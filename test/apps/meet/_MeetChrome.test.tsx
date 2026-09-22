// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MeetCard, MeetPageShell } from "../../../apps/meet/_MeetChrome.js";

describe("MeetPageShell", () => {
    it("wraps its children in a main region between the branding header and footer", () => {
        render(
            <MeetPageShell branding={{ companyName: "Acme", title: "Acme", headerHtml: "<p>the header</p>", footerHtml: "<p>the footer</p>" }}>
                <p>the page</p>
            </MeetPageShell>,
        );

        const header = screen.getByText("the header");
        const main = screen.getByRole("main");
        const footer = screen.getByText("the footer");
        expect(main).toContainElement(screen.getByText("the page"));
        expect(header.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("renders only its children when there is no branding", () => {
        const { container } = render(
            <MeetPageShell branding={null}>
                <p>the page</p>
            </MeetPageShell>,
        );
        expect(screen.getByRole("main")).toContainElement(screen.getByText("the page"));
        expect(container.querySelectorAll("main ~ *, main + *")).toHaveLength(0);
    });
});

describe("MeetCard", () => {
    it("is a medium-width card by default and takes a custom maximum width", () => {
        const narrow = render(
            <MeetCard>
                <p>content</p>
            </MeetCard>,
        );
        expect(narrow.container.firstElementChild).toHaveClass("max-w-2xl");
        expect(screen.getByText("content")).toBeInTheDocument();
        narrow.unmount();

        const wide = render(
            <MeetCard maxWidth="max-w-5xl">
                <p>content</p>
            </MeetCard>,
        );
        expect(wide.container.firstElementChild).toHaveClass("max-w-5xl");
        expect(wide.container.firstElementChild).not.toHaveClass("max-w-2xl");
    });
});
