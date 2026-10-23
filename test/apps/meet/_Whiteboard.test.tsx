// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Whiteboard, { CursorMarker, PEN_LABELS, SHAPE_LABELS, SWATCHES, labelTextColor, type WhiteboardProps } from "../../../apps/meet/_Whiteboard.js";
import { CollabSession, type RemoteCursor } from "../../../apps/shared/collab/CollabSession.js";
import { hexToHsv, hsvToHex } from "../../../apps/shared/collab/color.js";
import { BOARD_HEIGHT, BOARD_WIDTH, PEN_TYPES, SIZES, STAMPS, STAMP_SIZES, STENCIL_SHAPES, type BoardElement } from "../../../apps/shared/collab/protocol.js";
import type { SignalMessage } from "../../../apps/shared/webrtc/types.js";

/** A signaling channel that keeps what is sent and never delivers anything. */
function fakeChannel() {
    const sent: SignalMessage[] = [];
    return {
        sent,
        send: (message: SignalMessage) => {
            sent.push(message);
        },
        onMessage: () => () => undefined,
    };
}

/** A 2D context that records every call - the `BoardContext` methods, plus what the color wheel draws with. */
function recordingContext() {
    const calls: { name: string; args: unknown[] }[] = [];
    const record =
        (name: string) =>
        (...args: unknown[]) => {
            calls.push({ name, args });
        };
    const methods = ["save", "restore", "setTransform", "clearRect", "fillRect", "beginPath", "closePath", "moveTo", "lineTo", "quadraticCurveTo", "ellipse", "stroke", "fill", "fillText", "putImageData"];
    const ctx: Record<string, unknown> = Object.fromEntries(methods.map((name) => [name, record(name)]));
    Object.assign(ctx, {
        createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        strokeStyle: "#000",
        fillStyle: "#000",
        globalAlpha: 1,
        globalCompositeOperation: "source-over",
        font: "",
        textAlign: "start",
        textBaseline: "alphabetic",
    });
    return { ctx, calls, named: (name: string) => calls.filter((call) => call.name === name) };
}

/** Animation frames requested and not yet run. */
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let cancelFrame: ReturnType<typeof vi.fn>;
function flushFrames() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
}

/** Where the stage and the canvas sit on the page. */
const layout = {
    stage: { left: 0, top: 0, width: 1000, height: 450 },
    canvas: { left: 100, top: 50, width: 800, height: 450 },
};
const asRect = (rect: { left: number; top: number; width: number; height: number }) =>
    ({ ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect }) as DOMRect;

let recorder: ReturnType<typeof recordingContext>;
let getContext: ReturnType<typeof vi.spyOn>;
let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    recorder = recordingContext();
    getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => recorder.ctx as unknown as CanvasRenderingContext2D);
    layout.stage = { left: 0, top: 0, width: 1000, height: 450 };
    layout.canvas = { left: 100, top: 50, width: 800, height: 450 };
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return asRect(this.dataset.testid === "whiteboard-canvas" ? layout.canvas : layout.stage);
    });
    frames = new Map();
    nextFrame = 1;
    cancelFrame = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
});

afterEach(() => {
    getContext.mockRestore();
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
});

/** The whiteboard over a real session, redrawn on every board change as `_CallView.tsx` does it. */
function Harness({ session, onClose }: { session: CollabSession; onClose: () => void }) {
    const [revision, setRevision] = useState(session.board.revision);
    useEffect(() => {
        const off = session.onEvent(() => setRevision(session.board.revision));
        return () => {
            off();
        };
    }, [session]);
    return <Whiteboard session={session} revision={revision} onClose={onClose} />;
}

function renderBoard() {
    const channel = fakeChannel();
    const session = new CollabSession({ channel, selfUid: "me", peerId: "me~1", selfName: "Alice", now: () => 1_000 });
    const onClose = vi.fn();
    const result = render(<Harness session={session} onClose={onClose} />);
    return { ...result, channel, session, onClose };
}

const canvas = () => screen.getByTestId("whiteboard-canvas");
const button = (name: string) => screen.getByRole("button", { name });
/** The page position of board point (`x`, `y`) - the canvas shows the board at half size, 100px in and 50px down. */
const at = (x: number, y: number) => ({ clientX: 100 + x / 2, clientY: 50 + y / 2 });
const elements = (session: CollabSession): BoardElement[] => session.board.elements;
const ops = (channel: ReturnType<typeof fakeChannel>) => channel.sent.map((message) => message.whiteboard as { op: string });

/** Dispatches a pointer move whose `getCoalescedEvents` is `coalesced` (or absent, for `undefined`). */
function moveWith(target: HTMLElement, position: { clientX: number; clientY: number }, coalesced: { clientX: number; clientY: number }[] | undefined) {
    const event = new PointerEvent("pointermove", { bubbles: true, ...position });
    Object.defineProperty(event, "getCoalescedEvents", { value: coalesced && (() => coalesced) });
    fireEvent(target, event);
}

