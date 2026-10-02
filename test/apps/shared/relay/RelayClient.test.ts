///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MAX_BUFFERED_BYTES,
    MAX_NEGOTIATED_MESSAGE_BYTES,
    MIN_NEGOTIATED_MESSAGE_BYTES,
    MAX_MESSAGE_BYTES,
    MAX_WANTED_PEERS,
    RELAY_BACKOFF_BASE_MS,
    RELAY_BACKOFF_MAX_MS,
    RELAY_HANDSHAKE_TIMEOUT_MS,
    RELAY_PING_INTERVAL_MS,
    RelayClient,
} from "../../../../apps/shared/relay/RelayClient.js";
import { FakeSocket, relayed, last } from "./relayFakes.js";

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

function setup(random = 0.5) {
    const sockets: FakeSocket[] = [];
    const media: [string, number[]][] = [];
    let throwOnCreate = false;
    const client = new RelayClient({
        url: "wss://example.com/api/mail/video-meetings/relay/m1",
        peerId: "me~abc",
        createSocket: (url) => {
            if (throwOnCreate) throw new Error("refused");
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket;
        },
        random: () => random,
        onMedia: (peer, payload) => media.push([peer, Array.from(payload)]),
    });
    return {
        client,
        sockets,
        media,
        throwOnCreate: (value: boolean) => {
            throwOnCreate = value;
        },
    };
}

/** Starts a client and takes its first socket all the way to `ready`. */
function readyClient() {
    const s = setup();
    s.client.start();
    const socket = s.sockets[0];
    socket.open();
    socket.ready();
    return { ...s, socket };
}

describe("RelayClient handshake", () => {
    it("connects to the URL, sends hello on open, and is ready only after the server says so", () => {
        const { client, sockets } = setup();
        expect(client.ready).toBe(false);
        client.start();
        expect(sockets).toHaveLength(1);
        expect(sockets[0].url).toBe("wss://example.com/api/mail/video-meetings/relay/m1");
        expect(sockets[0].binaryType).toBe("arraybuffer");
        // Not open yet: nothing may be sent.
        expect(sockets[0].sent).toEqual([]);
        sockets[0].open();
        expect(sockets[0].texts()).toEqual([{ op: "hello", v: 1, peer: "me~abc" }]);
        expect(client.ready).toBe(false);
        sockets[0].ready();
        expect(client.ready).toBe(true);
        // The (empty) want is sent right after ready.
        expect(sockets[0].texts()[1]).toEqual({ op: "want", peers: [] });
    });

    it("start() is idempotent and does nothing once closed", () => {
        const { client, sockets } = setup();
        client.start();
        client.start();
        expect(sockets).toHaveLength(1);
        const other = setup();
        other.client.close();
        other.client.start();
        expect(other.sockets).toHaveLength(0);
    });

    it("ignores text that is not a ready message, and a repeated ready", () => {
        const { client, sockets } = setup();
        client.start();
        const socket = sockets[0];
        socket.open();
        socket.message("not json");
        socket.message("null");
        socket.message('"ready"');
        socket.message(JSON.stringify({ op: "other" }));
        expect(client.ready).toBe(false);
        socket.ready();
        socket.ready();
        expect(socket.texts().filter((m) => m.op === "want")).toHaveLength(1);
    });

    it("ignores media before ready", () => {
        const { client, sockets, media } = setup();
        client.start();
        sockets[0].open();
        sockets[0].message(relayed("peer", Uint8Array.of(1)));
        expect(media).toEqual([]);
        expect(client.ready).toBe(false);
    });

    it("abandons and retries a socket that never becomes ready", () => {
        const { client, sockets } = setup();
        client.start();
        sockets[0].open();
        vi.advanceTimersByTime(RELAY_HANDSHAKE_TIMEOUT_MS);
        expect(sockets[0].closeCalls).toHaveLength(1);
        // The abandoned socket's own late close event is ignored (its handlers are detached).
        expect(sockets[0].onclose).toBeNull();
        vi.advanceTimersByTime(RELAY_BACKOFF_BASE_MS);
        expect(sockets).toHaveLength(2);
        expect(client.ready).toBe(false);
    });

    it("does not time out once ready", () => {
        const { sockets } = readyClient();
        vi.advanceTimersByTime(RELAY_HANDSHAKE_TIMEOUT_MS * 2);
        expect(sockets).toHaveLength(1);
    });
});

