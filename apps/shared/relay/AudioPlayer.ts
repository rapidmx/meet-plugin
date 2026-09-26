///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { TimestampUnwrapper, type Frame } from "./frames.js";
import type { AudioContextLike, AudioDataLike, DecoderLike, RelayEnv } from "./relayEnv.js";
import { safeClose } from "./senderCommon.js";

export const PLAYBACK_SAMPLE_RATE = 48_000;
/** How far ahead of the clock the first packet after a start or an underrun is scheduled. It is the jitter buffer:
 * packets arriving up to this late (relative to their neighbours) still play in order without a gap. */
export const JITTER_BUFFER_SECONDS = 0.08;
/** If scheduled audio already runs this far past the clock the receiver has fallen behind (a burst, or the sender's
 * clock running fast), so further packets are dropped until playback catches up - better a brief skip than latency
 * that keeps growing. */
export const MAX_AHEAD_SECONDS = 0.4;
/** Skip a packet instead of queueing it when the decoder is this far behind. */
export const AUDIO_MAX_DECODE_QUEUE = 16;

/**
 * Decodes one sender's Opus packets and schedules them for playback into a `MediaStreamAudioDestinationNode`.
 *
 * Each decoded block is copied into an `AudioBuffer` and started on its own `AudioBufferSourceNode` at
 * `max(currentTime + jitter, nextTime)`, where `nextTime` is when the previous block ends - so consecutive blocks
 * join seamlessly, and after a gap in the stream playback restarts with the jitter buffer's worth of headroom.
 * Opus packets are independently decodable, so a lost packet costs only its own 20 ms and needs no recovery step;
 * the decoder is created lazily and discarded on any error, and replaced by the next packet.
 */
export class AudioPlayer {
    private decoder: DecoderLike | undefined;
    private nextTime = 0;
    private readonly timestamps = new TimestampUnwrapper();

    /** `destination` is the node whose stream the peer's `MediaStream` carries. */
    constructor(
        private readonly env: RelayEnv,
        private readonly ctx: AudioContextLike,
        private readonly destination: unknown,
    ) {}

    /** Feeds one reassembled audio frame (one Opus packet). */
    push(frame: Frame): void {
        const decoder = this.decoder ?? this.createDecoder();
        if (!decoder || decoder.decodeQueueSize > AUDIO_MAX_DECODE_QUEUE) {
            return;
        }
        try {
            decoder.decode(
                this.env.createEncodedAudioChunk({ type: "key", timestamp: this.timestamps.next(frame.timestampMs) * 1000, data: frame.data }),
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
        safeClose(decoder);
    }

    private createDecoder(): DecoderLike | undefined {
        let decoder: DecoderLike | undefined;
        try {
            decoder = this.env.createAudioDecoder({
                output: (data) => this.play(data),
                error: () => {
                    // Only the current decoder's failure matters; a stale one was already replaced.
                    if (this.decoder === decoder) {
                        this.discardDecoder();
                    }
                },
            });
            decoder.configure({ codec: "opus", sampleRate: PLAYBACK_SAMPLE_RATE, numberOfChannels: 1 });
        } catch {
            safeClose(decoder);
            return undefined;
        }
        this.decoder = decoder;
        return decoder;
    }

    /** Schedules one decoded block. Always closes `data`. */
    private play(data: AudioDataLike): void {
        try {
            const now = this.ctx.currentTime;
            if (this.nextTime - now > MAX_AHEAD_SECONDS) {
                return;
            }
            const buffer = this.ctx.createBuffer(1, data.numberOfFrames, data.sampleRate);
            const pcm = new Float32Array(data.numberOfFrames);
            data.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
            buffer.copyToChannel(pcm, 0);
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(this.destination);
            source.onended = () => source.disconnect();
            const start = Math.max(now + JITTER_BUFFER_SECONDS, this.nextTime);
            source.start(start);
            this.nextTime = start + buffer.duration;
        } catch {
            // A block the browser will not take (an odd sample rate, a closed context) is dropped like a lost packet.
        } finally {
            data.close();
        }
    }
}
