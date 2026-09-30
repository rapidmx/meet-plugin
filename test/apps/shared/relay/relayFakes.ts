///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Fakes for the relay tier's browser APIs. jsdom has no WebCodecs, no Web Audio and no canvas capture, so the relay
 * code takes a `RelayEnv` (see `apps/shared/relay/relayEnv.ts`) and these build one out of plain objects that record
 * what was done to them and expose the knobs a test needs - a coder that throws, an event fired by hand, a clock that
 * only moves when told to.
 */
import { vi } from "vitest";
import type {
    AudioBufferLike,
    AudioContextLike,
    AudioDataInit,
    AudioDataLike,
    BufferSourceLike,
    CanvasContextLike,
    CanvasLike,
    CoderInit,
    EncodedChunkLike,
    GainLike,
    RelayEnv,
    RelaySocket,
    ScriptProcessorLike,
    VideoElementLike,
    VideoFrameLike,
} from "../../../../apps/shared/relay/relayEnv.js";
import { fakeMediaStream, fakeTrack } from "../../testUtils.js";

/** A fake WebSocket that behaves as the relay server would when driven by `open()`/`message()`/`triggerClose()`. */
export class FakeSocket implements RelaySocket {
    readyState = 0;
    bufferedAmount = 0;
    binaryType = "blob";
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    /** Everything `send()` was given: strings for text, `Uint8Array` for binary. */
    sent: (string | Uint8Array)[] = [];
    closeCalls: [number | undefined, string | undefined][] = [];
    sendThrows = false;
    closeThrows = false;

    constructor(readonly url: string) {}

    send(data: string | Uint8Array): void {
        if (this.sendThrows) {
            throw new Error("send failed");
        }
        this.sent.push(data);
    }

    close(code?: number, reason?: string): void {
        this.closeCalls.push([code, reason]);
        if (this.closeThrows) {
            throw new Error("close failed");
        }
    }

    /** The text messages sent so far, parsed. */
    texts(): Record<string, unknown>[] {
        return this.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m) as Record<string, unknown>);
    }

    /** The binary messages sent so far. */
    binaries(): Uint8Array[] {
        return this.sent.filter((m): m is Uint8Array => typeof m !== "string");
    }

    /** The connection opens: the client is expected to send its hello. */
    open(): void {
        this.readyState = 1;
        this.onopen?.({});
    }

    /** The server answers the hello; `extra` adds fields such as `maxMessageBytes`. */
    ready(extra: Record<string, unknown> = {}): void {
        this.message(JSON.stringify({ op: "ready", v: 1, ...extra }));
    }

    message(data: unknown): void {
        this.onmessage?.({ data });
    }

    triggerClose(): void {
        this.readyState = 3;
        this.onclose?.({});
    }
}

/** What the server does to a binary message before delivering it: `[N][sender id][payload]`. */
export function relayed(senderId: string, payload: Uint8Array): ArrayBuffer {
    const id = new TextEncoder().encode(senderId);
    const out = new Uint8Array(1 + id.length + payload.length);
    out[0] = id.length;
    out.set(id, 1);
    out.set(payload, 1 + id.length);
    return out.buffer;
}

/** How a coder misbehaves; all off by default. */
export interface CoderBehavior {
    createThrows: boolean;
    configureThrows: boolean;
    useThrows: boolean;
    closeThrows: boolean;
}

function newBehavior(): CoderBehavior {
    return { createThrows: false, configureThrows: false, useThrows: false, closeThrows: false };
}

/** A fake `AudioEncoder`/`AudioDecoder`/`VideoEncoder`/`VideoDecoder`. `inputs` holds whatever was passed to
 * `encode()`/`decode()`. */
export class FakeCoder<TIn = unknown, TOut = unknown> {
    configured: Record<string, unknown>[] = [];
    inputs: TIn[] = [];
    options: unknown[] = [];
    closed = false;
    /** What `encodeQueueSize`/`decodeQueueSize` report. */
    queueSize = 0;

    constructor(
        readonly init: CoderInit<TOut>,
        private readonly behavior: CoderBehavior,
    ) {}

    get encodeQueueSize(): number {
        return this.queueSize;
    }

    get decodeQueueSize(): number {
        return this.queueSize;
    }

    configure(config: Record<string, unknown>): void {
        if (this.behavior.configureThrows) {
            throw new Error("configure failed");
        }
        this.configured.push(config);
    }

    encode(input: TIn, options?: unknown): void {
        this.use(input, options);
    }

    decode(chunk: TIn): void {
        this.use(chunk, undefined);
    }

    close(): void {
        this.closed = true;
        if (this.behavior.closeThrows) {
            throw new Error("already closed");
        }
    }

