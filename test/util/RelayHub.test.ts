///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    InProcessRelayBus,
    isValidRelayPeer,
    parseRelayEnabled,
    RELAY_BURST_BYTES,
    RELAY_HELLO_TIMEOUT_MS,
    RELAY_LARGE_PAYLOAD_BYTES,
    RELAY_MAX_PAYLOAD_BYTES,
    RELAY_WS_MAX_BACKPRESSURE_BYTES,
    RELAY_MAX_SOCKETS_PER_ROOM,
    RELAY_MAX_SOCKETS_PER_UID,
    RELAY_MAX_WANT_PEERS,
    RELAY_OVER_BUDGET_CLOSE_MS,
    RelayHub,
    type RelayBus,
    type RelayBusListener,
    type RelayConnection,
    type RelaySocket,
} from "../../src/util/RelayHub.js";

/** A socket that records what it was sent and how it was closed. `sendResult` decides how `send()` behaves. */
class FakeSocket implements RelaySocket {
    public sent: (string | Uint8Array)[] = [];
    public closed?: { code?: number; reason?: string };
    public sendResult: "ok" | "dropped" | "throw" = "ok";

    public send(data: string | Uint8Array, cb?: (err?: Error | null) => void): void {
        if (this.sendResult === "throw") {
            throw new Error("socket is gone");
        }
        this.sent.push(data);
        cb?.(this.sendResult === "dropped" ? new Error("uWS backpressure limit reached: message dropped") : undefined);
    }

    public close(code?: number, reason?: string): void {
        this.closed = { code, reason };
    }

    public get texts(): any[] {
        return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
    }

    public get frames(): Buffer[] {
        return this.sent.filter((d) => typeof d !== "string").map((d) => Buffer.from(d));
    }
}

interface Peer {
    sock: FakeSocket;
    conn: RelayConnection;
    peer: string;
}

const text = (conn: RelayConnection, message: unknown): void => conn.message(typeof message === "string" ? message : JSON.stringify(message), false);
const binary = (conn: RelayConnection, payload: Uint8Array): void => conn.message(payload, true);

/** Attaches a socket for `uid` to `room` and, unless `peer` is `null`, completes its `hello` as `peer`. */
function connect(hub: RelayHub, room: string, uid: string, peer: string | null = uid): Peer {
    const sock: FakeSocket = new FakeSocket();
    const conn: RelayConnection | undefined = hub.attach(room, uid, sock);
    expect(conn).toBeDefined();
    if (peer !== null) {
        text(conn!, { op: "hello", v: 1, peer });
    }
    return { sock, conn: conn!, peer: peer ?? "" };
}

const want = (p: Peer, peers: string[]): void => text(p.conn, { op: "want", peers });

/** The `[len][sender][payload]` a receiver is expected to get. */
const frameOf = (sender: string, payload: Uint8Array): Buffer => {
    const name: Buffer = Buffer.from(sender, "utf8");
    return Buffer.concat([Buffer.from([name.length]), name, payload]);
};

