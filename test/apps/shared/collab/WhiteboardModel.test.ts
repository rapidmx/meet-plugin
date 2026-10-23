///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { MAX_PENDING_POINT_OPS, MAX_TOMBSTONES, WhiteboardModel } from "../../../../apps/shared/collab/WhiteboardModel.js";
import {
    MAX_BOARD_ELEMENTS,
    MAX_POINTS_PER_OP,
    MAX_STROKE_POINTS,
    type BoardElement,
    type ShapeElement,
    type StampElement,
    type StrokeElement,
    type WhiteboardOp,
} from "../../../../apps/shared/collab/protocol.js";

function stroke(id: string, points: number[], overrides: Partial<StrokeElement> = {}): StrokeElement {
    return { kind: "stroke", id, epoch: 0, pen: "ballpoint", color: "#112233", size: 4, points, ...overrides };
}

function shape(id: string, overrides: Partial<ShapeElement> = {}): ShapeElement {
    return { kind: "shape", id, epoch: 0, shape: "rect", color: "#445566", size: 2, x1: 0, y1: 0, x2: 10, y2: 10, ...overrides };
}

function stamp(id: string, overrides: Partial<StampElement> = {}): StampElement {
    return { kind: "stamp", id, epoch: 0, stamp: "⭐", size: 32, x: 5, y: 5, ...overrides };
}

function add(element: BoardElement): WhiteboardOp {
    return { op: "add", element };
}

function points(id: string, start: number, pts: number[]): WhiteboardOp {
    return { op: "points", id, start, points: pts };
}

/** `count` points, the n-th at (n, n). */
function run(from: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => [from + i, from + i]).flat();
}

function strokePoints(model: WhiteboardModel, id: string): number[] | undefined {
    const element = model.get(id);
    return element?.kind === "stroke" ? element.points : undefined;
}

