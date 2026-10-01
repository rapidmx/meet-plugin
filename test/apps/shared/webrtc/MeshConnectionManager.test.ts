///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_CONNECT_TIMEOUT_MS,
    DEFAULT_DIAGNOSTICS_POLL_MS,
    DEFAULT_DISCONNECTED_GRACE_MS,
    MeshConnectionManager,
    type MeshConnectionManagerOptions,
    isOfferer,
} from "../../../../apps/shared/webrtc/MeshConnectionManager.js";
import { type MeshEvent, REACTION_EMOJIS, type RelayTransportLike, type SignalMessage, type SignalingChannel } from "../../../../apps/shared/webrtc/types.js";
import { type FakeRTCPeerConnection, fakeMediaStream, fakeRTCPeerConnection, fakeTrack } from "../../testUtils.js";

/** A directly-controllable fake channel for single-manager tests: `emit()` injects an incoming message, `sent`
 * records everything the manager under test published. */
function manualChannel(): SignalingChannel & { emit: (message: SignalMessage) => void; sent: SignalMessage[] } {
    const handlers = new Set<(message: SignalMessage) => void>();
    const sent: SignalMessage[] = [];
    return {
        sent,
        // `peer` defaults to `from`, so it is only kept where a test gave the manager a distinct peer id.
        send: (message) => sent.push(message.peer === message.from ? { ...message, peer: undefined } : message),
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
    return {
        channel(): SignalingChannel {
            return {
                send: (message) => {
                    for (const handler of [...allHandlers]) handler(message);
                },
                onMessage: (handler) => {
                    allHandlers.add(handler);
                    return () => allHandlers.delete(handler);
                },
            };
        },
    };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

/** A manager for `selfUid` (default "a") on a manual channel, with a fake peer connection factory recording every
 * connection it makes and every event it emits. */
function setup(overrides: Partial<MeshConnectionManagerOptions> = {}) {
    const channel = manualChannel();
    const created: FakeRTCPeerConnection[] = [];
    const events: MeshEvent[] = [];
    const audio = fakeTrack("audio", "local-audio");
    const video = fakeTrack("video", "local-video");
    const manager = new MeshConnectionManager({
        selfUid: "a",
        selfName: "Alice",
        iceServers: [],
        channel,
        createPeerConnection: () => {
            const pc = fakeRTCPeerConnection();
            created.push(pc);
            return pc;
        },
        createMediaStream: () => fakeMediaStream(),
        localAudioTrack: audio,
        localVideoTrack: video,
        ...overrides,
    });
    manager.onEvent((e) => events.push(e));
    return { manager, channel, created, events, audio, video };
}

const hello = (from: string, name?: string, state?: SignalMessage["state"]): SignalMessage => ({
    type: "video-meeting-signal",
    kind: "hello",
    from,
    ...(name ? { name } : {}),
    ...(state ? { state } : {}),
});
const signal = (kind: SignalMessage["kind"], from: string, rest: Partial<SignalMessage> = {}): SignalMessage => ({
    type: "video-meeting-signal",
    kind,
    from,
    ...rest,
});
const offer = (from: string, to: string): SignalMessage => signal("offer", from, { to, sdp: { type: "offer", sdp: "remote-offer" } });
const STATE = { audioOn: true, videoOn: true, handRaised: false };
/** What every participant reports until its connection is up (or given up on). */
const CONNECTING = { transport: "connecting" } as const;

describe("MeshConnectionManager - peer ids", () => {
    it("publishes as the authenticated uid and names its own tab in 'peer'", async () => {
        const { manager, channel } = setup({ selfUid: "user-1", peerId: "user-1~abc" });
        manager.start();
        channel.emit(hello("z", "Zed"));
        await flush();
        expect(channel.sent.length).toBeGreaterThan(1);
        for (const message of channel.sent) {
            expect(message).toMatchObject({ from: "user-1", peer: "user-1~abc" });
        }
    });

    it("identifies a sender by its peer, so two tabs of one account are two participants that see each other", async () => {
        const { manager, channel, events } = setup({ selfUid: "user-1", peerId: "user-1~aaa" });
        manager.start();
        // Its own messages (same peer) are ignored, but the same account's other tab is a participant.
        channel.emit({ ...hello("user-1", "Me"), peer: "user-1~aaa" });
        expect(manager.participants).toEqual([]);
        channel.emit({ ...hello("user-1", "Me on my phone", STATE), peer: "user-1~bbb" });
        await flush();
        expect(manager.participants).toEqual([{ uid: "user-1~bbb", name: "Me on my phone", ...STATE, ...CONNECTING }]);
        expect(events).toContainEqual({ type: "participant-joined", participant: { uid: "user-1~bbb", name: "Me on my phone", ...STATE, ...CONNECTING } });
        // Point-to-point messages address the peer, not the account.
        expect(channel.sent).toContainEqual(expect.objectContaining({ kind: "offer", to: "user-1~bbb" }));
    });

    it("only answers messages addressed to its own peer id", async () => {
        const { manager, channel } = setup({ selfUid: "user-1", peerId: "user-1~aaa" });
        manager.start();
        channel.emit({ ...signal("offer", "z", { to: "user-1", sdp: { type: "offer", sdp: "x" } }) });
        channel.emit({ ...signal("offer", "z", { to: "user-1~bbb", sdp: { type: "offer", sdp: "x" } }) });
        await flush();
        expect(manager.participants).toEqual([]);
        channel.emit({ ...signal("offer", "z", { to: "user-1~aaa", sdp: { type: "offer", sdp: "x" } }) });
        await flush();
        expect(manager.participants).toHaveLength(1);
    });

    it("ignores a peer id that doesn't belong to the sender's verified uid", () => {
        const { manager, channel } = setup();
        manager.start();
        channel.emit({ ...hello("mallory", "Mallory"), peer: "victim~1" });
        channel.emit({ ...hello("mallory", "Mallory"), peer: "mallory-x~1" });
        expect(manager.participants).toEqual([]);
        channel.emit({ ...hello("mallory", "Mallory"), peer: "mallory~1" });
        expect(manager.participants).toHaveLength(1);
        expect(manager.participants[0].uid).toBe("mallory~1");
    });
});

describe("isOfferer", () => {
    it("is true for the lexicographically smaller uid", () => {
        expect(isOfferer("a", "b")).toBe(true);
        expect(isOfferer("b", "a")).toBe(false);
        expect(isOfferer("a", "a")).toBe(false);
    });
});

describe("MeshConnectionManager - hello/roster", () => {
    it("announces its name and state on start(), and is idempotent", () => {
        const { manager, channel } = setup();
        manager.start();
        manager.start();
        expect(channel.sent).toEqual([{ type: "video-meeting-signal", kind: "hello", from: "a", name: "Alice", state: STATE }]);
    });

    it("announces no audio or video when it has no tracks, unless told otherwise", () => {
        const none = setup({ localAudioTrack: null, localVideoTrack: undefined });
        none.manager.start();
        expect(none.channel.sent[0].state).toEqual({ audioOn: false, videoOn: false, handRaised: false });

        const muted = setup({ localState: { audioOn: false } });
        muted.manager.start();
        expect(muted.channel.sent[0].state).toEqual({ audioOn: false, videoOn: true, handRaised: false });
    });

    it("ignores its own broadcast messages", () => {
        const { manager, channel } = setup();
        manager.start();
        channel.emit(hello("a", "Alice"));
        expect(manager.participants).toEqual([]);
    });

    it("ignores messages that aren't video-meeting signals", () => {
        const { manager, channel } = setup();
        manager.start();
        channel.emit({ ...hello("z", "Zed"), type: "something-else" } as unknown as SignalMessage);
        expect(manager.participants).toEqual([]);
    });

    it("ignores a targeted message not addressed to it", () => {
        const { manager, channel } = setup();
        manager.start();
        channel.emit(signal("offer", "z", { to: "someone-else", sdp: { type: "offer", sdp: "x" } }));
        expect(manager.participants).toEqual([]);
    });

    it("adds a new peer on hello, echoes its own hello, and - as the offerer - gives the connection both transceivers and offers", async () => {
        const { manager, channel, created, events, audio, video } = setup({ iceServers: [{ urls: "stun:example.com" }] });
        manager.start();
        channel.sent.length = 0;
        channel.emit(hello("z", "Zed", { audioOn: true, videoOn: false, handRaised: false })); // "a" < "z" - self is the offerer
        await flush();

        const zed = { uid: "z", name: "Zed", audioOn: true, videoOn: false, handRaised: false, ...CONNECTING };
        expect(manager.participants).toEqual([zed]);
        expect(events).toContainEqual({ type: "participant-joined", participant: zed });
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "hello", from: "a", name: "Alice", state: STATE });
        expect(created).toHaveLength(1);
        // Both transceivers, sending whatever the local participant has.
        expect(created[0].addTransceiver).toHaveBeenCalledWith("audio", audio);
        expect(created[0].addTransceiver).toHaveBeenCalledWith("video", video);
        expect(created[0].createOffer).toHaveBeenCalledTimes(1);
        expect(created[0].setLocalDescription).toHaveBeenCalledWith({ type: "offer", sdp: "fake-offer-sdp" });
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "offer", from: "a", to: "z", sdp: { type: "offer", sdp: "fake-offer-sdp" } });
    });

    it("still adds both transceivers when it has nothing to send", async () => {
        const { manager, channel, created } = setup({ localAudioTrack: null, localVideoTrack: null });
        manager.start();
        channel.emit(hello("z", "Zed"));
        await flush();
        expect(created[0].addTransceiver).toHaveBeenCalledWith("audio", null);
        expect(created[0].addTransceiver).toHaveBeenCalledWith("video", null);
    });

    it("does not offer, or add transceivers, when the peer's uid is smaller (they are the offerer)", async () => {
        const { manager, channel, created } = setup({ selfUid: "z", selfName: "Zed" });
        manager.start();
        channel.emit(hello("a", "Alice"));
        await flush();
        expect(created[0].createOffer).not.toHaveBeenCalled();
        expect(created[0].addTransceiver).not.toHaveBeenCalled();
    });

    it("ignores a duplicate hello from an already-known peer", async () => {
        const { manager, channel, created, events } = setup({ selfUid: "z", selfName: "Zed" });
        manager.start();
        channel.emit(hello("a", "Alice", STATE));
        await flush();
        channel.emit(hello("a", "Alice", STATE));
        await flush();
        expect(created).toHaveLength(1);
        expect(events.filter((e) => e.type === "participant-joined")).toHaveLength(1);
        expect(events.filter((e) => e.type === "participant-updated")).toEqual([]);
    });

    it("names an unnamed hello sender by their uid", async () => {
        const { manager, channel } = setup({ selfUid: "z", selfName: "Zed" });
        manager.start();
        channel.emit(hello("a"));
        await flush();
        expect(manager.participants).toEqual([{ uid: "a", name: "a", audioOn: false, videoOn: false, handRaised: false, ...CONNECTING }]);
    });

    it("fills in the real name and state when a hello arrives after the offer that created the peer", async () => {
        const { manager, channel, events } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(offer("a", "b"));
        await flush();
        expect(manager.participants[0].name).toBe("a");

        channel.sent.length = 0;
        channel.emit(hello("a", "Alice", STATE));
        expect(manager.participants).toEqual([{ uid: "a", name: "Alice", ...STATE, ...CONNECTING }]);
        expect(events).toContainEqual({ type: "participant-updated", participant: { uid: "a", name: "Alice", ...STATE, ...CONNECTING } });
        // Not a new peer: no second echo, no second connection.
        expect(channel.sent).toEqual([]);
    });

    it("takes a new name from a later hello that carries no state, keeping the state it has", async () => {
        const { manager, channel } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(hello("a", "Alice", STATE));
        await flush();
        channel.emit(hello("a", "Alicia"));
        expect(manager.participants[0]).toMatchObject({ name: "Alicia", ...STATE });
    });

    it("keeps the name it has when a later hello carries none", async () => {
        const { manager, channel } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(hello("a", "Alice", STATE));
        await flush();
        channel.emit(hello("a", undefined, { ...STATE, videoOn: false }));
        expect(manager.participants[0]).toMatchObject({ name: "Alice", videoOn: false });
    });

    it("coerces a received state to booleans", async () => {
        const { manager, channel } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(hello("a", "Alice", { audioOn: "yes", videoOn: 1, handRaised: null } as unknown as SignalMessage["state"]));
        expect(manager.participants[0]).toMatchObject({ audioOn: false, videoOn: false, handRaised: false });
    });
});

