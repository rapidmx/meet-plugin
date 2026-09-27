///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type VideoFilters } from "../../../../../apps/shared/media/filters/filterTypes.js";
import type { FaceLandmark } from "../../../../../apps/shared/media/filters/accessories.js";
import type { FaceTracker, PersonMask, PersonSegmenter } from "../../../../../apps/shared/media/filters/mlModels.js";
import {
    type BackgroundPicture,
    type FilterStatus,
    VideoFilterProcessor,
    type VideoFilterProcessorOptions,
} from "../../../../../apps/shared/media/filters/VideoFilterProcessor.js";
import { fakeTrack, installFakeMediaStream } from "../../../testUtils.js";

const SEGMENTATION_ERROR =
    "The background effect couldn't be loaded, so your background stays hidden. Turn the effect off to show your camera.";
const FACE_ERROR = "The face effect couldn't be loaded.";
const RENDER_ERROR = "Video effects stopped working.";

/** Frame rate used by most tests: a 100 ms interval, so `frames(n)` is exactly n ticks. */
const FRAME_RATE = 10;
const INTERVAL = 100;

const blur: VideoFilters = { ...NO_FILTERS, background: "blur" };
const image: VideoFilters = { ...NO_FILTERS, background: "image" };
const crown: VideoFilters = { ...NO_FILTERS, accessory: "crown" };

interface Call {
    /** Which fake canvas's context: `c0` is the processor's own canvas, the rest are its scratch layers in creation order. */
    target: string;
    op: string;
    args: unknown[];
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** A 478-point face mesh with the landmarks the accessories use: eyes 0.4/0.6 at y 0.4, forehead (0.5, 0.2). */
function faceMesh(count = 478): FaceLandmark[] {
    const landmarks = Array.from({ length: count }, () => ({ x: 0.5, y: 0.5 }));
    if (count > 263) {
        landmarks[33] = { x: 0.4, y: 0.4 };
        landmarks[263] = { x: 0.6, y: 0.4 };
        landmarks[10] = { x: 0.5, y: 0.2 };
        landmarks[1] = { x: 0.5, y: 0.5 };
        landmarks[0] = { x: 0.5, y: 0.6 };
    }
    return landmarks;
}

/** The whole fake browser one processor runs in - canvases, contexts, the video element and the models. */
function harness(
    options: Partial<Omit<VideoFilterProcessorOptions, "deps">> & {
        autoFrameRate?: boolean;
        playRejects?: boolean;
        /** Canvas ids (`c1`, ...) whose `getContext` returns null. */
        nullContexts?: string[];
        deps?: VideoFilterProcessorOptions["deps"];
    } = {},
) {
    const { autoFrameRate, playRejects, nullContexts, deps, ...rest } = options;
    const calls: Call[] = [];
    const canvases: any[] = [];
    const images: any[] = [];
    const h = {
        calls,
        canvases,
        images,
        clock: 0,
        clockStep: 0,
        /** What `getImageData` returns for every pixel. */
        pixel: [100, 150, 200, 255],
        drawImageThrows: false,
        nullContexts: new Set<string>(nullContexts),
        mask: null as PersonMask | null,
        face: null as FaceLandmark[] | null,
        track: fakeTrack("video"),
        source: fakeTrack("video", "camera"),
        video: {
            id: "video",
            readyState: 4,
            videoWidth: 640,
            videoHeight: 480,
            muted: false,
            playsInline: false,
            srcObject: undefined as unknown,
            play: vi.fn(async () => undefined),
            pause: vi.fn(),
        },
        segmenter: null as unknown as PersonSegmenter & { segment: ReturnType<typeof vi.fn> },
        faceTracker: null as unknown as FaceTracker & { detect: ReturnType<typeof vi.fn> },
        segmenterLoad: deferred<PersonSegmenter>(),
        faceLoad: deferred<FaceTracker>(),
        createSegmenter: null as unknown as ReturnType<typeof vi.fn>,
        createFaceTracker: null as unknown as ReturnType<typeof vi.fn>,
        onStatus: vi.fn<(status: FilterStatus) => void>(),
        processor: null as unknown as VideoFilterProcessor,
        /** Ops recorded against one canvas's context, as `[op, ...args]`. */
        ops(target: string): unknown[][] {
            return calls.filter((c) => c.target === target).map((c) => [c.op, ...c.args]);
        },
        /** How many frames were drawn on the processor's own canvas from the camera or a picture. */
        frameDraws(): number {
            return calls.filter((c) => c.target === "c0" && c.op === "drawImage").length;
        },
        statuses(): FilterStatus[] {
            return h.onStatus.mock.calls.map((call) => call[0]);
        },
        /** Runs `n` frame intervals - one tick each. */
        frames(n = 1): void {
            vi.advanceTimersByTime(INTERVAL * n);
        },
        widthSets: new Map<string, number>(),
    };

    const label = (value: any): unknown => (value && typeof value === "object" && "id" in value ? value.id : value);

    function makeContext(id: string): CanvasRenderingContext2D {
        const stored: Record<string, unknown> = {};
        const recorders = new Map<string, (...args: unknown[]) => void>();
        const record = (op: string, args: unknown[]) => calls.push({ target: id, op, args });
        const explicit: Record<string, (...args: any[]) => unknown> = {
            drawImage: (source: unknown, ...rest: unknown[]) => {
                record("drawImage", [label(source), ...rest]);
                if (h.drawImageThrows) {
                    throw new Error("draw failed");
                }
            },
            clearRect: (...args: unknown[]) => record("clearRect", args),
            getImageData: (x: number, y: number, w: number, hgt: number) => {
                record("getImageData", [x, y, w, hgt]);
                const data = new Uint8ClampedArray(w * hgt * 4);
                for (let i = 0; i < data.length; i += 4) {
                    data.set(h.pixel, i);
                }
                const result = { width: w, height: hgt, data };
                images.push(result);
                return result;
            },
            putImageData: (img: unknown, x: number, y: number) => record("putImageData", [img, x, y]),
            createImageData: (w: number, hgt: number) => {
                record("createImageData", [w, hgt]);
                const result = { width: w, height: hgt, data: new Uint8ClampedArray(w * hgt * 4) };
                images.push(result);
                return result;
            },
        };
        const logged = new Set(["globalCompositeOperation", "imageSmoothingEnabled", "imageSmoothingQuality"]);
        return new Proxy({} as CanvasRenderingContext2D, {
            get(_target, prop) {
                if (typeof prop !== "string") return undefined;
                if (prop in explicit) return explicit[prop];
                if (prop in stored) return stored[prop];
                if (!recorders.has(prop)) recorders.set(prop, (...args: unknown[]) => record(prop, args));
                return recorders.get(prop);
            },
            set(_target, prop, value) {
                stored[String(prop)] = value;
                if (logged.has(String(prop))) record(`set ${String(prop)}`, [value]);
                return true;
            },
        });
    }

    function makeCanvas(): HTMLCanvasElement {
        const id = `c${canvases.length}`;
        const ctx = makeContext(id);
        let width = 300;
        let height = 150;
        const canvas = {
            id,
            get width() {
                return width;
            },
            set width(value: number) {
                width = value;
                h.widthSets.set(id, (h.widthSets.get(id) ?? 0) + 1);
            },
            get height() {
                return height;
            },
            set height(value: number) {
                height = value;
            },
            getContext: vi.fn(() => (h.nullContexts.has(id) ? null : ctx)),
            captureStream: vi.fn(() => ({ getVideoTracks: () => [h.track] })),
        };
        canvases.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
    }

    if (playRejects) {
        h.video.play.mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
    }
    h.segmenter = { segment: vi.fn(() => h.mask) };
    h.faceTracker = { detect: vi.fn(() => h.face) };
    h.createSegmenter = vi.fn(() => h.segmenterLoad.promise);
    h.createFaceTracker = vi.fn(() => h.faceLoad.promise);

    h.processor = new VideoFilterProcessor({
        source: h.source,
        filters: NO_FILTERS,
        frameRate: autoFrameRate ? undefined : FRAME_RATE,
        onStatus: h.onStatus,
        ...rest,
        deps: {
            createCanvas: makeCanvas,
            createVideo: () => h.video as unknown as HTMLVideoElement,
            createSegmenter: h.createSegmenter as never,
            createFaceTracker: h.createFaceTracker as never,
            now: () => {
                const value = h.clock;
                h.clock += h.clockStep;
                return value;
            },
            ...deps,
        },
    });
    created.push(h.processor);
    return h;
}

/** Every processor a test made, so none is left ticking. */
const created: VideoFilterProcessor[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    installFakeMediaStream();
});

