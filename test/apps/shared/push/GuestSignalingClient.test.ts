///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestSignalingClient } from "../../../../apps/shared/push/GuestSignalingClient.js";
import { fakePushSocket } from "../../testUtils.js";
import type { SignalMessage } from "../../../../apps/shared/webrtc/types.js";

function fakeDocument(): { cookie: string; location: { protocol: string } } {
    return { cookie: "", location: { protocol: "https:" } };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("GuestSignalingClient.connect", () => {
    it("applies the guest auth cookie, subscribes, and resolves once the channel is granted", async () => {
        const socket = fakePushSocket();
        const doc = fakeDocument();
        const client = new GuestSignalingClient({
            channel: "meeting-1",
            token: "guest-token",
            url: () => "wss://example.com/push",
            createSocket: () => socket,
            documentRef: doc,
        });

        const connected = client.connect();
        socket.open();
        socket.message({ id: 0, type: "SUBSCRIBED", data: ["guest:1"] });
        socket.message({ id: 1, type: "SUBSCRIBED", data: ["meeting-1"] });
        await expect(connected).resolves.toBeUndefined();
        expect(doc.cookie).toBe("jwt=guest-token; path=/; SameSite=Lax; Secure");
        expect(JSON.parse(socket.sent[0])).toEqual({ id: 1, type: "SUBSCRIBE", data: ["meeting-1"] });

        client.close();
        expect(doc.cookie).toBe("jwt=; path=/; Max-Age=0");
        expect(socket.close).toHaveBeenCalledWith(1000, "closing");

        // Idempotent - a second close() is a no-op (no double-clear, no throw).
        doc.cookie = "unrelated=value";
        client.close();
        expect(doc.cookie).toBe("unrelated=value");
    });

    it("writes no cookie at all when token is omitted (an already-authenticated real caller - join()'s 'authenticated: true' case)", async () => {
        const socket = fakePushSocket();
        const doc = fakeDocument();
        const client = new GuestSignalingClient({
            channel: "meeting-1",
            url: () => "wss://example.com/push",
            createSocket: () => socket,
            documentRef: doc,
        });

        const connected = client.connect();
        socket.open();
        socket.message({ id: 0, type: "SUBSCRIBED", data: ["real-user-1"] });
        socket.message({ id: 1, type: "SUBSCRIBED", data: ["meeting-1"] });
        await expect(connected).resolves.toBeUndefined();
        // No cookie write at all - relies entirely on the browser's own already-existing real `jwt` session cookie.
        expect(doc.cookie).toBe("");

        client.close();
        // clearAuthCookie() is a no-op too: nothing was ever applied, so nothing to clear or overwrite.
        expect(doc.cookie).toBe("");
    });

    it("omits Secure over a non-HTTPS origin", async () => {
        const socket = fakePushSocket();
        const doc = { cookie: "", location: { protocol: "http:" } };
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => socket,
            documentRef: doc,
        });
        const connected = client.connect();
        socket.open();
        socket.message({ id: 0, type: "SUBSCRIBED", data: [] });
        socket.message({ id: 1, type: "SUBSCRIBED", data: ["m1"] });
        await connected;
        expect(doc.cookie).toBe("jwt=t; path=/; SameSite=Lax");
    });

    it("does nothing when there is no document to set a cookie on (SSR)", async () => {
        const socket = fakePushSocket();
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => socket,
            documentRef: undefined,
        });
        // This test file runs under vitest's plain `node` environment - no real `document` exists either.
        const connected = client.connect();
        socket.open();
        socket.message({ id: 0, type: "SUBSCRIBED", data: [] });
        socket.message({ id: 1, type: "SUBSCRIBED", data: ["m1"] });
        await connected;
        client.close();
    });

    it("does not attempt to SUBSCRIBE while the socket isn't actually open yet", async () => {
        const socket = fakePushSocket();
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => socket,
            documentRef: fakeDocument(),
        });
        void client.connect().catch(() => undefined);
        // The connect-time greeting arrives before this fake socket reports itself open (readyState left at its
        // default, `0`/CONNECTING) - `send0()`'s own readiness guard must simply drop the SUBSCRIBE rather than
        // throwing on a socket that isn't ready to send.
        socket.message({ id: 0, type: "SUBSCRIBED", data: [] });
        expect(socket.send).not.toHaveBeenCalled();
        client.close();
    });

    it("rejects when the channel refuses the subscription", async () => {
        const socket = fakePushSocket();
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => socket,
            documentRef: fakeDocument(),
        });
        const connected = client.connect();
        socket.open();
        socket.message({ id: 0, type: "SUBSCRIBED", data: [] });
        socket.message({ id: 1, type: "SUBSCRIBED", data: [] });
        await expect(connected).rejects.toThrow(/refused/);
    });

    it("rejects immediately when there is no WebSocket support", async () => {
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => undefined,
            documentRef: fakeDocument(),
        });
        await expect(client.connect()).rejects.toThrow(/doesn't support/);
    });

    it("rejects when no createSocket is given and there is no global WebSocket either", async () => {
        vi.stubGlobal("WebSocket", undefined);
        const client = new GuestSignalingClient({ channel: "m1", token: "t", url: () => "ws://localhost/push", documentRef: fakeDocument() });
        await expect(client.connect()).rejects.toThrow(/doesn't support/);
    });

    it("falls back to the real global WebSocket constructor when no createSocket is given", async () => {
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
        const client = new GuestSignalingClient({ channel: "m1", token: "t", url: () => "ws://localhost/push", documentRef: fakeDocument() });
        const connected = client.connect();
        const socket = FakeWebSocket.instances[0];
        expect(socket.url).toBe("ws://localhost/push");
        socket.readyState = 1;
        socket.onmessage?.({ data: JSON.stringify({ id: 0, type: "SUBSCRIBED", data: [] }) });
        socket.onmessage?.({ data: JSON.stringify({ id: 1, type: "SUBSCRIBED", data: ["m1"] }) });
        await connected;
        client.close();
        expect(socket.close).toHaveBeenCalledWith(1000, "closing");
    });

    it("rejects a connect() call on an already-closed client", async () => {
        const client = new GuestSignalingClient({ channel: "m1", token: "t", url: () => undefined });
        client.close();
        await expect(client.connect()).rejects.toThrow(/already been closed/);
    });

    it("rejects the pending connect when closed before it resolves", async () => {
        const socket = fakePushSocket();
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => socket,
            documentRef: fakeDocument(),
        });
        const connected = client.connect();
        client.close();
        await expect(connected).rejects.toThrow(/Closed before/);
    });

    it("schedules a reconnect when the socket factory throws synchronously", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => {
                calls++;
                throw new Error("boom");
            },
            documentRef: fakeDocument(),
            random: () => 0,
        });
        void client.connect().catch(() => undefined);
        expect(calls).toBe(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(calls).toBeGreaterThan(1);
        client.close();
        vi.useRealTimers();
    });

    it("reconnects with backoff after an unexpected close, and does not reconnect after close()", async () => {
        vi.useFakeTimers();
        const sockets = [fakePushSocket(), fakePushSocket()];
        let index = 0;
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => sockets[index++],
            documentRef: fakeDocument(),
            random: () => 0,
        });
        const connected = client.connect();
        sockets[0].open();
        sockets[0].message({ id: 0, type: "SUBSCRIBED", data: [] });
        sockets[0].message({ id: 1, type: "SUBSCRIBED", data: ["m1"] });
        await connected;

        sockets[0].triggerClose();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(index).toBe(2);
        sockets[1].open();
        sockets[1].message({ id: 0, type: "SUBSCRIBED", data: [] });
        sockets[1].message({ id: 2, type: "SUBSCRIBED", data: ["m1"] });

        client.close();
        sockets[1].triggerClose();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(index).toBe(2);
        vi.useRealTimers();
    });

    it("ignores a belated close event from a stale (already-replaced) socket", async () => {
        vi.useFakeTimers();
        const sockets = [fakePushSocket(), fakePushSocket()];
        let index = 0;
        const client = new GuestSignalingClient({
            channel: "m1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => sockets[index++],
            documentRef: fakeDocument(),
            random: () => 0,
        });
        const connected = client.connect();
        sockets[0].open();
        sockets[0].message({ id: 0, type: "SUBSCRIBED", data: [] });
        sockets[0].message({ id: 1, type: "SUBSCRIBED", data: ["m1"] });
        await connected;

        sockets[0].triggerClose();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(index).toBe(2);

        // `sockets[0]` is now stale (`sockets[1]` is current) - its own belated close firing again must not
        // schedule a second, redundant reconnect.
        expect(() => sockets[0].triggerClose()).not.toThrow();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(index).toBe(2);

        client.close();
        vi.useRealTimers();
    });
});