describe("RelayHub", () => {
    let hub: RelayHub;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        hub = new RelayHub();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("hello", () => {
        it("Answers a valid hello with ready, for the uid itself or a `<uid>~suffix` peer.", () => {
            const a = connect(hub, "room", "alice");
            expect(a.sock.texts).toEqual([{ op: "ready", v: 1, maxMessageBytes: RELAY_MAX_PAYLOAD_BYTES }]);
            const b = connect(hub, "room", "alice", "alice~tab-1");
            expect(b.sock.texts).toEqual([{ op: "ready", v: 1, maxMessageBytes: RELAY_MAX_PAYLOAD_BYTES }]);
            const c = connect(hub, "room", "guest:abc_-", "guest:abc_-~é");
            expect(c.sock.texts).toEqual([{ op: "ready", v: 1, maxMessageBytes: RELAY_MAX_PAYLOAD_BYTES }]);
            expect(a.sock.closed).toBeUndefined();
        });

        it.each([
            ["a peer that is not the uid", "bob"],
            ["a peer that only starts with the uid", "alicex"],
            ["a peer with another uid's prefix", "bob~alice"],
            ["a peer with whitespace", "alice~a b"],
            ["a peer with a control character", "alice~a\u0007"],
            ["a peer with an invisible character", "alice~a​b"],
            ["a peer over 128 characters", `alice~${"x".repeat(128)}`],
            ["a peer whose UTF-8 encoding is over 255 bytes", `alice~${"€".repeat(90)}`],
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

            vi.advanceTimersByTime(RELAY_HELLO_TIMEOUT_MS - 1);
            expect(silent.closed).toBeUndefined();
            vi.advanceTimersByTime(1);
            expect(silent.closed).toEqual({ code: 1008, reason: "Hello timeout." });
            expect(registered.sock.closed).toBeUndefined();
            expect(hub.socketCount("room")).toBe(1);
        });

        it("Ignores a second hello from an already registered socket.", () => {
            const a = connect(hub, "room", "alice");
            text(a.conn, { op: "hello", v: 1, peer: "alice~other" });
            expect(a.sock.texts).toEqual([{ op: "ready", v: 1, maxMessageBytes: RELAY_MAX_PAYLOAD_BYTES }]);
            expect(a.sock.closed).toBeUndefined();
            // Still registered under its first peer id.
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);
            binary(a.conn, Buffer.from([1]));
            expect(b.sock.frames).toHaveLength(1);
        });

        it("Survives a socket whose send() throws while answering the hello.", () => {
            const sock = new FakeSocket();
            sock.sendResult = "throw";
            const conn = hub.attach("room", "alice", sock)!;
            expect(() => text(conn, { op: "hello", v: 1, peer: "alice" })).not.toThrow();
            expect(sock.closed).toBeUndefined();
        });
    });

    describe("ignored input", () => {
        it("Ignores malformed and non-hello text before hello, and binary before hello.", () => {
            const a = connect(hub, "room", "alice", null);
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);

            text(a.conn, "not json");
            text(a.conn, "42");
            text(a.conn, "null");
            text(a.conn, "[1,2]");
            text(a.conn, { op: "want", peers: ["bob"] });
            text(a.conn, { op: "unknown" });
            text(a.conn, { nothing: true });
            binary(a.conn, Buffer.from([1, 2, 3]));

            expect(a.sock.sent).toEqual([]);
            expect(a.sock.closed).toBeUndefined();
            expect(b.sock.frames).toEqual([]);
            expect(hub.stats.framesDroppedInvalid).toBe(1);
        });

        it("Ignores malformed, unknown and oversized text after hello without changing anything.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);

            text(a.conn, "not json");
            text(a.conn, "null");
            text(a.conn, "[]");
            text(a.conn, { op: "ping" });
            text(a.conn, `{"op":"want","peers":["x"],"pad":"${"x".repeat(RELAY_MAX_PAYLOAD_BYTES)}"}`);

            expect(a.sock.closed).toBeUndefined();
            binary(a.conn, Buffer.from([7]));
            expect(b.sock.frames).toEqual([frameOf("alice", Buffer.from([7]))]);
        });

        it("Reads a text message delivered as bytes (the `ws` library hands text over as a Buffer).", () => {
            const sock = new FakeSocket();
            const conn = hub.attach("room", "alice", sock)!;
            conn.message(Buffer.from(JSON.stringify({ op: "hello", v: 1, peer: "alice" })), false);
            expect(sock.texts).toEqual([{ op: "ready", v: 1, maxMessageBytes: RELAY_MAX_PAYLOAD_BYTES }]);
        });

        it("Ignores everything a socket sends once it was closed.", () => {
            const a = connect(hub, "room", "alice", null);
            a.conn.close();
            text(a.conn, { op: "hello", v: 1, peer: "alice" });
            binary(a.conn, Buffer.from([1]));
            expect(a.sock.sent).toEqual([]);
        });
    });

    describe("want and forwarding", () => {
        it("Forwards a binary message to every other socket that wants its sender, as [len][sender][payload].", () => {
            const a = connect(hub, "room", "alice", "alice~tab");
            const b = connect(hub, "room", "bob");
            const c = connect(hub, "room", "carol");
            const d = connect(hub, "room", "dave");
            want(b, ["alice~tab"]);
            want(c, ["alice~tab", "bob"]);
            want(d, ["bob"]);
            want(a, ["alice~tab", "bob"]);

            const payload = Buffer.from("opaque media", "utf8");
            binary(a.conn, payload);

            expect(b.sock.frames).toEqual([frameOf("alice~tab", payload)]);
            expect(c.sock.frames).toEqual([frameOf("alice~tab", payload)]);
            // Wanted nobody it got a frame from.
            expect(d.sock.frames).toEqual([]);
            // Never echoed to its sender, even though it lists its own peer id.
            expect(a.sock.frames).toEqual([]);
            expect(hub.stats.framesForwarded).toBe(2);
        });

        it("Stamps the sender from the hello and never trusts the payload, including one that looks like a header.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice", "bob"]);

            const forged = frameOf("bob", Buffer.from("x"));
            binary(a.conn, forged);

            expect(b.sock.frames).toEqual([frameOf("alice", forged)]);
        });

        it("Encodes a multi-byte sender's length in bytes.", () => {
            const peer = "alice~é€";
            const a = connect(hub, "room", "alice", peer);
            const b = connect(hub, "room", "bob");
            want(b, [peer]);
            binary(a.conn, Buffer.from([9]));
            const frame = b.sock.frames[0];
            expect(frame[0]).toBe(Buffer.byteLength(peer));
            expect(frame.subarray(1, 1 + frame[0]).toString("utf8")).toBe(peer);
            expect(frame.subarray(1 + frame[0])).toEqual(Buffer.from([9]));
        });

        it("Replaces the interest set on every want, and only forwards to the newest set.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            const c = connect(hub, "room", "carol");
            want(b, ["alice"]);
            binary(a.conn, Buffer.from([1]));
            want(b, ["carol"]);
            binary(a.conn, Buffer.from([2]));
            want(b, []);
            binary(c.conn, Buffer.from([3]));

            expect(b.sock.frames).toEqual([frameOf("alice", Buffer.from([1]))]);
        });

        it("Ignores invalid want entries, keeps at most 32 valid ones, and ignores a non-array peers.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            const many: unknown[] = ["a b", 7, null, "", "x".repeat(200), ...Array.from({ length: RELAY_MAX_WANT_PEERS }, (_, i) => `p${i}`), "alice"];
            text(b.conn, { op: "want", peers: many });
            binary(a.conn, Buffer.from([1]));
            // "alice" was the 33rd valid entry, so it was cut off.
            expect(b.sock.frames).toEqual([]);

            text(b.conn, { op: "want", peers: ["a b", "alice", "alice"] });
            binary(a.conn, Buffer.from([2]));
            expect(b.sock.frames).toEqual([frameOf("alice", Buffer.from([2]))]);

            text(b.conn, { op: "want", peers: "everyone" });
            text(b.conn, { op: "want" });
            // Neither of those changed the set, so alice is still wanted.
            binary(a.conn, Buffer.from([3]));
            expect(b.sock.frames).toHaveLength(2);
            expect(b.sock.frames[1]).toEqual(frameOf("alice", Buffer.from([3])));
        });

        it("Keeps rooms apart.", () => {
            const a = connect(hub, "room-1", "alice");
            const b = connect(hub, "room-2", "bob");
            want(b, ["alice"]);
            binary(a.conn, Buffer.from([1]));
            expect(b.sock.frames).toEqual([]);
        });

        it("Does not forward to a socket that has not said hello, even one that has already sent a want.", () => {
            const a = connect(hub, "room", "alice");
            const pending = connect(hub, "room", "bob", null);
            text(pending.conn, { op: "want", peers: ["alice"] });
            binary(a.conn, Buffer.from([1]));
            expect(pending.sock.frames).toEqual([]);
        });
    });

    describe("binary validation", () => {
        it("Drops empty and oversized payloads, and forwards one of exactly the maximum size.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);

            binary(a.conn, Buffer.alloc(0));
            binary(a.conn, Buffer.alloc(RELAY_MAX_PAYLOAD_BYTES + 1));
            expect(b.sock.frames).toEqual([]);
            expect(hub.stats.framesDroppedInvalid).toBe(2);

            binary(a.conn, Buffer.alloc(RELAY_MAX_PAYLOAD_BYTES, 5));
            expect(b.sock.frames).toHaveLength(1);
            expect(b.sock.frames[0].length).toBe(1 + "alice".length + RELAY_MAX_PAYLOAD_BYTES);
            expect(a.sock.closed).toBeUndefined();
        });

        it("Accepts a payload that is a plain Uint8Array view, honoring its offset and length.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);
            const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
            a.conn.message(backing.subarray(2, 5), true);
            expect(b.sock.frames).toEqual([frameOf("alice", Buffer.from([1, 2, 3]))]);
        });

        it("Treats a text payload flagged binary as its UTF-8 bytes.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);
            a.conn.message("hi", true);
            expect(b.sock.frames).toEqual([frameOf("alice", Buffer.from("hi"))]);
        });
    });

    describe("rate limiting", () => {
        const chunk = Buffer.alloc(RELAY_MAX_PAYLOAD_BYTES, 1);
        const burstFrames = RELAY_BURST_BYTES / RELAY_MAX_PAYLOAD_BYTES;

        it("Passes a full burst, drops silently beyond it, and passes again once the bucket has refilled.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);

            for (let i = 0; i < burstFrames; i++) {
                binary(a.conn, chunk);
            }
            expect(b.sock.frames).toHaveLength(burstFrames);
            binary(a.conn, chunk);
            expect(b.sock.frames).toHaveLength(burstFrames);
            expect(hub.stats.framesDroppedBudget).toBe(1);
            expect(a.sock.closed).toBeUndefined();

            // 512 KiB/s: half a second buys 16 more frames of 16 KiB.
            vi.advanceTimersByTime(500);
            for (let i = 0; i < 20; i++) {
                binary(a.conn, chunk);
            }
            expect(b.sock.frames).toHaveLength(burstFrames + 16);
        });

        it("Closes a socket kept over budget for more than 10 seconds with 1008 \"Too much data.\".", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);

            let elapsed = 0;
            while (!a.sock.closed && elapsed < RELAY_OVER_BUDGET_CLOSE_MS * 3) {
                // 160 KiB every 100 ms: 1.6 MiB/s against a 512 KiB/s budget.
                for (let i = 0; i < 10; i++) {
                    binary(a.conn, chunk);
                }
                vi.advanceTimersByTime(100);
                elapsed += 100;
            }

            expect(a.sock.closed).toEqual({ code: 1008, reason: "Too much data." });
            // The burst empties in about 0.7 s, and the first drop starts the 10 s clock.
            expect(elapsed).toBeGreaterThan(RELAY_OVER_BUDGET_CLOSE_MS);
            expect(elapsed).toBeLessThan(RELAY_OVER_BUDGET_CLOSE_MS + 2000);
            expect(hub.socketCount("room")).toBe(1);
            // Once closed, its remaining messages are ignored.
            const before = hub.stats.framesForwarded;
            binary(a.conn, chunk);
            expect(hub.stats.framesForwarded).toBe(before);
        });

        it("Does not close a socket that only goes over budget now and then, however long that goes on.", () => {
            const a = connect(hub, "room", "alice");
            for (let round = 0; round < 8; round++) {
                // Empty the bucket and send one more: a lone drop, then two quiet seconds to refill.
                for (let i = 0; i < burstFrames + 1; i++) {
                    binary(a.conn, chunk);
                }
                vi.advanceTimersByTime(2000);
            }
            expect(hub.stats.framesDroppedBudget).toBe(8);
            expect(a.sock.closed).toBeUndefined();
        });
    });

    describe("receiver backpressure", () => {
        it("Drops a frame a receiver's send() reports as dropped, counts it, logs it, and still serves the others.", () => {
            const debug = vi.fn();
            hub = new RelayHub({ logger: { debug } });
            const a = connect(hub, "room", "alice");
            const slow = connect(hub, "room", "bob");
            const fast = connect(hub, "room", "carol");
            want(slow, ["alice"]);
            want(fast, ["alice"]);
            slow.sock.sendResult = "dropped";

            binary(a.conn, Buffer.from([1]));

            expect(fast.sock.frames).toEqual([frameOf("alice", Buffer.from([1]))]);
            expect(hub.stats.framesDroppedBackpressure).toBe(1);
            expect(debug).toHaveBeenCalledTimes(1);
            expect(debug.mock.calls[0][0]).toContain("bob");
            expect(slow.sock.closed).toBeUndefined();

            // Later frames flow again once the receiver recovers.
            slow.sock.sendResult = "ok";
            binary(a.conn, Buffer.from([2]));
            expect(slow.sock.frames).toHaveLength(2);
        });

        it("Survives a receiver whose send() throws, with no logger configured.", () => {
            const a = connect(hub, "room", "alice");
            const broken = connect(hub, "room", "bob");
            const fine = connect(hub, "room", "carol");
            want(broken, ["alice"]);
            want(fine, ["alice"]);
            broken.sock.sendResult = "throw";

            expect(() => binary(a.conn, Buffer.from([1]))).not.toThrow();

            expect(fine.sock.frames).toHaveLength(1);
            expect(hub.stats.framesDroppedBackpressure).toBe(1);
            expect(hub.stats.framesForwarded).toBe(1);
        });

        it("Describes a non-Error rejection in the debug log too.", () => {
            const debug = vi.fn();
            hub = new RelayHub({ logger: { debug } });
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);
            b.sock.send = (_data, cb) => cb?.("nope" as any);
            binary(a.conn, Buffer.from([1]));
            expect(debug.mock.calls[0][0]).toContain("nope");
        });
    });

    describe("replacing a peer", () => {
        it("Closes the older socket with 1008 \"Replaced.\" and routes to the newer one.", () => {
            const first = connect(hub, "room", "alice", "alice~tab");
            const sender = connect(hub, "room", "bob");
            const second = connect(hub, "room", "alice", "alice~tab");
            want(first, ["bob"]);
            want(second, ["bob"]);

            expect(first.sock.closed).toEqual({ code: 1008, reason: "Replaced." });
            expect(second.sock.closed).toBeUndefined();
            expect(hub.socketCount("room")).toBe(2);

            binary(sender.conn, Buffer.from([1]));
            expect(first.sock.frames).toEqual([]);
            expect(second.sock.frames).toHaveLength(1);
        });

        it("Is not undone by the replaced socket's own close event arriving afterwards.", () => {
            const first = connect(hub, "room", "alice");
            const second = connect(hub, "room", "alice");
            const sender = connect(hub, "room", "bob");
            want(second, ["bob"]);

            first.conn.close();

            expect(hub.socketCount("room")).toBe(2);
            binary(sender.conn, Buffer.from([1]));
            expect(second.sock.frames).toHaveLength(1);
        });

        it("Only ever replaces within the same room.", () => {
            const one = connect(hub, "room-1", "alice");
            const two = connect(hub, "room-2", "alice");
            expect(one.sock.closed).toBeUndefined();
            expect(two.sock.closed).toBeUndefined();
        });
    });

    describe("limits", () => {
        it("Refuses a socket over the per-room maximum with 1008 \"Room full.\", counting sockets still awaiting hello.", () => {
            for (let i = 0; i < RELAY_MAX_SOCKETS_PER_ROOM; i++) {
                // Four uids' worth each, so only the room limit can apply.
                const sock = new FakeSocket();
                const conn = hub.attach("room", `user-${Math.floor(i / RELAY_MAX_SOCKETS_PER_UID)}`, sock);
                expect(conn).toBeDefined();
                if (i % 2 === 0) {
                    text(conn!, { op: "hello", v: 1, peer: `user-${Math.floor(i / RELAY_MAX_SOCKETS_PER_UID)}~${i}` });
                }
            }
            expect(hub.socketCount("room")).toBe(RELAY_MAX_SOCKETS_PER_ROOM);

            const refused = new FakeSocket();
            expect(hub.attach("room", "someone-else", refused)).toBeUndefined();
            expect(refused.closed).toEqual({ code: 1008, reason: "Room full." });
            expect(hub.socketCount("room")).toBe(RELAY_MAX_SOCKETS_PER_ROOM);
            // Another room is unaffected.
            expect(hub.attach("other", "someone-else", new FakeSocket())).toBeDefined();
        });

        it("Refuses a fifth socket of one uid with 1008 \"Too many connections.\", but not another uid's.", () => {
            for (let i = 0; i < RELAY_MAX_SOCKETS_PER_UID; i++) {
                connect(hub, "room", "alice", `alice~${i}`);
            }
            const refused = new FakeSocket();
            expect(hub.attach("room", "alice", refused)).toBeUndefined();
            expect(refused.closed).toEqual({ code: 1008, reason: "Too many connections." });

            expect(hub.attach("room", "bob", new FakeSocket())).toBeDefined();
            // ...and the same uid may hold sockets in another room.
            expect(hub.attach("elsewhere", "alice", new FakeSocket())).toBeDefined();
        });

        it("Frees a slot when a socket closes.", () => {
            const held: Peer[] = [];
            for (let i = 0; i < RELAY_MAX_SOCKETS_PER_UID; i++) {
                held.push(connect(hub, "room", "alice", `alice~${i}`));
            }
            held[0].conn.close();
            expect(hub.attach("room", "alice", new FakeSocket())).toBeDefined();
        });
    });

    describe("cleanup", () => {
        it("Deletes an emptied room and its bus subscription, and forgets a closed socket's timer.", () => {
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob", null);
            expect(hub.roomCount).toBe(1);

            a.conn.close();
            expect(hub.socketCount("room")).toBe(1);
            b.conn.close();
            b.conn.close();
            expect(hub.roomCount).toBe(0);
            expect(hub.socketCount("room")).toBe(0);

            // The pending socket's hello timer died with it.
            vi.advanceTimersByTime(RELAY_HELLO_TIMEOUT_MS * 2);
            expect(b.sock.closed).toBeUndefined();
            expect(vi.getTimerCount()).toBe(0);
        });

        it("Releases a socket the hub itself closed, and tolerates its later close event.", () => {
            const bad = new FakeSocket();
            const conn = hub.attach("room", "alice", bad)!;
            text(conn, { op: "hello", v: 1, peer: "mallory" });
            expect(hub.roomCount).toBe(0);
            expect(() => conn.close()).not.toThrow();
        });

        it("Starts a fresh room after the old one was deleted.", () => {
            connect(hub, "room", "alice").conn.close();
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);
            binary(a.conn, Buffer.from([1]));
            expect(b.sock.frames).toHaveLength(1);
        });
    });

    describe("the bus seam", () => {
        class RecordingBus implements RelayBus {
            public listeners = new Map<string, RelayBusListener>();
            public unsubscribed: string[] = [];
            public published: { room: string; sender: string; frame: Buffer }[] = [];

            public subscribe(roomId: string, listener: RelayBusListener): () => void {
                this.listeners.set(roomId, listener);
                return () => {
                    this.unsubscribed.push(roomId);
                    this.listeners.delete(roomId);
                };
            }

            public publish(room: string, sender: string, frame: Buffer): void {
                this.published.push({ room, sender, frame });
            }
        }

        it("Publishes every accepted frame to the bus instead of delivering it directly.", () => {
            const bus = new RecordingBus();
            hub = new RelayHub({ bus });
            const a = connect(hub, "room", "alice");
            const b = connect(hub, "room", "bob");
            want(b, ["alice"]);

            binary(a.conn, Buffer.from([1, 2]));

            expect(bus.published).toEqual([{ room: "room", sender: "alice", frame: frameOf("alice", Buffer.from([1, 2])) }]);
            // The recording bus never calls back, so nothing was delivered.
            expect(b.sock.frames).toEqual([]);
        });

        it("Delivers a frame arriving over the bus from another process, and unsubscribes when the room empties.", () => {
            const bus = new RecordingBus();
            hub = new RelayHub({ bus });
            const b = connect(hub, "room", "bob");
            const c = connect(hub, "room", "carol");
            want(b, ["remote-peer"]);

            const frame = frameOf("remote-peer", Buffer.from([5]));
            bus.listeners.get("room")!("remote-peer", frame);

            expect(b.sock.frames).toEqual([frame]);
            expect(c.sock.frames).toEqual([]);

            const listener = bus.listeners.get("room")!;
            b.conn.close();
            expect(bus.unsubscribed).toEqual([]);
            c.conn.close();
            expect(bus.unsubscribed).toEqual(["room"]);
            expect(bus.listeners.size).toBe(0);

            // A frame that was already in flight over an asynchronous bus is ignored, not delivered to a new room.
            expect(() => listener("remote-peer", frame)).not.toThrow();
            expect(b.sock.frames).toEqual([frame]);
        });

        it("Subscribes once per room, however many sockets join it.", () => {
            const bus = new RecordingBus();
            const subscribe = vi.spyOn(bus, "subscribe");
            hub = new RelayHub({ bus });
            connect(hub, "room", "alice");
            connect(hub, "room", "bob");
            connect(hub, "other", "carol");
            expect(subscribe).toHaveBeenCalledTimes(2);
        });
    });

    describe("InProcessRelayBus", () => {
        it("Delivers to every subscriber of the room, only that room's, and stops after unsubscribing.", () => {
            const bus = new InProcessRelayBus();
            const one = vi.fn();
            const two = vi.fn();
            const other = vi.fn();
            const offOne = bus.subscribe("room", one);
            bus.subscribe("room", two);
            bus.subscribe("other", other);
            const frame = Buffer.from([1]);

            bus.publish("room", "alice", frame);
            expect(one).toHaveBeenCalledWith("alice", frame);
            expect(two).toHaveBeenCalledWith("alice", frame);
            expect(other).not.toHaveBeenCalled();

            offOne();
            offOne();
            bus.publish("room", "alice", frame);
            expect(one).toHaveBeenCalledTimes(1);
            expect(two).toHaveBeenCalledTimes(2);
        });

        it("Publishes to a room nobody subscribed to without error, and lets a stale unsubscribe leave a newer room alone.", () => {
            const bus = new InProcessRelayBus();
            expect(() => bus.publish("nobody", "alice", Buffer.from([1]))).not.toThrow();

            const first = vi.fn();
            const off = bus.subscribe("room", first);
            off();
            const second = vi.fn();
            bus.subscribe("room", second);
            // The first subscription's own set is gone; calling its unsubscribe again must not disturb the new one.
            off();
            bus.publish("room", "alice", Buffer.from([1]));
            expect(second).toHaveBeenCalledTimes(1);
            expect(first).not.toHaveBeenCalled();
        });
    });
});

