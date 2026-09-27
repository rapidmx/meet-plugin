///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The face accessories - sunglasses, cat ears, a party hat, a crown, a mustache - drawn as vector paths onto the
 * filtered frame, so the plugin ships no image assets at all.
 *
 * Each one is drawn in the face's own coordinate frame: the origin sits on a landmark (between the eyes, the top of
 * the forehead, the nose), the x axis runs along the line between the eyes so the accessory tilts with the head, and
 * one unit is the distance between the outer corners of the eyes so it grows and shrinks with the head. That keeps
 * every drawing routine below a few plain numbers in "face widths".
 */
import type { Accessory } from "./filterTypes.js";

/** A landmark as the face model reports it: 0-1 across and down the frame. */
export interface FaceLandmark {
    x: number;
    y: number;
}

export interface Point {
    x: number;
    y: number;
}

/** Where the parts of a face are, in canvas pixels. */
export interface FaceGeometry {
    /** Halfway between the outer corners of the eyes. */
    eyes: Point;
    /** The top of the forehead. */
    forehead: Point;
    noseTip: Point;
    upperLip: Point;
    /** The distance between the outer corners of the eyes - one unit of the accessories' coordinate frame. */
    unit: number;
    /** The tilt of the line between the eyes, in radians. */
    angle: number;
}

// Indices into the 478-point face mesh (MediaPipe's canonical face model).
const RIGHT_EYE_OUTER = 33;
const LEFT_EYE_OUTER = 263;
const FOREHEAD_TOP = 10;
const NOSE_TIP = 1;
const UPPER_LIP = 0;
const MESH_POINTS = 468;

/** Works out where the parts of a face are, in pixels, from the face mesh's landmarks - `null` when there are not
 * enough of them to be a face mesh at all. */
export function faceGeometry(landmarks: FaceLandmark[], width: number, height: number): FaceGeometry | null {
    if (landmarks.length < MESH_POINTS) {
        return null;
    }
    const at = (index: number): Point => ({ x: landmarks[index].x * width, y: landmarks[index].y * height });
    const right = at(RIGHT_EYE_OUTER);
    const left = at(LEFT_EYE_OUTER);
    return {
        eyes: { x: (right.x + left.x) / 2, y: (right.y + left.y) / 2 },
        forehead: at(FOREHEAD_TOP),
        noseTip: at(NOSE_TIP),
        upperLip: at(UPPER_LIP),
        unit: Math.hypot(left.x - right.x, left.y - right.y),
        angle: Math.atan2(left.y - right.y, left.x - right.x),
    };
}

/** Runs `draw` with the canvas moved to `origin`, turned by the face's tilt and scaled to one face width per unit. */
function inFaceFrame(ctx: CanvasRenderingContext2D, origin: Point, face: FaceGeometry, draw: () => void): void {
    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.rotate(face.angle);
    ctx.scale(face.unit, face.unit);
    draw();
    ctx.restore();
}

