///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// An in-memory stand-in for the parts of node-redis the relay bus uses, shared by every fake client it hands out so
// several `RedisRelayBus` instances behave like several server replicas talking to one Redis. Wire it up in a test
// file the way the push tests do:
//
//     const redis = vi.hoisted(() => ({ createClient: vi.fn() }));
//     vi.mock("redis", () => ({ createClient: redis.createClient }));
//     ...
//     redis.createClient.mockReset().mockImplementation((options) => server.createClient(options));
//
// It models what the bus relies on: buffer-mode pub/sub delivered asynchronously, SUBSCRIBE / UNSUBSCRIBE only when a
// client's first listener of a channel arrives / its last one leaves, a client that is not ready rejecting commands
// when its offline queue is disabled, and subscriptions surviving an outage (node-redis re-issues them on reconnect).
import { EventEmitter } from "events";

/** One logged Redis command. */
export interface FakeRedisOp {
    client: number;
    command: "SUBSCRIBE" | "UNSUBSCRIBE" | "PUBLISH";
    channel: string;
    /** The published payload, for PUBLISH. */
    message?: Buffer;
}

interface Subscription {
    listener: (message: Buffer, channel: Buffer) => void;
    bufferMode: boolean;
}

export class FakeRedisClient extends EventEmitter {
    public isOpen = false;
    public isReady = false;
    public destroyed = false;
    public readonly subscriptions: Map<string, Set<Subscription>> = new Map();

    constructor(
        private readonly server: FakeRedisServer,
        public readonly index: number,
        public readonly options: any,
    ) {
        super();
    }

    public async connect(): Promise<this> {
        if (this.server.failConnect) {
            throw new Error("connect failed");
        }
        this.isOpen = true;
        if (this.server.autoReady) {
            this.isReady = true;
        }
        return this;
    }

    public async publish(channel: string, message: Buffer): Promise<number> {
        this.server.guard(this, "publish", true);
        this.server.ops.push({ client: this.index, command: "PUBLISH", channel, message: Buffer.from(message) });
        this.server.deliver(channel, message);
        return 0;
    }

    public async subscribe(channel: string, listener: (message: Buffer, channel: Buffer) => void, bufferMode?: boolean): Promise<void> {
        this.server.guard(this, "subscribe", false);
        let set: Set<Subscription> | undefined = this.subscriptions.get(channel);
        if (!set) {
            set = new Set();
            this.subscriptions.set(channel, set);
            this.server.ops.push({ client: this.index, command: "SUBSCRIBE", channel });
        }
        set.add({ listener, bufferMode: bufferMode === true });
    }

    public async unsubscribe(channel: string, listener: (message: Buffer, channel: Buffer) => void, _bufferMode?: boolean): Promise<void> {
        this.server.guard(this, "unsubscribe", false);
        const set: Set<Subscription> | undefined = this.subscriptions.get(channel);
        for (const subscription of set ?? []) {
            if (subscription.listener === listener) {
                set!.delete(subscription);
            }
        }
        if (set && set.size === 0) {
            this.subscriptions.delete(channel);
            this.server.ops.push({ client: this.index, command: "UNSUBSCRIBE", channel });
        }
    }

    public destroy(): void {
        if (this.server.failDestroy) {
            throw new Error("destroy failed");
        }
        this.destroyed = true;
        this.isOpen = false;
        this.isReady = false;
        this.subscriptions.clear();
    }
}

export class FakeRedisServer {
    public readonly clients: FakeRedisClient[] = [];
    public readonly ops: FakeRedisOp[] = [];
    /** Whether a client is ready as soon as it connects. */
    public autoReady = true;
    /** When set, every command of that kind rejects. */
    public fail: { publish?: boolean; subscribe?: boolean; unsubscribe?: boolean } = {};
    public failConnect = false;
    public failDestroy = false;
    /** Makes `createClient()` throw on its n-th call from now (1-based), like node-redis does for an unusable URL. */
    public throwOnCreate?: number;

    /** What `createClient` of the mocked `redis` module does. */
    public createClient(options: any): FakeRedisClient {
        if (this.throwOnCreate !== undefined && --this.throwOnCreate === 0) {
            throw new Error("Invalid URL");
        }
        const client = new FakeRedisClient(this, this.clients.length, options);
        this.clients.push(client);
        return client;
    }

    /** Applies the connection and failure rules to a command before it does anything. */
    public guard(client: FakeRedisClient, kind: "publish" | "subscribe" | "unsubscribe", offlineQueueMatters: boolean): void {
        if (!client.isOpen) {
            throw new Error("The client is closed");
        }
        if (offlineQueueMatters && !client.isReady && client.options?.disableOfflineQueue) {
            throw new Error("The client is offline");
        }
        if (this.fail[kind]) {
            throw new Error(`${kind} failed`);
        }
    }

    /** Delivers a published message to every subscriber of `channel` - asynchronously, as Redis does. */
    public deliver(channel: string, message: Buffer | string): void {
        const copy: Buffer | string = typeof message === "string" ? message : Buffer.from(message);
        queueMicrotask(() => {
            for (const client of this.clients) {
                for (const subscription of [...(client.subscriptions.get(channel) ?? [])]) {
                    subscription.listener(copy as Buffer, Buffer.from(channel));
                }
            }
        });
    }

    /** Waits until everything delivered so far has been handed to its listeners. */
    public async settle(): Promise<void> {
        await new Promise((resolve) => setImmediate(resolve));
    }

    /** Simulates the Redis connection dropping: nothing is ready, subscriptions are remembered. */
    public outage(): void {
        for (const client of this.clients) {
            client.isReady = false;
        }
    }

    /** Simulates the connection coming back; node-redis has re-issued the subscriptions by then. */
    public recover(): void {
        for (const client of this.clients) {
            client.isReady = client.isOpen;
        }
    }

    /** Makes every open client ready - for a server started with `autoReady = false`. */
    public makeReady(): void {
        this.recover();
    }

    /** The commands of one kind that were issued, optionally on one channel. */
    public commands(command: FakeRedisOp["command"], channel?: string): FakeRedisOp[] {
        return this.ops.filter((op) => op.command === command && (channel === undefined || op.channel === channel));
    }

    /** How many clients have a subscription on `channel`. */
    public subscribers(channel: string): number {
        return this.clients.filter((client) => client.subscriptions.has(channel)).length;
    }
}
