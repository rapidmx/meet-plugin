///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    CURSOR_TOOLS,
    MAX_CHAT_LENGTH,
    MAX_ID_LENGTH,
    MAX_NAME_LENGTH,
    MAX_POINTS_PER_OP,
    MAX_REMOVE_IDS,
    MAX_STROKE_POINTS,
    PEN_TYPES,
    SIZES,
    STAMPS,
    STAMP_SIZES,
    STENCIL_SHAPES,
    clampCoordinate,
    isOwnId,
    normalizeColor,
    parseChat,
    parseCursor,
    parseSync,
    parseWhiteboardOp,
} from "../../../../apps/shared/collab/protocol.js";

function stroke(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { kind: "stroke", id: "a:1", epoch: 0, pen: "ballpoint", color: "#112233", size: 4, points: [10, 20, 30, 40], ...overrides };
}

function shape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { kind: "shape", id: "a:2", epoch: 1, shape: "rect", color: "#aabbcc", size: 8, x1: 0, y1: 0, x2: 100, y2: 50, ...overrides };
}

function stamp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { kind: "stamp", id: "a:3", epoch: 2, stamp: "⭐", size: 56, x: 800, y: 450, ...overrides };
}

function add(element: unknown): unknown {
    return { op: "add", element };
}

/** `count` valid points as a flat array. */
function flatPoints(count: number): number[] {
    return Array.from({ length: count * 2 }, (_, i) => i % 100);
}

describe("normalizeColor", () => {
    it("returns a lowercase #rrggbb color as it is", () => {
        expect(normalizeColor("#0a1b2c")).toBe("#0a1b2c");
    });

    it("lowercases an uppercase or mixed-case color", () => {
        expect(normalizeColor("#AABBCC")).toBe("#aabbcc");
        expect(normalizeColor("#aBcDeF")).toBe("#abcdef");
    });

    it("rejects anything that is not a string", () => {
        for (const value of [undefined, null, 0x112233, {}, ["#112233"], true]) {
            expect(normalizeColor(value)).toBeUndefined();
        }
    });

    it("rejects strings that are not exactly #rrggbb", () => {
        for (const value of ["", "#fff", "112233", "#1122334", "#11223", "#gg0000", "red", " #112233", "#112233 ", "rgb(1,2,3)", "#11223344"]) {
            expect(normalizeColor(value)).toBeUndefined();
        }
    });
});

describe("isOwnId", () => {
    it("accepts an id under the peer's own prefix", () => {
        expect(isOwnId("peer:1", "peer")).toBe(true);
        expect(isOwnId("peer:", "peer")).toBe(true);
        expect(isOwnId("peer:1:2", "peer")).toBe(true);
    });

    it("rejects someone else's id, including one that only shares a prefix without the colon", () => {
        expect(isOwnId("other:1", "peer")).toBe(false);
        expect(isOwnId("peer2:1", "peer")).toBe(false);
        expect(isOwnId("peer", "peer")).toBe(false);
        expect(isOwnId("xpeer:1", "peer")).toBe(false);
    });
});

