///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    SIGNALING_BACKOFF_MAX_MS,
    SIGNALING_DEFAULT_MAX_MESSAGE_BYTES,
    SIGNALING_KEEPALIVE_MS,
    SIGNALING_MAX_QUEUED,
    SIGNALING_PROTOCOL_VERSION,
    SignalingClient,
    type SignalingClientOptions,
    signalingUrl,
} from "../../../../apps/shared/signaling/SignalingClient.js";
import type { SignalMessage } from "../../../../apps/shared/webrtc/types.js";
import { type FakeSignalingSocket, fakeSignalingSocket } from "../../testUtils.js";

const api = vi.hoisted(() => ({ origin: "" }));
vi.mock("@rapidmx/web-client/lib/util/api.js", () => ({ apiOrigin: () => api.origin }));

const URL = "wss://mail.example.com/api/mail/video-meetings/signal/m1";

function fakeDocument(protocol = "https:"): { cookie: string; location: { protocol: string } } {
    return { cookie: "", location: { protocol } };
}

function signal(kind: SignalMessage["kind"] = "hello", from = "me~1"): SignalMessage {
    return { type: "video-meeting-signal", kind, from };
}

/** A client over a list of fake sockets, handed out one per `createSocket()` call. */
function setup(options: Partial<SignalingClientOptions> = {}) {
    const sockets: FakeSignalingSocket[] = [];
    const createSocket = vi.fn((_url: string) => {
        const socket = fakeSignalingSocket();
        sockets.push(socket);
        return socket;
    });
    const doc = fakeDocument();
    const onClosed = vi.fn();
    const client = new SignalingClient({
        meetingUid: "m1",
        peerId: "me~1",
        token: "guest-token",
        url: URL,
        createSocket,
        documentRef: doc,
        onClosed,
        random: () => 0,
        ...options,
    });
    return { client, sockets, createSocket, doc, onClosed };
}

/** Takes `socket` through open, hello and ready. */
function ready(socket: FakeSignalingSocket, maxMessageBytes: unknown = 65_536): void {
    socket.open();
    socket.message({ op: "ready", v: SIGNALING_PROTOCOL_VERSION, maxMessageBytes });
}

function frames(socket: FakeSignalingSocket): unknown[] {
    return socket.sent.map((text) => JSON.parse(text));
}

