///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChimeAudioContext, defaultChimeContext, playRaisedHandChime } from "../../../../apps/shared/media/chime.js";

function fakeContext(state = "running") {
    const oscillators: { type: string; frequency: { setValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
    const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    const context = {
        currentTime: 10,
        state,
        destination: "speakers",
        createGain: vi.fn(() => gain),
        createOscillator: vi.fn(() => {
            const oscillator = { type: "", frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
            oscillators.push(oscillator);
            return oscillator;
        }),
        resume: vi.fn(),
        close: vi.fn(),
    };
    return { context: context as unknown as ChimeAudioContext & typeof context, oscillators, gain };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("playRaisedHandChime", () => {
    it("plays two rising notes through one fading gain, then releases the audio context", () => {
        vi.useFakeTimers();
        const { context, oscillators, gain } = fakeContext();
        playRaisedHandChime(() => context);

        expect(oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0])).toEqual([880, 1320]);
        expect(oscillators.every((o) => o.type === "sine" && o.connect.mock.calls[0][0] === gain)).toBe(true);
        expect(oscillators[0].start).toHaveBeenCalledWith(10);
        expect(oscillators[1].start).toHaveBeenCalledWith(expect.closeTo(10.18));
        expect(gain.connect).toHaveBeenCalledWith("speakers");
        expect(context.resume).not.toHaveBeenCalled();
        expect(context.close).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(context.close).toHaveBeenCalledTimes(1);
    });

    it("wakes a suspended context first", () => {
        const { context } = fakeContext("suspended");
        playRaisedHandChime(() => context);
        expect(context.resume).toHaveBeenCalledTimes(1);
    });

    it("does nothing where there is no audio", () => {
        expect(() => playRaisedHandChime(() => undefined)).not.toThrow();
    });

    it("never throws, whatever the audio system does", () => {
        expect(() =>
            playRaisedHandChime(() => {
                throw new Error("audio is broken");
            }),
        ).not.toThrow();
    });
});

describe("defaultChimeContext", () => {
    it("builds the browser's AudioContext, falling back to the prefixed one, and reports none when there is neither", () => {
        class Standard {}
        class Prefixed {}
        vi.stubGlobal("window", { AudioContext: Standard });
        expect(defaultChimeContext()).toBeInstanceOf(Standard);
        vi.stubGlobal("window", { webkitAudioContext: Prefixed });
        expect(defaultChimeContext()).toBeInstanceOf(Prefixed);
        vi.stubGlobal("window", {});
        expect(defaultChimeContext()).toBeUndefined();
    });

    it("reports none outside a browser", () => {
        vi.stubGlobal("window", undefined);
        expect(defaultChimeContext()).toBeUndefined();
    });
});
