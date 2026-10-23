///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    BOARD_BACKGROUND,
    type BoardContext,
    STAMP_FONT_FAMILY,
    drawElement,
    hitTest,
    renderBoard,
    seededRandom,
    starPoints,
} from "../../../../apps/shared/collab/whiteboardRender.js";
import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    type PenType,
    type ShapeElement,
    type StampElement,
    type StencilShape,
    type StrokeElement,
} from "../../../../apps/shared/collab/protocol.js";

type Call = [string, ...unknown[]];

const METHODS = [
    "save",
    "restore",
    "setTransform",
    "clearRect",
    "fillRect",
    "beginPath",
    "closePath",
    "moveTo",
    "lineTo",
    "quadraticCurveTo",
    "ellipse",
    "stroke",
    "fill",
    "fillText",
] as const;

const PROPERTIES = [
    "lineWidth",
    "lineCap",
    "lineJoin",
    "strokeStyle",
    "fillStyle",
    "globalAlpha",
    "globalCompositeOperation",
    "font",
    "textAlign",
    "textBaseline",
] as const;

/** A `BoardContext` that records every method call as `[name, ...args]` and every property assignment as
 * `["set", name, value]`, in order, in `calls`. */
function recordingContext(): BoardContext & { calls: Call[] } {
    const calls: Call[] = [];
    const ctx: Record<string, unknown> = { calls };
    for (const name of METHODS) {
        ctx[name] = (...args: unknown[]) => {
            calls.push([name, ...args]);
        };
    }
    for (const name of PROPERTIES) {
        let value: unknown;
        Object.defineProperty(ctx, name, {
            get: () => value,
            set: (next: unknown) => {
                value = next;
                calls.push(["set", name, next]);
            },
        });
    }
    return ctx as unknown as BoardContext & { calls: Call[] };
}

function names(calls: Call[]): string[] {
    return calls.map((call) => (call[0] === "set" ? `${call[0]}:${call[1] as string}` : call[0]));
}

function only(calls: Call[], name: string): Call[] {
    return calls.filter((call) => call[0] === name);
}

/** The value each property was last set to. */
function finalState(calls: Call[]): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const call of calls) {
        if (call[0] === "set") {
            state[call[1] as string] = call[2];
        }
    }
    return state;
}

function stroke(pen: PenType, points: number[], overrides: Partial<StrokeElement> = {}): StrokeElement {
    return { kind: "stroke", id: "a:1", epoch: 0, pen, color: "#ff0000", size: 4, points, ...overrides };
}

function shape(s: StencilShape, overrides: Partial<ShapeElement> = {}): ShapeElement {
    return { kind: "shape", id: "a:2", epoch: 0, shape: s, color: "#00ff00", size: 2, x1: 10, y1: 20, x2: 110, y2: 70, ...overrides };
}

function stamp(overrides: Partial<StampElement> = {}): StampElement {
    return { kind: "stamp", id: "a:3", epoch: 0, stamp: "⭐", size: 32, x: 100, y: 200, ...overrides };
}

function draw(element: Parameters<typeof drawElement>[1]): Call[] {
    const ctx = recordingContext();
    drawElement(ctx, element);
    return ctx.calls;
}

describe("seededRandom", () => {
    it("gives the same sequence for the same seed", () => {
        const a = seededRandom("peer:1");
        const b = seededRandom("peer:1");
        const first = Array.from({ length: 20 }, a);
        expect(Array.from({ length: 20 }, b)).toEqual(first);
    });

    it("gives different sequences for different seeds", () => {
        const a = Array.from({ length: 5 }, seededRandom("peer:1"));
        const b = Array.from({ length: 5 }, seededRandom("peer:2"));
        expect(a).not.toEqual(b);
    });

    it("gives numbers in [0, 1) that vary", () => {
        const random = seededRandom("");
        const values = Array.from({ length: 1000 }, random);
        for (const value of values) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
        expect(new Set(values).size).toBeGreaterThan(990);
        const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
        expect(mean).toBeGreaterThan(0.4);
        expect(mean).toBeLessThan(0.6);
    });
});