describe("Whiteboard - the canvas", () => {
    it("fits the largest 16:9 box into the stage, backed at the display's pixel ratio", () => {
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
        try {
            renderBoard();
            // 1000 x 450 has room for 800 x 450.
            expect(canvas().style.width).toBe("800px");
            expect(canvas().style.height).toBe("450px");
            expect(canvas()).toHaveAttribute("width", "1600");
            expect(canvas()).toHaveAttribute("height", "900");
        } finally {
            Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
        }
    });

    it("treats a missing pixel ratio as 1, and an empty stage as a 1px canvas", () => {
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 0 });
        layout.stage = { left: 0, top: 0, width: 0, height: 0 };
        try {
            renderBoard();
            expect(canvas()).toHaveAttribute("width", "1");
            expect(canvas()).toHaveAttribute("height", "1");
        } finally {
            Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
        }
    });

    it("refits when the stage is resized, and stops watching it once gone", () => {
        const observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe = vi.fn();
                disconnect = vi.fn();
                constructor(public callback: () => void) {
                    observers.push(this);
                }
            },
        );
        const { unmount } = renderBoard();
        expect(observers).toHaveLength(1);
        expect(observers[0].observe).toHaveBeenCalledWith(canvas().parentElement);

        // A taller-than-wide stage: the width limits the box.
        layout.stage = { left: 0, top: 0, width: 320, height: 900 };
        act(() => observers[0].callback());
        expect(canvas().style.width).toBe("320px");
        expect(canvas().style.height).toBe("180px");

        unmount();
        expect(observers[0].disconnect).toHaveBeenCalled();
    });

    it("draws the board at most once per frame, however many changes arrive in between", () => {
        const { rerender, session, onClose } = renderBoard();
        expect(frames.size).toBe(1);
        flushFrames();
        // The paper, at the canvas's scale (800 / 1600).
        expect(recorder.named("fillRect")[0].args).toEqual([0, 0, 800, 450]);

        recorder.calls.length = 0;
        rerender(<Whiteboard session={session} revision={41} onClose={onClose} />);
        rerender(<Whiteboard session={session} revision={42} onClose={onClose} />);
        expect(frames.size).toBe(1);
        flushFrames();
        expect(recorder.named("fillRect")).toHaveLength(1);
        expect(frames.size).toBe(0);
    });

    it("cancels a pending redraw when it goes away, and has nothing to cancel otherwise", () => {
        const first = renderBoard();
        expect(frames.size).toBe(1);
        first.unmount();
        expect(cancelFrame).toHaveBeenCalledTimes(1);

        const second = renderBoard();
        flushFrames();
        second.unmount();
        expect(cancelFrame).toHaveBeenCalledTimes(1);
    });

    it("draws nothing, without failing, where the browser has no 2D context", () => {
        getContext.mockReturnValue(null);
        const { session } = renderBoard();
        flushFrames();
        fireEvent.pointerDown(canvas(), { ...at(200, 200), button: 0 });
        fireEvent.pointerUp(canvas());
        expect(elements(session)).toHaveLength(1);
        flushFrames();
        expect(recorder.calls).toHaveLength(0);
    });

    it("draws nothing from a frame that still runs after the board has gone", () => {
        const { unmount } = renderBoard();
        const pending = [...frames.values()];
        expect(pending).toHaveLength(1);
        unmount();
        pending[0](0);
        expect(recorder.calls).toHaveLength(0);
    });
});