describe("MeshConnectionManager - offer/answer/ICE", () => {
    it("answers an incoming offer from an unknown peer, claiming the offer's transceivers and sending its tracks on them", async () => {
        const { manager, channel, created, events, audio, video } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.sent.length = 0;
        channel.emit(offer("a", "b"));
        await flush();

        expect(created[0].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "remote-offer" });
        // The answerer added no transceivers of its own - it took the ones the offer created.
        expect(created[0].addTransceiver).not.toHaveBeenCalled();
        expect(created[0].claimTransceivers).toHaveBeenCalledTimes(1);
        expect(created[0].senders.audio!.replaceTrack).toHaveBeenCalledWith(audio);
        expect(created[0].senders.video!.replaceTrack).toHaveBeenCalledWith(video);
        expect(created[0].createAnswer).toHaveBeenCalledTimes(1);
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "answer", from: "b", to: "a", sdp: { type: "answer", sdp: "fake-answer-sdp" } });
        expect(events).toContainEqual({ type: "participant-joined", participant: { uid: "a", name: "a", audioOn: false, videoOn: false, handRaised: false, ...CONNECTING } });
        // It also introduces itself, since the offer may have beaten its own hello.
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "hello", from: "b", name: "Bob", state: STATE });
    });

    it("claims the transceivers only once for a peer, and sends nothing for a track it doesn't have", async () => {
        const { manager, channel, created } = setup({ selfUid: "z", selfName: "Zed", localAudioTrack: null, localVideoTrack: null });
        manager.start();
        channel.emit(hello("a", "Alice"));
        await flush();
        channel.emit(offer("a", "z"));
        await flush();
        channel.emit(offer("a", "z"));
        await flush();
        expect(created[0].claimTransceivers).toHaveBeenCalledTimes(1);
        expect(created[0].senders.audio!.replaceTrack).not.toHaveBeenCalled();
        expect(created[0].senders.video!.replaceTrack).not.toHaveBeenCalled();
    });

    it("copes with an offer that lacks a kind it would send", async () => {
        let pc!: FakeRTCPeerConnection;
        const { manager, channel } = setup({
            selfUid: "z",
            selfName: "Zed",
            createPeerConnection: () => (pc = fakeRTCPeerConnection(["audio"])),
        });
        manager.start();
        channel.emit(offer("a", "z"));
        await flush();
        expect(pc.senders.audio!.replaceTrack).toHaveBeenCalled();
        expect(pc.senders.video).toBeUndefined();
        expect(channel.sent.map((m) => m.kind)).toContain("answer");
    });

    it("ignores an offer with no sdp", async () => {
        const { manager, channel, created } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(signal("offer", "a", { to: "b" }));
        await flush();
        expect(created).toHaveLength(0);
    });

    it("applies an answer to the matching pending offer", async () => {
        const { manager, channel, created } = setup();
        manager.start();
        channel.emit(hello("z", "Zed"));
        await flush();
        channel.emit(signal("answer", "z", { to: "a", sdp: { type: "answer", sdp: "remote-answer" } }));
        await flush();
        expect(created[0].setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "remote-answer" });
    });

    it("ignores an answer with no matching peer, and one with no sdp", async () => {
        const { manager, channel, created } = setup();
        manager.start();
        channel.emit(signal("answer", "z", { to: "a", sdp: { type: "answer", sdp: "x" } }));
        await flush();
        channel.emit(hello("z", "Zed"));
        await flush();
        channel.emit(signal("answer", "z", { to: "a" }));
        await flush();
        expect(created[0].setRemoteDescription).not.toHaveBeenCalled();
    });

    it("buffers an ICE candidate until the remote description is set, then flushes it", async () => {
        const { manager, channel, created } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(offer("a", "b"));
        // Arrives before the async setRemoteDescription() resolves: buffered, not applied yet.
        channel.emit(signal("ice-candidate", "a", { to: "b", candidate: { candidate: "buffered" } }));
        expect(created[0].addIceCandidate).not.toHaveBeenCalled();
        await flush();
        expect(created[0].addIceCandidate).toHaveBeenCalledWith({ candidate: "buffered" });
    });

    it("holds a candidate that beats its own offer, and applies it once the peer exists", async () => {
        const { manager, channel, created } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(signal("ice-candidate", "a", { to: "b", candidate: { candidate: "early-1" } }));
        channel.emit(signal("ice-candidate", "a", { to: "b", candidate: { candidate: "early-2" } }));
        await flush();
        expect(created).toHaveLength(0);

        channel.emit(offer("a", "b"));
        await flush();
        expect(created[0].addIceCandidate).toHaveBeenCalledWith({ candidate: "early-1" });
        expect(created[0].addIceCandidate).toHaveBeenCalledWith({ candidate: "early-2" });
    });

    it("bounds what it holds for peers that never appear", async () => {
        const { manager, channel, created } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        for (let i = 0; i < 70; i++) {
            channel.emit(signal("ice-candidate", "a", { to: "b", candidate: { candidate: `c${i}` } }));
        }
        for (let i = 0; i < 40; i++) {
            channel.emit(signal("ice-candidate", `ghost-${i}`, { to: "b", candidate: { candidate: "x" } }));
        }
        await flush();

        channel.emit(offer("a", "b"));
        await flush();
        expect(created[0].addIceCandidate).toHaveBeenCalledTimes(64);
        expect(created[0].addIceCandidate).not.toHaveBeenCalledWith({ candidate: "c64" });

        // The 33rd distinct stranger was never held (32 peers' worth, "a" plus 31 ghosts, were).
        channel.emit(offer("ghost-39", "b"));
        await flush();
        expect(created[1].addIceCandidate).not.toHaveBeenCalled();
        channel.emit(offer("ghost-0", "b"));
        await flush();
        expect(created[2].addIceCandidate).toHaveBeenCalledWith({ candidate: "x" });
    });

    it("forgets what it held for a peer that says goodbye", async () => {
        const { manager, channel, created } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(signal("ice-candidate", "a", { to: "b", candidate: { candidate: "stale" } }));
        channel.emit(signal("bye", "a"));
        channel.emit(offer("a", "b"));
        await flush();
        expect(created[0].addIceCandidate).not.toHaveBeenCalled();
    });

    it("applies an ICE candidate directly once the remote description is already set", async () => {
        const { manager, channel, created } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(offer("a", "b"));
        await flush();
        channel.emit(signal("ice-candidate", "a", { to: "b", candidate: { candidate: "late" } }));
        await flush();
        expect(created[0].addIceCandidate).toHaveBeenCalledWith({ candidate: "late" });
    });

    it("ignores an ICE candidate with no candidate payload", async () => {
        const { manager, channel, created } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        channel.emit(offer("a", "b"));
        await flush();
        channel.emit(signal("ice-candidate", "a", { to: "b" }));
        await flush();
        expect(created[0].addIceCandidate).not.toHaveBeenCalled();
    });

    it("publishes locally generated ICE candidates addressed to the right peer", async () => {
        const { manager, channel, created } = setup();
        manager.start();
        channel.emit(hello("z", "Zed"));
        await flush();
        created[0].onicecandidate!({ candidate: { candidate: "local-candidate" } });
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "ice-candidate", from: "a", to: "z", candidate: { candidate: "local-candidate" } });
        // The end-of-candidates signal (`candidate: null`) is never published.
        channel.sent.length = 0;
        created[0].onicecandidate!({ candidate: null });
        expect(channel.sent).toEqual([]);
    });

    it("gathers a peer's incoming tracks into one stream, announcing it as each track arrives", async () => {
        const { manager, channel, created, events } = setup();
        manager.start();
        channel.emit(hello("z", "Zed"));
        await flush();
        const remoteAudio = fakeTrack("audio");
        const remoteVideo = fakeTrack("video");
        created[0].ontrack!({ track: remoteAudio });
        created[0].ontrack!({ track: remoteVideo });
        // A repeat of a track already in the stream adds nothing.
        created[0].ontrack!({ track: remoteVideo });

        const streamEvents = events.filter((e) => e.type === "remote-stream");
        expect(streamEvents).toHaveLength(3);
        const stream = streamEvents[0].stream;
        expect(streamEvents[2].stream).toBe(stream);
        expect(stream.getTracks()).toEqual([remoteAudio, remoteVideo]);
    });

    it("builds the per-peer stream with the browser's own MediaStream by default", async () => {
        const seen: unknown[] = [];
        class FakeStream {
            tracks: MediaStreamTrack[] = [];
            constructor() {
                seen.push(this);
            }
            getTracks() {
                return this.tracks;
            }
            addTrack(track: MediaStreamTrack) {
                this.tracks.push(track);
            }
        }
        const original = globalThis.MediaStream;
        globalThis.MediaStream = FakeStream as unknown as typeof MediaStream;
        try {
            const { manager, channel } = setup({ createMediaStream: undefined });
            manager.start();
            channel.emit(hello("z", "Zed"));
            await flush();
            expect(seen).toHaveLength(1);
        } finally {
            globalThis.MediaStream = original;
        }
    });

    it("treats a closed connection state as the peer leaving", async () => {
        const { manager, channel, created, events } = setup();
        manager.start();
        channel.emit(hello("z", "Zed"));
        await flush();
        created[0].connectionState = "closed";
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
        const { manager, channel, created, events } = setup();
        manager.start();
        channel.emit(hello("z", "Zed"));
        await flush();
        channel.emit(signal("presenter-claim", "z"));
        expect(manager.presenterUid).toBe("z");

        channel.emit(signal("bye", "z"));
        expect(manager.participants).toEqual([]);
        expect(created[0].close).toHaveBeenCalledTimes(1);
        expect(events).toContainEqual({ type: "participant-left", uid: "z" });
        expect(manager.presenterUid).toBeUndefined();
        expect(events).toContainEqual({ type: "presenter-changed", uid: undefined });
    });

    it("ignores a bye from an unknown peer", () => {
        const { manager, channel } = setup();
        manager.start();
        expect(() => channel.emit(signal("bye", "nobody"))).not.toThrow();
    });

    it("sends bye, closes every connection, unsubscribes and clears listeners on stop() - only if started", async () => {
        const never = setup();
        // stop() before start() never sent.
        never.manager.stop();
        expect(never.channel.sent).toEqual([]);

        const { manager, channel, created } = setup();
        manager.start();
        channel.emit(hello("z", "Zed"));
        await flush();
        channel.sent.length = 0;
        manager.stop();
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "bye", from: "a" });
        expect(created[0].close).toHaveBeenCalledTimes(1);
        expect(manager.participants).toEqual([]);
        // Idempotent.
        manager.stop();
        expect(channel.sent.filter((m) => m.kind === "bye")).toHaveLength(1);
    });
});

