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

class FakeRTCPeerConnection {
    static instances: FakeRTCPeerConnection[] = [];
    config: unknown;
    onicecandidate: ((event: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
    ontrack: ((event: { streams: unknown[] }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    connectionState = "new";
    addTrack = vi.fn((track: unknown) => new FakeSender(track));
    getSenders = vi.fn(() => ["sender-1"]);
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
        const stream = {};
        const sender = like.addTrack(track as never, stream as never);
        expect(real.addTrack).toHaveBeenCalledWith(track, stream);
        expect(sender).toBeInstanceOf(FakeSender);

        expect(like.getSenders()).toEqual(["sender-1"]);
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
        const stream = {};
        real.ontrack!({ streams: [stream] });
        expect(onTrack).toHaveBeenCalledWith({ streams: [stream] });

        const onStateChange = vi.fn();
        like.onconnectionstatechange = onStateChange;
        real.onconnectionstatechange!();
        expect(onStateChange).toHaveBeenCalledTimes(1);
    });

    it("does nothing when no handler has been assigned yet", () => {
        vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
        createBrowserPeerConnection({ iceServers: [] });
        const real = FakeRTCPeerConnection.instances[0];
        expect(() => real.onicecandidate!({ candidate: null })).not.toThrow();
        expect(() => real.ontrack!({ streams: [] })).not.toThrow();
        expect(() => real.onconnectionstatechange!()).not.toThrow();
    });
});