describe("Whiteboard - pens", () => {
    it("draws a stroke with each pen, skipping points too close to the last", () => {
        const { session, channel } = renderBoard();
        for (const pen of PEN_TYPES) {
            fireEvent.click(button(PEN_LABELS[pen]));
            expect(button(PEN_LABELS[pen])).toHaveAttribute("aria-pressed", "true");
            const before = elements(session).length;
            fireEvent.pointerDown(canvas(), { ...at(200, 200), button: 0, pointerId: 1 });
            // 1 board unit away: below the threshold.
            fireEvent.pointerMove(canvas(), at(201, 200));
            fireEvent.pointerMove(canvas(), at(204, 200));
            fireEvent.pointerMove(canvas(), at(204, 201));
            fireEvent.pointerUp(canvas());
            const stroke = elements(session)[before];
            expect(stroke).toMatchObject({ kind: "stroke", pen, color: SWATCHES[0], size: SIZES[1], points: [200, 200, 204, 200] });
        }
        expect(button(PEN_LABELS.ballpoint)).toHaveAttribute("aria-pressed", "false");
        // The first points go out with the add, the rest as a batch once the stroke ends.
        expect(ops(channel).slice(0, 2).map((op) => op.op)).toEqual(["add", "points"]);
        expect(canvas().className).toContain("cursor-crosshair");
    });

    it("takes every coalesced sample of a fast move, and the move itself where the browser coalesces nothing", () => {
        const { session } = renderBoard();
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        moveWith(canvas(), at(130, 100), [at(110, 100), at(120, 100), at(130, 100)]);
        moveWith(canvas(), at(140, 100), undefined);
        moveWith(canvas(), at(150, 100), []);
        fireEvent.pointerUp(canvas());
        expect(elements(session)[0]).toMatchObject({ points: [100, 100, 110, 100, 120, 100, 130, 100, 140, 100, 150, 100] });
    });

    it("captures the pointer where the browser can", () => {
        const setPointerCapture = vi.fn();
        renderBoard();
        canvas().setPointerCapture = setPointerCapture;
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0, pointerId: 9 });
        expect(setPointerCapture).toHaveBeenCalledWith(9);
    });

    it("ignores any button but the primary one, and moves or releases with nothing being drawn", () => {
        const { session, channel } = renderBoard();
        fireEvent.pointerMove(canvas(), at(100, 100));
        fireEvent.pointerUp(canvas());
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 2 });
        fireEvent.pointerMove(canvas(), at(200, 200));
        fireEvent.pointerUp(canvas());
        expect(elements(session)).toHaveLength(0);
        expect(channel.sent).toHaveLength(0);
    });

    it("draws nothing more while the board is full", () => {
        const { session } = renderBoard();
        vi.spyOn(session, "beginStroke").mockReturnValue(undefined);
        const extend = vi.spyOn(session, "extendStroke");
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        fireEvent.pointerMove(canvas(), at(200, 200));
        fireEvent.pointerUp(canvas());
        expect(extend).not.toHaveBeenCalled();
    });

    it("maps an unsized canvas one-to-one onto the board", () => {
        layout.canvas = { left: 0, top: 0, width: 0, height: 0 };
        const { session } = renderBoard();
        fireEvent.pointerDown(canvas(), { clientX: 321, clientY: 123, button: 0 });
        fireEvent.pointerUp(canvas());
        expect(elements(session)[0]).toMatchObject({ points: [321, 123] });
    });

    it("draws in the size and swatch chosen", () => {
        const { session } = renderBoard();
        const sizes = within(screen.getByRole("group", { name: "Size" })).getAllByRole("button");
        expect(sizes).toHaveLength(SIZES.length);
        expect(button("Size 2")).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(button("Size 4"));
        expect(button("Size 4")).toHaveAttribute("aria-pressed", "true");
        expect(button("Size 2")).toHaveAttribute("aria-pressed", "false");

        const swatches = within(screen.getByRole("radiogroup", { name: "Color" })).getAllByRole("radio");
        expect(swatches).toHaveLength(SWATCHES.length);
        expect(screen.getByRole("radio", { name: `Color ${SWATCHES[0]}` })).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByRole("radio", { name: "Color #d93025" }));
        expect(screen.getByRole("radio", { name: "Color #d93025" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("radio", { name: `Color ${SWATCHES[0]}` })).toHaveAttribute("aria-checked", "false");

        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        fireEvent.pointerUp(canvas());
        expect(elements(session)[0]).toMatchObject({ color: "#d93025", size: SIZES[3] });
    });
});

describe("Whiteboard - custom color", () => {
    it("opens the color wheel from its button, draws in the color picked there, and closes from the same button", () => {
        const { session } = renderBoard();
        const custom = button("Custom color");
        expect(custom).toHaveAttribute("aria-expanded", "false");
        expect(custom.className).not.toContain("ring-2 ring-[#a8c7fa]");

        fireEvent.click(custom);
        expect(custom).toHaveAttribute("aria-expanded", "true");
        const dialog = screen.getByRole("dialog", { name: "Custom color" });
        fireEvent.change(within(dialog).getByRole("slider", { name: "Brightness" }), { target: { value: "100" } });
        const picked = hsvToHex({ ...hexToHsv(SWATCHES[0]), v: 1 });
        expect(SWATCHES).not.toContain(picked);
        expect(custom.className).toContain("ring-2 ring-[#a8c7fa]");
        for (const radio of screen.getAllByRole("radio")) {
            expect(radio).toHaveAttribute("aria-checked", "false");
        }

        fireEvent.click(custom);
        expect(screen.queryByRole("dialog", { name: "Custom color" })).toBeNull();

        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        fireEvent.pointerUp(canvas());
        expect(elements(session)[0]).toMatchObject({ color: picked });
    });

    it("closes the color wheel when drawing starts", () => {
        renderBoard();
        fireEvent.click(button("Custom color"));
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        expect(screen.queryByRole("dialog", { name: "Custom color" })).toBeNull();
    });
});