describe("MeshConnectionManager - local tracks and state", () => {
    it("swaps a track on every connection's sender, and remembers it for peers that join later", async () => {
        const { manager, channel, created } = setup();
        manager.start();
        channel.emit(hello("y", "Yan")); // offerer: senders exist at once
        await flush();
        const screen = fakeTrack("video", "screen");
        manager.setLocalTrack("video", screen);
        expect(created[0].senders.video!.replaceTrack).toHaveBeenCalledWith(screen);

        manager.setLocalTrack("audio", null);
        expect(created[0].senders.audio!.replaceTrack).toHaveBeenCalledWith(null);

        channel.emit(hello("z", "Zed"));
        await flush();
        expect(created[1].addTransceiver).toHaveBeenCalledWith("video", screen);
        expect(created[1].addTransceiver).toHaveBeenCalledWith("audio", null);
    });

    it("has nothing to swap on an answerer's connection until its offer arrives, then sends the latest track", async () => {
        const { manager, channel, created } = setup({ selfUid: "z", selfName: "Zed" });
        manager.start();
        channel.emit(hello("a", "Alice"));
        await flush();
        const later = fakeTrack("video", "later");
        expect(() => manager.setLocalTrack("video", later)).not.toThrow();

        channel.emit(offer("a", "z"));
        await flush();
        expect(created[0].senders.video!.replaceTrack).toHaveBeenCalledWith(later);
    });

    it("does nothing when there are no peers yet", () => {
        const { manager } = setup();
        manager.start();
        expect(() => manager.setLocalTrack("video", null)).not.toThrow();
    });

    it("tells everyone when its state changes, and only when it does", () => {
        const { manager, channel } = setup();
        manager.start();
        channel.sent.length = 0;
        manager.setLocalState({ audioOn: false });
        expect(channel.sent).toEqual([{ type: "video-meeting-signal", kind: "state", from: "a", state: { audioOn: false, videoOn: true, handRaised: false } }]);
        channel.sent.length = 0;
        manager.setLocalState({ audioOn: false });
        manager.setLocalState({});
        expect(channel.sent).toEqual([]);
    });

    it("only records a state change made before start() or after stop(), which hello then carries", () => {
        const { manager, channel } = setup();
        manager.setLocalState({ handRaised: true });
        expect(channel.sent).toEqual([]);
        manager.start();
        expect(channel.sent[0].state).toEqual({ audioOn: true, videoOn: true, handRaised: true });
        manager.stop();
        channel.sent.length = 0;
        manager.setLocalState({ handRaised: false });
        expect(channel.sent).toEqual([]);
    });

    it("applies a peer's state message, announcing a raised hand once", async () => {
        const { manager, channel, events } = setup();
        manager.start();
        channel.emit(hello("z", "Zed", STATE));
        await flush();
        events.length = 0;

        channel.emit(signal("state", "z", { state: { audioOn: false, videoOn: true, handRaised: true } }));
        expect(manager.participants[0]).toMatchObject({ audioOn: false, handRaised: true });
        expect(events).toEqual([
            { type: "participant-updated", participant: { uid: "z", name: "Zed", audioOn: false, videoOn: true, handRaised: true, ...CONNECTING } },
            { type: "hand-raised", uid: "z", name: "Zed" },
        ]);

        // Still up: an update for another field is not a new raise.
        events.length = 0;
        channel.emit(signal("state", "z", { state: { audioOn: true, videoOn: true, handRaised: true } }));
        expect(events.map((e) => e.type)).toEqual(["participant-updated"]);

        // Lowering it announces nothing extra, and an unchanged state announces nothing at all.
        events.length = 0;
        channel.emit(signal("state", "z", { state: { audioOn: true, videoOn: true, handRaised: false } }));
        channel.emit(signal("state", "z", { state: { audioOn: true, videoOn: true, handRaised: false } }));
        expect(events.map((e) => e.type)).toEqual(["participant-updated"]);
    });

    it("ignores a state message from a stranger, or with no state", async () => {
        const { manager, channel, events } = setup();
        manager.start();
        channel.emit(signal("state", "stranger", { state: STATE }));
        channel.emit(hello("z", "Zed", STATE));
        await flush();
        events.length = 0;
        channel.emit(signal("state", "z"));
        expect(events).toEqual([]);
    });
});

