///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    REDIS_RELAY_CHANNEL_PREFIX,
    REDIS_RELAY_ORIGIN_BYTES,
    REDIS_RELAY_WARN_INTERVAL_MS,
    RedisRelayBus,
    redisRelayChannel,
    type RedisRelayBusLogger,
    type RedisRelayBusOptions,
} from "../../src/util/RedisRelayBus.js";
import { RelayHub, type RelayBusListener, type RelayConnection, type RelaySocket } from "../../src/util/RelayHub.js";
import { FakeRedisServer } from "./fakeRedis.js";

const redis = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("redis", () => ({ createClient: redis.createClient }));

class FakeSocket implements RelaySocket {
    public sent: (string | Uint8Array)[] = [];
    public send(data: string | Uint8Array): void {
        this.sent.push(data);
    }
    public close(): void {
        // Nothing to release.
    }
    public get frames(): Buffer[] {
        return this.sent.filter((d) => typeof d !== "string").map((d) => Buffer.from(d));
    }
}

interface Peer {
    sock: FakeSocket;
    conn: RelayConnection;
}

/** Attaches a socket of `uid` to `room` of `hub`, says hello as `uid` and wants `wanted`. */
function join(hub: RelayHub, room: string, uid: string, wanted: string[] = []): Peer {
    const sock = new FakeSocket();
    const conn: RelayConnection = hub.attach(room, uid, sock)!;
    conn.message(JSON.stringify({ op: "hello", v: 1, peer: uid }), false);
    conn.message(JSON.stringify({ op: "want", peers: wanted }), false);
    return { sock, conn };
}

/** The `[len][sender][payload]` a receiver is expected to get. */
const frameOf = (sender: string, payload: Uint8Array): Buffer => {
    const name: Buffer = Buffer.from(sender, "utf8");
    return Buffer.concat([Buffer.from([name.length]), name, payload]);
};

/** A Redis message as another replica would publish it. */
function wire(origin: Buffer, sender: string, frame: Buffer): Buffer {
    const name: Buffer = Buffer.from(sender, "utf8");
    return Buffer.concat([origin, Buffer.from([name.length]), name, frame]);
}