describe("isValidRelayPeer", () => {
    it("Accepts printable, non-whitespace strings of 1 to 128 characters.", () => {
        expect(isValidRelayPeer("a")).toBe(true);
        expect(isValidRelayPeer("guest:AbC-_09~tab")).toBe(true);
        expect(isValidRelayPeer("é中文")).toBe(true);
        expect(isValidRelayPeer("x".repeat(128))).toBe(true);
    });

    it("Rejects everything else.", () => {
        for (const bad of ["", "x".repeat(129), "a b", "a\tb", "a\nb", "a\u0000b", "a\u007fb", "a​b", "a b", "a\ud800b", "€".repeat(86), 1, null, undefined, {}]) {
            expect(isValidRelayPeer(bad)).toBe(false);
        }
    });
});

describe("parseRelayEnabled", () => {
    it("Enables the relay for true, 1 and any other value, including an unset one.", () => {
        for (const value of [true, 1, "true", "TRUE", " true ", "1", "", "yes", undefined, null, {}]) {
            expect(parseRelayEnabled(value)).toBe(true);
        }
    });

    it("Disables it for false, 0, \"false\" and \"0\".", () => {
        for (const value of [false, 0, "false", "False", " FALSE ", "0"]) {
            expect(parseRelayEnabled(value)).toBe(false);
        }
    });
});