describe("parseWhiteboardOp", () => {
    it("rejects anything that is not a plain object", () => {
        for (const value of [undefined, null, 0, "add", [], [{ op: "clear", epoch: 1 }], true]) {
            expect(parseWhiteboardOp(value)).toBeUndefined();
        }
    });

    it("rejects an unknown or missing op", () => {
        expect(parseWhiteboardOp({ op: "draw", element: stroke() })).toBeUndefined();
        expect(parseWhiteboardOp({ element: stroke() })).toBeUndefined();
    });

    describe("add of a stroke", () => {
        it("accepts every pen type and every size", () => {
            for (const pen of PEN_TYPES) {
                for (const size of SIZES) {
                    expect(parseWhiteboardOp(add(stroke({ pen, size })))).toEqual({ op: "add", element: stroke({ pen, size }) });
                }
            }
        });

        it("normalizes the color to lowercase", () => {
            const op = parseWhiteboardOp(add(stroke({ color: "#ABCDEF" })));
            expect(op).toEqual({ op: "add", element: stroke({ color: "#abcdef" }) });
        });

        it("keeps only the known fields", () => {
            const op = parseWhiteboardOp({ op: "add", extra: 1, element: stroke({ evil: "<script>" }) });
            expect(op).toEqual({ op: "add", element: stroke() });
        });

        it("accepts a single point and exactly MAX_POINTS_PER_OP points", () => {
            expect(parseWhiteboardOp(add(stroke({ points: [5, 6] })))).toBeDefined();
            expect(parseWhiteboardOp(add(stroke({ points: flatPoints(MAX_POINTS_PER_OP) })))).toBeDefined();
        });

        it("accepts coordinates out to the allowed margin around the board", () => {
            const points = [-BOARD_WIDTH, -BOARD_HEIGHT, 2 * BOARD_WIDTH, 2 * BOARD_HEIGHT];
            expect(parseWhiteboardOp(add(stroke({ points })))).toEqual({ op: "add", element: stroke({ points }) });
        });

        it("rejects an unknown pen", () => {
            expect(parseWhiteboardOp(add(stroke({ pen: "quill" })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ pen: undefined })))).toBeUndefined();
        });

        it("rejects a bad color", () => {
            expect(parseWhiteboardOp(add(stroke({ color: "blue" })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ color: 0 })))).toBeUndefined();
        });

        it("rejects a size that is not one of SIZES", () => {
            for (const size of [0, 3, 5, 100, "4", undefined]) {
                expect(parseWhiteboardOp(add(stroke({ size })))).toBeUndefined();
            }
        });

        it("rejects empty, odd-length, too long or non-array points", () => {
            expect(parseWhiteboardOp(add(stroke({ points: [] })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ points: [1, 2, 3] })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ points: flatPoints(MAX_POINTS_PER_OP + 1) })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ points: "1,2" })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ points: { 0: 1, 1: 2, length: 2 } })))).toBeUndefined();
        });

        it("rejects out-of-range or non-integer coordinates, in x and in y", () => {
            for (const points of [
                [-BOARD_WIDTH - 1, 0],
                [2 * BOARD_WIDTH + 1, 0],
                [0, -BOARD_HEIGHT - 1],
                [0, 2 * BOARD_HEIGHT + 1],
                [1.5, 0],
                [0, 1.5],
                [Number.NaN, 0],
                [0, Number.POSITIVE_INFINITY],
                ["1", 0],
                [0, null],
                [0, 0, 10, 2000],
            ]) {
                expect(parseWhiteboardOp(add(stroke({ points })))).toBeUndefined();
            }
        });

        it("returns a copy of the points, unaffected by later changes to the input", () => {
            const points = [1, 2, 3, 4];
            const input = stroke({ points });
            const op = parseWhiteboardOp(add(input));
            points.push(5, 6);
            points[0] = 99;
            input.id = "changed";
            expect(op).toEqual({ op: "add", element: stroke({ points: [1, 2, 3, 4] }) });
        });
    });

    describe("add of a shape", () => {
        it("accepts every stencil shape and every size", () => {
            for (const s of STENCIL_SHAPES) {
                for (const size of SIZES) {
                    expect(parseWhiteboardOp(add(shape({ shape: s, size })))).toEqual({ op: "add", element: shape({ shape: s, size }) });
                }
            }
        });

        it("normalizes the color and keeps only the known fields", () => {
            expect(parseWhiteboardOp(add(shape({ color: "#ABCDEF", extra: true })))).toEqual({ op: "add", element: shape({ color: "#abcdef" }) });
        });

        it("accepts corners at the edges of the allowed margin", () => {
            const corners = { x1: -BOARD_WIDTH, y1: -BOARD_HEIGHT, x2: 2 * BOARD_WIDTH, y2: 2 * BOARD_HEIGHT };
            expect(parseWhiteboardOp(add(shape(corners)))).toEqual({ op: "add", element: shape(corners) });
        });

        it("rejects an unknown shape, a bad color or a bad size", () => {
            expect(parseWhiteboardOp(add(shape({ shape: "hexagon" })))).toBeUndefined();
            expect(parseWhiteboardOp(add(shape({ color: "#12345" })))).toBeUndefined();
            expect(parseWhiteboardOp(add(shape({ size: 7 })))).toBeUndefined();
        });

        it("rejects each corner coordinate when it is out of range or not an integer", () => {
            for (const key of ["x1", "x2"]) {
                expect(parseWhiteboardOp(add(shape({ [key]: 2 * BOARD_WIDTH + 1 })))).toBeUndefined();
                expect(parseWhiteboardOp(add(shape({ [key]: -BOARD_WIDTH - 1 })))).toBeUndefined();
                expect(parseWhiteboardOp(add(shape({ [key]: 0.5 })))).toBeUndefined();
            }
            for (const key of ["y1", "y2"]) {
                expect(parseWhiteboardOp(add(shape({ [key]: 2 * BOARD_HEIGHT + 1 })))).toBeUndefined();
                expect(parseWhiteboardOp(add(shape({ [key]: -BOARD_HEIGHT - 1 })))).toBeUndefined();
                expect(parseWhiteboardOp(add(shape({ [key]: undefined })))).toBeUndefined();
            }
        });

        it("returns a copy, unaffected by later changes to the input", () => {
            const input = shape();
            const op = parseWhiteboardOp(add(input));
            input.x1 = 999;
            input.color = "#000000";
            expect(op).toEqual({ op: "add", element: shape() });
        });
    });

    describe("add of a stamp", () => {
        it("accepts every stamp and every stamp size", () => {
            for (const s of STAMPS) {
                for (const size of STAMP_SIZES) {
                    expect(parseWhiteboardOp(add(stamp({ stamp: s, size })))).toEqual({ op: "add", element: stamp({ stamp: s, size }) });
                }
            }
        });

        it("keeps only the known fields, so a color on a stamp is dropped", () => {
            expect(parseWhiteboardOp(add(stamp({ color: "#ffffff" })))).toEqual({ op: "add", element: stamp() });
        });

        it("rejects a stamp outside the list, or any arbitrary string", () => {
            for (const s of ["🙂", "<img>", "", "⭐⭐", undefined]) {
                expect(parseWhiteboardOp(add(stamp({ stamp: s })))).toBeUndefined();
            }
        });

        it("rejects a pen size where a stamp size is expected", () => {
            expect(parseWhiteboardOp(add(stamp({ size: 4 })))).toBeUndefined();
        });

        it("rejects an out-of-range position", () => {
            expect(parseWhiteboardOp(add(stamp({ x: 2 * BOARD_WIDTH + 1 })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stamp({ y: -BOARD_HEIGHT - 1 })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stamp({ x: 1.25 })))).toBeUndefined();
        });

        it("returns a copy, unaffected by later changes to the input", () => {
            const input = stamp();
            const op = parseWhiteboardOp(add(input));
            input.x = 0;
            expect(op).toEqual({ op: "add", element: stamp() });
        });
    });

    describe("add of any element", () => {
        it("rejects a missing or non-object element", () => {
            expect(parseWhiteboardOp({ op: "add" })).toBeUndefined();
            expect(parseWhiteboardOp(add(null))).toBeUndefined();
            expect(parseWhiteboardOp(add([stroke()]))).toBeUndefined();
        });

        it("rejects an unknown kind", () => {
            expect(parseWhiteboardOp(add(stroke({ kind: "text" })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ kind: undefined })))).toBeUndefined();
        });

        it("rejects an empty, overlong or non-string id", () => {
            expect(parseWhiteboardOp(add(stroke({ id: "" })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ id: "x".repeat(MAX_ID_LENGTH + 1) })))).toBeUndefined();
            expect(parseWhiteboardOp(add(stroke({ id: 7 })))).toBeUndefined();
        });

        it("accepts an id of exactly MAX_ID_LENGTH", () => {
            const id = "x".repeat(MAX_ID_LENGTH);
            expect(parseWhiteboardOp(add(stamp({ id })))).toEqual({ op: "add", element: stamp({ id }) });
        });

        it("rejects a negative, fractional or non-numeric epoch", () => {
            for (const epoch of [-1, 0.5, "1", undefined, Number.NaN]) {
                expect(parseWhiteboardOp(add(stroke({ epoch })))).toBeUndefined();
            }
        });
    });

    describe("points", () => {
        const valid = { op: "points", id: "a:1", start: 3, points: [1, 2, 3, 4] };

        it("accepts a valid op and copies its points", () => {
            const points = [1, 2, 3, 4];
            const op = parseWhiteboardOp({ ...valid, points, extra: "x" });
            points[0] = 50;
            points.push(1, 1);
            expect(op).toEqual({ op: "points", id: "a:1", start: 3, points: [1, 2, 3, 4] });
        });

        it("accepts a start of 0 and of MAX_STROKE_POINTS - 1", () => {
            expect(parseWhiteboardOp({ ...valid, start: 0 })).toBeDefined();
            expect(parseWhiteboardOp({ ...valid, start: MAX_STROKE_POINTS - 1 })).toBeDefined();
        });

        it("rejects a bad id", () => {
            expect(parseWhiteboardOp({ ...valid, id: "" })).toBeUndefined();
            expect(parseWhiteboardOp({ ...valid, id: undefined })).toBeUndefined();
            expect(parseWhiteboardOp({ ...valid, id: "y".repeat(MAX_ID_LENGTH + 1) })).toBeUndefined();
        });

        it("rejects a negative, fractional, too large or non-numeric start", () => {
            for (const start of [-1, 1.5, MAX_STROKE_POINTS, "0", undefined]) {
                expect(parseWhiteboardOp({ ...valid, start })).toBeUndefined();
            }
        });

        it("rejects empty, odd-length, too long or out-of-range points", () => {
            expect(parseWhiteboardOp({ ...valid, points: [] })).toBeUndefined();
            expect(parseWhiteboardOp({ ...valid, points: [1] })).toBeUndefined();
            expect(parseWhiteboardOp({ ...valid, points: flatPoints(MAX_POINTS_PER_OP + 1) })).toBeUndefined();
            expect(parseWhiteboardOp({ ...valid, points: [BOARD_WIDTH * 3, 0] })).toBeUndefined();
            expect(parseWhiteboardOp({ ...valid, points: undefined })).toBeUndefined();
        });

        it("accepts exactly MAX_POINTS_PER_OP points", () => {
            expect(parseWhiteboardOp({ ...valid, points: flatPoints(MAX_POINTS_PER_OP) })).toBeDefined();
        });
    });

    describe("remove", () => {
        it("accepts a list of ids and copies it", () => {
            const ids = ["a:1", "b:2"];
            const op = parseWhiteboardOp({ op: "remove", ids });
            ids.push("c:3");
            ids[0] = "z";
            expect(op).toEqual({ op: "remove", ids: ["a:1", "b:2"] });
        });

        it("accepts exactly MAX_REMOVE_IDS ids", () => {
            const ids = Array.from({ length: MAX_REMOVE_IDS }, (_, i) => `a:${i}`);
            expect(parseWhiteboardOp({ op: "remove", ids })).toEqual({ op: "remove", ids });
        });

        it("rejects an empty list, too many ids, a non-array, or any bad id in the list", () => {
            expect(parseWhiteboardOp({ op: "remove", ids: [] })).toBeUndefined();
            expect(parseWhiteboardOp({ op: "remove", ids: Array.from({ length: MAX_REMOVE_IDS + 1 }, (_, i) => `a:${i}`) })).toBeUndefined();
            expect(parseWhiteboardOp({ op: "remove", ids: "a:1" })).toBeUndefined();
            expect(parseWhiteboardOp({ op: "remove" })).toBeUndefined();
            expect(parseWhiteboardOp({ op: "remove", ids: ["a:1", ""] })).toBeUndefined();
            expect(parseWhiteboardOp({ op: "remove", ids: ["a:1", 2] })).toBeUndefined();
            expect(parseWhiteboardOp({ op: "remove", ids: ["z".repeat(MAX_ID_LENGTH + 1)] })).toBeUndefined();
        });
    });

    describe("clear", () => {
        it("accepts a whole, non-negative epoch", () => {
            expect(parseWhiteboardOp({ op: "clear", epoch: 0 })).toEqual({ op: "clear", epoch: 0 });
            expect(parseWhiteboardOp({ op: "clear", epoch: 12, extra: 1 })).toEqual({ op: "clear", epoch: 12 });
        });

        it("rejects a negative, fractional, missing or non-numeric epoch", () => {
            for (const epoch of [-1, 2.5, undefined, "3", Number.POSITIVE_INFINITY]) {
                expect(parseWhiteboardOp({ op: "clear", epoch })).toBeUndefined();
            }
        });
    });
});