    /** The coder produces an output. */
    emit(output: TOut): void {
        this.init.output(output);
    }

    /** The coder reports an error. */
    fail(): void {
        this.init.error(new Error("coder error"));
    }

    private use(input: TIn, options: unknown): void {
        if (this.behavior.useThrows) {
            throw new Error("coder closed");
        }
        this.inputs.push(input);
        this.options.push(options);
    }
}

/** An encoder's output. */
export function fakeChunk(bytes: number[] | Uint8Array, type: "key" | "delta" = "key", timestamp = 0): EncodedChunkLike {
    const data = Uint8Array.from(bytes);
    return {
        type,
        timestamp,
        byteLength: data.length,
        copyTo: (destination) => destination.set(data),
    };
}

/** An `AudioData` that a decoder hands back (or one the sender built - see `FakeEnv.audioData`). */
export class FakeAudioData implements AudioDataLike {
    closed = false;
    copyCalls: { planeIndex: number; format?: string }[] = [];
    copyThrows = false;

    constructor(
        readonly numberOfFrames = 960,
        readonly sampleRate = 48_000,
        readonly init?: AudioDataInit,
    ) {}

    copyTo(destination: Float32Array, options: { planeIndex: number; format?: string }): void {
        if (this.copyThrows) {
            throw new Error("copy failed");
        }
        this.copyCalls.push(options);
        destination.fill(0.25);
    }

    close(): void {
        this.closed = true;
    }
}

export class FakeVideoFrame implements VideoFrameLike {
    closed = false;

    constructor(
        readonly displayWidth = 320,
        readonly displayHeight = 240,
        readonly timestampUs = 0,
    ) {}

    close(): void {
        this.closed = true;
    }
}

/** A node with `connect()`/`disconnect()` bookkeeping. */
export class FakeNode {
    connections: unknown[] = [];
    disconnected = false;

    connect(destination: unknown): unknown {
        this.connections.push(destination);
        return destination;
    }

    disconnect(): void {
        this.disconnected = true;
    }
}

export class FakeProcessor extends FakeNode implements ScriptProcessorLike {
    onaudioprocess: ScriptProcessorLike["onaudioprocess"] = null;

    /** The browser delivers a block of microphone samples. */
    run(samples: Float32Array): void {
        this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
    }
}

export class FakeGain extends FakeNode implements GainLike {
    /** `ramps` records every `setValueAtTime()`/`linearRampToValueAtTime()` call, in order, for a test to assert a
     * fade's shape against - `.value` alone (as `AudioSender`'s static mute uses) never touches it. */
    ramps: { method: "setValueAtTime" | "linearRampToValueAtTime"; value: number; time: number }[] = [];
    gain = {
        value: 1,
        setValueAtTime: (value: number, startTime: number) => {
            this.ramps.push({ method: "setValueAtTime", value, time: startTime });
        },
        linearRampToValueAtTime: (value: number, endTime: number) => {
            this.ramps.push({ method: "linearRampToValueAtTime", value, time: endTime });
        },
    };
}

export class FakeBufferSource extends FakeNode implements BufferSourceLike {
    buffer: AudioBufferLike | null = null;
    onended: (() => void) | null = null;
    startedAt: number | undefined;
    start(when?: number): void {
        this.startedAt = when;
    }
}

export class FakeAudioBuffer implements AudioBufferLike {
    channelData: Float32Array | undefined;

    constructor(
        readonly length: number,
        readonly sampleRate: number,
    ) {}

    get duration(): number {
        return this.length / this.sampleRate;
    }

    copyToChannel(source: Float32Array): void {
        this.channelData = source;
    }
}

export class FakeAudioContext implements AudioContextLike {
    state = "running";
    currentTime = 0;
    readonly destination = { kind: "destination" };
    processors: FakeProcessor[] = [];
    gains: FakeGain[] = [];
    sourceNodes: FakeNode[] = [];
    sources: FakeBufferSource[] = [];
    buffers: FakeAudioBuffer[] = [];
    streamDestinations: { stream: MediaStream }[] = [];
    closed = false;
    resume = vi.fn(async () => {
        if (this.resumeRejects) {
            throw new Error("not allowed");
        }
        if (this.resumeMakesRunning) {
            this.state = "running";
        }
    });
    close = vi.fn(async () => {
        this.closed = true;
        if (this.closeRejects) {
            throw new Error("already closed");
        }
    });
    resumeRejects = false;
    resumeMakesRunning = true;
    closeRejects = false;
    createBufferThrows = false;

    constructor(readonly sampleRate: number) {}

    createMediaStreamSource(stream: MediaStream): FakeNode {
        const node = new FakeNode();
        this.sourceNodes.push(node);
        void stream;
        return node;
    }

