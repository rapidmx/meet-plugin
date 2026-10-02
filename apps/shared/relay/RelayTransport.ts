///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The last-resort media tier of a call: when two participants' WebRTC connection cannot be made at all (typically a
 * network that blocks UDP and TURN alike), their audio and video travel over a WebSocket to the server, which fans
 * each participant's frames out to whoever asked for them. This module is the facade the mesh manager talks to; the
 * pieces behind it are:
 *
 * - `RelayClient` - the socket: hello/ready/want, reconnection, dropping media it cannot send promptly.
 * - `frames` - the fragment format inside each WebSocket message and the reassembly of it.
 * - `RelaySender` (`AudioSender`, `VideoSender`) - capture and encode the local tracks (Opus and VP8 via WebCodecs).
 * - `RelayReceiver` (`AudioPlayer`, `VideoPlayer`) - decode a remote participant back into a `MediaStream`.
 *
 * There is one transport (one socket) per meeting, however many peers use it, and the codecs are fixed - there is no
 * negotiation, because both ends are this same code.
 */
import { apiOrigin } from "@rapidmx/web-client/lib/util/api.js";
import type { RelayDiagnostics } from "../webrtc/types.js";
import { PLAYBACK_SAMPLE_RATE } from "./AudioPlayer.js";
import { resumeAudioContext } from "./audioResume.js";
import { RelayClient } from "./RelayClient.js";
import { detectRelayEnv, type AudioContextLike, type RelayEnv } from "./relayEnv.js";
import { RelayReceiver } from "./RelayReceiver.js";
import { RelaySender } from "./RelaySender.js";

export interface RelayTransport {
    /** false when this browser lacks WebSocket, AudioEncoder/AudioDecoder/VideoEncoder/VideoDecoder, VideoFrame,
     * AudioContext or canvas.captureStream - the mesh then never falls back to the relay. */
    readonly supported: boolean;
    /** Start receiving `peerId`'s media (opens/keeps the socket, adds to `want`). `onStream` gets a MediaStream that
     * plays that peer (one audio + one video track). Called at most once per stream creation; calling receiveFrom
     * again for the same peer is a no-op. */
    receiveFrom(peerId: string, onStream: (stream: MediaStream) => void): void;
    stopReceivingFrom(peerId: string): void;
    /** Start/stop publishing the local tracks (encode + send). Only encodes while active; stopping releases the
     * encoders and audio nodes. */
    setSending(active: boolean): void;
    /** Same semantics as `MeshConnectionManager.setLocalTrack`: null = send nothing for that kind. Safe to call
     * before or after `setSending`. */
    setLocalTrack(kind: "audio" | "video", track: MediaStreamTrack | null): void;
    /** The sending counters (shared by every peer) plus what has been received from `peerId`, for the diagnostics
     * panel - cumulative, so a caller wanting a rate keeps the previous sample. */
    diagnostics(peerId: string): RelayDiagnostics;
    /** Closes the socket, all coders, streams and timers. Idempotent. */
    close(): void;
}

export interface RelayTransportOptions {
    meetingUid: string;
    /** This participant's peer id on the meeting's signaling channel - the id the server stamps on what it sends. */
    peerId: string;
    /** Overrides the socket URL (default: `relayUrl(meetingUid)`). */
    url?: string;
    /** Overrides every browser API the relay uses (default: `detectRelayEnv()`), so a test can drive it with fakes. */
    env?: RelayEnv;
}

/** The relay WebSocket's URL for a meeting: this deployment's origin (the API origin when the UI is served from a
 * different one, else the page's own), `http` becoming `ws` - the same derivation `pushUrl()` uses for `/push`.
 * `undefined` when there is no origin at all (not running in a browser). */
export function relayUrl(meetingUid: string): string | undefined {
    const origin = apiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
    return origin ? `${origin.replace(/^http/i, "ws")}/api/mail/video-meetings/relay/${encodeURIComponent(meetingUid)}` : undefined;
}

