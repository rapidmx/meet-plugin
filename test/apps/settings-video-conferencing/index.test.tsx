// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Minimal render check for the Phase 1 placeholder page - see the page's own comment and this package's
// `.claude/NOTES.md` for why it exists and what replaces it in Phase 4.
import { render, screen } from "@testing-library/react";
import VideoConferencingSettingsPage from "../../../apps/settings-video-conferencing/index.js";

describe("apps/settings-video-conferencing placeholder page", () => {
    it("Renders its coming-soon message.", () => {
        render(<VideoConferencingSettingsPage />);
        expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
    });
});
