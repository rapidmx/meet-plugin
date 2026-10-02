///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * A draggable, persistent window around `_DiagnosticsPanel.tsx` - unlike every other popover in this call (which
 * closes the moment focus moves elsewhere), this one stays open and visible over the call for as long as a
 * participant is actively troubleshooting a connection, until they close it themselves (the title bar's own ✕).
 * Opened from the navbar's "…" menu (`_CallView.tsx`).
 *
 * Dragging is tracked on `document`, not the title bar itself, so a fast drag that outruns the pointer never gets
 * "stuck" the way listening only on the title bar's own element would - the standard way to implement a drag
 * without relying on `setPointerCapture()` (unimplemented in the jsdom this is tested under). The window's position
 * is owned by this component (`position` state), not the caller - closing and reopening it starts over at
 * `initialPosition` rather than remembering where it was left, since there is nothing durable to anchor that to
 * across the call ending and starting again.
 */
import React, { useEffect, useRef, useState } from "react";

export interface DiagnosticsWindowProps {
    onClose: () => void;
    /** Where the window first appears - defaults to a spot near the top-left corner, clear of the header's own
     * chips and buttons. */
    initialPosition?: { x: number; y: number };
    children: React.ReactNode;
}

const DEFAULT_POSITION = { x: 12, y: 56 };

export default function DiagnosticsWindow({ onClose, initialPosition = DEFAULT_POSITION, children }: DiagnosticsWindowProps) {
    const [position, setPosition] = useState(initialPosition);
    const [dragging, setDragging] = useState(false);
    const dragOffsetRef = useRef({ x: 0, y: 0 });

    function handleTitleBarPointerDown(event: React.PointerEvent) {
        dragOffsetRef.current = { x: event.clientX - position.x, y: event.clientY - position.y };
        setDragging(true);
    }

    useEffect(() => {
        if (!dragging) {
            return;
        }
        const onMove = (event: PointerEvent) => {
            setPosition({ x: event.clientX - dragOffsetRef.current.x, y: event.clientY - dragOffsetRef.current.y });
        };
        const onUp = () => setDragging(false);
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        return () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
        };
    }, [dragging]);

    return (
        <div
            role="dialog"
            aria-label="Call diagnostics"
            className="fixed z-30 w-80 max-w-[calc(100vw-1rem)] max-h-[70vh] flex flex-col rounded-2xl bg-[#2b2d30]/95 text-white shadow-xl overflow-hidden"
            style={{ left: position.x, top: position.y }}
        >
            <div
                className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-white/10 cursor-move select-none"
                onPointerDown={handleTitleBarPointerDown}
            >
                <span className="text-sm font-medium">Call diagnostics</span>
                <button
                    type="button"
                    className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    aria-label="Close call diagnostics"
                    onClick={onClose}
                >
                    ✕
                </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3">{children}</div>
        </div>
    );
}