/** What `createRelayTransport()` returns on a browser that cannot run the relay: every call is a no-op. */
const UNSUPPORTED_TRANSPORT: RelayTransport = {
    supported: false,
    receiveFrom: () => undefined,
    stopReceivingFrom: () => undefined,
    setSending: () => undefined,
    setLocalTrack: () => undefined,
    diagnostics: () => ({
        send: {
            audioCapturedMs: 0,
            audioCaptureWallMs: 0,
            audioSilentMs: 0,
            audioEncoderSkippedMs: 0,
            audio: { framesSent: 0, framesDropped: 0, bytesSent: 0 },
            video: { framesSent: 0, framesDropped: 0, bytesSent: 0 },
        },
    }),
    close: () => undefined,
};

class WebSocketRelayTransport implements RelayTransport {
    readonly supported = true;
    private readonly client: RelayClient;
    private readonly sender: RelaySender;
    private readonly receivers = new Map<string, RelayReceiver>();
    private playback: AudioContextLike | undefined;
    private stopResume: (() => void) | undefined;
    private closed = false;

    constructor(
        private readonly env: RelayEnv,
        url: string,
        peerId: string,
    ) {
        this.client = new RelayClient({
            url,
            peerId,
            createSocket: (target) => env.createSocket(target),
            random: () => env.random(),
            now: () => env.now(),
            onMedia: (sender, payload) => this.receivers.get(sender)?.handleMedia(payload),
        });
        this.sender = new RelaySender({
            env,
            send: (message) => this.client.sendMedia(message),
            canSend: () => this.client.ready,
            maxMessageBytes: () => this.client.maxMessageBytes,
        });
    }

    receiveFrom(peerId: string, onStream: (stream: MediaStream) => void): void {
        if (this.closed || this.receivers.has(peerId)) {
            return;
        }
        const receiver = this.createReceiver();
        if (!receiver) {
            return;
        }
        this.receivers.set(peerId, receiver);
        this.client.start();
        this.client.setWanted(this.receivers.keys());
        onStream(receiver.stream);
    }

    stopReceivingFrom(peerId: string): void {
        const receiver = this.receivers.get(peerId);
        if (!receiver) {
            return;
        }
        this.receivers.delete(peerId);
        receiver.close();
        this.client.setWanted(this.receivers.keys());
    }

    setSending(active: boolean): void {
        if (this.closed) {
            return;
        }
        if (active) {
            this.client.start();
        }
        this.sender.setActive(active);
    }

    setLocalTrack(kind: "audio" | "video", track: MediaStreamTrack | null): void {
        if (!this.closed) {
            this.sender.setTrack(kind, track);
        }
    }

    diagnostics(peerId: string): RelayDiagnostics {
        return { roundTripMs: this.client.roundTripMs, send: this.sender.diagnostics(), receive: this.receivers.get(peerId)?.diagnostics() };
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.sender.setActive(false);
        for (const receiver of this.receivers.values()) {
            receiver.close();
        }
        this.receivers.clear();
        this.client.close();
        this.stopResume?.();
        // `close()` rejects for a context that is already closed; nothing to do about it.
        this.playback?.close().catch(() => undefined);
        this.playback = undefined;
    }

    /** A receiver on the shared playback context, or `undefined` if this browser will not build one (the peer then
     * simply has no relayed media). */
    private createReceiver(): RelayReceiver | undefined {
        try {
            if (!this.playback) {
                this.playback = this.env.createAudioContext(PLAYBACK_SAMPLE_RATE);
                // Nothing the user just did created this context, so it may start suspended - see `resumeAudioContext`.
                this.stopResume = resumeAudioContext(this.playback, this.env.document);
            }
            return new RelayReceiver(this.env, this.playback);
        } catch {
            return undefined;
        }
    }
}

/**
 * Creates the relay transport for one meeting. Returns an inert transport (`supported: false`) when the browser lacks
 * something the relay needs, so the caller can simply check `supported` once and never fall back to it.
 * No socket is opened until the first `receiveFrom()` or `setSending(true)`.
 */
export function createRelayTransport(options: RelayTransportOptions): RelayTransport {
    const env = options.env ?? detectRelayEnv();
    const url = options.url ?? relayUrl(options.meetingUid);
    if (!env || !url) {
        return UNSUPPORTED_TRANSPORT;
    }
    return new WebSocketRelayTransport(env, url, options.peerId);
}
