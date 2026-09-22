// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Minimal render check for the Phase 1 placeholder page - see the page's own comment and this package's
// `.claude/NOTES.md` for why it exists and what replaces it in Phase 2.
import { render, screen } from "@testing-library/react";
import MeetPage from "../../../apps/meet/index.js";

describe("apps/meet placeholder page", () => {
    it("Renders its coming-soon message.", () => {
        render(<MeetPage />);
        expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
    });
});
