// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DiagnosticsWindow from "../../../apps/meet/_DiagnosticsWindow.js";

function titleBar(): HTMLElement {
    return screen.getByText("Call diagnostics").closest("div")!;
}

function dialogStyle(): CSSStyleDeclaration {
    return screen.getByRole("dialog", { name: "Call diagnostics" }).style;
}

describe("DiagnosticsWindow", () => {
    it("starts at the default position, renders its children, and closes from its own button", () => {
        const onClose = vi.fn();
        render(
            <DiagnosticsWindow onClose={onClose}>
                <p>diagnostics content</p>
            </DiagnosticsWindow>,
        );
        expect(screen.getByText("diagnostics content")).toBeInTheDocument();
        expect(dialogStyle().left).toBe("12px");
        expect(dialogStyle().top).toBe("56px");

        fireEvent.click(screen.getByRole("button", { name: "Close call diagnostics" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("starts at a given initial position", () => {
        render(
            <DiagnosticsWindow onClose={vi.fn()} initialPosition={{ x: 40, y: 80 }}>
                <p>content</p>
            </DiagnosticsWindow>,
        );
        expect(dialogStyle().left).toBe("40px");
        expect(dialogStyle().top).toBe("80px");
    });

    it("drags from the title bar, following the pointer, and stops following once released", () => {
        render(
            <DiagnosticsWindow onClose={vi.fn()} initialPosition={{ x: 10, y: 10 }}>
                <p>content</p>
            </DiagnosticsWindow>,
        );
        fireEvent.pointerDown(titleBar(), { clientX: 15, clientY: 20 });
        fireEvent.pointerMove(document, { clientX: 35, clientY: 50 });
        // Offset from the pointer-down (5, 10) is preserved: 35-5=30, 50-10=40.
        expect(dialogStyle().left).toBe("30px");
        expect(dialogStyle().top).toBe("40px");

        fireEvent.pointerUp(document);
        fireEvent.pointerMove(document, { clientX: 100, clientY: 100 });
        // No longer dragging - stayed where it was released.
        expect(dialogStyle().left).toBe("30px");
        expect(dialogStyle().top).toBe("40px");
    });

    it("does not move on a pointer move before any pointer down on the title bar", () => {
        render(
            <DiagnosticsWindow onClose={vi.fn()} initialPosition={{ x: 10, y: 10 }}>
                <p>content</p>
            </DiagnosticsWindow>,
        );
        fireEvent.pointerMove(document, { clientX: 500, clientY: 500 });
        expect(dialogStyle().left).toBe("10px");
        expect(dialogStyle().top).toBe("10px");
    });

    it("removes its document listeners once dragging stops, rather than leaking them", () => {
        render(
            <DiagnosticsWindow onClose={vi.fn()} initialPosition={{ x: 0, y: 0 }}>
                <p>content</p>
            </DiagnosticsWindow>,
        );
        fireEvent.pointerDown(titleBar(), { clientX: 0, clientY: 0 });
        fireEvent.pointerUp(document);
        // A move after the drag ended, and after unmount, must not throw or move anything stale.
        fireEvent.pointerMove(document, { clientX: 999, clientY: 999 });
        expect(dialogStyle().left).toBe("0px");
        expect(dialogStyle().top).toBe("0px");
    });
});
