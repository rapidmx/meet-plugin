///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The shared whiteboard, shown in place of the video stage while a participant has it open (`_CallView.tsx`). Every
 * participant draws on the same board - `CollabSession` (`apps/shared/collab/CollabSession.ts`) carries the drawing
 * to everyone and `whiteboardRender.ts` draws it - but each one opens and closes their own view of it.
 *
 * ## Tools
 *
 * - **Pens** - ballpoint, sharpie, marker, crayon and coloring pencil (`PEN_TYPES`), each drawn its own way.
 * - **Stencil** - drags out a line, arrow, rectangle, ellipse, triangle or star, previewed while dragging.
 * - **Stamps** - places one of `STAMPS` where clicked.
 * - **Eraser** - erases whatever it passes over, anyone's drawing.
 *
 * Plus a row of sizes, color swatches and a color wheel (`_ColorWheel.tsx`) for any other color, undo (also
 * Ctrl/Cmd+Z: takes back this participant's own last drawing) and clear (for everyone, after a confirmation).
 *
 * ## Everyone's pointers
 *
 * While this participant's pointer is over the board it is shared (`CollabSession.moveCursor()`), as the tool they
 * have picked in the color they have picked; everyone else's (`cursors`) is drawn over the canvas the same way, with
 * their name beside it, so each can see who is pointing at - or drawing - what. They are plain elements over the
 * canvas rather than part of the drawing, so a pointer moving never redraws the board.
 *
 * ## Talking stick
 *
 * While `canDraw` is off (talking-stick mode, and someone else holds the stick - see `_CallView.tsx`), drawing,
 * undo and clear do nothing and a note names who may draw; picking a tool or color still works, ready for when the
 * stick comes round. The pointer is still shared.
 *
 * ## The canvas
 *
 * The board is a fixed 16:9 space (`BOARD_WIDTH` x `BOARD_HEIGHT`) fitted into whatever room the stage has, so a
 * stroke lands in the same place on every participant's screen whatever their window size. The canvas is backed at
 * the display's pixel ratio so lines stay sharp, and redrawn at most once per animation frame whenever the board
 * changes (`revision`).
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CollabSession, RemoteCursor } from "../shared/collab/CollabSession.js";
import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    PEN_TYPES,
    SIZES,
    STAMPS,
    STAMP_SIZES,
    STENCIL_SHAPES,
    type PenType,
    type CursorTool,
    type ShapeElement,
    type Stamp,
    type StencilShape,
} from "../shared/collab/protocol.js";
import { drawElement, hitTest, renderBoard, type BoardContext } from "../shared/collab/whiteboardRender.js";
import ColorWheel from "./_ColorWheel.js";
import { ClearIcon, EraserIcon, UndoIcon } from "./_icons.js";

export interface WhiteboardProps {
    session: CollabSession;
    /** `session.board.revision` - a new value redraws the board. */
    revision: number;
    /** Everyone else's pointers on the board - `CollabSession.cursors`. */
    cursors?: readonly RemoteCursor[];
    /** Whether this participant may draw now - see this module's doc comment on talking stick. Defaults to `true`. */
    canDraw?: boolean;
    /** Who may draw while `canDraw` is off, for the note saying so; absent while nobody holds the stick. */
    drawLockedTo?: string;
    onClose: () => void;
}

type Tool = { kind: "pen"; pen: PenType } | { kind: "stencil" } | { kind: "stamp" } | { kind: "eraser" };

export const PEN_LABELS: Record<PenType, string> = {
    ballpoint: "Ballpoint pen",
    sharpie: "Sharpie",
    marker: "Marker",
    crayon: "Crayon",
    pencil: "Coloring pencil",
};

export const SHAPE_LABELS: Record<StencilShape, string> = {
    line: "Line",
    arrow: "Arrow",
    rect: "Rectangle",
    ellipse: "Ellipse",
    triangle: "Triangle",
    star: "Star",
};

/** The color swatches, in display order. */
export const SWATCHES = ["#202124", "#ffffff", "#9aa0a6", "#d93025", "#f29900", "#fbbc04", "#188038", "#1a73e8", "#9334e6", "#e52592", "#795548", "#00bcd4"] as const;

