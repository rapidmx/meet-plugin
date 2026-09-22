///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { JOIN_TOKEN_PATTERN, PUBLIC_SLUG_PATTERN, mintJoinToken, mintPublicSlug } from "../../src/util/TokenUtils.js";

describe("mintJoinToken", () => {
    it("Mints a value matching JOIN_TOKEN_PATTERN.", () => {
        expect(mintJoinToken()).toMatch(JOIN_TOKEN_PATTERN);
    });

    it("Mints a fresh, non-repeating value on every call.", () => {
        expect(mintJoinToken()).not.toBe(mintJoinToken());
    });

    it("Never matches PUBLIC_SLUG_PATTERN, so the two can never collide.", () => {
        expect(mintJoinToken()).not.toMatch(PUBLIC_SLUG_PATTERN);
    });
});

describe("mintPublicSlug", () => {
    it("Mints a value matching PUBLIC_SLUG_PATTERN.", () => {
        expect(mintPublicSlug()).toMatch(PUBLIC_SLUG_PATTERN);
    });

    it("Mints a fresh, non-repeating value on every call.", () => {
        expect(mintPublicSlug()).not.toBe(mintPublicSlug());
    });

    it("Never matches JOIN_TOKEN_PATTERN, so the two can never collide.", () => {
        expect(mintPublicSlug()).not.toMatch(JOIN_TOKEN_PATTERN);
    });
});
