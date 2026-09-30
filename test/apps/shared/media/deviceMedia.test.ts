///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    classifyMediaError,
    defaultMediaDevices,
    isMediaDevicesSupported,
    listDevices,
    notFoundError,
    requestDisplayMedia,
    requestUserMedia,
    stopStream,
} from "../../../../apps/shared/media/deviceMedia.js";

function track(kind: "audio" | "video"): MediaStreamTrack {
    return { kind, enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
}

function stream(tracks: MediaStreamTrack[]): MediaStream {
    return {
        getTracks: () => tracks,
        getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
        getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    } as unknown as MediaStream;
}

describe("defaultMediaDevices", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns undefined when there is no mediaDevices on the (Node 24+) global navigator", () => {
        // This test file runs under vitest's plain `node` environment (no `// @vitest-environment jsdom` docblock)
        // - Node itself (>=21) already provides a global `navigator` with no `mediaDevices` at all.
        expect(defaultMediaDevices()).toBeUndefined();
    });

    it("also returns undefined where `navigator` itself does not exist at all (an older runtime)", () => {
        vi.stubGlobal("navigator", undefined);
        expect(defaultMediaDevices()).toBeUndefined();
    });
});

describe("isMediaDevicesSupported", () => {
    it("is false with no devices object, and false without a getUserMedia function", () => {
        expect(isMediaDevicesSupported(undefined)).toBe(false);
        expect(isMediaDevicesSupported({})).toBe(false);
    });

    it("is true once getUserMedia is present", () => {
        expect(isMediaDevicesSupported({ getUserMedia: vi.fn() })).toBe(true);
    });
});

describe("classifyMediaError", () => {
    it.each([
        ["NotAllowedError", "permission-denied"],
        ["SecurityError", "permission-denied"],
        ["NotFoundError", "not-found"],
        ["OverconstrainedError", "not-found"],
        ["AbortError", "unknown"],
    ] as const)("maps %s to %s", (name, kind) => {
        const err = new Error("boom");
        err.name = name;
        expect(classifyMediaError(err).kind).toBe(kind);
    });

    it("maps a non-Error rejection to unknown", () => {
        expect(classifyMediaError("nope").kind).toBe("unknown");
    });

    describe("not-found message, by what was actually requested", () => {
        function notFound(): Error {
            const err = new Error("boom");
            err.name = "NotFoundError";
            return err;
        }

        it("names just the microphone when only audio was requested", () => {
            expect(classifyMediaError(notFound(), { audio: true })).toEqual({ kind: "not-found", message: "No microphone was found on this device." });
        });

        it("names just the camera when only video was requested", () => {
            expect(classifyMediaError(notFound(), { video: { facingMode: "user" } })).toEqual({
                kind: "not-found",
                message: "No camera was found on this device.",
            });
        });

        it("names both when both were requested", () => {
            expect(classifyMediaError(notFound(), { audio: true, video: true })).toEqual({
                kind: "not-found",
                message: "No camera or microphone was found on this device.",
            });
        });

        it("names both when the caller doesn't say what it asked for (listDevices/requestDisplayMedia)", () => {
            expect(classifyMediaError(notFound())).toEqual({ kind: "not-found", message: "No camera or microphone was found on this device." });
        });

        it("falls back to naming both when neither was actually truthy in the constraints", () => {
            expect(classifyMediaError(notFound(), { audio: false, video: false })).toEqual({
                kind: "not-found",
                message: "No camera or microphone was found on this device.",
            });
        });
    });
});

describe("notFoundError", () => {
    it("names just the microphone, just the camera, or both", () => {
        expect(notFoundError(true, false)).toEqual({ kind: "not-found", message: "No microphone was found on this device." });
        expect(notFoundError(false, true)).toEqual({ kind: "not-found", message: "No camera was found on this device." });
        expect(notFoundError(true, true)).toEqual({ kind: "not-found", message: "No camera or microphone was found on this device." });
    });
});

describe("listDevices", () => {
    it("is unsupported without enumerateDevices", async () => {
        const result = await listDevices({});
        expect(result).toEqual({ ok: false, error: { kind: "unsupported", message: expect.any(String) } });
    });

    it("splits the result into cameras and microphones", async () => {
        const cam = { kind: "videoinput" } as MediaDeviceInfo;
        const mic = { kind: "audioinput" } as MediaDeviceInfo;
        const out = { kind: "audiooutput" } as MediaDeviceInfo;
        const result = await listDevices({ enumerateDevices: async () => [cam, mic, out] });
        expect(result).toEqual({ ok: true, value: { cameras: [cam], microphones: [mic] } });
    });

    it("classifies a rejected enumerateDevices call", async () => {
        const err = new Error("nope");
        err.name = "NotAllowedError";
        const result = await listDevices({ enumerateDevices: async () => Promise.reject(err) });
        expect(result).toEqual({ ok: false, error: { kind: "permission-denied", message: expect.any(String) } });
    });
});

describe("requestUserMedia", () => {
    it("is unsupported without getUserMedia", async () => {
        const result = await requestUserMedia({ video: true }, {});
        expect(result.ok).toBe(false);
    });

    it("resolves the stream on success", async () => {
        const fakeStream = stream([track("audio")]);
        const result = await requestUserMedia({ audio: true }, { getUserMedia: async () => fakeStream });
        expect(result).toEqual({ ok: true, value: fakeStream });
    });

    it("classifies a rejected call, naming the device it actually asked for", async () => {
        const err = new Error("nope");
        err.name = "NotFoundError";
        const result = await requestUserMedia({ video: true }, { getUserMedia: async () => Promise.reject(err) });
        expect(result).toEqual({ ok: false, error: { kind: "not-found", message: "No camera was found on this device." } });
    });
});

describe("requestDisplayMedia", () => {
    it("is unsupported without getDisplayMedia", async () => {
        const result = await requestDisplayMedia({});
        expect(result.ok).toBe(false);
    });

    it("resolves the stream on success, requesting video only", async () => {
        const fakeStream = stream([track("video")]);
        const getDisplayMedia = vi.fn(async () => fakeStream);
        const result = await requestDisplayMedia({ getDisplayMedia });
        expect(result).toEqual({ ok: true, value: fakeStream });
        expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    });

    it("classifies a rejected call (e.g. the user cancelled the picker)", async () => {
        const err = new Error("cancelled");
        err.name = "NotAllowedError";
        const result = await requestDisplayMedia({ getDisplayMedia: async () => Promise.reject(err) });
        expect(result).toEqual({ ok: false, error: { kind: "permission-denied", message: expect.any(String) } });
    });
});

describe("stopStream", () => {
    it("stops every track", () => {
        const a = track("audio");
        const v = track("video");
        stopStream(stream([a, v]));
        expect(a.stop).toHaveBeenCalledTimes(1);
        expect(v.stop).toHaveBeenCalledTimes(1);
    });

    it("tolerates undefined/null", () => {
        expect(() => stopStream(undefined)).not.toThrow();
        expect(() => stopStream(null)).not.toThrow();
    });
});
