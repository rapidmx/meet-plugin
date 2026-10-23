///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Hue/saturation/value conversions for the whiteboard's color wheel (`apps/meet/_ColorWheel.tsx`). Hue is in degrees
 * [0, 360), saturation and value in [0, 1]; colors are lowercase `#rrggbb`. */

export interface Hsv {
    h: number;
    s: number;
    v: number;
}

/** `[r, g, b]`, each 0-255, of an HSV color. */
export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
    const hue = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = v - c;
    const sector = Math.floor(hue / 60);
    const [r, g, b] = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
    ][sector];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function hsvToHex(hsv: Hsv): string {
    return `#${hsvToRgb(hsv)
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")}`;
}

/** The HSV of a `#rrggbb` color; black for anything else. */
export function hexToHsv(hex: string): Hsv {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!match) {
        return { h: 0, s: 0, v: 0 };
    }
    const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255);
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let h = 0;
    if (delta > 0) {
        if (max === r) {
            h = 60 * (((g - b) / delta) % 6);
        } else if (max === g) {
            h = 60 * ((b - r) / delta + 2);
        } else {
            h = 60 * ((r - g) / delta + 4);
        }
    }
    return { h: (h + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

/** The hue and saturation at (`x`, `y`) on a wheel of `radius` centered at (`radius`, `radius`): hue by angle
 * (red at the right, going clockwise), saturation by distance from the center, clamped to the rim. */
export function wheelPoint(x: number, y: number, radius: number): { h: number; s: number } {
    const dx = x - radius;
    const dy = y - radius;
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return { h, s: Math.min(1, Math.hypot(dx, dy) / radius) };
}
