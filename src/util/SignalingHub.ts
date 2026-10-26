///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { InProcessRelayBus, isValidRelayPeer, type RelayBus, type RelayConnection, type RelaySocket } from "./RelayHub.js";

/** The version of the signaling wire protocol this module implements - the `v` of `hello`/`ready`. */
export const SIGNALING_PROTOCOL_VERSION = 1;

/** The largest text message a socket may send when the route could not raise the framework's own limit. */
export const SIGNALING_MAX_PAYLOAD_BYTES: number = 16 * 1024;

/** The larger message limit the signaling route asks the framework for when it can (see the relay's identical
 * `RELAY_LARGE_PAYLOAD_BYTES`): a whiteboard's catch-up for a late joiner then travels in a few messages, not dozens. */
export const SIGNALING_LARGE_PAYLOAD_BYTES: number = 64 * 1024;

/** The most sockets (registered or still awaiting their `hello`) one room holds at once. */
export const SIGNALING_MAX_SOCKETS_PER_ROOM = 16;

/** The most sockets one authenticated uid may hold in one room at once (several tabs or devices of one account). */
export const SIGNALING_MAX_SOCKETS_PER_UID = 4;

/** Sustained inbound messages per second per socket. Drawing on the whiteboard sends about 15 a second, and a
 * connection being set up sends a burst of ICE candidates; this leaves room for both at once. */
export const SIGNALING_RATE_MESSAGES_PER_SECOND = 50;

/** Burst allowance, in messages, of a socket's message bucket - also its capacity. */
export const SIGNALING_BURST_MESSAGES = 200;

/** Sustained inbound bytes per second per socket. */
export const SIGNALING_RATE_BYTES_PER_SECOND: number = 256 * 1024;

/** Burst allowance, in bytes, of a socket's byte bucket - also its capacity. Enough for a late joiner's catch-up. */
export const SIGNALING_BURST_BYTES: number = 2 * 1024 * 1024;

/** How long a socket may stay over budget continuously before it is closed with 1008 "Too much data.". */
export const SIGNALING_OVER_BUDGET_CLOSE_MS = 10_000;

/** Two over-budget drops further apart than this are separate episodes - see `RELAY_OVER_BUDGET_GRACE_MS`. */
export const SIGNALING_OVER_BUDGET_GRACE_MS = 1_000;

/** How long a new socket has to send its `hello` before it is closed with 1008 "Hello timeout.". */
export const SIGNALING_HELLO_TIMEOUT_MS = 10_000;

/** The reason a socket is closed with (1008) when its uid is removed from the meeting - see `SignalingHub.evict()`. */
export const SIGNALING_EVICTED_REASON = "Removed from the meeting.";

/** The bus room a meeting's signaling travels in, kept apart from the same meeting's relay room on a shared bus. */
export function signalingBusRoom(roomId: string): string {
    return `signal:${roomId}`;
}

/** The bus sender an eviction is published under - never a valid peer id of any socket, which starts with its uid. */
const SIGNALING_EVICT_SENDER = "~evict";

/** What crosses the bus: a stamped message for one peer (`to`) or for everyone but its sender, or an eviction. */
type BusFrame = { t: "m"; to?: string; d: Record<string, unknown> } | { t: "evict"; uid: string };

/** A pair of token buckets - messages and bytes - refilled continuously, starting full. */
class Budget {
    private messages: number = SIGNALING_BURST_MESSAGES;
    private bytes: number = SIGNALING_BURST_BYTES;
    private last: number;

    constructor(now: number) {
        this.last = now;
    }

    /** Takes one message of `size` bytes if both buckets allow it; returns whether it did. */
    public take(size: number, now: number): boolean {
        const elapsed: number = (now - this.last) / 1000;
        this.last = now;
        this.messages = Math.min(SIGNALING_BURST_MESSAGES, this.messages + elapsed * SIGNALING_RATE_MESSAGES_PER_SECOND);
        this.bytes = Math.min(SIGNALING_BURST_BYTES, this.bytes + elapsed * SIGNALING_RATE_BYTES_PER_SECOND);
        if (this.messages < 1 || this.bytes < size) {
            return false;
        }
        this.messages -= 1;
        this.bytes -= size;
        return true;
    }
}

interface Room {
    id: string;
    /** Every accepted socket, including ones still awaiting their `hello`. */
    conns: Set<Connection>;
    /** Sockets that have said `hello`, by peer id. */
    peers: Map<string, Connection>;
    unsubscribe: () => void;
}

/** What a `Connection` needs from the hub that owns it. */
interface ConnectionEnv {
    bus: RelayBus;
    maxPayloadBytes: number;
    remove(conn: Connection): void;
}

