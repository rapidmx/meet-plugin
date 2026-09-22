///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";
import { MeshConnectionManager, isOfferer } from "../../../../apps/shared/webrtc/MeshConnectionManager.js";
import type { MeshEvent, RTCPeerConnectionFactory, SignalMessage, SignalingChannel } from "../../../../apps/shared/webrtc/types.js";
import { fakeMediaStream, fakeRTCPeerConnection, fakeTrack } from "../../testUtils.js";

/** A directly-controllable fake channel for single-manager tests: `emit()` injects an incoming message, `sent`
 * records everything the manager under test published. */
function manualChannel(): SignalingChannel & { emit: (message: SignalMessage) => void; sent: SignalMessage[] } {
    const handlers = new Set<(message: SignalMessage) => void>();
    const sent: SignalMessage[] = [];
    return {
        sent,
        send: (message) => sent.push(message),
        onMessage: (handler) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        emit: (message) => {
            for (const handler of [...handlers]) handler(message);
        },
    };
}

/** A small in-memory pub/sub bus wiring several managers' channels together - fans every send out to every
 * registered handler, including the sender's own (matching the real `/push` transport - see
 * `MeshConnectionManager`'s own doc comment on why it filters its own uid at the top of `handleMessage()`). */
function bus() {
    const allHandlers = new Set<(message: SignalMessage) => void>();
    const channel: SignalingChannel = {
        send: (message) => {
            for (const handler of [...allHandlers]) handler(message);
        },
        onMessage: (handler) => {
            allHandlers.add(handler);
            return () => allHandlers.delete(handler);
        },
    };
    // Every participant gets its own channel *view* of the same bus, so a manager's `unsubscribe` only removes
    // its own handler - built once per call to `channel()` below.
    return {
        channel(): SignalingChannel {
            return {
                send: channel.send,
                onMessage: channel.onMessage,
            };
        },
    };
}

function trackingFactory(): { factory: RTCPeerConnectionFactory; created: ReturnType<typeof fakeRTCPeerConnection>[] } {
    const created: ReturnType<typeof fakeRTCPeerConnection>[] = [];
    return {
        created,
        factory: () => {
            const pc = fakeRTCPeerConnection();
            created.push(pc);
            return pc;
        },
    };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

function localStream() {
    return fakeMediaStream([fakeTrack("audio"), fakeTrack("video")]);
}

describe("isOfferer", () => {
    it("is true for the lexicographically smaller uid", () => {
        expect(isOfferer("a", "b")).toBe(true);
        expect(isOfferer("b", "a")).toBe(false);
        expect(isOfferer("a", "a")).toBe(false);
    });
});

describe("MeshConnectionManager - hello/roster", () => {
    it("sends its own hello on start(), and is idempotent", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        manager.start();
        expect(channel.sent).toEqual([{ type: "video-meeting-signal", kind: "hello", from: "a", name: "Alice" }]);
    });

    it("ignores its own broadcast messages", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "a", name: "Alice" });
        expect(manager.participants).toEqual([]);
    });

    it("ignores a targeted message not addressed to it", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "offer", from: "z", to: "someone-else", sdp: { type: "offer", sdp: "x" } });
        expect(manager.participants).toEqual([]);
    });

    it("adds a new peer on hello, emits participant-joined, echoes its own hello, and offers when it is the offerer", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "a", // "a" < "z" - self is the offerer
            selfName: "Alice",
            iceServers: [{ urls: "stun:example.com" }],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.sent.length = 0;
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();

        expect(manager.participants).toEqual([{ uid: "z", name: "Zed" }]);
        expect(events).toContainEqual({ type: "participant-joined", participant: { uid: "z", name: "Zed" } });
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "hello", from: "a", name: "Alice" });
        expect(created).toHaveLength(1);
        expect(created[0].createOffer).toHaveBeenCalledTimes(1);
        expect(created[0].setLocalDescription).toHaveBeenCalledWith({ type: "offer", sdp: "fake-offer-sdp" });
        expect(channel.sent).toContainEqual({
            type: "video-meeting-signal",
            kind: "offer",
            from: "a",
            to: "z",
            sdp: { type: "offer", sdp: "fake-offer-sdp" },
        });
        // The local stream's tracks were attached to the new peer connection.
        expect(created[0].addTrack).toHaveBeenCalledTimes(2);
    });

    it("does not offer when the peer's uid is smaller (they are the offerer)", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "z", // "z" > "a" - the peer is the offerer
            selfName: "Zed",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "a", name: "Alice" });
        await flush();
        expect(created[0].createOffer).not.toHaveBeenCalled();
    });

    it("ignores a duplicate hello from an already-known peer", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "z",
            selfName: "Zed",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "a", name: "Alice" });
        await flush();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "a", name: "Alice" });
        await flush();
        expect(created).toHaveLength(1);
        expect(events.filter((e) => e.type === "participant-joined")).toHaveLength(1);
    });

    it("names an unnamed hello sender by their uid", async () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "z",
            selfName: "Zed",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "a" });
        await flush();
        expect(manager.participants).toEqual([{ uid: "a", name: "a" }]);
    });
});

