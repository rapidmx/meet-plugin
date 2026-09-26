///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { KIND_VIDEO } from "./frames.js";
import type { CanvasContextLike, CanvasLike, EncodedChunkLike, EncoderLike, VideoElementLike, VideoFrameLike } from "./relayEnv.js";
import { safeClose, type SenderDeps } from "./senderCommon.js";

export const VIDEO_MAX_WIDTH = 480;
export const VIDEO_MAX_HEIGHT = 360;
export const VIDEO_FPS = 15;
export const VIDEO_BITRATE = 350_000;
/** A key frame is forced this often, so a receiver that joins or loses a frame recovers within two seconds. */
export const VIDEO_KEY_FRAME_INTERVAL = 30;
/** Skip a tick instead of queueing a frame when the encoder is this far behind. */
export const VIDEO_MAX_ENCODE_QUEUE = 3;
/** `HTMLMediaElement.HAVE_CURRENT_DATA`: a frame is available to draw. */
const HAVE_CURRENT_DATA = 2;

/** The size a `width` x `height` picture is encoded at: shrunk to fit `VIDEO_MAX_WIDTH` x `VIDEO_MAX_HEIGHT` keeping
 * its aspect ratio (never enlarged), and rounded to even numbers because VP8's chroma planes are half size. */
export function fitSize(width: number, height: number): { width: number; height: number } {
    const scale = Math.min(1, VIDEO_MAX_WIDTH / width, VIDEO_MAX_HEIGHT / height);
    return {
        width: Math.max(2, 2 * Math.round((width * scale) / 2)),
        height: Math.max(2, 2 * Math.round((height * scale) / 2)),
    };
}

/**
 * Captures one camera or screen-share track and publishes it as VP8.
 *
 * One capture path: a hidden `<video>` plays the track, a `setInterval` at about 15 fps draws its current picture onto
 * a canvas (which also does the down-scaling, so the encoder always sees the size it was configured for), and the
 * canvas becomes a `VideoFrame` for the `VideoEncoder`. A key frame is forced at the start, after any change of
 * source or size and every `VIDEO_KEY_FRAME_INTERVAL` frames, and whenever a frame could not be sent (a receiver
 * that missed a fragment cannot decode the deltas that follow it, so the fastest cure is a new key frame).
 *
 * Replacing the track (a screen share swaps the camera track for a display track) keeps the loop running: the
 * `<video>` is pointed at the new track and a key frame is forced. The encoder is created lazily at the first real
 * picture, because its size is only known once the video has one, and discarded on any error rather than repaired
 * inside its own error callback.
 */
export class VideoSender {
    private active = false;
    private track: MediaStreamTrack | null = null;
    private attachedTrack: MediaStreamTrack | null = null;

    private video: VideoElementLike | undefined;
    private timer: unknown;
    private encoder: EncoderLike<VideoFrameLike, { keyFrame: boolean }> | undefined;
    private encodedWidth = 0;
    private encodedHeight = 0;
    private frameCount = 0;
    private forceKey = true;
    private baseMs = 0;

    constructor(private readonly deps: SenderDeps) {}

    setActive(active: boolean): void {
        this.active = active;
        this.sync();
    }

    setTrack(track: MediaStreamTrack | null): void {
        this.track = track;
        this.sync();
    }

    private sync(): void {
        const wanted = this.active ? this.track : null;
        if (wanted === this.attachedTrack) {
            return;
        }
        if (!wanted) {
            this.stop();
        } else if (this.video) {
            this.attachedTrack = wanted;
            this.attachSource(this.video, wanted);
            this.forceKey = true;
        } else {
            this.start(wanted);
        }
    }