/** A freehand point closer than this (board units) to the previous one is skipped - it adds nothing visible. */
const MIN_POINT_DISTANCE = 2;
/** The eraser's reach around the pointer, in board units. */
const ERASER_RADIUS = 14;
/** A stencil drag shorter than this (board units) is a mis-click, not a shape. */
const MIN_SHAPE_SIZE = 4;

const TOOL_BUTTON =
    "w-9 h-9 shrink-0 flex items-center justify-center rounded-lg hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 aria-pressed:bg-[#a8c7fa] aria-pressed:text-[#062e6f]";

/** A short sample of each pen's line, for its toolbar button. */
function PenSample({ pen }: { pen: PenType }) {
    const look: Record<PenType, { width: number; opacity: number; dash?: string; cap: "round" | "square" }> = {
        ballpoint: { width: 1.5, opacity: 1, cap: "round" },
        sharpie: { width: 3, opacity: 1, cap: "round" },
        marker: { width: 6, opacity: 0.5, cap: "square" },
        crayon: { width: 4, opacity: 0.8, dash: "2 1", cap: "round" },
        pencil: { width: 1.5, opacity: 0.6, dash: "3 1", cap: "round" },
    };
    const { width, opacity, dash, cap } = look[pen];
    return (
        <svg viewBox="0 0 24 24" className="w-6 h-6" aria-hidden="true" focusable="false">
            <path d="M3 16c3-6 6-6 9 0s6 6 9 0" fill="none" stroke="currentColor" strokeWidth={width} strokeOpacity={opacity} strokeDasharray={dash} strokeLinecap={cap} />
        </svg>
    );
}

/** Black or white, whichever reads better on `color` (`#rrggbb`). */
export function labelTextColor(color: string): string {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000000" : "#ffffff";
}

/** A participant's pointer: their tool's own shape in their color, its tip (or a stamp's center) at the point, with
 * their name beside it. */
export function CursorMarker({ cursor, left, top }: { cursor: Pick<RemoteCursor, "name" | "tool" | "color" | "stamp">; left: number; top: number }) {
    const { tool, color } = cursor;
    let glyph: React.ReactNode;
    if (tool === "stamp") {
        glyph = <span className="block -translate-x-1/2 -translate-y-1/2 text-2xl leading-none drop-shadow">{cursor.stamp ?? "⭐"}</span>;
    } else if (tool === "eraser") {
        glyph = (
            <svg viewBox="0 0 24 24" className="w-6 h-6 -translate-x-1/2 -translate-y-1/2" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="#ffffff" fillOpacity="0.6" stroke={color} strokeWidth="2" />
            </svg>
        );
    } else if (tool === "stencil") {
        glyph = (
            <svg viewBox="0 0 24 24" className="w-6 h-6 -translate-x-1/2 -translate-y-1/2" fill="none" stroke={color} strokeWidth="2" aria-hidden="true">
                <line x1="12" y1="2" x2="12" y2="22" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <rect x="15" y="15" width="7" height="7" />
            </svg>
        );
    } else {
        // A pen held at an angle, tip at the top-left corner: its body width and tip say which pen it is.
        const body: Record<PenType, { width: number; tip: string }> = {
            ballpoint: { width: 4, tip: "M0 0l5 2-3 3z" },
            sharpie: { width: 6, tip: "M0 0l7 3-4 4z" },
            marker: { width: 8, tip: "M0 0h6l2 2v6H2L0 6z" },
            crayon: { width: 6, tip: "M0 0l8 4-4 4z" },
            pencil: { width: 5, tip: "M0 0l6 2-4 4z" },
        };
        const { width, tip } = body[tool];
        glyph = (
            <svg viewBox="0 0 28 28" className="w-7 h-7" aria-hidden="true">
                <g transform="rotate(45 0 0)">
                    <rect x="6" y={-width / 2} width="20" height={width} rx="1" fill={color} stroke="#000000" strokeOpacity="0.5" strokeWidth="1" />
                </g>
                <path d={tip} fill={color} stroke="#000000" strokeOpacity="0.5" strokeWidth="0.8" />
            </svg>
        );
    }
    return (
        <div className="pointer-events-none absolute transition-[left,top] duration-75 ease-linear" style={{ left, top }} data-testid="remote-cursor">
            {glyph}
            <span
                className="absolute left-4 top-4 max-w-40 truncate whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium shadow"
                style={{ backgroundColor: color, color: labelTextColor(color) }}
            >
                {cursor.name}
            </span>
        </div>
    );
}

