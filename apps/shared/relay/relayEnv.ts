///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Every browser API the relay tier touches, gathered behind one injectable object.
 *
 * WebCodecs, Web Audio and canvas capture are exactly the surfaces jsdom does not have, and the sender and
 * receiver need a lot of them at once, so instead of patching a dozen globals in each test (and reading `globalThis`
 * all over the implementation) the code takes a `RelayEnv` and `detectRelayEnv()` builds the real one. The interfaces
 * here are deliberately the narrowest structural subset the relay actually calls - they are satisfied by the real
 * browser objects, and small enough that a test's fake is a few lines.
 */

/** The half of an encoded chunk (`EncodedAudioChunk`/`EncodedVideoChunk`) an encoder's output callback reads. */
export interface EncodedChunkLike {
    readonly type: "key" | "delta";
    /** Microseconds, as given to the encoder. */
    readonly timestamp: number;
    readonly byteLength: number;
    copyTo(destination: Uint8Array): void;
}

export interface CoderInit<T> {
    output: (output: T, metadata?: unknown) => void;
    error: (error: Error) => void;
}

/** `AudioData`. */
export interface AudioDataLike {
    readonly numberOfFrames: number;
    readonly sampleRate: number;
    copyTo(destination: Float32Array, options: { planeIndex: number; format?: string }): void;
    close(): void;
}

export interface AudioDataInit {
    format: "f32-planar";
    sampleRate: number;
    numberOfFrames: number;
    numberOfChannels: number;
    timestamp: number;
    data: Float32Array;
}

/** `VideoFrame`. */
export interface VideoFrameLike {
    readonly displayWidth: number;
    readonly displayHeight: number;
    close(): void;
}

export interface EncoderLike<TInput, TOptions = undefined> {
    readonly encodeQueueSize: number;
    configure(config: Record<string, unknown>): void;
    encode(input: TInput, options?: TOptions): void;
    close(): void;
}

export interface DecoderLike {
    readonly decodeQueueSize: number;
    configure(config: Record<string, unknown>): void;
    decode(chunk: unknown): void;
    close(): void;
}

export interface AudioNodeLike {
    connect(destination: unknown): unknown;
    disconnect(): void;
}

export interface ScriptProcessorLike extends AudioNodeLike {
    onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
}

export interface GainLike extends AudioNodeLike {
    gain: { value: number };
}

export interface AudioBufferLike {
    copyToChannel(source: Float32Array, channel: number): void;
    readonly duration: number;
}

export interface BufferSourceLike extends AudioNodeLike {
    buffer: AudioBufferLike | null;
    onended: (() => void) | null;
    start(when?: number): void;
}

export interface AudioContextLike {
    readonly state: string;
    readonly currentTime: number;
    readonly destination: unknown;
    createMediaStreamSource(stream: MediaStream): AudioNodeLike;
    createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number): ScriptProcessorLike;
    createGain(): GainLike;
    createMediaStreamDestination(): { readonly stream: MediaStream };
    createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
    createBufferSource(): BufferSourceLike;
    resume(): Promise<void>;
    close(): Promise<void>;
}

export interface CanvasContextLike {
    drawImage(source: unknown, dx: number, dy: number, dw?: number, dh?: number): void;
}

/** A hidden `<canvas>`. */
export interface CanvasLike {
    width: number;
    height: number;
    getContext(type: "2d"): CanvasContextLike | null;
    captureStream(frameRate: number): MediaStream;
}

/** A hidden `<video>`. */
export interface VideoElementLike {
    muted: boolean;
    autoplay: boolean;
    playsInline: boolean;
    srcObject: unknown;
    readonly readyState: number;
    readonly videoWidth: number;
    readonly videoHeight: number;
    play(): Promise<void> | undefined;
    pause(): void;
}