describe("MeshConnectionManager - reactions", () => {
    it("sends a reaction from the palette, and refuses anything else", () => {
        const { manager, channel } = setup();
        manager.start();
        channel.sent.length = 0;
        expect(manager.sendReaction(REACTION_EMOJIS[0])).toBe(true);
        expect(channel.sent).toEqual([{ type: "video-meeting-signal", kind: "reaction", from: "a", emoji: REACTION_EMOJIS[0] }]);
        channel.sent.length = 0;
        expect(manager.sendReaction("not an emoji")).toBe(false);
        expect(channel.sent).toEqual([]);
    });

    it("announces a peer's reaction with their name, ignoring strangers and anything outside the palette", async () => {
        const { manager, channel, events } = setup();
        manager.start();
        channel.emit(hello("z", "Zed", STATE));
        await flush();
        events.length = 0;

        channel.emit(signal("reaction", "z", { emoji: REACTION_EMOJIS[3] }));
        expect(events).toEqual([{ type: "reaction", uid: "z", name: "Zed", emoji: REACTION_EMOJIS[3] }]);
        events.length = 0;
        channel.emit(signal("reaction", "z", { emoji: "<script>" }));
        channel.emit(signal("reaction", "z"));
        channel.emit(signal("reaction", "stranger", { emoji: REACTION_EMOJIS[0] }));
        expect(events).toEqual([]);
    });
});

