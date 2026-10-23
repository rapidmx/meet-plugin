///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { InProcessRelayBus, type RelayBus, type RelayBusListener, type RelayConnection, type RelaySocket } from "../../src/util/RelayHub.js";
import {
    SIGNALING_BURST_BYTES,
    SIGNALING_BURST_MESSAGES,
    SIGNALING_EVICTED_REASON,
    SIGNALING_HELLO_TIMEOUT_MS,
    SIGNALING_LARGE_PAYLOAD_BYTES,
    SIGNALING_MAX_PAYLOAD_BYTES,
    SIGNALING_MAX_SOCKETS_PER_ROOM,
    SIGNALING_MAX_SOCKETS_PER_UID,
    SIGNALING_OVER_BUDGET_CLOSE_MS,
    SIGNALING_PROTOCOL_VERSION,
    SignalingHub,
    signalingBusRoom,
} from "../../src/util/SignalingHub.js";

/** A socket that records what it was sent and how it was closed; `throwOnSend` makes `send()` throw. */
class FakeSocket implements RelaySocket {
    public sent: (string | Uint8Array)[] = [];
    public closed?: { code?: number; reason?: string };
    public throwOnSend = false;

    public send(data: string | Uint8Array): void {
        if (this.throwOnSend) {
            throw new Error("socket is gone");
        }
        this.sent.push(data);
    }

    public close(code?: number, reason?: string): void {
        this.closed = { code, reason };
    }

    public get texts(): any[] {
        return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
    }

    /** The `data` of every `signal` message this socket received. */
    public get signals(): any[] {
        return this.texts.filter((m) => m.op === "signal").map((m) => m.data);
    }
}

interface Peer {
    sock: FakeSocket;
    conn: RelayConnection;
    peer: string;
}

const READY = { op: "ready", v: 1, maxMessageBytes: SIGNALING_MAX_PAYLOAD_BYTES };

const text = (conn: RelayConnection, message: unknown): void => conn.message(typeof message === "string" ? message : JSON.stringify(message), false);
const signal = (p: Peer, data: unknown): void => text(p.conn, { op: "signal", data });

/** Attaches a socket for `uid` to `room` and, unless `peer` is `null`, completes its `hello` as `peer`. */
function connect(hub: SignalingHub, room: string, uid: string, peer: string | null = uid): Peer {
    const sock: FakeSocket = new FakeSocket();
    const conn: RelayConnection | undefined = hub.attach(room, uid, sock);
    expect(conn).toBeDefined();
    if (peer !== null) {
        text(conn!, { op: "hello", v: 1, peer });
    }
    return { sock, conn: conn!, peer: peer ?? "" };
}

/** A bus that records subscriptions and publishes, and never delivers anything by itself. */
class RecordingBus implements RelayBus {
    public listeners = new Map<string, RelayBusListener>();
    public unsubscribed: string[] = [];
    public published: { room: string; sender: string; frame: any }[] = [];

    public subscribe(roomId: string, listener: RelayBusListener): () => void {
        this.listeners.set(roomId, listener);
        return () => {
            this.unsubscribed.push(roomId);
            this.listeners.delete(roomId);
        };
    }

    public publish(room: string, sender: string, frame: Buffer): void {
        this.published.push({ room, sender, frame: JSON.parse(frame.toString("utf8")) });
    }
}