    createScriptProcessor(): FakeProcessor {
        const node = new FakeProcessor();
        this.processors.push(node);
        return node;
    }

    createGain(): FakeGain {
        const node = new FakeGain();
        this.gains.push(node);
        return node;
    }

    createMediaStreamDestination(): { stream: MediaStream } {
        const destination = { stream: fakeMediaStream([fakeTrack("audio")]) };
        this.streamDestinations.push(destination);
        return destination;
    }

    createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
        if (this.createBufferThrows) {
            throw new Error("bad buffer");
        }
        void channels;
        const buffer = new FakeAudioBuffer(length, sampleRate);
        this.buffers.push(buffer);
        return buffer;
    }

    createBufferSource(): FakeBufferSource {
        const source = new FakeBufferSource();
        this.sources.push(source);
        return source;
    }
}

export class FakeVideoElement implements VideoElementLike {
    muted = false;
    autoplay = false;
    playsInline = false;
    srcObject: unknown = undefined;
    readyState = 4;
    videoWidth = 640;
    videoHeight = 480;
    playCalls = 0;
    pauseCalls = 0;
    /** `"undefined"` mimics a browser whose `play()` returns nothing. */
    playResult: "resolve" | "reject" | "undefined" = "resolve";

    play(): Promise<void> | undefined {
        this.playCalls += 1;
        if (this.playResult === "undefined") {
            return undefined;
        }
        return this.playResult === "reject" ? Promise.reject(new Error("blocked")) : Promise.resolve();
    }

    pause(): void {
        this.pauseCalls += 1;
    }
}

export class FakeCanvas implements CanvasLike {
    width = 300;
    height = 150;
    drawn: { source: unknown; args: number[] }[] = [];
    captureRates: number[] = [];
    readonly context: CanvasContextLike = {
        drawImage: (source: unknown, ...args: number[]) => {
            if (this.drawThrows) {
                throw new Error("draw failed");
            }
            this.drawn.push({ source, args });
        },
    };
    contextAvailable = true;
    drawThrows = false;

    getContext(): CanvasContextLike | null {
        return this.contextAvailable ? this.context : null;
    }

    captureStream(frameRate: number): MediaStream {
        this.captureRates.push(frameRate);
        return fakeMediaStream([fakeTrack("video", "canvas-video")]);
    }
}

/** A fake `document` for the gesture listeners. */
export class FakeEventTarget {
    listeners = new Map<string, Set<() => void>>();

    addEventListener(type: string, listener: () => void): void {
        this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
    }

    removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    /** How many listeners are attached in all. */
    count(): number {
        return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
    }

    emit(type: string): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) {
            listener();
        }
    }
}

/** Everything `createFakeRelayEnv()` builds, for a test to inspect and drive. */
export interface FakeRelayEnv {
    env: RelayEnv;
    sockets: FakeSocket[];
    audioContexts: FakeAudioContext[];
    audioEncoders: FakeCoder<AudioDataLike, EncodedChunkLike>[];
    audioDecoders: FakeCoder<unknown, AudioDataLike>[];
    videoEncoders: FakeCoder<VideoFrameLike, EncodedChunkLike>[];
    videoDecoders: FakeCoder<unknown, VideoFrameLike>[];
    audioData: FakeAudioData[];
    videoFrames: FakeVideoFrame[];
    videos: FakeVideoElement[];
    canvases: FakeCanvas[];
    mediaStreams: { tracks: MediaStreamTrack[]; stream: MediaStream }[];
    encodedAudioChunks: { type: string; timestamp: number; data: Uint8Array }[];
    encodedVideoChunks: { type: string; timestamp: number; data: Uint8Array }[];
    document: FakeEventTarget;
    intervals: Map<number, { callback: () => void; ms: number }>;
    behavior: {
        audioEncoder: CoderBehavior;
        audioDecoder: CoderBehavior;
        videoEncoder: CoderBehavior;
        videoDecoder: CoderBehavior;
        socketThrows: boolean;
        audioContextThrows: boolean;
        audioContextState: string;
        videoElementThrows: boolean;
        canvasHasContext: boolean;
        audioDataThrows: boolean;
        videoFrameThrows: boolean;
        canvasThrows: boolean;
        mediaStreamThrows: boolean;
    };
    clock: { now: number };
    /** Runs every registered interval callback once. */
    tick(times?: number): void;
}