describe("renderBoard", () => {
    it("fills the whole canvas with paper at identity, then scales to board units", () => {
        const ctx = recordingContext();
        renderBoard(ctx, [], 0.5);
        expect(ctx.calls).toEqual([
            ["save"],
            ["setTransform", 1, 0, 0, 1, 0, 0],
            ["set", "globalAlpha", 1],
            ["set", "globalCompositeOperation", "source-over"],
            ["set", "fillStyle", BOARD_BACKGROUND],
            ["fillRect", 0, 0, BOARD_WIDTH * 0.5, BOARD_HEIGHT * 0.5],
            ["setTransform", 0.5, 0, 0, 0.5, 0, 0],
            ["restore"],
        ]);
    });

    it("draws each element in order, each inside its own save/restore", () => {
        const ctx = recordingContext();
        const elements = [stroke("ballpoint", [1, 2, 3, 4]), shape("line"), stamp()];
        renderBoard(ctx, elements, 2);
        const calls = ctx.calls.slice(7, -1);
        expect(calls).toEqual([...draw(elements[0]), ...draw(elements[1]), ...draw(elements[2])]);
        expect(ctx.calls[ctx.calls.length - 1]).toEqual(["restore"]);
        expect(only(ctx.calls, "save")).toHaveLength(4);
        expect(only(ctx.calls, "restore")).toHaveLength(4);
    });
});

