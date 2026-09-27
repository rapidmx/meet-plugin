///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { parseEffectsAssetsUrl } from "../../src/util/EffectsUtils.js";

describe("parseEffectsAssetsUrl", () => {
    it.each([undefined, null, 42, true, {}, ["https://files.example.com"]])("Returns undefined for the non-string value %j.", (value) => {
        expect(parseEffectsAssetsUrl(value)).toBeUndefined();
    });

    it("Returns undefined when the value is empty or blank.", () => {
        expect(parseEffectsAssetsUrl("")).toBeUndefined();
        expect(parseEffectsAssetsUrl("   ")).toBeUndefined();
        expect(parseEffectsAssetsUrl("\t\n")).toBeUndefined();
    });

    it("Accepts an https:// URL.", () => {
        expect(parseEffectsAssetsUrl("https://files.example.com/meet-effects")).toBe("https://files.example.com/meet-effects");
    });

    it("Accepts an http:// URL.", () => {
        expect(parseEffectsAssetsUrl("http://files.example.com/meet-effects")).toBe("http://files.example.com/meet-effects");
    });

    it("Accepts a URL with a port, a query-free host-only form, and an uppercase scheme.", () => {
        expect(parseEffectsAssetsUrl("https://files.example.com:8443/effects")).toBe("https://files.example.com:8443/effects");
        expect(parseEffectsAssetsUrl("https://files.example.com")).toBe("https://files.example.com");
        expect(parseEffectsAssetsUrl("HTTPS://Files.Example.com/effects")).toBe("HTTPS://Files.Example.com/effects");
    });

    it("Accepts a root-relative path.", () => {
        expect(parseEffectsAssetsUrl("/meet-effects")).toBe("/meet-effects");
        expect(parseEffectsAssetsUrl("/assets/meet/effects")).toBe("/assets/meet/effects");
    });

    it("Trims surrounding whitespace.", () => {
        expect(parseEffectsAssetsUrl("  https://files.example.com/effects \n")).toBe("https://files.example.com/effects");
        expect(parseEffectsAssetsUrl("\t/meet-effects  ")).toBe("/meet-effects");
    });

    it("Strips trailing slashes.", () => {
        expect(parseEffectsAssetsUrl("https://files.example.com/effects/")).toBe("https://files.example.com/effects");
        expect(parseEffectsAssetsUrl("https://files.example.com/effects///")).toBe("https://files.example.com/effects");
        expect(parseEffectsAssetsUrl("/meet-effects/")).toBe("/meet-effects");
        expect(parseEffectsAssetsUrl(" /meet-effects/ ")).toBe("/meet-effects");
    });

    it("Returns undefined for a bare root path, which has nothing left once its slash is stripped.", () => {
        expect(parseEffectsAssetsUrl("/")).toBeUndefined();
        expect(parseEffectsAssetsUrl("///")).toBeUndefined();
    });

    it("Returns undefined for a protocol-relative URL.", () => {
        expect(parseEffectsAssetsUrl("//files.example.com/effects")).toBeUndefined();
    });

    it.each(["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "ftp://files.example.com/effects", "file:///etc/passwd", "blob:https://example.com/abc"])(
        "Returns undefined for the non-http(s) URL %s.",
        (value) => {
            expect(parseEffectsAssetsUrl(value)).toBeUndefined();
        },
    );

    it("Returns undefined for a relative path that does not start with a slash.", () => {
        expect(parseEffectsAssetsUrl("meet-effects")).toBeUndefined();
        expect(parseEffectsAssetsUrl("./meet-effects")).toBeUndefined();
        expect(parseEffectsAssetsUrl("../meet-effects")).toBeUndefined();
        expect(parseEffectsAssetsUrl("files.example.com/effects")).toBeUndefined();
    });

    it("Returns undefined for a scheme with no host.", () => {
        expect(parseEffectsAssetsUrl("https://")).toBeUndefined();
        expect(parseEffectsAssetsUrl("http:///")).toBeUndefined();
        expect(parseEffectsAssetsUrl("https:/files.example.com")).toBeUndefined();
    });

    it("Returns undefined when whitespace remains inside the value.", () => {
        expect(parseEffectsAssetsUrl("https://files.example.com/my effects")).toBeUndefined();
        expect(parseEffectsAssetsUrl("/meet effects")).toBeUndefined();
        expect(parseEffectsAssetsUrl("https://files.example.com/a\tb")).toBeUndefined();
        expect(parseEffectsAssetsUrl("https://files.example.com/a\nb")).toBeUndefined();
    });
});