describe("RelayClient message limit", () => {
    function readyWith(extra?: Record<string, unknown>) {
        const s = setup();
        s.client.start();
        const socket = s.sockets[0];
        socket.open();
        socket.ready(extra);
        return { ...s, socket };
    }

    it("defaults to 16384 before ready and when ready does not say (an older server)", () => {
        const s = setup();
        expect(s.client.maxMessageBytes).toBe(MAX_MESSAGE_BYTES);
        expect(MAX_MESSAGE_BYTES).toBe(16_384);
        s.client.start();
        s.sockets[0].open();
        expect(s.client.maxMessageBytes).toBe(16_384);
        s.sockets[0].ready();
        expect(s.client.maxMessageBytes).toBe(16_384);
    });

    it("uses the size the server announces, for the send check as well", () => {
        const { client, socket } = readyWith({ maxMessageBytes: 65_536 });
        expect(client.maxMessageBytes).toBe(65_536);
        expect(client.sendMedia(new Uint8Array(65_536))).toBe(true);
        expect(client.sendMedia(new Uint8Array(65_537))).toBe(false);
        expect(socket.binaries()).toHaveLength(1);
    });

    it("keeps refusing over 16384 bytes without an announcement", () => {
        const { client } = readyWith();
        expect(client.sendMedia(new Uint8Array(16_385))).toBe(false);
        expect(client.sendMedia(new Uint8Array(16_384))).toBe(true);
    });

    it("accepts a limit below the default and honours it", () => {
        const { client } = readyWith({ maxMessageBytes: MIN_NEGOTIATED_MESSAGE_BYTES });
        expect(client.maxMessageBytes).toBe(1024);
        expect(client.sendMedia(new Uint8Array(1025))).toBe(false);
        expect(client.sendMedia(new Uint8Array(1024))).toBe(true);
    });

    it("clamps an enormous limit to 1 MiB", () => {
        expect(readyWith({ maxMessageBytes: 2 ** 40 }).client.maxMessageBytes).toBe(MAX_NEGOTIATED_MESSAGE_BYTES);
        expect(MAX_NEGOTIATED_MESSAGE_BYTES).toBe(1024 * 1024);
        expect(readyWith({ maxMessageBytes: MAX_NEGOTIATED_MESSAGE_BYTES }).client.maxMessageBytes).toBe(1024 * 1024);
    });

    it.each([1023, 0, -5, 65_536.5, Number.NaN, "65536", null, true, {}, [65_536]])("ignores an invalid maxMessageBytes (%s)", (value) => {
        expect(readyWith({ maxMessageBytes: value }).client.maxMessageBytes).toBe(16_384);
    });

    it("ignores an infinite limit", () => {
        // JSON cannot carry Infinity (it serialises as null), but a fake or future transport might hand one over.
        const s = setup();
        s.client.start();
        s.sockets[0].open();
        s.sockets[0].message(JSON.stringify({ op: "ready", maxMessageBytes: Infinity }));
        expect(s.client.ready).toBe(true);
        expect(s.client.maxMessageBytes).toBe(16_384);
    });

    it("resets to the default when the socket closes, and learns the next server afresh", () => {
        const { client, sockets, socket } = readyWith({ maxMessageBytes: 65_536 });
        socket.triggerClose();
        expect(client.maxMessageBytes).toBe(16_384);
        vi.advanceTimersByTime(1000);
        sockets[1].open();
        expect(client.maxMessageBytes).toBe(16_384);
        sockets[1].ready({ maxMessageBytes: 32_768 });
        expect(client.maxMessageBytes).toBe(32_768);
        sockets[1].triggerClose();
        vi.advanceTimersByTime(2000);
        // A reconnect to an older server (no field) is back to 16384.
        sockets[2].open();
        sockets[2].ready();
        expect(client.maxMessageBytes).toBe(16_384);
    });

    it("resets when a handshake times out and when closed", () => {
        const a = readyWith({ maxMessageBytes: 65_536 });
        a.client.close();
        expect(a.client.maxMessageBytes).toBe(16_384);
        const b = setup();
        b.client.start();
        b.sockets[0].open();
        vi.advanceTimersByTime(RELAY_HANDSHAKE_TIMEOUT_MS);
        expect(b.client.maxMessageBytes).toBe(16_384);
    });
});

