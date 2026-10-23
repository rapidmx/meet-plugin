///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Draws the whiteboard's elements on a 2D canvas, in board units (`protocol.ts`'s `BOARD_WIDTH` x `BOARD_HEIGHT`)
 * scaled to the canvas. Each pen has its own look:
 *
 * - **ballpoint** - a thin, even, opaque line.
 * - **sharpie** - a bolder opaque line with round ends.
 * - **marker** - a broad, square-tipped, translucent stroke laid down in `multiply`, so it highlights what is under
 * it instead of covering it, and doesn't darken where it overlaps itself (the stroke is one path).
 * - **crayon** - a waxy translucent base speckled with grain, like wax catching on paper.
 * - **pencil** - a coloring pencil: several fine, slightly offset, faint passes that build up a grainy line.
 *
 * The grain of a crayon or pencil comes from a random generator seeded by the element's id, so every participant's
 * board draws the very same texture for the same stroke - it is not re-randomized per screen or per redraw.
 */
import { BOARD_HEIGHT, BOARD_WIDTH, type BoardElement, type ShapeElement, type StampElement, type StrokeElement } from "./protocol.js";

/** The subset of `CanvasRenderingContext2D` the renderer uses, so a test can record calls on a plain object. */
export type BoardContext = Pick<
    CanvasRenderingContext2D,
    | "save"
    | "restore"
    | "setTransform"
    | "clearRect"
    | "fillRect"
    | "beginPath"
    | "closePath"
    | "moveTo"
    | "lineTo"
    | "quadraticCurveTo"
    | "ellipse"
    | "stroke"
    | "fill"
    | "fillText"
    | "lineWidth"
    | "lineCap"
    | "lineJoin"
    | "strokeStyle"
    | "fillStyle"
    | "globalAlpha"
    | "globalCompositeOperation"
    | "font"
    | "textAlign"
    | "textBaseline"
>;

/** The board's paper color. */
export const BOARD_BACKGROUND = "#ffffff";

/** The font stack stamps are drawn in - each platform's color emoji font first. */
export const STAMP_FONT_FAMILY = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

/** A small, fast, seedable PRNG (mulberry32) - returns numbers in [0, 1). */
export function seededRandom(seed: string): () => number {
    let state = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
    }
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Clears the canvas to paper and draws `elements` in order, `scale` canvas pixels per board unit. */
export function renderBoard(ctx: BoardContext, elements: readonly BoardElement[], scale: number): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = BOARD_BACKGROUND;
    ctx.fillRect(0, 0, BOARD_WIDTH * scale, BOARD_HEIGHT * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const element of elements) {
        drawElement(ctx, element);
    }
    ctx.restore();
}

export function drawElement(ctx: BoardContext, element: BoardElement): void {
    ctx.save();
    switch (element.kind) {
        case "stroke":
            drawStroke(ctx, element);
            break;
        case "shape":
            drawShape(ctx, element);
            break;
        case "stamp":
            drawStamp(ctx, element);
            break;
    }
    ctx.restore();
}

/** Traces a smooth path through `points` (curves through the midpoints between them), offset by (`dx`, `dy`). */
function tracePath(ctx: BoardContext, points: readonly number[], dx = 0, dy = 0): void {
    ctx.beginPath();
    ctx.moveTo(points[0] + dx, points[1] + dy);
    if (points.length === 2) {
        // A single tap still leaves a dot.
        ctx.lineTo(points[0] + dx + 0.01, points[1] + dy);
        return;
    }
    for (let i = 2; i < points.length - 2; i += 2) {
        const midX = (points[i] + points[i + 2]) / 2;
        const midY = (points[i + 1] + points[i + 3]) / 2;
        ctx.quadraticCurveTo(points[i] + dx, points[i + 1] + dy, midX + dx, midY + dy);
    }
    ctx.lineTo(points[points.length - 2] + dx, points[points.length - 1] + dy);
}

function drawStroke(ctx: BoardContext, stroke: StrokeElement): void {
    const { points, size, color } = stroke;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    switch (stroke.pen) {
        case "ballpoint":
            ctx.lineWidth = Math.max(1.2, size * 0.6);
            tracePath(ctx, points);
            ctx.stroke();
            return;
        case "sharpie":
            ctx.lineWidth = size * 1.4;
            tracePath(ctx, points);
            ctx.stroke();
            return;
        case "marker":
            ctx.globalCompositeOperation = "multiply";
            ctx.globalAlpha = 0.4;
            ctx.lineCap = "square";
            ctx.lineWidth = size * 3;
            tracePath(ctx, points);
            ctx.stroke();
            return;
        case "crayon":
            drawCrayon(ctx, stroke);
            return;
        case "pencil":
            drawPencil(ctx, stroke);
            return;
    }
}