describe("RedisRelayBus", () => {
    let server: FakeRedisServer;
    let logger: { [K in keyof RedisRelayBusLogger]: ReturnType<typeof vi.fn> };
    const buses: RedisRelayBus[] = [];

    /** One server replica: a bus on the shared fake Redis and a hub on it. */
    async function replica(overrides: Partial<RedisRelayBusOptions> = {}): Promise<{ bus: RedisRelayBus; hub: RelayHub }> {
        const bus = new RedisRelayBus({ url: "redis://fake:6379", logger, ...overrides });
        await bus.connect();
        buses.push(bus);
        return { bus, hub: new RelayHub({ bus }) };
    }

    beforeEach(() => {
        server = new FakeRedisServer();
        logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        redis.createClient.mockReset().mockImplementation((options: any) => server.createClient(options));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        buses.splice(0).forEach((bus) => bus.close());
    });

    describe("connecting", () => {
        it("Creates one publisher (without an offline queue) and one shared subscriber from the events url, each with an error handler.", async () => {
            const { bus, hub } = await replica();
            expect(server.clients).toHaveLength(2);
            expect(redis.createClient).toHaveBeenCalledWith({ url: "redis://fake:6379", disableOfflineQueue: true });
            expect(redis.createClient).toHaveBeenCalledWith({ url: "redis://fake:6379" });
            // `attachRedisErrorHandler()` - without an `error` listener a Redis outage would crash the process.
            for (const client of server.clients) {
                expect(client.listenerCount("error")).toBe(1);
            }
            expect(bus.connected).toBe(true);

            // However many rooms and sockets, no further client is created.
            join(hub, "room-1", "alice");
            join(hub, "room-2", "alice");
            join(hub, "room-1", "bob");
            expect(server.clients).toHaveLength(2);
            expect(server.subscribers(redisRelayChannel("room-1"))).toBe(1);
        });

        it("Is not connected before connect() and does nothing when connected twice.", async () => {
            const bus = new RedisRelayBus({ url: "redis://fake", logger });
            expect(bus.connected).toBe(false);
            await bus.connect();
            await bus.connect();
            buses.push(bus);
            expect(server.clients).toHaveLength(2);
        });

        it("Returns from connect() without waiting for Redis, and starts publishing once the publisher is ready.", async () => {
            server.autoReady = false;
            const { bus } = await replica();
            expect(bus.connected).toBe(false);
            server.makeReady();
            expect(bus.connected).toBe(true);
        });

        it("Rejects when the client cannot be created (a bad url) and leaves nothing open.", async () => {
            server.throwOnCreate = 1;
            const bus = new RedisRelayBus({ url: "not a url", logger });
            await expect(bus.connect()).rejects.toThrow("Invalid URL");
            expect(bus.connected).toBe(false);
            expect(server.clients).toHaveLength(0);
        });

        it("Destroys the publisher when the subscriber cannot be created.", async () => {
            server.throwOnCreate = 2;
            const bus = new RedisRelayBus({ url: "not a url", logger });
            await expect(bus.connect()).rejects.toThrow("Invalid URL");
            expect(bus.connected).toBe(false);
            expect(server.clients).toHaveLength(1);
            expect(server.clients[0].destroyed).toBe(true);
        });

        it("Logs, and does not throw, when a client's connection attempt fails.", async () => {
            server.failConnect = true;
            const { bus } = await replica();
            await server.settle();
            expect(bus.stats.failures).toBe(2);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain("connect the publisher");
        });
    });

    describe("between two replicas", () => {
        it("Delivers a frame a socket sent on one replica to a socket on the other that wants the sender, with the server-stamped sender intact.", async () => {
            const r1 = await replica();
            const r2 = await replica();
            const alice = join(r1.hub, "room", "alice");
            const bob = join(r2.hub, "room", "bob", ["alice"]);
            const carol = join(r2.hub, "room", "carol", ["dave"]);
            bob.sock.sent.length = 0;

            const payload = Buffer.from([1, 2, 3, 4]);
            alice.conn.message(payload, true);
            await server.settle();

            expect(bob.sock.frames).toEqual([frameOf("alice", payload)]);
            // ... but not to a socket that does not want the sender,
            expect(carol.sock.frames).toEqual([]);
            // ... and not back to the sender.
            expect(alice.sock.frames).toEqual([]);
        });

        it("Works in both directions and for several senders and receivers at once.", async () => {
            const r1 = await replica();
            const r2 = await replica();
            const alice = join(r1.hub, "room", "alice", ["bob"]);
            const bob = join(r2.hub, "room", "bob", ["alice"]);
            const erin = join(r1.hub, "room", "erin", ["alice", "bob"]);

            alice.conn.message(Buffer.from("from alice"), true);
            bob.conn.message(Buffer.from("from bob"), true);
            await server.settle();

            expect(alice.sock.frames).toEqual([frameOf("bob", Buffer.from("from bob"))]);
            expect(bob.sock.frames).toEqual([frameOf("alice", Buffer.from("from alice"))]);
            expect(erin.sock.frames).toEqual([frameOf("alice", Buffer.from("from alice")), frameOf("bob", Buffer.from("from bob"))]);
        });

        it("Delivers to a socket on the replica of origin exactly once - locally, synchronously, and never again from Redis.", async () => {
            const r1 = await replica();
            const r2 = await replica();
            const alice = join(r1.hub, "room", "alice");
            const dave = join(r1.hub, "room", "dave", ["alice"]);
            join(r2.hub, "room", "bob", ["alice"]);

            alice.conn.message(Buffer.from("once"), true);
            // Local delivery does not wait for Redis.
            expect(dave.sock.frames).toEqual([frameOf("alice", Buffer.from("once"))]);
            await server.settle();
            expect(dave.sock.frames).toHaveLength(1);
            expect(r1.bus.stats.receivedDropped).toBe(1);
            expect(r1.bus.stats.received).toBe(0);
            expect(r2.bus.stats.received).toBe(1);
        });

        it("Keeps rooms apart: a frame only reaches the other replicas' sockets of its own room.", async () => {
            const r1 = await replica();
            const r2 = await replica();
            const alice = join(r1.hub, "room-a", "alice");
            const bob = join(r2.hub, "room-b", "bob", ["alice"]);
            alice.conn.message(Buffer.from("x"), true);
            await server.settle();
            expect(bob.sock.frames).toEqual([]);
        });

        it("Carries every byte value across untouched (buffer mode, no text decoding).", async () => {
            const r1 = await replica();
            const r2 = await replica();
            const alice = join(r1.hub, "room", "alice~tab-é中");
            const bob = join(r2.hub, "room", "bob", ["alice~tab-é中"]);
            const payload = Buffer.alloc(256 * 4);
            for (let i = 0; i < payload.length; i++) {
                payload[i] = i % 256;
            }
            alice.conn.message(payload.subarray(0, 4096), true);
            await server.settle();
            // Invalid UTF-8 on purpose: 0x80..0xff standing alone.
            expect(bob.sock.frames).toHaveLength(1);
            expect(bob.sock.frames[0].equals(frameOf("alice~tab-é中", payload.subarray(0, 4096)))).toBe(true);
        });

        it("Publishes `[16 bytes origin][1 byte N][N bytes sender][frame]` to `videoconf:relay:<room>`, with one origin id per bus.", async () => {
            const r1 = await replica();
            const r2 = await replica();
            const alice = join(r1.hub, "room", "alice");
            const bob = join(r2.hub, "room", "bob");
            join(r1.hub, "other", "carol");

            alice.conn.message(Buffer.from("aa"), true);
            alice.conn.message(Buffer.from("bb"), true);
            bob.conn.message(Buffer.from("cc"), true);

            const published = server.commands("PUBLISH");
            expect(published).toHaveLength(3);
            expect(published.every((op) => op.channel === `${REDIS_RELAY_CHANNEL_PREFIX}room`)).toBe(true);
            const [first, second, third] = published.map((op) => op.message!);
            expect(first.subarray(REDIS_RELAY_ORIGIN_BYTES)).toEqual(Buffer.concat([Buffer.from([5]), Buffer.from("alice"), frameOf("alice", Buffer.from("aa"))]));
            expect(second.subarray(0, REDIS_RELAY_ORIGIN_BYTES)).toEqual(first.subarray(0, REDIS_RELAY_ORIGIN_BYTES));
            expect(third.subarray(0, REDIS_RELAY_ORIGIN_BYTES)).not.toEqual(first.subarray(0, REDIS_RELAY_ORIGIN_BYTES));
            expect(third.subarray(REDIS_RELAY_ORIGIN_BYTES)).toEqual(Buffer.concat([Buffer.from([3]), Buffer.from("bob"), frameOf("bob", Buffer.from("cc"))]));
            expect(r1.bus.stats.published).toBe(2);
            expect(r2.bus.stats.published).toBe(1);
            await server.settle();
        });

        it("Delivers frames again after a Redis outage, once the client is back (node-redis re-subscribes on reconnect by itself).", async () => {
            // The fake keeps a client's subscriptions across an outage, as node-redis does: on reconnect its socket
            // initiator runs `resubscribe()` for every channel the client held (node_modules/@redis/client
            // dist/lib/client/index.js, `#initiateSocket`). The bus therefore has no re-subscribe logic.
            const r1 = await replica();
            const r2 = await replica();
            const alice = join(r1.hub, "room", "alice", ["bob"]);
            const bob = join(r2.hub, "room", "bob", ["alice"]);

            server.outage();
            expect(r1.bus.connected).toBe(false);
            alice.conn.message(Buffer.from("lost"), true);
            await server.settle();
            expect(bob.sock.frames).toEqual([]);

            server.recover();
            alice.conn.message(Buffer.from("back"), true);
            bob.conn.message(Buffer.from("back too"), true);
            await server.settle();
            expect(bob.sock.frames).toEqual([frameOf("alice", Buffer.from("back"))]);
            expect(alice.sock.frames).toEqual([frameOf("bob", Buffer.from("back too"))]);
        });
    });

    describe("localOnly - skipping Redis for a single-replica room", () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it("keeps publishing to Redis until the first poll completes.", async () => {
            // Only the interval timer is faked - `setImmediate` stays real, so `server.settle()` (used by some of
            // these tests) keeps working rather than hanging on a now-fake `setImmediate` it never advances.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const { bus, hub } = await replica({ numSubPollMs: 10 });
            const alice = join(hub, "room", "alice");
            join(hub, "room", "bob", ["alice"]);

            alice.conn.message(Buffer.from("x"), true);
            expect(server.commands("PUBLISH")).toHaveLength(1);
            expect(bus.stats.publishSkippedLocalOnly).toBe(0);
        });

        it("skips publishing once a poll confirms no other replica is subscribed to the room.", async () => {
            // Only the interval timer is faked - `setImmediate` stays real, so `server.settle()` (used by some of
            // these tests) keeps working rather than hanging on a now-fake `setImmediate` it never advances.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const { bus, hub } = await replica({ numSubPollMs: 10 });
            const alice = join(hub, "room", "alice");
            join(hub, "room", "bob", ["alice"]);
            await vi.advanceTimersByTimeAsync(10);

            alice.conn.message(Buffer.from("x"), true);
            expect(server.commands("PUBLISH")).toHaveLength(0);
            expect(bus.stats.published).toBe(0);
            expect(bus.stats.publishSkippedLocalOnly).toBe(1);
        });

        it("keeps publishing while another replica also has a listener for the room.", async () => {
            // Only the interval timer is faked - `setImmediate` stays real, so `server.settle()` (used by some of
            // these tests) keeps working rather than hanging on a now-fake `setImmediate` it never advances.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const r1 = await replica({ numSubPollMs: 10 });
            const r2 = await replica({ numSubPollMs: 10 });
            const alice = join(r1.hub, "room", "alice");
            const bob = join(r2.hub, "room", "bob", ["alice"]);
            await vi.advanceTimersByTimeAsync(10);

            alice.conn.message(Buffer.from("x"), true);
            await server.settle();
            expect(bob.sock.frames).toEqual([frameOf("alice", Buffer.from("x"))]);
            expect(r1.bus.stats.published).toBe(1);
            expect(r1.bus.stats.publishSkippedLocalOnly).toBe(0);
        });

        it("stops publishing once the other replica's listener leaves, from the next poll onward.", async () => {
            // Only the interval timer is faked - `setImmediate` stays real, so `server.settle()` (used by some of
            // these tests) keeps working rather than hanging on a now-fake `setImmediate` it never advances.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const r1 = await replica({ numSubPollMs: 10 });
            const r2 = await replica({ numSubPollMs: 10 });
            const alice = join(r1.hub, "room", "alice");
            const bob = join(r2.hub, "room", "bob", ["alice"]);
            await vi.advanceTimersByTimeAsync(10);
            bob.conn.close();
            await vi.advanceTimersByTimeAsync(10);

            alice.conn.message(Buffer.from("x"), true);
            expect(server.commands("PUBLISH")).toHaveLength(0);
            expect(r1.bus.stats.publishSkippedLocalOnly).toBe(1);
        });

        it("counts a failed subscriber-count check as a failure, warns once, and leaves rooms publishing.", async () => {
            // Only the interval timer is faked - `setImmediate` stays real, so `server.settle()` (used by some of
            // these tests) keeps working rather than hanging on a now-fake `setImmediate` it never advances.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const { bus, hub } = await replica({ numSubPollMs: 10 });
            const alice = join(hub, "room", "alice");
            join(hub, "room", "bob", ["alice"]);
            server.fail.pubSubNumSub = true;
            await vi.advanceTimersByTimeAsync(10);

            expect(bus.stats.failures).toBe(1);
            expect(logger.warn.mock.calls[0][0]).toContain("check room subscriber counts");

            server.fail.pubSubNumSub = false;
            alice.conn.message(Buffer.from("x"), true);
            expect(server.commands("PUBLISH")).toHaveLength(1);
        });

        it("does nothing while there are no active rooms.", async () => {
            // Only the interval timer is faked - `setImmediate` stays real, so `server.settle()` (used by some of
            // these tests) keeps working rather than hanging on a now-fake `setImmediate` it never advances.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            await replica({ numSubPollMs: 10 });
            await vi.advanceTimersByTimeAsync(10);
            expect(server.commands("PUBSUB_NUMSUB")).toHaveLength(0);
        });

        it("does nothing while the publisher is not connected.", async () => {
            // Only the interval timer is faked - `setImmediate` stays real, so `server.settle()` (used by some of
            // these tests) keeps working rather than hanging on a now-fake `setImmediate` it never advances.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const { hub } = await replica({ numSubPollMs: 10 });
            join(hub, "room", "alice");
            server.outage();
            await vi.advanceTimersByTimeAsync(10);
            expect(server.commands("PUBSUB_NUMSUB")).toHaveLength(0);
        });

        it("treats a room that appears mid-poll as not yet measured, so it keeps publishing.", async () => {
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const { hub } = await replica({ numSubPollMs: 10 });
            join(hub, "room-a", "alice");
            const publisher = server.clients[0];
            const original = publisher.pubSubNumSub.bind(publisher);
            let carol: Peer;
            vi.spyOn(publisher, "pubSubNumSub").mockImplementationOnce(async (channels: string[]) => {
                // A second room's first local listener arrives after the batch was already queried, but before
                // this poll's result comes back - it was never asked about, so `counts` has nothing for it.
                carol = join(hub, "room-b", "carol");
                return original(channels);
            });

            await vi.advanceTimersByTimeAsync(10);
            carol!.conn.message(Buffer.from("x"), true);
            expect(server.commands("PUBLISH", redisRelayChannel("room-b"))).toHaveLength(1);
        });

        it("checks every active room's channel in one poll.", async () => {
            // Only the interval timer is faked - `setImmediate` stays real, so `server.settle()` (used by some of
            // these tests) keeps working rather than hanging on a now-fake `setImmediate` it never advances.
            vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
            const { hub } = await replica({ numSubPollMs: 10 });
            join(hub, "room-a", "alice");
            join(hub, "room-b", "bob");
            await vi.advanceTimersByTimeAsync(10);
            const checked = server.commands("PUBSUB_NUMSUB").map((op) => op.channel);
            expect(checked).toEqual(expect.arrayContaining([redisRelayChannel("room-a"), redisRelayChannel("room-b")]));
        });
    });

    describe("subscriptions", () => {
        const channel = redisRelayChannel("room");
        const noop: RelayBusListener = () => undefined;

        it("Subscribes on the room's first local listener, once, and unsubscribes on the last one leaving.", async () => {
            const { bus } = await replica();
            const off1 = bus.subscribe("room", noop);
            const off2 = bus.subscribe("room", () => undefined);
            expect(server.commands("SUBSCRIBE", channel)).toHaveLength(1);

            off1();
            expect(server.commands("UNSUBSCRIBE")).toHaveLength(0);
            expect(server.subscribers(channel)).toBe(1);
            off2();
            expect(server.commands("UNSUBSCRIBE", channel)).toHaveLength(1);
            expect(server.subscribers(channel)).toBe(0);
        });

        it("Stops delivering a room's remote frames once its last listener has left, and subscribes again for a new one.", async () => {
            const r1 = await replica();
            const r2 = await replica();
            const alice = join(r1.hub, "room", "alice");
            const bob = join(r2.hub, "room", "bob", ["alice"]);

            bob.conn.close();
            expect(server.commands("UNSUBSCRIBE", channel)).toHaveLength(1);
            expect(r2.hub.roomCount).toBe(0);
            alice.conn.message(Buffer.from("nobody home"), true);
            await server.settle();
            expect(r2.bus.stats.received).toBe(0);
            expect(bob.sock.frames).toEqual([]);

            const bob2 = join(r2.hub, "room", "bob", ["alice"]);
            expect(server.commands("SUBSCRIBE", channel)).toHaveLength(3);
            alice.conn.message(Buffer.from("hello again"), true);
            await server.settle();
            expect(bob2.sock.frames).toEqual([frameOf("alice", Buffer.from("hello again"))]);
        });

        it("Ignores a second call of an unsubscribe function, including after the room was re-created.", async () => {
            const { bus } = await replica();
            const off = bus.subscribe("room", noop);
            off();
            const again = bus.subscribe("room", noop);
            off();
            expect(server.commands("UNSUBSCRIBE")).toHaveLength(1);
            expect(server.subscribers(channel)).toBe(1);
            again();
            expect(server.commands("UNSUBSCRIBE")).toHaveLength(2);
        });

        it("Swallows a failing SUBSCRIBE or UNSUBSCRIBE and keeps delivering locally.", async () => {
            const { bus, hub } = await replica();
            server.fail = { subscribe: true, unsubscribe: true };
            const alice = join(hub, "room", "alice");
            const bob = join(hub, "room", "bob", ["alice"]);
            await server.settle();
            expect(bus.stats.failures).toBe(1);

            alice.conn.message(Buffer.from("local"), true);
            expect(bob.sock.frames).toEqual([frameOf("alice", Buffer.from("local"))]);

            alice.conn.close();
            bob.conn.close();
            await server.settle();
            expect(bus.stats.failures).toBe(2);
            expect(logger.warn).toHaveBeenCalledTimes(1);
        });

        it("Swallows a client that throws instead of rejecting.", async () => {
            const { bus } = await replica();
            const subscriber = server.clients[1];
            subscriber.subscribe = () => {
                throw new Error("sync throw");
            };
            const off = bus.subscribe("room", noop);
            await server.settle();
            expect(bus.stats.failures).toBe(1);
            expect(logger.warn.mock.calls[0][0]).toContain("sync throw");
            off();
        });
    });

    describe("failures of Redis", () => {
        it("Never throws from a failing publish, still delivers locally, and warns at most once per interval.", async () => {
            const { bus, hub } = await replica();
            const alice = join(hub, "room", "alice");
            const bob = join(hub, "room", "bob", ["alice"]);
            server.fail = { publish: true };
            let now: number = Date.now();
            vi.spyOn(Date, "now").mockImplementation(() => now);

            for (let i = 0; i < 5; i++) {
                alice.conn.message(Buffer.from([i]), true);
            }
            await server.settle();
            expect(bob.sock.frames).toHaveLength(5);
            expect(bus.stats.failures).toBe(5);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain("publish a frame");
            expect(logger.debug).toHaveBeenCalledTimes(4);

            now += REDIS_RELAY_WARN_INTERVAL_MS;
            alice.conn.message(Buffer.from([9]), true);
            await server.settle();
            expect(logger.warn).toHaveBeenCalledTimes(2);
        });

        it("Skips publishing while the publisher is not connected - no error, no queueing - and resumes afterwards.", async () => {
            const { bus, hub } = await replica();
            const alice = join(hub, "room", "alice");
            const bob = join(hub, "room", "bob", ["alice"]);
            server.outage();

            for (let i = 0; i < 3; i++) {
                alice.conn.message(Buffer.from([i]), true);
            }
            await server.settle();
            expect(bob.sock.frames).toHaveLength(3);
            expect(bus.stats.publishSkipped).toBe(3);
            expect(bus.stats.failures).toBe(0);
            expect(logger.warn).not.toHaveBeenCalled();
            expect(server.commands("PUBLISH")).toHaveLength(0);

            server.recover();
            alice.conn.message(Buffer.from([7]), true);
            expect(server.commands("PUBLISH")).toHaveLength(1);
        });

        it("Logs a failure that is not an Error object as it is.", async () => {
            const { hub } = await replica();
            const alice = join(hub, "room", "alice");
            server.clients[0].publish = () => Promise.reject("plain string reason");
            alice.conn.message(Buffer.from("x"), true);
            await server.settle();
            expect(logger.warn.mock.calls[0][0]).toContain("plain string reason");
        });

        it("Rejects a publish an offline publisher would have queued, as it has no offline queue.", async () => {
            // A frame that raced the connection going down: `isReady` was true when checked, false at send.
            const { bus, hub } = await replica();
            const alice = join(hub, "room", "alice");
            const publisher = server.clients[0];
            const publish = publisher.publish.bind(publisher);
            publisher.publish = async (channel, message) => {
                publisher.isReady = false;
                return await publish(channel, message);
            };
            alice.conn.message(Buffer.from("x"), true);
            await server.settle();
            expect(bus.stats.failures).toBe(1);
            expect(logger.warn.mock.calls[0][0]).toContain("offline");
        });

        it("Publishes nothing for a sender id that cannot be encoded in one length byte, but still delivers it locally.", async () => {
            const { bus } = await replica();
            const heard: [string, Buffer][] = [];
            bus.subscribe("room", (sender, frame) => heard.push([sender, frame]));
            bus.publish("room", "x".repeat(256), Buffer.from("f"));
            bus.publish("room", "", Buffer.from("f"));
            expect(heard).toHaveLength(2);
            expect(bus.stats.publishSkipped).toBe(2);
            expect(server.commands("PUBLISH")).toHaveLength(0);
        });
    });

    describe("inbound messages", () => {
        const channel = redisRelayChannel("room");
        const other = Buffer.alloc(REDIS_RELAY_ORIGIN_BYTES, 7);

        async function listening(): Promise<{ bus: RedisRelayBus; heard: [string, Buffer][] }> {
            const { bus } = await replica();
            const heard: [string, Buffer][] = [];
            bus.subscribe("room", (sender, frame) => heard.push([sender, frame]));
            return { bus, heard };
        }

        it("Delivers a well-formed message from another origin and drops every garbled one, without throwing.", async () => {
            const { bus, heard } = await listening();
            const good = wire(other, "alice", Buffer.from([5, 0x61, 0x6c, 0x69, 0x63, 0x65, 9]));
            const garbled: (Buffer | string)[] = [
                Buffer.alloc(0),
                Buffer.from("short"),
                Buffer.concat([other, Buffer.from([1])]),
                // A zero-length sender.
                Buffer.concat([other, Buffer.from([0]), Buffer.from([1, 2, 3])]),
                // A length byte that overruns the message.
                Buffer.concat([other, Buffer.from([200]), Buffer.from("abc")]),
                // A sender and no frame at all.
                Buffer.concat([other, Buffer.from([3]), Buffer.from("abc")]),
                // Not a buffer (a client that was not in buffer mode).
                "a string message",
            ];
            for (const message of garbled) {
                server.deliver(channel, message);
            }
            server.deliver(channel, good);
            await server.settle();

            expect(heard).toEqual([["alice", good.subarray(REDIS_RELAY_ORIGIN_BYTES + 1 + 5)]]);
            expect(bus.stats.received).toBe(1);
            expect(bus.stats.receivedDropped).toBe(garbled.length);
            expect(bus.stats.failures).toBe(0);
        });

        it("Drops a bus's own messages, whatever their content.", async () => {
            const { bus, heard } = await listening();
            bus.publish("room", "alice", frameOf("alice", Buffer.from("x")));
            await server.settle();
            expect(heard).toHaveLength(1);
            expect(bus.stats.receivedDropped).toBe(1);
        });

        it("Drops a message for a room with no local listener left (it arrived while unsubscribing).", async () => {
            const { bus } = await replica();
            const off = bus.subscribe("room", () => undefined);
            // Redis had already sent it when the UNSUBSCRIBE was issued.
            const subscription = [...server.clients[1].subscriptions.get(channel)!][0];
            off();
            subscription.listener(wire(other, "alice", Buffer.from([1, 2])), Buffer.from(channel));
            expect(bus.stats.receivedDropped).toBe(1);
        });

        it("Keeps a throwing listener from escaping into the Redis client's dispatch.", async () => {
            const { bus } = await replica();
            bus.subscribe("room", () => {
                throw new Error("listener blew up");
            });
            server.deliver(channel, wire(other, "alice", Buffer.from([1, 2])));
            await server.settle();
            expect(bus.stats.failures).toBe(1);
            expect(logger.warn.mock.calls[0][0]).toContain("listener blew up");
        });
    });

    describe("without Redis", () => {
        it("Behaves as an in-process bus before connect().", () => {
            const bus = new RedisRelayBus({ url: "redis://fake", logger });
            const heard: string[] = [];
            const off = bus.subscribe("room", (sender) => heard.push(sender));
            bus.publish("room", "alice", Buffer.from("f"));
            off();
            bus.publish("room", "bob", Buffer.from("f"));
            expect(heard).toEqual(["alice"]);
            expect(server.ops).toHaveLength(0);
        });
    });

    describe("close", () => {
        it("Destroys both clients, stops publishing and keeps delivering locally.", async () => {
            const { bus, hub } = await replica();
            const alice = join(hub, "room", "alice");
            const bob = join(hub, "room", "bob", ["alice"]);
            expect(bus.connected).toBe(true);

            bus.close();
            expect(server.clients.map((c) => c.destroyed)).toEqual([true, true]);
            expect(bus.connected).toBe(false);

            alice.conn.message(Buffer.from("still here"), true);
            expect(bob.sock.frames).toEqual([frameOf("alice", Buffer.from("still here"))]);
            expect(server.commands("PUBLISH")).toHaveLength(0);

            // Rooms that empty afterwards do not try to UNSUBSCRIBE on a dead client.
            alice.conn.close();
            bob.conn.close();
            expect(server.commands("UNSUBSCRIBE")).toHaveLength(0);
            bus.close();
        });

        it("Is safe on a bus that never connected, and survives a client that fails to be destroyed.", async () => {
            new RedisRelayBus({ url: "redis://fake", logger }).close();
            const { bus } = await replica();
            server.failDestroy = true;
            bus.close();
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain("destroy a client");
            expect(bus.connected).toBe(false);
            server.failDestroy = false;
        });
    });
});
