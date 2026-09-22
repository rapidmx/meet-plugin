///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { buildBaseUrl } from "../../src/util/PublicUrlUtils.js";

describe("buildBaseUrl", () => {
    it("Returns undefined when the value is undefined.", () => {
        expect(buildBaseUrl(undefined)).toBeUndefined();
    });

    it("Returns undefined when the value is empty or blank.", () => {
        expect(buildBaseUrl("")).toBeUndefined();
        expect(buildBaseUrl("   ")).toBeUndefined();
    });

    it("Returns undefined for an unparseable value.", () => {
        expect(buildBaseUrl("not a url")).toBeUndefined();
    });

    it("Accepts a plain https:// URL, stripping a trailing slash.", () => {
        expect(buildBaseUrl("https://mail.example.com/meet/")).toBe("https://mail.example.com/meet");
    });

    it("Accepts an https:// URL with no path.", () => {
        expect(buildBaseUrl("https://mail.example.com")).toBe("https://mail.example.com");
    });

    it("Rejects a plain http:// URL for a non-loopback host.", () => {
        expect(buildBaseUrl("http://mail.example.com/meet")).toBeUndefined();
    });

    it("Accepts http:// for localhost, 127.0.0.1 and [::1] (local development).", () => {
        expect(buildBaseUrl("http://localhost:3000/meet")).toBe("http://localhost:3000/meet");
        expect(buildBaseUrl("http://127.0.0.1:3000/meet")).toBe("http://127.0.0.1:3000/meet");
        expect(buildBaseUrl("http://[::1]:3000/meet")).toBe("http://[::1]:3000/meet");
    });

    it("Rejects a URL carrying a query string.", () => {
        expect(buildBaseUrl("https://mail.example.com/meet?x=1")).toBeUndefined();
    });

    it("Rejects a URL carrying a fragment.", () => {
        expect(buildBaseUrl("https://mail.example.com/meet#frag")).toBeUndefined();
    });

    it("Rejects a URL carrying credentials.", () => {
        expect(buildBaseUrl("https://user:pass@mail.example.com/meet")).toBeUndefined();
    });

    it("Rejects any other protocol.", () => {
        expect(buildBaseUrl("ftp://mail.example.com/meet")).toBeUndefined();
    });
});