/** The subset of `WebSocket` the relay client uses (the same seam shape `GuestSignalingClient`'s `PushSocket` has). */
export interface RelaySocket {
    readyState: number;
    /** Bytes queued by `send()` that the browser has not yet handed to the network - the backpressure signal. */
    readonly bufferedAmount: number;
    binaryType: string;
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

/** What `resumeAudioContext()` needs from `document`. */
export interface EventTargetLike {
    addEventListener(type: string, listener: () => void, options?: boolean): void;
    removeEventListener(type: string, listener: () => void, options?: boolean): void;
}

export interface RelayEnv {
    createSocket(url: string): RelaySocket;
    /** `new AudioContext({ sampleRate })`. */
    createAudioContext(sampleRate: number): AudioContextLike;
    createMediaStream(tracks: MediaStreamTrack[]): MediaStream;
    createVideoElement(): VideoElementLike;
    createCanvas(): CanvasLike;
    createAudioEncoder(init: CoderInit<EncodedChunkLike>): EncoderLike<AudioDataLike>;
    createAudioDecoder(init: CoderInit<AudioDataLike>): DecoderLike;
    createVideoEncoder(init: CoderInit<EncodedChunkLike>): EncoderLike<VideoFrameLike, { keyFrame: boolean }>;
    createVideoDecoder(init: CoderInit<VideoFrameLike>): DecoderLike;
    createAudioData(init: AudioDataInit): AudioDataLike;
    /** `new VideoFrame(canvas, { timestamp })`. */
    createVideoFrame(canvas: CanvasLike, timestampUs: number): VideoFrameLike;
    createEncodedAudioChunk(init: { type: "key" | "delta"; timestamp: number; data: Uint8Array }): unknown;
    createEncodedVideoChunk(init: { type: "key" | "delta"; timestamp: number; data: Uint8Array }): unknown;
    document: EventTargetLike;
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    /** A monotonic clock in milliseconds (`performance.now()`). */
    now(): number;
    random(): number;
}

/** The names of the globals `detectRelayEnv()` requires, in one place so the check and the tests agree. */
export const REQUIRED_GLOBALS = [
    "WebSocket",
    "AudioEncoder",
    "AudioDecoder",
    "VideoEncoder",
    "VideoDecoder",
    "AudioData",
    "VideoFrame",
    "EncodedAudioChunk",
    "EncodedVideoChunk",
    "AudioContext",
    "MediaStream",
    "HTMLCanvasElement",
    "document",
] as const;

/**
 * Builds the real environment from the browser's globals, or returns `undefined` when this browser lacks any
 * piece of it (no WebSocket, no WebCodecs, no `AudioContext`, no `canvas.captureStream`, or not a browser at all).
 * The relay codecs are fixed (Opus and VP8), so there is nothing useful to do with a partial environment - the
 * mesh simply never falls back to the relay on such a browser.
 */
export function detectRelayEnv(): RelayEnv | undefined {
    const scope = globalThis as unknown as Record<string, unknown>;
    for (const name of REQUIRED_GLOBALS) {
        if (typeof scope[name] === "undefined") {
            return undefined;
        }
    }
    if (typeof HTMLCanvasElement.prototype.captureStream !== "function") {
        return undefined;
    }
    // Each factory resolves its constructor when called (not once here) so the environment follows whatever the page
    // has at that moment, and so a test can stub a constructor after detection.
    const construct = (name: string, ...args: unknown[]): never => new (scope[name] as new (...a: unknown[]) => never)(...args);
    return {
        createSocket: (url) => construct("WebSocket", url),
        createAudioContext: (sampleRate) => construct("AudioContext", { sampleRate }),
        createMediaStream: (tracks) => construct("MediaStream", tracks),
        createVideoElement: () => document.createElement("video"),
        createCanvas: () => document.createElement("canvas"),
        createAudioEncoder: (init) => construct("AudioEncoder", init),
        createAudioDecoder: (init) => construct("AudioDecoder", init),
        createVideoEncoder: (init) => construct("VideoEncoder", init),
        createVideoDecoder: (init) => construct("VideoDecoder", init),
        createAudioData: (init) => construct("AudioData", init),
        createVideoFrame: (canvas, timestamp) => construct("VideoFrame", canvas, { timestamp }),
        createEncodedAudioChunk: (init) => construct("EncodedAudioChunk", init),
        createEncodedVideoChunk: (init) => construct("EncodedVideoChunk", init),
        document,
        setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
        clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
        now: () => performance.now(),
        random: () => Math.random(),
    };
}
