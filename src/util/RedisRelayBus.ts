///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { attachRedisErrorHandler, importRedis } from "@rapidrest/service-core";
import type { RelayBus, RelayBusListener } from "./RelayHub.js";

/** The prefix of the Redis pub/sub channel a room's frames travel on: `videoconf:relay:<roomId>`. */
export const REDIS_RELAY_CHANNEL_PREFIX = "videoconf:relay:";

/** The length, in bytes, of the random id every `RedisRelayBus` stamps on what it publishes. */
export const REDIS_RELAY_ORIGIN_BYTES = 16;

/** The least time between two `warn` messages about failing Redis commands; the failures in between are logged at
 * `debug`, so a Redis outage cannot flood the log at the rate media frames arrive. */
export const REDIS_RELAY_WARN_INTERVAL_MS = 30_000;

/** The channel a room's frames are published to. */
export function redisRelayChannel(roomId: string): string {
    return REDIS_RELAY_CHANNEL_PREFIX + roomId;
}

/** The logger a `RedisRelayBus` writes to - the framework's logger satisfies it. */
export interface RedisRelayBusLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export interface RedisRelayBusOptions {
    /** The `datastores:events` Redis URL. */
    url: string;
    logger: RedisRelayBusLogger;
}

/** What the bus counts, for tests and diagnostics. */
export interface RedisRelayBusStats {
    /** Frames published to Redis. */
    published: number;
    /** Frames not published because the publisher was not connected (or the sender id cannot be encoded). */
    publishSkipped: number;
    /** Redis commands (publish, subscribe, unsubscribe, connect) that failed. */
    failures: number;
    /** Messages received from Redis and handed to local listeners. */
    received: number;
    /** Messages received from Redis and ignored: this bus's own, garbled, or for a room with no local listener. */
    receivedDropped: number;
}

/** The part of a node-redis client the bus uses (structurally typed so the plugin needs no `redis` types). */
interface RelayRedisClient {
    readonly isReady: boolean;
    connect(): Promise<unknown>;
    publish(channel: string, message: Buffer): Promise<unknown>;
    subscribe(channel: string, listener: (message: Buffer, channel: Buffer) => void, bufferMode: true): Promise<unknown>;
    unsubscribe(channel: string, listener: (message: Buffer, channel: Buffer) => void, bufferMode: true): Promise<unknown>;
    destroy(): void;
}

interface BusRoom {
    /** The local listeners of the room - one per `RelayHub` in this process, in practice. */
    listeners: Set<RelayBusListener>;
    /** The function registered with the Redis subscriber for the room, once it has been asked to subscribe. */
    onMessage?: (message: Buffer) => void;
}

/**
 * A `RelayBus` that also carries frames between server replicas over Redis pub/sub, so participants whose relay
 * sockets landed on different replicas still reach each other. The Redis is the deployment's `datastores:events` one,
 * the same the framework's push system (`BasePushRoute`) uses across replicas.
 *
 * ## How
 *
 * The bus owns exactly two Redis clients for the whole process, however many sockets and rooms there are: a
 * publisher, and one shared subscriber (a client in subscriber mode cannot publish). Both come from
 * `importRedis()` and `attachRedisErrorHandler()` of `@rapidrest/service-core`, exactly as `BasePushRoute` obtains its
 * clients - see `connect()`.
 *
 * Each room has a channel, `videoconf:relay:<roomId>`. The bus counts the local listeners of every room: the first
 * one to arrive makes it SUBSCRIBE and the last one to leave makes it UNSUBSCRIBE, so a replica receives only the
 * rooms it has sockets in. Subscriptions use the client's BUFFER mode, so media bytes are never decoded as text.
 *
 * `publish()` delivers to this process's listeners synchronously, exactly as `InProcessRelayBus` does - local
 * delivery never goes through Redis - and, when the publisher is connected, also publishes the frame to the room's
 * channel without waiting for it. Every message carries the id of the bus that published it and a bus ignores its own,
 * so nothing is delivered twice on the replica of origin, while every other replica delivers it to its own listeners.
 *
 * ## Wire format of a Redis message
 *
 * `[16 bytes: origin bus id][1 byte: N][N bytes: the sender's peer id, UTF-8][the frame]`, where `frame` is what the
 * `RelayHub` gave `publish()` (its own `[sender length][sender][payload]` header included). The origin id is random
 * per bus instance. A message that is shorter than that, whose length byte is 0 or overruns it, or that carries no
 * frame, is dropped; parsing never throws.
 *
 * ## Failure behaviour
 *
 * Redis being down or slow never affects local delivery and never throws into the hub: `publish()` is fire-and-forget,
 * is skipped outright while the publisher is not connected (its offline queue is disabled, so an outage cannot pile
 * frames up in memory), and every failed command is caught and counted. Failures are logged at `warn` at most once per
 * `REDIS_RELAY_WARN_INTERVAL_MS` and at `debug` otherwise; connection errors themselves are logged by
 * `attachRedisErrorHandler()` (one error per outage). The clients keep node-redis's default reconnect strategy
 * (retry forever with backoff), and on reconnect node-redis re-issues SUBSCRIBE for every channel the subscriber held
 * (`resubscribe()` in the client's socket initiator), so the bus needs no re-subscribe logic of its own - relay
 * between replicas resumes by itself when Redis comes back, and frames sent during the outage are simply lost, which
 * media tolerates. A bus used before `connect()`, after `close()`, or whose Redis is unavailable behaves as an
 * `InProcessRelayBus`.
 *
 * ## Bandwidth
 *
 * Every relayed frame is published once, whatever the number of receivers, and Redis delivers it to every replica
 * subscribed to that room - including replicas whose sockets there do not `want` the sender at all (the hub filters
 * after the bus). A room's cross-replica traffic is therefore roughly its total relayed upload times the number of
 * OTHER replicas holding sockets of it, and each of those replicas' subscribers reads all of it. A single-replica
 * room costs a publish per frame and no receiving. Redis pub/sub buffers nothing for a slow subscriber beyond the
 * server's client-output-buffer limit for pub/sub, after which Redis drops that connection (the client then
 * reconnects and resubscribes).
 *
 * @author Jean-Philippe Steinmetz
 */
