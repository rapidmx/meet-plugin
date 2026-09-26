///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { TimestampUnwrapper, type Frame } from "./frames.js";
import type { CanvasContextLike, CanvasLike, DecoderLike, RelayEnv, VideoFrameLike } from "./relayEnv.js";
import { safeClose } from "./senderCommon.js";

/** Skip a frame (and wait for the next key frame) when the decoder is this far behind. */
export const VIDEO_MAX_DECODE_QUEUE = 8;
const SEQ_MODULUS = 0x10000;

/**
 * Decodes one sender's VP8 frames and draws them onto a canvas, whose `captureStream()` track is what the rest of
 * the app plays as that participant's video.
 *
 * VP8 is a chain of deltas hanging off key frames, so a decoder fed a delta frame without its predecessor produces
 * garbage or errors. This therefore decodes only from a key frame onward and falls back to waiting for the next one
 * whenever the chain may be broken: a gap in `seq` (a fragment or a whole frame was dropped on the way), the decoder
 * being too far behind, or any decode error. The sender forces a key frame every couple of seconds, which bounds the
 * wait. The decoder is created lazily and discarded on error.
 */
export class VideoPlayer {
    private decoder: DecoderLike | undefined;
    private needKey = true;
    private expectedSeq: number | undefined;
    private readonly timestamps = new TimestampUnwrapper();

    constructor(
        private readonly env: RelayEnv,
        private readonly canvas: CanvasLike,
        private readonly context: CanvasContextLike,
    ) {}

    /** Feeds one reassembled video frame. */
    push(frame: Frame): void {
        if (this.expectedSeq !== undefined && frame.seq !== this.expectedSeq) {
            this.needKey = true;
        }
        this.expectedSeq = (frame.seq + 1) % SEQ_MODULUS;
        if (frame.keyFrame) {
            this.needKey = false;
        } else if (this.needKey) {
            return;
        }
        const decoder = this.decoder ?? this.createDecoder();
        if (!decoder || decoder.decodeQueueSize > VIDEO_MAX_DECODE_QUEUE) {
            this.needKey = true;
            return;
        }
        try {
            decoder.decode(
                this.env.createEncodedVideoChunk({
                    type: frame.keyFrame ? "key" : "delta",
                    timestamp: this.timestamps.next(frame.timestampMs) * 1000,
                    data: frame.data,
                }),
            );
        } catch {
            this.discardDecoder();
        }
    }

    close(): void {
        this.discardDecoder();
    }

    private discardDecoder(): void {
        const decoder = this.decoder;
        this.decoder = undefined;
        this.needKey = true;
        safeClose(decoder);
    }

    private createDecoder(): DecoderLike | undefined {
        let decoder: DecoderLike | undefined;
        try {
            decoder = this.env.createVideoDecoder({
                output: (picture) => this.draw(picture),
                error: () => {
                    // Only the current decoder's failure matters; a stale one was already replaced.
                    if (this.decoder === decoder) {
                        this.discardDecoder();
                    }
                },
            });
            decoder.configure({ codec: "vp8" });
        } catch {
            safeClose(decoder);
            return undefined;
        }
        this.decoder = decoder;
        return decoder;
    }

    /** Draws one decoded picture, resizing the canvas to it. Always closes `picture`. */
    private draw(picture: VideoFrameLike): void {
        try {
            if (this.canvas.width !== picture.displayWidth || this.canvas.height !== picture.displayHeight) {
                this.canvas.width = picture.displayWidth;
                this.canvas.height = picture.displayHeight;
            }
            this.context.drawImage(picture, 0, 0);
        } catch {
            // A picture the canvas will not take is dropped; the next one draws over it anyway.
        } finally {
            picture.close();
        }
    }
}