describe("drawElement", () => {
    describe("strokes", () => {
        it("draws a ballpoint as a thin line, no thinner than 1.2", () => {
            const calls = draw(stroke("ballpoint", [0, 0, 10, 10], { size: 4 }));
            expect(calls).toEqual([
                ["save"],
                ["set", "strokeStyle", "#ff0000"],
                ["set", "fillStyle", "#ff0000"],
                ["set", "lineJoin", "round"],
                ["set", "lineCap", "round"],
                ["set", "lineWidth", 4 * 0.6],
                ["beginPath"],
                ["moveTo", 0, 0],
                ["lineTo", 10, 10],
                ["stroke"],
                ["restore"],
            ]);
            expect(finalState(draw(stroke("ballpoint", [0, 0], { size: 2 }))).lineWidth).toBe(1.2);
        });

        it("draws a sharpie as a bolder line with round ends", () => {
            const calls = draw(stroke("sharpie", [0, 0, 10, 10], { size: 8 }));
            expect(finalState(calls)).toMatchObject({ lineWidth: 8 * 1.4, lineCap: "round", strokeStyle: "#ff0000" });
            expect(only(calls, "stroke")).toHaveLength(1);
        });

        it("draws a marker broad, square-tipped and translucent in multiply, as a single path", () => {
            const calls = draw(stroke("marker", [0, 0, 10, 10, 20, 0], { size: 8 }));
            expect(finalState(calls)).toMatchObject({ globalCompositeOperation: "multiply", globalAlpha: 0.4, lineCap: "square", lineWidth: 24 });
            expect(only(calls, "beginPath")).toHaveLength(1);
            expect(only(calls, "stroke")).toHaveLength(1);
        });

        it("traces a single point as a tiny segment, so a tap leaves a dot", () => {
            const calls = draw(stroke("ballpoint", [5, 6]));
            expect(calls.slice(6, 9)).toEqual([
                ["beginPath"],
                ["moveTo", 5, 6],
                ["lineTo", 5.01, 6],
            ]);
        });

        it("traces two points as a straight line", () => {
            const calls = draw(stroke("sharpie", [5, 6, 50, 60]));
            expect(only(calls, "quadraticCurveTo")).toEqual([]);
            expect(only(calls, "moveTo")).toEqual([["moveTo", 5, 6]]);
            expect(only(calls, "lineTo")).toEqual([["lineTo", 50, 60]]);
        });

        it("traces a longer stroke as curves through the midpoints, ending on its last point", () => {
            const calls = draw(stroke("ballpoint", [0, 0, 10, 0, 20, 10, 30, 10]));
            expect(calls.slice(6, -2)).toEqual([
                ["beginPath"],
                ["moveTo", 0, 0],
                ["quadraticCurveTo", 10, 0, 15, 5],
                ["quadraticCurveTo", 20, 10, 25, 10],
                ["lineTo", 30, 10],
            ]);
        });

        it("draws a crayon as a translucent base path speckled with grain", () => {
            const points = [0, 0, 30, 40];
            const size = 8;
            const width = size * 1.8;
            const calls = draw(stroke("crayon", points, { size }));
            expect(calls.slice(5, 12)).toEqual([
                ["set", "globalAlpha", 0.55],
                ["set", "lineWidth", width],
                ["beginPath"],
                ["moveTo", 0, 0],
                ["lineTo", 30, 40],
                ["stroke"],
                ["set", "globalAlpha", 0.7],
            ]);
            const specks = only(calls, "fillRect");
            expect(specks).toHaveLength(Math.ceil((50 * width) / 18));
            const speck = width / 6;
            for (const [, x, y, w, h] of specks as [string, number, number, number, number][]) {
                expect(w).toBe(speck);
                expect(h).toBe(speck);
                // Every speck lands within the stroke's width (plus a speck) of the segment.
                expect(x).toBeGreaterThanOrEqual(-width);
                expect(x).toBeLessThanOrEqual(30 + width);
                expect(y).toBeGreaterThanOrEqual(-width);
                expect(y).toBeLessThanOrEqual(40 + width);
            }
            expect(calls[calls.length - 1]).toEqual(["restore"]);
        });

        it("speckles a crayon segment by segment, more for a longer one, and at least 1 unit per speck", () => {
            const size = 2;
            const width = size * 1.8;
            const calls = draw(stroke("crayon", [0, 0, 3, 4, 3, 104], { size }));
            expect(only(calls, "fillRect")).toHaveLength(Math.ceil((5 * width) / 18) + Math.ceil((100 * width) / 18));
            expect(only(calls, "fillRect")[0][3]).toBe(1);
        });

        it("still speckles a single-point crayon tap", () => {
            const width = 24 * 1.8;
            const calls = draw(stroke("crayon", [100, 100], { size: 24 }));
            expect(only(calls, "fillRect")).toHaveLength(Math.ceil(width / 18));
            expect(only(calls, "lineTo")).toEqual([["lineTo", 100.01, 100]]);
        });

        it("draws a pencil as three faint, slightly offset passes", () => {
            const size = 14;
            const calls = draw(stroke("pencil", [10, 10, 20, 20, 30, 10], { size }));
            expect(finalState(calls)).toMatchObject({ lineWidth: size * 0.45, globalAlpha: 0.35 });
            expect(only(calls, "beginPath")).toHaveLength(3);
            expect(only(calls, "stroke")).toHaveLength(3);
            const jitter = size * 0.35;
            const starts = only(calls, "moveTo") as [string, number, number][];
            for (const [, x, y] of starts) {
                expect(Math.abs(x - 10)).toBeLessThanOrEqual(jitter / 2);
                expect(Math.abs(y - 10)).toBeLessThanOrEqual(jitter / 2);
            }
            expect(new Set(starts.map(([, x, y]) => `${x},${y}`)).size).toBe(3);
            // Each pass is offset as a whole: its curve and end move with its start.
            const ends = only(calls, "lineTo") as [string, number, number][];
            const curves = only(calls, "quadraticCurveTo") as [string, number, number, number, number][];
            for (let pass = 0; pass < 3; pass++) {
                const dx = starts[pass][1] - 10;
                const dy = starts[pass][2] - 10;
                expect(ends[pass][1]).toBeCloseTo(30 + dx);
                expect(ends[pass][2]).toBeCloseTo(10 + dy);
                expect(curves[pass][1]).toBeCloseTo(20 + dx);
                expect(curves[pass][4]).toBeCloseTo(15 + dy);
            }
        });

        it("keeps a small pencil at least 0.8 wide with at least 0.6 of jitter", () => {
            const calls = draw(stroke("pencil", [10, 10], { size: 1 }));
            expect(finalState(calls).lineWidth).toBe(0.8);
            for (const [, x, y] of only(calls, "moveTo") as [string, number, number][]) {
                expect(Math.abs(x - 10)).toBeLessThanOrEqual(0.3);
                expect(Math.abs(y - 10)).toBeLessThanOrEqual(0.3);
            }
        });

        it("draws the same crayon or pencil stroke identically every time", () => {
            for (const pen of ["crayon", "pencil"] as const) {
                const element = stroke(pen, [0, 0, 40, 30, 80, 90, 100, 100], { id: "peer:7", size: 14 });
                expect(draw(element)).toEqual(draw({ ...element, points: [...element.points] }));
            }
        });

        it("gives a different grain to a stroke with a different id", () => {
            for (const pen of ["crayon", "pencil"] as const) {
                const element = stroke(pen, [0, 0, 40, 30, 80, 90], { size: 14 });
                expect(draw({ ...element, id: "a:1" })).not.toEqual(draw({ ...element, id: "b:1" }));
            }
        });
    });

    describe("shapes", () => {
        it("sets the outline style for every shape", () => {
            for (const s of ["line", "arrow", "rect", "ellipse", "triangle", "star"] as const) {
                const calls = draw(shape(s, { size: 8, color: "#123456" }));
                expect(calls.slice(0, 6)).toEqual([
                    ["save"],
                    ["set", "strokeStyle", "#123456"],
                    ["set", "lineWidth", 8],
                    ["set", "lineJoin", "round"],
                    ["set", "lineCap", "round"],
                    ["beginPath"],
                ]);
                expect(calls.slice(-2)).toEqual([["stroke"], ["restore"]]);
            }
        });

        it("draws a line from its first corner to its second", () => {
            expect(draw(shape("line", { x1: 110, y1: 70, x2: 10, y2: 20 })).slice(6, -2)).toEqual([
                ["moveTo", 110, 70],
                ["lineTo", 10, 20],
            ]);
        });

        it("draws an arrow with a two-sided head at its second end", () => {
            const calls = draw(shape("arrow", { x1: 0, y1: 0, x2: 100, y2: 0, size: 2 })).slice(6, -2);
            expect(calls.slice(0, 2)).toEqual([
                ["moveTo", 0, 0],
                ["lineTo", 100, 0],
            ]);
            const head = 12;
            const spread = Math.PI / 7;
            expect(calls[2]).toEqual(["moveTo", 100, 0]);
            expect(calls[3][0]).toBe("lineTo");
            expect(calls[3][1]).toBeCloseTo(100 - head * Math.cos(spread));
            expect(calls[3][2]).toBeCloseTo(head * Math.sin(spread));
            expect(calls[4]).toEqual(["moveTo", 100, 0]);
            expect(calls[5][1]).toBeCloseTo(100 - head * Math.cos(spread));
            expect(calls[5][2]).toBeCloseTo(-head * Math.sin(spread));
            expect(calls).toHaveLength(6);
        });

        it("grows an arrow's head with its size and points it along the shaft", () => {
            const calls = draw(shape("arrow", { x1: 0, y1: 100, x2: 0, y2: 0, size: 14 })).slice(6, -2);
            const head = 14 * 4;
            // Pointing up: the head's barbs sit below the tip.
            for (const barb of [calls[3], calls[5]] as [string, number, number][]) {
                expect(Math.hypot(barb[1], barb[2])).toBeCloseTo(head);
                expect(barb[2]).toBeGreaterThan(0);
            }
        });

        it("draws a rect across its corners whichever way it was dragged", () => {
            const expected = [
                ["moveTo", 10, 20],
                ["lineTo", 110, 20],
                ["lineTo", 110, 70],
                ["lineTo", 10, 70],
                ["closePath"],
            ];
            expect(draw(shape("rect")).slice(6, -2)).toEqual(expected);
            expect(draw(shape("rect", { x1: 110, y1: 70, x2: 10, y2: 20 })).slice(6, -2)).toEqual(expected);
        });

        it("draws an ellipse inscribed in its box", () => {
            expect(draw(shape("ellipse", { x1: 110, y1: 20, x2: 10, y2: 70 })).slice(6, -2)).toEqual([["ellipse", 60, 45, 50, 25, 0, 0, Math.PI * 2]]);
        });

        it("draws a triangle with its apex at the top middle", () => {
            expect(draw(shape("triangle", { y1: 70, y2: 20 })).slice(6, -2)).toEqual([
                ["moveTo", 60, 20],
                ["lineTo", 110, 70],
                ["lineTo", 10, 70],
                ["closePath"],
            ]);
        });

        it("draws a star through starPoints, closed", () => {
            const calls = draw(shape("star")).slice(6, -2);
            const corners = starPoints(10, 20, 100, 50);
            expect(calls).toEqual([["moveTo", ...corners[0]], ...corners.slice(1).map((corner) => ["lineTo", ...corner]), ["closePath"]]);
        });
    });

    describe("stamps", () => {
        it("draws the stamp's emoji centered on its position at its size", () => {
            expect(draw(stamp({ stamp: "🔥", size: 96, x: 7, y: 9 }))).toEqual([
                ["save"],
                ["set", "font", `96px ${STAMP_FONT_FAMILY}`],
                ["set", "textAlign", "center"],
                ["set", "textBaseline", "middle"],
                ["set", "fillStyle", "#000000"],
                ["fillText", "🔥", 7, 9],
                ["restore"],
            ]);
        });
    });
});