beforeEach(() => {
    api.origin = "";
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("signalingUrl", () => {
    it("is undefined without any origin (not a browser)", () => {
        expect(signalingUrl("m1")).toBeUndefined();
    });

    it("uses the page's own origin, with http becoming ws", () => {
        vi.stubGlobal("window", { location: { origin: "https://mail.example.com" } });
        expect(signalingUrl("m1")).toBe(URL);
        vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
        expect(signalingUrl("m1")).toBe("ws://localhost:3000/api/mail/video-meetings/signal/m1");
    });

    it("prefers the configured API origin and encodes the meeting uid", () => {
        api.origin = "https://api.example.com";
        vi.stubGlobal("window", { location: { origin: "https://other.example.com" } });
        expect(signalingUrl("a b/c")).toBe("wss://api.example.com/api/mail/video-meetings/signal/a%20b%2Fc");
    });

    it("is undefined when the page's origin is empty", () => {
        vi.stubGlobal("window", { location: { origin: "" } });
        expect(signalingUrl("m1")).toBeUndefined();
    });
});

describe("SignalingClient.connect", () => {
    it("says hello once open and resolves on ready, with the server's maxMessageBytes", async () => {
        const { client, sockets, createSocket } = setup();
        expect(client.maxMessageBytes).toBe(SIGNALING_DEFAULT_MAX_MESSAGE_BYTES);
        const connected = client.connect();
        expect(createSocket).toHaveBeenCalledWith(URL);
        sockets[0].open();
        expect(frames(sockets[0])).toEqual([{ op: "hello", v: SIGNALING_PROTOCOL_VERSION, peer: "me~1" }]);
        sockets[0].message({ op: "ready", v: 1, maxMessageBytes: 65_536 });
        await expect(connected).resolves.toBeUndefined();
        expect(client.maxMessageBytes).toBe(65_536);
        client.close();
    });

    it.each([["a string", "65536"], ["zero", 0], ["negative", -1], ["infinite", Infinity], ["NaN", NaN], ["missing", undefined]])(
        "keeps the default maxMessageBytes when ready's is %s",
        async (_name, value) => {
            const { client, sockets } = setup();
            const connected = client.connect();
            sockets[0].open();
            // JSON turns Infinity/NaN into null, so hand those over as raw frames.
            sockets[0].onmessage?.({ data: `{"op":"ready","v":1,"maxMessageBytes":${value === undefined ? "null" : JSON.stringify(value) ?? "null"}}` });
            await connected;
            expect(client.maxMessageBytes).toBe(SIGNALING_DEFAULT_MAX_MESSAGE_BYTES);
            client.close();
        },
    );

    it("does not say hello on a socket that is not open", () => {
        const { client, sockets } = setup();
        void client.connect().catch(() => undefined);
        // `onopen` fired while the socket still reports CONNECTING - `write()` drops it rather than throwing.
        sockets[0].onopen?.({});
        expect(sockets[0].send).not.toHaveBeenCalled();
        client.close();
    });

    it("rejects with the server's reason when it refuses the socket (1008) before ready", async () => {
        const { client, sockets, onClosed } = setup();
        const connected = client.connect();
        sockets[0].open();
        sockets[0].triggerClose(1008, "No grant.");
        await expect(connected).rejects.toThrow("No grant.");
        expect(onClosed).not.toHaveBeenCalled();
        expect(sockets).toHaveLength(1);
        client.close();
    });

    it("rejects with a default reason when a 1008 before ready carries none", async () => {
        const { client, sockets } = setup();
        const connected = client.connect();
        sockets[0].triggerClose(1008, "");
        await expect(connected).rejects.toThrow("The meeting refused the connection.");
        client.close();
    });

    it("rejects when there is no URL to connect to", async () => {
        const { client, createSocket } = setup({ url: undefined });
        await expect(client.connect()).rejects.toThrow(/doesn't support/);
        expect(createSocket).not.toHaveBeenCalled();
    });

    it("rejects when no createSocket is given and there is no global WebSocket either", async () => {
        vi.stubGlobal("WebSocket", undefined);
        const { client } = setup({ createSocket: undefined });
        await expect(client.connect()).rejects.toThrow(/doesn't support/);
    });

    it("falls back to the global WebSocket constructor, and to signalingUrl(), when given neither", async () => {
        class FakeWebSocket {
            static instances: FakeWebSocket[] = [];
            readyState = 0;
            onopen: ((event: unknown) => void) | null = null;
            onmessage: ((event: { data: unknown }) => void) | null = null;
            onclose: ((event: unknown) => void) | null = null;
            onerror: ((event: unknown) => void) | null = null;
            send = vi.fn();
            close = vi.fn();
            constructor(public url: string) {
                FakeWebSocket.instances.push(this);
            }
        }
        vi.stubGlobal("WebSocket", FakeWebSocket);
        vi.stubGlobal("window", { location: { origin: "https://mail.example.com" } });
        const { client } = setup({ createSocket: undefined, url: undefined });
        const connected = client.connect();
        const socket = FakeWebSocket.instances[0];
        expect(socket.url).toBe(URL);
        socket.readyState = 1;
        socket.onopen?.({});
        socket.onmessage?.({ data: JSON.stringify({ op: "ready", v: 1, maxMessageBytes: 1_000 }) });
        await connected;
        client.close();
        expect(socket.close).toHaveBeenCalledWith(1000, "closing");
    });

    it("rejects a connect() call on an already-closed client", async () => {
        const { client, createSocket } = setup();
        client.close();
        await expect(client.connect()).rejects.toThrow(/already been closed/);
        expect(createSocket).not.toHaveBeenCalled();
    });

    it("rejects the pending connect when closed before it resolves", async () => {
        const { client } = setup();
        const connected = client.connect();
        client.close();
        await expect(connected).rejects.toThrow(/Closed before/);
    });

    it("schedules a reconnect when the socket factory throws, and connects on a later attempt", async () => {
        vi.useFakeTimers();
        const socket = fakeSignalingSocket();
        let calls = 0;
        const { client } = setup({
            createSocket: () => {
                calls++;
                if (calls === 1) {
                    throw new Error("boom");
                }
                return socket;
            },
        });
        const connected = client.connect();
        expect(calls).toBe(1);
        await vi.advanceTimersByTimeAsync(499);
        expect(calls).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toBe(2);
        ready(socket);
        await expect(connected).resolves.toBeUndefined();
        client.close();
    });

    it("ignores an error event, leaving it to the close that follows", () => {
        const { client, sockets } = setup();
        void client.connect().catch(() => undefined);
        expect(sockets[0].onerror?.({})).toBeUndefined();
        client.close();
    });
});

describe("SignalingClient auth cookie", () => {
    it("sets the guest cookie before connecting and clears it on close, once", async () => {
        const { client, sockets, doc } = setup();
        const connected = client.connect();
        expect(doc.cookie).toBe("jwt=guest-token; path=/; SameSite=Lax; Secure");
        ready(sockets[0]);
        await connected;

        client.close();
        expect(doc.cookie).toBe("jwt=; path=/; Max-Age=0");
        expect(sockets[0].close).toHaveBeenCalledWith(1000, "closing");

        // Idempotent - a second close() is a no-op (no double-clear, no second socket close).
        doc.cookie = "unrelated=value";
        client.close();
        expect(doc.cookie).toBe("unrelated=value");
        expect(sockets[0].close).toHaveBeenCalledTimes(1);
    });

    it("encodes the token", () => {
        const { client, doc } = setup({ token: "a;b c" });
        void client.connect().catch(() => undefined);
        expect(doc.cookie).toBe("jwt=a%3Bb%20c; path=/; SameSite=Lax; Secure");
        client.close();
    });

    it("writes no cookie at all when token is omitted (a caller already signed in), and clears none on close", async () => {
        const { client, sockets, doc } = setup({ token: undefined });
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        expect(doc.cookie).toBe("");
        client.close();
        expect(doc.cookie).toBe("");
    });

    it("clears no cookie when closed before ever connecting", () => {
        const { client, doc } = setup();
        doc.cookie = "unrelated=value";
        client.close();
        expect(doc.cookie).toBe("unrelated=value");
    });

    it("omits Secure over a non-HTTPS origin", () => {
        const doc = fakeDocument("http:");
        const { client } = setup({ documentRef: doc });
        void client.connect().catch(() => undefined);
        expect(doc.cookie).toBe("jwt=guest-token; path=/; SameSite=Lax");
        client.close();
    });

    it("does nothing when there is no document to set a cookie on", async () => {
        // This file runs under vitest's plain `node` environment - no real `document` exists either.
        const { client, sockets } = setup({ documentRef: undefined });
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        expect(() => client.close()).not.toThrow();
    });

    it("falls back to the global document and location", () => {
        const doc = { cookie: "" };
        vi.stubGlobal("document", doc);
        const first = setup({ documentRef: undefined });
        void first.client.connect().catch(() => undefined);
        // No global `location` in node - no Secure.
        expect(doc.cookie).toBe("jwt=guest-token; path=/; SameSite=Lax");
        first.client.close();
        expect(doc.cookie).toBe("jwt=; path=/; Max-Age=0");

        vi.stubGlobal("location", { protocol: "https:" });
        const second = setup({ documentRef: { cookie: "" } });
        void second.client.connect().catch(() => undefined);
        second.client.close();
        const third = setup({ documentRef: undefined });
        void third.client.connect().catch(() => undefined);
        expect(doc.cookie).toBe("jwt=guest-token; path=/; SameSite=Lax; Secure");
        third.client.close();
    });

    it("re-applies the cookie before each reconnect", async () => {
        vi.useFakeTimers();
        const { client, sockets, doc } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        doc.cookie = "";
        sockets[0].triggerClose(1006);
        await vi.advanceTimersByTimeAsync(500);
        expect(sockets).toHaveLength(2);
        expect(doc.cookie).toBe("jwt=guest-token; path=/; SameSite=Lax; Secure");
        client.close();
    });
});

describe("SignalingClient.send", () => {
    it("writes a signal envelope directly once ready", async () => {
        const { client, sockets } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        client.send(signal("offer"));
        expect(frames(sockets[0])[1]).toEqual({ op: "signal", data: signal("offer") });
        client.close();
    });

    it("queues while not ready and flushes in order on ready", async () => {
        const { client, sockets } = setup();
        client.send(signal("hello"));
        const connected = client.connect();
        client.send(signal("offer"));
        sockets[0].open();
        client.send(signal("answer"));
        expect(frames(sockets[0])).toEqual([{ op: "hello", v: 1, peer: "me~1" }]);
        sockets[0].message({ op: "ready", v: 1, maxMessageBytes: 65_536 });
        await connected;
        expect(frames(sockets[0]).slice(1)).toEqual([
            { op: "signal", data: signal("hello") },
            { op: "signal", data: signal("offer") },
            { op: "signal", data: signal("answer") },
        ]);
        client.close();
    });

    it("drops the oldest queued message once the queue is full", async () => {
        const { client, sockets } = setup();
        for (let i = 0; i < SIGNALING_MAX_QUEUED + 2; i++) {
            client.send(signal("state", `p${i}`));
        }
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        const sent = frames(sockets[0]).slice(1) as { data: SignalMessage }[];
        expect(sent).toHaveLength(SIGNALING_MAX_QUEUED);
        expect(sent[0].data.from).toBe("p2");
        expect(sent[sent.length - 1].data.from).toBe(`p${SIGNALING_MAX_QUEUED + 1}`);
        client.close();
    });

    it("queues a message whose write throws, and keeps the rest queued when a flush write throws", async () => {
        vi.useFakeTimers();
        const { client, sockets } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        sockets[0].send.mockImplementation(() => {
            throw new Error("gone");
        });
        expect(() => client.send(signal("offer"))).not.toThrow();
        expect(() => client.send(signal("answer"))).not.toThrow();

        sockets[0].triggerClose(1006);
        await vi.advanceTimersByTimeAsync(500);
        // The new socket's first flush write throws too - nothing is lost, it waits for the next ready.
        sockets[1].open();
        sockets[1].send.mockImplementationOnce(() => {
            throw new Error("gone");
        });
        sockets[1].message({ op: "ready", v: 1 });
        expect(frames(sockets[1])).toEqual([{ op: "hello", v: 1, peer: "me~1" }]);

        sockets[1].triggerClose(1006);
        await vi.advanceTimersByTimeAsync(500);
        ready(sockets[2]);
        expect(frames(sockets[2]).slice(1)).toEqual([
            { op: "signal", data: signal("offer") },
            { op: "signal", data: signal("answer") },
        ]);
        client.close();
    });

    it("is a no-op once closed", () => {
        const { client, sockets } = setup();
        void client.connect().catch(() => undefined);
        client.close();
        client.send(signal());
        sockets[0].readyState = 1;
        expect(sockets[0].send).not.toHaveBeenCalled();
    });
});

describe("SignalingClient incoming frames", () => {
    async function connected() {
        const ctx = setup();
        const promise = ctx.client.connect();
        ready(ctx.sockets[0]);
        await promise;
        return ctx;
    }

    it("delivers a signal to every listener, and stops after unsubscribing", async () => {
        const { client, sockets } = await connected();
        const a: SignalMessage[] = [];
        const b: SignalMessage[] = [];
        const unsubscribeA = client.onMessage((m) => a.push(m));
        client.onMessage((m) => b.push(m));
        const payload = signal("offer", "them~2");
        sockets[0].message({ op: "signal", data: payload });
        expect(a).toEqual([payload]);
        expect(b).toEqual([payload]);

        unsubscribeA();
        sockets[0].message({ op: "signal", data: payload });
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(2);
        client.close();
    });

    it("lets a listener unsubscribe itself mid-delivery without skipping the others", async () => {
        const { client, sockets } = await connected();
        const seen: string[] = [];
        const unsubscribe = client.onMessage(() => {
            seen.push("first");
            unsubscribe();
        });
        client.onMessage(() => seen.push("second"));
        sockets[0].message({ op: "signal", data: signal() });
        sockets[0].message({ op: "signal", data: signal() });
        expect(seen).toEqual(["first", "second", "second"]);
        client.close();
    });

    it("ignores junk frames", async () => {
        const { client, sockets } = await connected();
        const listener = vi.fn();
        client.onMessage(listener);
        sockets[0].onmessage?.({ data: 42 });
        sockets[0].onmessage?.({ data: new ArrayBuffer(4) });
        sockets[0].onmessage?.({ data: "not json {" });
        sockets[0].onmessage?.({ data: "null" });
        sockets[0].onmessage?.({ data: '"a string"' });
        sockets[0].onmessage?.({ data: "7" });
        sockets[0].message({ op: "signal" });
        sockets[0].message({ op: "signal", data: null });
        sockets[0].message({ op: "signal", data: "not-an-object" });
        sockets[0].message({ op: "pong", t: 1 });
        sockets[0].message({ op: "whatever", data: signal() });
        sockets[0].message({ data: signal() });
        expect(listener).not.toHaveBeenCalled();
        client.close();
    });

    it("hands the server's removed notice to every onRemoved listener, never to onMessage, and stops after unsubscribing", async () => {
        const { client, sockets } = await connected();
        const message = vi.fn();
        const a: string[] = [];
        const b: string[] = [];
        client.onMessage(message);
        const unsubscribeA = client.onRemoved((uid) => a.push(uid));
        client.onRemoved((uid) => b.push(uid));
        sockets[0].message({ op: "removed", uid: "bob" });
        expect(a).toEqual(["bob"]);
        expect(b).toEqual(["bob"]);
        expect(message).not.toHaveBeenCalled();

        unsubscribeA();
        sockets[0].message({ op: "removed", uid: "carol" });
        expect(a).toEqual(["bob"]);
        expect(b).toEqual(["bob", "carol"]);
        client.close();
    });

    it("ignores a removed notice without a uid, and one a participant sent inside a signal", async () => {
        const { client, sockets } = await connected();
        const removed = vi.fn();
        client.onRemoved(removed);
        sockets[0].message({ op: "removed" });
        sockets[0].message({ op: "removed", uid: "" });
        sockets[0].message({ op: "removed", uid: 42 });
        sockets[0].message({ op: "signal", data: { op: "removed", uid: "bob" } });
        expect(removed).not.toHaveBeenCalled();
        client.close();
    });

    it("reports a removed listener that throws, and still calls the rest", async () => {
        const { client, sockets } = await connected();
        const reportError = vi.fn();
        vi.stubGlobal("reportError", reportError);
        try {
            const second = vi.fn();
            client.onRemoved(() => {
                throw new Error("boom");
            });
            client.onRemoved(second);
            sockets[0].message({ op: "removed", uid: "bob" });
            expect(second).toHaveBeenCalledWith("bob");
            expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
        } finally {
            vi.unstubAllGlobals();
        }
        client.close();
    });

    it("drops its removed listeners on close", async () => {
        const { client, sockets } = await connected();
        const removed = vi.fn();
        client.onRemoved(removed);
        const onmessage = sockets[0].onmessage;
        client.close();
        onmessage?.({ data: JSON.stringify({ op: "removed", uid: "bob" }) });
        expect(removed).not.toHaveBeenCalled();
    });

    it("drops its listeners on close", async () => {
        const { client, sockets } = await connected();
        const listener = vi.fn();
        client.onMessage(listener);
        const onmessage = sockets[0].onmessage;
        client.close();
        expect(sockets[0].onmessage).toBeNull();
        onmessage?.({ data: JSON.stringify({ op: "signal", data: signal() }) });
        expect(listener).not.toHaveBeenCalled();
    });
});

describe("SignalingClient keepalive", () => {
    it("pings on an interval once ready, and stops once closed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const { client, sockets } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        await vi.advanceTimersByTimeAsync(SIGNALING_KEEPALIVE_MS - 1);
        expect(sockets[0].sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(frames(sockets[0])[1]).toEqual({ op: "ping", t: 1_000_000 + SIGNALING_KEEPALIVE_MS });
        await vi.advanceTimersByTimeAsync(SIGNALING_KEEPALIVE_MS);
        expect(sockets[0].sent).toHaveLength(3);

        client.close();
        await vi.advanceTimersByTimeAsync(SIGNALING_KEEPALIVE_MS * 3);
        expect(sockets[0].sent).toHaveLength(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops pinging when the socket drops, and restarts on the next ready (only once)", async () => {
        vi.useFakeTimers();
        const { client, sockets } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        sockets[0].triggerClose(1006);
        expect(vi.getTimerCount()).toBe(1); // just the reconnect
        await vi.advanceTimersByTimeAsync(500);
        ready(sockets[1]);
        // A repeated ready replaces the keepalive rather than adding a second one.
        sockets[1].message({ op: "ready", v: 1 });
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(SIGNALING_KEEPALIVE_MS);
        expect(frames(sockets[1]).filter((f) => (f as { op: string }).op === "ping")).toHaveLength(1);
        expect(sockets[0].sent).toHaveLength(1);
        client.close();
    });
});

describe("SignalingClient reconnect", () => {
    it("reconnects with backoff after an unexpected close, says hello again, and resets the backoff on ready", async () => {
        vi.useFakeTimers();
        const { client, sockets, onClosed } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;

        sockets[0].triggerClose(1006);
        await vi.advanceTimersByTimeAsync(499);
        expect(sockets).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(2);

        // The second attempt fails too - the next wait doubles.
        sockets[1].triggerClose(1006);
        await vi.advanceTimersByTimeAsync(999);
        expect(sockets).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(3);

        client.send(signal("offer"));
        ready(sockets[2]);
        expect(frames(sockets[2])).toEqual([
            { op: "hello", v: 1, peer: "me~1" },
            { op: "signal", data: signal("offer") },
        ]);

        // Ready reset the backoff.
        sockets[2].triggerClose(1001);
        await vi.advanceTimersByTimeAsync(500);
        expect(sockets).toHaveLength(4);
        expect(onClosed).not.toHaveBeenCalled();
        client.close();
    });

    it("treats a close event without a code as unexpected", async () => {
        vi.useFakeTimers();
        const { client, sockets } = setup();
        void client.connect().catch(() => undefined);
        sockets[0].readyState = 3;
        sockets[0].onclose?.(undefined as unknown as { code?: number });
        await vi.advanceTimersByTimeAsync(500);
        expect(sockets).toHaveLength(2);
        client.close();
    });

    it("keeps retrying a connect() that has not resolved yet, and still resolves it", async () => {
        vi.useFakeTimers();
        const { client, sockets } = setup();
        const connected = client.connect();
        sockets[0].triggerClose(1006);
        await vi.advanceTimersByTimeAsync(500);
        ready(sockets[1]);
        await expect(connected).resolves.toBeUndefined();
        client.close();
    });

    it("jitters the wait with random() and caps it at SIGNALING_BACKOFF_MAX_MS", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const { client } = setup({
            random: () => 1,
            createSocket: () => {
                calls++;
                throw new Error("boom");
            },
        });
        void client.connect().catch(() => undefined);
        // With random() = 1 each wait is the full ceiling: 1s, 2s, 4s, 8s, 16s, then 30s from there on.
        for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000]) {
            const before = calls;
            await vi.advanceTimersByTimeAsync(wait - 1);
            expect(calls).toBe(before);
            await vi.advanceTimersByTimeAsync(1);
            expect(calls).toBe(before + 1);
        }
        expect(SIGNALING_BACKOFF_MAX_MS).toBe(30_000);
        client.close();
    });

    it("uses Math.random() when no random option is given", async () => {
        vi.useFakeTimers();
        const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
        const { client, sockets } = setup({ random: undefined });
        void client.connect().catch(() => undefined);
        sockets[0].triggerClose(1006);
        expect(random).toHaveBeenCalled();
        // ceiling 1s: 500ms + 0.5 * 500ms.
        await vi.advanceTimersByTimeAsync(749);
        expect(sockets).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets).toHaveLength(2);
        client.close();
    });

    it("does not reconnect after close(), even when the old socket's close event fires", async () => {
        vi.useFakeTimers();
        const { client, sockets } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        const onclose = sockets[0].onclose;
        client.close();
        expect(sockets[0].onclose).toBeNull();
        onclose?.({ code: 1006 });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(1);
    });

    it("cancels a pending reconnect on close()", async () => {
        vi.useFakeTimers();
        const { client, sockets } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        sockets[0].triggerClose(1006);
        client.close();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(1);
    });

    it("does not reconnect when the factory throws after close() (e.g. close() from inside it)", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const holder: { client?: SignalingClient } = {};
        const { client } = setup({
            createSocket: () => {
                calls++;
                holder.client?.close();
                throw new Error("boom");
            },
        });
        holder.client = client;
        await expect(client.connect()).rejects.toThrow(/Closed before/);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls).toBe(1);
    });

    it("ignores a belated close event from a stale (already-replaced) socket", async () => {
        vi.useFakeTimers();
        const { client, sockets } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;

        sockets[0].triggerClose(1006);
        await vi.advanceTimersByTimeAsync(500);
        expect(sockets).toHaveLength(2);
        ready(sockets[1]);

        // `sockets[0]` is stale now - neither another close nor a 1008 "Replaced." from it may schedule a reconnect,
        // drop the current socket or end the call.
        sockets[0].triggerClose(1006);
        sockets[0].triggerClose(1008, "Replaced.");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(2);
        client.send(signal("offer"));
        expect(frames(sockets[1]).at(-1)).toEqual({ op: "signal", data: signal("offer") });
        client.close();
    });
});