describe("MeshConnectionManager - offer/answer/ICE", () => {
    it("answers an incoming offer from an unknown peer, emitting participant-joined", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "b",
            selfName: "Bob",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.sent.length = 0;
        channel.emit({ type: "video-meeting-signal", kind: "offer", from: "a", to: "b", sdp: { type: "offer", sdp: "remote-offer" } });
        await flush();

        expect(created[0].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "remote-offer" });
        expect(created[0].createAnswer).toHaveBeenCalledTimes(1);
        expect(channel.sent).toContainEqual({
            type: "video-meeting-signal",
            kind: "answer",
            from: "b",
            to: "a",
            sdp: { type: "answer", sdp: "fake-answer-sdp" },
        });
        expect(events).toContainEqual({ type: "participant-joined", participant: { uid: "a", name: "a" } });
    });

    it("ignores an offer with no sdp", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "b",
            selfName: "Bob",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "offer", from: "a", to: "b" });
        await flush();
        expect(created).toHaveLength(0);
    });

    it("applies an answer to the matching pending offer", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();
        channel.emit({ type: "video-meeting-signal", kind: "answer", from: "z", to: "a", sdp: { type: "answer", sdp: "remote-answer" } });
        await flush();
        expect(created[0].setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "remote-answer" });
    });

    it("ignores an answer with no matching peer, and one with no sdp", async () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        // No peer "z" tracked at all.
        await expect(
            (async () => {
                channel.emit({ type: "video-meeting-signal", kind: "answer", from: "z", to: "a", sdp: { type: "answer", sdp: "x" } });
                await flush();
            })(),
        ).resolves.toBeUndefined();

        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();
        channel.emit({ type: "video-meeting-signal", kind: "answer", from: "z", to: "a" });
        await flush();
        // No throw, and the earlier offer's setRemoteDescription was never (successfully) called with an answer.
    });

    it("buffers an ICE candidate until the remote description is set, then flushes it", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "b",
            selfName: "Bob",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        // The offer hasn't arrived yet - a candidate for "a" arriving first has no peer at all yet, and is dropped.
        channel.emit({ type: "video-meeting-signal", kind: "ice-candidate", from: "a", to: "b", candidate: { candidate: "early" } });
        await flush();

        channel.emit({ type: "video-meeting-signal", kind: "offer", from: "a", to: "b", sdp: { type: "offer", sdp: "o" } });
        // A candidate arriving before the async setRemoteDescription() resolves is buffered, not applied yet.
        channel.emit({ type: "video-meeting-signal", kind: "ice-candidate", from: "a", to: "b", candidate: { candidate: "buffered" } });
        await flush();

        expect(created[0].addIceCandidate).toHaveBeenCalledWith({ candidate: "buffered" });
        expect(created[0].addIceCandidate).not.toHaveBeenCalledWith({ candidate: "early" });
    });

    it("applies an ICE candidate directly once the remote description is already set", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "b",
            selfName: "Bob",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "offer", from: "a", to: "b", sdp: { type: "offer", sdp: "o" } });
        await flush();
        channel.emit({ type: "video-meeting-signal", kind: "ice-candidate", from: "a", to: "b", candidate: { candidate: "late" } });
        await flush();
        expect(created[0].addIceCandidate).toHaveBeenCalledWith({ candidate: "late" });
    });

    it("ignores an ICE candidate with no candidate payload", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "b",
            selfName: "Bob",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "offer", from: "a", to: "b", sdp: { type: "offer", sdp: "o" } });
        await flush();
        channel.emit({ type: "video-meeting-signal", kind: "ice-candidate", from: "a", to: "b" });
        await flush();
        expect(created[0].addIceCandidate).not.toHaveBeenCalled();
    });

    it("publishes locally generated ICE candidates addressed to the right peer", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();
        created[0].onicecandidate!({ candidate: { candidate: "local-candidate" } });
        expect(channel.sent).toContainEqual({
            type: "video-meeting-signal",
            kind: "ice-candidate",
            from: "a",
            to: "z",
            candidate: { candidate: "local-candidate" },
        });
        // The end-of-candidates signal (`candidate: null`) is never published.
        channel.sent.length = 0;
        created[0].onicecandidate!({ candidate: null });
        expect(channel.sent).toEqual([]);
    });

    it("emits a remote-stream event when a track arrives, and ignores a track event with no stream", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();
        const remoteStream = fakeMediaStream([fakeTrack("video")]);
        created[0].ontrack!({ streams: [remoteStream] });
        expect(events).toContainEqual({ type: "remote-stream", uid: "z", stream: remoteStream });

        events.length = 0;
        created[0].ontrack!({ streams: [] });
        expect(events).toEqual([]);
    });

    it("treats a failed/closed connection state as the peer leaving", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();
        created[0].connectionState = "failed";
        created[0].onconnectionstatechange!();
        expect(manager.participants).toEqual([]);
        expect(events).toContainEqual({ type: "participant-left", uid: "z" });

        // A subsequent "connected" transition on an already-removed peer's (stale) handler is a no-op.
        created[0].connectionState = "connected";
        expect(() => created[0].onconnectionstatechange!()).not.toThrow();
    });
});