    private start(track: MediaStreamTrack): void {
        const env = this.deps.env;
        this.attachedTrack = track;
        this.baseMs = env.now();
        this.frameCount = 0;
        this.forceKey = true;
        try {
            const video = env.createVideoElement();
            video.muted = true;
            video.autoplay = true;
            video.playsInline = true;
            const canvas = env.createCanvas();
            const context = canvas.getContext("2d");
            if (!context) {
                throw new Error("No 2D canvas context.");
            }
            this.video = video;
            this.attachSource(video, track);
            this.timer = env.setInterval(() => this.tick(video, canvas, context), Math.round(1000 / VIDEO_FPS));
        } catch {
            // No usable video element or canvas: video simply isn't relayed.
            this.stop();
        }
    }

    private attachSource(video: VideoElementLike, track: MediaStreamTrack): void {
        video.srcObject = this.deps.env.createMediaStream([track]);
        // Autoplay policy can reject this; a muted, inline video is normally allowed, and a rejection just means no
        // pictures (readyState never advances), which `tick()` already treats as "nothing to send".
        video.play()?.catch(() => undefined);
    }

    private stop(): void {
        this.attachedTrack = null;
        if (this.timer !== undefined) {
            this.deps.env.clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.video) {
            this.video.pause();
            this.video.srcObject = null;
            this.video = undefined;
        }
        this.discardEncoder();
    }

    private discardEncoder(): void {
        const encoder = this.encoder;
        this.encoder = undefined;
        this.encodedWidth = this.encodedHeight = 0;
        safeClose(encoder);
    }

    private tick(video: VideoElementLike, canvas: CanvasLike, context: CanvasContextLike): void {
        if (!this.deps.canSend()) {
            // Nothing is being sent, so whoever starts receiving next needs a key frame to begin with.
            this.forceKey = true;
            return;
        }
        if (video.readyState < HAVE_CURRENT_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
            return;
        }
        const { width, height } = fitSize(video.videoWidth, video.videoHeight);
        const encoder =
            this.encoder && width === this.encodedWidth && height === this.encodedHeight ? this.encoder : this.configureEncoder(width, height);
        if (!encoder || encoder.encodeQueueSize > VIDEO_MAX_ENCODE_QUEUE) {
            return;
        }
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        context.drawImage(video, 0, 0, width, height);
        const keyFrame = this.forceKey || this.frameCount % VIDEO_KEY_FRAME_INTERVAL === 0;
        let frame: VideoFrameLike | undefined;
        try {
            frame = this.deps.env.createVideoFrame(canvas, Math.round((this.deps.env.now() - this.baseMs) * 1000));
            encoder.encode(frame, { keyFrame });
            this.forceKey = false;
            this.frameCount += 1;
        } catch {
            this.discardEncoder();
            this.forceKey = true;
        } finally {
            frame?.close();
        }
    }

    /** (Re)creates the encoder for a `width` x `height` picture. VP8 cannot change size without a key frame, so this
     * always forces one. Returns `undefined` when this browser cannot make the encoder. */
    private configureEncoder(width: number, height: number): EncoderLike<VideoFrameLike, { keyFrame: boolean }> | undefined {
        this.discardEncoder();
        let encoder: EncoderLike<VideoFrameLike, { keyFrame: boolean }> | undefined;
        try {
            encoder = this.deps.env.createVideoEncoder({
                output: (chunk) => this.onChunk(chunk),
                error: () => {
                    // Only the current encoder's failure matters; a stale one was already replaced.
                    if (this.encoder === encoder) {
                        this.discardEncoder();
                        this.forceKey = true;
                    }
                },
            });
            encoder.configure({
                codec: "vp8",
                width,
                height,
                bitrate: VIDEO_BITRATE,
                framerate: VIDEO_FPS,
                latencyMode: "realtime",
            });
        } catch {
            safeClose(encoder);
            return undefined;
        }
        this.encoder = encoder;
        this.encodedWidth = width;
        this.encodedHeight = height;
        this.forceKey = true;
        return encoder;
    }

    private onChunk(chunk: EncodedChunkLike): void {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        if (!this.deps.publish(KIND_VIDEO, chunk.type === "key", bytes, this.baseMs + chunk.timestamp / 1000)) {
            this.forceKey = true;
        }
    }
}