describe("SignalingClient refused after ready", () => {
    it("calls onClosed with the server's reason on a 1008, and does not reconnect", async () => {
        vi.useFakeTimers();
        const { client, sockets, onClosed } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        sockets[0].triggerClose(1008, "Removed from the meeting.");
        expect(onClosed).toHaveBeenCalledExactlyOnceWith("Removed from the meeting.");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        client.close();
    });

    it("uses a default reason when the 1008 carries none", async () => {
        const { client, sockets, onClosed } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        sockets[0].triggerClose(1008);
        expect(onClosed).toHaveBeenCalledExactlyOnceWith("The meeting refused the connection.");
        client.close();
    });

    it("calls onClosed for a 1008 on a reconnected socket before it is ready again", async () => {
        vi.useFakeTimers();
        const { client, sockets, onClosed } = setup();
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        sockets[0].triggerClose(1006);
        await vi.advanceTimersByTimeAsync(500);
        sockets[1].open();
        sockets[1].triggerClose(1008, "The meeting has ended.");
        expect(onClosed).toHaveBeenCalledExactlyOnceWith("The meeting has ended.");
        client.close();
    });

    it("is fine without an onClosed callback", async () => {
        const { client, sockets } = setup({ onClosed: undefined });
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        expect(() => sockets[0].triggerClose(1008, "Bye.")).not.toThrow();
        client.close();
    });
});