describe("MeshConnectionManager - bye/stop", () => {
    it("removes the peer and clears presenter status on bye", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();
        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "z" });
        expect(manager.presenterUid).toBe("z");

        channel.emit({ type: "video-meeting-signal", kind: "bye", from: "z" });
        expect(manager.participants).toEqual([]);
        expect(created[0].close).toHaveBeenCalledTimes(1);
        expect(events).toContainEqual({ type: "participant-left", uid: "z" });
        expect(manager.presenterUid).toBeUndefined();
        expect(events).toContainEqual({ type: "presenter-changed", uid: undefined });
    });

    it("ignores a bye from an unknown peer", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        expect(() => channel.emit({ type: "video-meeting-signal", kind: "bye", from: "nobody" })).not.toThrow();
    });

    it("sends bye, closes every connection, unsubscribes and clears listeners on stop() - only if started", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        // stop() before start() never sent.
        manager.stop();
        expect(channel.sent).toEqual([]);

        const manager2 = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager2.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();
        channel.sent.length = 0;
        manager2.stop();
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "bye", from: "a" });
        expect(created[0].close).toHaveBeenCalledTimes(1);
        expect(manager2.participants).toEqual([]);
        // Idempotent.
        manager2.stop();
        expect(channel.sent.filter((m) => m.kind === "bye")).toHaveLength(1);
    });
});

describe("MeshConnectionManager - presenter (single-writer)", () => {
    it("claims presenter status when free, and refuses when someone else already presents", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        expect(manager.claimPresenter()).toBe(true);
        expect(manager.presenterUid).toBe("a");
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-claim", from: "a" });
        expect(events).toContainEqual({ type: "presenter-changed", uid: "a" });

        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "y" });
        // "y" > "a" (self already presenting) - self keeps presenting, per the collision rule.
        expect(manager.presenterUid).toBe("a");

        const manager2Channel = manualChannel();
        const manager2 = new MeshConnectionManager({
            selfUid: "b",
            selfName: "Bob",
            iceServers: [],
            channel: manager2Channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager2.start();
        manager2Channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "other" });
        expect(manager2.claimPresenter()).toBe(false);
    });

    it("releases presenter status, and is a no-op when not presenting", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.sent.length = 0;
        manager.releasePresenter();
        expect(channel.sent).toEqual([]);

        manager.claimPresenter();
        channel.sent.length = 0;
        events.length = 0;
        manager.releasePresenter();
        expect(manager.presenterUid).toBeUndefined();
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-release", from: "a" });
        expect(events).toContainEqual({ type: "presenter-changed", uid: undefined });
    });

    it("resolves a genuine claim collision deterministically - the smaller uid wins, and the loser self-revokes", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "b",
            selfName: "Bob",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        // Self optimistically claims first...
        manager.claimPresenter();
        expect(manager.presenterUid).toBe("b");
        channel.sent.length = 0;
        // ...but a remote claim from a smaller uid arrives (a genuine race) - self loses and must self-revoke.
        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "a" });
        expect(manager.presenterUid).toBe("a");
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-release", from: "b" });
    });

    it("resolves a collision between two other participants as a silent bystander (no message sent)", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "m",
            selfName: "Mallory",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.sent.length = 0;
        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "z" });
        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "a" });
        expect(manager.presenterUid).toBe("a");
        // The bystander observes the winner change but never sends anything - it was never the loser.
        expect(channel.sent).toEqual([]);
        expect(events).toContainEqual({ type: "presenter-changed", uid: "a" });
    });

    it("ignores a duplicate claim from the already-recorded presenter", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "z" });
        manager.onEvent((e) => events.push(e));
        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "z" });
        expect(manager.presenterUid).toBe("z");
        expect(events).toEqual([]);
    });

    it("clears presenter status when the current presenter's own release message arrives", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const events: MeshEvent[] = [];
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.onEvent((e) => events.push(e));
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "z" });
        channel.emit({ type: "video-meeting-signal", kind: "presenter-release", from: "z" });
        expect(manager.presenterUid).toBeUndefined();
        expect(events).toContainEqual({ type: "presenter-changed", uid: undefined });
    });

    it("ignores a presenter-release that doesn't match the current presenter", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "z" });
        channel.emit({ type: "video-meeting-signal", kind: "presenter-release", from: "someone-else" });
        expect(manager.presenterUid).toBe("z");
    });
});

