///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";
import {
    type FaceGeometry,
    type FaceLandmark,
    drawAccessory,
    faceGeometry,
} from "../../../../../apps/shared/media/filters/accessories.js";
import type { Accessory } from "../../../../../apps/shared/media/filters/filterTypes.js";

/** A 478-point mesh with every point at the frame's centre except the ones the accessories use. */
function mesh(points: Record<number, FaceLandmark> = {}, count = 478): FaceLandmark[] {
    const landmarks: FaceLandmark[] = Array.from({ length: count }, () => ({ x: 0.5, y: 0.5 }));
    for (const [index, point] of Object.entries(points)) {
        landmarks[Number(index)] = point;
    }
    return landmarks;
}

// 33 is the right eye's outer corner, 263 the left's, 10 the top of the forehead, 1 the nose tip, 0 the upper lip.
const LEVEL_FACE = mesh({
    33: { x: 0.4, y: 0.4 },
    263: { x: 0.6, y: 0.4 },
    10: { x: 0.5, y: 0.2 },
    1: { x: 0.5, y: 0.5 },
    0: { x: 0.5, y: 0.6 },
});

describe("faceGeometry", () => {
    it("locates the parts of a level face in pixels", () => {
        const face = faceGeometry(LEVEL_FACE, 1000, 500)!;
        expect(face.eyes).toEqual({ x: 500, y: 200 });
        expect(face.forehead).toEqual({ x: 500, y: 100 });
        expect(face.noseTip).toEqual({ x: 500, y: 250 });
        expect(face.upperLip).toEqual({ x: 500, y: 300 });
        expect(face.unit).toBeCloseTo(200);
        expect(face.angle).toBeCloseTo(0);
    });

    it("reports the tilt of the line between the eyes, and the eye distance along it", () => {
        // Right eye (400, 400) to left eye (600, 600) on a 1000x1000 frame: 45 degrees, 200 * sqrt(2) apart.
        const tilted = mesh({ 33: { x: 0.4, y: 0.4 }, 263: { x: 0.6, y: 0.6 } });
        const face = faceGeometry(tilted, 1000, 1000)!;
        expect(face.angle).toBeCloseTo(Math.PI / 4);
        expect(face.unit).toBeCloseTo(200 * Math.SQRT2);
        expect(face.eyes.x).toBeCloseTo(500);
        expect(face.eyes.y).toBeCloseTo(500);
    });

    it("gives a negative angle when the head tilts the other way", () => {
        const tilted = mesh({ 33: { x: 0.4, y: 0.6 }, 263: { x: 0.6, y: 0.4 } });
        expect(faceGeometry(tilted, 1000, 1000)!.angle).toBeCloseTo(-Math.PI / 4);
    });

    it("scales x by the width and y by the height separately", () => {
        const face = faceGeometry(LEVEL_FACE, 200, 100)!;
        expect(face.eyes).toEqual({ x: 100, y: 40 });
        expect(face.unit).toBeCloseTo(40);
    });

    it("returns null when there are fewer than 468 landmarks", () => {
        expect(faceGeometry(mesh({}, 467), 100, 100)).toBeNull();
        expect(faceGeometry([], 100, 100)).toBeNull();
    });

    it("accepts exactly 468 landmarks", () => {
        expect(faceGeometry(mesh({}, 468), 100, 100)).not.toBeNull();
    });
});

