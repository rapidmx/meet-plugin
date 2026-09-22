///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** The frame shared by every page in this app: the deployment's branding header/footer around a centered card, the
 * same `booking-plugin`'s `_BookingChrome.tsx` shell-component pattern this plugin's Phase 2 spec calls for. Not a
 * page itself: `_`-prefixed files in `apps/` aren't routed. */
import React, { PropsWithChildren } from "react";
import { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";
import { BrandingFooter, BrandingHeader } from "@rapidmx/web-client/shared/components/layout/BrandingChrome.js";

export function MeetPageShell({ branding, children }: PropsWithChildren<{ branding: Branding | null }>) {
    return (
        <div className="min-h-screen flex flex-col">
            <BrandingHeader branding={branding} />
            <main className="flex-1 bg-surface-alt px-4 py-6 sm:py-10">{children}</main>
            <BrandingFooter branding={branding} />
        </div>
    );
}

/** The white card the lobby (and the "meeting not found" state) is drawn in - the in-call view (`_CallView.tsx`)
 * deliberately does NOT use this: a video call wants the full viewport, not a centered card. */
export function MeetCard({ maxWidth = "max-w-2xl", children }: PropsWithChildren<{ maxWidth?: string }>) {
    return (
        <div className={`mx-auto w-full ${maxWidth} overflow-hidden rounded-lg border border-border bg-surface shadow-sm p-6 sm:p-10`}>
            {children}
        </div>
    );
}