describe("RelayClient want", () => {
    it("sends the wanted set when it changes while ready, replacing the previous one", () => {
        const { client, socket } = readyClient();
        client.setWanted(new Set(["a", "b"]));
        client.setWanted(["b"]);
        const wants = socket.texts().filter((m) => m.op === "want");
        expect(wants.slice(1)).toEqual([
            { op: "want", peers: ["a", "b"] },
            { op: "want", peers: ["b"] },
        ]);
    });

    it("holds the wanted set until ready and sends it then", () => {
        const { client, sockets } = setup();
        client.setWanted(["a"]);
        client.start();
        sockets[0].open();
        expect(sockets[0].texts().some((m) => m.op === "want")).toBe(false);
        sockets[0].ready();
        expect(sockets[0].texts()[1]).toEqual({ op: "want", peers: ["a"] });
    });

    it("caps the wanted set at the server's limit", () => {
        const { client, socket } = readyClient();
        client.setWanted(Array.from({ length: 40 }, (_, i) => `p${i}`));
        const lastWant = last(socket.texts()) as { peers: string[] };
        expect(lastWant.peers).toHaveLength(MAX_WANTED_PEERS);
    });
});

describe("RelayClient media", () => {
    it("sends binary media once ready", () => {
        const { client, socket } = readyClient();
        expect(client.sendMedia(Uint8Array.of(1, 2, 3))).toBe(true);
        expect(socket.binaries()).toEqual([Uint8Array.of(1, 2, 3)]);
    });

    it("drops media when there is no socket, it is not ready, it is not open, it is backed up or it is too large", () => {
        const fresh = setup();
        expect(fresh.client.sendMedia(Uint8Array.of(1))).toBe(false);
        fresh.client.start();
        fresh.sockets[0].open();
        expect(fresh.client.sendMedia(Uint8Array.of(1))).toBe(false);

        const { client, socket } = readyClient();
        socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
        expect(client.sendMedia(Uint8Array.of(1))).toBe(false);
        socket.bufferedAmount = MAX_BUFFERED_BYTES;
        expect(client.sendMedia(Uint8Array.of(1))).toBe(true);
        expect(client.sendMedia(new Uint8Array(MAX_MESSAGE_BYTES + 1))).toBe(false);
        expect(client.sendMedia(new Uint8Array(MAX_MESSAGE_BYTES))).toBe(true);
        socket.readyState = 2;
        expect(client.sendMedia(Uint8Array.of(1))).toBe(false);
    });

    it("reports a send that throws as dropped", () => {
        const { client, socket } = readyClient();
        socket.sendThrows = true;
        expect(client.sendMedia(Uint8Array.of(1))).toBe(false);
    });

    it("does not send text on a socket that is no longer open", () => {
        const { client, socket } = readyClient();
        const before = socket.sent.length;
        socket.readyState = 2;
        client.setWanted(["a"]);
        expect(socket.sent).toHaveLength(before);
    });

    it("survives a text send that throws", () => {
        const { client, socket } = readyClient();
        socket.sendThrows = true;
        expect(() => client.setWanted(["a"])).not.toThrow();
    });

    it("parses relayed media into the sender's id and the original payload", () => {
        const { media, socket } = readyClient();
        socket.message(relayed("peer-1~x", Uint8Array.of(9, 8, 7)));
        socket.message(relayed("é~ü", Uint8Array.of(1)));
        socket.message(relayed("p", new Uint8Array(0)));
        expect(media).toEqual([
            ["peer-1~x", [9, 8, 7]],
            ["é~ü", [1]],
            ["p", []],
        ]);
    });

    it("accepts a typed array as well as an ArrayBuffer", () => {
        const { media, socket } = readyClient();
        const whole = new Uint8Array(relayed("p", Uint8Array.of(5)));
        // A view into a larger buffer must respect its offset.
        const padded = new Uint8Array(whole.length + 3);
        padded.set(whole, 3);
        socket.message(padded.subarray(3));
        expect(media).toEqual([["p", [5]]]);
    });

    it("ignores malformed binary messages and non-binary data", () => {
        const { media, socket } = readyClient();
        socket.message(new ArrayBuffer(0));
        socket.message(Uint8Array.of(0, 1, 2).buffer);
        socket.message(Uint8Array.of(5, 1, 2).buffer);
        socket.message({ not: "binary" });
        socket.message(null);
        expect(media).toEqual([]);
    });
});

