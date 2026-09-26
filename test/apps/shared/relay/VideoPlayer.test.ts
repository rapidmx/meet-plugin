///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { KIND_VIDEO, type Frame } from "../../../../apps/shared/relay/frames.js";
import { VIDEO_MAX_DECODE_QUEUE, VideoPlayer } from "../../../../apps/shared/relay/VideoPlayer.js";
import { createFakeRelayEnv, FakeCanvas, FakeVideoFrame } from "./relayFakes.js";

function frame(seq: number, keyFrame: boolean, timestampMs = seq * 66): Frame {
    return { kind: KIND_VIDEO, keyFrame, seq, timestampMs, data: Uint8Array.of(seq & 255) };
}

function setup() {
    const fake = createFakeRelayEnv();
    const canvas = new FakeCanvas();
    const player = new VideoPlayer(fake.env, canvas, canvas.context);
    return { fake, canvas, player };
}

describe("VideoPlayer decoding", () => {
    it("waits for a key frame and drops deltas before it", () => {
        const { fake, player } = setup();
        player.push(frame(0, false));
        player.push(frame(1, false));
        expect(fake.videoDecoders).toHaveLength(0);
        player.push(frame(2, true));
        expect(fake.videoDecoders).toHaveLength(1);
        expect(fake.videoDecoders[0].configured).toEqual([{ codec: "vp8" }]);
        player.push(frame(3, false));
        expect(fake.encodedVideoChunks.map((c) => [c.type, Array.from(c.data)])).toEqual([
            ["key", [2]],
            ["delta", [3]],
        ]);
    });

    it("uses unwrapped microsecond timestamps", () => {
        const { fake, player } = setup();
        player.push(frame(0, true, 2 ** 32 - 33));
        player.push(frame(1, false, 33));
        expect(fake.encodedVideoChunks.map((c) => c.timestamp)).toEqual([0, 66_000]);
    });

    it("drops deltas after a gap in the sequence until the next key frame", () => {
        const { fake, player } = setup();
        player.push(frame(0, true));
        player.push(frame(1, false));
        // seq 2 never arrived.
        player.push(frame(3, false));
        player.push(frame(4, false));
        expect(fake.encodedVideoChunks).toHaveLength(2);
        player.push(frame(5, true));
        player.push(frame(6, false));
        expect(fake.encodedVideoChunks).toHaveLength(4);
    });

    it("recovers at a key frame even when that key frame itself follows a gap", () => {
        const { fake, player } = setup();
        player.push(frame(0, true));
        player.push(frame(7, true));
        expect(fake.encodedVideoChunks).toHaveLength(2);
    });

    it("treats the sequence wrapping as consecutive", () => {
        const { fake, player } = setup();
        player.push(frame(65_535, true));
        player.push(frame(0, false));
        expect(fake.encodedVideoChunks).toHaveLength(2);
    });

    it("waits for a key frame when the decoder is backed up", () => {
        const { fake, player } = setup();
        player.push(frame(0, true));
        fake.videoDecoders[0].queueSize = VIDEO_MAX_DECODE_QUEUE + 1;
        player.push(frame(1, false));
        fake.videoDecoders[0].queueSize = 0;
        player.push(frame(2, false));
        expect(fake.encodedVideoChunks).toHaveLength(1);
        player.push(frame(3, true));
        expect(fake.encodedVideoChunks).toHaveLength(2);
    });

    it("waits for a key frame and rebuilds the decoder after decode() throws", () => {
        const { fake, player } = setup();
        player.push(frame(0, true));
        fake.behavior.videoDecoder.useThrows = true;
        player.push(frame(1, false));
        expect(fake.videoDecoders[0].closed).toBe(true);
        fake.behavior.videoDecoder.useThrows = false;
        player.push(frame(2, false));
        expect(fake.videoDecoders).toHaveLength(1);
        player.push(frame(3, true));
        expect(fake.videoDecoders).toHaveLength(2);
        expect(fake.videoDecoders[1].inputs).toHaveLength(1);
    });

    it("waits for a key frame after an error callback, and never throws out of it", () => {
        const { fake, player } = setup();
        player.push(frame(0, true));
        fake.behavior.videoDecoder.closeThrows = true;
        expect(() => fake.videoDecoders[0].fail()).not.toThrow();
        player.push(frame(1, false));
        expect(fake.videoDecoders).toHaveLength(1);
        player.push(frame(2, true));
        expect(fake.videoDecoders).toHaveLength(2);
    });

    it("ignores an error from a decoder that was already replaced", () => {
        const { fake, player } = setup();
        player.push(frame(0, true));
        fake.behavior.videoDecoder.useThrows = true;
        player.push(frame(1, false));
        fake.behavior.videoDecoder.useThrows = false;
        player.push(frame(2, true));
        fake.videoDecoders[0].fail();
        expect(fake.videoDecoders[1].closed).toBe(false);
    });

    it("keeps waiting for a key frame when the decoder cannot be made or configured, and retries", () => {
        const { fake, player } = setup();
        fake.behavior.videoDecoder.createThrows = true;
        player.push(frame(0, true));
        fake.behavior.videoDecoder.createThrows = false;
        fake.behavior.videoDecoder.configureThrows = true;
        player.push(frame(1, true));
        expect(fake.videoDecoders[0].closed).toBe(true);
        fake.behavior.videoDecoder.configureThrows = false;
        player.push(frame(2, false));
        expect(fake.videoDecoders).toHaveLength(1);
        player.push(frame(3, true));
        expect(fake.videoDecoders[1].inputs).toHaveLength(1);
    });

    it("closes its decoder on close()", () => {
        const { fake, player } = setup();
        player.push(frame(0, true));
        player.close();
        expect(fake.videoDecoders[0].closed).toBe(true);
        player.close();
    });
});

describe("VideoPlayer drawing", () => {
    it("draws each decoded picture, sizing the canvas to it, and closes it", () => {
        const { fake, canvas, player } = setup();
        player.push(frame(0, true));
        const picture = new FakeVideoFrame(480, 270);
        fake.videoDecoders[0].emit(picture);
        expect([canvas.width, canvas.height]).toEqual([480, 270]);
        expect(canvas.drawn).toEqual([{ source: picture, args: [0, 0] }]);
        expect(picture.closed).toBe(true);
        // Same size again: no resize needed.
        const second = new FakeVideoFrame(480, 270);
        fake.videoDecoders[0].emit(second);
        expect(canvas.drawn).toHaveLength(2);
        expect(second.closed).toBe(true);
    });

    it("resizes when only one dimension changes", () => {
        const { fake, canvas, player } = setup();
        player.push(frame(0, true));
        fake.videoDecoders[0].emit(new FakeVideoFrame(480, 270));
        fake.videoDecoders[0].emit(new FakeVideoFrame(480, 360));
        expect([canvas.width, canvas.height]).toEqual([480, 360]);
        fake.videoDecoders[0].emit(new FakeVideoFrame(320, 360));
        expect([canvas.width, canvas.height]).toEqual([320, 360]);
    });

    it("closes a picture the canvas will not take, without throwing", () => {
        const { fake, canvas, player } = setup();
        player.push(frame(0, true));
        canvas.drawThrows = true;
        const picture = new FakeVideoFrame();
        expect(() => fake.videoDecoders[0].emit(picture)).not.toThrow();
        expect(picture.closed).toBe(true);
    });
});