describe("SignalingClient.close", () => {
    it("swallows a socket that throws on close", () => {
        const { client, sockets } = setup();
        void client.connect().catch(() => undefined);
        sockets[0].close.mockImplementation(() => {
            throw new Error("already gone");
        });
        expect(() => client.close()).not.toThrow();
    });

    it("works with no socket at all", () => {
        const { client } = setup();
        expect(() => client.close()).not.toThrow();
    });
});

describe("SignalingClient with a protected meeting's cipher", () => {
    /** A stand-in cipher: seals to `{ e: <kind> }`, opens what names a kind, drops the rest - slowly for the first message, to show order. */
    function fakeCipher() {
        let delay = 20;
        return {
            seal: vi.fn(async (message: SignalMessage) => {
                const wait = delay;
                delay = 0;
                await new Promise((resolve) => setTimeout(resolve, wait));
                return message.to ? { to: message.to, e: message.kind } : { e: message.kind };
            }),
            open: vi.fn(async (data: Record<string, unknown>) => {
                const wait = delay;
                delay = 0;
                await new Promise((resolve) => setTimeout(resolve, wait));
                return typeof data.e === "string" ? signal(data.e as SignalMessage["kind"], String(data.from)) : undefined;
            }),
        };
    }

    it("sends only sealed messages, in the order they were sent, and nothing once closed", async () => {
        const cipher = fakeCipher();
        const { client, sockets } = setup({ cipher });
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        client.send(signal("hello"));
        client.send({ ...signal("offer"), to: "bob~1" });
        await vi.waitFor(() => expect(frames(sockets[0])).toHaveLength(3));
        expect(frames(sockets[0]).slice(1)).toEqual([
            { op: "signal", data: { e: "hello" } },
            { op: "signal", data: { to: "bob~1", e: "offer" } },
        ]);
        client.close();
        client.send(signal("bye"));
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(frames(sockets[0])).toHaveLength(3);
    });

    it("hands listeners only what opens, in the order it arrived", async () => {
        const cipher = fakeCipher();
        const { client, sockets } = setup({ cipher });
        const received: SignalMessage[] = [];
        client.onMessage((message) => received.push(message));
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        sockets[0].message({ op: "signal", data: { e: "hello", from: "bob" } });
        sockets[0].message({ op: "signal", data: { kind: "chat", from: "mallory" } });
        sockets[0].message({ op: "signal", data: { e: "state", from: "bob" } });
        await vi.waitFor(() => expect(cipher.open).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(received.map((m) => m.kind)).toEqual(["hello", "state"]));
        client.close();
    });

    it("reports the plaintext a message may take once sealed, and the server's limit itself without a cipher", async () => {
        const cipher = { ...fakeCipher(), plaintextBudget: vi.fn((limit: number) => limit - 100) };
        const { client, sockets } = setup({ cipher });
        const connected = client.connect();
        ready(sockets[0], 20_000);
        await connected;
        expect(client.maxMessageBytes).toBe(20_000);
        expect(client.maxPlainMessageBytes).toBe(19_900);
        client.close();

        const plain = setup();
        expect(plain.client.maxPlainMessageBytes).toBe(SIGNALING_DEFAULT_MAX_MESSAGE_BYTES);
        expect(setup({ cipher: fakeCipher() }).client.maxPlainMessageBytes).toBe(SIGNALING_DEFAULT_MAX_MESSAGE_BYTES);
    });

    it("keeps delivering after a listener throws, or a message fails to open, and keeps sending after one fails to seal", async () => {
        const reportError = vi.fn();
        vi.stubGlobal("reportError", reportError);
        const cipher = fakeCipher();
        const { client, sockets } = setup({ cipher });
        const received: string[] = [];
        let throwOnce = true;
        client.onMessage((message) => {
            if (throwOnce) {
                throwOnce = false;
                throw new Error("listener broke");
            }
            received.push(message.kind);
        });
        client.onMessage((message) => received.push(`second:${message.kind}`));
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        cipher.open.mockRejectedValueOnce(new Error("open broke"));
        sockets[0].message({ op: "signal", data: { e: "chat", from: "bob" } });
        sockets[0].message({ op: "signal", data: { e: "hello", from: "bob" } });
        sockets[0].message({ op: "signal", data: { e: "state", from: "bob" } });
        await vi.waitFor(() => expect(received).toEqual(["second:hello", "state", "second:state"]));
        expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "listener broke" }));

        cipher.seal.mockRejectedValueOnce(new Error("seal broke"));
        client.send(signal("chat"));
        client.send(signal("bye"));
        await vi.waitFor(() => expect(frames(sockets[0]).slice(1)).toEqual([{ op: "signal", data: { e: "bye" } }]));
        client.close();
    });

    it("hands a plaintext message to the other listeners when one throws, with no error reporting to give it to", async () => {
        vi.stubGlobal("reportError", undefined);
        const { client, sockets } = setup();
        const received: string[] = [];
        client.onMessage(() => {
            throw new Error("listener broke");
        });
        client.onMessage((message) => received.push(message.kind));
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        expect(() => sockets[0].message({ op: "signal", data: signal("hello", "bob") })).not.toThrow();
        expect(received).toEqual(["hello"]);
        client.close();
    });

    it("hands on a removed notice only after every signal that arrived before it has been opened", async () => {
        const cipher = fakeCipher();
        const { client, sockets } = setup({ cipher });
        const order: string[] = [];
        client.onMessage((message) => order.push(`${message.kind}:${message.from}`));
        client.onRemoved((uid) => order.push(`removed:${uid}`));
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        // The first open is the slow one: the hello is still being opened when the notice arrives.
        sockets[0].message({ op: "signal", data: { e: "hello", from: "bob~1" } });
        sockets[0].message({ op: "removed", uid: "bob" });
        sockets[0].message({ op: "signal", data: { e: "state", from: "carol~1" } });
        expect(order).toEqual([]);
        await vi.waitFor(() => expect(order).toEqual(["hello:bob~1", "removed:bob", "state:carol~1"]));
        client.close();
    });

    it("drops a removed notice still waiting behind a signal being opened when it closed", async () => {
        const cipher = fakeCipher();
        const { client, sockets } = setup({ cipher });
        const removed = vi.fn();
        client.onRemoved(removed);
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        sockets[0].message({ op: "signal", data: { e: "hello", from: "bob~1" } });
        sockets[0].message({ op: "removed", uid: "bob" });
        client.close();
        await vi.waitFor(() => expect(cipher.open).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(removed).not.toHaveBeenCalled();
    });

    it("drops what was still being sealed or opened when it closed", async () => {
        const cipher = fakeCipher();
        const { client, sockets } = setup({ cipher });
        const received: SignalMessage[] = [];
        client.onMessage((message) => received.push(message));
        const connected = client.connect();
        ready(sockets[0]);
        await connected;
        client.send(signal("hello"));
        sockets[0].message({ op: "signal", data: { e: "state", from: "bob" } });
        client.close();
        await vi.waitFor(() => expect(cipher.open).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(frames(sockets[0])).toHaveLength(1);
        expect(received).toEqual([]);
    });
});
