///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { MIN_SILENT_RUN_SECONDS, SILENCE_THRESHOLD, SilenceMeter } from "../../../../apps/shared/relay/SilenceMeter.js";

const RATE = 48_000;

/** `ms` milliseconds of `value` at 48 kHz. */
function block(ms: number, value: number): Float32Array {
    return new Float32Array((RATE * ms) / 1000).fill(value);
}

describe("SilenceMeter", () => {
    it("counts nothing before anything is fed", () => {
        const meter = new SilenceMeter();
        expect(meter.totalMs).toBe(0);
        expect(meter.silentMs).toBe(0);
    });

    it("counts noise as sound and digital zero as silence", () => {
        const meter = new SilenceMeter();
        meter.feed(block(20, 0.01), RATE);
        meter.feed(block(10, 0), RATE);
        meter.feed(block(20, -0.01), RATE);
        expect(meter.totalMs).toBeCloseTo(50, 6);
        expect(meter.silentMs).toBeCloseTo(10, 6);
    });

    it("treats anything under the threshold as silent, and anything above it as sound", () => {
        const meter = new SilenceMeter();
        meter.feed(block(10, SILENCE_THRESHOLD / 2), RATE);
        meter.feed(block(10, SILENCE_THRESHOLD * 2), RATE);
        expect(meter.silentMs).toBeCloseTo(10, 6);
    });

    it("ignores runs shorter than the minimum - a waveform crossing zero is not silence", () => {
        const meter = new SilenceMeter();
        const shortMs = MIN_SILENT_RUN_SECONDS * 1000 - 1;
        meter.feed(block(shortMs, 0), RATE);
        meter.feed(block(10, 0.5), RATE);
        expect(meter.silentMs).toBe(0);
    });

    it("counts a run that straddles two blocks in full", () => {
        const meter = new SilenceMeter();
        meter.feed(block(3, 0), RATE);
        meter.feed(block(3, 0), RATE);
        meter.feed(block(1, 0.5), RATE);
        expect(meter.silentMs).toBeCloseTo(6, 6);
    });

    it("includes a long-enough run that is still going", () => {
        const meter = new SilenceMeter();
        meter.feed(block(10, 0.5), RATE);
        meter.feed(block(8, 0), RATE);
        expect(meter.silentMs).toBeCloseTo(8, 6);
    });

    it("ends a run when the sample rate changes, measuring each part at its own rate", () => {
        const meter = new SilenceMeter();
        meter.feed(block(6, 0), RATE);
        meter.feed(new Float32Array(240).fill(0), 24_000);
        expect(meter.totalMs).toBeCloseTo(16, 6);
        expect(meter.silentMs).toBeCloseTo(16, 6);
    });
});
