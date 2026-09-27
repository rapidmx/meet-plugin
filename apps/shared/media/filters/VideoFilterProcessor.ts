///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Turns the camera's `MediaStreamTrack` into a *filtered* one: frames from the camera are drawn onto a canvas, put
 * through the chosen filters, and the canvas's `captureStream()` track is what the rest of the app sends to the call.
 * `useLocalMedia()` owns one of these while any filter is on and swaps it in for the camera track, so the lobby
 * preview, the peer connections and the WebSocket relay all get the filtered picture without knowing about it.
 *
 * Per frame: the background (untouched, or blurred / replaced behind the person-segmentation mask), then the colour
 * effect over the whole picture, then the face accessory on top - see `filterTypes.ts`.
 *
 * - **Fails closed.** A participant who asked for a hidden background must never be shown with their real one - not
 * while the segmentation model is still loading, and not if it can't be loaded. Until the mask is available the frame
 * is the background alone (the blurred or replacement picture, no person), and `onStatus` reports the load and any
 * failure so the UI can say why. Accessories don't matter that way: without the face model there simply is no accessory.
 * - **Timing.** Frames are driven by a timer rather than `requestAnimationFrame`, which stops entirely in a
 * background tab - the call would freeze for everyone else the moment the participant switched to another window.
 * Browsers still slow a background tab's timers, so a filtered picture can drop to a low frame rate there.
 *
 * Everything browser-facing (canvases, the video element, the models) comes in through `deps`, so the tests drive a
 * processor with fakes.
 */
import { type FaceGeometry, type FaceLandmark, drawAccessory, faceGeometry } from "./accessories.js";
import { type Accessory, type VideoFilters, needsFace, needsSegmentation } from "./filterTypes.js";
import { type FaceTracker, type PersonMask, type PersonSegmenter, createFaceTracker, createPersonSegmenter } from "./mlModels.js";
import { applyGrayscale, applyNightVision, applySepia, maskToAlpha } from "./pixelEffects.js";

/** A picture to show behind the participant. */
export interface BackgroundPicture {
    source: CanvasImageSource;
    width: number;
    height: number;
}

export interface FilterStatus {
    /** A model the current filters need is still downloading. */
    loading: boolean;
    /** Why a filter isn't fully working, ready to show - `null` when all is well. */
    error: string | null;
}

export interface ProcessorDeps {
    createCanvas(): HTMLCanvasElement;
    createVideo(): HTMLVideoElement;
    createSegmenter(assetsUrl?: string): Promise<PersonSegmenter>;
    createFaceTracker(assetsUrl?: string): Promise<FaceTracker>;
    now(): number;
}

export interface VideoFilterProcessorOptions {
    /** The camera's track. The processor only reads it - stopping it stays with whoever owns it. */
    source: MediaStreamTrack;
    filters: VideoFilters;
    backgroundImage?: BackgroundPicture | null;
    /** Where the models are hosted, when not on the default CDN - see `mlModels.ts`. */
    assetsUrl?: string;
    onStatus?: (status: FilterStatus) => void;
    frameRate?: number;
    deps?: Partial<ProcessorDeps>;
}

const DEFAULT_FRAME_RATE = 30;
/** The background is blurred by drawing the frame at 1/this size and scaling it back up. */
const BLUR_DIVISOR = 12;
/** The picture is pixelated into about this many blocks across. */
const PIXEL_BLOCKS = 80;
/** How many frames in a row without a detected face before the accessory is taken off - a face is briefly lost when
 * the head turns, and the accessory shouldn't flicker for that. */
const FACE_HOLD_FRAMES = 6;

const SEGMENTATION_ERROR =
    "The background effect couldn't be loaded, so your background stays hidden. Turn the effect off to show your camera.";
const FACE_ERROR = "The face effect couldn't be loaded.";
const RENDER_ERROR = "Video effects stopped working.";

type ModelState = "idle" | "loading" | "ready" | "failed";

interface Layer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
}

const PIXEL_EFFECTS = { bw: applyGrayscale, sepia: applySepia, "night-vision": applyNightVision };

const DEFAULT_DEPS: ProcessorDeps = {
    createCanvas: () => document.createElement("canvas"),
    createVideo: () => document.createElement("video"),
    createSegmenter: createPersonSegmenter,
    createFaceTracker,
    now: () => performance.now(),
};

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
        throw new Error("This browser can't draw video effects.");
    }
    return ctx;
}

