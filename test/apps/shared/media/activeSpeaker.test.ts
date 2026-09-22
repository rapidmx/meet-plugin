///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_SPEAKER_THRESHOLD, pickActiveSpeaker } from "../../../../apps/shared/media/activeSpeaker.js";

describe("pickActiveSpeaker", () => {
    it("picks the loudest participant above threshold", () => {
        expect(pickActiveSpeaker({ a: 5, b: 40, c: 20 }, undefined)).toBe("b");
    });

    it("keeps the current pick when nobody is above threshold", () => {
        expect(pickActiveSpeaker({ a: 2, b: 3 }, "a")).toBe("a");
    });

    it("returns undefined when nobody is above threshold and there is no current pick", () => {
        expect(pickActiveSpeaker({ a: 2, b: 3 }, undefined)).toBeUndefined();
    });

    it("drops the current pick once they're no longer a measured participant", () => {
        expect(pickActiveSpeaker({ b: 3 }, "a")).toBeUndefined();
    });

    it("breaks an exact tie in favor of the current speaker", () => {
        expect(pickActiveSpeaker({ a: 50, b: 50 }, "b")).toBe("b");
    });

    it("picks a new leader when a later entry strictly exceeds the current best", () => {
        expect(pickActiveSpeaker({ a: 50, b: 60 }, undefined)).toBe("b");
    });

    it("respects a custom threshold", () => {
        expect(pickActiveSpeaker({ a: 30 }, undefined, 50)).toBeUndefined();
        expect(pickActiveSpeaker({ a: 60 }, undefined, 50)).toBe("a");
    });

    it("exposes a documented default threshold", () => {
        expect(DEFAULT_ACTIVE_SPEAKER_THRESHOLD).toBeGreaterThan(0);
    });

    it("handles an empty levels map", () => {
        expect(pickActiveSpeaker({}, undefined)).toBeUndefined();
        expect(pickActiveSpeaker({}, "a")).toBeUndefined();
    });
});