describe("parseChat", () => {
    const valid = { id: "m1", text: "hello", sentAt: 1_700_000_000_000 };

    it("accepts a valid message and keeps only its known fields", () => {
        expect(parseChat({ ...valid, peer: "spoofed", name: "Mallory" })).toEqual(valid);
    });

    it("keeps the text exactly, including surrounding whitespace", () => {
        expect(parseChat({ ...valid, text: "  hi\n" })).toEqual({ ...valid, text: "  hi\n" });
    });

    it("accepts text of exactly MAX_CHAT_LENGTH characters and any finite sentAt", () => {
        expect(parseChat({ ...valid, text: "a".repeat(MAX_CHAT_LENGTH) })).toBeDefined();
        expect(parseChat({ ...valid, sentAt: -5.5 })).toEqual({ ...valid, sentAt: -5.5 });
    });

    it("rejects anything that is not a plain object", () => {
        for (const value of [undefined, null, "hello", 1, [valid]]) {
            expect(parseChat(value)).toBeUndefined();
        }
    });

    it("rejects a bad id", () => {
        expect(parseChat({ ...valid, id: "" })).toBeUndefined();
        expect(parseChat({ ...valid, id: 1 })).toBeUndefined();
        expect(parseChat({ ...valid, id: "i".repeat(MAX_ID_LENGTH + 1) })).toBeUndefined();
    });

    it("rejects non-string text, overlong text and blank text", () => {
        expect(parseChat({ ...valid, text: 5 })).toBeUndefined();
        expect(parseChat({ ...valid, text: undefined })).toBeUndefined();
        expect(parseChat({ ...valid, text: "a".repeat(MAX_CHAT_LENGTH + 1) })).toBeUndefined();
        expect(parseChat({ ...valid, text: "" })).toBeUndefined();
        expect(parseChat({ ...valid, text: "  \n\t " })).toBeUndefined();
    });

    it("rejects a non-numeric or non-finite sentAt", () => {
        for (const sentAt of ["1", undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(parseChat({ ...valid, sentAt })).toBeUndefined();
        }
    });
});

describe("parseSync", () => {
    const entry = { id: "m1", text: "hi", sentAt: 5, peer: "a", name: "Alice" };
    const valid = { part: 0, of: 1, epoch: 0, chat: [], ops: [] };

    it("accepts an empty part", () => {
        expect(parseSync(valid)).toEqual(valid);
    });

    it("accepts the last part of several and keeps only the known fields", () => {
        expect(parseSync({ ...valid, part: 2, of: 3, epoch: 4, extra: 1 })).toEqual({ part: 2, of: 3, epoch: 4, chat: [], ops: [] });
    });

    it("rejects anything that is not a plain object", () => {
        for (const value of [undefined, null, "sync", 3, [valid]]) {
            expect(parseSync(value)).toBeUndefined();
        }
    });

    it("rejects a non-integer part or of, or a bad epoch", () => {
        expect(parseSync({ ...valid, part: 0.5 })).toBeUndefined();
        expect(parseSync({ ...valid, part: "0" })).toBeUndefined();
        expect(parseSync({ ...valid, of: 1.5 })).toBeUndefined();
        expect(parseSync({ ...valid, of: undefined })).toBeUndefined();
        expect(parseSync({ ...valid, epoch: -1 })).toBeUndefined();
        expect(parseSync({ ...valid, epoch: 0.1 })).toBeUndefined();
    });

    it("rejects an of below 1, a negative part, or a part at or past of", () => {
        expect(parseSync({ ...valid, of: 0 })).toBeUndefined();
        expect(parseSync({ ...valid, part: -1 })).toBeUndefined();
        expect(parseSync({ ...valid, part: 1, of: 1 })).toBeUndefined();
        expect(parseSync({ ...valid, part: 5, of: 3 })).toBeUndefined();
    });

    it("rejects a missing or non-array chat or ops", () => {
        expect(parseSync({ ...valid, chat: undefined })).toBeUndefined();
        expect(parseSync({ ...valid, chat: {} })).toBeUndefined();
        expect(parseSync({ ...valid, ops: undefined })).toBeUndefined();
        expect(parseSync({ ...valid, ops: "[]" })).toBeUndefined();
    });

    it("keeps valid chat entries with their peer and name, and drops the invalid ones", () => {
        const chat = [
            entry,
            { ...entry, id: "m2", text: "   " },
            { ...entry, id: "m3", peer: "" },
            { ...entry, id: "m4", peer: 7 },
            { ...entry, id: "m5", name: 1 },
            { ...entry, id: "m6", name: "n".repeat(MAX_NAME_LENGTH + 1) },
            { ...entry, id: "m7", name: "n".repeat(MAX_NAME_LENGTH) },
            { ...entry, id: "m8", name: "" },
            null,
            "text",
            { ...entry, id: "m9", sentAt: "now" },
            { ...entry, id: "m10", extra: "dropped" },
        ];
        const sync = parseSync({ ...valid, chat });
        expect(sync?.chat).toEqual([
            entry,
            { ...entry, id: "m7", name: "n".repeat(MAX_NAME_LENGTH) },
            { ...entry, id: "m8", name: "" },
            { ...entry, id: "m10" },
        ]);
    });

    it("keeps valid ops and drops the invalid ones, in order", () => {
        const ops = [
            { op: "add", element: stroke() },
            { op: "add", element: stroke({ pen: "quill" }) },
            { op: "clear", epoch: 3 },
            { op: "points", id: "a:1", start: -1, points: [1, 2] },
            null,
            { op: "remove", ids: ["a:1"] },
            { op: "nope" },
            { op: "points", id: "a:1", start: 2, points: [1, 2] },
        ];
        expect(parseSync({ ...valid, ops })?.ops).toEqual([
            { op: "add", element: stroke() },
            { op: "clear", epoch: 3 },
            { op: "remove", ids: ["a:1"] },
            { op: "points", id: "a:1", start: 2, points: [1, 2] },
        ]);
    });

    it("returns copies, unaffected by later changes to the input", () => {
        const chatEntry = { ...entry };
        const element = stroke();
        const input = { ...valid, chat: [chatEntry], ops: [{ op: "add", element }] };
        const sync = parseSync(input);
        chatEntry.text = "changed";
        chatEntry.peer = "b";
        (element.points as number[]).push(1, 1);
        input.chat.push({ ...entry, id: "m2" });
        input.ops.length = 0;
        expect(sync).toEqual({ ...valid, chat: [entry], ops: [{ op: "add", element: stroke() }] });
    });
});

describe("CURSOR_TOOLS", () => {
    it("is every pen, then the stencil, the stamp and the eraser", () => {
        expect(CURSOR_TOOLS).toEqual([...PEN_TYPES, "stencil", "stamp", "eraser"]);
    });
});

describe("parseCursor", () => {
    const pointer = (overrides: Record<string, unknown> = {}) => ({ x: 100, y: 200, tool: "marker", color: "#AbCdEf", ...overrides });

    it("accepts a pointer that left the board, whatever else it carries", () => {
        expect(parseCursor({ hidden: true })).toEqual({ hidden: true });
        expect(parseCursor({ hidden: true, x: "nonsense", tool: "laser" })).toEqual({ hidden: true });
    });

    it("does not take a hidden flag other than true as hidden", () => {
        expect(parseCursor({ hidden: "yes" })).toBeUndefined();
        expect(parseCursor({ hidden: false, ...pointer() })).toEqual({ x: 100, y: 200, tool: "marker", color: "#abcdef" });
    });

    it.each(CURSOR_TOOLS.map((tool) => [tool]))("accepts the %s tool, normalizing the color and copying only what it knows", (tool) => {
        const input = pointer({ tool, extra: "dropped" });
        const parsed = parseCursor(input);
        expect(parsed).toEqual({ x: 100, y: 200, tool, color: "#abcdef" });
        expect(parsed).not.toHaveProperty("stamp");
        input.x = 5;
        expect(parsed).toMatchObject({ x: 100 });
    });

    it("accepts every known stamp, with any tool", () => {
        for (const stamp of STAMPS) {
            expect(parseCursor(pointer({ tool: "stamp", stamp }))).toEqual({ x: 100, y: 200, tool: "stamp", color: "#abcdef", stamp });
        }
        expect(parseCursor(pointer({ tool: "eraser", stamp: "⭐" }))).toMatchObject({ tool: "eraser", stamp: "⭐" });
    });

    it("accepts coordinates across the slack allowed around the board", () => {
        expect(parseCursor(pointer({ x: -BOARD_WIDTH, y: -BOARD_HEIGHT }))).toMatchObject({ x: -BOARD_WIDTH, y: -BOARD_HEIGHT });
        expect(parseCursor(pointer({ x: 2 * BOARD_WIDTH, y: 2 * BOARD_HEIGHT }))).toMatchObject({ x: 2 * BOARD_WIDTH, y: 2 * BOARD_HEIGHT });
    });

    it.each([
        ["an unknown stamp", pointer({ tool: "stamp", stamp: "<b>" })],
        ["a null stamp", pointer({ tool: "stamp", stamp: null })],
        ["an unknown tool", pointer({ tool: "laser" })],
        ["no tool", pointer({ tool: undefined })],
        ["an invalid color", pointer({ color: "red" })],
        ["no color", pointer({ color: undefined })],
        ["a fractional x", pointer({ x: 1.5 })],
        ["a string y", pointer({ y: "2" })],
        ["an x past the slack", pointer({ x: 2 * BOARD_WIDTH + 1 })],
        ["a y below the slack", pointer({ y: -BOARD_HEIGHT - 1 })],
        ["a missing x", pointer({ x: undefined })],
    ])("drops a pointer with %s", (_label, value) => {
        expect(parseCursor(value)).toBeUndefined();
    });

    it.each([
        ["undefined", undefined],
        ["null", null],
        ["a string", "hidden"],
        ["a number", 5],
        ["an array", [100, 200]],
    ])("drops %s", (_label, value) => {
        expect(parseCursor(value)).toBeUndefined();
    });
});

describe("clampCoordinate", () => {
    it("rounds to a whole unit", () => {
        expect(clampCoordinate(10.4, 100)).toBe(10);
        expect(clampCoordinate(10.5, 100)).toBe(11);
        expect(clampCoordinate(0, 100)).toBe(0);
        expect(clampCoordinate(100, 100)).toBe(100);
    });

    it("keeps the value within [0, max]", () => {
        expect(clampCoordinate(-0.4, 100)).toBe(0);
        expect(clampCoordinate(-50, 100)).toBe(0);
        expect(clampCoordinate(100.4, 100)).toBe(100);
        expect(clampCoordinate(5000, BOARD_WIDTH)).toBe(BOARD_WIDTH);
        expect(clampCoordinate(-Infinity, BOARD_HEIGHT)).toBe(0);
    });

    it("treats a non-finite value as 0", () => {
        expect(clampCoordinate(NaN, 100)).toBe(0);
        expect(clampCoordinate(Infinity, 100)).toBe(0);
    });
});