describe("GuestSignalingClient message handling", () => {
    async function connectedClient(): Promise<{ client: GuestSignalingClient; socket: ReturnType<typeof fakePushSocket> }> {
        const socket = fakePushSocket();
        const client = new GuestSignalingClient({
            channel: "meeting-1",
            token: "t",
            url: () => "ws://localhost/push",
            createSocket: () => socket,
            documentRef: fakeDocument(),
        });
        const connected = client.connect();
        socket.open();
        socket.message({ id: 0, type: "SUBSCRIBED", data: [] });
        socket.message({ id: 1, type: "SUBSCRIBED", data: ["meeting-1"] });
        await connected;
        return { client, socket };
    }

    it("delivers a signaling message for this channel, and unsubscribes cleanly", async () => {
        const { client, socket } = await connectedClient();
        const received: SignalMessage[] = [];
        const unsubscribe = client.onMessage((m) => received.push(m));
        const payload: SignalMessage = { type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" };
        socket.message({ type: "MESSAGE", channel: "meeting-1", data: payload });
        expect(received).toEqual([payload]);

        unsubscribe();
        socket.message({ type: "MESSAGE", channel: "meeting-1", data: payload });
        expect(received).toHaveLength(1);
    });

    it("ignores messages for a different channel, non-signal payloads, malformed JSON and non-string frames", async () => {
        const { client, socket } = await connectedClient();
        const received: SignalMessage[] = [];
        client.onMessage((m) => received.push(m));

        socket.message({ type: "MESSAGE", channel: "some-other-channel", data: { type: "video-meeting-signal", kind: "hello", from: "z" } });
        socket.message({ type: "MESSAGE", channel: "meeting-1", data: { type: "SomethingElse" } });
        socket.message({ type: "MESSAGE", channel: "meeting-1", data: "not-an-object" });
        socket.onmessage?.({ data: "not json {" });
        socket.onmessage?.({ data: 42 });
        socket.onmessage?.({ data: "null" });
        expect(received).toEqual([]);
    });

    it("ignores an error event", async () => {
        const { socket } = await connectedClient();
        expect(() => socket.onerror?.({})).not.toThrow();
    });
});

describe("GuestSignalingClient.send", () => {
    it("POSTs the message with a bearer token, targeting the meeting's own channel", async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const client = new GuestSignalingClient({ channel: "meeting-1", token: "guest-token", fetchImpl });
        const message: SignalMessage = { type: "video-meeting-signal", kind: "bye", from: "g1" };
        client.send(message);
        await Promise.resolve();
        expect(fetchImpl).toHaveBeenCalledWith(
            "/push/meeting-1",
            expect.objectContaining({
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer guest-token" },
                body: JSON.stringify(message),
                // So a `bye` sent as the page unloads still goes out.
                keepalive: true,
            }),
        );
    });

    it("POSTs with no Authorization header at all when token is omitted, relying on the browser's own cookie", async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const client = new GuestSignalingClient({ channel: "meeting-1", fetchImpl });
        const message: SignalMessage = { type: "video-meeting-signal", kind: "bye", from: "real-user-1" };
        client.send(message);
        await Promise.resolve();
        expect(fetchImpl).toHaveBeenCalledWith(
            "/push/meeting-1",
            expect.objectContaining({
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(message),
            }),
        );
    });

    it("swallows a failed publish", async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error("network down");
        });
        const client = new GuestSignalingClient({ channel: "m1", token: "t", fetchImpl });
        expect(() => client.send({ type: "video-meeting-signal", kind: "bye", from: "g1" })).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();
    });

    it("does nothing when there is no fetch available", () => {
        vi.stubGlobal("fetch", undefined);
        const client = new GuestSignalingClient({ channel: "m1", token: "t" });
        expect(() => client.send({ type: "video-meeting-signal", kind: "bye", from: "g1" })).not.toThrow();
    });
});