describe("Whiteboard - stencil", () => {
    it("previews the shape while it is dragged out, then adds it", () => {
        const { session, channel } = renderBoard();
        flushFrames();
        fireEvent.click(button("Stencil"));
        expect(button("Stencil")).toHaveAttribute("aria-pressed", "true");
        expect(button("Rectangle")).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("group", { name: "Size" })).toBeInTheDocument();

        fireEvent.pointerDown(canvas(), { ...at(200, 200), button: 0 });
        fireEvent.pointerMove(canvas(), at(400, 300));
        expect(elements(session)).toHaveLength(0);
        expect(channel.sent).toHaveLength(0);
        recorder.calls.length = 0;
        flushFrames();
        // The board, then the preview on top of it at the canvas's scale.
        const transforms = recorder.named("setTransform").map((call) => call.args);
        expect(transforms).toContainEqual([0.5, 0, 0, 0.5, 0, 0]);
        expect(recorder.named("closePath")).toHaveLength(1);

        fireEvent.pointerUp(canvas());
        expect(elements(session)).toEqual([expect.objectContaining({ kind: "shape", shape: "rect", x1: 200, y1: 200, x2: 400, y2: 300, color: SWATCHES[0], size: SIZES[1] })]);
        recorder.calls.length = 0;
        flushFrames();
        // The rectangle drawn once, as part of the board - the preview is gone.
        expect(recorder.named("closePath")).toHaveLength(1);
    });

    it("adds nothing for a drag too short to be a shape", () => {
        const { session } = renderBoard();
        fireEvent.click(button("Stencil"));
        fireEvent.pointerDown(canvas(), { ...at(200, 200), button: 0 });
        fireEvent.pointerUp(canvas());
        fireEvent.pointerDown(canvas(), { ...at(200, 200), button: 0 });
        fireEvent.pointerMove(canvas(), at(202, 202));
        fireEvent.pointerUp(canvas());
        expect(elements(session)).toHaveLength(0);
    });

    it("draws each shape, showing the one chosen on the stencil button", () => {
        const { session } = renderBoard();
        fireEvent.click(button("Stencil"));
        for (const shape of STENCIL_SHAPES) {
            fireEvent.click(button(SHAPE_LABELS[shape]));
            expect(button(SHAPE_LABELS[shape])).toHaveAttribute("aria-pressed", "true");
            fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
            fireEvent.pointerMove(canvas(), at(300, 200));
            fireEvent.pointerUp(canvas());
        }
        expect(elements(session).map((element) => (element.kind === "shape" ? element.shape : element.kind))).toEqual([...STENCIL_SHAPES]);
        // The stencil button shows the shape last picked.
        expect(button("Stencil").innerHTML).toBe(button(SHAPE_LABELS.star).innerHTML);
    });
});

describe("Whiteboard - stamps", () => {
    it("opens the stamp picker with the tool, places the stamp picked at the size picked, and hides the color controls", () => {
        const { session } = renderBoard();
        fireEvent.click(button("Stamp"));
        expect(button("Stamp")).toHaveAttribute("aria-pressed", "true");
        const picker = screen.getByRole("dialog", { name: "Stamps" });
        expect(within(picker).getAllByRole("button")).toHaveLength(STAMPS.length);
        expect(within(picker).getByRole("button", { name: `Stamp ${STAMPS[0]}` })).toHaveAttribute("aria-pressed", "true");
        expect(screen.queryByRole("radiogroup", { name: "Color" })).toBeNull();
        expect(screen.queryByRole("group", { name: "Size" })).toBeNull();
        expect(canvas().className).toContain("cursor-copy");

        fireEvent.click(within(picker).getByRole("button", { name: "Stamp 💡" }));
        expect(screen.queryByRole("dialog", { name: "Stamps" })).toBeNull();
        expect(button("Stamp")).toHaveTextContent("💡");

        expect(button("Stamp size 2")).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(button("Stamp size 3"));
        expect(button("Stamp size 3")).toHaveAttribute("aria-pressed", "true");

        fireEvent.pointerDown(canvas(), { ...at(500, 400), button: 0 });
        fireEvent.pointerMove(canvas(), at(600, 400));
        fireEvent.pointerUp(canvas());
        expect(elements(session)).toEqual([expect.objectContaining({ kind: "stamp", stamp: "💡", size: STAMP_SIZES[2], x: 500, y: 400 })]);
    });

    it("toggles the stamp picker from the stamp button", () => {
        renderBoard();
        fireEvent.click(button("Stamp"));
        expect(screen.getByRole("dialog", { name: "Stamps" })).toBeInTheDocument();
        fireEvent.click(button("Stamp"));
        expect(screen.queryByRole("dialog", { name: "Stamps" })).toBeNull();
        expect(button("Stamp")).toHaveAttribute("aria-pressed", "true");
    });
});

describe("Whiteboard - eraser", () => {
    it("erases whatever it passes over, and nothing else", () => {
        const { session, channel } = renderBoard();
        act(() => void session.addStamp(STAMPS[0], STAMP_SIZES[0], 300, 300));
        act(() => void session.addStamp(STAMPS[1], STAMP_SIZES[0], 1200, 700));
        const [near, far] = elements(session).map((element) => element.id);
        channel.sent.length = 0;

        fireEvent.click(button("Eraser"));
        expect(button("Eraser")).toHaveAttribute("aria-pressed", "true");
        expect(canvas().className).toContain("cursor-cell");
        expect(screen.queryByRole("radiogroup", { name: "Color" })).toBeNull();
        expect(screen.queryByRole("group", { name: "Size" })).toBeNull();
        expect(screen.queryByRole("group", { name: "Stamp size" })).toBeNull();

        // Down on empty board, then dragged across the first stamp.
        fireEvent.pointerDown(canvas(), { ...at(100, 300), button: 0 });
        expect(channel.sent).toHaveLength(0);
        fireEvent.pointerMove(canvas(), at(200, 300));
        fireEvent.pointerMove(canvas(), at(300, 300));
        fireEvent.pointerUp(canvas());
        expect(elements(session).map((element) => element.id)).toEqual([far]);
        expect(ops(channel)).toEqual([{ op: "remove", ids: [near] }]);

        // Released: moving no longer erases.
        fireEvent.pointerMove(canvas(), at(1200, 700));
        expect(elements(session)).toHaveLength(1);
    });
});