describe("MeshConnectionManager - presenter (single-writer)", () => {
    it("claims presenter status when free, and refuses when someone else already presents", () => {
        const { manager, channel, events } = setup();
        manager.start();
        expect(manager.claimPresenter()).toBe(true);
        expect(manager.presenterUid).toBe("a");
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-claim", from: "a" });
        expect(events).toContainEqual({ type: "presenter-changed", uid: "a" });

        channel.emit(signal("presenter-claim", "y"));
        // "y" > "a" (self already presenting) - self keeps presenting, per the collision rule.
        expect(manager.presenterUid).toBe("a");

        const other = setup({ selfUid: "b", selfName: "Bob" });
        other.manager.start();
        other.channel.emit(signal("presenter-claim", "other"));
        expect(other.manager.claimPresenter()).toBe(false);
    });

    it("releases presenter status, and is a no-op when not presenting", () => {
        const { manager, channel, events } = setup();
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
        const { manager, channel } = setup({ selfUid: "b", selfName: "Bob" });
        manager.start();
        // Self optimistically claims first...
        manager.claimPresenter();
        expect(manager.presenterUid).toBe("b");
        channel.sent.length = 0;
        // ...but a remote claim from a smaller uid arrives (a genuine race) - self loses and must self-revoke.
        channel.emit(signal("presenter-claim", "a"));
        expect(manager.presenterUid).toBe("a");
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-release", from: "b" });
    });

    it("resolves a collision between two other participants as a silent bystander (no message sent)", () => {
        const { manager, channel, events } = setup({ selfUid: "m", selfName: "Mallory" });
        manager.start();
        channel.sent.length = 0;
        channel.emit(signal("presenter-claim", "z"));
        channel.emit(signal("presenter-claim", "a"));
        expect(manager.presenterUid).toBe("a");
        // The bystander observes the winner change but never sends anything - it was never the loser.
        expect(channel.sent).toEqual([]);
        expect(events).toContainEqual({ type: "presenter-changed", uid: "a" });
    });

    it("ignores a duplicate claim from the already-recorded presenter", () => {
        const { manager, channel, events } = setup();
        manager.start();
        channel.emit(signal("presenter-claim", "z"));
        events.length = 0;
        channel.emit(signal("presenter-claim", "z"));
        expect(manager.presenterUid).toBe("z");
        expect(events).toEqual([]);
    });

    it("clears presenter status when the current presenter's own release message arrives", () => {
        const { manager, channel, events } = setup();
        manager.start();
        channel.emit(signal("presenter-claim", "z"));
        channel.emit(signal("presenter-release", "z"));
        expect(manager.presenterUid).toBeUndefined();
        expect(events).toContainEqual({ type: "presenter-changed", uid: undefined });
    });

    it("ignores a presenter-release that doesn't match the current presenter", () => {
        const { manager, channel } = setup();
        manager.start();
        channel.emit(signal("presenter-claim", "z"));
        channel.emit(signal("presenter-release", "someone-else"));
        expect(manager.presenterUid).toBe("z");
    });
});

describe("MeshConnectionManager - onEvent", () => {
    it("stops delivering events once unsubscribed", () => {
        const { manager, events } = setup();
        const later: MeshEvent[] = [];
        const unsubscribe = manager.onEvent((e) => later.push(e));
        manager.start();
        unsubscribe();
        manager.claimPresenter();
        expect(later).toEqual([]);
        expect(events).toHaveLength(1);
    });
});

describe("MeshConnectionManager - two real instances converging", () => {
    it("discovers each other regardless of join order and completes the offer/answer exchange both ways", async () => {
        const b = bus();
        const createdA: FakeRTCPeerConnection[] = [];
        const createdZ: FakeRTCPeerConnection[] = [];
        const make = (selfUid: string, selfName: string, created: FakeRTCPeerConnection[]) =>
            new MeshConnectionManager({
                selfUid,
                selfName,
                iceServers: [],
                channel: b.channel(),
                createPeerConnection: () => {
                    const pc = fakeRTCPeerConnection();
                    created.push(pc);
                    return pc;
                },
                createMediaStream: () => fakeMediaStream(),
                localAudioTrack: fakeTrack("audio"),
                localVideoTrack: fakeTrack("video"),
            });
        const managerA = make("a", "Alice", createdA); // smaller uid - offerer toward "z"
        const managerZ = make("z", "Zed", createdZ);

        managerA.start();
        managerZ.start();
        await flush();

        expect(managerA.participants).toEqual([{ uid: "z", name: "Zed", ...STATE, ...CONNECTING }]);
        expect(managerZ.participants).toEqual([{ uid: "a", name: "Alice", ...STATE, ...CONNECTING }]);
        expect(createdA[0].setLocalDescription).toHaveBeenCalledWith({ type: "offer", sdp: "fake-offer-sdp" });
        expect(createdZ[0].setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "fake-offer-sdp" });
        expect(createdZ[0].setLocalDescription).toHaveBeenCalledWith({ type: "answer", sdp: "fake-answer-sdp" });
        expect(createdA[0].setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "fake-answer-sdp" });
        // Each side ends up with a sender for each kind, the answerer's from claiming the offer's transceivers.
        expect(createdA[0].senders.audio).toBeDefined();
        expect(createdZ[0].senders.video).toBeDefined();
    });
});

/** A fake `RelayTransportLike` recording every call, and remembering each `receiveFrom()` callback so a test can hand
 * the manager a stream the way the real relay would. */
function fakeRelay(supported = true) {
    const streamHandlers = new Map<string, (stream: MediaStream) => void>();
    return {
        supported,
        streamHandlers,
        receiveFrom: vi.fn((peerId: string, onStream: (stream: MediaStream) => void) => streamHandlers.set(peerId, onStream)),
        stopReceivingFrom: vi.fn(),
        setSending: vi.fn(),
        setLocalTrack: vi.fn(),
        close: vi.fn(),
    };
}

/** A manager with a relay and a peer "z" that has said hello (so the connection to it exists). */
async function setupWithPeer(relay: RelayTransportLike | undefined, overrides: Partial<MeshConnectionManagerOptions> = {}) {
    const context = setup({ relay, ...overrides });
    context.manager.start();
    context.channel.emit(hello("z", "Zed"));
    await flush();
    return { ...context, pc: context.created[0], transportOf: () => context.manager.participants[0]?.transport };
}