describe("RelayClient reconnection", () => {
    it("reconnects with a jittered, growing backoff capped at the maximum, and re-sends hello and want", () => {
        const { client, sockets } = setup(0);
        client.setWanted(["a"]);
        client.start();
        // random() = 0 gives half the ceiling: 500ms, 1s, 2s, 4s, 7.5s (15s / 2) and stays there.
        const delays = [500, 1000, 2000, 4000, 7500, 7500];
        delays.forEach((delay, index) => {
            const socket = sockets[index];
            socket.open();
            socket.triggerClose();
            expect(sockets).toHaveLength(index + 1);
            vi.advanceTimersByTime(delay - 1);
            expect(sockets).toHaveLength(index + 1);
            vi.advanceTimersByTime(1);
            expect(sockets).toHaveLength(index + 2);
        });
        expect(RELAY_BACKOFF_MAX_MS).toBe(15_000);

        const latest = last(sockets) as FakeSocket;
        latest.open();
        latest.ready();
        expect(latest.texts()).toEqual([
            { op: "hello", v: 1, peer: "me~abc" },
            { op: "want", peers: ["a"] },
        ]);
        expect(client.ready).toBe(true);
    });

    it("uses the full ceiling when the jitter is at its maximum", () => {
        const { client, sockets } = setup(1);
        client.start();
        sockets[0].triggerClose();
        vi.advanceTimersByTime(RELAY_BACKOFF_BASE_MS - 1);
        expect(sockets).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(sockets).toHaveLength(2);
    });

    it("resets the backoff once a connection becomes ready", () => {
        const { client, sockets } = setup(1);
        client.start();
        sockets[0].triggerClose();
        vi.advanceTimersByTime(1000);
        sockets[1].triggerClose();
        vi.advanceTimersByTime(2000);
        sockets[2].open();
        sockets[2].ready();
        sockets[2].triggerClose();
        // Back to the first step, not the third.
        vi.advanceTimersByTime(1000);
        expect(sockets).toHaveLength(4);
    });

    it("stops being ready when the socket closes", () => {
        const { client, socket } = readyClient();
        socket.triggerClose();
        expect(client.ready).toBe(false);
        expect(client.sendMedia(Uint8Array.of(1))).toBe(false);
    });

    it("retries when the socket cannot even be created", () => {
        const s = setup(0);
        s.throwOnCreate(true);
        s.client.start();
        expect(s.sockets).toHaveLength(0);
        s.throwOnCreate(false);
        vi.advanceTimersByTime(500);
        expect(s.sockets).toHaveLength(1);
    });

    it("ignores events from a socket it has already replaced", () => {
        const { client, sockets, media } = setup(0);
        client.start();
        const old = sockets[0];
        const oldOnMessage = old.onmessage;
        const oldOnClose = old.onclose;
        old.triggerClose();
        vi.advanceTimersByTime(500);
        expect(sockets).toHaveLength(2);
        sockets[1].open();
        sockets[1].ready();
        oldOnMessage?.({ data: relayed("p", Uint8Array.of(1)) });
        oldOnClose?.({});
        expect(media).toEqual([]);
        expect(client.ready).toBe(true);
    });

    it("tolerates close() throwing while detaching a dead socket", () => {
        const { client, sockets } = setup(0);
        client.start();
        sockets[0].closeThrows = true;
        expect(() => sockets[0].triggerClose()).not.toThrow();
        vi.advanceTimersByTime(500);
        expect(sockets).toHaveLength(2);
    });

    it("swallows socket errors", () => {
        const { sockets, client } = setup();
        client.start();
        expect(() => sockets[0].onerror?.({})).not.toThrow();
    });
});