/** Counters of what the hub did with messages - for tests and diagnostics. */
export interface SignalingStats {
    /** Messages handed to a receiving socket. */
    delivered: number;
    /** Messages dropped because their sender was over budget. */
    droppedBudget: number;
    /** Messages dropped for being malformed, oversized, or sent before `hello`. */
    droppedInvalid: number;
}

class Connection implements RelayConnection {
    public peer?: string;
    private closed = false;
    private helloTimer?: ReturnType<typeof setTimeout>;
    private readonly budget: Budget = new Budget(Date.now());
    private overBudgetSince?: number;
    private lastOverBudget = 0;

    constructor(
        private readonly env: ConnectionEnv,
        private readonly stats: SignalingStats,
        public readonly room: Room,
        public readonly uid: string,
        private readonly socket: RelaySocket,
    ) {
        this.helloTimer = setTimeout(() => this.evict("Hello timeout."), SIGNALING_HELLO_TIMEOUT_MS);
        this.helloTimer.unref();
    }

    public message(data: string | Uint8Array, isBinary: boolean): void {
        if (this.closed) {
            return;
        }
        if (isBinary) {
            this.stats.droppedInvalid++;
            return;
        }
        const text: string = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        this.text(text);
    }

    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.helloTimer);
        this.env.remove(this);
    }

    /** Closes the socket from this side with 1008 and `reason`, and forgets it. */
    public evict(reason: string): void {
        this.close();
        this.socket.close(1008, reason);
    }

    /** Sends `text` to this socket, ignoring a failure - the socket is going away, and its close event cleans up. */
    public send(text: string): boolean {
        try {
            this.socket.send(text);
            return true;
        } catch {
            return false;
        }
    }

    private text(text: string): void {
        // A character is at least one byte, so this bounds the parse below by the payload limit.
        if (text.length > this.env.maxPayloadBytes) {
            this.stats.droppedInvalid++;
            return;
        }
        let message: any;
        try {
            message = JSON.parse(text);
        } catch {
            this.stats.droppedInvalid++;
            return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
            this.stats.droppedInvalid++;
            return;
        }
        if (!this.peer) {
            if (message.op === "hello") {
                this.hello(message);
            } else {
                this.stats.droppedInvalid++;
            }
        } else if (message.op === "signal") {
            this.signal(message.data, Buffer.byteLength(text, "utf8"));
        } else if (message.op === "ping") {
            if (typeof message.t === "number" && Number.isFinite(message.t)) {
                this.send(JSON.stringify({ op: "pong", t: message.t }));
            }
        } else {
            this.stats.droppedInvalid++;
        }
    }

    private hello(message: any): void {
        if (message.v !== SIGNALING_PROTOCOL_VERSION) {
            this.evict("Unsupported version.");
            return;
        }
        const peer: unknown = message.peer;
        if (!isValidRelayPeer(peer) || (peer !== this.uid && !peer.startsWith(`${this.uid}~`))) {
            this.evict("Invalid peer.");
            return;
        }
        // A reconnecting client's new socket replaces the old one, which may not have noticed it is dead yet.
        this.room.peers.get(peer)?.evict("Replaced.");
        this.room.peers.set(peer, this);
        this.peer = peer;
        clearTimeout(this.helloTimer);
        this.send(JSON.stringify({ op: "ready", v: SIGNALING_PROTOCOL_VERSION, maxMessageBytes: this.env.maxPayloadBytes }));
    }

    private signal(data: unknown, size: number): void {
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            this.stats.droppedInvalid++;
            return;
        }
        const now: number = Date.now();
        if (!this.budget.take(size, now)) {
            this.stats.droppedBudget++;
            if (this.overBudgetSince === undefined || now - this.lastOverBudget > SIGNALING_OVER_BUDGET_GRACE_MS) {
                this.overBudgetSince = now;
            }
            this.lastOverBudget = now;
            if (now - this.overBudgetSince > SIGNALING_OVER_BUDGET_CLOSE_MS) {
                this.evict("Too much data.");
            }
            return;
        }
        // Who sent it is stamped here from the authenticated socket and its `hello`, never read from the payload.
        const stamped: Record<string, unknown> = { ...(data as Record<string, unknown>), from: this.uid, peer: this.peer };
        const to: unknown = stamped.to;
        const frame: BusFrame = { t: "m", d: stamped };
        if (to !== undefined) {
            if (!isValidRelayPeer(to)) {
                this.stats.droppedInvalid++;
                return;
            }
            frame.to = to;
        }
        // A signal, never media: a bus must not skip it for a room it believes no other replica listens to, since
        // nothing resends a lost `hello` answer or offer to a peer that just joined on another replica.
        this.env.bus.publish(this.room.id, this.peer!, Buffer.from(JSON.stringify(frame), "utf8"), "signal");
    }
}

