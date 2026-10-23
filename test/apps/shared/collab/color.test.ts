///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex, hsvToRgb, wheelPoint } from "../../../../apps/shared/collab/color.js";

/** One fully saturated, full-value color per 60-degree hue sector, plus one in the middle of each sector. */
const SECTORS: { h: number; hex: string; mid: string }[] = [
    { h: 0, hex: "#ff0000", mid: "#ff8000" },
    { h: 60, hex: "#ffff00", mid: "#80ff00" },
    { h: 120, hex: "#00ff00", mid: "#00ff80" },
    { h: 180, hex: "#00ffff", mid: "#0080ff" },
    { h: 240, hex: "#0000ff", mid: "#8000ff" },
    { h: 300, hex: "#ff00ff", mid: "#ff0080" },
];

describe("hsvToRgb", () => {
    it("gives the primary and secondary colors at each sector's start", () => {
        expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual([255, 0, 0]);
        expect(hsvToRgb({ h: 60, s: 1, v: 1 })).toEqual([255, 255, 0]);
        expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual([0, 255, 0]);
        expect(hsvToRgb({ h: 180, s: 1, v: 1 })).toEqual([0, 255, 255]);
        expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual([0, 0, 255]);
        expect(hsvToRgb({ h: 300, s: 1, v: 1 })).toEqual([255, 0, 255]);
    });

    it("gives a gray for zero saturation, whatever the hue", () => {
        for (const h of [0, 90, 200, 359]) {
            expect(hsvToRgb({ h, s: 0, v: 0.5 })).toEqual([128, 128, 128]);
        }
    });

    it("gives black for zero value and white for full value without saturation", () => {
        expect(hsvToRgb({ h: 123, s: 1, v: 0 })).toEqual([0, 0, 0]);
        expect(hsvToRgb({ h: 0, s: 0, v: 1 })).toEqual([255, 255, 255]);
    });

    it("wraps a negative hue or one of 360 or more onto [0, 360)", () => {
        expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual([255, 0, 0]);
        expect(hsvToRgb({ h: -120, s: 1, v: 1 })).toEqual(hsvToRgb({ h: 240, s: 1, v: 1 }));
        expect(hsvToRgb({ h: 420, s: 1, v: 1 })).toEqual(hsvToRgb({ h: 60, s: 1, v: 1 }));
        expect(hsvToRgb({ h: -720, s: 1, v: 1 })).toEqual([255, 0, 0]);
    });

    it("blends in the hue just before the next sector", () => {
        expect(hsvToRgb({ h: 359.9, s: 1, v: 1 })).toEqual([255, 0, 0]);
        expect(hsvToRgb({ h: 330, s: 1, v: 1 })).toEqual([255, 0, 128]);
    });
});

describe("hsvToHex", () => {
    it("formats each sector's color as a lowercase #rrggbb", () => {
        for (const { h, hex, mid } of SECTORS) {
            expect(hsvToHex({ h, s: 1, v: 1 })).toBe(hex);
            expect(hsvToHex({ h: h + 30, s: 1, v: 1 })).toBe(mid);
        }
    });

    it("pads small channels with a leading zero", () => {
        expect(hsvToHex({ h: 0, s: 0, v: 0 })).toBe("#000000");
        expect(hsvToHex({ h: 0, s: 0, v: 10 / 255 })).toBe("#0a0a0a");
    });
});

describe("hexToHsv", () => {
    it("finds each sector's hue", () => {
        for (const { h, hex, mid } of SECTORS) {
            expect(hexToHsv(hex)).toEqual({ h, s: 1, v: 1 });
            const middle = hexToHsv(mid);
            expect(middle.h).toBeCloseTo(h + 30, 0);
            expect(middle.s).toBe(1);
            expect(middle.v).toBe(1);
        }
    });

    it("round-trips hex -> hsv -> hex in every sector, at several saturations and values", () => {
        for (const hex of ["#ff0000", "#ff8000", "#c0ff33", "#12ab34", "#00ffcc", "#2040a0", "#7a10e0", "#e01070", "#ff00ff", "#804020", "#336699"]) {
            expect(hsvToHex(hexToHsv(hex))).toBe(hex);
        }
    });

    it("round-trips hsv -> hex -> hsv across the hue circle to within rounding", () => {
        for (let h = 0; h < 360; h += 15) {
            for (const [s, v] of [
                [1, 1],
                [0.5, 0.8],
                [0.75, 0.6],
            ]) {
                const back = hexToHsv(hsvToHex({ h, s, v }));
                const hueError = Math.min(Math.abs(back.h - h), 360 - Math.abs(back.h - h));
                expect(hueError).toBeLessThan(1);
                expect(back.s).toBeCloseTo(s, 1);
                expect(back.v).toBeCloseTo(v, 2);
            }
        }
    });

    it("gives a gray a hue and saturation of zero", () => {
        expect(hexToHsv("#808080")).toEqual({ h: 0, s: 0, v: 128 / 255 });
        expect(hexToHsv("#ffffff")).toEqual({ h: 0, s: 0, v: 1 });
    });

    it("gives black a saturation of zero rather than dividing by zero", () => {
        expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    });

    it("keeps the hue of a red-dominant color with more blue than green in [0, 360)", () => {
        const hsv = hexToHsv("#ff0080");
        expect(hsv.h).toBeCloseTo(330, 0);
        expect(hsv.h).toBeLessThan(360);
    });

    it("accepts uppercase hex", () => {
        expect(hexToHsv("#00FF00")).toEqual({ h: 120, s: 1, v: 1 });
    });

    it("gives black for anything that is not #rrggbb", () => {
        for (const hex of ["", "red", "#fff", "00ff00", "#00ff0", "#00ff000", "#gg0000", " #00ff00"]) {
            expect(hexToHsv(hex)).toEqual({ h: 0, s: 0, v: 0 });
        }
    });
});

describe("wheelPoint", () => {
    const radius = 100;

    it("puts red (hue 0) at the right and goes clockwise on screen", () => {
        expect(wheelPoint(200, 100, radius)).toEqual({ h: 0, s: 1 });
        expect(wheelPoint(100, 200, radius).h).toBeCloseTo(90);
        expect(wheelPoint(0, 100, radius).h).toBeCloseTo(180);
        expect(wheelPoint(100, 0, radius).h).toBeCloseTo(270);
    });

    it("gives diagonal angles in between", () => {
        expect(wheelPoint(150, 150, radius).h).toBeCloseTo(45);
        expect(wheelPoint(50, 150, radius).h).toBeCloseTo(135);
        expect(wheelPoint(50, 50, radius).h).toBeCloseTo(225);
        expect(wheelPoint(150, 50, radius).h).toBeCloseTo(315);
    });

    it("keeps the hue in [0, 360)", () => {
        for (const [x, y] of [
            [199, 99.99],
            [199, 100.01],
            [0, 100],
            [100, 0],
        ]) {
            const { h } = wheelPoint(x, y, radius);
            expect(h).toBeGreaterThanOrEqual(0);
            expect(h).toBeLessThan(360);
        }
    });

    it("scales saturation by distance from the center", () => {
        expect(wheelPoint(100, 100, radius)).toEqual({ h: 0, s: 0 });
        expect(wheelPoint(150, 100, radius).s).toBeCloseTo(0.5);
        expect(wheelPoint(100, 25, radius).s).toBeCloseTo(0.75);
    });

    it("clamps saturation to 1 outside the rim", () => {
        expect(wheelPoint(400, 100, radius)).toEqual({ h: 0, s: 1 });
        expect(wheelPoint(-50, -50, radius).s).toBe(1);
    });
});
