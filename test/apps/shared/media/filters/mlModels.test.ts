///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    MEDIAPIPE_VERSION,
    createFaceTracker,
    createPersonSegmenter,
    modelUrls,
    personMaskIndex,
    resetModelCache,
} from "../../../../../apps/shared/media/filters/mlModels.js";

/** What the faked `@mediapipe/tasks-vision` does - each test scripts it. */
const vision = vi.hoisted(() => ({
    forVisionTasks: vi.fn(),
    createSegmenter: vi.fn(),
    createFaceLandmarker: vi.fn(),
}));

vi.mock("@mediapipe/tasks-vision", () => ({
    FilesetResolver: { forVisionTasks: vision.forVisionTasks },
    ImageSegmenter: { createFromOptions: vision.createSegmenter },
    FaceLandmarker: { createFromOptions: vision.createFaceLandmarker },
}));

const FRAME = {} as HTMLVideoElement;

/** A fake mask as MediaPipe hands one to the `segmentForVideo` callback. */
function fakeMask(values: number[], width = values.length, height = 1) {
    return { width, height, getAsFloat32Array: vi.fn(() => Float32Array.from(values)) };
}

interface FakeSegmenter {
    getLabels: ReturnType<typeof vi.fn>;
    segmentForVideo: ReturnType<typeof vi.fn>;
}

function fakeSegmenter(labels: string[], masks: ReturnType<typeof fakeMask>[] | undefined): FakeSegmenter {
    return {
        getLabels: vi.fn(() => labels),
        segmentForVideo: vi.fn((_frame: unknown, _timestamp: number, callback: (result: unknown) => void) => {
            callback({ confidenceMasks: masks });
        }),
    };
}

beforeEach(() => {
    resetModelCache();
    vision.forVisionTasks.mockReset().mockResolvedValue({ fileset: true });
    vision.createSegmenter.mockReset();
    vision.createFaceLandmarker.mockReset();
});

describe("MEDIAPIPE_VERSION", () => {
    it("matches the installed @mediapipe/tasks-vision, so the wasm fetched at runtime fits the JavaScript", () => {
        const pkg = JSON.parse(readFileSync("node_modules/@mediapipe/tasks-vision/package.json", "utf8")) as { version: string };
        expect(MEDIAPIPE_VERSION).toBe(pkg.version);
    });
});

