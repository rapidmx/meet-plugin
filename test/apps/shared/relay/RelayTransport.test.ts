///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFragment, KIND_AUDIO, KIND_VIDEO } from "../../../../apps/shared/relay/frames.js";
import { createRelayTransport, relayUrl } from "../../../../apps/shared/relay/RelayTransport.js";
import { createFakeRelayEnv, FakeAudioData, fakeChunk, FakeVideoFrame, relayed, track, type FakeRelayEnv, last } from "./relayFakes.js";

const api = vi.hoisted(() => ({ origin: "" }));
vi.mock("@rapidmx/web-client/lib/util/api.js", () => ({ apiOrigin: () => api.origin }));

beforeEach(() => {
    api.origin = "";
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const RELAY_URL = "wss://mail.example.com/api/mail/video-meetings/relay/m1";

function setup() {
    const fake = createFakeRelayEnv();
    const transport = createRelayTransport({ meetingUid: "m1", peerId: "me~1", url: RELAY_URL, env: fake.env });
    return { fake, transport };
}

/** Takes the transport's socket through open and ready. */
function connect(fake: FakeRelayEnv, index = 0) {
    const socket = fake.sockets[index];
    socket.open();
    socket.ready();
    return socket;
}

describe("relayUrl", () => {
    it("uses the page's own origin, with http becoming ws", () => {
        vi.stubGlobal("window", { location: { origin: "https://mail.example.com" } });
        expect(relayUrl("m1")).toBe("wss://mail.example.com/api/mail/video-meetings/relay/m1");
        vi.stubGlobal("window", { location: { origin: "http://localhost:3000" } });
        expect(relayUrl("m1")).toBe("ws://localhost:3000/api/mail/video-meetings/relay/m1");
    });

    it("prefers the configured API origin and encodes the meeting uid", () => {
        api.origin = "https://api.example.com";
        vi.stubGlobal("window", { location: { origin: "https://other.example.com" } });
        expect(relayUrl("a b/c")).toBe("wss://api.example.com/api/mail/video-meetings/relay/a%20b%2Fc");
    });

    it("is undefined without any origin (not a browser)", () => {
        expect(relayUrl("m1")).toBeUndefined();
    });
});

describe("createRelayTransport support", () => {
    it("is unsupported, and every call is a harmless no-op, when the browser lacks what it needs", () => {
        // The node test environment has no WebCodecs, so detection fails.
        const transport = createRelayTransport({ meetingUid: "m1", peerId: "me", url: RELAY_URL });
        expect(transport.supported).toBe(false);
        const onStream = vi.fn();
        transport.receiveFrom("p", onStream);
        transport.stopReceivingFrom("p");
        transport.setSending(true);
        transport.setLocalTrack("audio", track("audio"));
        transport.close();
        expect(onStream).not.toHaveBeenCalled();
    });

    it("is unsupported when there is no RELAY_URL to connect to", () => {
        const fake = createFakeRelayEnv();
        expect(createRelayTransport({ meetingUid: "m1", peerId: "me", env: fake.env }).supported).toBe(false);
    });

    it("derives the RELAY_URL from the page when none is given", () => {
        vi.stubGlobal("window", { location: { origin: "https://mail.example.com" } });
        const fake = createFakeRelayEnv();
        const transport = createRelayTransport({ meetingUid: "m1", peerId: "me", env: fake.env });
        expect(transport.supported).toBe(true);
        transport.receiveFrom("p", () => undefined);
        expect(fake.sockets[0].url).toBe("wss://mail.example.com/api/mail/video-meetings/relay/m1");
        transport.close();
    });

    it("is supported with an environment and a RELAY_URL, and opens no socket until it is used", () => {
        const { fake, transport } = setup();
        expect(transport.supported).toBe(true);
        expect(fake.sockets).toHaveLength(0);
        expect(fake.audioContexts).toHaveLength(0);
    });
});

describe("receiving", () => {
    it("opens the socket, wants the peer once ready, and hands over a stream with an audio and a video track", () => {
        const { fake, transport } = setup();
        const onStream = vi.fn();
        transport.receiveFrom("peer-a~x", onStream);
        expect(fake.sockets).toHaveLength(1);
        expect(onStream).toHaveBeenCalledTimes(1);
        const stream = onStream.mock.calls[0][0] as MediaStream;
        expect(stream.getTracks().map((t) => t.kind)).toEqual(["audio", "video"]);
        const socket = connect(fake);
        expect(socket.texts()).toEqual([
            { op: "hello", v: 1, peer: "me~1" },
            { op: "want", peers: ["peer-a~x"] },
        ]);
        transport.close();
    });

    it("gives each peer its own stream, shares one playback context, and re-wants the full set", () => {
        const { fake, transport } = setup();
        const a = vi.fn();
        const b = vi.fn();
        const socket = (transport.receiveFrom("a", a), fake.sockets[0]);
        socket.open();
        socket.ready();
        transport.receiveFrom("b", b);
        expect(a.mock.calls[0][0]).not.toBe(b.mock.calls[0][0]);
        expect(fake.audioContexts).toHaveLength(1);
        expect(fake.sockets).toHaveLength(1);
        expect(last(socket.texts())).toEqual({ op: "want", peers: ["a", "b"] });
        transport.close();
    });

    it("calling receiveFrom again for the same peer is a no-op", () => {
        const { fake, transport } = setup();
        const onStream = vi.fn();
        transport.receiveFrom("a", onStream);
        const socket = connect(fake);
        const before = socket.sent.length;
        transport.receiveFrom("a", onStream);
        expect(onStream).toHaveBeenCalledTimes(1);
        expect(socket.sent).toHaveLength(before);
        transport.close();
    });

    it("stopReceivingFrom drops the peer from the wanted set, ends its stream and is a no-op for an unknown peer", () => {
        const { fake, transport } = setup();
        const onStream = vi.fn();
        transport.receiveFrom("a", onStream);
        transport.receiveFrom("b", () => undefined);
        const socket = connect(fake);
        const stream = onStream.mock.calls[0][0] as MediaStream;
        transport.stopReceivingFrom("a");
        expect(last(socket.texts())).toEqual({ op: "want", peers: ["b"] });
        for (const t of stream.getTracks()) {
            expect(t.stop).toHaveBeenCalled();
        }
        const before = socket.sent.length;
        transport.stopReceivingFrom("a");
        transport.stopReceivingFrom("never-added");
        expect(socket.sent).toHaveLength(before);
        // The stopped peer can be received again, with a fresh stream.
        const again = vi.fn();
        transport.receiveFrom("a", again);
        expect(again).toHaveBeenCalledTimes(1);
        transport.close();
    });

    it("routes relayed media to the right peer's decoders and ignores unknown senders", () => {
        const { fake, transport } = setup();
        transport.receiveFrom("a", () => undefined);
        transport.receiveFrom("b", () => undefined);
        const socket = connect(fake);
        const frame = (kind: number, byte: number) => {
            const header = Uint8Array.of(kind, 1, 0, 0, 0, 1, 0, 0, 0, 0, byte);
            return header;
        };
        socket.message(relayed("a", frame(KIND_AUDIO, 11)));
        socket.message(relayed("b", frame(KIND_AUDIO, 22)));
        socket.message(relayed("stranger", frame(KIND_AUDIO, 33)));
        expect(fake.encodedAudioChunks.map((c) => Array.from(c.data))).toEqual([[11], [22]]);
        transport.close();
    });

    it("does not receive after close, and does not throw on stale media", () => {
        const { fake, transport } = setup();
        transport.receiveFrom("a", () => undefined);
        const socket = connect(fake);
        transport.close();
        const onStream = vi.fn();
        transport.receiveFrom("a", onStream);
        expect(onStream).not.toHaveBeenCalled();
        expect(() => socket.onmessage?.({ data: relayed("a", Uint8Array.of(1)) })).not.toThrow();
    });

    it("hands over no stream when the browser will not build a playback context, and retries next time", () => {
        const { fake, transport } = setup();
        fake.behavior.audioContextThrows = true;
        const onStream = vi.fn();
        transport.receiveFrom("a", onStream);
        expect(onStream).not.toHaveBeenCalled();
        expect(fake.sockets).toHaveLength(0);
        fake.behavior.audioContextThrows = false;
        transport.receiveFrom("a", onStream);
        expect(onStream).toHaveBeenCalledTimes(1);
        transport.close();
    });

    it("hands over no stream when the receiver itself cannot be built", () => {
        const { fake, transport } = setup();
        fake.behavior.mediaStreamThrows = true;
        const onStream = vi.fn();
        transport.receiveFrom("a", onStream);
        expect(onStream).not.toHaveBeenCalled();
        transport.close();
    });

    it("tries to resume a suspended playback context, and stops listening for gestures on close", () => {
        const fake = createFakeRelayEnv();
        fake.behavior.audioContextState = "suspended";
        const transport = createRelayTransport({ meetingUid: "m1", peerId: "me", url: RELAY_URL, env: fake.env });
        transport.receiveFrom("a", () => undefined);
        expect(fake.audioContexts[0].resume).toHaveBeenCalled();
        expect(fake.document.count()).toBeGreaterThan(0);
        transport.close();
        expect(fake.document.count()).toBe(0);
    });
});

describe("sending", () => {
    it("opens the socket when sending starts and encodes nothing until the relay is ready", () => {
        const { fake, transport } = setup();
        transport.setLocalTrack("audio", track("audio"));
        transport.setLocalTrack("video", track("video"));
        expect(fake.sockets).toHaveLength(0);
        transport.setSending(true);
        expect(fake.sockets).toHaveLength(1);
        fake.audioContexts[0].processors[0].run(new Float32Array(2048));
        fake.tick();
        expect(fake.audioData).toHaveLength(0);
        expect(fake.videoFrames).toHaveLength(0);

        const socket = connect(fake);
        fake.audioContexts[0].processors[0].run(new Float32Array(2048));
        fake.tick();
        expect(fake.audioData).toHaveLength(1);
        expect(fake.videoFrames).toHaveLength(1);
        expect((fake.videoEncoders[0].options as { keyFrame: boolean }[])[0]).toEqual({ keyFrame: true });

        fake.audioEncoders[0].emit(fakeChunk([1, 2, 3], "key", 0));
        fake.videoEncoders[0].emit(fakeChunk(new Array(15_000).fill(7), "key", 0));
        const kinds = socket.binaries().map((m) => decodeFragment(m)?.kind);
        expect(kinds).toEqual([KIND_AUDIO, KIND_VIDEO, KIND_VIDEO]);
        transport.close();
    });

    it("accepts tracks before or after setSending, and null to stop a kind", () => {
        const { fake, transport } = setup();
        transport.setSending(true);
        expect(fake.audioContexts).toHaveLength(0);
        transport.setLocalTrack("audio", track("audio"));
        expect(fake.audioContexts).toHaveLength(1);
        transport.setLocalTrack("video", track("video"));
        expect(fake.videos).toHaveLength(1);
        transport.setLocalTrack("audio", null);
        expect(fake.audioContexts[0].closed).toBe(true);
        transport.setLocalTrack("video", null);
        expect(fake.intervals.size).toBe(0);
        transport.close();
    });

    it("stopping releases the encoders and audio nodes but keeps the socket for receiving", () => {
        const { fake, transport } = setup();
        transport.setLocalTrack("audio", track("audio"));
        transport.setLocalTrack("video", track("video"));
        transport.setSending(true);
        connect(fake);
        fake.tick();
        transport.setSending(false);
        expect(fake.audioContexts[0].closed).toBe(true);
        expect(fake.videoEncoders[0].closed).toBe(true);
        expect(fake.intervals.size).toBe(0);
        expect(fake.sockets[0].closeCalls).toHaveLength(0);
        // Sending again re-uses the same socket.
        transport.setSending(true);
        expect(fake.sockets).toHaveLength(1);
        expect(fake.audioContexts).toHaveLength(2);
        transport.close();
    });

    it("setSending(false) alone never opens a socket", () => {
        const { fake, transport } = setup();
        transport.setSending(false);
        expect(fake.sockets).toHaveLength(0);
    });

    it("drops frames while the socket is backed up and forces a key frame after", () => {
        const { fake, transport } = setup();
        transport.setLocalTrack("video", track("video"));
        transport.setSending(true);
        const socket = connect(fake);
        fake.tick();
        socket.bufferedAmount = 1024 * 1024;
        fake.videoEncoders[0].emit(fakeChunk([1], "delta", 0));
        expect(socket.binaries()).toHaveLength(0);
        socket.bufferedAmount = 0;
        fake.tick();
        expect(last(fake.videoEncoders[0].options as { keyFrame: boolean }[])).toEqual({ keyFrame: true });
        transport.close();
    });
});

describe("close", () => {
    it("releases everything, is idempotent, and makes every later call a no-op", () => {
        const { fake, transport } = setup();
        const onStream = vi.fn();
        transport.receiveFrom("a", onStream);
        transport.setLocalTrack("audio", track("audio"));
        transport.setLocalTrack("video", track("video"));
        transport.setSending(true);
        const socket = connect(fake);
        fake.tick();
        const stream = onStream.mock.calls[0][0] as MediaStream;
        // Contexts: [0] is the playback context (receiveFrom came first), [1] the capture graph.
        transport.close();
        transport.close();
        expect(socket.closeCalls).toHaveLength(1);
        expect(fake.audioContexts.every((c) => c.closed)).toBe(true);
        expect(fake.videoEncoders[0].closed).toBe(true);
        expect(fake.intervals.size).toBe(0);
        for (const t of stream.getTracks()) {
            expect(t.stop).toHaveBeenCalled();
        }

        transport.setSending(true);
        transport.setLocalTrack("audio", track("audio"));
        transport.receiveFrom("b", onStream);
        transport.stopReceivingFrom("a");
        vi.advanceTimersByTime(60_000);
        expect(fake.sockets).toHaveLength(1);
        expect(fake.audioContexts).toHaveLength(2);
        expect(onStream).toHaveBeenCalledTimes(1);
    });

    it("ignores the playback context refusing to close", async () => {
        const { fake, transport } = setup();
        transport.receiveFrom("a", () => undefined);
        fake.audioContexts[0].closeRejects = true;
        transport.close();
        await Promise.resolve();
        expect(fake.audioContexts[0].close).toHaveBeenCalled();
    });

    it("stops reconnecting after close", () => {
        const { fake, transport } = setup();
        transport.receiveFrom("a", () => undefined);
        fake.sockets[0].open();
        fake.sockets[0].triggerClose();
        transport.close();
        vi.advanceTimersByTime(60_000);
        expect(fake.sockets).toHaveLength(1);
    });

    it("reconnects and re-sends the wanted set while open", () => {
        const { fake, transport } = setup();
        transport.receiveFrom("a", () => undefined);
        connect(fake);
        fake.sockets[0].triggerClose();
        vi.advanceTimersByTime(1000);
        const second = connect(fake, 1);
        expect(last(second.texts())).toEqual({ op: "want", peers: ["a"] });
        transport.close();
    });
});

describe("message size negotiated with the server", () => {
    /** Sender and receiver on a server that announces `limit` (undefined = an older server that says nothing). */
    function loopback(limit: number | undefined) {
        const sender = createFakeRelayEnv();
        const receiver = createFakeRelayEnv();
        const a = createRelayTransport({ meetingUid: "m1", peerId: "a~1", url: RELAY_URL, env: sender.env });
        const b = createRelayTransport({ meetingUid: "m1", peerId: "b~1", url: RELAY_URL, env: receiver.env });
        b.receiveFrom("a~1", () => undefined);
        a.setLocalTrack("video", track("video"));
        a.setSending(true);
        const extra = limit === undefined ? {} : { maxMessageBytes: limit };
        for (const fake of [sender, receiver]) {
            fake.sockets[0].open();
            fake.sockets[0].ready(extra);
        }
        sender.tick();
        const picture = Uint8Array.from({ length: 30_000 }, (_, i) => i % 251);
        sender.videoEncoders[0].emit(fakeChunk(picture, "key", 0));
        const messages = sender.sockets[0].binaries();
        for (const message of messages) {
            receiver.sockets[0].message(relayed("a~1", message));
        }
        return { a, b, picture, messages, receiver };
    }

    it("sends a 30 KB key frame in ONE message when the server allows 65536", () => {
        const { a, b, picture, messages, receiver } = loopback(65_536);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toHaveLength(30_010);
        expect(receiver.encodedVideoChunks).toHaveLength(1);
        expect(receiver.encodedVideoChunks[0].data).toEqual(picture);
        a.close();
        b.close();
    });

    it("sends it in several messages, each within 16384 bytes, on an older server that announces nothing", () => {
        const { a, b, picture, messages, receiver } = loopback(undefined);
        expect(messages.map((m) => m.length)).toEqual([12_010, 12_010, 6_010]);
        expect(receiver.encodedVideoChunks[0].data).toEqual(picture);
        a.close();
        b.close();
    });

    it("does the same when the server announces 16384 explicitly", () => {
        const { a, b, picture, messages, receiver } = loopback(16_384);
        expect(messages.map((m) => m.length)).toEqual([12_010, 12_010, 6_010]);
        expect(receiver.encodedVideoChunks[0].data).toEqual(picture);
        a.close();
        b.close();
    });

    it("caps each message at 60010 bytes even when the server allows a megabyte", () => {
        const sender = createFakeRelayEnv();
        const a = createRelayTransport({ meetingUid: "m1", peerId: "a~1", url: RELAY_URL, env: sender.env });
        a.setLocalTrack("video", track("video"));
        a.setSending(true);
        sender.sockets[0].open();
        sender.sockets[0].ready({ maxMessageBytes: 1024 * 1024 });
        sender.tick();
        sender.videoEncoders[0].emit(fakeChunk(new Array(100_000).fill(1), "key", 0));
        expect(sender.sockets[0].binaries().map((m) => m.length)).toEqual([60_010, 40_010]);
        a.close();
    });

    it("falls back to 12000 byte fragments after a reconnect to an older server", () => {
        const sender = createFakeRelayEnv();
        const a = createRelayTransport({ meetingUid: "m1", peerId: "a~1", url: RELAY_URL, env: sender.env });
        a.setLocalTrack("video", track("video"));
        a.setSending(true);
        sender.sockets[0].open();
        sender.sockets[0].ready({ maxMessageBytes: 65_536 });
        sender.tick();
        sender.sockets[0].triggerClose();
        vi.advanceTimersByTime(1000);
        sender.sockets[1].open();
        sender.sockets[1].ready();
        sender.tick();
        sender.videoEncoders[0].emit(fakeChunk(new Array(20_000).fill(1), "key", 0));
        expect(sender.sockets[1].binaries().map((m) => m.length)).toEqual([12_010, 8_010]);
        a.close();
    });
});

describe("two participants through a relay", () => {
    /** A stand-in for the server: what one side's socket sends is delivered to the other side's socket, stamped with
     * the sender's id, as `[N][id][payload]`. */
    function pipe(from: FakeRelayEnv, fromId: string, to: FakeRelayEnv) {
        let delivered = 0;
        return () => {
            const socket = from.sockets[0];
            for (const message of socket.binaries().slice(delivered)) {
                to.sockets[0].message(relayed(fromId, message));
            }
            delivered = socket.binaries().length;
        };
    }

    it("carries audio and a multi-fragment key frame from a sender's encoders to a receiver's decoders", () => {
        const sender = createFakeRelayEnv();
        const receiver = createFakeRelayEnv();
        const a = createRelayTransport({ meetingUid: "m1", peerId: "a~1", url: RELAY_URL, env: sender.env });
        const b = createRelayTransport({ meetingUid: "m1", peerId: "b~1", url: RELAY_URL, env: receiver.env });
        const onStream = vi.fn();
        b.receiveFrom("a~1", onStream);
        a.setLocalTrack("audio", track("audio"));
        a.setLocalTrack("video", track("video"));
        a.setSending(true);
        connect(sender);
        connect(receiver);
        const deliver = pipe(sender, "a~1", receiver);

        sender.audioContexts[0].processors[0].run(new Float32Array(2048));
        sender.audioEncoders[0].emit(fakeChunk([5, 6, 7], "key", 20_000));
        sender.tick();
        const picture = Uint8Array.from({ length: 30_000 }, (_, i) => i % 251);
        sender.videoEncoders[0].emit(fakeChunk(picture, "key", 0));
        deliver();

        expect(receiver.encodedAudioChunks.map((c) => Array.from(c.data))).toEqual([[5, 6, 7]]);
        expect(receiver.encodedVideoChunks).toHaveLength(1);
        expect(receiver.encodedVideoChunks[0]).toMatchObject({ type: "key" });
        expect(receiver.encodedVideoChunks[0].data).toEqual(picture);

        // The decoders' output reaches the receiver's stream: audio is scheduled, video is drawn.
        receiver.audioDecoders[0].emit(new FakeAudioData(960));
        receiver.videoDecoders[0].emit(new FakeVideoFrame(480, 360));
        expect(receiver.audioContexts[0].sources).toHaveLength(1);
        expect(receiver.canvases[0].drawn).toHaveLength(1);

        a.close();
        b.close();
    });

    it("recovers video at the next key frame when the server drops a fragment", () => {
        const sender = createFakeRelayEnv();
        const receiver = createFakeRelayEnv();
        const a = createRelayTransport({ meetingUid: "m1", peerId: "a~1", url: RELAY_URL, env: sender.env });
        const b = createRelayTransport({ meetingUid: "m1", peerId: "b~1", url: RELAY_URL, env: receiver.env });
        b.receiveFrom("a~1", () => undefined);
        a.setLocalTrack("video", track("video"));
        a.setSending(true);
        connect(sender);
        connect(receiver);
        sender.tick();
        const encoder = sender.videoEncoders[0];
        const socket = sender.sockets[0];
        const send = (bytes: Uint8Array[], drop: number[] = []) => {
            bytes.forEach((message, i) => {
                if (!drop.includes(i)) receiver.sockets[0].message(relayed("a~1", message));
            });
        };
        const take = () => {
            const messages = socket.binaries();
            socket.sent.length = 0;
            return messages;
        };

        encoder.emit(fakeChunk(new Array(20_000).fill(1), "key", 0));
        send(take());
        expect(receiver.encodedVideoChunks).toHaveLength(1);

        // A delta frame loses its second fragment: it is never decoded, and neither are the deltas after it.
        encoder.emit(fakeChunk(new Array(20_000).fill(2), "delta", 66_000));
        send(take(), [1]);
        encoder.emit(fakeChunk([3], "delta", 132_000));
        send(take());
        expect(receiver.encodedVideoChunks).toHaveLength(1);

        // The next key frame restores it.
        encoder.emit(fakeChunk([4], "key", 198_000));
        send(take());
        encoder.emit(fakeChunk([5], "delta", 264_000));
        send(take());
        expect(receiver.encodedVideoChunks.map((c) => c.type)).toEqual(["key", "key", "delta"]);

        a.close();
        b.close();
    });
});