describe("Whiteboard - undo, clear and close", () => {
    it("takes back this participant's last drawing from the undo button, and on Ctrl/Cmd+Z", () => {
        const { session } = renderBoard();
        for (const x of [100, 200, 300, 400]) {
            act(() => void session.addStamp(STAMPS[0], STAMP_SIZES[0], x, 100));
        }
        fireEvent.click(button("Undo"));
        expect(elements(session)).toHaveLength(3);
        expect(fireEvent.keyDown(document, { key: "z", ctrlKey: true })).toBe(false);
        expect(elements(session)).toHaveLength(2);
        fireEvent.keyDown(document, { key: "Z", metaKey: true });
        expect(elements(session)).toHaveLength(1);
        // Not a redo, and not a bare Z.
        fireEvent.keyDown(document, { key: "z", ctrlKey: true, shiftKey: true });
        fireEvent.keyDown(document, { key: "z" });
        fireEvent.keyDown(document, { key: "y", ctrlKey: true });
        expect(elements(session)).toHaveLength(1);
    });

    it("leaves Ctrl+Z to whatever is being typed in", () => {
        const { session } = renderBoard();
        act(() => void session.addStamp(STAMPS[0], STAMP_SIZES[0], 100, 100));
        const typing = document.createElement("div");
        typing.innerHTML = `<input aria-label="field" /><textarea aria-label="area"></textarea><div contenteditable="true"><span>rich</span></div>`;
        document.body.appendChild(typing);
        for (const target of [typing.querySelector("input")!, typing.querySelector("textarea")!, typing.querySelector("span")!]) {
            expect(fireEvent.keyDown(target, { key: "z", ctrlKey: true })).toBe(true);
        }
        expect(elements(session)).toHaveLength(1);
        // Elsewhere on the page it still undoes.
        fireEvent.keyDown(typing, { key: "z", ctrlKey: true });
        expect(elements(session)).toHaveLength(0);
        typing.remove();
    });

    it("clears the board for everyone only after a confirmation, and cancels", () => {
        const { session, channel } = renderBoard();
        act(() => void session.addStamp(STAMPS[0], STAMP_SIZES[0], 100, 100));

        fireEvent.click(button("Clear whiteboard"));
        const confirm = screen.getByRole("group", { name: "Clear the whiteboard?" });
        expect(confirm).toHaveTextContent("Clear for everyone?");
        expect(screen.queryByRole("button", { name: "Clear whiteboard" })).toBeNull();
        fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("group", { name: "Clear the whiteboard?" })).toBeNull();
        expect(elements(session)).toHaveLength(1);

        fireEvent.click(button("Clear whiteboard"));
        fireEvent.click(within(screen.getByRole("group", { name: "Clear the whiteboard?" })).getByRole("button", { name: "Clear" }));
        expect(elements(session)).toHaveLength(0);
        expect(session.board.epoch).toBe(1);
        expect(ops(channel).at(-1)).toEqual({ op: "clear", epoch: 1 });
        expect(button("Clear whiteboard")).toBeInTheDocument();
    });

    it("closes a popover and the clear confirmation on Escape, and nothing on another key", () => {
        renderBoard();
        fireEvent.click(button("Custom color"));
        fireEvent.click(button("Clear whiteboard"));
        fireEvent.keyDown(document, { key: "Enter" });
        expect(screen.getByRole("dialog", { name: "Custom color" })).toBeInTheDocument();
        expect(screen.getByRole("group", { name: "Clear the whiteboard?" })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Custom color" })).toBeNull();
        expect(screen.queryByRole("group", { name: "Clear the whiteboard?" })).toBeNull();

        fireEvent.click(button("Stamp"));
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Stamps" })).toBeNull();
    });

    it("closes from its own button, and stops listening for keys once gone", () => {
        const { session, onClose, unmount } = renderBoard();
        fireEvent.click(screen.getByRole("button", { name: "Back to video" }));
        expect(onClose).toHaveBeenCalledTimes(1);

        act(() => void session.addStamp(STAMPS[0], STAMP_SIZES[0], 100, 100));
        unmount();
        fireEvent.keyDown(document, { key: "z", ctrlKey: true });
        expect(elements(session)).toHaveLength(1);
    });
});

/** The whiteboard rendered directly, with `props` over a fresh session's defaults. */
function renderWith(props: Partial<WhiteboardProps> = {}) {
    const channel = fakeChannel();
    const session = new CollabSession({ channel, selfUid: "me", peerId: "me~1", selfName: "Alice", now: () => 1_000 });
    const onClose = vi.fn();
    const all: WhiteboardProps = { session, revision: 0, onClose, ...props };
    const result = render(<Whiteboard {...all} />);
    return { ...result, channel, session, onClose, props: all };
}

