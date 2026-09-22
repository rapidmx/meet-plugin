///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren } from "react";
import { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";
import { CUSTOM_STYLESHEET_LINK_ID } from "@rapidmx/react-shared/branding/useBranding.js";

export interface LayoutProps {
    /** Supplied by the server's public page route (`PublicPageRoute`), which every `public` plugin app's route
     * extends - see `booking-plugin`'s `apps/book/_layout.tsx`'s identical `LayoutProps` doc comment for the
     * mechanism this mirrors. */
    branding?: Branding;
}

export default function Layout({ children, branding }: PropsWithChildren<LayoutProps>) {
    const title = branding?.title || branding?.companyName ? `${branding?.title || branding?.companyName}: Meet` : "RapidMX: Meet";
    const iconHref = branding?.iconUrl || branding?.logoUrl || "/images/logo.svg";
    const stylesheetHref = branding?.stylesheetUrl;

    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>{title}</title>
                <link rel="icon" type="image/svg+xml" href={iconHref} />
                <link rel="alternate icon" href="/favicon.ico" />
                {stylesheetHref && <link rel="stylesheet" href={stylesheetHref} id={CUSTOM_STYLESHEET_LINK_ID} />}
            </head>
            <body>{children}</body>
        </html>
    );
}