afterEach(() => {
    for (const processor of created.splice(0)) {
        processor.stop();
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Lets promise callbacks (a model finishing loading) run. */
async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

/** A mask of `width` x `height` with the given confidence for its first pixels (the rest is background). */
function mask(width: number, height: number, ...confidence: number[]): PersonMask {
    const values = new Float32Array(width * height);
    values.set(confidence);
    return { width, height, confidence: values };
}

describe("construction", () => {
    it("captures the canvas at the given frame rate and exposes its track", () => {
        const h = harness();
        expect(h.canvases[0].captureStream).toHaveBeenCalledWith(FRAME_RATE);
        expect(h.processor.track).toBe(h.track);
    });

    it("defaults to 30 frames per second", () => {
        const h = harness({ autoFrameRate: true });
        expect(h.canvases[0].captureStream).toHaveBeenCalledWith(30);
        // The first frame is drawn at once, the next one 1000/30 ms later.
        expect(h.frameDraws()).toBe(1);
        vi.advanceTimersByTime(32);
        expect(h.frameDraws()).toBe(1);
        vi.advanceTimersByTime(2);
        expect(h.frameDraws()).toBe(2);
    });

    it("asks for a 2D context that is cheap to read back", () => {
        const h = harness();
        expect(h.canvases[0].getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
    });

    it("plays the camera's track in a muted, inline video element", () => {
        const h = harness();
        expect(h.video.muted).toBe(true);
        expect(h.video.playsInline).toBe(true);
        expect(h.video.play).toHaveBeenCalledTimes(1);
        const stream = h.video.srcObject as MediaStream;
        expect(stream.getVideoTracks()).toEqual([h.source]);
    });

    it("throws when the browser can't make a 2D context", () => {
        expect(
            () =>
                new VideoFilterProcessor({
                    source: fakeTrack("video"),
                    filters: NO_FILTERS,
                    deps: {
                        createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement,
                        createVideo: () => ({}) as HTMLVideoElement,
                    },
                }),
        ).toThrow("This browser can't draw video effects.");
    });

    it("swallows a video.play() that is rejected", async () => {
        // A rejected promise nobody handles would fail the test run, so getting through is the assertion.
        const h = harness({ playRejects: true });
        await flush();
        expect(h.video.play).toHaveBeenCalledTimes(1);
        expect(h.frameDraws()).toBe(1);
    });
});

describe("frame loop", () => {
    it("draws the camera frame straight onto the canvas when there is no background", () => {
        const h = harness();
        expect(h.ops("c0")).toEqual([["drawImage", "video", 0, 0, 640, 480]]);
        expect(h.canvases).toHaveLength(1);
        expect(h.canvases[0].width).toBe(640);
        expect(h.canvases[0].height).toBe(480);
        expect(h.createSegmenter).not.toHaveBeenCalled();
        expect(h.createFaceTracker).not.toHaveBeenCalled();
    });

    it("draws again on every interval", () => {
        const h = harness();
        h.frames(3);
        expect(h.frameDraws()).toBe(4);
    });

    it("skips frames while the video has no frame yet, and carries on when it does", () => {
        const h = harness();
        h.video.readyState = 1;
        h.frames(2);
        expect(h.frameDraws()).toBe(1);
        h.video.readyState = 2;
        h.frames();
        expect(h.frameDraws()).toBe(2);
    });

    it("skips frames while the video has no size", () => {
        const h = harness();
        h.video.videoWidth = 0;
        h.frames(2);
        expect(h.frameDraws()).toBe(1);
        h.video.videoWidth = 640;
        h.frames();
        expect(h.frameDraws()).toBe(2);
    });

    it("draws nothing at all while the video is not ready from the very first frame", () => {
        const h = harness({ deps: { createVideo: () => ({ id: "video", readyState: 0, videoWidth: 0, play: vi.fn(async () => undefined), pause: vi.fn() }) as never } });
        h.frames(2);
        expect(h.frameDraws()).toBe(0);
        expect(h.widthSets.size).toBe(0);
    });

    it("resizes the canvas only when the video's size changes", () => {
        const h = harness();
        h.frames(2);
        expect(h.widthSets.get("c0")).toBe(1);
        h.video.videoWidth = 320;
        h.video.videoHeight = 240;
        h.frames();
        expect(h.canvases[0].width).toBe(320);
        expect(h.canvases[0].height).toBe(240);
        expect(h.widthSets.get("c0")).toBe(2);
        expect(h.ops("c0").slice(-1)[0]).toEqual(["drawImage", "video", 0, 0, 320, 240]);
    });

    it("also resizes when only the height changes", () => {
        const h = harness();
        h.video.videoHeight = 360;
        h.frames();
        expect(h.canvases[0].height).toBe(360);
        expect(h.canvases[0].width).toBe(640);
    });

    it("waits out what is left of the interval after a slow frame", () => {
        const h = harness();
        h.clockStep = 60; // every call to now() is 60 ms later than the last: the frame "took" 60 ms.
        h.frames(); // this tick runs, and schedules the next one 100 - 60 ms later
        expect(h.frameDraws()).toBe(2);
        vi.advanceTimersByTime(39);
        expect(h.frameDraws()).toBe(2);
        vi.advanceTimersByTime(1);
        expect(h.frameDraws()).toBe(3);
    });

    it("does not wait at all when a frame took longer than the interval", () => {
        const h = harness();
        h.clockStep = 500;
        // (Not `frames()`: a zero-delay timer that reschedules itself would never let that advance finish.)
        const draws = h.frameDraws();
        vi.advanceTimersToNextTimer();
        expect(h.frameDraws()).toBe(draws + 1);
        // The next frame is due immediately, not an interval later.
        vi.advanceTimersToNextTimer();
        expect(h.frameDraws()).toBe(draws + 2);
        expect(vi.getTimerCount()).toBe(1);
    });
});

describe("background blur", () => {
    it("draws a small copy of the frame and scales it up, and no raw frame, while the mask is not ready", () => {
        const h = harness({ filters: blur });
        expect(h.canvases).toHaveLength(2);
        // 640x480 / 12, rounded up.
        expect(h.canvases[1].width).toBe(54);
        expect(h.canvases[1].height).toBe(40);
        expect(h.ops("c1")).toEqual([
            ["set imageSmoothingQuality", "high"],
            ["drawImage", "video", 0, 0, 54, 40],
        ]);
        expect(h.ops("c0")).toEqual([
            ["set imageSmoothingQuality", "high"],
            ["drawImage", "c1", 0, 0, 640, 480],
        ]);
        // No person is composited and the camera frame itself never reaches the main canvas.
        expect(h.canvases).toHaveLength(2);
        expect(h.calls.filter((c) => c.target === "c0" && c.args[0] === "video")).toEqual([]);
    });

    it("keeps the scratch canvas between frames", () => {
        const h = harness({ filters: blur });
        h.frames(3);
        expect(h.canvases).toHaveLength(2);
        expect(h.widthSets.get("c1")).toBe(1);
    });

    it("resizes the scratch canvas when the video's size changes", () => {
        const h = harness({ filters: blur });
        h.video.videoWidth = 1280;
        h.video.videoHeight = 720;
        h.frames();
        expect(h.canvases[1].width).toBe(107);
        expect(h.canvases[1].height).toBe(60);
    });

    it("stays fail-closed - blur only, no person - when the model fails to load", async () => {
        const h = harness({ filters: blur });
        h.segmenterLoad.reject(new Error("offline"));
        await flush();
        h.frames(2);
        expect(h.canvases).toHaveLength(2);
        expect(h.calls.filter((c) => c.args[0] === "video" && c.target === "c0")).toEqual([]);
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: SEGMENTATION_ERROR });
    });

    it("falls back to blur for a custom image background that has no picture", () => {
        for (const backgroundImage of [undefined, null]) {
            const h = harness({ filters: image, backgroundImage });
            expect(h.ops("c0")).toEqual([
                ["set imageSmoothingQuality", "high"],
                ["drawImage", "c1", 0, 0, 640, 480],
            ]);
        }
    });
});

describe("custom image background", () => {
    function picture(width: number, height: number): BackgroundPicture {
        return { source: { id: "picture" } as unknown as CanvasImageSource, width, height };
    }

    it("covers a canvas with a picture that is relatively wider, cropping the sides", () => {
        const h = harness({ filters: image, backgroundImage: picture(1000, 500) });
        // scale = max(640/1000, 480/500) = 0.96 -> 960 x 480, centred horizontally.
        expect(h.ops("c0")).toEqual([["drawImage", "picture", -160, 0, 960, 480]]);
        expect(h.canvases).toHaveLength(1);
    });

    it("covers a canvas with a picture that is relatively taller, cropping the top and bottom", () => {
        const h = harness({ filters: image, backgroundImage: picture(400, 800) });
        // scale = max(640/400, 480/800) = 1.6 -> 640 x 1280, centred vertically.
        expect(h.ops("c0")).toEqual([["drawImage", "picture", 0, -400, 640, 1280]]);
    });

    it("fits a picture of the canvas's own proportions exactly", () => {
        const h = harness({ filters: image, backgroundImage: picture(320, 240) });
        expect(h.ops("c0")).toEqual([["drawImage", "picture", 0, 0, 640, 480]]);
    });

    it("composites the person over the picture once the mask is ready", async () => {
        const h = harness({ filters: image, backgroundImage: picture(640, 480) });
        h.mask = mask(2, 2, 1, 0, 0.3, 0.7);
        h.segmenterLoad.resolve(h.segmenter);
        await flush();
        h.frames();
        expect(h.ops("c0")).toEqual([
            ["drawImage", "picture", 0, 0, 640, 480],
            ["drawImage", "picture", 0, 0, 640, 480],
            ["drawImage", "c2", 0, 0],
        ]);
    });

    it("switches to the picture, and away from it, through update()", () => {
        const h = harness({ filters: image });
        expect(h.canvases).toHaveLength(2); // blurred, no picture yet
        h.processor.update(image, picture(640, 480));
        h.frames();
        expect(h.ops("c0").slice(-1)[0]).toEqual(["drawImage", "picture", 0, 0, 640, 480]);
        h.processor.update(NO_FILTERS, null);
        h.frames();
        expect(h.ops("c0").slice(-1)[0]).toEqual(["drawImage", "video", 0, 0, 640, 480]);
    });
});

describe("person compositing", () => {
    async function ready(filters = blur, m: PersonMask | null = mask(4, 2, 1, 1, 1, 1, 0, 0, 0.3, 0.7)) {
        const h = harness({ filters });
        h.mask = m;
        h.segmenterLoad.resolve(h.segmenter);
        await flush();
        return h;
    }

    it("segments each frame with the video and the frame's timestamp", async () => {
        const h = await ready();
        h.clock = 1234;
        h.frames();
        expect(h.segmenter.segment).toHaveBeenLastCalledWith(h.video, 1234);
    });

    it("draws the mask as alpha, then the video through it (source-in), then the result over the blur", async () => {
        const h = await ready();
        h.frames();
        // c0 main, c1 blur, c2 mask, c3 person
        expect(h.canvases).toHaveLength(4);
        expect(h.ops("c2")).toEqual([
            ["createImageData", 4, 2],
            ["putImageData", h.images[0], 0, 0],
        ]);
        expect(h.ops("c3")).toEqual([
            ["set globalCompositeOperation", "source-over"],
            ["clearRect", 0, 0, 640, 480],
            ["drawImage", "c2", 0, 0, 640, 480],
            ["set globalCompositeOperation", "source-in"],
            ["drawImage", "video", 0, 0, 640, 480],
            ["set globalCompositeOperation", "source-over"],
        ]);
        expect(h.ops("c0").slice(-2)).toEqual([
            ["drawImage", "c1", 0, 0, 640, 480],
            ["drawImage", "c3", 0, 0],
        ]);
        // The camera frame itself is only ever drawn through the person layer.
        expect(h.calls.filter((c) => c.target === "c0" && c.args[0] === "video")).toEqual([]);
        expect(h.canvases[2].width).toBe(4);
        expect(h.canvases[2].height).toBe(2);
        expect(h.canvases[3].width).toBe(640);
    });

    it("turns the mask's confidence into the alpha channel", async () => {
        const h = await ready();
        h.frames();
        const alpha = Array.from(h.images[0].data as Uint8ClampedArray).filter((_, i) => i % 4 === 3);
        expect(alpha).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    });

    it("reuses one image across frames while the mask keeps its size", async () => {
        const h = await ready();
        h.frames(3);
        expect(h.ops("c2").filter((op) => op[0] === "createImageData")).toHaveLength(1);
        expect(h.ops("c2").filter((op) => op[0] === "putImageData")).toHaveLength(3);
        for (const op of h.ops("c2").filter((o) => o[0] === "putImageData")) {
            expect(op[1]).toBe(h.images[0]);
        }
    });

    it("creates a new image when the mask changes width or height", async () => {
        const h = await ready();
        h.frames();
        h.mask = mask(2, 2, 1, 1, 1, 1);
        h.frames();
        h.mask = mask(2, 4, 1, 1, 1, 1);
        h.frames();
        expect(h.ops("c2").filter((op) => op[0] === "createImageData")).toEqual([
            ["createImageData", 4, 2],
            ["createImageData", 2, 2],
            ["createImageData", 2, 4],
        ]);
    });

    it("draws only the background for a frame the model produced no mask for", async () => {
        const h = await ready(blur, null);
        h.frames();
        expect(h.canvases).toHaveLength(2);
        expect(h.segmenter.segment).toHaveBeenCalled();
        expect(h.ops("c0").slice(-1)[0]).toEqual(["drawImage", "c1", 0, 0, 640, 480]);
    });

    it("drops to fail-closed, reports the error and stops segmenting when the model throws", async () => {
        const h = await ready();
        h.segmenter.segment.mockImplementation(() => {
            throw new Error("GPU lost");
        });
        h.frames(3);
        // Tried once (in the frame it threw in), then never again.
        expect(h.segmenter.segment).toHaveBeenCalledTimes(1);
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: SEGMENTATION_ERROR });
        // Frames still go out, as the blurred background alone.
        expect(h.ops("c0").slice(-1)[0]).toEqual(["drawImage", "c1", 0, 0, 640, 480]);
        expect(h.calls.filter((c) => c.target === "c0" && c.args[0] === "video")).toEqual([]);
    });
});

