///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RelaySendDiagnostics } from "../webrtc/types.js";
import { resumeAudioContext } from "./audioResume.js";
import { KIND_AUDIO } from "./frames.js";
import type {
    AudioContextLike,
    AudioDataLike,
    AudioNodeLike,
    EncodedChunkLike,
    EncoderLike,
    GainLike,
    ScriptProcessorLike,
} from "./relayEnv.js";
import { safeClose, type SenderDeps } from "./senderCommon.js";
import { SilenceMeter } from "./SilenceMeter.js";

export const AUDIO_SAMPLE_RATE = 48_000;
/** Frames per `ScriptProcessorNode` callback: about 43 ms, a compromise between latency and how often the main
 * thread is interrupted. */
export const AUDIO_PROCESS_FRAMES = 2048;
export const AUDIO_BITRATE = 24_000;
/** The Opus frame duration in microseconds (20 ms). */
export const AUDIO_FRAME_DURATION_US = 20_000;
/** Skip a block instead of queueing it when the encoder is this far behind. */
export const AUDIO_MAX_ENCODE_QUEUE = 8;

/**
 * Captures one microphone track and publishes it as Opus.
 *
 * There is exactly one capture path, chosen for being testable and available everywhere the relay is: an
 * `AudioContext` at 48 kHz, a `MediaStreamAudioSourceNode` on the track, and a `ScriptProcessorNode` that receives
 * the raw PCM. (`ScriptProcessorNode` is deprecated in favour of `AudioWorklet`, but it needs no separate module
 * file to load, which a plugin bundle has no good place for, and every browser still supports it.) The processor's
 * output is routed through a zero-gain node to the destination, because browsers only run a processor that is
 * connected to the destination, and the gain stops the microphone playing back locally.
 *
 * It encodes only while sending is active, a track is set and the socket can take the frames, and rebuilds the graph
 * when the track is replaced. The encoder is created lazily and discarded on any error, so a coder that died is
 * replaced at the next block rather than being repaired inside its own error callback.
 */
export class AudioSender {
    private active = false;
    private track: MediaStreamTrack | null = null;
    private attachedTrack: MediaStreamTrack | null = null;

    private ctx: AudioContextLike | undefined;
    private source: AudioNodeLike | undefined;
    private processor: ScriptProcessorLike | undefined;
    private gain: GainLike | undefined;
    private stopResume: (() => void) | undefined;
    private encoder: EncoderLike<AudioDataLike> | undefined;
    private baseMs = 0;
    private samples = 0;

    /** Diagnostics, cumulative across capture sessions: what the capture path delivered (and how much of it was
     * silent), the wall-clock time it was attached for, and what the encoder had to skip. */
    private readonly captured = new SilenceMeter();
    private wallMs = 0;
    private encoderSkippedSamples = 0;

    constructor(private readonly deps: SenderDeps) {}

    /** The capture half of `RelaySendDiagnostics`. */
    captureStats(): Pick<RelaySendDiagnostics, "audioCapturedMs" | "audioCaptureWallMs" | "audioSilentMs" | "audioEncoderSkippedMs"> {
        return {
            audioCapturedMs: this.captured.totalMs,
            audioCaptureWallMs: this.wallMs + (this.attachedTrack ? this.deps.env.now() - this.baseMs : 0),
            audioSilentMs: this.captured.silentMs,
            audioEncoderSkippedMs: (this.encoderSkippedSamples * 1000) / AUDIO_SAMPLE_RATE,
        };
    }

    setActive(active: boolean): void {
        this.active = active;
        this.sync();
    }

    setTrack(track: MediaStreamTrack | null): void {
        this.track = track;
        this.sync();
    }

    /** Brings the capture graph in line with (`active`, `track`): torn down when either is missing, rebuilt when
     * the track changed, untouched otherwise. */
    private sync(): void {
        const wanted = this.active ? this.track : null;
        if (wanted === this.attachedTrack) {
            return;
        }
        this.detach();
        if (wanted) {
            this.attach(wanted);
        }
    }

