// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// See `booking-plugin`'s identical `test/apps/book/_layout.test.tsx` for why `renderToStaticMarkup` is used here
// rather than `@testing-library/react`'s `render()`.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Layout from "../../../apps/meet/_layout.js";

describe("Layout", () => {
    it("renders the document shell with the given children inside the body", () => {
        const html = renderToStaticMarkup(
            <Layout>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>RapidMX: Meet</title>");
        expect(html).toContain('charSet="utf-8"');
        expect(html).toContain('href="/favicon.ico"');
        expect(html).toContain("<body><p>page content</p></body>");
    });

    it("renders the configured title and icon when branding is supplied", () => {
        const html = renderToStaticMarkup(
            <Layout branding={{ companyName: "Acme", title: "Acme Mail", iconUrl: "https://cdn.example.com/icon.png" }}>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>Acme Mail: Meet</title>");
        expect(html).toContain('href="https://cdn.example.com/icon.png"');
        expect(html).not.toContain('rel="stylesheet"');
    });

    it("falls back to the company name for the title, and the logo for the icon", () => {
        const html = renderToStaticMarkup(
            <Layout branding={{ companyName: "Acme", title: "", logoUrl: "https://cdn.example.com/logo.svg" }}>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>Acme: Meet</title>");
        expect(html).toContain('href="https://cdn.example.com/logo.svg"');
    });

    it("links the configured custom stylesheet", () => {
        const html = renderToStaticMarkup(
            <Layout branding={{ companyName: "", title: "", stylesheetUrl: "https://cdn.example.com/brand.css" }}>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain('<link rel="stylesheet" href="https://cdn.example.com/brand.css" id="');
        expect(html).toContain("<title>RapidMX: Meet</title>");
        expect(html).toContain('href="/images/logo.svg"');
    });
});
