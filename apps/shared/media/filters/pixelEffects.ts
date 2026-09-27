///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The colour effects, as plain functions over an RGBA pixel buffer (`ImageData.data`) so they need no canvas API
 * beyond `getImageData`/`putImageData`. They are done here, one pixel at a time, rather than with the canvas
 * `filter` property, which Safari does not support.
 *
 * Each function edits `data` in place and leaves the alpha channel alone.
 */

/** Rec. 601 luma - how bright a colour looks. */
function luma(r: number, g: number, b: number): number {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function applyGrayscale(data: Uint8ClampedArray): void {
    for (let i = 0; i < data.length; i += 4) {
        const y = luma(data[i], data[i + 1], data[i + 2]);
        data[i] = y;
        data[i + 1] = y;
        data[i + 2] = y;
    }
}

export function applySepia(data: Uint8ClampedArray): void {
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // `Uint8ClampedArray` clamps to 0-255 on assignment.
        data[i] = 0.393 * r + 0.769 * g + 0.189 * b;
        data[i + 1] = 0.349 * r + 0.686 * g + 0.168 * b;
        data[i + 2] = 0.272 * r + 0.534 * g + 0.131 * b;
    }
}

/** A brightened, green-tinted picture, like a night-vision scope. */
export function applyNightVision(data: Uint8ClampedArray): void {
    for (let i = 0; i < data.length; i += 4) {
        const y = luma(data[i], data[i + 1], data[i + 2]) * 1.4;
        data[i] = y * 0.25;
        data[i + 1] = y;
        data[i + 2] = y * 0.25;
    }
}

/** Below this confidence a pixel is background; above `MASK_HIGH` it is the person; in between it fades, so the edge of
 * the person is soft rather than jagged. */
const MASK_LOW = 0.3;
const MASK_HIGH = 0.7;

/** Turns a person-confidence mask (0-1 per pixel) into the alpha channel of an RGBA buffer, sharpening the edge with a
 * smoothstep. `rgba` must hold `4 * confidence.length` values. */
export function maskToAlpha(confidence: Float32Array, rgba: Uint8ClampedArray): void {
    for (let i = 0; i < confidence.length; i++) {
        const t = Math.min(1, Math.max(0, (confidence[i] - MASK_LOW) / (MASK_HIGH - MASK_LOW)));
        rgba[i * 4 + 3] = t * t * (3 - 2 * t) * 255;
    }
}