describe("starPoints", () => {
    it("gives ten corners starting at the top point, alternating outer and inner", () => {
        const corners = starPoints(0, 0, 100, 200);
        expect(corners).toHaveLength(10);
        expect(corners[0][0]).toBeCloseTo(50);
        expect(corners[0][1]).toBeCloseTo(0);
        for (const [i, [x, y]] of corners.entries()) {
            const rx = (x - 50) / 50;
            const ry = (y - 100) / 100;
            expect(Math.hypot(rx, ry)).toBeCloseTo(i % 2 === 0 ? 1 : 0.4);
        }
    });

    it("stays inside its box and is symmetric about its vertical center line", () => {
        const corners = starPoints(10, 20, 80, 60);
        for (const [x, y] of corners) {
            expect(x).toBeGreaterThanOrEqual(10 - 1e-9);
            expect(x).toBeLessThanOrEqual(90 + 1e-9);
            expect(y).toBeGreaterThanOrEqual(20 - 1e-9);
            expect(y).toBeLessThanOrEqual(80 + 1e-9);
        }
        for (let i = 1; i < 10; i++) {
            expect(corners[i][0] - 50).toBeCloseTo(50 - corners[10 - i][0]);
            expect(corners[i][1]).toBeCloseTo(corners[10 - i][1]);
        }
    });

    it("collapses to the center for an empty box", () => {
        for (const [x, y] of starPoints(5, 5, 0, 0)) {
            expect(x).toBeCloseTo(5);
            expect(y).toBeCloseTo(5);
        }
    });
});