describe("SignalingHub", () => {
    let hub: SignalingHub;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        hub = new SignalingHub();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("Namespaces its bus rooms apart from the relay's.", () => {
        expect(signalingBusRoom("abc")).toBe("signal:abc");
        expect(SIGNALING_PROTOCOL_VERSION).toBe(1);
    });

    describe("hello", () => {
        it("Answers a valid hello with ready, for the uid itself or a `<uid>~suffix` peer.", () => {
            const a = connect(hub, "room", "alice");
            expect(a.sock.texts).toEqual([READY]);
            const b = connect(hub, "room", "alice", "alice~tab-1");
            expect(b.sock.texts).toEqual([READY]);
            const c = connect(hub, "room", "guest:abc_-", "guest:abc_-~é");
            expect(c.sock.texts).toEqual([READY]);
            expect(a.sock.closed).toBeUndefined();
            expect(hub.socketCount("room")).toBe(3);
        });

        it.each([
            ["a peer that is not the uid", "bob"],
            ["a peer that only starts with the uid", "alicex"],
            ["a peer with another uid's prefix", "bob~alice"],
            ["a peer with whitespace", "alice~a b"],
            ["a non-string peer", 42],
            ["a missing peer", undefined],
            ["an empty peer", ""],
        ])("Closes the socket with 1008 \"Invalid peer.\" for %s.", (_name, peer) => {
            const sock = new FakeSocket();
            const conn = hub.attach("room", "alice", sock)!;
            text(conn, { op: "hello", v: 1, peer });
            expect(sock.closed).toEqual({ code: 1008, reason: "Invalid peer." });
            expect(sock.sent).toEqual([]);
            expect(hub.roomCount).toBe(0);
            // Its own close event, arriving afterwards, is harmless.
            expect(() => conn.close()).not.toThrow();
        });

        it("Closes the socket with 1008 \"Unsupported version.\" for a hello of another protocol version.", () => {
            for (const v of [2, undefined, "1"]) {
                const sock = new FakeSocket();
                text(hub.attach("room", "alice", sock)!, { op: "hello", v, peer: "alice" });
                expect(sock.closed).toEqual({ code: 1008, reason: "Unsupported version." });
            }
        });

        it("Closes the socket with 1008 \"Hello timeout.\" when no hello arrives in time, and only then.", () => {
            const silent = new FakeSocket();
            hub.attach("room", "alice", silent);
            const registered = connect(hub, "room", "bob");

            vi.advanceTimersByTime(SIGNALING_HELLO_TIMEOUT_MS - 1);
            expect(silent.closed).toBeUndefined();
            vi.advanceTimersByTime(1);
            expect(silent.closed).toEqual({ code: 1008, reason: "Hello timeout." });
            // The socket that said hello in time had its timer cleared.
            vi.advanceTimersByTime(SIGNALING_HELLO_TIMEOUT_MS * 2);
            expect(registered.sock.closed).toBeUndefined();
            expect(hub.socketCount("room")).toBe(1);
        });

        it("Treats a second hello from a registered socket as an unknown message.", () => {
            const a = connect(hub, "room", "alice");
            text(a.conn, { op: "hello", v: 1, peer: "alice~other" });
            expect(a.sock.texts).toEqual([READY]);
            expect(a.sock.closed).toBeUndefined();
            expect(hub.stats.droppedInvalid).toBe(1);
            // Still registered under its first peer id.
            const b = connect(hub, "room", "bob");
            signal(b, { to: "alice", n: 1 });
            expect(a.sock.signals).toEqual([{ to: "alice", n: 1, from: "bob", peer: "bob" }]);
        });

        it("Survives a socket whose send() throws while answering the hello.", () => {
            const sock = new FakeSocket();
            sock.throwOnSend = true;
            const conn = hub.attach("room", "alice", sock)!;
            expect(() => text(conn, { op: "hello", v: 1, peer: "alice" })).not.toThrow();
            expect(sock.closed).toBeUndefined();
        });

        it("Reads a text message delivered as bytes (the `ws` library hands text over as a Buffer).", () => {
            const sock = new FakeSocket();
            const conn = hub.attach("room", "alice", sock)!;
            conn.message(Buffer.from(JSON.stringify({ op: "hello", v: 1, peer: "alice" })), false);
            expect(sock.texts).toEqual([READY]);
        });

        it("Tells the client a configured larger message limit in ready.", () => {
            hub = new SignalingHub({ maxPayloadBytes: SIGNALING_LARGE_PAYLOAD_BYTES });
            const a = connect(hub, "room", "alice");
            expect(a.sock.texts).toEqual([{ op: "ready", v: 1, maxMessageBytes: SIGNALING_LARGE_PAYLOAD_BYTES }]);
        });
    });

    describe("replacing a peer", () => {
        it("Closes the older socket with 1008 \"Replaced.\" and routes to the newer one.", () => {
            const first = connect(hub, "room", "alice", "alice~tab");
            const sender = connect(hub, "room", "bob");
            const second = connect(hub, "room", "alice", "alice~tab");

            expect(first.sock.closed).toEqual({ code: 1008, reason: "Replaced." });
            expect(second.sock.closed).toBeUndefined();
            expect(hub.socketCount("room")).toBe(2);

            signal(sender, { n: 1 });
            expect(first.sock.signals).toEqual([]);
            expect(second.sock.signals).toHaveLength(1);
        });

        it("Is not undone by the replaced socket's own close event arriving afterwards.", () => {
            const first = connect(hub, "room", "alice");
            const second = connect(hub, "room", "alice");
            const sender = connect(hub, "room", "bob");
            first.conn.close();
            expect(hub.socketCount("room")).toBe(2);
            signal(sender, { to: "alice" });
            expect(second.sock.signals).toHaveLength(1);
        });
    });

    describe("ignored input", () => {
        it("Drops malformed, binary and non-hello messages before hello.", () => {
            const a = connect(hub, "room", "alice", null);
            const b = connect(hub, "room", "bob");

            text(a.conn, "not json");
            text(a.conn, "42");
            text(a.conn, "null");
            text(a.conn, "[1,2]");
            text(a.conn, { op: "signal", data: { n: 1 } });
            text(a.conn, { op: "ping", t: 1 });
            text(a.conn, { nothing: true });
            a.conn.message(Buffer.from([1, 2, 3]), true);

            expect(a.sock.sent).toEqual([]);
            expect(a.sock.closed).toBeUndefined();
            expect(b.sock.signals).toEqual([]);
            expect(hub.stats.droppedInvalid).toBe(8);
        });

        it("Drops malformed, binary, oversized and unknown messages after hello without closing the socket.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");

            text(a.conn, "not json");
            text(a.conn, "null");
            text(a.conn, "[]");
            text(a.conn, '"a string"');
            text(a.conn, { op: "unknown" });
            a.conn.message(JSON.stringify({ op: "signal", data: { n: 1 } }), true);
            text(a.conn, `{"op":"signal","data":{"pad":"${"x".repeat(SIGNALING_MAX_PAYLOAD_BYTES)}"}}`);
            for (const data of [undefined, null, "text", 7, [1, 2]]) {
                text(a.conn, { op: "signal", data });
            }

            expect(hub.stats.droppedInvalid).toBe(12);
            expect(b.sock.signals).toEqual([]);
            expect(a.sock.closed).toBeUndefined();

            // A message of exactly the limit still goes through.
            const prefix = '{"op":"signal","data":{"pad":"';
            const suffix = '"}}';
            text(a.conn, prefix + "x".repeat(SIGNALING_MAX_PAYLOAD_BYTES - prefix.length - suffix.length) + suffix);
            expect(b.sock.signals).toHaveLength(1);
        });

        it("Ignores everything a socket sends once it was closed.", () => {
            const a = connect(hub, "room", "alice", null);
            a.conn.close();
            a.conn.close();
            text(a.conn, { op: "hello", v: 1, peer: "alice" });
            expect(a.sock.sent).toEqual([]);
            expect(hub.stats.droppedInvalid).toBe(0);
        });
    });

    describe("ping", () => {
        it("Echoes a ping's finite t straight back as a pong.", () => {
            const a = connect(hub, "room", "alice");
            text(a.conn, { op: "ping", t: 1234.5 });
            text(a.conn, { op: "ping", t: -7 });
            expect(a.sock.texts.slice(1)).toEqual([
                { op: "pong", t: 1234.5 },
                { op: "pong", t: -7 },
            ]);
        });

        it("Ignores a ping without a finite number t.", () => {
            const a = connect(hub, "room", "alice");
            text(a.conn, { op: "ping" });
            text(a.conn, { op: "ping", t: "12" });
            text(a.conn, '{"op":"ping","t":1e999}');
            expect(a.sock.texts).toEqual([READY]);
            expect(a.sock.closed).toBeUndefined();
        });
    });

    describe("signal", () => {
        it("Broadcasts to every other registered socket of the room, never back to its sender or to one awaiting hello.", () => {
            const a = connect(hub, "room", "alice", "alice~tab");
            const b = connect(hub, "room", "bob");
            const c = connect(hub, "room", "carol");
            const pending = connect(hub, "room", "dave", null);
            const elsewhere = connect(hub, "other", "erin");

            signal(a, { type: "presence", n: 1 });

            const expected = { type: "presence", n: 1, from: "alice", peer: "alice~tab" };
            expect(b.sock.texts.slice(1)).toEqual([{ op: "signal", data: expected }]);
            expect(c.sock.signals).toEqual([expected]);
            expect(a.sock.signals).toEqual([]);
            expect(pending.sock.sent).toEqual([]);
            expect(elsewhere.sock.signals).toEqual([]);
            expect(hub.stats.delivered).toBe(2);
        });

        it("Stamps from and peer from the authenticated socket, overwriting forged ones.", () => {
            const a = connect(hub, "room", "alice", "alice~1");
            const b = connect(hub, "room", "bob");
            signal(a, { from: "bob", peer: "bob", n: 1 });
            expect(b.sock.signals).toEqual([{ from: "alice", peer: "alice~1", n: 1 }]);
        });

        it("Delivers a message naming `to` only to that peer.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob", "bob~1");
            const c = connect(hub, "room", "carol");
            signal(a, { type: "offer", to: "bob~1" });
            expect(b.sock.signals).toEqual([{ type: "offer", to: "bob~1", from: "alice", peer: "alice" }]);
            expect(c.sock.signals).toEqual([]);
            expect(hub.stats.delivered).toBe(1);
        });

        it("Delivers a `to` naming an absent peer, or the sender itself, to nobody.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            signal(a, { to: "nobody" });
            signal(a, { to: "alice" });
            expect(b.sock.signals).toEqual([]);
            expect(a.sock.signals).toEqual([]);
            expect(hub.stats.delivered).toBe(0);
            expect(hub.stats.droppedInvalid).toBe(0);
        });

        it("Drops a message whose `to` is not a valid peer id.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            for (const to of [42, null, "", "a b", "x".repeat(200)]) {
                signal(a, { to });
            }
            expect(b.sock.signals).toEqual([]);
            expect(hub.stats.droppedInvalid).toBe(5);
        });

        it("Survives a receiver whose send() throws, still serving the others and not counting it as delivered.", () => {
            const a = connect(hub, "room", "alice");
            const broken = connect(hub, "room", "bob");
            const fine = connect(hub, "room", "carol");
            broken.sock.throwOnSend = true;
            expect(() => signal(a, { n: 1 })).not.toThrow();
            expect(fine.sock.signals).toHaveLength(1);
            expect(hub.stats.delivered).toBe(1);
            expect(broken.sock.closed).toBeUndefined();
        });
    });

    describe("rate limiting", () => {
        it("Passes a full burst of messages, drops beyond it, and passes again once the bucket has refilled.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            for (let i = 0; i < SIGNALING_BURST_MESSAGES + 5; i++) {
                signal(a, { i });
            }
            expect(b.sock.signals).toHaveLength(SIGNALING_BURST_MESSAGES);
            expect(hub.stats.droppedBudget).toBe(5);
            expect(a.sock.closed).toBeUndefined();

            // 50 messages a second: a tenth of a second buys 5 more.
            vi.advanceTimersByTime(100);
            for (let i = 0; i < 10; i++) {
                signal(a, { i });
            }
            expect(b.sock.signals).toHaveLength(SIGNALING_BURST_MESSAGES + 5);
        });

        it("Limits bytes as well as messages.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            const pad = "x".repeat(SIGNALING_MAX_PAYLOAD_BYTES - 100);
            for (let i = 0; i < SIGNALING_BURST_MESSAGES; i++) {
                signal(a, { pad });
            }
            const passed = b.sock.signals.length;
            // Bounded by the byte bucket, well before the message bucket would be.
            expect(passed).toBe(Math.floor(SIGNALING_BURST_BYTES / (SIGNALING_MAX_PAYLOAD_BYTES - 100 + '{"op":"signal","data":{"pad":""}}'.length)));
            expect(passed).toBeLessThan(SIGNALING_BURST_MESSAGES);
            expect(hub.stats.droppedBudget).toBe(SIGNALING_BURST_MESSAGES - passed);
        });

        it("Closes a socket kept over budget for more than 10 seconds with 1008 \"Too much data.\".", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");

            let elapsed = 0;
            while (!a.sock.closed && elapsed < SIGNALING_OVER_BUDGET_CLOSE_MS * 3) {
                // 200 messages a second against a budget of 50.
                for (let i = 0; i < 20; i++) {
                    signal(a, { i });
                }
                vi.advanceTimersByTime(100);
                elapsed += 100;
            }

            expect(a.sock.closed).toEqual({ code: 1008, reason: "Too much data." });
            // The burst empties in about 1.3 s, and the first drop starts the 10 s clock.
            expect(elapsed).toBeGreaterThan(SIGNALING_OVER_BUDGET_CLOSE_MS);
            expect(elapsed).toBeLessThan(SIGNALING_OVER_BUDGET_CLOSE_MS + 3000);
            expect(hub.socketCount("room")).toBe(1);
            const before = b.sock.signals.length;
            signal(a, { late: true });
            expect(b.sock.signals).toHaveLength(before);
        });

        it("Does not close a socket that only goes over budget now and then, however long that goes on.", () => {
            const a = connect(hub, "room", "alice");
            for (let round = 0; round < 8; round++) {
                // Empty the bucket and send one more: a lone drop, then quiet seconds to refill.
                for (let i = 0; i < SIGNALING_BURST_MESSAGES + 1; i++) {
                    signal(a, { i });
                }
                vi.advanceTimersByTime(5000);
            }
            expect(hub.stats.droppedBudget).toBe(8);
            expect(a.sock.closed).toBeUndefined();
        });
    });

    describe("limits", () => {
        it("Refuses a socket over the per-room maximum with 1008 \"Room full.\", counting sockets still awaiting hello.", () => {
            for (let i = 0; i < SIGNALING_MAX_SOCKETS_PER_ROOM; i++) {
                const uid = `user-${Math.floor(i / SIGNALING_MAX_SOCKETS_PER_UID)}`;
                connect(hub, "room", uid, i % 2 === 0 ? `${uid}~${i}` : null);
            }
            expect(hub.socketCount("room")).toBe(SIGNALING_MAX_SOCKETS_PER_ROOM);

            const refused = new FakeSocket();
            expect(hub.attach("room", "someone-else", refused)).toBeUndefined();
            expect(refused.closed).toEqual({ code: 1008, reason: "Room full." });
            expect(hub.socketCount("room")).toBe(SIGNALING_MAX_SOCKETS_PER_ROOM);
            expect(hub.attach("other", "someone-else", new FakeSocket())).toBeDefined();
        });

        it("Refuses a fifth socket of one uid with 1008 \"Too many connections.\", but not another uid's, and frees a slot on close.", () => {
            const held: Peer[] = [];
            for (let i = 0; i < SIGNALING_MAX_SOCKETS_PER_UID; i++) {
                held.push(connect(hub, "room", "alice", `alice~${i}`));
            }
            const refused = new FakeSocket();
            expect(hub.attach("room", "alice", refused)).toBeUndefined();
            expect(refused.closed).toEqual({ code: 1008, reason: "Too many connections." });
            expect(hub.attach("room", "bob", new FakeSocket())).toBeDefined();
            expect(hub.attach("elsewhere", "alice", new FakeSocket())).toBeDefined();

            held[0].conn.close();
            expect(hub.attach("room", "alice", new FakeSocket())).toBeDefined();
        });
    });

    describe("evict", () => {
        it("Closes every socket of the uid in the room with 1008, registered or not, and leaves everyone else alone.", () => {
            const a1 = connect(hub, "room", "alice", "alice~1");
            const a2 = connect(hub, "room", "alice", null);
            const b = connect(hub, "room", "bob");
            const elsewhere = connect(hub, "other", "alice");

            hub.evict("room", "alice");

            expect(a1.sock.closed).toEqual({ code: 1008, reason: SIGNALING_EVICTED_REASON });
            expect(a2.sock.closed).toEqual({ code: 1008, reason: SIGNALING_EVICTED_REASON });
            expect(b.sock.closed).toBeUndefined();
            expect(elsewhere.sock.closed).toBeUndefined();
            expect(hub.socketCount("room")).toBe(1);

            // The evicted peer no longer receives anything.
            signal(b, { to: "alice~1" });
            expect(a1.sock.signals).toEqual([]);
        });

        it("Is a no-op for a room this hub holds no socket in.", () => {
            expect(() => hub.evict("nowhere", "alice")).not.toThrow();
            expect(hub.roomCount).toBe(0);
        });

        it("Publishes the eviction on the bus, and evicts locally even when the bus delivers nothing back.", () => {
            const bus = new RecordingBus();
            hub = new SignalingHub({ bus });
            const a = connect(hub, "room", "alice");
            hub.evict("room", "alice");
            expect(bus.published).toEqual([{ room: "signal:room", sender: "~evict", frame: { t: "evict", uid: "alice" } }]);
            expect(a.sock.closed).toEqual({ code: 1008, reason: SIGNALING_EVICTED_REASON });
        });
    });

    describe("replicas (two hubs on one bus)", () => {
        let bus: InProcessRelayBus;
        let replica1: SignalingHub;
        let replica2: SignalingHub;

        beforeEach(() => {
            bus = new InProcessRelayBus();
            replica1 = new SignalingHub({ bus });
            replica2 = new SignalingHub({ bus });
        });

        it("Carries broadcasts and `to` messages to participants connected to another hub.", () => {
            const a = connect(replica1, "room", "alice");
            const b = connect(replica2, "room", "bob");
            const c = connect(replica2, "room", "carol");

            signal(a, { n: 1 });
            expect(b.sock.signals).toEqual([{ n: 1, from: "alice", peer: "alice" }]);
            expect(c.sock.signals).toEqual([{ n: 1, from: "alice", peer: "alice" }]);
            expect(a.sock.signals).toEqual([]);

            signal(b, { n: 2, to: "alice" });
            expect(a.sock.signals).toEqual([{ n: 2, to: "alice", from: "bob", peer: "bob" }]);
            expect(c.sock.signals).toHaveLength(1);
        });

        it("Evicts a uid's sockets on another hub, even from a hub holding no socket in the room.", () => {
            const a = connect(replica1, "room", "alice");
            const b = connect(replica1, "room", "bob");

            replica2.evict("room", "alice");

            expect(a.sock.closed).toEqual({ code: 1008, reason: SIGNALING_EVICTED_REASON });
            expect(b.sock.closed).toBeUndefined();
            expect(replica1.socketCount("room")).toBe(1);
            expect(replica2.roomCount).toBe(0);
        });
    });

    describe("cleanup and counts", () => {
        it("Deletes an emptied room and its bus subscription, and forgets a closed socket's timer.", () => {
            const bus = new RecordingBus();
            hub = new SignalingHub({ bus });
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob", null);
            connect(hub, "other", "carol").conn.close();
            expect(bus.unsubscribed).toEqual(["signal:other"]);
            expect(hub.roomCount).toBe(1);
            expect(hub.socketCount("room")).toBe(2);
            expect([...bus.listeners.keys()]).toEqual(["signal:room"]);

            a.conn.close();
            expect(hub.socketCount("room")).toBe(1);
            b.conn.close();
            expect(hub.roomCount).toBe(0);
            expect(hub.socketCount("room")).toBe(0);
            expect(bus.unsubscribed).toEqual(["signal:other", "signal:room"]);

            vi.advanceTimersByTime(SIGNALING_HELLO_TIMEOUT_MS * 2);
            expect(b.sock.closed).toBeUndefined();
            expect(vi.getTimerCount()).toBe(0);
        });

        it("Subscribes once per room, and starts a fresh room after the old one was deleted.", () => {
            const bus = new RecordingBus();
            const subscribe = vi.spyOn(bus, "subscribe");
            hub = new SignalingHub({ bus });
            connect(hub, "room", "alice");
            connect(hub, "room", "bob");
            expect(subscribe).toHaveBeenCalledTimes(1);

            hub = new SignalingHub();
            connect(hub, "room", "alice").conn.close();
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            signal(a, { n: 1 });
            expect(b.sock.signals).toHaveLength(1);
        });

        it("Publishes a stamped frame on the bus instead of delivering it directly.", () => {
            const bus = new RecordingBus();
            hub = new SignalingHub({ bus });
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            signal(a, { n: 1, to: "bob" });
            expect(bus.published).toEqual([{ room: "signal:room", sender: "alice", frame: { t: "m", to: "bob", d: { n: 1, to: "bob", from: "alice", peer: "alice" } } }]);
            signal(a, { n: 2 });
            expect(bus.published[1].frame).toEqual({ t: "m", d: { n: 2, from: "alice", peer: "alice" } });
            expect(b.sock.signals).toEqual([]);
        });
    });

    describe("bus frames", () => {
        it("Ignores, and logs, an unreadable frame; ignores one of an unknown kind.", () => {
            const bus = new RecordingBus();
            const debug = vi.fn();
            hub = new SignalingHub({ bus, logger: { debug } });
            const a = connect(hub, "room", "alice");
            const listener = bus.listeners.get("signal:room")!;

            expect(() => listener("x", Buffer.from("not json"))).not.toThrow();
            expect(debug).toHaveBeenCalledWith("Ignored an unreadable signaling frame in signal:room.");
            listener("x", Buffer.from("null"));
            listener("x", Buffer.from('{"t":"zzz"}'));
            expect(a.sock.signals).toEqual([]);
            expect(a.sock.closed).toBeUndefined();
        });

        it("Ignores an unreadable frame without a logger configured.", () => {
            const bus = new RecordingBus();
            hub = new SignalingHub({ bus });
            connect(hub, "room", "alice");
            expect(() => bus.listeners.get("signal:room")!("x", Buffer.from("{"))).not.toThrow();
        });

        it("Delivers a frame from another process, and ignores one still in flight for a room that has since emptied.", () => {
            const bus = new RecordingBus();
            hub = new SignalingHub({ bus });
            const a = connect(hub, "room", "alice");
            const listener = bus.listeners.get("signal:room")!;
            const frame = Buffer.from(JSON.stringify({ t: "m", d: { n: 1, from: "remote", peer: "remote" } }));

            listener("remote", frame);
            expect(a.sock.signals).toEqual([{ n: 1, from: "remote", peer: "remote" }]);

            a.conn.close();
            expect(hub.roomCount).toBe(0);
            expect(() => listener("remote", frame)).not.toThrow();
            expect(hub.stats.delivered).toBe(1);
        });
    });
});
