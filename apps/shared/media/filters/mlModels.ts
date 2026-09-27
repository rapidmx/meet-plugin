///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The two machine-learning models behind the filters, run in the browser with MediaPipe Tasks:
 *
 * - **Person segmentation** (`createPersonSegmenter`) - which pixels are the participant: what the background
 * blur and the custom background need.
 * - **Face landmarks** (`createFaceTracker`) - where the participant's face is: what the accessories need.
 *
 * Nothing here is loaded until a participant turns a filter on that needs it, and each model is loaded once and
 * shared. The MediaPipe library itself is `import()`ed on demand for the same reason - a participant who never uses a
 * filter never downloads it.
 *
 * **Where the assets come from**: by default the WebAssembly runtime is fetched from jsDelivr and the models from
 * Google's public MediaPipe model bucket. That is a request to a third party, so an administrator can host them
 * instead (the `mail:videoconf:effects:assets_url` setting, delivered by the join response): the runtime's `wasm/`
 * directory from the `@mediapipe/tasks-vision` package, plus `selfie_segmenter.tflite` and `face_landmarker.task`,
 * all under one base URL.
 *
 * Everything the rest of the pipeline needs from MediaPipe is behind the small `PersonSegmenter`/`FaceTracker`
 * interfaces, so `VideoFilterProcessor` never touches the library and its tests use fakes.
 */
import type { FaceLandmark } from "./accessories.js";

/** Must match the installed `@mediapipe/tasks-vision` (a test checks): the `.wasm` fetched at runtime has to be the
 * version the JavaScript was built against. */
export const MEDIAPIPE_VERSION = "1.0.1";

const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const CDN_SEGMENTER_MODEL =
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
const CDN_FACE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export interface ModelUrls {
    wasm: string;
    segmenter: string;
    face: string;
}

/** Where to fetch the runtime and models from - the CDN when `assetsUrl` is empty, else under `assetsUrl`. */
export function modelUrls(assetsUrl?: string): ModelUrls {
    if (!assetsUrl) {
        return { wasm: CDN_WASM, segmenter: CDN_SEGMENTER_MODEL, face: CDN_FACE_MODEL };
    }
    const base = assetsUrl.replace(/\/+$/, "");
    return { wasm: `${base}/wasm`, segmenter: `${base}/selfie_segmenter.tflite`, face: `${base}/face_landmarker.task` };
}

/** How likely each pixel of a frame is to be the participant, 0-1. */
export interface PersonMask {
    width: number;
    height: number;
    confidence: Float32Array;
}

export interface PersonSegmenter {
    /** Segments `frame`, or `null` when the model produced nothing for it. */
    segment(frame: HTMLVideoElement, timestampMs: number): PersonMask | null;
}

export interface FaceTracker {
    /** The landmarks of the first face in `frame`, or `null` when there is none. */
    detect(frame: HTMLVideoElement, timestampMs: number): FaceLandmark[] | null;
}

/** Which of a segmentation model's masks is the person: the one labelled as such (the selfie model's only label is
 * "selfie"), else the last (models list the background first). */
export function personMaskIndex(labels: string[], maskCount: number): number {
    const index = labels.findIndex((label) => /person|selfie|foreground/i.test(label));
    return index >= 0 && index < maskCount ? index : maskCount - 1;
}

/** MediaPipe rejects a frame whose timestamp isn't later than the last one it saw. */
function monotonic(): (timestampMs: number) => number {
    let last = -1;
    return (timestampMs) => {
        last = Math.max(timestampMs, last + 1);
        return last;
    };
}

type Vision = typeof import("@mediapipe/tasks-vision");

/** Creates a task on the GPU, or on the CPU when the GPU can't run it (no WebGL, or a driver that refuses). */
async function withFallback<T>(create: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
    try {
        return await create("GPU");
    } catch {
        return create("CPU");
    }
}

async function loadSegmenter(assetsUrl?: string): Promise<PersonSegmenter> {
    const urls = modelUrls(assetsUrl);
    const vision: Vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(urls.wasm);
    const segmenter = await withFallback((delegate) =>
        vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: urls.segmenter, delegate },
            runningMode: "VIDEO",
            outputConfidenceMasks: true,
            outputCategoryMask: false,
        }),
    );
    const labels = segmenter.getLabels();
    const stamp = monotonic();
    return {
        segment(frame, timestampMs) {
            let mask: PersonMask | null = null;
            segmenter.segmentForVideo(frame, stamp(timestampMs), (result) => {
                const masks = result.confidenceMasks;
                if (!masks?.length) {
                    return;
                }
                const person = masks[personMaskIndex(labels, masks.length)];
                // The mask is only valid inside this callback, so it is copied out.
                mask = { width: person.width, height: person.height, confidence: new Float32Array(person.getAsFloat32Array()) };
            });
            return mask;
        },
    };
}

async function loadFaceTracker(assetsUrl?: string): Promise<FaceTracker> {
    const urls = modelUrls(assetsUrl);
    const vision: Vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(urls.wasm);
    const landmarker = await withFallback((delegate) =>
        vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: urls.face, delegate },
            runningMode: "VIDEO",
            numFaces: 1,
        }),
    );
    const stamp = monotonic();
    return {
        detect(frame, timestampMs) {
            return landmarker.detectForVideo(frame, stamp(timestampMs)).faceLandmarks[0] ?? null;
        },
    };
}

const segmenters = new Map<string, Promise<PersonSegmenter>>();
const faceTrackers = new Map<string, Promise<FaceTracker>>();

/** Loads `load` once per key, and forgets a failure so the next attempt (a retry) tries again. */
function shared<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let pending = cache.get(key);
    if (!pending) {
        pending = load();
        cache.set(key, pending);
        pending.catch(() => cache.delete(key));
    }
    return pending;
}

/** The person-segmentation model, loaded on first use and shared from then on. Rejects if it can't be loaded. */
export function createPersonSegmenter(assetsUrl?: string): Promise<PersonSegmenter> {
    return shared(segmenters, assetsUrl ?? "", () => loadSegmenter(assetsUrl));
}

/** The face-landmark model, loaded on first use and shared from then on. Rejects if it can't be loaded. */
export function createFaceTracker(assetsUrl?: string): Promise<FaceTracker> {
    return shared(faceTrackers, assetsUrl ?? "", () => loadFaceTracker(assetsUrl));
}

/** Forgets every loaded model - for tests. */
export function resetModelCache(): void {
    segmenters.clear();
    faceTrackers.clear();
}
