///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    ACCESSORY_OPTIONS,
    BACKGROUND_OPTIONS,
    EFFECT_OPTIONS,
    NO_FILTERS,
    filtersActive,
    needsFace,
    needsSegmentation,
    sanitizeFilters,
} from "../../../../../apps/shared/media/filters/filterTypes.js";

describe("option lists", () => {
    it.each([
        ["background", BACKGROUND_OPTIONS],
        ["effect", EFFECT_OPTIONS],
        ["accessory", ACCESSORY_OPTIONS],
    ])("%s options start with none, have unique ids, and a label and glyph each", (_name, options) => {
        expect(options[0].id).toBe("none");
        expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
        for (const option of options) {
            expect(option.label).not.toBe("");
            expect(option.emoji).not.toBe("");
        }
    });

    it("lists every documented filter", () => {
        expect(BACKGROUND_OPTIONS.map((o) => o.id)).toEqual(["none", "blur", "image"]);
        expect(EFFECT_OPTIONS.map((o) => o.id)).toEqual(["none", "bw", "sepia", "night-vision", "pixelate"]);
        expect(ACCESSORY_OPTIONS.map((o) => o.id)).toEqual(["none", "sunglasses", "cat-ears", "party-hat", "crown", "mustache"]);
    });
});

describe("filtersActive / needsSegmentation / needsFace", () => {
    it("NO_FILTERS is entirely off", () => {
        expect(NO_FILTERS).toEqual({ background: "none", effect: "none", accessory: "none" });
        expect(filtersActive(NO_FILTERS)).toBe(false);
        expect(needsSegmentation(NO_FILTERS)).toBe(false);
        expect(needsFace(NO_FILTERS)).toBe(false);
    });

    it("is active when any single layer is on", () => {
        expect(filtersActive({ ...NO_FILTERS, background: "blur" })).toBe(true);
        expect(filtersActive({ ...NO_FILTERS, effect: "sepia" })).toBe(true);
        expect(filtersActive({ ...NO_FILTERS, accessory: "crown" })).toBe(true);
    });

    it("needs segmentation only for a background", () => {
        expect(needsSegmentation({ ...NO_FILTERS, background: "blur" })).toBe(true);
        expect(needsSegmentation({ ...NO_FILTERS, background: "image" })).toBe(true);
        expect(needsSegmentation({ ...NO_FILTERS, effect: "bw", accessory: "crown" })).toBe(false);
    });

    it("needs the face model only for an accessory", () => {
        expect(needsFace({ ...NO_FILTERS, accessory: "mustache" })).toBe(true);
        expect(needsFace({ ...NO_FILTERS, background: "blur", effect: "bw" })).toBe(false);
    });
});

describe("sanitizeFilters", () => {
    it("keeps valid filters", () => {
        const filters = { background: "image", effect: "night-vision", accessory: "party-hat" } as const;
        expect(sanitizeFilters(filters)).toEqual(filters);
    });

    it("returns a copy, not the same object", () => {
        const filters = { background: "blur", effect: "none", accessory: "none" } as const;
        expect(sanitizeFilters(filters)).not.toBe(filters);
    });

    it("falls back to none for unknown ids, keeping the valid fields", () => {
        expect(sanitizeFilters({ background: "hologram", effect: "bw", accessory: "monocle" })).toEqual({
            background: "none",
            effect: "bw",
            accessory: "none",
        });
    });

    it("falls back to none for non-string values", () => {
        expect(sanitizeFilters({ background: 3, effect: null, accessory: {} })).toEqual(NO_FILTERS);
    });

    it("fills in missing fields", () => {
        expect(sanitizeFilters({ effect: "sepia" })).toEqual({ background: "none", effect: "sepia", accessory: "none" });
    });

    it.each([[undefined], [null], ["blur"], [42], [true]])("treats %s as no filters", (value) => {
        expect(sanitizeFilters(value)).toEqual(NO_FILTERS);
    });

    it("treats an array as an object with none of the fields", () => {
        expect(sanitizeFilters(["blur"])).toEqual(NO_FILTERS);
    });
});
