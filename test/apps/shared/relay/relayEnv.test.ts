// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectRelayEnv, REQUIRED_GLOBALS } from "../../../../apps/shared/relay/relayEnv.js";

/** Every constructor `detectRelayEnv()` uses, replaced by a class that just records what it was built with. */
class Recorded {
    static instances: Recorded[] = [];
    readonly args: unknown[];
    constructor(...args: unknown[]) {
        this.args = args;
        Recorded.instances.push(this);
    }
}

function stubBrowser(): void {
    for (const name of REQUIRED_GLOBALS) {
        if (name === "document" || name === "HTMLCanvasElement") {
            continue;
        }
        vi.stubGlobal(name, class extends Recorded {});
    }
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", { value: () => undefined, configurable: true });
}

beforeEach(() => {
    Recorded.instances = [];
});

afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
    vi.useRealTimers();
});

describe("detectRelayEnv", () => {
    it("returns undefined in a browser that has none of it (jsdom)", () => {
        expect(detectRelayEnv()).toBeUndefined();
    });

    it("returns an environment when everything is present", () => {
        stubBrowser();
        expect(detectRelayEnv()).toBeDefined();
    });

    it.each(REQUIRED_GLOBALS)("returns undefined when %s is missing", (name) => {
        stubBrowser();
        vi.stubGlobal(name, undefined);
        expect(detectRelayEnv()).toBeUndefined();
    });

    it("returns undefined when canvas.captureStream is missing", () => {
        stubBrowser();
        Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
        expect(detectRelayEnv()).toBeUndefined();
    });

    it("builds every browser object from the current globals", () => {
        stubBrowser();
        const env = detectRelayEnv();
        expect(env).toBeDefined();
        const e = env as NonNullable<typeof env>;
        const created = [
            e.createSocket("wss://x/relay"),
            e.createAudioContext(48_000),
            e.createMediaStream([]),
            e.createAudioEncoder({ output: () => undefined, error: () => undefined }),
            e.createAudioDecoder({ output: () => undefined, error: () => undefined }),
            e.createVideoEncoder({ output: () => undefined, error: () => undefined }),
            e.createVideoDecoder({ output: () => undefined, error: () => undefined }),
            e.createAudioData({ format: "f32-planar", sampleRate: 48_000, numberOfFrames: 1, numberOfChannels: 1, timestamp: 0, data: new Float32Array(1) }),
            e.createEncodedAudioChunk({ type: "key", timestamp: 1, data: new Uint8Array(1) }),
            e.createEncodedVideoChunk({ type: "delta", timestamp: 2, data: new Uint8Array(1) }),
        ] as unknown as Recorded[];
        expect(created.every((c) => c instanceof Recorded)).toBe(true);
        expect(created[0].args).toEqual(["wss://x/relay"]);
        expect(created[1].args).toEqual([{ sampleRate: 48_000 }]);
        expect(created[2].args).toEqual([[]]);
        expect(created[7].args[0]).toMatchObject({ format: "f32-planar", sampleRate: 48_000 });
        expect(created[8].args[0]).toMatchObject({ type: "key", timestamp: 1 });
        expect(created[9].args[0]).toMatchObject({ type: "delta", timestamp: 2 });

        const canvas = e.createCanvas();
        const frame = e.createVideoFrame(canvas, 5000) as unknown as Recorded;
        expect(frame.args).toEqual([canvas, { timestamp: 5000 }]);
    });

    it("builds real hidden elements and exposes the page's document, clock, timers and random", () => {
        stubBrowser();
        const e = detectRelayEnv() as NonNullable<ReturnType<typeof detectRelayEnv>>;
        expect(e.createVideoElement()).toBeInstanceOf(HTMLVideoElement);
        expect(e.createCanvas()).toBeInstanceOf(HTMLCanvasElement);
        expect(e.document).toBe(document);
        expect(typeof e.now()).toBe("number");
        const r = e.random();
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(1);

        vi.useFakeTimers();
        const callback = vi.fn();
        const handle = e.setInterval(callback, 100);
        vi.advanceTimersByTime(250);
        expect(callback).toHaveBeenCalledTimes(2);
        e.clearInterval(handle);
        vi.advanceTimersByTime(250);
        expect(callback).toHaveBeenCalledTimes(2);
    });
});
