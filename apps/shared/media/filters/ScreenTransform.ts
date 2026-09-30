///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Rotates and/or flips a screen-share track before it's sent, so everyone - the presenter included, since their own
 * preview is this same processor's output - sees it the right way round, rather than however the browser's own
 * window/screen capture happened to hand it back. Window capture in particular has a known, driver/compositor-
 * dependent history of occasionally returning upside-down or sideways frames for a specific captured window; this
 * is the presenter's own manual correction for that, not an automatic fix (there's no reliable way to detect it
 * from pixels alone).
 *
 * Reuses `VideoFilterProcessor.ts`'s own shape (a hidden `<video>` playing the source track, a canvas redrawn on a
 * timer, `captureStream()` exposing the result) but far simpler: no models to load, no per-frame throttling to
 * worry about, just a transform applied on each draw. Entirely independent of the camera pipeline - `useLocalMedia`'s
 * filters never see the screen-share track, and this never touches the camera's.
 */

/** A rotation in degrees clockwise. */
export type ScreenRotation = 0 | 90 | 180 | 270;

export interface ScreenTransformState {
    rotation: ScreenRotation;
    /** Mirrored left-right, applied before the rotation (so "flip, then turn" - the usual photo-editing order). */
    flipped: boolean;
}

export const NO_SCREEN_TRANSFORM: ScreenTransformState = { rotation: 0, flipped: false };

/** The next rotation clockwise, wrapping back to 0 after 270. */
export function rotateClockwise(state: ScreenTransformState): ScreenTransformState {
    const next: Record<ScreenRotation, ScreenRotation> = { 0: 90, 90: 180, 180: 270, 270: 0 };
    return { ...state, rotation: next[state.rotation] };
}

export interface ScreenTransformDeps {
    createCanvas(): HTMLCanvasElement;
    createVideo(): HTMLVideoElement;
    now(): number;
}

/** Screen share doesn't need the camera's 30fps - matches `VIDEO_FPS`, what the relay's own `VideoSender` already
 * encodes a shared screen at. */
const DEFAULT_FRAME_RATE = 15;

const DEFAULT_DEPS: ScreenTransformDeps = {
    createCanvas: () => document.createElement("canvas"),
    createVideo: () => document.createElement("video"),
    now: () => performance.now(),
};

export interface ScreenTransformOptions {
    /** The screen-share track. Only ever read - stopping it stays with whoever owns it (`_CallView.tsx`). */
    source: MediaStreamTrack;
    state?: ScreenTransformState;
    frameRate?: number;
    deps?: Partial<ScreenTransformDeps>;
}

export class ScreenTransformProcessor {
    /** The transformed video - what to send in place of the screen track's own. */
    readonly track: MediaStreamTrack;

    private readonly deps: ScreenTransformDeps;
    private readonly interval: number;
    private readonly video: HTMLVideoElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;

    private state: ScreenTransformState;
    private stopped = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(options: ScreenTransformOptions) {
        this.deps = { ...DEFAULT_DEPS, ...options.deps };
        this.state = options.state ?? NO_SCREEN_TRANSFORM;
        const frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
        this.interval = 1000 / frameRate;

        this.canvas = this.deps.createCanvas();
        const ctx = this.canvas.getContext("2d");
        if (!ctx) {
            throw new Error("This browser can't rotate the shared screen.");
        }
        this.ctx = ctx;
        this.track = this.canvas.captureStream(frameRate).getVideoTracks()[0];

        this.video = this.deps.createVideo();
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.srcObject = new MediaStream([options.source]);
        void this.video.play().catch(() => undefined);

        this.tick();
    }

    /** Changes the rotation/flip without interrupting the video. */
    setState(state: ScreenTransformState): void {
        this.state = state;
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        this.video.pause();
        this.video.srcObject = null;
        this.track.stop();
    }

    private tick = (): void => {
        if (this.stopped) {
            return;
        }
        const started = this.deps.now();
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
            this.render();
        }
        this.timer = setTimeout(this.tick, Math.max(0, this.interval - (this.deps.now() - started)));
    };

    private render(): void {
        const { video, canvas, ctx, state } = this;
        const sourceWidth = video.videoWidth;
        const sourceHeight = video.videoHeight;
        // A quarter turn swaps which way is "wide" - the canvas (and so the track everyone actually receives) must
        // match, or the picture is squashed into the untransformed aspect ratio.
        const swapped = state.rotation === 90 || state.rotation === 270;
        const width = swapped ? sourceHeight : sourceWidth;
        const height = swapped ? sourceWidth : sourceHeight;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }

        if (state.rotation === 0 && !state.flipped) {
            ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight);
            return;
        }
        ctx.save();
        ctx.translate(width / 2, height / 2);
        ctx.rotate((state.rotation * Math.PI) / 180);
        if (state.flipped) {
            ctx.scale(-1, 1);
        }
        ctx.drawImage(video, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
        ctx.restore();
    }
}