function remote(overrides: Partial<RemoteCursor> = {}): RemoteCursor {
    return { peer: "bob~1", name: "Bob", x: 800, y: 450, tool: "marker", color: "#d93025", at: 1, ...overrides };
}

describe("labelTextColor", () => {
    it("is black on a light color and white on a dark one", () => {
        expect(labelTextColor("#ffffff")).toBe("#000000");
        expect(labelTextColor("#fbbc04")).toBe("#000000");
        expect(labelTextColor("#00ff80")).toBe("#000000");
        // Pure green is just dark enough for white.
        expect(labelTextColor("#00ff00")).toBe("#ffffff");
        expect(labelTextColor("#000000")).toBe("#ffffff");
        expect(labelTextColor("#202124")).toBe("#ffffff");
        expect(labelTextColor("#1a73e8")).toBe("#ffffff");
        expect(labelTextColor("#ff0000")).toBe("#ffffff");
    });

    it("puts the threshold just above a mid grey", () => {
        // 150 is not above the threshold; 151 is.
        expect(labelTextColor("#969696")).toBe("#ffffff");
        expect(labelTextColor("#979797")).toBe("#000000");
    });
});

describe("CursorMarker", () => {
    const marker = (cursor: Parameters<typeof CursorMarker>[0]["cursor"], left = 12, top = 34) => {
        const { container } = render(<CursorMarker cursor={cursor} left={left} top={top} />);
        return container.firstElementChild as HTMLElement;
    };

    it("sits at the point given, never catching the pointer, with the name in a label of the pointer's color", () => {
        const element = marker({ name: "Bob", tool: "marker", color: "#ffffff" });
        expect(element).toHaveAttribute("data-testid", "remote-cursor");
        expect(element.style.left).toBe("12px");
        expect(element.style.top).toBe("34px");
        expect(element.className).toContain("pointer-events-none");
        const label = screen.getByText("Bob");
        expect(label.style.backgroundColor).toBe("rgb(255, 255, 255)");
        expect(label.style.color).toBe("rgb(0, 0, 0)");
    });

    it("reads white on a dark pointer color", () => {
        marker({ name: "Dark", tool: "eraser", color: "#202124" });
        expect(screen.getByText("Dark").style.color).toBe("rgb(255, 255, 255)");
    });

    it("draws each pen as its own body and tip, in the pointer's color", () => {
        const looks = new Set<string>();
        for (const pen of PEN_TYPES) {
            const element = marker({ name: pen, tool: pen, color: "#1a73e8" });
            const svg = element.querySelector("svg")!;
            expect(svg.getAttribute("viewBox")).toBe("0 0 28 28");
            const body = svg.querySelector("rect")!;
            const tip = svg.querySelector("path")!;
            expect(body.getAttribute("fill")).toBe("#1a73e8");
            expect(tip.getAttribute("fill")).toBe("#1a73e8");
            expect(Number(body.getAttribute("y"))).toBe(-Number(body.getAttribute("height")) / 2);
            looks.add(`${body.getAttribute("height")} ${tip.getAttribute("d")}`);
            expect(within(element).getByText(pen)).toBeInTheDocument();
        }
        expect(looks.size).toBe(PEN_TYPES.length);
    });

    it("draws the stencil as a crosshair with a square, in the pointer's color", () => {
        const element = marker({ name: "S", tool: "stencil", color: "#188038" });
        const svg = element.querySelector("svg")!;
        expect(svg.getAttribute("stroke")).toBe("#188038");
        expect(svg.querySelectorAll("line")).toHaveLength(2);
        expect(svg.querySelectorAll("rect")).toHaveLength(1);
    });

    it("draws the eraser as a ring in the pointer's color", () => {
        const element = marker({ name: "E", tool: "eraser", color: "#9334e6" });
        const circle = element.querySelector("svg circle")!;
        expect(circle.getAttribute("stroke")).toBe("#9334e6");
        expect(circle.getAttribute("fill")).toBe("#ffffff");
    });

    it("shows the stamp tool as its stamp, or a star when it names none", () => {
        const withStamp = marker({ name: "With", tool: "stamp", color: "#000000", stamp: "🔥" });
        expect(withStamp.querySelector("svg")).toBeNull();
        expect(withStamp.firstElementChild).toHaveTextContent("🔥");
        const without = marker({ name: "Without", tool: "stamp", color: "#000000" });
        expect(without.firstElementChild).toHaveTextContent("⭐");
    });
});

