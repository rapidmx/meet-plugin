// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Phase 2 replaces the Phase 1 placeholder page - see the page's own comment and this package's `.claude/NOTES.md`.
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import NoMeetingTokenPage from "../../../apps/meet/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("apps/meet index (no token) page", () => {
    it("Shows a friendly message rather than a raw error.", async () => {
        mockFetch((url) => {
            if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
            throw new Error(`unexpected ${url}`);
        });
        render(<NoMeetingTokenPage />);
        expect(await screen.findByText("No meeting link specified.")).toBeInTheDocument();
    });
});