const setState = (pc: FakeRTCPeerConnection, state: string) => {
    pc.connectionState = state;
    pc.onconnectionstatechange?.();
};

describe("MeshConnectionManager - media paths (p2p, then TURN, then the WebSocket relay)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("reports a connected pair as direct, or as relayed through TURN when the selected candidate pair is a relay", async () => {
        const direct = await setupWithPeer(undefined);
        expect(direct.transportOf()).toBe("connecting");
        setState(direct.pc, "connected");
        await flush();
        expect(direct.transportOf()).toBe("p2p");
        expect(direct.events).toContainEqual({ type: "participant-updated", participant: expect.objectContaining({ uid: "z", transport: "p2p" }) });

        const relayed = await setupWithPeer(undefined);
        relayed.pc.type = "turn";
        setState(relayed.pc, "connected");
        await flush();
        expect(relayed.transportOf()).toBe("turn");
    });

    it("counts a pair whose type the browser does not report, or whose stats fail to read, as direct", async () => {
        const unknown = await setupWithPeer(undefined);
        unknown.pc.type = "unknown";
        setState(unknown.pc, "connected");
        await flush();
        expect(unknown.transportOf()).toBe("p2p");

        const failing = await setupWithPeer(undefined);
        failing.pc.connectionType.mockRejectedValueOnce(new Error("no stats"));
        setState(failing.pc, "connected");
        await flush();
        expect(failing.transportOf()).toBe("p2p");
    });

    it("announces a path change once, and re-reads the path when ICE reconnects on a different one", async () => {
        // A connected pair also gets its own diagnostics-driven update (same transport, a fresh stats sample - see
        // "MeshConnectionManager - diagnostics polling" below), so this counts distinct transport *values* seen in
        // order rather than raw event counts, which is what "announces a path change once" actually means.
        const transportSequence = (events: MeshEvent[]): string[] =>
            events
                .filter((e): e is MeshEvent & { type: "participant-updated" } => e.type === "participant-updated")
                .map((e) => e.participant.transport)
                .filter((transport, i, all) => transport !== all[i - 1]);
        const { pc, events, transportOf } = await setupWithPeer(undefined);
        setState(pc, "connected");
        await flush();
        setState(pc, "connected");
        await flush();
        expect(transportSequence(events)).toEqual(["p2p"]);

        pc.type = "turn";
        setState(pc, "connected");
        await flush();
        expect(transportOf()).toBe("turn");
        expect(transportSequence(events)).toEqual(["p2p", "turn"]);
    });

    it("drops a path reading that lands after the pair dropped, fell back or left", async () => {
        const dropped = await setupWithPeer(undefined);
        dropped.pc.connectionState = "connected";
        dropped.pc.onconnectionstatechange!();
        dropped.pc.connectionState = "disconnected";
        await flush();
        expect(dropped.transportOf()).toBe("connecting");

        const relay = fakeRelay();
        const fellBack = await setupWithPeer(relay);
        fellBack.pc.connectionState = "connected";
        fellBack.pc.onconnectionstatechange!();
        fellBack.channel.emit(signal("relay-fallback", "z"));
        await flush();
        expect(fellBack.transportOf()).toBe("websocket");

        const left = await setupWithPeer(undefined);
        left.pc.connectionState = "connected";
        left.pc.onconnectionstatechange!();
        left.channel.emit(signal("bye", "z"));
        await flush();
        expect(left.events.filter((e) => e.type === "participant-updated")).toEqual([]);
    });

    it("moves a pair whose connection failed to the WebSocket relay, closing the connection and telling the peer", async () => {
        const relay = fakeRelay();
        const { manager, channel, pc, events } = await setupWithPeer(relay);
        channel.sent.length = 0;

        setState(pc, "failed");

        expect(manager.participants).toEqual([{ uid: "z", name: "Zed", audioOn: false, videoOn: false, handRaised: false, transport: "websocket" }]);
        expect(pc.close).toHaveBeenCalledTimes(1);
        expect(pc.onconnectionstatechange).toBeNull();
        expect(pc.onicecandidate).toBeNull();
        expect(pc.ontrack).toBeNull();
        expect(relay.receiveFrom).toHaveBeenCalledWith("z", expect.any(Function));
        expect(relay.setSending).toHaveBeenLastCalledWith(true);
        expect(channel.sent).toEqual([{ type: "video-meeting-signal", kind: "relay-fallback", from: "a", to: "z" }]);
        expect(events).toContainEqual({ type: "participant-updated", participant: expect.objectContaining({ uid: "z", transport: "websocket" }) });
        // Not a departure: the participant stays in the call.
        expect(events.some((e) => e.type === "participant-left")).toBe(false);
    });

    it("plays the relay's stream in place of the one WebRTC would have filled", async () => {
        const relay = fakeRelay();
        const { pc, events } = await setupWithPeer(relay);
        setState(pc, "failed");
        const stream = fakeMediaStream();

        relay.streamHandlers.get("z")!(stream);

        expect(events).toContainEqual({ type: "remote-stream", uid: "z", stream });
    });

    it("moves a pair that has not connected within the timeout, and leaves one that connected in time alone", async () => {
        vi.useFakeTimers();
        const relay = fakeRelay();
        const slow = await setupWithPeer(relay, { connectTimeoutMs: 5000 });
        vi.advanceTimersByTime(4999);
        expect(slow.transportOf()).toBe("connecting");
        vi.advanceTimersByTime(1);
        expect(slow.transportOf()).toBe("websocket");

        const quick = await setupWithPeer(relay, { connectTimeoutMs: 5000 });
        setState(quick.pc, "connected");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(quick.transportOf()).toBe("p2p");
    });

    it("waits DEFAULT_CONNECT_TIMEOUT_MS when no timeout is given", async () => {
        vi.useFakeTimers();
        const { transportOf } = await setupWithPeer(fakeRelay());
        vi.advanceTimersByTime(DEFAULT_CONNECT_TIMEOUT_MS - 1);
        expect(transportOf()).toBe("connecting");
        vi.advanceTimersByTime(1);
        expect(transportOf()).toBe("websocket");
    });

    it("gives a disconnected pair a grace period to recover before moving it, without restarting the wait", async () => {
        vi.useFakeTimers();
        const relay = fakeRelay();
        const { pc, transportOf } = await setupWithPeer(relay, { disconnectedGraceMs: 3000 });
        setState(pc, "connected");
        await vi.advanceTimersByTimeAsync(0);

        setState(pc, "disconnected");
        vi.advanceTimersByTime(2000);
        setState(pc, "disconnected");
        vi.advanceTimersByTime(999);
        expect(transportOf()).toBe("p2p");
        vi.advanceTimersByTime(1);
        expect(transportOf()).toBe("websocket");
    });

    it("keeps a disconnected pair that reconnects within the grace period on WebRTC", async () => {
        vi.useFakeTimers();
        const { pc, transportOf } = await setupWithPeer(fakeRelay(), { disconnectedGraceMs: 3000 });
        setState(pc, "connected");
        await vi.advanceTimersByTimeAsync(0);
        setState(pc, "disconnected");
        vi.advanceTimersByTime(2000);
        setState(pc, "connected");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(transportOf()).toBe("p2p");
    });

    it("waits DEFAULT_DISCONNECTED_GRACE_MS when no grace period is given", async () => {
        vi.useFakeTimers();
        const { pc, transportOf } = await setupWithPeer(fakeRelay());
        setState(pc, "connected");
        await vi.advanceTimersByTimeAsync(0);
        setState(pc, "disconnected");
        vi.advanceTimersByTime(DEFAULT_DISCONNECTED_GRACE_MS - 1);
        expect(transportOf()).toBe("p2p");
        vi.advanceTimersByTime(1);
        expect(transportOf()).toBe("websocket");
    });

    it("ignores connection states that need no action", async () => {
        const { pc, transportOf } = await setupWithPeer(fakeRelay());
        setState(pc, "connecting");
        expect(transportOf()).toBe("connecting");
    });

    it("marks a pair failed - and keeps the participant - when there is no relay to fall back to", async () => {
        for (const relay of [undefined, fakeRelay(false)]) {
            const { manager, channel, pc, events } = await setupWithPeer(relay);
            channel.sent.length = 0;
            setState(pc, "failed");
            expect(manager.participants).toEqual([{ uid: "z", name: "Zed", audioOn: false, videoOn: false, handRaised: false, transport: "failed" }]);
            expect(pc.close).not.toHaveBeenCalled();
            expect(channel.sent).toEqual([]);
            expect(events.some((e) => e.type === "participant-left")).toBe(false);
            // Reporting the same failure again changes nothing.
            const updates = events.filter((e) => e.type === "participant-updated").length;
            setState(pc, "failed");
            expect(events.filter((e) => e.type === "participant-updated")).toHaveLength(updates);
        }
    });

    it("switches to the relay when the peer says it has, without saying so back", async () => {
        const relay = fakeRelay();
        const { manager, channel, pc } = await setupWithPeer(relay);
        channel.sent.length = 0;

        channel.emit(signal("relay-fallback", "z", { to: "a" }));

        expect(manager.participants[0].transport).toBe("websocket");
        expect(pc.close).toHaveBeenCalledTimes(1);
        expect(relay.receiveFrom).toHaveBeenCalledTimes(1);
        expect(channel.sent).toEqual([]);

        // Hearing it again, or from someone unknown, does nothing more.
        channel.emit(signal("relay-fallback", "z", { to: "a" }));
        channel.emit(signal("relay-fallback", "nobody", { to: "a" }));
        expect(relay.receiveFrom).toHaveBeenCalledTimes(1);
    });

    it("ignores a late connection event from a connection it already left, or after stopping", async () => {
        const relay = fakeRelay();
        const { manager, pc } = await setupWithPeer(relay);
        const late = pc.onconnectionstatechange!;
        setState(pc, "failed");
        pc.connectionState = "connected";
        late();
        expect(manager.participants[0].transport).toBe("websocket");

        const stopped = await setupWithPeer(fakeRelay());
        const staleHandler = stopped.pc.onconnectionstatechange!;
        stopped.manager.stop();
        stopped.pc.connectionState = "failed";
        staleHandler();
        expect(stopped.events.filter((e) => e.type !== "participant-joined")).toEqual([]);
    });

    it("stops the relay when the last relayed peer leaves, and only then", async () => {
        const relay = fakeRelay();
        const { manager, channel, created } = await setupWithPeer(relay);
        channel.emit(hello("y", "Yan"));
        await flush();
        expect(created).toHaveLength(2);
        setState(created[0], "failed");
        setState(created[1], "failed");
        expect(relay.setSending).toHaveBeenLastCalledWith(true);

        channel.emit(signal("bye", "z"));
        expect(relay.stopReceivingFrom).toHaveBeenCalledWith("z");
        expect(relay.setSending).toHaveBeenLastCalledWith(true);

        channel.emit(signal("bye", "y"));
        expect(relay.stopReceivingFrom).toHaveBeenCalledWith("y");
        expect(relay.setSending).toHaveBeenLastCalledWith(false);
        expect(manager.participants).toEqual([]);
    });

    it("leaves the relay alone when a peer that never used it leaves", async () => {
        const relay = fakeRelay();
        const { channel } = await setupWithPeer(relay);
        channel.emit(signal("bye", "z"));
        expect(relay.stopReceivingFrom).not.toHaveBeenCalled();
        expect(relay.setSending).not.toHaveBeenCalled();
    });

    it("hands the relay the local tracks from the start and on every change, and closes it on stop", () => {
        const relay = fakeRelay();
        const { manager, audio, video } = setup({ relay });
        expect(relay.setLocalTrack).toHaveBeenCalledWith("audio", audio);
        expect(relay.setLocalTrack).toHaveBeenCalledWith("video", video);

        const screen = fakeTrack("video", "screen");
        manager.setLocalTrack("video", screen);
        expect(relay.setLocalTrack).toHaveBeenLastCalledWith("video", screen);

        manager.start();
        manager.stop();
        expect(relay.close).toHaveBeenCalledTimes(1);
    });

    it("cancels a pending fallback when the manager stops", async () => {
        vi.useFakeTimers();
        const relay = fakeRelay();
        const { manager } = await setupWithPeer(relay, { connectTimeoutMs: 1000 });
        manager.stop();
        vi.advanceTimersByTime(5000);
        expect(relay.receiveFrom).not.toHaveBeenCalled();
    });
});