describe("Whiteboard - everyone's pointers", () => {
    it("draws everyone else's pointer over the board, scaled from the board to the box shown, with their name", () => {
        const { rerender, props } = renderWith({
            cursors: [remote(), remote({ peer: "carol~1", name: "Carol", x: 0, y: BOARD_HEIGHT, tool: "stamp", stamp: "💡" }), remote({ peer: "dan~1", name: "Dan", x: BOARD_WIDTH, y: 0 })],
        });
        const markers = screen.getAllByTestId("remote-cursor");
        // The box is 800 x 450: half the board's size.
        expect(markers.map((m) => [m.style.left, m.style.top])).toEqual([
            ["400px", "225px"],
            ["0px", "450px"],
            ["800px", "0px"],
        ]);
        expect(markers.map((m) => m.textContent)).toEqual(["Bob", "💡Carol", "Dan"]);
        // The layer they sit on covers the board's box and lets the pointer through to the canvas.
        const layer = markers[0].parentElement!;
        expect(layer.style.width).toBe("800px");
        expect(layer.style.height).toBe("450px");
        expect(layer).toHaveAttribute("aria-hidden", "true");

        rerender(<Whiteboard {...props} cursors={[remote({ x: 160, y: 90 })]} />);
        expect(screen.getAllByTestId("remote-cursor").map((m) => [m.style.left, m.style.top])).toEqual([["80px", "45px"]]);
        // A pointer moving doesn't redraw the board.
        flushFrames();
        rerender(<Whiteboard {...props} cursors={[remote({ x: 320, y: 180 })]} />);
        expect(frames.size).toBe(0);
    });

    it("shows no pointers by default", () => {
        renderWith();
        expect(screen.queryAllByTestId("remote-cursor")).toHaveLength(0);
    });

    it("shares this participant's pointer as the tool and color picked while nothing is being drawn", () => {
        const { session } = renderWith();
        const move = vi.spyOn(session, "moveCursor");
        fireEvent.pointerMove(canvas(), at(200, 100));
        expect(move).toHaveBeenLastCalledWith(200, 100, "ballpoint", SWATCHES[0], undefined);

        fireEvent.click(button(PEN_LABELS.crayon));
        fireEvent.click(screen.getByRole("radio", { name: "Color #d93025" }));
        fireEvent.pointerMove(canvas(), at(300, 120));
        expect(move).toHaveBeenLastCalledWith(300, 120, "crayon", "#d93025", undefined);

        fireEvent.click(button("Stencil"));
        fireEvent.pointerMove(canvas(), at(10, 20));
        expect(move).toHaveBeenLastCalledWith(10, 20, "stencil", "#d93025", undefined);

        fireEvent.click(button("Eraser"));
        fireEvent.pointerMove(canvas(), at(30, 40));
        expect(move).toHaveBeenLastCalledWith(30, 40, "eraser", "#d93025", undefined);

        // Only the stamp tool shares its stamp.
        fireEvent.click(button("Stamp"));
        fireEvent.click(screen.getByRole("button", { name: "Stamp 🎉" }));
        fireEvent.pointerMove(canvas(), at(50, 60));
        expect(move).toHaveBeenLastCalledWith(50, 60, "stamp", "#d93025", "🎉");
        expect(move).toHaveBeenCalledTimes(5);
    });

    it("doesn't share the pointer while a pen stroke is drawn, and does again once it ends", () => {
        const { session } = renderWith();
        const move = vi.spyOn(session, "moveCursor");
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        fireEvent.pointerMove(canvas(), at(120, 100));
        moveWith(canvas(), at(160, 100), [at(140, 100), at(160, 100)]);
        expect(move).not.toHaveBeenCalled();
        expect(elements(session)[0]).toMatchObject({ points: [100, 100, 120, 100, 140, 100, 160, 100] });
        fireEvent.pointerUp(canvas());
        fireEvent.pointerMove(canvas(), at(180, 100));
        expect(move).toHaveBeenCalledTimes(1);
        expect(move).toHaveBeenLastCalledWith(180, 100, "ballpoint", SWATCHES[0], undefined);
    });

    it("shares the pointer through a stencil or eraser drag, once per move however many samples it holds", () => {
        const { session } = renderWith();
        const move = vi.spyOn(session, "moveCursor");
        fireEvent.click(button("Stencil"));
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        moveWith(canvas(), at(300, 200), [at(200, 150), at(300, 200)]);
        expect(move).toHaveBeenCalledTimes(1);
        expect(move).toHaveBeenLastCalledWith(300, 200, "stencil", SWATCHES[0], undefined);
        fireEvent.pointerUp(canvas());

        fireEvent.click(button("Eraser"));
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        fireEvent.pointerMove(canvas(), at(400, 300));
        expect(move).toHaveBeenCalledTimes(2);
        expect(move).toHaveBeenLastCalledWith(400, 300, "eraser", SWATCHES[0], undefined);
    });

    it("says the pointer left when it leaves the canvas, and when the board goes away", () => {
        const { session, unmount } = renderWith();
        const hide = vi.spyOn(session, "hideCursor");
        fireEvent.pointerLeave(canvas());
        expect(hide).toHaveBeenCalledTimes(1);
        unmount();
        expect(hide).toHaveBeenCalledTimes(2);
    });

    it("sends the shared pointer over the session's channel", async () => {
        const { channel } = renderWith();
        fireEvent.pointerMove(canvas(), at(200, 100));
        await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
        expect(channel.sent).toEqual([expect.objectContaining({ kind: "whiteboard-cursor", cursor: { x: 200, y: 100, tool: "ballpoint", color: SWATCHES[0] } })]);
        fireEvent.pointerLeave(canvas());
        expect(channel.sent[channel.sent.length - 1]).toMatchObject({ kind: "whiteboard-cursor", cursor: { hidden: true } });
    });
});

