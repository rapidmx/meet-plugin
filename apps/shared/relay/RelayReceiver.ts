///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AudioPlayer } from "./AudioPlayer.js";
import { decodeFragment, FrameReassembler, KIND_AUDIO } from "./frames.js";
import type { AudioContextLike, RelayEnv } from "./relayEnv.js";
import { VideoPlayer } from "./VideoPlayer.js";

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
        const frame = (fragment.kind === KIND_AUDIO ? this.audioFrames : this.videoFrames).push(fragment);
        if (!frame) {
            return;
        }
        if (frame.kind === KIND_AUDIO) {
            this.audio.push(frame);
        } else {
            this.video?.push(frame);
        }
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