describe("WhiteboardModel", () => {
    describe("a new board", () => {
        it("is empty, at epoch 0 and revision 0, with room", () => {
            const model = new WhiteboardModel();
            expect(model.elements).toEqual([]);
            expect(model.size).toBe(0);
            expect(model.epoch).toBe(0);
            expect(model.revision).toBe(0);
            expect(model.hasRoom).toBe(true);
            expect(model.get("a:1")).toBeUndefined();
            expect(model.toOps()).toEqual([]);
        });
    });

    describe("add", () => {
        it("adds each kind of element in drawing order", () => {
            const model = new WhiteboardModel();
            expect(model.apply(add(stroke("a:1", [1, 2])), "a")).toBe(true);
            expect(model.apply(add(shape("a:2")), "a")).toBe(true);
            expect(model.apply(add(stamp("b:1")), "b")).toBe(true);
            expect(model.elements.map((e) => e.id)).toEqual(["a:1", "a:2", "b:1"]);
            expect(model.size).toBe(3);
            expect(model.get("a:2")).toEqual(shape("a:2"));
            expect(model.revision).toBe(3);
        });

        it("ignores an add under someone else's id", () => {
            const model = new WhiteboardModel();
            expect(model.apply(add(stroke("a:1", [1, 2])), "b")).toBe(false);
            expect(model.apply(add(stroke("ab:1", [1, 2])), "a")).toBe(false);
            expect(model.size).toBe(0);
            expect(model.revision).toBe(0);
        });

        it("accepts any id from a catch-up (author null)", () => {
            const model = new WhiteboardModel();
            expect(model.apply(add(stroke("a:1", [1, 2])), null)).toBe(true);
            expect(model.apply(add(stamp("b:1")), null)).toBe(true);
            expect(model.size).toBe(2);
        });

        it("copies a stroke's points, so later changes to the op don't reach the board", () => {
            const model = new WhiteboardModel();
            const pts = [1, 2];
            model.apply(add(stroke("a:1", pts)), "a");
            pts.push(3, 4);
            expect(strokePoints(model, "a:1")).toEqual([1, 2]);
        });

        it("cuts a stroke longer than MAX_STROKE_POINTS down to it", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, MAX_STROKE_POINTS + 10))), "a");
            expect(strokePoints(model, "a:1")).toHaveLength(MAX_STROKE_POINTS * 2);
        });

        it("extends an existing stroke by what a repeated add has beyond it", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 2))), "a");
            const revision = model.revision;
            expect(model.apply(add(stroke("a:1", run(0, 5))), "a")).toBe(true);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 5));
            expect(model.revision).toBe(revision + 1);
            expect(model.size).toBe(1);
        });

        it("keeps the points a stroke already has when a repeated add disagrees with them", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", [1, 1, 2, 2])), "a");
            expect(model.apply(add(stroke("a:1", [9, 9, 9, 9, 3, 3])), "a")).toBe(true);
            expect(strokePoints(model, "a:1")).toEqual([1, 1, 2, 2, 3, 3]);
        });

        it("reports no change for a repeated add of a stroke with no more points", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 3))), "a");
            const revision = model.revision;
            expect(model.apply(add(stroke("a:1", run(0, 3))), "a")).toBe(false);
            expect(model.apply(add(stroke("a:1", run(0, 1))), null)).toBe(false);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 3));
            expect(model.revision).toBe(revision);
        });

        it("ignores a repeated add of a shape or stamp, or one that changes an element's kind", () => {
            const model = new WhiteboardModel();
            model.apply(add(shape("a:1")), "a");
            model.apply(add(stamp("a:2")), "a");
            model.apply(add(stroke("a:3", [1, 1])), "a");
            const revision = model.revision;
            expect(model.apply(add(shape("a:1", { x2: 500 })), "a")).toBe(false);
            expect(model.apply(add(stamp("a:2", { x: 99 })), "a")).toBe(false);
            expect(model.apply(add(stroke("a:1", [1, 1, 2, 2])), "a")).toBe(false);
            expect(model.apply(add(shape("a:3")), "a")).toBe(false);
            expect(model.get("a:1")).toEqual(shape("a:1"));
            expect(model.get("a:2")).toEqual(stamp("a:2"));
            expect(model.get("a:3")).toEqual(stroke("a:3", [1, 1]));
            expect(model.revision).toBe(revision);
        });

        it("ignores a repeated add of someone else's stroke even when it would extend it", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", [1, 1])), "a");
            expect(model.apply(add(stroke("a:1", [1, 1, 2, 2])), "b")).toBe(false);
            expect(strokePoints(model, "a:1")).toEqual([1, 1]);
        });

        it("refuses a new element once the board holds MAX_BOARD_ELEMENTS, until one is erased", () => {
            const model = new WhiteboardModel();
            for (let i = 0; i < MAX_BOARD_ELEMENTS; i++) {
                expect(model.apply(add(stamp(`a:${i}`)), "a")).toBe(true);
            }
            expect(model.hasRoom).toBe(false);
            expect(model.apply(add(stamp("a:extra")), "a")).toBe(false);
            expect(model.apply(add(stroke("a:stroke", [1, 1])), null)).toBe(false);
            expect(model.size).toBe(MAX_BOARD_ELEMENTS);
            model.apply({ op: "remove", ids: ["a:0"] }, "b");
            expect(model.hasRoom).toBe(true);
            expect(model.apply(add(stamp("a:extra")), "a")).toBe(true);
        });

        it("still extends an existing stroke on a full board", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:s", [1, 1])), "a");
            for (let i = 1; i < MAX_BOARD_ELEMENTS; i++) {
                model.apply(add(stamp(`a:${i}`)), "a");
            }
            expect(model.hasRoom).toBe(false);
            expect(model.apply(add(stroke("a:s", [1, 1, 2, 2])), "a")).toBe(true);
            expect(model.apply(points("a:s", 2, [3, 3]), "a")).toBe(true);
            expect(strokePoints(model, "a:s")).toEqual([1, 1, 2, 2, 3, 3]);
        });
    });

    describe("points", () => {
        it("appends to the author's own stroke from its start index", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 2))), "a");
            expect(model.apply(points("a:1", 2, run(2, 3)), "a")).toBe(true);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 5));
        });

        it("ignores points for someone else's stroke, but takes them from a catch-up", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 1))), "a");
            expect(model.apply(points("a:1", 1, run(1, 1)), "b")).toBe(false);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 1));
            expect(model.apply(points("a:1", 1, run(1, 1)), null)).toBe(true);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 2));
        });

        it("doesn't hold someone else's points either, so they never apply later", () => {
            const model = new WhiteboardModel();
            expect(model.apply(points("a:1", 1, run(1, 1)), "b")).toBe(false);
            model.apply(add(stroke("a:1", run(0, 1))), "a");
            expect(strokePoints(model, "a:1")).toEqual(run(0, 1));
        });

        it("ignores points for a shape or a stamp", () => {
            const model = new WhiteboardModel();
            model.apply(add(shape("a:1")), "a");
            model.apply(add(stamp("a:2")), "a");
            const revision = model.revision;
            expect(model.apply(points("a:1", 0, [1, 1]), "a")).toBe(false);
            expect(model.apply(points("a:2", 0, [1, 1]), null)).toBe(false);
            expect(model.get("a:1")).toEqual(shape("a:1"));
            expect(model.get("a:2")).toEqual(stamp("a:2"));
            expect(model.revision).toBe(revision);
        });

        it("treats repeated or overlapping points as harmless, keeping the points already held", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 3))), "a");
            const revision = model.revision;
            expect(model.apply(points("a:1", 1, [7, 7, 8, 8]), "a")).toBe(false);
            expect(model.apply(points("a:1", 0, run(0, 3)), "a")).toBe(false);
            expect(model.revision).toBe(revision);
            expect(model.apply(points("a:1", 1, [7, 7, 8, 8, 3, 3, 4, 4]), "a")).toBe(true);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 5));
        });

        it("writes nothing past MAX_STROKE_POINTS", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, MAX_STROKE_POINTS - 1))), "a");
            expect(model.apply(points("a:1", MAX_STROKE_POINTS - 1, [1, 1, 2, 2, 3, 3]), "a")).toBe(true);
            expect(strokePoints(model, "a:1")).toHaveLength(MAX_STROKE_POINTS * 2);
            expect(strokePoints(model, "a:1")!.slice(-2)).toEqual([1, 1]);
            expect(model.apply(points("a:1", MAX_STROKE_POINTS, [4, 4]), "a")).toBe(false);
            expect(strokePoints(model, "a:1")).toHaveLength(MAX_STROKE_POINTS * 2);
        });

        describe("out of order", () => {
            it("holds points for a stroke that hasn't arrived and applies them when it does", () => {
                const model = new WhiteboardModel();
                expect(model.apply(points("a:1", 2, run(2, 2)), "a")).toBe(false);
                expect(model.size).toBe(0);
                expect(model.revision).toBe(0);
                expect(model.apply(add(stroke("a:1", run(0, 2))), "a")).toBe(true);
                expect(strokePoints(model, "a:1")).toEqual(run(0, 4));
            });

            it("holds points that start past the end and applies them when the gap fills", () => {
                const model = new WhiteboardModel();
                model.apply(add(stroke("a:1", run(0, 2))), "a");
                expect(model.apply(points("a:1", 4, run(4, 2)), "a")).toBe(false);
                expect(strokePoints(model, "a:1")).toEqual(run(0, 2));
                expect(model.apply(points("a:1", 2, run(2, 2)), "a")).toBe(true);
                expect(strokePoints(model, "a:1")).toEqual(run(0, 6));
            });

            it("drains a whole chain of held ops, in any arrival order", () => {
                const model = new WhiteboardModel();
                model.apply(points("a:1", 8, run(8, 2)), "a");
                model.apply(points("a:1", 4, run(4, 2)), "a");
                model.apply(points("a:1", 6, run(6, 2)), "a");
                model.apply(points("a:1", 2, run(2, 2)), "a");
                model.apply(add(stroke("a:1", run(0, 2))), "a");
                expect(strokePoints(model, "a:1")).toEqual(run(0, 10));
            });

            it("drains held ops only for their own stroke, leaving others' waiting", () => {
                const model = new WhiteboardModel();
                model.apply(points("b:1", 1, run(1, 1)), "b");
                model.apply(points("a:1", 1, run(1, 1)), "a");
                model.apply(add(stroke("a:1", run(0, 1))), "a");
                expect(strokePoints(model, "a:1")).toEqual(run(0, 2));
                model.apply(add(stroke("b:1", run(0, 1))), "b");
                expect(strokePoints(model, "b:1")).toEqual(run(0, 2));
            });

            it("keeps a held op waiting while its gap is only partly filled", () => {
                const model = new WhiteboardModel();
                model.apply(add(stroke("a:1", run(0, 1))), "a");
                model.apply(points("a:1", 3, run(3, 1)), "a");
                model.apply(points("a:1", 1, run(1, 1)), "a");
                expect(strokePoints(model, "a:1")).toEqual(run(0, 2));
                model.apply(points("a:1", 2, run(2, 1)), "a");
                expect(strokePoints(model, "a:1")).toEqual(run(0, 4));
            });

            it("discards a held op that the stroke has already overtaken", () => {
                const model = new WhiteboardModel();
                model.apply(points("a:1", 1, [9, 9]), "a");
                model.apply(add(stroke("a:1", run(0, 3))), null);
                expect(strokePoints(model, "a:1")).toEqual(run(0, 3));
                // The overtaken op is gone: a later shorter add doesn't revive it.
                model.apply(points("a:1", 3, run(3, 1)), "a");
                expect(strokePoints(model, "a:1")).toEqual(run(0, 4));
            });

            it("drains held ops when a repeated add fills the gap", () => {
                const model = new WhiteboardModel();
                model.apply(add(stroke("a:1", run(0, 1))), "a");
                model.apply(points("a:1", 3, run(3, 2)), "a");
                model.apply(add(stroke("a:1", run(0, 3))), null);
                expect(strokePoints(model, "a:1")).toEqual(run(0, 5));
            });

            it("holds at most MAX_PENDING_POINT_OPS ops, dropping the oldest", () => {
                const model = new WhiteboardModel();
                // The op that fills the gap first arrives first, so it is the one pushed out.
                model.apply(points("a:1", 1, run(1, 1)), "a");
                for (let i = 0; i < MAX_PENDING_POINT_OPS; i++) {
                    model.apply(points(`a:other${i}`, 1, [1, 1]), "a");
                }
                model.apply(add(stroke("a:1", run(0, 1))), "a");
                expect(strokePoints(model, "a:1")).toEqual(run(0, 1));
                // The newest held op is still there.
                model.apply(add(stroke(`a:other${MAX_PENDING_POINT_OPS - 1}`, [0, 0])), "a");
                expect(strokePoints(model, `a:other${MAX_PENDING_POINT_OPS - 1}`)).toEqual([0, 0, 1, 1]);
                // The oldest kept is also still there, exactly at the cap.
                model.apply(add(stroke("a:other0", [0, 0])), "a");
                expect(strokePoints(model, "a:other0")).toEqual([0, 0, 1, 1]);
            });
        });
    });

    describe("remove", () => {
        it("removes any element, whoever drew it", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", [1, 1])), "a");
            model.apply(add(shape("b:1")), "b");
            model.apply(add(stamp("c:1")), "c");
            const revision = model.revision;
            expect(model.apply({ op: "remove", ids: ["a:1", "c:1"] }, "b")).toBe(true);
            expect(model.elements.map((e) => e.id)).toEqual(["b:1"]);
            expect(model.revision).toBe(revision + 1);
        });

        it("reports no change, and doesn't bump the revision, when nothing it names is there", () => {
            const model = new WhiteboardModel();
            model.apply(add(stamp("a:1")), "a");
            const revision = model.revision;
            expect(model.apply({ op: "remove", ids: ["x:1", "x:2"] }, "a")).toBe(false);
            expect(model.revision).toBe(revision);
            expect(model.size).toBe(1);
        });

        it("keeps a removed element from coming back through an add", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", [1, 1])), "a");
            model.apply({ op: "remove", ids: ["a:1"] }, "b");
            expect(model.apply(add(stroke("a:1", [1, 1, 2, 2])), "a")).toBe(false);
            expect(model.apply(add(stroke("a:1", [1, 1])), null)).toBe(false);
            expect(model.get("a:1")).toBeUndefined();
        });

        it("keeps an element removed before it ever arrived from being added", () => {
            const model = new WhiteboardModel();
            expect(model.apply({ op: "remove", ids: ["a:1"] }, "b")).toBe(false);
            expect(model.apply(add(stamp("a:1")), "a")).toBe(false);
            expect(model.size).toBe(0);
        });

        it("ignores points for a removed stroke", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", [1, 1])), "a");
            model.apply({ op: "remove", ids: ["a:1"] }, "a");
            const revision = model.revision;
            expect(model.apply(points("a:1", 1, [2, 2]), "a")).toBe(false);
            expect(model.apply(points("a:1", 0, [2, 2]), null)).toBe(false);
            expect(model.revision).toBe(revision);
            expect(model.get("a:1")).toBeUndefined();
        });

        it("remembers at most MAX_TOMBSTONES ids, forgetting the oldest", () => {
            const model = new WhiteboardModel();
            const ids = Array.from({ length: MAX_TOMBSTONES }, (_, i) => `a:${i}`);
            for (let i = 0; i < ids.length; i += 500) {
                model.apply({ op: "remove", ids: ids.slice(i, i + 500) }, "a");
            }
            // At the cap, every one is still remembered.
            expect(model.apply(add(stamp("a:0")), "a")).toBe(false);
            model.apply({ op: "remove", ids: ["a:new"] }, "a");
            // One more pushed the oldest out, so it can be drawn again; the next oldest is still remembered.
            expect(model.apply(add(stamp("a:0")), "a")).toBe(true);
            expect(model.apply(add(stamp("a:1")), "a")).toBe(false);
            expect(model.apply(add(stamp("a:new")), "a")).toBe(false);
        });
    });

    describe("clear", () => {
        it("raises the epoch and drops every element drawn before it", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", [1, 1])), "a");
            model.apply(add(shape("b:1")), "b");
            const revision = model.revision;
            expect(model.apply({ op: "clear", epoch: 1 }, "c")).toBe(true);
            expect(model.epoch).toBe(1);
            expect(model.size).toBe(0);
            expect(model.revision).toBe(revision + 1);
        });

        it("keeps elements already drawn in the new epoch or later", () => {
            const model = new WhiteboardModel();
            model.apply(add(stamp("a:1", { epoch: 0 })), "a");
            model.apply(add(stamp("a:2", { epoch: 2 })), "a");
            model.apply(add(stamp("a:3", { epoch: 3 })), "a");
            model.apply({ op: "clear", epoch: 2 }, null);
            expect(model.elements.map((e) => e.id)).toEqual(["a:2", "a:3"]);
        });

        it("is a no-op at the same or a lower epoch", () => {
            const model = new WhiteboardModel();
            model.apply({ op: "clear", epoch: 3 }, "a");
            model.apply(add(stamp("a:1", { epoch: 3 })), "a");
            const revision = model.revision;
            expect(model.apply({ op: "clear", epoch: 3 }, "a")).toBe(false);
            expect(model.apply({ op: "clear", epoch: 1 }, "a")).toBe(false);
            expect(model.apply({ op: "clear", epoch: 0 }, null)).toBe(false);
            expect(model.epoch).toBe(3);
            expect(model.size).toBe(1);
            expect(model.revision).toBe(revision);
        });

        it("is a no-op at epoch 0 on a new board", () => {
            const model = new WhiteboardModel();
            expect(model.apply({ op: "clear", epoch: 0 }, "a")).toBe(false);
            expect(model.revision).toBe(0);
        });

        it("refuses an element from an older epoch afterwards", () => {
            const model = new WhiteboardModel();
            model.apply({ op: "clear", epoch: 2 }, "a");
            expect(model.apply(add(stroke("a:1", [1, 1], { epoch: 1 })), "a")).toBe(false);
            expect(model.apply(add(stamp("a:2", { epoch: 1 })), null)).toBe(false);
            expect(model.apply(add(stamp("a:3", { epoch: 2 })), "a")).toBe(true);
            expect(model.elements.map((e) => e.id)).toEqual(["a:3"]);
        });

        it("drops points held for a stroke that was cleared away", () => {
            const model = new WhiteboardModel();
            model.apply(points("a:1", 1, run(1, 1)), "a");
            model.apply({ op: "clear", epoch: 1 }, "b");
            // Its add, from before the clear, is refused, so the held points never surface.
            expect(model.apply(add(stroke("a:1", run(0, 1), { epoch: 0 })), "a")).toBe(false);
            expect(model.get("a:1")).toBeUndefined();
        });

        it("forgets points held for a stroke on the board that the clear removed", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 1))), "a");
            model.apply(points("a:1", 3, [7, 7]), "a");
            model.apply({ op: "clear", epoch: 1 }, "b");
            // Even were the same id to be drawn again in the new epoch, the old held points don't attach to it.
            model.apply(add(stroke("a:1", run(0, 3), { epoch: 1 })), "a");
            expect(strokePoints(model, "a:1")).toEqual(run(0, 3));
        });

        it("doesn't drop points held for a stroke of the new epoch, so a catch-up's clear can't truncate it", () => {
            // A newcomer joins while `a` is drawing a stroke in epoch 1: a live `points` op for it arrives before the
            // catch-up, which begins with a clear to its epoch and carries the stroke as far as it had got.
            const model = new WhiteboardModel();
            model.apply(points("a:1", 3, run(3, 2)), "a");
            model.apply({ op: "clear", epoch: 1 }, null);
            model.apply(add(stroke("a:1", run(0, 3), { epoch: 1 })), null);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 5));
            // And the live ops after it keep connecting.
            expect(model.apply(points("a:1", 5, run(5, 1)), "a")).toBe(true);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 6));
        });
    });

    describe("revision", () => {
        it("bumps on every change and only on a change", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", [1, 1])), "a");
            expect(model.revision).toBe(1);
            model.apply(points("a:1", 1, [2, 2]), "a");
            expect(model.revision).toBe(2);
            model.apply(points("a:1", 1, [2, 2]), "a");
            model.apply(add(stroke("b:1", [1, 1])), "a");
            model.apply(points("a:1", 9, [2, 2]), "a");
            expect(model.revision).toBe(2);
            model.apply({ op: "remove", ids: ["a:1"] }, "a");
            expect(model.revision).toBe(3);
            model.apply({ op: "clear", epoch: 1 }, "a");
            expect(model.revision).toBe(4);
        });
    });

    describe("toOps", () => {
        function populated(): WhiteboardModel {
            const model = new WhiteboardModel();
            model.apply({ op: "clear", epoch: 2 }, "a");
            model.apply(add(stroke("a:1", run(0, 3), { epoch: 2, pen: "crayon" })), "a");
            model.apply(add(shape("b:1", { epoch: 2, shape: "star" })), "b");
            model.apply(add(stamp("c:1", { epoch: 3 })), "c");
            model.apply(add(stroke("b:2", run(10, 1), { epoch: 2, pen: "pencil", size: 24 })), "b");
            return model;
        }

        it("gives an add per element, in drawing order", () => {
            const model = populated();
            expect(model.toOps()).toEqual(model.elements.map((element) => ({ op: "add", element })));
        });

        it("rebuilds an identical board when applied to a fresh one as a catch-up", () => {
            const model = populated();
            const copy = new WhiteboardModel();
            for (const op of model.toOps()) {
                expect(copy.apply(op, null)).toBe(true);
            }
            expect(copy.elements).toEqual(model.elements);
        });

        it("hands out copies, so changing an op doesn't change the board", () => {
            const model = populated();
            const ops = model.toOps();
            for (const op of ops) {
                if (op.op === "add") {
                    op.element.id = "changed";
                    if (op.element.kind === "stroke") {
                        op.element.points.push(1, 1);
                    }
                }
            }
            expect(model.elements.map((e) => e.id)).toEqual(["a:1", "b:1", "c:1", "b:2"]);
            expect(strokePoints(model, "a:1")).toEqual(run(0, 3));
        });

        it("splits a long stroke into an add and points ops of at most pointsPerOp points", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 10))), "a");
            const ops = model.toOps(4);
            expect(ops).toEqual([
                { op: "add", element: stroke("a:1", run(0, 4)) },
                { op: "points", id: "a:1", start: 4, points: run(4, 4) },
                { op: "points", id: "a:1", start: 8, points: run(8, 2) },
            ]);
            const copy = new WhiteboardModel();
            for (const op of ops) {
                copy.apply(op, null);
            }
            expect(copy.elements).toEqual(model.elements);
        });

        it("doesn't split a stroke of exactly pointsPerOp points", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 4))), "a");
            expect(model.toOps(4)).toEqual([{ op: "add", element: stroke("a:1", run(0, 4)) }]);
        });

        it("rebuilds the same board whatever order the split ops arrive in", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 9))), "a");
            const ops = model.toOps(2).reverse();
            const copy = new WhiteboardModel();
            for (const op of ops) {
                copy.apply(op, null);
            }
            expect(copy.elements).toEqual(model.elements);
        });

        it("clamps pointsPerOp to at least 1", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, 3))), "a");
            const expected = [
                { op: "add", element: stroke("a:1", run(0, 1)) },
                { op: "points", id: "a:1", start: 1, points: run(1, 1) },
                { op: "points", id: "a:1", start: 2, points: run(2, 1) },
            ];
            expect(model.toOps(0)).toEqual(expected);
            expect(model.toOps(-5)).toEqual(expected);
        });

        it("clamps pointsPerOp to at most MAX_POINTS_PER_OP", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, MAX_POINTS_PER_OP))), null);
            model.apply(points("a:1", MAX_POINTS_PER_OP, run(0, 5)), null);
            const ops = model.toOps(MAX_POINTS_PER_OP * 10);
            expect(ops).toHaveLength(2);
            expect(ops[0]).toEqual({ op: "add", element: stroke("a:1", run(0, MAX_POINTS_PER_OP)) });
            expect(ops[1]).toEqual({ op: "points", id: "a:1", start: MAX_POINTS_PER_OP, points: run(0, 5) });
            // The default is the maximum too.
            expect(model.toOps()).toEqual(ops);
        });

        it("splits a stroke at the MAX_STROKE_POINTS cap into ops a fresh board takes whole", () => {
            const model = new WhiteboardModel();
            model.apply(add(stroke("a:1", run(0, MAX_STROKE_POINTS))), null);
            const ops = model.toOps();
            expect(ops).toHaveLength(MAX_STROKE_POINTS / MAX_POINTS_PER_OP);
            const copy = new WhiteboardModel();
            for (const op of ops) {
                copy.apply(op, null);
            }
            expect(copy.elements).toEqual(model.elements);
        });
    });
});