export interface SignalingHubOptions {
    /** Where messages travel between sockets. Defaults to a new `InProcessRelayBus`. A bus shared with a `RelayHub` is
     * fine - the hub keeps to its own rooms (`signalingBusRoom()`). */
    bus?: RelayBus;
    logger?: { debug(message: string): void };
    /** The largest text message a socket may send, and what `ready` tells the client. Defaults to
     * `SIGNALING_MAX_PAYLOAD_BYTES`; the route sets `SIGNALING_LARGE_PAYLOAD_BYTES` when the framework was asked for that. */
    maxPayloadBytes?: number;
}

/**
 * The meeting's own signaling channel: a WebSocket per participant tab, carrying the JSON `SignalMessage`s of the
 * full-mesh call (`apps/shared/webrtc/types.ts`) - offers, answers, ICE candidates, presence, moderation, chat and
 * whiteboard - between the participants of one room (one meeting). It replaces publishing on the server's shared `/push`
 * route, so the call's traffic is neither an HTTP request per message nor shared with the webmail's own push
 * notifications. Like `RelayHub` it knows nothing about meetings, users, HTTP or any framework: a caller authorizes a
 * socket however it likes, hands it to `attach()` and feeds the returned connection the socket's events.
 *
 * ## Wire protocol (version 1, text messages only)
 *
 * Client to server, the first message must be `{"op":"hello","v":1,"peer":"<peerId>"}` within
 * `SIGNALING_HELLO_TIMEOUT_MS`, `peer` being the socket's uid or starting with `<uid>~` (the same rule, and the same
 * closing reasons, as the relay's `hello`). The server answers `{"op":"ready","v":1,"maxMessageBytes":N}`. A second
 * socket registering an already registered peer in the same room replaces the older one ("Replaced.").
 *
 * After that, `{"op":"signal","data":{...}}` sends `data` to the room, and `{"op":"ping","t":<number>}` is answered
 * with `{"op":"pong","t":<the same number>}` (a keepalive). The server overwrites `data.from` with the socket's uid
 * and `data.peer` with its peer id, so nobody can speak as someone else. When `data.to` names a peer id, only that peer's
 * socket receives it - an offer, an answer and ICE candidates never reach anyone they are not for; otherwise every
 * other registered socket of the room does. Each arrives as `{"op":"signal","data":{...}}`. Anything malformed,
 * binary, oversized, or sent before `hello`, is dropped.
 *
 * ## Limits and removal
 *
 * `SIGNALING_MAX_SOCKETS_PER_ROOM` sockets per room and `SIGNALING_MAX_SOCKETS_PER_UID` per uid per room ("Room full."
 * / "Too many connections."). Each socket's messages are metered by two token buckets (messages and bytes); an
 * over-budget message is dropped, and a socket kept over budget for `SIGNALING_OVER_BUDGET_CLOSE_MS` is closed with
 * "Too much data.". `evict()` closes every socket of one uid in a room, on every replica the bus reaches - the host
 * removing someone takes them off the signaling channel at once, not at their next reconnect - and then tells every
 * other socket of the room `{"op":"removed","uid":"<uid>"}`, once per replica. That notice comes from the server
 * itself, never wrapped in a `signal`, so no participant can send one: a client drops every connection it holds to a
 * peer of that uid on it, including a direct WebRTC one a removed client that ignores its own removal would keep up.
 *
 * ## Replicas
 *
 * Exactly as `RelayHub`'s: messages cross replicas when the bus does (`RedisRelayBus`), and every limit is per replica.
 */
export class SignalingHub {
    public readonly stats: SignalingStats = { delivered: 0, droppedBudget: 0, droppedInvalid: 0 };

    private readonly bus: RelayBus;
    private readonly rooms: Map<string, Room> = new Map();
    private readonly env: ConnectionEnv;
    private readonly logger?: { debug(message: string): void };

    constructor(options: SignalingHubOptions = {}) {
        this.bus = options.bus ?? new InProcessRelayBus();
        this.logger = options.logger;
        this.env = {
            bus: this.bus,
            maxPayloadBytes: options.maxPayloadBytes ?? SIGNALING_MAX_PAYLOAD_BYTES,
            remove: (conn: Connection) => this.remove(conn),
        };
    }

    /** The number of rooms that currently hold at least one socket. */
    public get roomCount(): number {
        return this.rooms.size;
    }

