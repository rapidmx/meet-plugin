///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { KIND_VIDEO } from "../../../../apps/shared/relay/frames.js";
import {
    fitSize,
    VIDEO_BITRATE,
    VIDEO_FPS,
    VIDEO_KEY_FRAME_INTERVAL,
    VIDEO_MAX_ENCODE_QUEUE,
    VideoSender,
} from "../../../../apps/shared/relay/VideoSender.js";
import { createFakeRelayEnv, fakeChunk, track, last } from "./relayFakes.js";

function setup() {
    const fake = createFakeRelayEnv();
    const published: { key: boolean; data: number[]; timestampMs: number }[] = [];
    const state = { canSend: true, publishResult: true };
    const sender = new VideoSender({
        env: fake.env,
        publish: (kind, key, data, timestampMs) => {
            expect(kind).toBe(KIND_VIDEO);
            published.push({ key, data: Array.from(data), timestampMs });
            return state.publishResult;
        },
        canSend: () => state.canSend,
    });
    return { fake, sender, published, state };
}

/** A sender that is capturing a 640x480 track and has encoded its first (key) frame. */
function running() {
    const s = setup();
    s.sender.setTrack(track("video"));
    s.sender.setActive(true);
    s.fake.tick();
    return { ...s, video: s.fake.videos[0], canvas: s.fake.canvases[0], encoder: s.fake.videoEncoders[0] };
}

describe("fitSize", () => {
    it("shrinks to fit 480x360 keeping the aspect ratio, with even dimensions", () => {
        expect(fitSize(1280, 720)).toEqual({ width: 480, height: 270 });
        expect(fitSize(1920, 1080)).toEqual({ width: 480, height: 270 });
        expect(fitSize(640, 480)).toEqual({ width: 480, height: 360 });
        expect(fitSize(720, 1280)).toEqual({ width: 202, height: 360 });
        expect(fitSize(1000, 1)).toEqual({ width: 480, height: 2 });
    });

    it("never enlarges a small picture", () => {
        expect(fitSize(320, 240)).toEqual({ width: 320, height: 240 });
        expect(fitSize(321, 241)).toEqual({ width: 322, height: 242 });
    });
});

describe("VideoSender capture", () => {
    it("builds nothing until it is both active and has a track", () => {
        const { fake, sender } = setup();
        sender.setActive(true);
        expect(fake.videos).toHaveLength(0);
        sender.setActive(false);
        sender.setTrack(track("video"));
        expect(fake.videos).toHaveLength(0);
    });

    it("plays the track in a muted inline video and samples it at 15 fps", () => {
        const { fake, sender } = setup();
        const t = track("video");
        sender.setTrack(t);
        sender.setActive(true);
        const video = fake.videos[0];
        expect(video.muted).toBe(true);
        expect(video.playsInline).toBe(true);
        expect(video.autoplay).toBe(true);
        expect(video.playCalls).toBe(1);
        expect(last(fake.mediaStreams)?.tracks).toEqual([t]);
        expect(video.srcObject).toBe(last(fake.mediaStreams)?.stream);
        expect([...fake.intervals.values()].map((i) => i.ms)).toEqual([Math.round(1000 / VIDEO_FPS)]);
    });

    it("tolerates play() rejecting or returning nothing", async () => {
        const rejecting = setup();
        rejecting.sender.setTrack(track("video"));
        rejecting.sender.setActive(true);
        rejecting.fake.videos[0].playResult = "reject";
        rejecting.sender.setTrack(track("video", "other"));
        await Promise.resolve();
        expect(rejecting.fake.videos[0].playCalls).toBe(2);

        const silent = setup();
        silent.sender.setTrack(track("video"));
        silent.sender.setActive(true);
        silent.fake.videos[0].playResult = "undefined";
        expect(() => silent.sender.setTrack(track("video", "other"))).not.toThrow();
    });

    it("stops the timer and releases the video when stopped, and again is a no-op", () => {
        const { fake, sender, video, encoder } = running();
        sender.setActive(false);
        expect(fake.intervals.size).toBe(0);
        expect(video.pauseCalls).toBe(1);
        expect(video.srcObject).toBeNull();
        expect(encoder.closed).toBe(true);
        sender.setActive(false);
        sender.setTrack(null);
        expect(video.pauseCalls).toBe(1);
    });

    it("stops when the track is removed", () => {
        const { fake, sender } = running();
        sender.setTrack(null);
        expect(fake.intervals.size).toBe(0);
    });

    it("gives up quietly when the browser cannot make a video element, a canvas or a 2D context", () => {
        for (const flag of ["videoElementThrows", "canvasThrows"] as const) {
            const { fake, sender } = setup();
            fake.behavior[flag] = true;
            sender.setTrack(track("video"));
            expect(() => sender.setActive(true)).not.toThrow();
            expect(fake.intervals.size).toBe(0);
        }
        const { fake, sender } = setup();
        fake.behavior.canvasHasContext = false;
        sender.setTrack(track("video"));
        sender.setActive(true);
        expect(fake.intervals.size).toBe(0);
        expect(fake.videos[0].srcObject).toBeUndefined();
        // Retries when asked again.
        fake.behavior.canvasHasContext = true;
        sender.setActive(false);
        sender.setActive(true);
        expect(fake.intervals.size).toBe(1);
    });
});