describe("colour effects", () => {
    it("does not read the picture back for no effect", () => {
        const h = harness();
        expect(h.ops("c0").some((op) => op[0] === "getImageData" || op[0] === "putImageData")).toBe(false);
    });

    it.each([
        ["bw", [141, 141, 141, 255]],
        ["sepia", [Math.round(100 * 0.393 + 150 * 0.769 + 200 * 0.189), Math.round(100 * 0.349 + 150 * 0.686 + 200 * 0.168), Math.round(100 * 0.272 + 150 * 0.534 + 200 * 0.131), 255]],
        ["night-vision", [Math.round(0.25 * 1.4 * 140.75), Math.round(1.4 * 140.75), Math.round(0.25 * 1.4 * 140.75), 255]],
    ] as const)("%s reads the frame back, changes its pixels and writes them again", (effect, expected) => {
        const h = harness({ filters: { ...NO_FILTERS, effect } });
        expect(h.ops("c0")).toEqual([
            ["drawImage", "video", 0, 0, 640, 480],
            ["getImageData", 0, 0, 640, 480],
            ["putImageData", h.images[0], 0, 0],
        ]);
        const data = h.images[0].data as Uint8ClampedArray;
        expect(data).toHaveLength(640 * 480 * 4);
        expect(Array.from(data.slice(0, 4))).toEqual(expected);
        expect(Array.from(data.slice(-4))).toEqual(expected);
    });

    it("pixelates by drawing a tiny copy and scaling it up without smoothing", () => {
        const h = harness({ filters: { ...NO_FILTERS, effect: "pixelate" } });
        // 80 blocks across; ceil(480 / 640 * 80) = 60 down.
        expect(h.canvases[1].width).toBe(80);
        expect(h.canvases[1].height).toBe(60);
        expect(h.ops("c1")).toEqual([["drawImage", "c0", 0, 0, 80, 60]]);
        expect(h.ops("c0")).toEqual([
            ["drawImage", "video", 0, 0, 640, 480],
            ["set imageSmoothingEnabled", false],
            ["drawImage", "c1", 0, 0, 640, 480],
            ["set imageSmoothingEnabled", true],
        ]);
    });

    it("rounds the pixelated height up for a tall video", () => {
        const h = harness({ filters: { ...NO_FILTERS, effect: "pixelate" } });
        h.video.videoWidth = 300;
        h.video.videoHeight = 500;
        h.frames();
        expect(h.canvases[1].height).toBe(Math.ceil((500 / 300) * 80));
    });

    it("applies the effect over the background, before any accessory", async () => {
        const h = harness({ filters: { background: "blur", effect: "bw", accessory: "crown" } });
        h.mask = mask(2, 2, 1, 1, 1, 1);
        h.face = faceMesh();
        h.segmenterLoad.resolve(h.segmenter);
        h.faceLoad.resolve(h.faceTracker);
        await flush();
        h.frames();
        const all = h.ops("c0").map((op) => op[0]);
        const frame = all.slice(all.lastIndexOf("set imageSmoothingQuality"));
        expect(frame.indexOf("getImageData")).toBeGreaterThan(frame.lastIndexOf("drawImage"));
        expect(frame.indexOf("putImageData")).toBeGreaterThan(frame.indexOf("getImageData"));
        expect(frame.indexOf("translate")).toBeGreaterThan(frame.indexOf("putImageData"));
    });
});