describe("RelayClient.close", () => {
    it("closes the socket, stops reconnecting for good and is idempotent", () => {
        const { client, sockets, socket } = { ...readyClient() };
        client.close();
        expect(socket.closeCalls).toEqual([[1000, "closing"]]);
        expect(socket.onmessage).toBeNull();
        expect(client.ready).toBe(false);
        expect(client.sendMedia(Uint8Array.of(1))).toBe(false);
        client.close();
        vi.advanceTimersByTime(60_000);
        expect(sockets).toHaveLength(1);
        expect(socket.closeCalls).toHaveLength(1);
    });

    it("cancels a pending reconnect and a pending handshake timer", () => {
        const a = setup();
        a.client.start();
        a.sockets[0].triggerClose();
        a.client.close();
        vi.advanceTimersByTime(60_000);
        expect(a.sockets).toHaveLength(1);

        const b = setup();
        b.client.start();
        b.client.close();
        vi.advanceTimersByTime(RELAY_HANDSHAKE_TIMEOUT_MS * 2);
        expect(b.sockets).toHaveLength(1);
        expect(b.sockets[0].closeCalls).toHaveLength(1);
    });

    it("is safe before start and when closing the socket throws", () => {
        const never = setup();
        expect(() => never.client.close()).not.toThrow();
        const { client, socket } = readyClient();
        socket.closeThrows = true;
        expect(() => client.close()).not.toThrow();
    });
});

describe("RelayClient ping", () => {
    const pings = (socket: FakeSocket) => socket.texts().filter((m) => m.op === "ping");
    const pong = (socket: FakeSocket, t: unknown) => socket.message(JSON.stringify({ op: "pong", t }));

    it("pings every RELAY_PING_INTERVAL_MS once ready, stamped with the clock, and times the pong", () => {
        const { client, socket } = readyClient();
        expect(pings(socket)).toEqual([]);
        expect(client.roundTripMs).toBeUndefined();
        vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
        const [ping] = pings(socket);
        expect(ping).toEqual({ op: "ping", t: Date.now() });
        vi.advanceTimersByTime(42);
        pong(socket, ping.t);
        expect(client.roundTripMs).toBe(42);
        vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
        expect(pings(socket)).toHaveLength(2);
    });

    it("sends no ping before ready", () => {
        const { client, sockets } = setup();
        client.start();
        sockets[0].open();
        vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS * 3);
        expect(pings(sockets[0])).toEqual([]);
    });

    it("uses the clock it was given", () => {
        let now = 500;
        const sockets: FakeSocket[] = [];
        const client = new RelayClient({
            url: "wss://example.com/relay",
            peerId: "me",
            createSocket: (url) => {
                const socket = new FakeSocket(url);
                sockets.push(socket);
                return socket;
            },
            random: () => 0.5,
            now: () => now,
            onMedia: () => undefined,
        });
        client.start();
        sockets[0].open();
        sockets[0].ready();
        vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
        expect(pings(sockets[0])).toEqual([{ op: "ping", t: 500 }]);
        now = 517;
        pong(sockets[0], 500);
        expect(client.roundTripMs).toBe(17);
        client.close();
    });

    it("ignores a pong before ready, without a number t, or from the future", () => {
        const { client, sockets } = setup();
        client.start();
        sockets[0].open();
        pong(sockets[0], Date.now() - 10);
        expect(client.roundTripMs).toBeUndefined();
        sockets[0].ready();
        pong(sockets[0], "10");
        pong(sockets[0], Date.now() + 1000);
        expect(client.roundTripMs).toBeUndefined();
    });

    it("forgets the round trip and stops pinging when the socket closes, and starts afresh on the next one", () => {
        const { client, sockets, socket } = readyClient();
        pong(socket, Date.now());
        expect(client.roundTripMs).toBe(0);
        socket.triggerClose();
        expect(client.roundTripMs).toBeUndefined();
        vi.advanceTimersByTime(RELAY_BACKOFF_BASE_MS);
        // The old socket pings no more, even while the new one is still handshaking.
        expect(pings(socket)).toEqual([]);
        sockets[1].open();
        sockets[1].ready();
        vi.advanceTimersByTime(RELAY_PING_INTERVAL_MS);
        expect(pings(sockets[1])).toHaveLength(1);
    });

    it("stops pinging on close()", () => {
        const { client, socket } = readyClient();
        pong(socket, Date.now());
        client.close();
        expect(client.roundTripMs).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });
});
