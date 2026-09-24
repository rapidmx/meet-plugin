///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserPeerConnection } from "../../../../apps/shared/webrtc/realPeerConnection.js";

class FakeSender {
    constructor(public track: unknown) {}
    replaceTrack = vi.fn();
}

class FakeTransceiver {
    direction = "recvonly";
    sender = new FakeSender(null);
    constructor(public receiver: { track: { kind: string } }) {}
}

class FakeRTCPeerConnection {
    static instances: FakeRTCPeerConnection[] = [];
    config: unknown;
    onicecandidate: ((event: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
    ontrack: ((event: { track: unknown; streams: unknown[] }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    connectionState = "new";
    addTransceiver = vi.fn((trackOrKind: unknown, init: unknown) => {
        const transceiver = new FakeTransceiver({ track: { kind: typeof trackOrKind === "string" ? trackOrKind : "video" } });
        transceiver.sender = new FakeSender(typeof trackOrKind === "string" ? null : trackOrKind);
        void init;
        return transceiver;
    });
    transceivers: FakeTransceiver[] = [];
    getTransceivers = vi.fn(() => this.transceivers);
    createOffer = vi.fn(async () => ({ type: "offer", sdp: "o" }));
    createAnswer = vi.fn(async () => ({ type: "answer", sdp: "a" }));
    setLocalDescription = vi.fn(async () => undefined);
    setRemoteDescription = vi.fn(async () => undefined);
    addIceCandidate = vi.fn(async () => undefined);
    close = vi.fn();
    constructor(config: unknown) {
        this.config = config;
        FakeRTCPeerConnection.instances.push(this);
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
    FakeRTCPeerConnection.instances = [];
});

describe("createBrowserPeerConnection", () => {
    it("constructs the real RTCPeerConnection with the given config and delegates every method", async () => {
        vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
        const like = createBrowserPeerConnection({ iceServers: [{ urls: "stun:example.com" }] });
        const real = FakeRTCPeerConnection.instances[0];
        expect(real.config).toEqual({ iceServers: [{ urls: "stun:example.com" }] });

        const track = { kind: "video" };
        const withTrack = like.addTransceiver("video", track as never);
        expect(real.addTransceiver).toHaveBeenCalledWith(track, { direction: "sendrecv" });
        expect(withTrack.sender.track).toBe(track);

        // Nothing to send yet: the transceiver is made by kind, and its sender sends nothing until replaceTrack().
        const withoutTrack = like.addTransceiver("audio", null);
        expect(real.addTransceiver).toHaveBeenCalledWith("audio", { direction: "sendrecv" });
        expect(withoutTrack.sender.track).toBeNull();

        await expect(like.createOffer()).resolves.toEqual({ type: "offer", sdp: "o" });
        await expect(like.createAnswer()).resolves.toEqual({ type: "answer", sdp: "a" });
        await like.setLocalDescription({ type: "offer", sdp: "o" });
        expect(real.setLocalDescription).toHaveBeenCalledWith({ type: "offer", sdp: "o" });
        await like.setRemoteDescription({ type: "answer", sdp: "a" });
        expect(real.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "a" });
        await like.addIceCandidate({ candidate: "c" });
        expect(real.addIceCandidate).toHaveBeenCalledWith({ candidate: "c" });
        like.close();
        expect(real.close).toHaveBeenCalledTimes(1);

        real.connectionState = "connected";
        expect(like.connectionState).toBe("connected");
    });

    it("forwards icecandidate/track/connectionstatechange events to whatever handler is currently assigned", () => {
        vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
        const like = createBrowserPeerConnection({ iceServers: [] });
        const real = FakeRTCPeerConnection.instances[0];

        const onIce = vi.fn();
        like.onicecandidate = onIce;
        real.onicecandidate!({ candidate: { toJSON: () => ({ candidate: "x", sdpMid: "0", sdpMLineIndex: 0 }) } });
        expect(onIce).toHaveBeenCalledWith({ candidate: { candidate: "x", sdpMid: "0", sdpMLineIndex: 0 } });

        onIce.mockClear();
        real.onicecandidate!({ candidate: null });
        expect(onIce).toHaveBeenCalledWith({ candidate: null });

        const onTrack = vi.fn();
        like.ontrack = onTrack;
        const track = { kind: "audio" };
        real.ontrack!({ track, streams: [{}] });
        expect(onTrack).toHaveBeenCalledWith({ track });

        const onStateChange = vi.fn();
        like.onconnectionstatechange = onStateChange;
        real.onconnectionstatechange!();
        expect(onStateChange).toHaveBeenCalledTimes(1);
    });

    it("claims the transceivers a remote offer created, one send-and-receive sender per kind", () => {
        vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
        const like = createBrowserPeerConnection({ iceServers: [] });
        const real = FakeRTCPeerConnection.instances[0];
        const audio = new FakeTransceiver({ track: { kind: "audio" } });
        const video = new FakeTransceiver({ track: { kind: "video" } });
        const secondVideo = new FakeTransceiver({ track: { kind: "video" } });
        real.transceivers = [audio, video, secondVideo];

        const senders = like.claimTransceivers();
        expect(senders.audio).toBe(audio.sender);
        expect(senders.video).toBe(video.sender);
        expect(audio.direction).toBe("sendrecv");
        expect(video.direction).toBe("sendrecv");
        // A second m-line of a kind already claimed is left alone.
        expect(secondVideo.direction).toBe("recvonly");
    });

    it("does nothing when no handler has been assigned yet", () => {
        vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
        createBrowserPeerConnection({ iceServers: [] });
        const real = FakeRTCPeerConnection.instances[0];
        expect(() => real.onicecandidate!({ candidate: null })).not.toThrow();
        expect(() => real.ontrack!({ track: {}, streams: [] })).not.toThrow();
        expect(() => real.onconnectionstatechange!()).not.toThrow();
    });
});
