///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The shared whiteboard's state: its elements in drawing order and its epoch, changed only by `apply()`ing
 * `WhiteboardOp`s - this participant's own as much as everyone else's, so every participant's board is built the same
 * way from the same ops. See `protocol.ts` for the rules an op is held to (who may add to which element, what the
 * epoch is for).
 *
 * Ops reach a participant in whatever order the network delivers them, and a newcomer's catch-up races the live ops
 * sent while it travels, so `apply()` is built to give the same board whatever the order:
 *
 * - `points` for a stroke that hasn't arrived yet, or that start past the points it has so far, wait (a bounded
 * number of them) and are applied the moment the gap is filled. Points already held are kept as they are.
 * - An `add` for an element already on the board adds only what it has beyond it (more points) - a catch-up repeating
 * what live ops already brought is harmless.
 * - A removed element stays removed: its id is remembered, so a catch-up sent before the erase cannot bring it back.
 */
import { MAX_BOARD_ELEMENTS, MAX_POINTS_PER_OP, MAX_STROKE_POINTS, isOwnId, type BoardElement, type WhiteboardOp } from "./protocol.js";

/** The most `points` ops held while their stroke, or the points before them, are still missing. */
export const MAX_PENDING_POINT_OPS = 400;

/** The most removed ids remembered. */
export const MAX_TOMBSTONES = 10_000;

type PointsOp = Extract<WhiteboardOp, { op: "points" }>;

export class WhiteboardModel {
    private readonly byId = new Map<string, BoardElement>();
    private readonly pending: PointsOp[] = [];
    private readonly tombstones = new Set<string>();
    private currentEpoch = 0;
    /** Bumped on every change, so a view can tell whether it needs to draw again. */
    private rev = 0;

    get epoch(): number {
        return this.currentEpoch;
    }

    get revision(): number {
        return this.rev;
    }

    /** Every element, in drawing order (oldest first). */
    get elements(): BoardElement[] {
        return [...this.byId.values()];
    }

    get size(): number {
        return this.byId.size;
    }

    get(id: string): BoardElement | undefined {
        return this.byId.get(id);
    }

    /** Whether one more element fits on the board. */
    get hasRoom(): boolean {
        return this.byId.size < MAX_BOARD_ELEMENTS;
    }

    /**
     * Applies `op` - sent by peer `author`, or, for `null`, carried by a catch-up on its authors' behalf (it names no
     * single author; see `CollabSession` on how far a catch-up is trusted). Returns whether the board changed.
     */
    apply(op: WhiteboardOp, author: string | null): boolean {
        switch (op.op) {
            case "add":
                return this.add(op.element, author);
            case "points":
                return this.points(op, author);
            case "remove":
                return this.remove(op.ids);
            case "clear":
                return this.clear(op.epoch);
        }
    }

    /** The ops that rebuild this board from nothing - a newcomer's catch-up. A long stroke is split into an `add` and
     * `points` ops of at most `pointsPerOp` points each (never more than `MAX_POINTS_PER_OP`). */
    toOps(pointsPerOp: number = MAX_POINTS_PER_OP): WhiteboardOp[] {
        const ops: WhiteboardOp[] = [];
        const perOp = Math.max(1, Math.floor(Math.min(pointsPerOp, MAX_POINTS_PER_OP)) || 1) * 2;
        for (const element of this.byId.values()) {
            if (element.kind !== "stroke" || element.points.length <= perOp) {
                ops.push({ op: "add", element: element.kind === "stroke" ? { ...element, points: [...element.points] } : { ...element } });
                continue;
            }
            ops.push({ op: "add", element: { ...element, points: element.points.slice(0, perOp) } });
            for (let i = perOp; i < element.points.length; i += perOp) {
                ops.push({ op: "points", id: element.id, start: i / 2, points: element.points.slice(i, i + perOp) });
            }
        }
        return ops;
    }

    private add(element: BoardElement, author: string | null): boolean {
        if ((author !== null && !isOwnId(element.id, author)) || element.epoch < this.currentEpoch || this.tombstones.has(element.id)) {
            return false;
        }
        const existing = this.byId.get(element.id);
        if (existing) {
            // Only a stroke grows; anything else is already all there.
            if (existing.kind !== "stroke" || element.kind !== "stroke") {
                return false;
            }
            return this.writePoints(existing, 0, element.points);
        }
        if (!this.hasRoom) {
            return false;
        }
        this.byId.set(element.id, element.kind === "stroke" ? { ...element, points: element.points.slice(0, MAX_STROKE_POINTS * 2) } : { ...element });
        this.changed();
        const added = this.byId.get(element.id)!;
        if (added.kind === "stroke") {
            this.drainPending(added);
        }
        return true;
    }

    private points(op: PointsOp, author: string | null): boolean {
        if ((author !== null && !isOwnId(op.id, author)) || this.tombstones.has(op.id)) {
            return false;
        }
        const element = this.byId.get(op.id);
        if (element && element.kind !== "stroke") {
            return false;
        }
        if (!element || op.start * 2 > element.points.length) {
            this.hold(op);
            return false;
        }
        return this.writePoints(element, op.start, op.points);
    }

    /** Writes `points` into `stroke` from point index `start`, then whatever was waiting for them. */
    private writePoints(stroke: Extract<BoardElement, { kind: "stroke" }>, start: number, points: number[]): boolean {
        const offset = start * 2;
        const end = Math.min(offset + points.length, MAX_STROKE_POINTS * 2);
        if (end <= stroke.points.length) {
            return false;
        }
        for (let i = Math.max(offset, stroke.points.length); i < end; i++) {
            stroke.points[i] = points[i - offset];
        }
        this.changed();
        this.drainPending(stroke);
        return true;
    }

    private hold(op: PointsOp): void {
        if (this.pending.length >= MAX_PENDING_POINT_OPS) {
            this.pending.shift();
        }
        this.pending.push(op);
    }

    /** Applies every held `points` op for `stroke` that now connects to what it has. */
    private drainPending(stroke: Extract<BoardElement, { kind: "stroke" }>): void {
        let progressed = true;
        while (progressed) {
            progressed = false;
            for (let i = 0; i < this.pending.length; i++) {
                const op = this.pending[i];
                if (op.id === stroke.id && op.start * 2 <= stroke.points.length) {
                    this.pending.splice(i, 1);
                    this.writePoints(stroke, op.start, op.points);
                    progressed = true;
                    break;
                }
            }
        }
    }

    private remove(ids: string[]): boolean {
        let changed = false;
        for (const id of ids) {
            if (this.tombstones.size >= MAX_TOMBSTONES) {
                this.tombstones.delete(this.tombstones.values().next().value as string);
            }
            this.tombstones.add(id);
            changed = this.byId.delete(id) || changed;
        }
        if (changed) {
            this.changed();
        }
        return changed;
    }

    private clear(epoch: number): boolean {
        if (epoch <= this.currentEpoch) {
            return false;
        }
        this.currentEpoch = epoch;
        const cleared = new Set<string>();
        for (const [id, element] of this.byId) {
            if (element.epoch < epoch) {
                this.byId.delete(id);
                cleared.add(id);
            }
        }
        // Drop only the points held for strokes just cleared away: one not here yet may belong to the new epoch - a
        // newcomer's catch-up starts with a clear that races the live ops of a stroke being drawn - and the rest can
        // never drain anyway (an older epoch's `add` is refused), so they just age out under the cap.
        const kept = this.pending.filter((op) => !cleared.has(op.id));
        this.pending.splice(0, this.pending.length, ...kept);
        this.changed();
        return true;
    }

    private changed(): void {
        this.rev += 1;
    }
}