/** A small outline of each stencil shape, for its button. */
function ShapeSample({ shape }: { shape: StencilShape }) {
    const paths: Record<StencilShape, React.ReactNode> = {
        line: <line x1="4" y1="20" x2="20" y2="4" />,
        arrow: <path d="M4 20L20 4m0 0h-7m7 0v7" />,
        rect: <rect x="4" y="6" width="16" height="12" />,
        ellipse: <ellipse cx="12" cy="12" rx="9" ry="6.5" />,
        triangle: <path d="M12 4l9 16H3z" />,
        star: <path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 16.8 6.4 20.1l1.4-6.3L3 9.5l6.4-.6z" />,
    };
    return (
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" focusable="false">
            {paths[shape]}
        </svg>
    );
}

export default function Whiteboard({ session, revision, cursors = [], canDraw = true, drawLockedTo, onClose }: WhiteboardProps) {
    const [tool, setTool] = useState<Tool>({ kind: "pen", pen: "ballpoint" });
    const [shape, setShape] = useState<StencilShape>("rect");
    const [stamp, setStamp] = useState<Stamp>(STAMPS[0]);
    const [color, setColor] = useState<string>(SWATCHES[0]);
    const [sizeIndex, setSizeIndex] = useState(1);
    const [stampSizeIndex, setStampSizeIndex] = useState(1);
    const [popover, setPopover] = useState<"wheel" | "stamps" | null>(null);
    const [confirmClear, setConfirmClear] = useState(false);
    const [box, setBox] = useState({ width: 0, height: 0 });

    const stageRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ strokeId?: string; lastX: number; lastY: number; startX: number; startY: number } | null>(null);
    const previewRef = useRef<ShapeElement | null>(null);
    const frameRef = useRef<number | undefined>(undefined);

    const size = SIZES[sizeIndex];
    const stampSize = STAMP_SIZES[stampSizeIndex];

    // The largest 16:9 box that fits the stage.
    useLayoutEffect(() => {
        const stage = stageRef.current!;
        const fit = () => {
            const { width, height } = stage.getBoundingClientRect();
            const fitted = Math.min(width, (height * BOARD_WIDTH) / BOARD_HEIGHT);
            setBox({ width: Math.floor(fitted), height: Math.floor((fitted * BOARD_HEIGHT) / BOARD_WIDTH) });
        };
        fit();
        if (typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(fit);
        observer.observe(stage);
        return () => observer.disconnect();
    }, []);

    const draw = useCallback(() => {
        frameRef.current = undefined;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d") as BoardContext | null | undefined;
        if (!canvas || !ctx) {
            return;
        }
        const scale = canvas.width / BOARD_WIDTH;
        renderBoard(ctx, session.board.elements, scale);
        if (previewRef.current) {
            ctx.save();
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            drawElement(ctx, previewRef.current);
            ctx.restore();
        }
    }, [session]);

    const scheduleDraw = useCallback(() => {
        if (frameRef.current === undefined) {
            frameRef.current = requestAnimationFrame(draw);
        }
    }, [draw]);

    const ratio = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;

    // A new size or pixel ratio resizes the canvas, which wipes it - so either redraws, as a change to the board does.
    useEffect(() => {
        scheduleDraw();
    }, [revision, box, ratio, scheduleDraw]);

    // This participant's pointer leaves everyone else's board with the board itself.
    useEffect(() => () => session.hideCursor(), [session]);

    useEffect(() => () => {
        if (frameRef.current !== undefined) {
            cancelAnimationFrame(frameRef.current);
        }
    }, []);

    // Ctrl/Cmd+Z takes back this participant's own last drawing - unless they are typing somewhere (the chat).
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("input, textarea, [contenteditable='true']")) {
                return;
            }
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z" && session.canDraw) {
                event.preventDefault();
                session.undo();
            } else if (event.key === "Escape") {
                setPopover(null);
                setConfirmClear(false);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [session]);

    function toBoard(event: { clientX: number; clientY: number }): { x: number; y: number } {
        const rect = canvasRef.current!.getBoundingClientRect();
        const width = rect.width || BOARD_WIDTH;
        const height = rect.height || BOARD_HEIGHT;
        return { x: ((event.clientX - rect.left) / width) * BOARD_WIDTH, y: ((event.clientY - rect.top) / height) * BOARD_HEIGHT };
    }

    function erase(x: number, y: number) {
        const hits = session.board.elements.filter((element) => hitTest(element, x, y, ERASER_RADIUS)).map((element) => element.id);
        session.erase(hits);
    }

    function cursorTool(): CursorTool {
        return tool.kind === "pen" ? tool.pen : tool.kind;
    }

    function shareCursor(x: number, y: number) {
        session.moveCursor(x, y, cursorTool(), color, tool.kind === "stamp" ? stamp : undefined);
    }

    function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
        if (event.button !== 0 || !canDraw) {
            return;
        }
        setPopover(null);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const { x, y } = toBoard(event);
        switch (tool.kind) {
            case "pen":
                drawingRef.current = { strokeId: session.beginStroke(tool.pen, color, size, x, y), lastX: x, lastY: y, startX: x, startY: y };
                return;
            case "stencil":
                drawingRef.current = { lastX: x, lastY: y, startX: x, startY: y };
                return;
            case "stamp":
                session.addStamp(stamp, stampSize, x, y);
                return;
            case "eraser":
                drawingRef.current = { lastX: x, lastY: y, startX: x, startY: y };
                erase(x, y);
                return;
        }
    }

    function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
        const drawing = drawingRef.current;
        if (!drawing) {
            const { x, y } = toBoard(event);
            shareCursor(x, y);
            return;
        }
        const events = typeof event.nativeEvent.getCoalescedEvents === "function" ? event.nativeEvent.getCoalescedEvents() : [];
        for (const sample of events.length > 0 ? events : [event]) {
            const { x, y } = toBoard(sample);
            if (tool.kind === "pen" && drawing.strokeId) {
                if (Math.hypot(x - drawing.lastX, y - drawing.lastY) >= MIN_POINT_DISTANCE) {
                    session.extendStroke(drawing.strokeId, x, y);
                    drawing.lastX = x;
                    drawing.lastY = y;
                }
            } else if (tool.kind === "eraser") {
                erase(x, y);
            } else if (tool.kind === "stencil") {
                previewRef.current = { kind: "shape", id: "preview", epoch: 0, shape, color, size, x1: drawing.startX, y1: drawing.startY, x2: x, y2: y };
                drawing.lastX = x;
                drawing.lastY = y;
                scheduleDraw();
            }
        }
        // Mid-stroke the stroke itself shows everyone where the pen is; anything else moves the pointer.
        if (tool.kind !== "pen") {
            const { x, y } = toBoard(event);
            shareCursor(x, y);
        }
    }

    function handlePointerUp() {
        const drawing = drawingRef.current;
        drawingRef.current = null;
        if (!drawing) {
            return;
        }
        if (tool.kind === "pen") {
            session.endStroke();
        } else if (tool.kind === "stencil") {
            previewRef.current = null;
            if (Math.hypot(drawing.lastX - drawing.startX, drawing.lastY - drawing.startY) >= MIN_SHAPE_SIZE) {
                session.addShape(shape, color, size, drawing.startX, drawing.startY, drawing.lastX, drawing.lastY);
            }
            scheduleDraw();
        }
    }

    const cursor = tool.kind === "eraser" ? "cursor-cell" : tool.kind === "stamp" ? "cursor-copy" : "cursor-crosshair";

    return (
        <section aria-label="Whiteboard" className="h-full flex flex-col gap-2" data-testid="whiteboard">
            <div role="toolbar" aria-label="Whiteboard tools" className="relative shrink-0 flex flex-wrap items-center gap-1 rounded-2xl bg-[#2b2d30] px-2 py-1.5 text-white">
                {PEN_TYPES.map((pen) => (
                    <button
                        key={pen}
                        type="button"
                        className={TOOL_BUTTON}
                        aria-label={PEN_LABELS[pen]}
                        title={PEN_LABELS[pen]}
                        aria-pressed={tool.kind === "pen" && tool.pen === pen}
                        onClick={() => setTool({ kind: "pen", pen })}
                    >
                        <PenSample pen={pen} />
                    </button>
                ))}
                <button type="button" className={TOOL_BUTTON} aria-label="Stencil" title="Stencil" aria-pressed={tool.kind === "stencil"} onClick={() => setTool({ kind: "stencil" })}>
                    <ShapeSample shape={shape} />
                </button>
                <button
                    type="button"
                    className={TOOL_BUTTON}
                    aria-label="Stamp"
                    title="Stamp"
                    aria-pressed={tool.kind === "stamp"}
                    onClick={() => {
                        setTool({ kind: "stamp" });
                        setPopover((prev) => (prev === "stamps" ? null : "stamps"));
                    }}
                >
                    <span className="text-lg leading-none">{stamp}</span>
                </button>
                <button type="button" className={TOOL_BUTTON} aria-label="Eraser" title="Eraser" aria-pressed={tool.kind === "eraser"} onClick={() => setTool({ kind: "eraser" })}>
                    <EraserIcon />
                </button>

                <span className="mx-1 h-6 w-px bg-white/15" aria-hidden="true" />

                {tool.kind === "stencil" && (
                    <div role="group" aria-label="Stencil shape" className="flex items-center gap-0.5">
                        {STENCIL_SHAPES.map((candidate) => (
                            <button key={candidate} type="button" className={TOOL_BUTTON} aria-label={SHAPE_LABELS[candidate]} title={SHAPE_LABELS[candidate]} aria-pressed={shape === candidate} onClick={() => setShape(candidate)}>
                                <ShapeSample shape={candidate} />
                            </button>
                        ))}
                    </div>
                )}

                {(tool.kind === "pen" || tool.kind === "stencil") && (
                    <div role="group" aria-label="Size" className="flex items-center gap-0.5">
                        {SIZES.map((candidate, index) => (
                            <button key={candidate} type="button" className={TOOL_BUTTON} aria-label={`Size ${index + 1}`} aria-pressed={sizeIndex === index} onClick={() => setSizeIndex(index)}>
                                <span className="rounded-full bg-current" style={{ width: 3 + index * 3, height: 3 + index * 3 }} />
                            </button>
                        ))}
                    </div>
                )}

                {tool.kind === "stamp" && (
                    <div role="group" aria-label="Stamp size" className="flex items-center gap-0.5">
                        {STAMP_SIZES.map((candidate, index) => (
                            <button key={candidate} type="button" className={TOOL_BUTTON} aria-label={`Stamp size ${index + 1}`} aria-pressed={stampSizeIndex === index} onClick={() => setStampSizeIndex(index)}>
                                <span style={{ fontSize: 9 + index * 4 }}>{stamp}</span>
                            </button>
                        ))}
                    </div>
                )}

                {tool.kind !== "eraser" && tool.kind !== "stamp" && (
                    <>
                        <span className="mx-1 h-6 w-px bg-white/15" aria-hidden="true" />
                        <div role="radiogroup" aria-label="Color" className="flex flex-wrap items-center gap-1">
                            {SWATCHES.map((swatch) => (
                                <button
                                    key={swatch}
                                    type="button"
                                    role="radio"
                                    aria-checked={color === swatch}
                                    aria-label={`Color ${swatch}`}
                                    className={`w-6 h-6 rounded-full border border-white/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${color === swatch ? "ring-2 ring-[#a8c7fa] ring-offset-2 ring-offset-[#2b2d30]" : ""}`}
                                    style={{ backgroundColor: swatch }}
                                    onClick={() => setColor(swatch)}
                                />
                            ))}
                            <button
                                type="button"
                                aria-label="Custom color"
                                aria-expanded={popover === "wheel"}
                                title="Custom color"
                                className={`w-6 h-6 rounded-full p-[3px] bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${SWATCHES.includes(color as never) ? "" : "ring-2 ring-[#a8c7fa] ring-offset-2 ring-offset-[#2b2d30]"}`}
                                onClick={() => setPopover((prev) => (prev === "wheel" ? null : "wheel"))}
                            >
                                <span className="block w-full h-full rounded-full border border-black/30" style={{ backgroundColor: color }} />
                            </button>
                        </div>
                    </>
                )}

                <span className="flex-1" />
                <button type="button" className={`${TOOL_BUTTON} disabled:opacity-40 disabled:cursor-not-allowed`} aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canDraw} onClick={() => session.undo()}>
                    <UndoIcon />
                </button>
                {confirmClear ? (
                    <span className="flex items-center gap-1 text-sm" role="group" aria-label="Clear the whiteboard?">
                        <span>Clear for everyone?</span>
                        <button
                            type="button"
                            className="px-2 py-1 rounded-lg bg-[#d93025] hover:bg-[#b3261e] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                            onClick={() => {
                                session.clear();
                                setConfirmClear(false);
                            }}
                        >
                            Clear
                        </button>
                        <button type="button" className="px-2 py-1 rounded-lg hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80" onClick={() => setConfirmClear(false)}>
                            Cancel
                        </button>
                    </span>
                ) : (
                    <button
                        type="button"
                        className={`${TOOL_BUTTON} disabled:opacity-40 disabled:cursor-not-allowed`}
                        aria-label="Clear whiteboard"
                        title="Clear whiteboard"
                        disabled={!canDraw}
                        onClick={() => setConfirmClear(true)}
                    >
                        <ClearIcon />
                    </button>
                )}
                <button type="button" className="ml-1 px-3 h-9 rounded-lg bg-[#3c4043] hover:bg-[#4b4f53] text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80" onClick={onClose}>
                    Back to video
                </button>

                {popover === "wheel" && (
                    <div role="dialog" aria-label="Custom color" className="absolute z-20 top-full mt-2 right-2 p-3 rounded-2xl bg-[#2b2d30] shadow-xl">
                        <ColorWheel color={color} onChange={setColor} />
                    </div>
                )}
                {popover === "stamps" && (
                    <div role="dialog" aria-label="Stamps" className="absolute z-20 top-full mt-2 left-2 grid grid-cols-8 gap-1 p-2 rounded-2xl bg-[#2b2d30] shadow-xl">
                        {STAMPS.map((candidate) => (
                            <button
                                key={candidate}
                                type="button"
                                aria-label={`Stamp ${candidate}`}
                                aria-pressed={stamp === candidate}
                                className="w-10 h-10 rounded-lg text-2xl hover:bg-white/10 aria-pressed:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                                onClick={() => {
                                    setStamp(candidate);
                                    setPopover(null);
                                }}
                            >
                                {candidate}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div ref={stageRef} className="relative flex-1 min-h-0 flex items-center justify-center">
                <canvas
                    ref={canvasRef}
                    width={Math.max(1, Math.round(box.width * ratio))}
                    height={Math.max(1, Math.round(box.height * ratio))}
                    style={{ width: box.width, height: box.height }}
                    className={`rounded-lg shadow-lg touch-none bg-white ${canDraw ? cursor : "cursor-not-allowed"}`}
                    aria-label="Whiteboard canvas"
                    role="img"
                    data-testid="whiteboard-canvas"
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onPointerLeave={() => session.hideCursor()}
                />
                <div className="pointer-events-none absolute overflow-hidden" style={{ width: box.width, height: box.height }} aria-hidden="true">
                    {cursors.map((remote) => (
                        <CursorMarker key={remote.peer} cursor={remote} left={(remote.x / BOARD_WIDTH) * box.width} top={(remote.y / BOARD_HEIGHT) * box.height} />
                    ))}
                </div>
                {!canDraw && (
                    <p role="status" className="absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-[#a8c7fa] px-3 py-1 text-sm font-medium text-[#062e6f] shadow">
                        🎙️ {drawLockedTo ? `Only ${drawLockedTo} can draw while the talking stick is on` : "Nobody can draw until the host hands out the talking stick"}
                    </p>
                )}
            </div>
        </section>
    );
}
