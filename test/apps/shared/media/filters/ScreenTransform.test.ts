///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    NO_SCREEN_TRANSFORM,
    ScreenTransformProcessor,
    rotateClockwise,
    type ScreenTransformState,
} from "../../../../../apps/shared/media/filters/ScreenTransform.js";
import { fakeTrack, installFakeMediaStream } from "../../../testUtils.js";

/** One op recorded against the fake 2D context, as `[method, ...args]`. `"set width"`/`"set height"` record a
 * canvas resize (distinct from a draw op) so a test can tell "the canvas didn't need resizing this frame" apart
 * from "it did." */
type Op = [string, ...unknown[]];

function fakeContext(ops: Op[]) {
    return {
        save: vi.fn(() => ops.push(["save"])),
        restore: vi.fn(() => ops.push(["restore"])),
        translate: vi.fn((x: number, y: number) => ops.push(["translate", x, y])),
        rotate: vi.fn((angle: number) => ops.push(["rotate", angle])),
        scale: vi.fn((x: number, y: number) => ops.push(["scale", x, y])),
        drawImage: vi.fn((...args: unknown[]) => ops.push(["drawImage", ...args])),
    };
}

function fakeCanvas(ops: Op[], options: { nullContext?: boolean } = {}) {
    let width = 0;
    let height = 0;
    const ctx = fakeContext(ops);
    const track = fakeTrack("video");
    return {
        ctx,
        track,
        get width() {
            return width;
        },
        set width(value: number) {
            width = value;
            ops.push(["set width", value]);
        },
        get height() {
            return height;
        },
        set height(value: number) {
            height = value;
            ops.push(["set height", value]);
        },
        getContext: vi.fn(() => (options.nullContext ? null : ctx)),
        captureStream: vi.fn((frameRate: number) => {
            ops.push(["captureStream", frameRate]);
            return { getVideoTracks: () => [track] };
        }),
    };
}

function fakeVideo(width = 640, height = 480) {
    return {
        readyState: 4,
        videoWidth: width,
        videoHeight: height,
        muted: false,
        playsInline: false,
        srcObject: undefined as unknown,
        play: vi.fn(async () => undefined),
        pause: vi.fn(),
    };
}

/** Frame rate used by most tests: a 100 ms interval, so `frames(n)` is exactly n ticks. */
const FRAME_RATE = 10;
const INTERVAL = 100;

