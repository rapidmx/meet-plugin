///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RelayReceiveDiagnostics } from "../webrtc/types.js";
import { TimestampUnwrapper, type Frame } from "./frames.js";
import type { AudioContextLike, AudioDataLike, DecoderLike, RelayEnv } from "./relayEnv.js";
import { safeClose } from "./senderCommon.js";
import { SilenceMeter } from "./SilenceMeter.js";

/** The playback half of `RelayReceiveDiagnostics.audio`. */
export type AudioPlaybackStats = Pick<RelayReceiveDiagnostics["audio"], "playedMs" | "silentMs" | "gaps" | "gapMs" | "droppedLate" | "bufferedMs">;

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
/** The length of the fade-in `play()` gives a block that doesn't pick up exactly where the last one left off (the
 * first block, or the one after a gap) - long enough to mask the click such a discontinuity would otherwise
 * produce, short enough that it is never heard as an actual fade. */
export const DISCONTINUITY_FADE_SECONDS = 0.004;

/**
 * Decodes one sender's Opus packets and schedules them for playback into a `MediaStreamAudioDestinationNode`.
 *
 * Each decoded block is copied into an `AudioBuffer` and started on its own `AudioBufferSourceNode` at
 * `max(currentTime + jitter, nextTime)`, where `nextTime` is when the previous block ends - so consecutive blocks
 * join seamlessly, and after a gap in the stream playback restarts with the jitter buffer's worth of headroom.
 * Opus packets are independently decodable, so a lost packet costs only its own 20 ms and needs no recovery step
 * *in terms of content* - but the shared decoder (reused across packets so it keeps its normal state between them,
 * not recreated per packet) is never told a packet was skipped, so its internal prediction state no longer matches
 * what it decodes next. Audibly this can be a click right at that seam, not just silence where the lost packet
 * would have been - the same is true of the very first block (nothing at all came before it) and of the block
 * after a stall long enough to need the jitter buffer's full headroom again. `play()` gives exactly those blocks a
 * few milliseconds' fade-in (`DISCONTINUITY_FADE_SECONDS`) through a `GainNode` to mask it; an ordinary block that
 * picks up exactly where the last one ended gets none - fading *every* block would itself be audible, a faint
 * tremolo at the packet rate. The decoder is created lazily and discarded on any error, and replaced by the next
 * packet.
 */
export class AudioPlayer {
    private decoder: DecoderLike | undefined;
    private nextTime = 0;
    private readonly timestamps = new TimestampUnwrapper();
    private readonly played = new SilenceMeter();
    private gaps = 0;
    private gapSeconds = 0;
    private droppedLate = 0;

    /** `destination` is the node whose stream the peer's `MediaStream` carries. */
    constructor(
        private readonly env: RelayEnv,
        private readonly ctx: AudioContextLike,
        private readonly destination: unknown,
    ) {}

    /** What playback has done so far - see `RelayReceiveDiagnostics`. */
    stats(): AudioPlaybackStats {
        return {
            playedMs: this.played.totalMs,
            silentMs: this.played.silentMs,
            gaps: this.gaps,
            gapMs: this.gapSeconds * 1000,
            droppedLate: this.droppedLate,
            bufferedMs: Math.max(0, this.nextTime - this.ctx.currentTime) * 1000,
        };
    }

    /** Feeds one reassembled audio frame (one Opus packet). */
    push(frame: Frame): void {
        const decoder = this.decoder ?? this.createDecoder();
        if (!decoder || decoder.decodeQueueSize > AUDIO_MAX_DECODE_QUEUE) {
            this.droppedLate += 1;
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
                this.droppedLate += 1;
                return;
            }
            const buffer = this.ctx.createBuffer(1, data.numberOfFrames, data.sampleRate);
            const pcm = new Float32Array(data.numberOfFrames);
            data.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
            buffer.copyToChannel(pcm, 0);
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            const start = Math.max(now + JITTER_BUFFER_SECONDS, this.nextTime);
            if (start > this.nextTime) {
                // A gap, not a continuation - the decoder's state no longer matches what it's about to decode (see
                // this class's doc comment), so fade this block in rather than let it start abruptly.
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0, start);
                gain.gain.linearRampToValueAtTime(1, start + DISCONTINUITY_FADE_SECONDS);
                source.connect(gain);
                gain.connect(this.destination);
                source.onended = () => {
                    source.disconnect();
                    gain.disconnect();
                };
            } else {
                source.connect(this.destination);
                source.onended = () => source.disconnect();
            }
            source.start(start);
            this.played.feed(pcm, data.sampleRate);
            if (start > this.nextTime && this.nextTime > 0) {
                // Playback ran dry: everything between the end of the last block and this one is silence.
                this.gaps += 1;
                this.gapSeconds += start - this.nextTime;
            }
            this.nextTime = start + buffer.duration;
        } catch {
            // A block the browser will not take (an odd sample rate, a closed context) is dropped like a lost packet.
        } finally {
            data.close();
        }
    }
}