describe("MeshConnectionManager - diagnostics polling", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("polls once immediately on connecting, without waiting a full interval", async () => {
        const { pc, events, manager } = await setupWithPeer(undefined);
        pc.diagnostics = { roundTripTimeSeconds: 0.02, audio: { packetsLost: 0 }, video: {} };
        setState(pc, "connected");
        await flush();
        expect(pc.collectDiagnostics).toHaveBeenCalledTimes(1);
        expect(manager.participants[0]?.diagnostics).toEqual(pc.diagnostics);
        expect(events).toContainEqual({
            type: "participant-updated",
            participant: expect.objectContaining({ uid: "z", diagnostics: pc.diagnostics }),
        });
    });

    it("polls again every DEFAULT_DIAGNOSTICS_POLL_MS, reflecting each new sample", async () => {
        vi.useFakeTimers();
        const { pc, manager } = await setupWithPeer(undefined, { diagnosticsPollMs: 3000 });
        pc.diagnostics = { audio: {}, video: {} };
        setState(pc, "connected");
        await flush();
        expect(pc.collectDiagnostics).toHaveBeenCalledTimes(1);

        pc.diagnostics = { roundTripTimeSeconds: 0.5, audio: {}, video: {} };
        await vi.advanceTimersByTimeAsync(3000);
        expect(pc.collectDiagnostics).toHaveBeenCalledTimes(2);
        expect(manager.participants[0]?.diagnostics).toEqual(pc.diagnostics);
    });

    it("defaults to DEFAULT_DIAGNOSTICS_POLL_MS when no interval is given", async () => {
        vi.useFakeTimers();
        const { pc } = await setupWithPeer(undefined);
        setState(pc, "connected");
        await flush();
        expect(pc.collectDiagnostics).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(DEFAULT_DIAGNOSTICS_POLL_MS);
        expect(pc.collectDiagnostics).toHaveBeenCalledTimes(2);
    });

    it("does not start a second timer when the connection merely reconnects without leaving WebRTC", async () => {
        vi.useFakeTimers();
        const { pc } = await setupWithPeer(undefined);
        setState(pc, "connected");
        await flush();
        setState(pc, "connected");
        await flush();
        expect(vi.getTimerCount()).toBe(1);
    });

    it("stops polling once the pair falls back to the relay, and clears the stale sample", async () => {
        vi.useFakeTimers();
        const relay = fakeRelay();
        const { pc, manager } = await setupWithPeer(relay);
        pc.diagnostics = { audio: {}, video: {} };
        setState(pc, "connected");
        await flush();
        expect(manager.participants[0]?.diagnostics).toEqual(pc.diagnostics);

        setState(pc, "failed");
        expect(manager.participants[0]?.diagnostics).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(pc.collectDiagnostics).toHaveBeenCalledTimes(1); // just the one poll from before the fallback
    });

    it("stops polling once the pair leaves", async () => {
        vi.useFakeTimers();
        const { pc, channel } = await setupWithPeer(undefined);
        setState(pc, "connected");
        await flush();
        channel.emit(signal("bye", "z"));
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops every peer's polling when the manager itself stops", async () => {
        vi.useFakeTimers();
        const { manager, pc } = await setupWithPeer(undefined);
        setState(pc, "connected");
        await flush();
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        manager.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves the last sample in place, rather than blanking it, when a poll fails", async () => {
        vi.useFakeTimers();
        const { pc, manager } = await setupWithPeer(undefined);
        pc.diagnostics = { roundTripTimeSeconds: 0.03, audio: {}, video: {} };
        setState(pc, "connected");
        await flush();
        expect(manager.participants[0]?.diagnostics).toEqual(pc.diagnostics);

        pc.collectDiagnostics.mockRejectedValueOnce(new Error("getStats failed"));
        await vi.advanceTimersByTimeAsync(DEFAULT_DIAGNOSTICS_POLL_MS);
        expect(manager.participants[0]?.diagnostics).toEqual(pc.diagnostics);
    });

    it("drops a reading that lands after the pair fell back or left, rather than resurrecting it", async () => {
        vi.useFakeTimers();
        const relay = fakeRelay();
        const { pc, manager } = await setupWithPeer(relay);
        // The very first poll (fired synchronously by connecting) is made slow, so it is still in flight when the
        // pair falls back moments later.
        pc.collectDiagnostics.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ audio: {}, video: {} }), 100)));
        setState(pc, "connected");
        setState(pc, "failed");
        await vi.advanceTimersByTimeAsync(200);
        expect(manager.participants[0]?.diagnostics).toBeUndefined();
    });
});