export class RedisRelayBus implements RelayBus {
    /** What the bus has done so far. */
    public readonly stats: RedisRelayBusStats = { published: 0, publishSkipped: 0, failures: 0, received: 0, receivedDropped: 0 };

    private readonly id: Buffer = crypto.randomBytes(REDIS_RELAY_ORIGIN_BYTES);
    private readonly rooms: Map<string, BusRoom> = new Map();
    private publisher?: RelayRedisClient;
    private subscriber?: RelayRedisClient;
    private lastWarn: number = Number.NEGATIVE_INFINITY;

    constructor(private readonly options: RedisRelayBusOptions) {}

    /** Whether frames are currently being published to Redis: `connect()` was called, the bus is not closed and the
     * publisher's connection is up. */
    public get connected(): boolean {
        return this.publisher?.isReady === true;
    }

    /**
     * Creates the publisher and the shared subscriber and starts connecting them, then returns without waiting for
     * either connection - a Redis that is down at start-up delays cross-replica relay, not the server, and the
     * clients keep retrying. Rooms subscribed to before this call are not caught up (the route calls it before it
     * exposes the bus). Does nothing when already connected. Throws when the `redis` package is not installed or the
     * URL is unusable; nothing is left open then.
     */
    public async connect(): Promise<void> {
        if (this.publisher) {
            return;
        }
        const { createClient } = await importRedis();
        // The publisher must never queue commands while disconnected: a frame is only worth sending right now.
        const publisher: RelayRedisClient = attachRedisErrorHandler(
            createClient({ url: this.options.url, disableOfflineQueue: true }),
            this.options.logger,
            "events (relay publisher)",
        );
        let subscriber: RelayRedisClient;
        try {
            subscriber = attachRedisErrorHandler(createClient({ url: this.options.url }), this.options.logger, "events (relay subscriber)");
        } catch (err) {
            publisher.destroy();
            throw err;
        }
        this.publisher = publisher;
        this.subscriber = subscriber;
        this.run("connect the publisher", () => publisher.connect());
        this.run("connect the subscriber", () => subscriber.connect());
    }

    /**
     * Shuts the bus down: destroys both clients (which ends their connections, and with them every subscription) and
     * stops publishing. Local delivery keeps working, as after a failed `connect()`. Safe to call repeatedly.
     * Nothing is unsubscribed one by one: the connection going away does that server-side, and an UNSUBSCRIBE could
     * only stall behind a Redis that is down.
     */
    public close(): void {
        const clients: (RelayRedisClient | undefined)[] = [this.publisher, this.subscriber];
        this.publisher = undefined;
        this.subscriber = undefined;
        for (const client of clients) {
            try {
                client?.destroy();
            } catch (err) {
                this.report("destroy a client", err);
            }
        }
    }

    public subscribe(roomId: string, listener: RelayBusListener): () => void {
        let room: BusRoom | undefined = this.rooms.get(roomId);
        if (!room) {
            room = { listeners: new Set() };
            this.rooms.set(roomId, room);
            this.redisSubscribe(roomId, room);
        }
        const current: BusRoom = room;
        current.listeners.add(listener);
        return () => {
            current.listeners.delete(listener);
            if (current.listeners.size === 0 && this.rooms.get(roomId) === current) {
                this.rooms.delete(roomId);
                this.redisUnsubscribe(roomId, current);
            }
        };
    }