export class VideoFilterProcessor {
    /** The filtered video - what to send in place of the camera's track. */
    readonly track: MediaStreamTrack;

    private readonly deps: ProcessorDeps;
    private readonly assetsUrl?: string;
    private readonly onStatus?: (status: FilterStatus) => void;
    private readonly interval: number;
    private readonly video: HTMLVideoElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly layers = new Map<string, Layer>();

    private filters: VideoFilters;
    private backgroundImage: BackgroundPicture | null;
    private stopped = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    private segmenter: PersonSegmenter | null = null;
    private segmenterState: ModelState = "idle";
    private faceTracker: FaceTracker | null = null;
    private faceState: ModelState = "idle";
    private lastFace: FaceLandmark[] | null = null;
    private framesWithoutFace = 0;
    private maskImage: ImageData | null = null;
    private renderFailed = false;
    private status: FilterStatus = { loading: false, error: null };

    constructor(options: VideoFilterProcessorOptions) {
        this.deps = { ...DEFAULT_DEPS, ...options.deps };
        this.filters = options.filters;
        this.backgroundImage = options.backgroundImage ?? null;
        this.assetsUrl = options.assetsUrl;
        this.onStatus = options.onStatus;
        const frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
        this.interval = 1000 / frameRate;

        this.canvas = this.deps.createCanvas();
        this.ctx = context2d(this.canvas);
        this.track = this.canvas.captureStream(frameRate).getVideoTracks()[0];

        this.video = this.deps.createVideo();
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.srcObject = new MediaStream([options.source]);
        void this.video.play().catch(() => undefined);

        this.syncModels();
        this.publishStatus();
        this.tick();
    }

    /** Changes the filters (and the background picture) without interrupting the video. Also retries a model that failed
     * to load, so choosing a filter again is a retry. */
    update(filters: VideoFilters, backgroundImage: BackgroundPicture | null): void {
        this.filters = filters;
        this.backgroundImage = backgroundImage;
        this.syncModels(true);
        this.publishStatus();
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        this.video.pause();
        this.video.srcObject = null;
        this.track.stop();
    }

    private syncModels(retry = false): void {
        if (needsSegmentation(this.filters) && (this.segmenterState === "idle" || (retry && this.segmenterState === "failed"))) {
            this.segmenterState = "loading";
            this.deps.createSegmenter(this.assetsUrl).then(
                (segmenter) => {
                    this.segmenter = segmenter;
                    this.segmenterState = "ready";
                    this.publishStatus();
                },
                () => {
                    this.segmenterState = "failed";
                    this.publishStatus();
                },
            );
        }
        if (needsFace(this.filters) && (this.faceState === "idle" || (retry && this.faceState === "failed"))) {
            this.faceState = "loading";
            this.deps.createFaceTracker(this.assetsUrl).then(
                (tracker) => {
                    this.faceTracker = tracker;
                    this.faceState = "ready";
                    this.publishStatus();
                },
                () => {
                    this.faceState = "failed";
                    this.publishStatus();
                },
            );
        }
    }

    private publishStatus(): void {
        if (this.stopped) {
            return;
        }
        const wantsSegmentation = needsSegmentation(this.filters);
        const wantsFace = needsFace(this.filters);
        let error: string | null = null;
        if (wantsSegmentation && this.segmenterState === "failed") {
            error = SEGMENTATION_ERROR;
        } else if (wantsFace && this.faceState === "failed") {
            error = FACE_ERROR;
        } else if (this.renderFailed) {
            error = RENDER_ERROR;
        }
        const loading = (wantsSegmentation && this.segmenterState === "loading") || (wantsFace && this.faceState === "loading");
        if (loading !== this.status.loading || error !== this.status.error) {
            this.status = { loading, error };
            this.onStatus?.(this.status);
        }
    }

