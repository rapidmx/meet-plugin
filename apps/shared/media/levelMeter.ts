///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * `Web Audio API` `AnalyserNode` wiring for a per-track volume meter - the browser-glue half of active-speaker
 * detection; `activeSpeaker.ts` holds the actual selection logic as plain, DOM-free functions over the numbers
 * this module produces. Every browser constructor is behind an injectable factory, so a test never needs a real
 * `AudioContext`.
 */

/** The subset of `AnalyserNode` this module uses - what a test's fake implements. */
export interface AnalyserNodeLike {
    fftSize: number;
    getByteTimeDomainData(array: Uint8Array): void;
}

/** The subset of `AudioContext` this module uses. */
export interface AudioContextLike {
    createAnalyser(): AnalyserNodeLike;
    createMediaStreamSource(stream: MediaStream): { connect(node: AnalyserNodeLike): void };
    close(): Promise<void> | void;
}

export type AudioContextFactory = () => AudioContextLike;

/** The real `AudioContext`/`webkitAudioContext` constructor, or `undefined` where there is none (SSR, a browser
 * with no Web Audio support). Resolved lazily - never at module scope - so importing this module is SSR-safe. */
export function defaultAudioContextFactory(): AudioContextFactory | undefined {
    if (typeof window === "undefined") {
        return undefined;
    }
    const Ctor: (new () => AudioContextLike) | undefined =
        (window as unknown as { AudioContext?: new () => AudioContextLike }).AudioContext ??
        (window as unknown as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
    return Ctor ? () => new Ctor() : undefined;
}

export interface LevelMeterHandle {
    /** Stops polling and releases the `AudioContext` - idempotent. */
    stop(): void;
}

/** How often the meter samples and reports a level, in milliseconds. Fast enough to feel responsive for
 * active-speaker switching without generating excessive React state churn. */
export const DEFAULT_LEVEL_METER_INTERVAL_MS = 200;

/**
 * Starts reporting `stream`'s audio level (0-100, a simple mean-absolute-deviation-from-silence over each sample
 * window - not true RMS/dBFS, deliberately: this is a threshold heuristic, not a metering instrument) to `onLevel`
 * every `intervalMs`. Returns `undefined` (nothing started) when there is no usable `AudioContext` or `stream` has
 * no audio track to measure - a caller treats that the same as "can't tell, don't auto-switch on this stream".
 */
export function startLevelMeter(
    stream: MediaStream,
    onLevel: (level: number) => void,
    options: { factory?: AudioContextFactory; intervalMs?: number } = {},
): LevelMeterHandle | undefined {
    const factory: AudioContextFactory | undefined = options.factory ?? defaultAudioContextFactory();
    if (!factory || stream.getAudioTracks().length === 0) {
        return undefined;
    }
    const context: AudioContextLike = factory();
    const analyser: AnalyserNodeLike = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);

    const timer: ReturnType<typeof setInterval> = setInterval(() => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            sum += Math.abs(buffer[i] - 128);
        }
        // The maximum possible mean deviation from the 128 midpoint is 128 (a square wave at full scale) -
        // normalized to a friendlier 0-100 range, matching `activeSpeaker.ts`'s `DEFAULT_ACTIVE_SPEAKER_THRESHOLD`.
        onLevel(Math.min(100, (sum / buffer.length / 128) * 100));
    }, options.intervalMs ?? DEFAULT_LEVEL_METER_INTERVAL_MS);

    let stopped = false;
    return {
        stop: () => {
            if (stopped) {
                return;
            }
            stopped = true;
            clearInterval(timer);
            void context.close();
        },
    };
}