/** A `CanvasRenderingContext2D` that records every call (in order) and lets the style properties be set freely. */
function recordingContext() {
    const calls: { name: string; args: unknown[] }[] = [];
    const methods = [
        "save",
        "restore",
        "translate",
        "rotate",
        "scale",
        "beginPath",
        "closePath",
        "moveTo",
        "lineTo",
        "arcTo",
        "arc",
        "bezierCurveTo",
        "clip",
        "fill",
        "stroke",
        "fillRect",
    ];
    const ctx: Record<string, unknown> = {};
    for (const name of methods) {
        ctx[name] = vi.fn((...args: unknown[]) => {
            calls.push({ name, args });
        });
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const FACE: FaceGeometry = {
    eyes: { x: 300, y: 200 },
    forehead: { x: 310, y: 100 },
    noseTip: { x: 305, y: 260 },
    upperLip: { x: 307, y: 300 },
    unit: 120,
    angle: 0.3,
};

const ACCESSORIES: Exclude<Accessory, "none">[] = ["sunglasses", "cat-ears", "party-hat", "crown", "mustache"];

/** The anchor each accessory is drawn at, in canvas pixels. */
const ANCHORS: Record<Exclude<Accessory, "none">, { x: number; y: number }[]> = {
    sunglasses: [FACE.eyes],
    "cat-ears": [FACE.forehead, FACE.noseTip],
    "party-hat": [FACE.forehead],
    crown: [FACE.forehead],
    mustache: [{ x: (305 + 307) / 2, y: (260 + 300) / 2 }],
};

describe("drawAccessory", () => {
    it.each(ACCESSORIES)("%s saves and restores in balance, never restoring more than it saved", (accessory) => {
        const { ctx, calls } = recordingContext();
        drawAccessory(ctx, accessory, FACE);
        let depth = 0;
        for (const call of calls) {
            if (call.name === "save") depth++;
            if (call.name === "restore") depth--;
            expect(depth).toBeGreaterThanOrEqual(0);
        }
        expect(depth).toBe(0);
        expect(calls.filter((c) => c.name === "save").length).toBeGreaterThan(0);
    });

    it.each(ACCESSORIES)("%s translates to its anchor, rotates by the face angle and scales by the face width", (accessory) => {
        const { ctx, calls } = recordingContext();
        drawAccessory(ctx, accessory, FACE);
        const translates = calls.filter((c) => c.name === "translate").map((c) => c.args);
        expect(translates).toEqual(ANCHORS[accessory].map((p) => [p.x, p.y]));
        const rotates = calls.filter((c) => c.name === "rotate").map((c) => c.args);
        expect(rotates).toEqual(ANCHORS[accessory].map(() => [FACE.angle]));
        const scales = calls.filter((c) => c.name === "scale").map((c) => c.args);
        expect(scales).toContainEqual([FACE.unit, FACE.unit]);
        // The face frame is entered before anything is drawn.
        const firstDraw = calls.findIndex((c) => ["fill", "stroke", "fillRect"].includes(c.name));
        expect(calls.findIndex((c) => c.name === "translate")).toBeLessThan(firstDraw);
        expect(calls.findIndex((c) => c.name === "rotate")).toBeLessThan(firstDraw);
    });

    it.each(ACCESSORIES)("%s starts a path before it fills or strokes", (accessory) => {
        const { ctx, calls } = recordingContext();
        drawAccessory(ctx, accessory, FACE);
        expect(calls.some((c) => c.name === "fill")).toBe(true);
        expect(calls.findIndex((c) => c.name === "beginPath")).toBeLessThan(calls.findIndex((c) => c.name === "fill"));
    });

    it("sunglasses draw two lenses, two arms, two glints and a bridge, mirrored", () => {
        const { ctx, calls } = recordingContext();
        drawAccessory(ctx, "sunglasses", FACE);
        const names = calls.map((c) => c.name);
        expect(names.filter((n) => n === "arcTo")).toHaveLength(8); // 4 corners x 2 lenses
        expect(names.filter((n) => n === "fill")).toHaveLength(4); // lens + glint x 2
        expect(names.filter((n) => n === "stroke")).toHaveLength(3); // an arm each side + the bridge
        expect(calls.filter((c) => c.name === "scale" && (c.args as number[])[0] === -1 && (c.args as number[])[1] === 1)).toHaveLength(1);
        expect(calls.filter((c) => c.name === "scale" && (c.args as number[])[0] === 1 && (c.args as number[])[1] === 1)).toHaveLength(1);
        expect((ctx as unknown as { fillStyle: string }).fillStyle).toBe("rgba(255, 255, 255, 0.2)");
        expect((ctx as unknown as { lineCap: string }).lineCap).toBe("round");
    });

    it("cat ears draw two ears (outer and inner) plus a nose and six whiskers stroked twice", () => {
        const { ctx, calls } = recordingContext();
        drawAccessory(ctx, "cat-ears", FACE);
        const names = calls.map((c) => c.name);
        expect(names.filter((n) => n === "fill")).toHaveLength(4 + 1); // outer + inner per ear, and the nose
        expect(names.filter((n) => n === "stroke")).toHaveLength(6 * 2);
        expect((ctx as unknown as { strokeStyle: string }).strokeStyle).toBe("#ffffff");
    });

    it("the party hat clips its stripes to the cone and adds a bobble", () => {
        const { ctx, calls } = recordingContext();
        drawAccessory(ctx, "party-hat", FACE);
        const names = calls.map((c) => c.name);
        expect(names.filter((n) => n === "clip")).toHaveLength(1);
        expect(names.filter((n) => n === "fillRect")).toHaveLength(1);
        expect(names.filter((n) => n === "stroke")).toHaveLength(3);
        expect(names.filter((n) => n === "arc")).toHaveLength(1);
        // The clip is restored before the bobble is drawn, so the bobble is not clipped away.
        expect(names.lastIndexOf("restore", names.indexOf("arc"))).toBeGreaterThan(names.indexOf("clip"));
    });

    it("the crown is outlined and set with four jewels", () => {
        const { ctx, calls } = recordingContext();
        drawAccessory(ctx, "crown", FACE);
        const names = calls.map((c) => c.name);
        expect(names.filter((n) => n === "stroke")).toHaveLength(1);
        expect(names.filter((n) => n === "arc")).toHaveLength(4);
        expect(names.filter((n) => n === "fill")).toHaveLength(1 + 4);
    });

    it("the mustache is one filled outline of bezier curves", () => {
        const { ctx, calls } = recordingContext();
        drawAccessory(ctx, "mustache", FACE);
        const names = calls.map((c) => c.name);
        expect(names.filter((n) => n === "bezierCurveTo")).toHaveLength(6);
        expect(names.filter((n) => n === "fill")).toHaveLength(1);
        expect((ctx as unknown as { fillStyle: string }).fillStyle).toBe("#3a2618");
    });
});