    private attach(track: MediaStreamTrack): void {
        const env = this.deps.env;
        this.attachedTrack = track;
        this.baseMs = env.now();
        this.samples = 0;
        try {
            const ctx = env.createAudioContext(AUDIO_SAMPLE_RATE);
            this.ctx = ctx;
            const source = ctx.createMediaStreamSource(env.createMediaStream([track]));
            this.source = source;
            const processor = ctx.createScriptProcessor(AUDIO_PROCESS_FRAMES, 1, 1);
            this.processor = processor;
            const gain = ctx.createGain();
            gain.gain.value = 0;
            this.gain = gain;
            processor.onaudioprocess = (event) => this.process(event.inputBuffer.getChannelData(0));
            source.connect(processor);
            processor.connect(gain);
            gain.connect(ctx.destination);
            this.stopResume = resumeAudioContext(ctx, env.document);
        } catch {
            // No usable AudioContext (or a browser that refuses one): audio simply isn't relayed.
            this.detach();
        }
    }

    private detach(): void {
        if (this.attachedTrack) {
            this.wallMs += this.deps.env.now() - this.baseMs;
        }
        this.attachedTrack = null;
        this.stopResume?.();
        this.stopResume = undefined;
        if (this.processor) {
            this.processor.onaudioprocess = null;
        }
        this.source?.disconnect();
        this.processor?.disconnect();
        this.gain?.disconnect();
        this.source = this.processor = this.gain = undefined;
        const ctx = this.ctx;
        this.ctx = undefined;
        // `close()` rejects for a context that is already closed; nothing to do about it.
        ctx?.close().catch(() => undefined);
        this.discardEncoder();
    }

    private discardEncoder(): void {
        const encoder = this.encoder;
        this.encoder = undefined;
        safeClose(encoder);
    }

    private process(input: Float32Array): void {
        const samples = input.length;
        const timestampUs = Math.round((this.samples * 1_000_000) / AUDIO_SAMPLE_RATE);
        this.samples += samples;
        this.captured.feed(input, AUDIO_SAMPLE_RATE);
        if (!this.deps.canSend()) {
            return;
        }
        const encoder = this.encoder ?? this.createEncoder();
        if (!encoder || encoder.encodeQueueSize > AUDIO_MAX_ENCODE_QUEUE) {
            this.encoderSkippedSamples += samples;
            return;
        }
        let audio: AudioDataLike | undefined;
        try {
            // The browser reuses `input` for the next block, so the encoder gets its own copy.
            audio = this.deps.env.createAudioData({
                format: "f32-planar",
                sampleRate: AUDIO_SAMPLE_RATE,
                numberOfFrames: samples,
                numberOfChannels: 1,
                timestamp: timestampUs,
                data: new Float32Array(input),
            });
            encoder.encode(audio);
        } catch {
            this.discardEncoder();
        } finally {
            audio?.close();
        }
    }

    private createEncoder(): EncoderLike<AudioDataLike> | undefined {
        let encoder: EncoderLike<AudioDataLike> | undefined;
        try {
            encoder = this.deps.env.createAudioEncoder({
                output: (chunk) => this.onChunk(chunk),
                error: () => {
                    // Only the current encoder's failure matters; a stale one was already replaced.
                    if (this.encoder === encoder) {
                        this.discardEncoder();
                    }
                },
            });
            encoder.configure({
                codec: "opus",
                sampleRate: AUDIO_SAMPLE_RATE,
                numberOfChannels: 1,
                bitrate: AUDIO_BITRATE,
                opus: { frameDuration: AUDIO_FRAME_DURATION_US },
            });
        } catch {
            safeClose(encoder);
            return undefined;
        }
        this.encoder = encoder;
        return encoder;
    }

    private onChunk(chunk: EncodedChunkLike): void {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        // Every Opus packet decodes on its own, so each is flagged as a key frame.
        this.deps.publish(KIND_AUDIO, true, bytes, this.baseMs + chunk.timestamp / 1000);
    }
}