    /** The number of sockets in `roomId` (0 for an unknown room). */
    public socketCount(roomId: string): number {
        return this.rooms.get(signalingBusRoom(roomId))?.conns.size ?? 0;
    }

    /**
     * Accepts an already-authorized `socket` of `uid` into room `roomId`, or refuses it (closing it with 1008) when
     * the room or the uid is at its limit. Returns the connection to feed the socket's events to, or `undefined`
     * when refused.
     */
    public attach(roomId: string, uid: string, socket: RelaySocket): RelayConnection | undefined {
        const busRoom: string = signalingBusRoom(roomId);
        let room: Room | undefined = this.rooms.get(busRoom);
        if (room) {
            if (room.conns.size >= SIGNALING_MAX_SOCKETS_PER_ROOM) {
                socket.close(1008, "Room full.");
                return undefined;
            }
            if ([...room.conns].filter((conn) => conn.uid === uid).length >= SIGNALING_MAX_SOCKETS_PER_UID) {
                socket.close(1008, "Too many connections.");
                return undefined;
            }
        } else {
            room = {
                id: busRoom,
                conns: new Set(),
                peers: new Map(),
                unsubscribe: this.bus.subscribe(busRoom, (sender, frame) => this.deliver(busRoom, sender, frame)),
            };
            this.rooms.set(busRoom, room);
        }
        const conn: Connection = new Connection(this.env, this.stats, room, uid, socket);
        room.conns.add(conn);
        return conn;
    }

    /** Closes every socket `uid` holds in room `roomId` (`SIGNALING_EVICTED_REASON`), on this replica and - through
     * the bus - every other. */
    public evict(roomId: string, uid: string): void {
        const frame: BusFrame = { t: "evict", uid };
        // Published under a sender of its own: a bus may refuse an empty one (`RedisRelayBus` cannot encode it, so an
        // eviction published as "" never left this replica). No socket's peer id can start with "~".
        this.bus.publish(signalingBusRoom(roomId), SIGNALING_EVICT_SENDER, Buffer.from(JSON.stringify(frame), "utf8"), "control");
        // A replica with no socket in the room has no bus subscription to hear that on - including this one, possibly.
        // The rest of the room is told by the bus frame's delivery alone, so each replica tells its sockets once.
        this.evictLocal(signalingBusRoom(roomId), uid, false);
    }

    /** Closes `uid`'s sockets in `busRoom` and, with `notify`, tells every socket left in it that `uid` was removed. */
    private evictLocal(busRoom: string, uid: string, notify: boolean): void {
        const room: Room | undefined = this.rooms.get(busRoom);
        for (const conn of [...(room?.conns ?? [])]) {
            if (conn.uid === uid) {
                conn.evict(SIGNALING_EVICTED_REASON);
            }
        }
        if (notify && room && this.rooms.get(busRoom) === room) {
            const text: string = JSON.stringify({ op: "removed", uid });
            for (const conn of room.peers.values()) {
                conn.send(text);
            }
        }
    }

    /** Forgets `conn`, and its room once that is empty. */
    private remove(conn: Connection): void {
        const room: Room = conn.room;
        room.conns.delete(conn);
        if (conn.peer && room.peers.get(conn.peer) === conn) {
            room.peers.delete(conn.peer);
        }
        if (room.conns.size === 0 && this.rooms.get(room.id) === room) {
            room.unsubscribe();
            this.rooms.delete(room.id);
        }
    }

    /** Hands one bus frame to the sockets of `busRoom` it is for. A frame for a room that has just emptied, or one
     * that is not a frame this hub publishes, is ignored. */
    private deliver(busRoom: string, sender: string, raw: Buffer): void {
        let frame: BusFrame;
        try {
            frame = JSON.parse(raw.toString("utf8"));
        } catch {
            this.logger?.debug(`Ignored an unreadable signaling frame in ${busRoom}.`);
            return;
        }
        if (frame?.t === "evict") {
            if (typeof frame.uid === "string") {
                this.evictLocal(busRoom, frame.uid, true);
            }
            return;
        }
        if (frame?.t !== "m") {
            return;
        }
        const room: Room | undefined = this.rooms.get(busRoom);
        if (!room) {
            return;
        }
        const text: string = JSON.stringify({ op: "signal", data: frame.d });
        const targets: Connection[] = frame.to !== undefined ? [room.peers.get(frame.to)].filter((c): c is Connection => !!c) : [...room.peers.values()];
        for (const conn of targets) {
            if (conn.peer !== sender && conn.send(text)) {
                this.stats.delivered++;
            }
        }
    }
}