    public publish(roomId: string, sender: string, frame: Buffer): void {
        this.publishToRedis(roomId, sender, frame);
        for (const listener of this.rooms.get(roomId)?.listeners ?? []) {
            listener(sender, frame);
        }
    }

    private publishToRedis(roomId: string, sender: string, frame: Buffer): void {
        const publisher: RelayRedisClient | undefined = this.publisher;
        const senderBytes: Buffer = Buffer.from(sender, "utf8");
        if (!publisher?.isReady || senderBytes.length === 0 || senderBytes.length > 255) {
            this.stats.publishSkipped++;
            return;
        }
        const message: Buffer = Buffer.allocUnsafe(REDIS_RELAY_ORIGIN_BYTES + 1 + senderBytes.length + frame.length);
        this.id.copy(message, 0);
        message[REDIS_RELAY_ORIGIN_BYTES] = senderBytes.length;
        senderBytes.copy(message, REDIS_RELAY_ORIGIN_BYTES + 1);
        frame.copy(message, REDIS_RELAY_ORIGIN_BYTES + 1 + senderBytes.length);
        this.stats.published++;
        this.run("publish a frame", () => publisher.publish(redisRelayChannel(roomId), message));
    }

    private redisSubscribe(roomId: string, room: BusRoom): void {
        const subscriber: RelayRedisClient | undefined = this.subscriber;
        if (!subscriber) {
            return;
        }
        const onMessage = (message: Buffer): void => this.receive(roomId, message);
        room.onMessage = onMessage;
        this.run("subscribe to a room", () => subscriber.subscribe(redisRelayChannel(roomId), onMessage, true));
    }

    private redisUnsubscribe(roomId: string, room: BusRoom): void {
        const subscriber: RelayRedisClient | undefined = this.subscriber;
        if (!subscriber || !room.onMessage) {
            return;
        }
        const onMessage: (message: Buffer) => void = room.onMessage;
        this.run("unsubscribe from a room", () => subscriber.unsubscribe(redisRelayChannel(roomId), onMessage, true));
    }

    /** Handles one message of a room's channel: parses it defensively and hands its frame to the local listeners,
     * unless this very bus published it. Never throws - it runs inside the Redis client's own message dispatch. */
    private receive(roomId: string, message: Buffer): void {
        try {
            const listeners: Set<RelayBusListener> | undefined = this.rooms.get(roomId)?.listeners;
            const parsed: { sender: string; frame: Buffer } | undefined = listeners ? this.parse(message) : undefined;
            if (!listeners || !parsed) {
                this.stats.receivedDropped++;
                return;
            }
            this.stats.received++;
            for (const listener of listeners) {
                listener(parsed.sender, parsed.frame);
            }
        } catch (err) {
            this.report("deliver a frame", err);
        }
    }

    /** Splits a Redis message into its sender and frame; `undefined` for a garbled one or this bus's own. */
    private parse(message: unknown): { sender: string; frame: Buffer } | undefined {
        if (!Buffer.isBuffer(message) || message.length < REDIS_RELAY_ORIGIN_BYTES + 3) {
            return undefined;
        }
        if (message.subarray(0, REDIS_RELAY_ORIGIN_BYTES).equals(this.id)) {
            return undefined;
        }
        const senderLength: number = message[REDIS_RELAY_ORIGIN_BYTES];
        const frameStart: number = REDIS_RELAY_ORIGIN_BYTES + 1 + senderLength;
        // A peer id is never empty and the frame carries at least its own header.
        if (senderLength === 0 || frameStart >= message.length) {
            return undefined;
        }
        return { sender: message.toString("utf8", REDIS_RELAY_ORIGIN_BYTES + 1, frameStart), frame: message.subarray(frameStart) };
    }

    /** Runs a Redis command without waiting for it: a failure, thrown or rejected, is only counted and logged. */
    private run(what: string, command: () => Promise<unknown>): void {
        (async () => {
            await command();
        })().catch((err) => this.report(what, err));
    }

    /** Counts a failure and logs it - at `warn` once per `REDIS_RELAY_WARN_INTERVAL_MS`, at `debug` in between. */
    private report(what: string, err: unknown): void {
        this.stats.failures++;
        const message = `Relay redis bus failed to ${what}: ${(err as Error)?.message ?? err}`;
        const now: number = Date.now();
        if (now - this.lastWarn >= REDIS_RELAY_WARN_INTERVAL_MS) {
            this.lastWarn = now;
            this.options.logger.warn(message);
        } else {
            this.options.logger.debug(message);
        }
    }
}