describe("accessories", () => {
    async function withFace(face: FaceLandmark[] | null = faceMesh()) {
        const h = harness({ filters: crown });
        h.face = face;
        h.faceLoad.resolve(h.faceTracker);
        await flush();
        return h;
    }

    const translates = (h: ReturnType<typeof harness>) => h.ops("c0").filter((op) => op[0] === "translate");

    it("draws nothing before the face model has loaded", () => {
        const h = harness({ filters: crown });
        h.face = faceMesh();
        h.frames(2);
        expect(translates(h)).toEqual([]);
        expect(h.faceTracker.detect).not.toHaveBeenCalled();
        expect(h.statuses()).toEqual([{ loading: true, error: null }]);
    });

    it("draws the accessory at the face once it is found", async () => {
        const h = await withFace();
        h.clock = 77;
        h.frames();
        // The crown sits on the forehead: landmark 10 at (0.5, 0.2) of 640 x 480.
        expect(translates(h)).toEqual([["translate", 320, 96]]);
        expect(h.ops("c0").filter((op) => op[0] === "rotate")).toEqual([["rotate", 0]]);
        expect(h.faceTracker.detect).toHaveBeenLastCalledWith(h.video, 77);
    });

    it("never runs the face model when there is no accessory", async () => {
        const h = harness({ filters: blur });
        h.faceLoad.resolve(h.faceTracker);
        await flush();
        h.frames(2);
        expect(h.createFaceTracker).not.toHaveBeenCalled();
        expect(h.faceTracker.detect).not.toHaveBeenCalled();
    });

    it("holds the accessory for 6 frames after the face is lost, then takes it off", async () => {
        const h = await withFace();
        h.frames(); // face found
        expect(translates(h)).toHaveLength(1);
        h.face = null;
        for (let lost = 1; lost <= 6; lost++) {
            h.frames();
            expect(translates(h)).toHaveLength(1 + lost);
        }
        h.frames(); // the 7th frame without a face
        expect(translates(h)).toHaveLength(7);
        h.frames();
        expect(translates(h)).toHaveLength(7);
    });

    it("draws again as soon as the face comes back, and restarts the hold", async () => {
        const h = await withFace();
        h.frames();
        h.face = null;
        h.frames(7);
        const before = translates(h).length;
        h.face = faceMesh();
        h.frames();
        expect(translates(h)).toHaveLength(before + 1);
        h.face = null;
        h.frames(6);
        expect(translates(h)).toHaveLength(before + 7);
        h.frames();
        expect(translates(h)).toHaveLength(before + 7);
    });

    it("draws nothing for landmarks that are not a full face mesh", async () => {
        const h = await withFace(faceMesh(100));
        h.frames(2);
        expect(translates(h)).toEqual([]);
        expect(h.faceTracker.detect).toHaveBeenCalled();
    });

    it("reports an error and stops tracking when the face model throws", async () => {
        const h = await withFace();
        h.frames();
        expect(translates(h)).toHaveLength(1);
        h.faceTracker.detect.mockImplementation(() => {
            throw new Error("boom");
        });
        h.frames();
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: FACE_ERROR });
        const calls = h.faceTracker.detect.mock.calls.length;
        h.frames(3);
        expect(h.faceTracker.detect.mock.calls.length).toBe(calls);
        // The picture itself carries on.
        expect(translates(h)).toHaveLength(1);
        expect(h.frameDraws()).toBeGreaterThan(3);
    });

    it("draws an accessory for every kind", async () => {
        for (const accessory of ["sunglasses", "cat-ears", "party-hat", "crown", "mustache"] as const) {
            const h = harness({ filters: { ...NO_FILTERS, accessory } });
            h.face = faceMesh();
            h.faceLoad.resolve(h.faceTracker);
            await flush();
            h.frames();
            expect(translates(h).length).toBeGreaterThan(0);
            expect(h.ops("c0").filter((op) => op[0] === "save")).toHaveLength(h.ops("c0").filter((op) => op[0] === "restore").length);
        }
    });
});