describe("hitTest", () => {
    describe("strokes", () => {
        const line = stroke("ballpoint", [0, 0, 100, 0, 100, 100], { size: 4 });

        it("hits near any segment, counting the stroke's own width", () => {
            expect(hitTest(line, 50, 0, 1)).toBe(true);
            expect(hitTest(line, 50, 5, 1)).toBe(true);
            expect(hitTest(line, 50, -5, 1)).toBe(true);
            expect(hitTest(line, 105, 50, 1)).toBe(true);
            expect(hitTest(line, 100, 100, 0)).toBe(true);
        });

        it("misses just beyond the eraser's reach", () => {
            expect(hitTest(line, 50, 5.01, 1)).toBe(false);
            expect(hitTest(line, 50, 50, 10)).toBe(false);
            expect(hitTest(line, -6, 0, 1)).toBe(false);
            expect(hitTest(line, 100, 106, 1)).toBe(false);
        });

        it("measures past a segment's end to the end point, not along the infinite line", () => {
            expect(hitTest(line, 103, -3, 1)).toBe(true);
            expect(hitTest(line, -4, -4, 1)).toBe(false);
            expect(hitTest(line, 150, 0, 10)).toBe(false);
        });

        it("hits a single-point stroke around its point", () => {
            const dot = stroke("ballpoint", [10, 10], { size: 2 });
            expect(hitTest(dot, 13, 14, 3)).toBe(true);
            expect(hitTest(dot, 14, 14, 3)).toBe(false);
        });

        it("treats a repeated point as a zero-length segment", () => {
            const dot = stroke("pencil", [10, 10, 10, 10], { size: 2 });
            expect(hitTest(dot, 10, 13, 1)).toBe(true);
            expect(hitTest(dot, 10, 14, 1)).toBe(false);
        });
    });

    describe("lines and arrows", () => {
        it("hits by distance to the segment, with the line's width", () => {
            for (const s of ["line", "arrow"] as const) {
                const element = shape(s, { x1: 0, y1: 0, x2: 100, y2: 100, size: 2 });
                expect(hitTest(element, 50, 50, 0)).toBe(true);
                expect(hitTest(element, 52, 48, 1)).toBe(true);
                // Inside its bounding box but far from the diagonal: a miss.
                expect(hitTest(element, 90, 10, 5)).toBe(false);
                expect(hitTest(element, 105, 105, 5)).toBe(false);
                expect(hitTest(element, 103, 103, 3)).toBe(true);
            }
        });

        it("hits a zero-length line around its point", () => {
            const element = shape("line", { x1: 20, y1: 20, x2: 20, y2: 20, size: 2 });
            expect(hitTest(element, 23, 20, 1)).toBe(true);
            expect(hitTest(element, 24, 20, 1)).toBe(false);
        });
    });

    describe("closed shapes", () => {
        it("hits anywhere in the bounding box, grown by the reach, whichever way it was dragged", () => {
            for (const s of ["rect", "ellipse", "triangle", "star"] as const) {
                for (const element of [shape(s, { size: 2 }), shape(s, { size: 2, x1: 110, y1: 70, x2: 10, y2: 20 })]) {
                    expect(hitTest(element, 60, 45, 0)).toBe(true);
                    expect(hitTest(element, 10, 20, 0)).toBe(true);
                    expect(hitTest(element, 7, 45, 1)).toBe(true);
                    expect(hitTest(element, 113, 45, 1)).toBe(true);
                    expect(hitTest(element, 60, 17, 1)).toBe(true);
                    expect(hitTest(element, 60, 73, 1)).toBe(true);
                    expect(hitTest(element, 6.9, 45, 1)).toBe(false);
                    expect(hitTest(element, 113.1, 45, 1)).toBe(false);
                    expect(hitTest(element, 60, 16.9, 1)).toBe(false);
                    expect(hitTest(element, 60, 73.1, 1)).toBe(false);
                }
            }
        });
    });

    describe("stamps", () => {
        it("hits anywhere on its square, grown by the eraser's radius", () => {
            const element = stamp({ size: 32, x: 100, y: 200 });
            expect(hitTest(element, 100, 200, 0)).toBe(true);
            expect(hitTest(element, 116, 216, 0)).toBe(true);
            expect(hitTest(element, 84, 184, 0)).toBe(true);
            expect(hitTest(element, 120, 200, 4)).toBe(true);
        });

        it("misses outside its square, on either axis", () => {
            const element = stamp({ size: 32, x: 100, y: 200 });
            expect(hitTest(element, 116.1, 200, 0)).toBe(false);
            expect(hitTest(element, 100, 183.9, 0)).toBe(false);
            expect(hitTest(element, 121, 200, 4)).toBe(false);
            expect(hitTest(element, 100, 221, 4)).toBe(false);
        });
    });
});
