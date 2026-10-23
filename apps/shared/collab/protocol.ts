///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The payloads of the call's chat and shared whiteboard, carried as ordinary `SignalMessage`s (`chat`, `whiteboard`,
 * `collab-sync-request`, `collab-sync` - see `../webrtc/types.ts`) over the meeting's signaling socket, and the
 * validators every received one goes through. Everything here arrives from another participant's browser, which
 * this one has no reason to trust beyond the sender identity the server stamps on the envelope: a payload that is
 * malformed, out of range or too big is dropped whole by `parseChat()`/`parseWhiteboardOp()`/`parseSync()` before
 * anything renders it.
 *
 * ## The board
 *
 * The whiteboard is a fixed `BOARD_WIDTH` x `BOARD_HEIGHT` coordinate space (16:9), whatever size each participant's
 * window shows it at, holding three kinds of `BoardElement`: a freehand `stroke` drawn with one of `PEN_TYPES`, a
 * `shape` drawn with the stencil (`STENCIL_SHAPES`), and a `stamp` (one of `STAMPS`). Coordinates are whole board
 * units, so a stroke's points travel as a flat `[x0, y0, x1, y1, ...]` integer array.
 *
 * An element's id starts with its author's peer id (`<peer>:<n>`), and only its author may add to it - a `points`
 * op or a second `add` under someone else's id is ignored, so nobody can rewrite another participant's drawing. Anyone
 * may remove any element, though: erasing is a shared-board action, as on a real whiteboard.
 *
 * Clearing the board raises its `epoch`. Every element records the epoch it was drawn in, and an element from an
 * older epoch is dropped wherever it shows up - so a participant who missed the clear, or a late joiner's catch-up
 * sent by someone who did, cannot bring cleared drawings back.
 */

export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 900;

/** The freehand pens, each with its own look - see `whiteboardRender.ts`. */
export const PEN_TYPES = ["ballpoint", "sharpie", "marker", "crayon", "pencil"] as const;
export type PenType = (typeof PEN_TYPES)[number];

/** What the stencil draws: dragged out from one corner (or end) to the other. */
export const STENCIL_SHAPES = ["line", "arrow", "rect", "ellipse", "triangle", "star"] as const;
export type StencilShape = (typeof STENCIL_SHAPES)[number];

/** The stamps a participant can place. A received stamp outside this list is ignored, so an arbitrary string from
 * another participant is never drawn - the same rule as the call's reactions (`REACTION_EMOJIS`). */
export const STAMPS = ["⭐", "❤️", "✅", "❌", "❓", "❗", "💡", "👍", "👎", "😀", "🎉", "🔥", "➡️", "⬅️", "⬆️", "⬇️"] as const;
export type Stamp = (typeof STAMPS)[number];

/** The pen/line sizes, smallest first - an element's `size` is one of these. */
export const SIZES = [2, 4, 8, 14, 24] as const;
export const STAMP_SIZES = [32, 56, 96, 160] as const;

/** The longest chat message, in characters. */
export const MAX_CHAT_LENGTH = 4000;
/** The most points one stroke may hold - about a minute of continuous drawing. */
export const MAX_STROKE_POINTS = 8000;
/** The most points one `points` op (or the first batch of an `add`) may carry. */
export const MAX_POINTS_PER_OP = 2000;
/** The most elements a board holds; drawing past it is refused until something is erased. */
export const MAX_BOARD_ELEMENTS = 5000;
/** The most chat messages kept; older ones are dropped. */
export const MAX_CHAT_HISTORY = 500;
/** The most ids one `remove` op may name. */
export const MAX_REMOVE_IDS = 500;
/** The longest element or chat id. */
export const MAX_ID_LENGTH = 200;
/** The longest display name a catch-up may carry for a chat message. */
export const MAX_NAME_LENGTH = 200;

export interface StrokeElement {
    kind: "stroke";
    id: string;
    epoch: number;
    pen: PenType;
    color: string;
    size: number;
    /** Flat `[x0, y0, x1, y1, ...]`, whole board units. */
    points: number[];
}

