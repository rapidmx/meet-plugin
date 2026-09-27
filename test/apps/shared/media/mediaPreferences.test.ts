///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BACKGROUND_KEY,
    PREFERENCES_KEY,
    defaultStorage,
    loadPreferences,
    savePreferences,
} from "../../../../apps/shared/media/mediaPreferences.js";

/** An in-memory `Storage`, with hooks to make individual operations throw. */
class FakeStorage implements Storage {
    readonly data = new Map<string, string>();
    failOn = new Set<"getItem" | "setItem" | "removeItem">();
    /** Keys whose `setItem` throws (a quota error for just the big value). */
    failSetKeys = new Set<string>();

    get length(): number {
        return this.data.size;
    }
    key(index: number): string | null {
        return [...this.data.keys()][index] ?? null;
    }
    getItem(key: string): string | null {
        if (this.failOn.has("getItem")) throw new Error("getItem blocked");
        return this.data.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        if (this.failOn.has("setItem") || this.failSetKeys.has(key)) throw new DOMException("quota", "QuotaExceededError");
        this.data.set(key, value);
    }
    removeItem(key: string): void {
        if (this.failOn.has("removeItem")) throw new Error("removeItem blocked");
        this.data.delete(key);
    }
    clear(): void {
        this.data.clear();
    }
    [name: string]: unknown;
}

const IMAGE = "data:image/jpeg;base64,AAAA";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("loadPreferences", () => {
    it("returns nothing when there is no storage", () => {
        expect(loadPreferences(undefined)).toEqual({});
    });

    it("returns every field undefined when nothing was saved", () => {
        const prefs = loadPreferences(new FakeStorage());
        expect(prefs).toEqual({
            cameraId: undefined,
            microphoneId: undefined,
            micEnabled: undefined,
            cameraEnabled: undefined,
            filters: undefined,
            backgroundImage: undefined,
        });
    });

    it("round trips everything through savePreferences", () => {
        const storage = new FakeStorage();
        savePreferences(
            {
                cameraId: "cam-1",
                microphoneId: "mic-1",
                micEnabled: false,
                cameraEnabled: true,
                filters: { background: "image", effect: "sepia", accessory: "crown" },
                backgroundImage: IMAGE,
            },
            storage,
        );
        expect(loadPreferences(storage)).toEqual({
            cameraId: "cam-1",
            microphoneId: "mic-1",
            micEnabled: false,
            cameraEnabled: true,
            filters: { background: "image", effect: "sepia", accessory: "crown" },
            backgroundImage: IMAGE,
        });
    });

    it("keeps the background image under its own key, not in the preferences", () => {
        const storage = new FakeStorage();
        savePreferences({ cameraId: "cam", backgroundImage: IMAGE }, storage);
        expect(storage.data.get(BACKGROUND_KEY)).toBe(IMAGE);
        expect(JSON.parse(storage.data.get(PREFERENCES_KEY)!)).toEqual({ cameraId: "cam" });
    });

    it("drops values of the wrong type", () => {
        const storage = new FakeStorage();
        storage.data.set(
            PREFERENCES_KEY,
            JSON.stringify({ cameraId: 7, microphoneId: "", micEnabled: "yes", cameraEnabled: 1 }),
        );
        expect(loadPreferences(storage)).toEqual({
            cameraId: undefined,
            microphoneId: undefined,
            micEnabled: undefined,
            cameraEnabled: undefined,
            filters: undefined,
            backgroundImage: undefined,
        });
    });

    it("keeps non-empty strings and both booleans", () => {
        const storage = new FakeStorage();
        storage.data.set(PREFERENCES_KEY, JSON.stringify({ cameraId: "c", micEnabled: false, cameraEnabled: true }));
        const prefs = loadPreferences(storage);
        expect(prefs.cameraId).toBe("c");
        expect(prefs.micEnabled).toBe(false);
        expect(prefs.cameraEnabled).toBe(true);
    });

    it("sanitises unknown filter ids and junk filter values", () => {
        const storage = new FakeStorage();
        storage.data.set(PREFERENCES_KEY, JSON.stringify({ filters: { background: "blur", effect: "vhs", accessory: 5 } }));
        expect(loadPreferences(storage).filters).toEqual({ background: "blur", effect: "none", accessory: "none" });

        storage.data.set(PREFERENCES_KEY, JSON.stringify({ filters: "blur" }));
        expect(loadPreferences(storage).filters).toEqual({ background: "none", effect: "none", accessory: "none" });

        storage.data.set(PREFERENCES_KEY, JSON.stringify({ filters: null }));
        expect(loadPreferences(storage).filters).toEqual({ background: "none", effect: "none", accessory: "none" });
    });

    it.each([["{not json"], ["[1, 2]"], ["null"], ['"text"'], ["42"]])("treats %s as nothing saved", (stored) => {
        const storage = new FakeStorage();
        storage.data.set(PREFERENCES_KEY, stored);
        expect(loadPreferences(storage).cameraId).toBeUndefined();
        expect(loadPreferences(storage).filters).toBeUndefined();
    });

    it("only accepts a background image that is a data:image/ url", () => {
        const storage = new FakeStorage();
        storage.data.set(BACKGROUND_KEY, "https://evil.example.com/x.png");
        expect(loadPreferences(storage).backgroundImage).toBeUndefined();
        storage.data.set(BACKGROUND_KEY, "data:text/html,<script>");
        expect(loadPreferences(storage).backgroundImage).toBeUndefined();
        storage.data.set(BACKGROUND_KEY, IMAGE);
        expect(loadPreferences(storage).backgroundImage).toBe(IMAGE);
    });

    it("survives a storage whose getItem throws", () => {
        const storage = new FakeStorage();
        storage.failOn.add("getItem");
        expect(() => loadPreferences(storage)).not.toThrow();
        expect(loadPreferences(storage).backgroundImage).toBeUndefined();
        expect(loadPreferences(storage).cameraId).toBeUndefined();
    });

    it("still returns the settings when only the background image can't be read", () => {
        const storage = new FakeStorage();
        storage.data.set(PREFERENCES_KEY, JSON.stringify({ cameraId: "cam" }));
        const getItem = storage.getItem.bind(storage);
        storage.getItem = (key: string) => {
            if (key === BACKGROUND_KEY) throw new Error("blocked");
            return getItem(key);
        };
        expect(loadPreferences(storage)).toMatchObject({ cameraId: "cam", backgroundImage: undefined });
    });
});

