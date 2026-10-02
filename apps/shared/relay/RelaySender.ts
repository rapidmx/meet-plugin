///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RelaySendDiagnostics, RelaySendStats } from "../webrtc/types.js";
import { AudioSender } from "./AudioSender.js";
import { DEFAULT_MESSAGE_BYTES, fragmentFrame, type FrameKind, KIND_AUDIO, KIND_VIDEO } from "./frames.js";
import type { RelayEnv } from "./relayEnv.js";
import type { PublishFrame } from "./senderCommon.js";
import { VideoSender } from "./VideoSender.js";

const SEQ_MODULUS = 0x10000;

/** Numbers and fragments the frames of one sender. The counters belong to the transport rather than to a capture
 * session, so stopping and restarting sending never resets `seq` - a receiver still holding the old value would
 * otherwise treat the restarted stream as older than what it has already seen. */
export class FramePublisher {
    private readonly seqs: Record<FrameKind, number> = { [KIND_AUDIO]: 0, [KIND_VIDEO]: 0 };
    /** What happened to each kind's frames - for the diagnostics panel. */
    readonly stats: Record<FrameKind, RelaySendStats> = {
        [KIND_AUDIO]: { framesSent: 0, framesDropped: 0, bytesSent: 0 },
        [KIND_VIDEO]: { framesSent: 0, framesDropped: 0, bytesSent: 0 },
    };

    /** `send` returns whether one message was accepted by the socket. */
    /** `maxMessageBytes` is the largest message the socket may send right now (it changes when the server's `ready`
     * announces a limit), so it is read for every frame rather than fixed at construction. */
    constructor(
        private readonly send: (message: Uint8Array) => boolean,
        private readonly maxMessageBytes: () => number = () => DEFAULT_MESSAGE_BYTES,
    ) {}

    /** Fragments and sends one frame, stopping at the first fragment the socket refuses (the rest could not be
     * used without it). Returns whether the whole frame went out. */
    publish: PublishFrame = (kind, keyFrame, data, timestampMs) => {
        const seq = this.seqs[kind];
        this.seqs[kind] = (seq + 1) % SEQ_MODULUS;
        const stats = this.stats[kind];
        const fragments = fragmentFrame(kind, keyFrame, seq, timestampMs, data, this.maxMessageBytes());
        if (fragments.length === 0) {
            stats.framesDropped += 1;
            return false;
        }
        for (const fragment of fragments) {
            if (!this.send(fragment)) {
                stats.framesDropped += 1;
                return false;
            }
            stats.bytesSent += fragment.length;
        }
        stats.framesSent += 1;
        return true;
    };
}

export interface RelaySenderOptions {
    env: RelayEnv;
    send: (message: Uint8Array) => boolean;
    canSend: () => boolean;
    /** The socket's current message limit; defaults to what an older server accepts. */
    maxMessageBytes?: () => number;
}

/** The publishing half of the relay: the two capture paths plus the frame numbering they share. */
export class RelaySender {
    private readonly publisher: FramePublisher;
    private readonly audio: AudioSender;
    private readonly video: VideoSender;

    constructor(options: RelaySenderOptions) {
        this.publisher = new FramePublisher(options.send, options.maxMessageBytes);
        const deps = { env: options.env, publish: this.publisher.publish, canSend: options.canSend };
        this.audio = new AudioSender(deps);
        this.video = new VideoSender(deps);
    }

    /** A snapshot of the sending counters - see `RelaySendDiagnostics`. */
    diagnostics(): RelaySendDiagnostics {
        return {
            ...this.audio.captureStats(),
            audio: { ...this.publisher.stats[KIND_AUDIO] },
            video: { ...this.publisher.stats[KIND_VIDEO] },
        };
    }

    /** Starts or stops encoding whatever tracks are set. Stopping releases the encoders and audio nodes. */
    setActive(active: boolean): void {
        this.audio.setActive(active);
        this.video.setActive(active);
    }

    /** `null` sends nothing for that kind. Safe before or after `setActive`. */
    setTrack(kind: "audio" | "video", track: MediaStreamTrack | null): void {
        (kind === "audio" ? this.audio : this.video).setTrack(track);
    }
}