describe("MeshConnectionManager - host moderation (mute-request, kicked)", () => {
    it("sends a mute request to one peer, point-to-point", () => {
        const { manager, channel } = setup({ peerId: "a~tab" });
        manager.start();
        manager.sendMuteRequest("z~tab");
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "mute-request", from: "a", peer: "a~tab", to: "z~tab" });
    });

    it("sends a kick to one peer, point-to-point", () => {
        const { manager, channel } = setup({ peerId: "a~tab" });
        manager.start();
        manager.sendKick("z~tab");
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "kicked", from: "a", peer: "a~tab", to: "z~tab" });
    });

    it("emits mute-requested on receiving one addressed to this peer, and ignores one addressed elsewhere", () => {
        const { manager, channel, events } = setup({ peerId: "a~tab" });
        manager.start();
        channel.emit(signal("mute-request", "z", { to: "someone-else" }));
        expect(events).not.toContainEqual({ type: "mute-requested" });

        channel.emit(signal("mute-request", "z", { to: "a~tab" }));
        expect(events).toContainEqual({ type: "mute-requested" });
    });

    it("emits kicked on receiving one addressed to this peer, and ignores one addressed elsewhere", () => {
        const { manager, channel, events } = setup({ peerId: "a~tab" });
        manager.start();
        channel.emit(signal("kicked", "z", { to: "someone-else" }));
        expect(events).not.toContainEqual({ type: "kicked" });

        channel.emit(signal("kicked", "z", { to: "a~tab" }));
        expect(events).toContainEqual({ type: "kicked" });
    });
});

describe("MeshConnectionManager - talking stick", () => {
    it("broadcasts activating the mode and applies it locally at once, with no round trip", () => {
        const { manager, channel, events } = setup({ peerId: "a~tab" });
        manager.start();
        manager.setTalkingStick(true, "a~tab");
        expect(channel.sent).toContainEqual({ type: "video-meeting-signal", kind: "talking-stick", from: "a", peer: "a~tab", active: true, holder: "a~tab" });
        expect(events).toContainEqual({ type: "talking-stick-changed", active: true, holder: "a~tab" });
    });

    it("broadcasts handing the stick to someone else", () => {
        const { manager, channel, events } = setup({ peerId: "a~tab" });
        manager.start();
        manager.setTalkingStick(true, "z~tab");
        expect(channel.sent).toContainEqual(expect.objectContaining({ kind: "talking-stick", active: true, holder: "z~tab" }));
        expect(events).toContainEqual({ type: "talking-stick-changed", active: true, holder: "z~tab" });
    });

    it("broadcasts turning the mode off with no holder", () => {
        const { manager, channel, events } = setup({ peerId: "a~tab" });
        manager.start();
        manager.setTalkingStick(false);
        expect(channel.sent).toContainEqual(expect.objectContaining({ kind: "talking-stick", active: false, holder: undefined }));
        expect(events).toContainEqual({ type: "talking-stick-changed", active: false, holder: undefined });
    });

    it("emits talking-stick-changed on receiving one, trusting the latest message with no collision to resolve", () => {
        const { manager, channel, events } = setup({ peerId: "a~tab" });
        manager.start();
        channel.emit(signal("talking-stick", "z", { active: true, holder: "z~tab" }));
        expect(events).toContainEqual({ type: "talking-stick-changed", active: true, holder: "z~tab" });

        channel.emit(signal("talking-stick", "z", { active: true, holder: "a~tab" }));
        expect(events).toContainEqual({ type: "talking-stick-changed", active: true, holder: "a~tab" });
    });

    it("sanitizes an untrusted message's fields rather than trusting their shape off the wire", () => {
        const { manager, channel, events } = setup({ peerId: "a~tab" });
        manager.start();
        channel.emit(signal("talking-stick", "z", { active: "yes" as unknown as boolean, holder: 42 as unknown as string }));
        expect(events).toContainEqual({ type: "talking-stick-changed", active: false, holder: undefined });
    });
});