describe("model loading and status", () => {
    it("reports nothing when no filter needs a model", async () => {
        const h = harness();
        h.frames(3);
        await flush();
        expect(h.onStatus).not.toHaveBeenCalled();
    });

    it("works without an onStatus callback", async () => {
        const h = harness({ filters: blur, onStatus: undefined });
        h.segmenterLoad.resolve(h.segmenter);
        await flush();
        h.frames();
        expect(h.frameDraws()).toBeGreaterThan(1);
    });

    it("reports loading while the segmentation model downloads, then ready", async () => {
        const h = harness({ filters: blur, assetsUrl: "https://assets.example.com" });
        expect(h.statuses()).toEqual([{ loading: true, error: null }]);
        expect(h.createSegmenter).toHaveBeenCalledWith("https://assets.example.com");
        h.segmenterLoad.resolve(h.segmenter);
        await flush();
        expect(h.statuses()).toEqual([
            { loading: true, error: null },
            { loading: false, error: null },
        ]);
    });

    it("reports loading for the face model too, and asks for it from assetsUrl", async () => {
        const h = harness({ filters: crown, assetsUrl: "https://assets.example.com" });
        expect(h.statuses()).toEqual([{ loading: true, error: null }]);
        expect(h.createFaceTracker).toHaveBeenCalledWith("https://assets.example.com");
        expect(h.createSegmenter).not.toHaveBeenCalled();
        h.faceLoad.resolve(h.faceTracker);
        await flush();
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: null });
    });

    it("stays loading until both models are in, emitting only when something changes", async () => {
        const h = harness({ filters: { background: "blur", effect: "none", accessory: "crown" } });
        expect(h.onStatus).toHaveBeenCalledTimes(1);
        h.segmenterLoad.resolve(h.segmenter);
        await flush();
        expect(h.onStatus).toHaveBeenCalledTimes(1);
        h.faceLoad.resolve(h.faceTracker);
        await flush();
        expect(h.statuses()).toEqual([
            { loading: true, error: null },
            { loading: false, error: null },
        ]);
    });

    it("does not emit again for an update() that changes nothing about the status", async () => {
        const h = harness({ filters: blur });
        h.segmenterLoad.resolve(h.segmenter);
        await flush();
        const count = h.onStatus.mock.calls.length;
        h.processor.update(blur, null);
        h.processor.update({ ...blur, effect: "sepia" }, null);
        expect(h.onStatus).toHaveBeenCalledTimes(count);
    });

    it("reports a segmentation model that fails to load", async () => {
        const h = harness({ filters: blur });
        h.segmenterLoad.reject(new Error("404"));
        await flush();
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: SEGMENTATION_ERROR });
    });

    it("reports a face model that fails to load", async () => {
        const h = harness({ filters: crown });
        h.faceLoad.reject(new Error("404"));
        await flush();
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: FACE_ERROR });
    });

    it("reports the background failure ahead of the face one", async () => {
        const h = harness({ filters: { background: "blur", effect: "none", accessory: "crown" } });
        h.faceLoad.reject(new Error("404"));
        await flush();
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: true, error: FACE_ERROR });
        h.segmenterLoad.reject(new Error("404"));
        await flush();
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: SEGMENTATION_ERROR });
    });

    it("stops reporting a failed model once the filters no longer need it", async () => {
        const h = harness({ filters: blur });
        h.segmenterLoad.reject(new Error("404"));
        await flush();
        h.processor.update(NO_FILTERS, null);
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: null });
    });
});