export interface ShapeElement {
    kind: "shape";
    id: string;
    epoch: number;
    shape: StencilShape;
    color: string;
    size: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface StampElement {
    kind: "stamp";
    id: string;
    epoch: number;
    stamp: Stamp;
    size: number;
    x: number;
    y: number;
}

export type BoardElement = StrokeElement | ShapeElement | StampElement;

export type WhiteboardOp =
    /** A new element - for a stroke, its first points; the rest follow in `points` ops. */
    | { op: "add"; element: BoardElement }
    /** More points of the sender's own stroke `id`, written from point index `start` on (so a repeat is harmless). */
    | { op: "points"; id: string; start: number; points: number[] }
    | { op: "remove"; ids: string[] }
    /** The board was cleared, now at `epoch`. */
    | { op: "clear"; epoch: number };

/** One chat message as its author sends it. */
export interface ChatPayload {
    id: string;
    text: string;
    /** The author's clock, ms since the epoch - only for display, never for ordering. */
    sentAt: number;
}

/** One chat message as a catch-up carries it: who sent it travels inside, since the envelope names the catch-up's sender. */
export interface ChatHistoryEntry extends ChatPayload {
    peer: string;
    name: string;
}

/** One part of the catch-up an existing participant sends a newcomer - see `CollabSession`. */
export interface SyncPayload {
    part: number;
    of: number;
    epoch: number;
    chat: ChatHistoryEntry[];
    ops: WhiteboardOp[];
}

const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isCoordinate(value: unknown, max: number): value is number {
    return Number.isInteger(value) && (value as number) >= -max && (value as number) <= 2 * max;
}

function isEpoch(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
}

function isPoints(value: unknown, max: number): value is number[] {
    if (!Array.isArray(value) || value.length % 2 !== 0 || value.length / 2 > max) {
        return false;
    }
    for (let i = 0; i < value.length; i += 2) {
        if (!isCoordinate(value[i], BOARD_WIDTH) || !isCoordinate(value[i + 1], BOARD_HEIGHT)) {
            return false;
        }
    }
    return true;
}

/** `color` as a lowercase `#rrggbb`, or `undefined` when it is not one. */
export function normalizeColor(color: unknown): string | undefined {
    if (typeof color !== "string") {
        return undefined;
    }
    const lower = color.toLowerCase();
    return COLOR_PATTERN.test(lower) ? lower : undefined;
}

/** Whether `id` is one `peer` may author - see this module's doc comment. */
export function isOwnId(id: string, peer: string): boolean {
    return id.startsWith(`${peer}:`);
}

function parseElement(value: unknown): BoardElement | undefined {
    if (!isRecord(value) || !isId(value.id) || !isEpoch(value.epoch)) {
        return undefined;
    }
    const { id, epoch } = value;
    switch (value.kind) {
        case "stroke": {
            const color = normalizeColor(value.color);
            if (!PEN_TYPES.includes(value.pen as PenType) || !color || !SIZES.includes(value.size as never) || !isPoints(value.points, MAX_POINTS_PER_OP) || value.points.length === 0) {
                return undefined;
            }
            return { kind: "stroke", id, epoch, pen: value.pen as PenType, color, size: value.size as number, points: [...value.points] };
        }
        case "shape": {
            const color = normalizeColor(value.color);
            if (
                !STENCIL_SHAPES.includes(value.shape as StencilShape) ||
                !color ||
                !SIZES.includes(value.size as never) ||
                !isCoordinate(value.x1, BOARD_WIDTH) ||
                !isCoordinate(value.y1, BOARD_HEIGHT) ||
                !isCoordinate(value.x2, BOARD_WIDTH) ||
                !isCoordinate(value.y2, BOARD_HEIGHT)
            ) {
                return undefined;
            }
            const { x1, y1, x2, y2 } = value as unknown as ShapeElement;
            return { kind: "shape", id, epoch, shape: value.shape as StencilShape, color, size: value.size as number, x1, y1, x2, y2 };
        }
        case "stamp": {
            if (!STAMPS.includes(value.stamp as Stamp) || !STAMP_SIZES.includes(value.size as never) || !isCoordinate(value.x, BOARD_WIDTH) || !isCoordinate(value.y, BOARD_HEIGHT)) {
                return undefined;
            }
            return { kind: "stamp", id, epoch, stamp: value.stamp as Stamp, size: value.size as number, x: value.x, y: value.y };
        }
        default:
            return undefined;
    }
}

/** A received whiteboard op, validated and copied, or `undefined` to drop it. */
export function parseWhiteboardOp(value: unknown): WhiteboardOp | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    switch (value.op) {
        case "add": {
            const element = parseElement(value.element);
            return element ? { op: "add", element } : undefined;
        }
        case "points":
            if (!isId(value.id) || !Number.isInteger(value.start) || (value.start as number) < 0 || (value.start as number) >= MAX_STROKE_POINTS) {
                return undefined;
            }
            if (!isPoints(value.points, MAX_POINTS_PER_OP) || value.points.length === 0) {
                return undefined;
            }
            return { op: "points", id: value.id, start: value.start as number, points: [...value.points] };
        case "remove":
            if (!Array.isArray(value.ids) || value.ids.length === 0 || value.ids.length > MAX_REMOVE_IDS || !value.ids.every(isId)) {
                return undefined;
            }
            return { op: "remove", ids: [...(value.ids)] };
        case "clear":
            return isEpoch(value.epoch) ? { op: "clear", epoch: value.epoch } : undefined;
        default:
            return undefined;
    }
}