function drawCrayon(ctx: BoardContext, stroke: StrokeElement): void {
    const random = seededRandom(stroke.id);
    const width = stroke.size * 1.8;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = width;
    tracePath(ctx, stroke.points);
    ctx.stroke();
    // Grain: specks scattered across the stroke's width along every segment, more for a longer segment.
    ctx.globalAlpha = 0.7;
    const speck = Math.max(1, width / 6);
    eachSegment(stroke.points, (x0, y0, x1, y1, length) => {
        const count = Math.ceil((length * width) / 18);
        for (let i = 0; i < count; i++) {
            const t = random();
            const spread = (random() - 0.5) * width;
            const along = (random() - 0.5) * speck;
            ctx.fillRect(x0 + (x1 - x0) * t + spread * 0.7 + along, y0 + (y1 - y0) * t + spread * 0.7 - along, speck, speck);
        }
    });
}

function drawPencil(ctx: BoardContext, stroke: StrokeElement): void {
    const random = seededRandom(stroke.id);
    ctx.lineWidth = Math.max(0.8, stroke.size * 0.45);
    ctx.globalAlpha = 0.35;
    const passes = 3;
    const jitter = Math.max(0.6, stroke.size * 0.35);
    for (let pass = 0; pass < passes; pass++) {
        tracePath(ctx, stroke.points, (random() - 0.5) * jitter, (random() - 0.5) * jitter);
        ctx.stroke();
    }
}

/** Calls `visit` with each segment of `points` and its length; a single point is a zero-length segment. */
function eachSegment(points: readonly number[], visit: (x0: number, y0: number, x1: number, y1: number, length: number) => void): void {
    if (points.length === 2) {
        visit(points[0], points[1], points[0], points[1], 1);
        return;
    }
    for (let i = 0; i < points.length - 2; i += 2) {
        const [x0, y0, x1, y1] = [points[i], points[i + 1], points[i + 2], points[i + 3]];
        visit(x0, y0, x1, y1, Math.hypot(x1 - x0, y1 - y0));
    }
}

function drawShape(ctx: BoardContext, shape: ShapeElement): void {
    const { x1, y1, x2, y2 } = shape;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.size;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    switch (shape.shape) {
        case "line":
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            break;
        case "arrow": {
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const head = Math.max(12, shape.size * 4);
            for (const side of [-1, 1]) {
                ctx.moveTo(x2, y2);
                ctx.lineTo(x2 - head * Math.cos(angle + side * (Math.PI / 7)), y2 - head * Math.sin(angle + side * (Math.PI / 7)));
            }
            break;
        }
        case "rect":
            ctx.moveTo(left, top);
            ctx.lineTo(left + width, top);
            ctx.lineTo(left + width, top + height);
            ctx.lineTo(left, top + height);
            ctx.closePath();
            break;
        case "ellipse":
            ctx.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
            break;
        case "triangle":
            ctx.moveTo(left + width / 2, top);
            ctx.lineTo(left + width, top + height);
            ctx.lineTo(left, top + height);
            ctx.closePath();
            break;
        case "star":
            for (const [i, [px, py]] of starPoints(left, top, width, height).entries()) {
                if (i === 0) {
                    ctx.moveTo(px, py);
                } else {
                    ctx.lineTo(px, py);
                }
            }
            ctx.closePath();
            break;
    }
    ctx.stroke();
}

/** The ten corners of a five-pointed star filling the given box, starting at its top point. */
export function starPoints(left: number, top: number, width: number, height: number): [number, number][] {
    const cx = left + width / 2;
    const cy = top + height / 2;
    const corners: [number, number][] = [];
    for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? 1 : 0.4;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        corners.push([cx + (Math.cos(angle) * radius * width) / 2, cy + (Math.sin(angle) * radius * height) / 2]);
    }
    return corners;
}

function drawStamp(ctx: BoardContext, stamp: StampElement): void {
    ctx.font = `${stamp.size}px ${STAMP_FONT_FAMILY}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#000000";
    ctx.fillText(stamp.stamp, stamp.x, stamp.y);
}

function distanceToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lengthSquared));
    return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Whether the eraser at (`x`, `y`) with `radius`, in board units, touches `element`. A stroke or line counts its own
 * width; a closed shape is touched on its outline's bounding box, a stamp anywhere on its square. */
export function hitTest(element: BoardElement, x: number, y: number, radius: number): boolean {
    switch (element.kind) {
        case "stroke": {
            const reach = radius + element.size;
            let hit = false;
            eachSegment(element.points, (x0, y0, x1, y1) => {
                hit = hit || distanceToSegment(x, y, x0, y0, x1, y1) <= reach;
            });
            return hit;
        }
        case "shape": {
            const reach = radius + element.size;
            if (element.shape === "line" || element.shape === "arrow") {
                return distanceToSegment(x, y, element.x1, element.y1, element.x2, element.y2) <= reach;
            }
            const left = Math.min(element.x1, element.x2) - reach;
            const right = Math.max(element.x1, element.x2) + reach;
            const top = Math.min(element.y1, element.y2) - reach;
            const bottom = Math.max(element.y1, element.y2) + reach;
            return x >= left && x <= right && y >= top && y <= bottom;
        }
        case "stamp": {
            const half = element.size / 2 + radius;
            return Math.abs(x - element.x) <= half && Math.abs(y - element.y) <= half;
        }
    }
}