describe("savePreferences", () => {
    it("does nothing without storage", () => {
        expect(() => savePreferences({ cameraId: "cam" }, undefined)).not.toThrow();
    });

    it("merges a patch into what is already saved", () => {
        const storage = new FakeStorage();
        savePreferences({ cameraId: "cam", micEnabled: true }, storage);
        savePreferences({ micEnabled: false, microphoneId: "mic" }, storage);
        expect(JSON.parse(storage.data.get(PREFERENCES_KEY)!)).toEqual({ cameraId: "cam", micEnabled: false, microphoneId: "mic" });
    });

    it("forgets a key patched to undefined", () => {
        const storage = new FakeStorage();
        savePreferences({ cameraId: "cam", microphoneId: "mic" }, storage);
        savePreferences({ cameraId: undefined }, storage);
        expect(loadPreferences(storage)).toMatchObject({ cameraId: undefined, microphoneId: "mic" });
        // JSON.stringify drops it entirely.
        expect(JSON.parse(storage.data.get(PREFERENCES_KEY)!)).toEqual({ microphoneId: "mic" });
    });

    it("builds on top of corrupt stored JSON instead of failing", () => {
        const storage = new FakeStorage();
        storage.data.set(PREFERENCES_KEY, "{oops");
        savePreferences({ cameraId: "cam" }, storage);
        expect(JSON.parse(storage.data.get(PREFERENCES_KEY)!)).toEqual({ cameraId: "cam" });
    });

    it("writes nothing to the preferences key for a patch that only carries the background image", () => {
        const storage = new FakeStorage();
        savePreferences({ backgroundImage: IMAGE }, storage);
        expect(storage.data.has(PREFERENCES_KEY)).toBe(false);
        expect(storage.data.get(BACKGROUND_KEY)).toBe(IMAGE);
    });

    it("writes nothing at all for an empty patch", () => {
        const storage = new FakeStorage();
        savePreferences({}, storage);
        expect(storage.data.size).toBe(0);
    });

    it("removes the background image when it is patched to undefined", () => {
        const storage = new FakeStorage();
        savePreferences({ backgroundImage: IMAGE, cameraId: "cam" }, storage);
        savePreferences({ backgroundImage: undefined }, storage);
        expect(storage.data.has(BACKGROUND_KEY)).toBe(false);
        expect(loadPreferences(storage)).toMatchObject({ cameraId: "cam", backgroundImage: undefined });
    });

    it("leaves the background image alone when the patch does not mention it", () => {
        const storage = new FakeStorage();
        savePreferences({ backgroundImage: IMAGE }, storage);
        savePreferences({ cameraId: "cam" }, storage);
        expect(storage.data.get(BACKGROUND_KEY)).toBe(IMAGE);
    });

    it("ignores a storage that throws on every write", () => {
        const storage = new FakeStorage();
        storage.failOn.add("setItem");
        expect(() => savePreferences({ cameraId: "cam", backgroundImage: IMAGE }, storage)).not.toThrow();
        expect(storage.data.size).toBe(0);
    });

    it("ignores a storage that throws on read while merging", () => {
        const storage = new FakeStorage();
        storage.failOn.add("getItem");
        expect(() => savePreferences({ cameraId: "cam" }, storage)).not.toThrow();
        // Nothing to merge with was readable, so the patch alone is written.
        expect(JSON.parse(storage.data.get(PREFERENCES_KEY)!)).toEqual({ cameraId: "cam" });
    });

    it("ignores a storage that throws on removeItem", () => {
        const storage = new FakeStorage();
        storage.failOn.add("removeItem");
        expect(() => savePreferences({ backgroundImage: undefined }, storage)).not.toThrow();
    });

    it("does not lose the other settings when the image is too big to store", () => {
        const storage = new FakeStorage();
        storage.failSetKeys.add(BACKGROUND_KEY);
        expect(() =>
            savePreferences({ cameraId: "cam", filters: { background: "image", effect: "none", accessory: "none" }, backgroundImage: IMAGE }, storage),
        ).not.toThrow();
        expect(loadPreferences(storage)).toEqual({
            cameraId: "cam",
            microphoneId: undefined,
            micEnabled: undefined,
            cameraEnabled: undefined,
            filters: { background: "image", effect: "none", accessory: "none" },
            backgroundImage: undefined,
        });
    });

    it("does not lose the image when only the settings can't be stored", () => {
        const storage = new FakeStorage();
        storage.failSetKeys.add(PREFERENCES_KEY);
        savePreferences({ cameraId: "cam", backgroundImage: IMAGE }, storage);
        expect(storage.data.get(BACKGROUND_KEY)).toBe(IMAGE);
        expect(storage.data.has(PREFERENCES_KEY)).toBe(false);
    });
});