describe("update()", () => {
    it("starts loading a model a newly chosen filter needs", async () => {
        const h = harness();
        h.processor.update(blur, null);
        expect(h.createSegmenter).toHaveBeenCalledTimes(1);
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: true, error: null });
        h.processor.update({ ...blur, accessory: "crown" }, null);
        expect(h.createFaceTracker).toHaveBeenCalledTimes(1);
    });

    it("does not reload a model that is loading or ready", async () => {
        const h = harness({ filters: { background: "blur", effect: "none", accessory: "crown" } });
        h.processor.update({ background: "blur", effect: "bw", accessory: "crown" }, null);
        expect(h.createSegmenter).toHaveBeenCalledTimes(1);
        expect(h.createFaceTracker).toHaveBeenCalledTimes(1);
        h.segmenterLoad.resolve(h.segmenter);
        h.faceLoad.resolve(h.faceTracker);
        await flush();
        h.processor.update({ background: "image", effect: "none", accessory: "sunglasses" }, null);
        expect(h.createSegmenter).toHaveBeenCalledTimes(1);
        expect(h.createFaceTracker).toHaveBeenCalledTimes(1);
    });

    it("retries a model that failed to load", async () => {
        const h = harness({ filters: { background: "blur", effect: "none", accessory: "crown" } });
        h.segmenterLoad.reject(new Error("404"));
        h.faceLoad.reject(new Error("404"));
        await flush();
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: SEGMENTATION_ERROR });

        const retry = deferred<PersonSegmenter>();
        h.createSegmenter.mockReturnValue(retry.promise);
        h.createFaceTracker.mockReturnValue(Promise.resolve(h.faceTracker));
        h.processor.update({ background: "blur", effect: "none", accessory: "crown" }, null);
        expect(h.createSegmenter).toHaveBeenCalledTimes(2);
        expect(h.createFaceTracker).toHaveBeenCalledTimes(2);
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: true, error: null });

        h.mask = mask(2, 2, 1, 1, 1, 1);
        retry.resolve(h.segmenter);
        await flush();
        expect(h.statuses().slice(-1)[0]).toEqual({ loading: false, error: null });
        h.frames();
        expect(h.canvases.length).toBeGreaterThan(2); // person compositing works again
    });

    it("retries a segmenter that threw at runtime", async () => {
        const h = harness({ filters: blur });
        h.segmenterLoad.resolve(h.segmenter);
        await flush();
        h.segmenter.segment.mockImplementation(() => {
            throw new Error("boom");
        });
        h.frames();
        expect(h.statuses().slice(-1)[0]?.error).toBe(SEGMENTATION_ERROR);
        h.createSegmenter.mockReturnValue(Promise.resolve(h.segmenter));
        h.processor.update(blur, null);
        expect(h.createSegmenter).toHaveBeenCalledTimes(2);
    });

    it("switches between filters without interrupting the video", () => {
        const h = harness();
        h.processor.update({ ...NO_FILTERS, effect: "bw" }, null);
        h.frames();
        expect(h.ops("c0").slice(-1)[0]).toEqual(["putImageData", h.images.slice(-1)[0], 0, 0]);
        h.processor.update(NO_FILTERS, null);
        h.frames();
        expect(h.ops("c0").slice(-1)[0]).toEqual(["drawImage", "video", 0, 0, 640, 480]);
        expect(h.track.stop).not.toHaveBeenCalled();
    });
});

