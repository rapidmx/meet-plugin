// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// `Layout` renders a full `<html>` document - only ever used server-side to wrap SSR output, never mounted
// client-side into an existing DOM. Rendered via `renderToStaticMarkup` for the same reason
// `booking-plugin`'s identical `_layout.test.tsx` gives.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Layout from "../../../apps/settings-video-conferencing/_layout.js";

describe("apps/settings-video-conferencing Layout", () => {
    it("Renders the document shell with the given children inside the body.", () => {
        const html = renderToStaticMarkup(
            <Layout>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>RapidMX: Mail</title>");
        expect(html).toContain('charSet="utf-8"');
        expect(html).toContain('href="/favicon.ico"');
        expect(html).toContain('href="/images/logo.svg"');
        expect(html).toContain("<body><p>page content</p></body>");
    });

    it("Renders the configured title, icon, and custom stylesheet when branding is supplied.", () => {
        const html = renderToStaticMarkup(
            <Layout
                branding={{
                    companyName: "Acme",
                    title: "Acme Mail",
                    iconUrl: "https://cdn.example.com/icon.png",
                    logoUrl: "https://cdn.example.com/logo.png",
                    stylesheetUrl: "https://cdn.example.com/theme.css",
                }}
            >
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>Acme Mail: Mail</title>");
        expect(html).toContain('href="https://cdn.example.com/icon.png"');
        expect(html).toContain('id="branding-stylesheet"');
        expect(html).toContain('href="https://cdn.example.com/theme.css"');
    });

    it("Falls back to the logo for the favicon when no icon is configured.", () => {
        const html = renderToStaticMarkup(
            <Layout branding={{ companyName: "Acme", title: "", logoUrl: "https://cdn.example.com/logo.png" }}>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain('href="https://cdn.example.com/logo.png"');
    });
});