/** Runs `draw` once as it is and once flipped left-right, for the two matching halves of a symmetrical accessory. */
function bothSides(ctx: CanvasRenderingContext2D, draw: () => void): void {
    for (const side of [1, -1]) {
        ctx.save();
        ctx.scale(side, 1);
        draw();
        ctx.restore();
    }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawSunglasses(ctx: CanvasRenderingContext2D, face: FaceGeometry): void {
    inFaceFrame(ctx, face.eyes, face, () => {
        ctx.fillStyle = "rgba(12, 12, 18, 0.93)";
        ctx.strokeStyle = "rgba(12, 12, 18, 0.93)";
        ctx.lineCap = "round";
        bothSides(ctx, () => {
            roundedRect(ctx, 0.06, -0.17, 0.54, 0.38, 0.12);
            ctx.fill();
            // The arm that runs back over the ear.
            ctx.lineWidth = 0.04;
            ctx.beginPath();
            ctx.moveTo(0.6, -0.06);
            ctx.lineTo(0.8, -0.1);
            ctx.stroke();
            // A glint across the lens.
            ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
            ctx.beginPath();
            ctx.moveTo(0.14, -0.1);
            ctx.lineTo(0.28, -0.1);
            ctx.lineTo(0.16, 0.12);
            ctx.lineTo(0.1, 0.12);
            ctx.closePath();
            ctx.fill();
        });
        // The bridge between the lenses.
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(-0.08, -0.08);
        ctx.lineTo(0.08, -0.08);
        ctx.stroke();
    });
}

function drawCat(ctx: CanvasRenderingContext2D, face: FaceGeometry): void {
    inFaceFrame(ctx, face.forehead, face, () => {
        bothSides(ctx, () => {
            ctx.fillStyle = "#3b3b44";
            ctx.beginPath();
            ctx.moveTo(0.68, 0.14);
            ctx.lineTo(0.12, 0);
            ctx.lineTo(0.62, -0.55);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = "#f4a6b8";
            ctx.beginPath();
            ctx.moveTo(0.56, 0.06);
            ctx.lineTo(0.22, 0);
            ctx.lineTo(0.58, -0.33);
            ctx.closePath();
            ctx.fill();
        });
    });
    inFaceFrame(ctx, face.noseTip, face, () => {
        ctx.fillStyle = "#f06a8a";
        ctx.beginPath();
        ctx.moveTo(-0.09, -0.04);
        ctx.lineTo(0.09, -0.04);
        ctx.lineTo(0, 0.06);
        ctx.closePath();
        ctx.fill();
        ctx.lineCap = "round";
        bothSides(ctx, () => {
            for (const tilt of [-1, 0, 1]) {
                ctx.beginPath();
                ctx.moveTo(0.3, 0.04 + tilt * 0.07);
                ctx.lineTo(0.85, -0.02 + tilt * 0.15);
                // A dark line under a white one, so the whiskers read against a light or a dark background.
                ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
                ctx.lineWidth = 0.035;
                ctx.stroke();
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 0.018;
                ctx.stroke();
            }
        });
    });
}

function drawPartyHat(ctx: CanvasRenderingContext2D, face: FaceGeometry): void {
    inFaceFrame(ctx, face.forehead, face, () => {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(-0.42, 0.1);
        ctx.lineTo(0.42, 0.1);
        ctx.lineTo(0.04, -1.15);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = "#ff5fa2";
        ctx.fillRect(-0.6, -1.3, 1.2, 1.5);
        ctx.strokeStyle = "#ffd23f";
        ctx.lineWidth = 0.09;
        for (const y of [-0.12, -0.42, -0.72]) {
            ctx.beginPath();
            ctx.moveTo(-0.6, y + 0.2);
            ctx.lineTo(0.6, y - 0.2);
            ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(0.04, -1.15, 0.09, 0, Math.PI * 2);
        ctx.fill();
    });
}

function drawCrown(ctx: CanvasRenderingContext2D, face: FaceGeometry): void {
    inFaceFrame(ctx, face.forehead, face, () => {
        ctx.beginPath();
        ctx.moveTo(-0.5, 0.1);
        ctx.lineTo(-0.5, -0.45);
        ctx.lineTo(-0.25, -0.2);
        ctx.lineTo(0, -0.55);
        ctx.lineTo(0.25, -0.2);
        ctx.lineTo(0.5, -0.45);
        ctx.lineTo(0.5, 0.1);
        ctx.closePath();
        ctx.fillStyle = "#f5c518";
        ctx.fill();
        ctx.strokeStyle = "#b8860b";
        ctx.lineWidth = 0.03;
        ctx.lineJoin = "round";
        ctx.stroke();
        for (const [x, y, color] of [
            [-0.5, -0.45, "#e63946"],
            [0, -0.55, "#3a86ff"],
            [0.5, -0.45, "#e63946"],
            [0, -0.05, "#2a9d8f"],
        ] as const) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, 0.05, 0, Math.PI * 2);
            ctx.fill();
        }
    });
}

function drawMustache(ctx: CanvasRenderingContext2D, face: FaceGeometry): void {
    const between: Point = { x: (face.noseTip.x + face.upperLip.x) / 2, y: (face.noseTip.y + face.upperLip.y) / 2 };
    inFaceFrame(ctx, between, face, () => {
        ctx.fillStyle = "#3a2618";
        ctx.beginPath();
        ctx.moveTo(0, -0.03);
        ctx.bezierCurveTo(-0.12, -0.12, -0.32, -0.1, -0.42, 0.02);
        ctx.bezierCurveTo(-0.46, 0.07, -0.4, 0.13, -0.34, 0.09);
        ctx.bezierCurveTo(-0.26, 0.04, -0.12, 0.06, 0, 0.09);
        ctx.bezierCurveTo(0.12, 0.06, 0.26, 0.04, 0.34, 0.09);
        ctx.bezierCurveTo(0.4, 0.13, 0.46, 0.07, 0.42, 0.02);
        ctx.bezierCurveTo(0.32, -0.1, 0.12, -0.12, 0, -0.03);
        ctx.closePath();
        ctx.fill();
    });
}

const DRAWERS: Record<Exclude<Accessory, "none">, (ctx: CanvasRenderingContext2D, face: FaceGeometry) => void> = {
    sunglasses: drawSunglasses,
    "cat-ears": drawCat,
    "party-hat": drawPartyHat,
    crown: drawCrown,
    mustache: drawMustache,
};

/** Draws `accessory` onto `ctx` for the face at `face`. */
export function drawAccessory(ctx: CanvasRenderingContext2D, accessory: Exclude<Accessory, "none">, face: FaceGeometry): void {
    DRAWERS[accessory](ctx, face);
}