    private tick = (): void => {
        if (this.stopped) {
            return;
        }
        const started = this.deps.now();
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
            try {
                this.render(started);
                if (this.renderFailed) {
                    // Drawing works again - a single bad frame doesn't leave the warning up.
                    this.renderFailed = false;
                    this.publishStatus();
                }
            } catch {
                // A frame that can't be drawn is skipped; the loop carries on, and the participant is told.
                if (!this.renderFailed) {
                    this.renderFailed = true;
                    this.publishStatus();
                }
            }
        }
        this.timer = setTimeout(this.tick, Math.max(0, this.interval - (this.deps.now() - started)));
    };

    /** A scratch canvas of the given size, kept between frames. */
    private layer(name: string, width: number, height: number): Layer {
        let layer = this.layers.get(name);
        if (!layer) {
            const canvas = this.deps.createCanvas();
            layer = { canvas, ctx: context2d(canvas) };
            this.layers.set(name, layer);
        }
        if (layer.canvas.width !== width || layer.canvas.height !== height) {
            layer.canvas.width = width;
            layer.canvas.height = height;
        }
        return layer;
    }

    private render(now: number): void {
        const { video, canvas, ctx, filters } = this;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }

        if (filters.background === "none") {
            ctx.drawImage(video, 0, 0, width, height);
        } else {
            this.drawBackground(now, width, height);
        }
        this.applyEffect(width, height);
        if (filters.accessory !== "none") {
            this.paintAccessory(filters.accessory, now, width, height);
        }
    }

    /** The background, then - once the segmentation model is ready - the participant on top of it. */
    private drawBackground(now: number, width: number, height: number): void {
        const { video, ctx } = this;
        const picture = this.backgroundImage;
        if (this.filters.background === "image" && picture) {
            const scale = Math.max(width / picture.width, height / picture.height);
            const drawnWidth = picture.width * scale;
            const drawnHeight = picture.height * scale;
            ctx.drawImage(picture.source, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
        } else {
            // Also the stand-in for a "custom image" background that has no image: blurred, never the real room.
            const small = this.layer("blur", Math.ceil(width / BLUR_DIVISOR), Math.ceil(height / BLUR_DIVISOR));
            small.ctx.imageSmoothingQuality = "high";
            small.ctx.drawImage(video, 0, 0, small.canvas.width, small.canvas.height);
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(small.canvas, 0, 0, width, height);
        }

        const mask = this.segment(now);
        if (!mask) {
            return;
        }
        const maskLayer = this.layer("mask", mask.width, mask.height);
        let image = this.maskImage;
        if (!image || image.width !== mask.width || image.height !== mask.height) {
            image = this.maskImage = maskLayer.ctx.createImageData(mask.width, mask.height);
        }
        maskToAlpha(mask.confidence, image.data);
        maskLayer.ctx.putImageData(image, 0, 0);

        const person = this.layer("person", width, height);
        person.ctx.globalCompositeOperation = "source-over";
        person.ctx.clearRect(0, 0, width, height);
        person.ctx.drawImage(maskLayer.canvas, 0, 0, width, height);
        person.ctx.globalCompositeOperation = "source-in";
        person.ctx.drawImage(video, 0, 0, width, height);
        person.ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(person.canvas, 0, 0);
    }

    private segment(now: number): PersonMask | null {
        if (!this.segmenter) {
            return null;
        }
        try {
            return this.segmenter.segment(this.video, now);
        } catch {
            this.segmenter = null;
            this.segmenterState = "failed";
            this.publishStatus();
            return null;
        }
    }

    private applyEffect(width: number, height: number): void {
        const { ctx } = this;
        const effect = this.filters.effect;
        if (effect === "pixelate") {
            const small = this.layer("pixel", PIXEL_BLOCKS, Math.ceil((height / width) * PIXEL_BLOCKS));
            small.ctx.drawImage(this.canvas, 0, 0, small.canvas.width, small.canvas.height);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(small.canvas, 0, 0, width, height);
            ctx.imageSmoothingEnabled = true;
        } else if (effect !== "none") {
            const pixels = ctx.getImageData(0, 0, width, height);
            PIXEL_EFFECTS[effect](pixels.data);
            ctx.putImageData(pixels, 0, 0);
        }
    }

    private paintAccessory(accessory: Exclude<Accessory, "none">, now: number, width: number, height: number): void {
        const face = this.trackFace(now);
        const geometry: FaceGeometry | null = face ? faceGeometry(face, width, height) : null;
        if (geometry) {
            drawAccessory(this.ctx, accessory, geometry);
        }
    }

    /** The face's landmarks for this frame - the last known ones for a few frames after it is lost. */
    private trackFace(now: number): FaceLandmark[] | null {
        if (!this.faceTracker) {
            return null;
        }
        let found: FaceLandmark[] | null = null;
        try {
            found = this.faceTracker.detect(this.video, now);
        } catch {
            this.faceTracker = null;
            this.faceState = "failed";
            this.publishStatus();
            return null;
        }
        if (found) {
            this.lastFace = found;
            this.framesWithoutFace = 0;
        } else if (++this.framesWithoutFace > FACE_HOLD_FRAMES) {
            this.lastFace = null;
        }
        return this.lastFace;
    }
}