describe("VideoSender encoding", () => {
    it("scales onto a canvas, encodes it as a forced key frame and closes the frame", () => {
        const { fake, encoder, video, canvas } = running();
        expect(encoder.configured).toEqual([
            { codec: "vp8", width: 480, height: 360, bitrate: VIDEO_BITRATE, framerate: VIDEO_FPS, latencyMode: "realtime" },
        ]);
        expect([canvas.width, canvas.height]).toEqual([480, 360]);
        expect(canvas.drawn).toEqual([{ source: video, args: [0, 0, 480, 360] }]);
        expect(fake.videoFrames).toHaveLength(1);
        expect(fake.videoFrames[0].closed).toBe(true);
        expect(encoder.inputs).toEqual([fake.videoFrames[0]]);
        expect(encoder.options).toEqual([{ keyFrame: true }]);
    });

    it("stamps frames in microseconds from the start of capture", () => {
        const { fake } = running();
        fake.clock.now += 200;
        fake.tick();
        expect(fake.videoFrames[1].timestampUs).toBe(200_000);
    });

    it("forces a key frame every 30 frames and not in between", () => {
        const { fake, encoder } = running();
        fake.tick(VIDEO_KEY_FRAME_INTERVAL);
        const keys = (encoder.options as { keyFrame: boolean }[]).map((o) => o.keyFrame);
        expect(keys).toHaveLength(31);
        expect(keys.filter(Boolean)).toHaveLength(2);
        expect(keys[0]).toBe(true);
        expect(keys[1]).toBe(false);
        expect(keys[30]).toBe(true);
    });

    it("waits until the video has a picture", () => {
        const { fake, sender } = setup();
        sender.setTrack(track("video"));
        sender.setActive(true);
        const video = fake.videos[0];
        for (const [readyState, width, height] of [
            [1, 640, 480],
            [4, 0, 480],
            [4, 640, 0],
        ]) {
            video.readyState = readyState;
            video.videoWidth = width;
            video.videoHeight = height;
            fake.tick();
        }
        expect(fake.videoEncoders).toHaveLength(0);
        video.readyState = 4;
        video.videoWidth = 640;
        video.videoHeight = 480;
        fake.tick();
        expect(fake.videoFrames).toHaveLength(1);
    });

    it("idles, and forces a key frame for whenever it resumes, while the socket cannot take frames", () => {
        const { fake, encoder, state } = running();
        fake.tick(3);
        state.canSend = false;
        fake.tick(2);
        expect(fake.videoFrames).toHaveLength(4);
        state.canSend = true;
        fake.tick();
        expect(last(encoder.options as { keyFrame: boolean }[])).toEqual({ keyFrame: true });
    });

    it("skips a tick when the encoder is backed up", () => {
        const { fake, encoder } = running();
        encoder.queueSize = VIDEO_MAX_ENCODE_QUEUE + 1;
        fake.tick();
        expect(fake.videoFrames).toHaveLength(1);
        encoder.queueSize = VIDEO_MAX_ENCODE_QUEUE;
        fake.tick();
        expect(fake.videoFrames).toHaveLength(2);
    });

    it("reconfigures and forces a key frame when the picture size changes", () => {
        const { fake, video, encoder, canvas } = running();
        fake.tick();
        video.videoWidth = 1920;
        video.videoHeight = 1080;
        fake.tick();
        expect(encoder.closed).toBe(true);
        const next = fake.videoEncoders[1];
        expect(next.configured[0]).toMatchObject({ width: 480, height: 270 });
        expect(next.options).toEqual([{ keyFrame: true }]);
        expect([canvas.width, canvas.height]).toEqual([480, 270]);
    });

    it("keeps the loop, re-points the video and forces a key frame when the track is replaced", () => {
        const { fake, sender, video, encoder } = running();
        fake.tick();
        const screen = track("video", "screen");
        sender.setTrack(screen);
        expect(fake.videos).toHaveLength(1);
        expect(fake.intervals.size).toBe(1);
        expect(video.playCalls).toBe(2);
        expect(last(fake.mediaStreams)?.tracks).toEqual([screen]);
        fake.tick();
        expect(last(encoder.options as { keyFrame: boolean }[])).toEqual({ keyFrame: true });
        // The same track again changes nothing.
        sender.setTrack(screen);
        expect(video.playCalls).toBe(2);
    });

    it("forces a key frame after a frame could not be sent", () => {
        const { fake, encoder, state } = running();
        fake.tick();
        state.publishResult = false;
        encoder.emit(fakeChunk([1], "delta", 66_000));
        state.publishResult = true;
        fake.tick();
        expect(last(encoder.options as { keyFrame: boolean }[])).toEqual({ keyFrame: true });
    });

    it("publishes encoded chunks with their key flag and capture-clock timestamp", () => {
        const { encoder, published } = running();
        encoder.emit(fakeChunk([1, 2], "key", 0));
        encoder.emit(fakeChunk([3], "delta", 66_000));
        expect(published).toEqual([
            { key: true, data: [1, 2], timestampMs: 1000 },
            { key: false, data: [3], timestampMs: 1066 },
        ]);
    });

    it("discards the encoder when encode() throws, closes the frame and recovers with a key frame", () => {
        const { fake, encoder } = running();
        fake.behavior.videoEncoder.useThrows = true;
        fake.tick();
        expect(fake.videoFrames[1].closed).toBe(true);
        expect(encoder.closed).toBe(true);
        fake.behavior.videoEncoder.useThrows = false;
        fake.tick();
        expect(fake.videoEncoders).toHaveLength(2);
        expect(fake.videoEncoders[1].options).toEqual([{ keyFrame: true }]);
    });

    it("discards the encoder when a VideoFrame cannot be built", () => {
        const { fake, encoder } = running();
        fake.behavior.videoFrameThrows = true;
        fake.tick();
        expect(encoder.closed).toBe(true);
    });

    it("replaces the encoder after an error callback with a key frame, and never throws out of it", () => {
        const { fake, encoder } = running();
        fake.behavior.videoEncoder.closeThrows = true;
        expect(() => encoder.fail()).not.toThrow();
        fake.behavior.videoEncoder.closeThrows = false;
        fake.tick();
        expect(fake.videoEncoders).toHaveLength(2);
        expect(fake.videoEncoders[1].options).toEqual([{ keyFrame: true }]);
    });

    it("ignores an error from an encoder that was already replaced", () => {
        const { fake, video, encoder } = running();
        video.videoWidth = 1920;
        video.videoHeight = 1080;
        fake.tick();
        const replacement = fake.videoEncoders[1];
        encoder.fail();
        expect(replacement.closed).toBe(false);
    });

    it("skips encoding when this browser cannot make or configure the encoder, and retries", () => {
        const { fake, sender } = setup();
        sender.setTrack(track("video"));
        sender.setActive(true);
        fake.behavior.videoEncoder.createThrows = true;
        fake.tick();
        fake.behavior.videoEncoder.createThrows = false;
        fake.behavior.videoEncoder.configureThrows = true;
        fake.tick();
        expect(fake.videoFrames).toHaveLength(0);
        expect(fake.videoEncoders[0].closed).toBe(true);
        fake.behavior.videoEncoder.configureThrows = false;
        fake.tick();
        expect(fake.videoFrames).toHaveLength(1);
    });
});
