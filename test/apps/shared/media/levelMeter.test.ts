///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AnalyserNodeLike, type AudioContextLike, defaultAudioContextFactory, startLevelMeter } from "../../../../apps/shared/media/levelMeter.js";

function track(kind: "audio" | "video" = "audio"): MediaStreamTrack {
    return { kind } as unknown as MediaStreamTrack;
}

function stream(tracks: MediaStreamTrack[]): MediaStream {
    return { getAudioTracks: () => tracks.filter((t) => t.kind === "audio") } as unknown as MediaStream;
}

/** A fake analyser whose `getByteTimeDomainData` fills the buffer with a constant value - `128` is silence (the
 * midpoint `levelMeter.ts` measures deviation from), anything else is "sound". */
function fakeAnalyser(fillValue: number): AnalyserNodeLike {
    return {
        fftSize: 512,
        getByteTimeDomainData(array: Uint8Array) {
            array.fill(fillValue);
        },
    };
}

describe("defaultAudioContextFactory", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns undefined when there is no window (this test's own node environment)", () => {
        expect(defaultAudioContextFactory()).toBeUndefined();
    });

    it("returns undefined when window exists but has neither AudioContext nor webkitAudioContext", () => {
        vi.stubGlobal("window", {});
        expect(defaultAudioContextFactory()).toBeUndefined();
    });

    it("wraps window.AudioContext when present", () => {
        class FakeAudioContext {}
        vi.stubGlobal("window", { AudioContext: FakeAudioContext });
        const factory = defaultAudioContextFactory();
        expect(factory!()).toBeInstanceOf(FakeAudioContext);
    });

    it("falls back to window.webkitAudioContext when AudioContext is absent", () => {
        class FakeWebkitAudioContext {}
        vi.stubGlobal("window", { webkitAudioContext: FakeWebkitAudioContext });
        const factory = defaultAudioContextFactory();
        expect(factory!()).toBeInstanceOf(FakeWebkitAudioContext);
    });
});

describe("startLevelMeter", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns undefined without a factory", () => {
        expect(startLevelMeter(stream([track()]), vi.fn(), { factory: undefined })).toBeUndefined();
    });

    it("returns undefined when the stream has no audio track", () => {
        const factory = vi.fn();
        expect(startLevelMeter(stream([track("video")]), vi.fn(), { factory })).toBeUndefined();
        expect(factory).not.toHaveBeenCalled();
    });

    it("uses the default sampling interval when none is given", () => {
        const analyser = fakeAnalyser(128);
        const context: AudioContextLike = {
            createAnalyser: () => analyser,
            createMediaStreamSource: () => ({ connect: vi.fn() }),
            close: vi.fn(),
        };
        const onLevel = vi.fn();
        const handle = startLevelMeter(stream([track()]), onLevel, { factory: () => context })!;
        vi.advanceTimersByTime(199);
        expect(onLevel).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onLevel).toHaveBeenCalledTimes(1);
        handle.stop();
    });

    it("reports silence as level 0", () => {
        const analyser = fakeAnalyser(128);
        const context: AudioContextLike = {
            createAnalyser: () => analyser,
            createMediaStreamSource: () => ({ connect: vi.fn() }),
            close: vi.fn(),
        };
        const onLevel = vi.fn();
        const handle = startLevelMeter(stream([track()]), onLevel, { factory: () => context, intervalMs: 100 });
        expect(handle).toBeDefined();
        vi.advanceTimersByTime(100);
        expect(onLevel).toHaveBeenCalledWith(0);
        handle!.stop();
    });

    it("reports a positive level for a loud sample, and stop() releases the context", () => {
        const analyser = fakeAnalyser(255);
        const context: AudioContextLike = {
            createAnalyser: () => analyser,
            createMediaStreamSource: () => ({ connect: vi.fn() }),
            close: vi.fn(),
        };
        const onLevel = vi.fn();
        const handle = startLevelMeter(stream([track()]), onLevel, { factory: () => context, intervalMs: 100 })!;
        vi.advanceTimersByTime(100);
        expect(onLevel.mock.calls[0][0]).toBeGreaterThan(0);
        handle.stop();
        expect(context.close).toHaveBeenCalledTimes(1);
        // stop() is idempotent, and no further sampling happens after it.
        handle.stop();
        expect(context.close).toHaveBeenCalledTimes(1);
        onLevel.mockClear();
        vi.advanceTimersByTime(1000);
        expect(onLevel).not.toHaveBeenCalled();
    });
});