/** Builds a complete `RelayEnv` out of fakes, plus handles to everything it creates. `random` is fixed at 0.5. */
export function createFakeRelayEnv(): FakeRelayEnv {
    let nextInterval = 1;
    const fake: FakeRelayEnv = {
        sockets: [],
        audioContexts: [],
        audioEncoders: [],
        audioDecoders: [],
        videoEncoders: [],
        videoDecoders: [],
        audioData: [],
        videoFrames: [],
        videos: [],
        canvases: [],
        mediaStreams: [],
        encodedAudioChunks: [],
        encodedVideoChunks: [],
        document: new FakeEventTarget(),
        intervals: new Map(),
        behavior: {
            audioEncoder: newBehavior(),
            audioDecoder: newBehavior(),
            videoEncoder: newBehavior(),
            videoDecoder: newBehavior(),
            socketThrows: false,
            audioContextThrows: false,
            audioContextState: "running",
            videoElementThrows: false,
            canvasHasContext: true,
            audioDataThrows: false,
            videoFrameThrows: false,
            canvasThrows: false,
            mediaStreamThrows: false,
        },
        clock: { now: 1000 },
        tick(times = 1) {
            for (let i = 0; i < times; i++) {
                for (const { callback } of [...fake.intervals.values()]) {
                    callback();
                }
            }
        },
        env: undefined as unknown as RelayEnv,
    };
    const coder = <TIn, TOut>(list: FakeCoder<TIn, TOut>[], behavior: CoderBehavior, init: CoderInit<TOut>): FakeCoder<TIn, TOut> => {
        if (behavior.createThrows) {
            throw new Error("unsupported");
        }
        const created = new FakeCoder<TIn, TOut>(init, behavior);
        list.push(created);
        return created;
    };
    fake.env = {
        createSocket: (url) => {
            if (fake.behavior.socketThrows) {
                throw new Error("socket refused");
            }
            const socket = new FakeSocket(url);
            fake.sockets.push(socket);
            return socket;
        },
        createAudioContext: (sampleRate) => {
            if (fake.behavior.audioContextThrows) {
                throw new Error("no audio context");
            }
            const ctx = new FakeAudioContext(sampleRate);
            ctx.state = fake.behavior.audioContextState;
            fake.audioContexts.push(ctx);
            return ctx;
        },
        createMediaStream: (tracks) => {
            if (fake.behavior.mediaStreamThrows) {
                throw new Error("no media stream");
            }
            const stream = fakeMediaStream(tracks);
            fake.mediaStreams.push({ tracks, stream });
            return stream;
        },
        createVideoElement: () => {
            if (fake.behavior.videoElementThrows) {
                throw new Error("no video element");
            }
            const video = new FakeVideoElement();
            fake.videos.push(video);
            return video;
        },
        createCanvas: () => {
            if (fake.behavior.canvasThrows) {
                throw new Error("no canvas");
            }
            const canvas = new FakeCanvas();
            canvas.contextAvailable = fake.behavior.canvasHasContext;
            fake.canvases.push(canvas);
            return canvas;
        },
        createAudioEncoder: (init) => coder(fake.audioEncoders, fake.behavior.audioEncoder, init),
        createAudioDecoder: (init) => coder(fake.audioDecoders, fake.behavior.audioDecoder, init),
        createVideoEncoder: (init) => coder(fake.videoEncoders, fake.behavior.videoEncoder, init),
        createVideoDecoder: (init) => coder(fake.videoDecoders, fake.behavior.videoDecoder, init),
        createAudioData: (init) => {
            if (fake.behavior.audioDataThrows) {
                throw new Error("bad audio data");
            }
            const data = new FakeAudioData(init.numberOfFrames, init.sampleRate, init);
            fake.audioData.push(data);
            return data;
        },
        createVideoFrame: (canvas, timestampUs) => {
            if (fake.behavior.videoFrameThrows) {
                throw new Error("bad frame");
            }
            const frame = new FakeVideoFrame(canvas.width, canvas.height, timestampUs);
            fake.videoFrames.push(frame);
            return frame;
        },
        createEncodedAudioChunk: (init) => {
            fake.encodedAudioChunks.push(init);
            return init;
        },
        createEncodedVideoChunk: (init) => {
            fake.encodedVideoChunks.push(init);
            return init;
        },
        document: fake.document,
        setInterval: (callback, ms) => {
            const id = nextInterval++;
            fake.intervals.set(id, { callback, ms });
            return id;
        },
        clearInterval: (handle) => {
            fake.intervals.delete(handle as number);
        },
        now: () => fake.clock.now,
        random: () => 0.5,
    };
    return fake;
}

/** A `fakeTrack()` with a stable identity for assertions. */
export function track(kind: "audio" | "video", id = `${kind}-track`): MediaStreamTrack {
    return fakeTrack(kind, id);
}

/** The last element (`Array.prototype.at` is newer than the ES2020 library this project compiles against). */
export function last<T>(list: readonly T[]): T | undefined {
    return list[list.length - 1];
}