describe("modelUrls", () => {
    it("uses the public CDNs, pinned to the installed version, when there is no assets url", () => {
        for (const url of [modelUrls(), modelUrls(""), modelUrls(undefined)]) {
            expect(url.wasm).toBe(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`);
            expect(url.segmenter).toMatch(/^https:\/\/storage\.googleapis\.com\/.*selfie_segmenter\.tflite$/);
            expect(url.face).toMatch(/^https:\/\/storage\.googleapis\.com\/.*face_landmarker\.task$/);
        }
    });

    it("puts everything under the assets url when one is given", () => {
        expect(modelUrls("https://assets.example.com/mp")).toEqual({
            wasm: "https://assets.example.com/mp/wasm",
            segmenter: "https://assets.example.com/mp/selfie_segmenter.tflite",
            face: "https://assets.example.com/mp/face_landmarker.task",
        });
    });

    it("ignores trailing slashes on the assets url", () => {
        const expected = modelUrls("https://assets.example.com/mp");
        expect(modelUrls("https://assets.example.com/mp/")).toEqual(expected);
        expect(modelUrls("https://assets.example.com/mp///")).toEqual(expected);
    });
});

describe("personMaskIndex", () => {
    it("picks the mask labelled as the person", () => {
        expect(personMaskIndex(["background", "person"], 2)).toBe(1);
        expect(personMaskIndex(["person", "background"], 2)).toBe(0);
    });

    it("also recognises 'foreground', in any case", () => {
        expect(personMaskIndex(["background", "Foreground"], 2)).toBe(1);
        expect(personMaskIndex(["PERSON", "background"], 2)).toBe(0);
    });

    it("falls back to the last mask when no label matches", () => {
        expect(personMaskIndex(["background", "other", "thing"], 3)).toBe(2);
        expect(personMaskIndex([], 2)).toBe(1);
    });

    it("falls back to the last mask when the matching label is beyond the masks returned", () => {
        expect(personMaskIndex(["background", "other", "person"], 2)).toBe(1);
    });
});

describe("createPersonSegmenter", () => {
    it("loads the runtime and model from the given urls on the GPU and copies the person mask out", async () => {
        const person = fakeMask([0.1, 0.9, 0.5], 3, 1);
        const model = fakeSegmenter(["background", "person"], [fakeMask([1, 1, 1]), person]);
        vision.createSegmenter.mockResolvedValue(model);

        const segmenter = await createPersonSegmenter("https://assets.example.com/mp/");

        expect(vision.forVisionTasks).toHaveBeenCalledWith("https://assets.example.com/mp/wasm");
        expect(vision.createSegmenter).toHaveBeenCalledTimes(1);
        expect(vision.createSegmenter.mock.calls[0][0]).toEqual({ fileset: true });
        expect(vision.createSegmenter.mock.calls[0][1]).toEqual({
            baseOptions: { modelAssetPath: "https://assets.example.com/mp/selfie_segmenter.tflite", delegate: "GPU" },
            runningMode: "VIDEO",
            outputConfidenceMasks: true,
            outputCategoryMask: false,
        });

        const mask = segmenter.segment(FRAME, 100)!;
        expect(mask.width).toBe(3);
        expect(mask.height).toBe(1);
        expect(Array.from(mask.confidence)).toEqual([expect.closeTo(0.1), expect.closeTo(0.9), 0.5]);
        expect(model.segmentForVideo.mock.calls[0][0]).toBe(FRAME);
    });

    it("uses the CDN urls with no assets url", async () => {
        vision.createSegmenter.mockResolvedValue(fakeSegmenter(["person"], [fakeMask([1])]));
        await createPersonSegmenter();
        expect(vision.forVisionTasks).toHaveBeenCalledWith(modelUrls().wasm);
        expect(vision.createSegmenter.mock.calls[0][1].baseOptions.modelAssetPath).toBe(modelUrls().segmenter);
    });

    it("returns a copy, since MediaPipe only keeps the mask valid inside its callback", async () => {
        const buffer = Float32Array.from([0.2, 0.8]);
        const person = { width: 2, height: 1, getAsFloat32Array: () => buffer };
        vision.createSegmenter.mockResolvedValue(fakeSegmenter(["person"], [person as never]));
        const segmenter = await createPersonSegmenter();

        const mask = segmenter.segment(FRAME, 1)!;
        expect(mask.confidence).not.toBe(buffer);
        buffer.fill(0); // MediaPipe reusing its buffer for the next frame
        expect(mask.confidence[1]).toBeCloseTo(0.8);
    });

    it("picks the mask by label, or the last one when none is labelled as a person", async () => {
        vision.createSegmenter.mockResolvedValueOnce(fakeSegmenter(["person", "background"], [fakeMask([0.25]), fakeMask([0.75])]));
        const byLabel = await createPersonSegmenter("https://a.example.com");
        expect(byLabel.segment(FRAME, 1)!.confidence[0]).toBeCloseTo(0.25);

        vision.createSegmenter.mockResolvedValueOnce(fakeSegmenter(["background", "other"], [fakeMask([0.25]), fakeMask([0.75])]));
        const last = await createPersonSegmenter("https://b.example.com");
        expect(last.segment(FRAME, 1)!.confidence[0]).toBeCloseTo(0.75);
    });

    it.each([[undefined], [[]]])("returns null when the model produced no masks (%j)", async (masks) => {
        vision.createSegmenter.mockResolvedValue(fakeSegmenter(["person"], masks));
        const segmenter = await createPersonSegmenter();
        expect(segmenter.segment(FRAME, 1)).toBeNull();
    });

    it("falls back to the CPU when the GPU delegate can't be created", async () => {
        const model = fakeSegmenter(["person"], [fakeMask([1])]);
        vision.createSegmenter.mockRejectedValueOnce(new Error("no WebGL")).mockResolvedValueOnce(model);

        const segmenter = await createPersonSegmenter();

        expect(vision.createSegmenter).toHaveBeenCalledTimes(2);
        expect(vision.createSegmenter.mock.calls[0][1].baseOptions.delegate).toBe("GPU");
        expect(vision.createSegmenter.mock.calls[1][1].baseOptions.delegate).toBe("CPU");
        expect(segmenter.segment(FRAME, 1)).not.toBeNull();
    });

    it("hands MediaPipe strictly increasing timestamps, even for repeated or earlier ones", async () => {
        const model = fakeSegmenter(["person"], [fakeMask([1])]);
        vision.createSegmenter.mockResolvedValue(model);
        const segmenter = await createPersonSegmenter();

        for (const timestamp of [100, 100, 50, 101, 500, 20]) {
            segmenter.segment(FRAME, timestamp);
        }

        const stamps = model.segmentForVideo.mock.calls.map((call) => call[1] as number);
        expect(stamps).toEqual([100, 101, 102, 103, 500, 501]);
    });

    // The loads below are awaited one at a time: vitest's module mock can hand a *second concurrent* dynamic
    // `import()` of a mocked module the real library instead of the fake.
    it("shares one model per assets url, and loads a different one for a different url", async () => {
        vision.createSegmenter.mockImplementation(async () => fakeSegmenter(["person"], [fakeMask([1])]));

        const a = createPersonSegmenter("https://a.example.com");
        expect(createPersonSegmenter("https://a.example.com")).toBe(a);
        await a;
        expect(createPersonSegmenter("https://a.example.com")).toBe(a);
        const b = createPersonSegmenter("https://b.example.com");
        expect(b).not.toBe(a);
        await b;
        const cdn = createPersonSegmenter();
        expect(createPersonSegmenter(undefined)).toBe(cdn);
        expect(cdn).not.toBe(a);
        await cdn;

        expect(vision.createSegmenter).toHaveBeenCalledTimes(3);
    });

    it("forgets a failed load, so the next attempt tries again", async () => {
        vision.createSegmenter.mockRejectedValue(new Error("offline"));
        await expect(createPersonSegmenter()).rejects.toThrow("offline");
        // Both the GPU and the CPU attempt failed.
        expect(vision.createSegmenter).toHaveBeenCalledTimes(2);

        vision.createSegmenter.mockReset().mockResolvedValue(fakeSegmenter(["person"], [fakeMask([1])]));
        const segmenter = await createPersonSegmenter();
        expect(segmenter.segment(FRAME, 1)).not.toBeNull();
        expect(vision.createSegmenter).toHaveBeenCalledTimes(1);
    });

    it("rejects when the runtime can't be fetched, and retries afterwards", async () => {
        vision.forVisionTasks.mockRejectedValueOnce(new Error("wasm 404"));
        await expect(createPersonSegmenter()).rejects.toThrow("wasm 404");
        expect(vision.createSegmenter).not.toHaveBeenCalled();

        vision.createSegmenter.mockResolvedValue(fakeSegmenter(["person"], [fakeMask([1])]));
        await expect(createPersonSegmenter()).resolves.toBeDefined();
    });

    it("keeps a successful load cached until the cache is reset", async () => {
        vision.createSegmenter.mockImplementation(async () => fakeSegmenter(["person"], [fakeMask([1])]));
        const first = createPersonSegmenter();
        await first;
        expect(createPersonSegmenter()).toBe(first);
        resetModelCache();
        const second = createPersonSegmenter();
        expect(second).not.toBe(first);
        await second;
        expect(vision.createSegmenter).toHaveBeenCalledTimes(2);
    });
});

/** A fake `FaceLandmarker` whose `detectForVideo` answers with `faces`. */
function fakeLandmarker(faces: { x: number; y: number }[][]) {
    return { detectForVideo: vi.fn(() => ({ faceLandmarks: faces })) };
}

describe("createFaceTracker", () => {
    it("loads the face model on the GPU for one face and returns the first face's landmarks", async () => {
        const first = [{ x: 0.1, y: 0.2 }];
        const model = fakeLandmarker([first, [{ x: 0.9, y: 0.9 }]]);
        vision.createFaceLandmarker.mockResolvedValue(model);

        const tracker = await createFaceTracker("https://assets.example.com/mp");

        expect(vision.forVisionTasks).toHaveBeenCalledWith("https://assets.example.com/mp/wasm");
        expect(vision.createFaceLandmarker.mock.calls[0][0]).toEqual({ fileset: true });
        expect(vision.createFaceLandmarker.mock.calls[0][1]).toEqual({
            baseOptions: { modelAssetPath: "https://assets.example.com/mp/face_landmarker.task", delegate: "GPU" },
            runningMode: "VIDEO",
            numFaces: 1,
        });
        expect(tracker.detect(FRAME, 10)).toBe(first);
        expect(model.detectForVideo.mock.calls[0]).toEqual([FRAME, 10]);
    });

    it("uses the CDN urls with no assets url", async () => {
        vision.createFaceLandmarker.mockResolvedValue(fakeLandmarker([]));
        await createFaceTracker();
        expect(vision.forVisionTasks).toHaveBeenCalledWith(modelUrls().wasm);
        expect(vision.createFaceLandmarker.mock.calls[0][1].baseOptions.modelAssetPath).toBe(modelUrls().face);
    });

    it("returns null when there is no face", async () => {
        vision.createFaceLandmarker.mockResolvedValue(fakeLandmarker([]));
        const tracker = await createFaceTracker();
        expect(tracker.detect(FRAME, 1)).toBeNull();
    });

    it("falls back to the CPU when the GPU delegate can't be created", async () => {
        vision.createFaceLandmarker.mockRejectedValueOnce(new Error("no WebGL")).mockResolvedValueOnce(fakeLandmarker([[{ x: 0, y: 0 }]]));

        const tracker = await createFaceTracker();

        expect(vision.createFaceLandmarker.mock.calls.map((call) => call[1].baseOptions.delegate)).toEqual(["GPU", "CPU"]);
        expect(tracker.detect(FRAME, 1)).toEqual([{ x: 0, y: 0 }]);
    });

    it("hands MediaPipe strictly increasing timestamps, even for repeated or earlier ones", async () => {
        const model = fakeLandmarker([]);
        vision.createFaceLandmarker.mockResolvedValue(model);
        const tracker = await createFaceTracker();

        for (const timestamp of [7, 7, 7, 3, 40]) {
            tracker.detect(FRAME, timestamp);
        }

        expect(model.detectForVideo.mock.calls.map((call) => (call as unknown[])[1])).toEqual([7, 8, 9, 10, 40]);
    });

    it("shares one model per assets url, and loads a different one for a different url", async () => {
        vision.createFaceLandmarker.mockImplementation(async () => fakeLandmarker([]));

        const a = createFaceTracker("https://a.example.com");
        expect(createFaceTracker("https://a.example.com")).toBe(a);
        await a;
        expect(createFaceTracker("https://a.example.com")).toBe(a);
        const b = createFaceTracker("https://b.example.com");
        expect(b).not.toBe(a);
        await b;
        const cdn = createFaceTracker();
        expect(createFaceTracker(undefined)).toBe(cdn);
        await cdn;

        expect(vision.createFaceLandmarker).toHaveBeenCalledTimes(3);
    });

    it("keeps the face and segmentation caches separate", async () => {
        vision.createSegmenter.mockImplementation(async () => fakeSegmenter(["person"], [fakeMask([1])]));
        vision.createFaceLandmarker.mockImplementation(async () => fakeLandmarker([]));
        await createPersonSegmenter();
        await createFaceTracker();
        expect(vision.createSegmenter).toHaveBeenCalledTimes(1);
        expect(vision.createFaceLandmarker).toHaveBeenCalledTimes(1);
    });

    it("forgets a failed load, so the next attempt tries again", async () => {
        vision.createFaceLandmarker.mockRejectedValue(new Error("offline"));
        await expect(createFaceTracker()).rejects.toThrow("offline");
        expect(vision.createFaceLandmarker).toHaveBeenCalledTimes(2);

        vision.createFaceLandmarker.mockReset().mockResolvedValue(fakeLandmarker([]));
        await expect(createFaceTracker()).resolves.toBeDefined();
        expect(vision.createFaceLandmarker).toHaveBeenCalledTimes(1);
    });

    it("resetModelCache makes the next call load afresh", async () => {
        vision.createFaceLandmarker.mockImplementation(async () => fakeLandmarker([]));
        const first = createFaceTracker();
        await first;
        resetModelCache();
        expect(createFaceTracker()).not.toBe(first);
    });
});