describe("RelayHub with a larger message limit", () => {
    const hub = new RelayHub({ maxPayloadBytes: RELAY_LARGE_PAYLOAD_BYTES });

    it("has a larger limit than the framework default, and a send buffer bigger than the framework default but still close to real-time", () => {
        expect(RELAY_LARGE_PAYLOAD_BYTES).toBeGreaterThan(RELAY_MAX_PAYLOAD_BYTES);
        // Bigger than the framework's own 64 KiB default (headroom for one key frame), but nowhere near the
        // several-second backlog a careless, much larger budget would let build up for a briefly slow receiver.
        expect(RELAY_WS_MAX_BACKPRESSURE_BYTES).toBeGreaterThan(64 * 1024);
        expect(RELAY_WS_MAX_BACKPRESSURE_BYTES).toBeLessThan(256 * 1024);
    });

    it("tells the client the limit in ready", () => {
        const a = connect(hub, "room-large", "alice");
        expect(a.sock.texts).toEqual([{ op: "ready", v: 1, maxMessageBytes: RELAY_LARGE_PAYLOAD_BYTES }]);
    });

    it("relays a payload up to the larger limit, and drops one over it", () => {
        const a = connect(hub, "room-large-2", "alice");
        const b = connect(hub, "room-large-2", "bob");
        want(b, ["alice"]);

        binary(a.conn, Buffer.alloc(RELAY_LARGE_PAYLOAD_BYTES + 1));
        expect(b.sock.frames).toEqual([]);

        // Well over the default limit, so a key frame now travels as one message.
        binary(a.conn, Buffer.alloc(RELAY_LARGE_PAYLOAD_BYTES, 7));
        expect(b.sock.frames).toHaveLength(1);
        expect(b.sock.frames[0].length).toBe(1 + "alice".length + RELAY_LARGE_PAYLOAD_BYTES);
    });

    it("bounds a text message by the same limit, so an oversized want is ignored", () => {
        const a = connect(hub, "room-large-3", "alice");
        const b = connect(hub, "room-large-3", "bob");
        text(b.conn, '{"op":"want","peers":["alice"],"pad":"' + "x".repeat(RELAY_LARGE_PAYLOAD_BYTES) + '"}');
        binary(a.conn, Buffer.alloc(10, 1));
        expect(b.sock.frames).toEqual([]);

        want(b, ["alice"]);
        binary(a.conn, Buffer.alloc(10, 1));
        expect(b.sock.frames).toHaveLength(1);
    });
});