describe("defaultStorage", () => {
    it("is jsdom's localStorage", () => {
        expect(defaultStorage()).toBe(window.localStorage);
    });

    it("is undefined when reading localStorage throws", () => {
        vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
            throw new DOMException("blocked", "SecurityError");
        });
        expect(defaultStorage()).toBeUndefined();
    });

    it("is undefined when there is no localStorage at all", () => {
        vi.stubGlobal("localStorage", undefined);
        try {
            expect(defaultStorage()).toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("with jsdom's real localStorage", () => {
    it("uses it when no storage is passed, and round trips", () => {
        savePreferences({ cameraId: "real-cam", micEnabled: true, backgroundImage: IMAGE });
        expect(window.localStorage.getItem(BACKGROUND_KEY)).toBe(IMAGE);
        expect(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY)!)).toEqual({ cameraId: "real-cam", micEnabled: true });
        expect(loadPreferences()).toMatchObject({ cameraId: "real-cam", micEnabled: true, backgroundImage: IMAGE });

        savePreferences({ backgroundImage: undefined, cameraId: undefined });
        expect(window.localStorage.getItem(BACKGROUND_KEY)).toBeNull();
        expect(loadPreferences()).toMatchObject({ cameraId: undefined, micEnabled: true, backgroundImage: undefined });
    });

    it("is a no-op when localStorage is blocked", () => {
        vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
            throw new DOMException("blocked", "SecurityError");
        });
        expect(() => savePreferences({ cameraId: "cam" })).not.toThrow();
        expect(Object.values(loadPreferences()).every((v) => v === undefined)).toBe(true);
    });

    it("tolerates a quota error from the real Storage", () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });
        expect(() => savePreferences({ cameraId: "cam", backgroundImage: IMAGE })).not.toThrow();
    });
});