function harness(options: { state?: ScreenTransformState; playRejects?: boolean; nullContext?: boolean } = {}) {
    const ops: Op[] = [];
    const canvas = fakeCanvas(ops, { nullContext: options.nullContext });
    const video = fakeVideo();
    if (options.playRejects) {
        video.play = vi.fn(async () => Promise.reject(new Error("NotAllowedError")));
    }
    const source = fakeTrack("video", "screen");
    const processor = new ScreenTransformProcessor({
        source,
        state: options.state,
        frameRate: FRAME_RATE,
        deps: { createCanvas: () => canvas as unknown as HTMLCanvasElement, createVideo: () => video as unknown as HTMLVideoElement, now: () => 0 },
    });
    // The constructor ticks once synchronously, same as `VideoFilterProcessor`'s - harmless in a real browser
    // (`readyState` starts at 0, well before `srcObject` has a frame to draw), but this harness's fake video
    // defaults to "ready" for every other test's convenience, so that first draw (and its resize, if the given
    // `state` calls for one) already happened by the time this returns - cleared here so it doesn't leak into
    // assertions about ticks driven by `frames()`, which is why those never see an initial "set width"/"set height"
    // even on the very first frame they cause.
    ops.length = 0;
    return {
        ops,
        canvas,
        video,
        source,
        processor,
        frames(n = 1) {
            for (let i = 0; i < n; i++) {
                vi.advanceTimersByTime(INTERVAL);
            }
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    installFakeMediaStream();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("rotateClockwise", () => {
    it("steps 0 -> 90 -> 180 -> 270 -> 0, leaving flipped untouched", () => {
        let state: ScreenTransformState = { rotation: 0, flipped: true };
        for (const expected of [90, 180, 270, 0] as const) {
            state = rotateClockwise(state);
            expect(state).toEqual({ rotation: expected, flipped: true });
        }
    });
});

describe("construction", () => {
    it("captures the canvas at the given frame rate and exposes its track", () => {
        const h = harness();
        expect(h.canvas.captureStream).toHaveBeenCalledWith(FRAME_RATE);
        expect(h.processor.track).toBe(h.canvas.track);
    });

    it("plays a muted, inline video of the source track", () => {
        const h = harness();
        expect(h.video.muted).toBe(true);
        expect(h.video.playsInline).toBe(true);
        expect(h.video.play).toHaveBeenCalledTimes(1);
    });

    it("throws when this browser can't give it a 2D context", () => {
        expect(() => harness({ nullContext: true })).toThrow(/can't rotate/);
    });

    it("swallows a rejected play() rather than throwing", () => {
        expect(() => harness({ playRejects: true })).not.toThrow();
    });
});

describe("drawing", () => {
    it("skips a tick while the video has no frame yet", () => {
        const h = harness();
        h.video.readyState = 1;
        h.frames();
        expect(h.ops).toEqual([]);
        h.video.readyState = 4;
        h.video.videoWidth = 0;
        h.frames();
        expect(h.ops).toEqual([]);
    });

    it("draws untransformed, matching the source size, with no save/rotate at all", () => {
        const h = harness();
        h.frames();
        expect(h.canvas.width).toBe(640);
        expect(h.canvas.height).toBe(480);
        expect(h.ops.filter((op) => op[0] !== "set width" && op[0] !== "set height")).toEqual([["drawImage", h.video, 0, 0, 640, 480]]);
    });

    it("doesn't resize the canvas again once it already matches", () => {
        // The constructor's own first tick already sized the canvas correctly (cleared by harness(), see its doc
        // comment) - none of these three further ticks should touch it again.
        const h = harness();
        h.frames(3);
        expect(h.ops.filter((op) => op[0] === "set width" || op[0] === "set height")).toEqual([]);
        expect(h.ops.filter((op) => op[0] === "drawImage")).toHaveLength(3);
    });

    it("rotates 90 and 270 with the canvas swapped to match, translating to its new center", () => {
        // The constructor's own first tick already resized the canvas to fit this rotation (see harness()'s doc
        // comment), so a later, ordinary tick's ops start straight from the draw - a resize is covered separately
        // by "doesn't resize the canvas again once it already matches".
        const h = harness({ state: { rotation: 90, flipped: false } });
        h.frames();
        expect(h.canvas.width).toBe(480);
        expect(h.canvas.height).toBe(640);
        expect(h.ops).toEqual([["save"], ["translate", 240, 320], ["rotate", Math.PI / 2], ["drawImage", h.video, -320, -240, 640, 480], ["restore"]]);

        const h270 = harness({ state: { rotation: 270, flipped: false } });
        h270.frames();
        expect(h270.canvas.width).toBe(480);
        expect(h270.canvas.height).toBe(640);
        expect(h270.ops.find((op) => op[0] === "rotate")).toEqual(["rotate", (270 * Math.PI) / 180]);
    });

    it("rotates 180 without swapping the canvas", () => {
        const h = harness({ state: { rotation: 180, flipped: false } });
        h.frames();
        expect(h.canvas.width).toBe(640);
        expect(h.canvas.height).toBe(480);
        expect(h.ops).toEqual([["save"], ["translate", 320, 240], ["rotate", Math.PI], ["drawImage", h.video, -320, -240, 640, 480], ["restore"]]);
    });

    it("flips with no rotation, through the transformed path (scale after an identity rotate)", () => {
        const h = harness({ state: { rotation: 0, flipped: true } });
        h.frames();
        expect(h.ops).toEqual([
            ["save"],
            ["translate", 320, 240],
            ["rotate", 0],
            ["scale", -1, 1],
            ["drawImage", h.video, -320, -240, 640, 480],
            ["restore"],
        ]);
    });

    it("changes what's drawn from the next tick after setState(), without interrupting playback", () => {
        const h = harness();
        h.frames();
        h.ops.length = 0;
        h.processor.setState({ rotation: 90, flipped: true });
        h.frames();
        expect(h.canvas.width).toBe(480);
        expect(h.ops.some((op) => op[0] === "scale")).toBe(true);
    });

    it("resizes the canvas when a later setState() actually changes the drawn size", () => {
        const h = harness(); // starts untransformed, 640x480 (resized invisibly during construction)
        h.ops.length = 0;
        h.processor.setState({ rotation: 90, flipped: false }); // now needs 480x640
        h.frames();
        expect(h.ops.filter((op) => op[0] === "set width" || op[0] === "set height")).toEqual([
            ["set width", 480],
            ["set height", 640],
        ]);
        expect(h.canvas.width).toBe(480);
        expect(h.canvas.height).toBe(640);
    });
});

describe("stop()", () => {
    it("guards against a tick that somehow still runs after it - a real but unreproducible-via-fake-timers race (the engine can already have queued a timer's callback before clearTimeout() reaches it)", () => {
        const h = harness();
        h.processor.stop();
        h.ops.length = 0;
        expect(() => (h.processor as unknown as { tick: () => void }).tick()).not.toThrow();
        expect(h.ops).toEqual([]);
    });

    it("clears the timer, pauses and releases the video, and stops the track", () => {
        const h = harness();
        h.frames();
        const drawsBefore = h.ops.filter((op) => op[0] === "drawImage").length;
        h.processor.stop();
        expect(h.video.pause).toHaveBeenCalledTimes(1);
        expect(h.video.srcObject).toBeNull();
        expect(h.canvas.track.stop).toHaveBeenCalledTimes(1);
        h.frames(3);
        expect(h.ops.filter((op) => op[0] === "drawImage")).toHaveLength(drawsBefore);
    });
});

describe("default dependencies", () => {
    it("creates a real canvas and video element and reads the real clock", () => {
        const ops: Op[] = [];
        const ctx = fakeContext(ops);
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
        const track = fakeTrack("video");
        Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
            configurable: true,
            writable: true,
            value: vi.fn(() => ({ getVideoTracks: () => [track] })),
        });
        const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
        const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
        const now = vi.spyOn(performance, "now");

        try {
            const processor = new ScreenTransformProcessor({ source: fakeTrack("video"), frameRate: FRAME_RATE });
            expect(processor.track).toBe(track);
            vi.advanceTimersByTime(INTERVAL);
            expect(now).toHaveBeenCalled();
            processor.stop();
            expect(pause).toHaveBeenCalled();
        } finally {
            getContext.mockRestore();
            play.mockRestore();
            pause.mockRestore();
            now.mockRestore();
            Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
        }
    });
});

describe("NO_SCREEN_TRANSFORM", () => {
    it("is the identity - no rotation, not flipped", () => {
        expect(NO_SCREEN_TRANSFORM).toEqual({ rotation: 0, flipped: false });
    });
});