describe("Whiteboard - when this participant may not draw", () => {
    function locked(props: Partial<WhiteboardProps> = {}) {
        const result = renderWith({ canDraw: false, ...props });
        // As _CallView.tsx does: the session's own policy says the same.
        result.session.setDrawPolicy(() => false);
        return result;
    }

    it("draws nothing with any tool, and shows the not-allowed cursor", () => {
        const { session, channel } = locked();
        expect(canvas().className).toContain("cursor-not-allowed");
        expect(canvas().className).not.toContain("cursor-crosshair");
        const begin = vi.spyOn(session, "beginStroke");
        const stamp = vi.spyOn(session, "addStamp");
        const erase = vi.spyOn(session, "erase");
        for (const tool of [PEN_LABELS.marker, "Stencil", "Eraser", "Stamp"]) {
            fireEvent.click(button(tool));
            fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
            fireEvent.pointerMove(canvas(), at(300, 300));
            fireEvent.pointerUp(canvas());
            expect(canvas().className).toContain("cursor-not-allowed");
        }
        expect(begin).not.toHaveBeenCalled();
        expect(stamp).not.toHaveBeenCalled();
        expect(erase).not.toHaveBeenCalled();
        expect(elements(session)).toHaveLength(0);
        expect(channel.sent.filter((message) => message.kind === "whiteboard")).toEqual([]);
    });

    it("still shares the pointer, and still lets a tool and color be picked", () => {
        const { session } = locked();
        const move = vi.spyOn(session, "moveCursor");
        fireEvent.click(button(PEN_LABELS.sharpie));
        fireEvent.click(screen.getByRole("radio", { name: "Color #188038" }));
        expect(button(PEN_LABELS.sharpie)).toHaveAttribute("aria-pressed", "true");
        // Pressing doesn't start anything, so the move after it is a plain pointer move.
        fireEvent.pointerDown(canvas(), { ...at(100, 100), button: 0 });
        fireEvent.pointerMove(canvas(), at(200, 200));
        expect(move).toHaveBeenLastCalledWith(200, 200, "sharpie", "#188038", undefined);
    });

    it("disables undo and clear, and ignores Ctrl+Z", () => {
        const channel = fakeChannel();
        const session = new CollabSession({ channel, selfUid: "me", peerId: "me~1", selfName: "Alice", now: () => 1_000 });
        session.addStamp(STAMPS[0], STAMP_SIZES[0], 100, 100);
        session.setDrawPolicy(() => false);
        const undo = vi.spyOn(session, "undo");
        render(<Whiteboard session={session} revision={1} canDraw={false} onClose={vi.fn()} />);
        expect(button("Undo")).toBeDisabled();
        expect(button("Clear whiteboard")).toBeDisabled();
        fireEvent.click(button("Undo"));
        fireEvent.click(button("Clear whiteboard"));
        expect(screen.queryByRole("group", { name: "Clear the whiteboard?" })).toBeNull();
        // Not taken: the browser's own Ctrl+Z still happens.
        expect(fireEvent.keyDown(document, { key: "z", ctrlKey: true })).toBe(true);
        expect(undo).not.toHaveBeenCalled();
        expect(elements(session)).toHaveLength(1);
    });

    it("names who may draw, or says nobody may yet", () => {
        const { rerender, props } = locked({ drawLockedTo: "Bob" });
        expect(screen.getByRole("status")).toHaveTextContent("Only Bob can draw while the talking stick is on");
        rerender(<Whiteboard {...props} drawLockedTo={undefined} />);
        expect(screen.getByRole("status")).toHaveTextContent("Nobody can draw until the host hands out the talking stick");
        rerender(<Whiteboard {...props} canDraw />);
        expect(screen.queryByRole("status")).toBeNull();
        expect(button("Undo")).toBeEnabled();
        expect(canvas().className).toContain("cursor-crosshair");
    });

    it("shows no note while drawing is allowed, which is the default", () => {
        renderWith();
        expect(screen.queryByRole("status")).toBeNull();
        expect(button("Undo")).toBeEnabled();
        expect(button("Clear whiteboard")).toBeEnabled();
    });
});

describe("Whiteboard - the display's pixel ratio", () => {
    it("resizes and redraws the canvas when the pixel ratio changes", () => {
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
        try {
            const { rerender, props } = renderWith();
            flushFrames();
            expect(frames.size).toBe(0);
            expect(canvas()).toHaveAttribute("width", "800");

            // Same props, same ratio: nothing to redraw.
            rerender(<Whiteboard {...props} />);
            expect(frames.size).toBe(0);

            Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
            rerender(<Whiteboard {...props} />);
            expect(canvas()).toHaveAttribute("width", "1600");
            expect(frames.size).toBe(1);
            recorder.calls.length = 0;
            flushFrames();
            // The paper, at the new scale (1600 / 1600).
            expect(recorder.named("fillRect")[0].args).toEqual([0, 0, 1600, 900]);
        } finally {
            Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
        }
    });
});
