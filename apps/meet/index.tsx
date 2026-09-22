///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Reached only by a bare `/meet` visit with no token (e.g. a mistyped/incomplete link) - the real join/lobby flow
 * lives at `apps/meet/[token].tsx`, `GET /meet/:token`. Mirrors `booking-plugin`'s identical `apps/book/index.tsx`.
 * Replaces this plugin's Phase 1 one-line placeholder page (see `.claude/NOTES.md`). */
import React from "react";
import useBranding from "@rapidmx/react-shared/branding/useBranding.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import { MeetCard, MeetPageShell } from "./_MeetChrome.js";

export default function NoMeetingTokenPage() {
    const { branding } = useBranding();
    return (
        <MeetPageShell branding={branding}>
            <MeetCard>
                <Alert>No meeting link specified.</Alert>
            </MeetCard>
        </MeetPageShell>
    );
}
