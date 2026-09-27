///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    applyGrayscale,
    applyNightVision,
    applySepia,
    maskToAlpha,
} from "../../../../../apps/shared/media/filters/pixelEffects.js";

/** One RGBA pixel per argument. */
function pixels(...rgba: [number, number, number, number][]): Uint8ClampedArray {
    return Uint8ClampedArray.from(rgba.flat());
}

describe("applyGrayscale", () => {
    it("sets r, g and b to the Rec. 601 luma and leaves alpha alone", () => {
        const data = pixels([100, 150, 200, 77]);
        applyGrayscale(data);
        const y = Math.round(0.299 * 100 + 0.587 * 150 + 0.114 * 200);
        expect(Array.from(data)).toEqual([y, y, y, 77]);
    });

    it("keeps white and black as they are", () => {
        const data = pixels([255, 255, 255, 255], [0, 0, 0, 0]);
        applyGrayscale(data);
        expect(Array.from(data)).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
    });

    it("treats green as brighter than red, and red as brighter than blue", () => {
        const data = pixels([255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]);
        applyGrayscale(data);
        expect(data[0]).toBe(76);
        expect(data[4]).toBe(150);
        expect(data[8]).toBe(29);
    });

    it("does nothing to an empty buffer", () => {
        const data = new Uint8ClampedArray(0);
        applyGrayscale(data);
        expect(data.length).toBe(0);
    });
});

describe("applySepia", () => {
    it("applies the sepia matrix and leaves alpha alone", () => {
        const data = pixels([100, 100, 100, 9]);
        applySepia(data);
        expect(Array.from(data)).toEqual([
            Math.round(100 * (0.393 + 0.769 + 0.189)),
            Math.round(100 * (0.349 + 0.686 + 0.168)),
            Math.round(100 * (0.272 + 0.534 + 0.131)),
            9,
        ]);
    });

    it("clamps channels that overflow 255", () => {
        const data = pixels([255, 255, 255, 255]);
        applySepia(data);
        // 255 * 1.351 and 255 * 1.203 overflow; 255 * 0.937 = 238.9 does not.
        expect(Array.from(data)).toEqual([255, 255, 239, 255]);
    });

    it("keeps black black", () => {
        const data = pixels([0, 0, 0, 255]);
        applySepia(data);
        expect(Array.from(data)).toEqual([0, 0, 0, 255]);
    });

    it("computes every channel from the original pixel, not from already-changed channels", () => {
        const data = pixels([200, 0, 0, 255]);
        applySepia(data);
        expect(Array.from(data)).toEqual([Math.round(200 * 0.393), Math.round(200 * 0.349), Math.round(200 * 0.272), 255]);
    });
});

describe("applyNightVision", () => {
    it("makes a green-tinted, brightened picture and leaves alpha alone", () => {
        const data = pixels([100, 100, 100, 42]);
        applyNightVision(data);
        const y = 100 * 1.4;
        expect(Array.from(data)).toEqual([Math.round(y * 0.25), Math.round(y), Math.round(y * 0.25), 42]);
    });

    it("clamps the green channel at 255 for a bright pixel", () => {
        const data = pixels([255, 255, 255, 255]);
        applyNightVision(data);
        // luma 255 * 1.4 = 357: green clamps to 255, red and blue are 357 * 0.25 = 89.25.
        expect(Array.from(data)).toEqual([89, 255, 89, 255]);
    });

    it("keeps black black", () => {
        const data = pixels([0, 0, 0, 255]);
        applyNightVision(data);
        expect(Array.from(data)).toEqual([0, 0, 0, 255]);
    });
});

describe("maskToAlpha", () => {
    it("is fully transparent at and below the low threshold", () => {
        const rgba = new Uint8ClampedArray(12).fill(9);
        maskToAlpha(Float32Array.from([0, 0.3, -1]), rgba);
        expect([rgba[3], rgba[7], rgba[11]]).toEqual([0, 0, 0]);
    });

    it("is fully opaque at and above the high threshold", () => {
        const rgba = new Uint8ClampedArray(12);
        maskToAlpha(Float32Array.from([0.7, 1, 5]), rgba);
        expect([rgba[3], rgba[7], rgba[11]]).toEqual([255, 255, 255]);
    });

    it("is half-opaque at the midpoint of the smoothstep", () => {
        const rgba = new Uint8ClampedArray(4);
        maskToAlpha(Float32Array.from([0.5]), rgba);
        expect(rgba[3]).toBe(128);
    });

    it("follows the smoothstep between the thresholds", () => {
        const rgba = new Uint8ClampedArray(4);
        // t = 0.25 -> 0.25^2 * (3 - 0.5) = 0.15625; float32(0.4) is a hair off 0.4, hence the tolerance.
        maskToAlpha(Float32Array.from([0.4]), rgba);
        expect(rgba[3]).toBeCloseTo(0.15625 * 255, 0);
        maskToAlpha(Float32Array.from([0.6]), rgba);
        expect(rgba[3]).toBeCloseTo(0.84375 * 255, 0);
    });

    it("only touches the alpha channel, one pixel per confidence value", () => {
        const rgba = Uint8ClampedArray.from([10, 20, 30, 0, 40, 50, 60, 0]);
        maskToAlpha(Float32Array.from([1, 0]), rgba);
        expect(Array.from(rgba)).toEqual([10, 20, 30, 255, 40, 50, 60, 0]);
    });

    it("does nothing for an empty mask", () => {
        const rgba = new Uint8ClampedArray(4).fill(7);
        maskToAlpha(new Float32Array(0), rgba);
        expect(Array.from(rgba)).toEqual([7, 7, 7, 7]);
    });
});