/** A received chat message, validated and copied, or `undefined` to drop it. Blank text is dropped too. */
export function parseChat(value: unknown): ChatPayload | undefined {
    if (!isRecord(value) || !isId(value.id) || typeof value.text !== "string" || typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt)) {
        return undefined;
    }
    if (value.text.length > MAX_CHAT_LENGTH || !value.text.trim()) {
        return undefined;
    }
    return { id: value.id, text: value.text, sentAt: value.sentAt };
}

/** A received catch-up part, validated and copied; entries that fail validation are left out rather than dropping
 * the whole part, and `undefined` only when the part itself is malformed. */
export function parseSync(value: unknown): SyncPayload | undefined {
    if (!isRecord(value) || !Number.isInteger(value.part) || !Number.isInteger(value.of) || !isEpoch(value.epoch)) {
        return undefined;
    }
    const part = value.part as number;
    const of = value.of as number;
    if (of < 1 || part < 0 || part >= of || !Array.isArray(value.chat) || !Array.isArray(value.ops)) {
        return undefined;
    }
    const chat: ChatHistoryEntry[] = [];
    for (const entry of value.chat) {
        const parsed = parseChat(entry);
        if (parsed && isRecord(entry) && isId(entry.peer) && typeof entry.name === "string" && entry.name.length <= MAX_NAME_LENGTH) {
            chat.push({ ...parsed, peer: entry.peer, name: entry.name });
        }
    }
    const ops: WhiteboardOp[] = [];
    for (const op of value.ops) {
        const parsed = parseWhiteboardOp(op);
        if (parsed) {
            ops.push(parsed);
        }
    }
    return { part, of, epoch: value.epoch, chat, ops };
}

/** What a participant's pointer on the board shows: the pen, or the stencil, stamp or eraser, they have picked. */
export const CURSOR_TOOLS = [...PEN_TYPES, "stencil", "stamp", "eraser"] as const;
export type CursorTool = (typeof CURSOR_TOOLS)[number];

/** Where a participant's pointer is on the board, and as what - or that it has left the board. Never stored, never
 * part of a catch-up: a pointer is only ever where it was a moment ago. */
export type CursorPayload = { hidden: true } | { x: number; y: number; tool: CursorTool; color: string; stamp?: Stamp };

/** A received pointer update, validated and copied, or `undefined` to drop it. */
export function parseCursor(value: unknown): CursorPayload | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (value.hidden === true) {
        return { hidden: true };
    }
    const color = normalizeColor(value.color);
    if (!CURSOR_TOOLS.includes(value.tool as CursorTool) || !color || !isCoordinate(value.x, BOARD_WIDTH) || !isCoordinate(value.y, BOARD_HEIGHT)) {
        return undefined;
    }
    if (value.stamp !== undefined && !STAMPS.includes(value.stamp as Stamp)) {
        return undefined;
    }
    const cursor: CursorPayload = { x: value.x, y: value.y, tool: value.tool as CursorTool, color };
    if (value.stamp !== undefined) {
        cursor.stamp = value.stamp as Stamp;
    }
    return cursor;
}

/** `value` rounded and kept within `[0, max]` - every coordinate this participant sends is, so no receiver's
 * validation (which allows some slack beyond the board) ever drops it. */
export function clampCoordinate(value: number, max: number): number {
    return Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}