describe("MeshConnectionManager - replaceLocalVideoTrack", () => {
    it("replaces the outgoing video track on every peer connection", async () => {
        const channel = manualChannel();
        const { factory, created } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        channel.emit({ type: "video-meeting-signal", kind: "hello", from: "z", name: "Zed" });
        await flush();
        const screenTrack = fakeTrack("video", "screen");
        manager.replaceLocalVideoTrack(screenTrack);
        const videoSender = created[0].getSenders().find((s) => s.track?.kind === "video");
        expect(videoSender!.replaceTrack).toHaveBeenCalledWith(screenTrack);
    });

    it("does nothing when there are no peers yet", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        manager.start();
        expect(() => manager.replaceLocalVideoTrack(null)).not.toThrow();
    });
});

describe("MeshConnectionManager - onEvent", () => {
    it("stops delivering events once unsubscribed", () => {
        const channel = manualChannel();
        const { factory } = trackingFactory();
        const manager = new MeshConnectionManager({
            selfUid: "a",
            selfName: "Alice",
            iceServers: [],
            channel,
            createPeerConnection: factory,
            localStream: localStream(),
        });
        const events: MeshEvent[] = [];
        const unsubscribe = manager.onEvent((e) => events.push(e));
        manager.start();
        unsubscribe();
        manager.claimPresenter();
        expect(events).toEqual([]);
    });
});

describe("MeshConnectionManager - two real instances converging", () => {
    it("discovers each other regardless of join order and completes the offer/answer exchange both ways", async () => {
        const b = bus();
        const { factory: factoryA, created: createdA } = trackingFactory();
        const { factory: factoryB, created: createdB } = trackingFactory();
        const managerA = new MeshConnectionManager({
            selfUid: "a", // smaller uid - offerer toward "z"
            selfName: "Alice",
            iceServers: [],
            channel: b.channel(),
            createPeerConnection: factoryA,
            localStream: localStream(),
        });
        const managerZ = new MeshConnectionManager({
            selfUid: "z",
            selfName: "Zed",
            iceServers: [],
            channel: b.channel(),
            createPeerConnection: factoryB,
            localStream: localStream(),
        });

        // "a" joins first (so "z"'s original hello, sent later, is the only one "a" ever needed to hear directly -
        // "z" only learns of "a" via the echo "a" sends upon discovering "z", exercising the roster-discovery
        // mechanism this module's doc comment describes).
        managerA.start();
        managerZ.start();
        await flush();

        expect(managerA.participants).toEqual([{ uid: "z", name: "Zed" }]);
        expect(managerZ.participants).toEqual([{ uid: "a", name: "Alice" }]);
        expect(createdA[0].setLocalDescription).toHaveBeenCalledWith({ type: "offer", sdp: "fake-offer-sdp" });
        expect(createdB[0].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "fake-offer-sdp" });
        expect(createdB[0].setLocalDescription).toHaveBeenCalledWith({ type: "answer", sdp: "fake-answer-sdp" });
        expect(createdA[0].setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "fake-answer-sdp" });
    });
});