describe("stop()", () => {
    it("clears the timer, pauses and releases the video and stops the filtered track", () => {
        const h = harness();
        expect(vi.getTimerCount()).toBe(1);
        h.processor.stop();
        expect(vi.getTimerCount()).toBe(0);
        expect(h.video.pause).toHaveBeenCalledTimes(1);
        expect(h.video.srcObject).toBeNull();
        expect(h.track.stop).toHaveBeenCalledTimes(1);
        const draws = h.frameDraws();
        h.frames(5);
        expect(h.frameDraws()).toBe(draws);
    });

    it("leaves the camera's own track alone", () => {
        const h = harness();
        h.processor.stop();
        expect(h.source.stop).not.toHaveBeenCalled();
    });

    it("ignores a model that finishes loading afterwards", async () => {
        const h = harness({ filters: { background: "blur", effect: "none", accessory: "crown" } });
        const count = h.onStatus.mock.calls.length;
        h.processor.stop();
        h.segmenterLoad.resolve(h.segmenter);
        h.faceLoad.reject(new Error("404"));
        await flush();
        expect(h.onStatus).toHaveBeenCalledTimes(count);
    });

    it("ignores an update() afterwards as far as reporting goes", () => {
        const h = harness();
        h.processor.stop();
        h.processor.update(blur, null);
        expect(h.onStatus).not.toHaveBeenCalled();
    });

    it("does not tick again if it is stopped from inside a frame's own status callback", () => {
        let processor: VideoFilterProcessor | undefined;
        const h = harness({
            onStatus: (status) => {
                if (status.error) processor?.stop();
            },
        });
        processor = h.processor;
        h.drawImageThrows = true;
        h.frames();
        // stop() ran during the tick, which then still scheduled its next one - that one must do nothing.
        expect(vi.getTimerCount()).toBe(1);
        const draws = h.frameDraws();
        h.frames();
        expect(h.frameDraws()).toBe(draws);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("render failures", () => {
    it("reports a frame that can't be drawn once and keeps ticking", () => {
        const h = harness();
        h.drawImageThrows = true;
        h.frames(3);
        expect(h.statuses()).toEqual([{ loading: false, error: RENDER_ERROR }]);
        expect(h.frameDraws()).toBe(1 + 3);
        expect(vi.getTimerCount()).toBe(1);
        // It recovers on its own once frames can be drawn again, and the warning goes away with it.
        h.drawImageThrows = false;
        h.frames();
        expect(h.ops("c0").slice(-1)[0]).toEqual(["drawImage", "video", 0, 0, 640, 480]);
        expect(h.statuses()).toEqual([
            { loading: false, error: RENDER_ERROR },
            { loading: false, error: null },
        ]);
        // ...and further good frames say nothing more.
        h.frames(2);
        expect(h.onStatus).toHaveBeenCalledTimes(2);
    });

    it("counts a scratch canvas that can't get a 2D context as a render failure, and keeps ticking", () => {
        // c0 is the main canvas; the blur layer is the next canvas made, and it has no 2D context.
        const h = harness({ filters: blur, nullContexts: ["c1", "c2", "c3"] });
        expect(h.statuses()).toEqual([
            { loading: true, error: null },
            { loading: true, error: RENDER_ERROR },
        ]);
        h.frames(2);
        expect(h.onStatus).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
    });
});

describe("default dependencies", () => {
    it("creates real canvas and video elements and reads the real clock", async () => {
        const context = new Proxy({} as CanvasRenderingContext2D, { get: () => vi.fn() });
        const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
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
            const processor = new VideoFilterProcessor({ source: fakeTrack("video"), filters: NO_FILTERS, frameRate: FRAME_RATE });
            created.push(processor);
            expect(processor.track).toBe(track);
            expect(getContext).toHaveBeenCalledWith("2d", { willReadFrequently: true });
            expect(play).toHaveBeenCalledTimes(1);
            const video = play.mock.contexts[0] as HTMLVideoElement;
            expect(video.tagName).toBe("VIDEO");
            expect(video.muted).toBe(true);
            // A video with no frame yet is skipped, and the loop keeps its timer.
            expect(now).toHaveBeenCalled();
            const reads = now.mock.calls.length;
            vi.advanceTimersByTime(INTERVAL);
            expect(now.mock.calls.length).toBeGreaterThan(reads);
            processor.stop();
            expect(pause).toHaveBeenCalledTimes(1);
        } finally {
            delete (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream;
        }
    });
});
