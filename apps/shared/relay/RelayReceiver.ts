///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RelayReceiveDiagnostics, RelayReceiveStats } from "../webrtc/types.js";
import { AudioPlayer } from "./AudioPlayer.js";
import { decodeFragment, type Frame, FrameReassembler, KIND_AUDIO, seqIsNewer } from "./frames.js";
import type { AudioContextLike, RelayEnv } from "./relayEnv.js";
import { VideoPlayer } from "./VideoPlayer.js";

const SEQ_MODULUS = 0x10000;
/** A jump in sequence numbers bigger than this is taken for the sender restarting its counter, not for that many
 * lost frames. Ten seconds of 20 ms audio packets - far more than any real outage the stream would survive. */
const MAX_COUNTED_SEQ_GAP = 500;

/** Counts one kind's frames as they complete, and the ones the sequence numbers say never did. */
class ReceiveCounter {
    readonly stats: RelayReceiveStats = { framesReceived: 0, framesLost: 0, bytesReceived: 0 };
    private lastSeq: number | undefined;

    fragment(bytes: number): void {
        this.stats.bytesReceived += bytes;
    }

    frame(frame: Frame): void {
        this.stats.framesReceived += 1;
        if (this.lastSeq !== undefined && seqIsNewer(frame.seq, this.lastSeq)) {
            const missing = ((frame.seq - this.lastSeq + SEQ_MODULUS) % SEQ_MODULUS) - 1;
            if (missing <= MAX_COUNTED_SEQ_GAP) {
                this.stats.framesLost += missing;
            }
        }
        this.lastSeq = frame.seq;
    }
}

/** The canvas is sized to the first decoded picture; until then it is this size. */
const INITIAL_CANVAS_WIDTH = 320;
const INITIAL_CANVAS_HEIGHT = 240;
/** The frame rate `captureStream()` samples the canvas at, matching what the sender produces. */
const CAPTURE_FPS = 15;

/**
 * One remote participant as seen through the relay: reassembles their fragments, decodes them, and exposes the result
 * as an ordinary `MediaStream` (`stream`) so the UI plays a relayed peer exactly like a WebRTC one.
 *
 * The stream exists, with both tracks, from construction - silent and blank until media arrives - so the caller can
 * attach it to an element straight away and never has to swap a stream in later. Audio goes through a
 * `MediaStreamAudioDestinationNode` on the shared playback context; video is drawn to a canvas and captured.
 */
export class RelayReceiver {
    readonly stream: MediaStream;
    private readonly audioFrames = new FrameReassembler();
    private readonly videoFrames = new FrameReassembler();
    private readonly audioCounter = new ReceiveCounter();
    private readonly videoCounter = new ReceiveCounter();
    private readonly audio: AudioPlayer;
    private readonly video: VideoPlayer | undefined;

    constructor(
        env: RelayEnv,
        playbackContext: AudioContextLike,
    ) {
        const destination = playbackContext.createMediaStreamDestination();
        this.audio = new AudioPlayer(env, playbackContext, destination);

        const canvas = env.createCanvas();
        canvas.width = INITIAL_CANVAS_WIDTH;
        canvas.height = INITIAL_CANVAS_HEIGHT;
        const context = canvas.getContext("2d");
        this.video = context ? new VideoPlayer(env, canvas, context) : undefined;

        this.stream = env.createMediaStream([...destination.stream.getAudioTracks(), ...canvas.captureStream(CAPTURE_FPS).getVideoTracks()]);
    }

    /** Handles one relayed payload from this sender (a media fragment). Anything malformed is ignored. */
    handleMedia(payload: Uint8Array): void {
        const fragment = decodeFragment(payload);
        if (!fragment) {
            return;
        }
        const isAudio = fragment.kind === KIND_AUDIO;
        const counter = isAudio ? this.audioCounter : this.videoCounter;
        counter.fragment(payload.length);
        const frame = (isAudio ? this.audioFrames : this.videoFrames).push(fragment);
        if (!frame) {
            return;
        }
        counter.frame(frame);
        if (frame.kind === KIND_AUDIO) {
            this.audio.push(frame);
        } else {
            this.video?.push(frame);
        }
    }

    /** A snapshot of what has been received from this peer - see `RelayReceiveDiagnostics`. */
    diagnostics(): RelayReceiveDiagnostics {
        return {
            audio: { ...this.audioCounter.stats, ...this.audio.stats() },
            video: { ...this.videoCounter.stats },
        };
    }

    /** Releases the decoders and ends the stream's tracks. */
    close(): void {
        this.audio.close();
        this.video?.close();
        for (const track of this.stream.getTracks()) {
            track.stop();
        }
    }
}
