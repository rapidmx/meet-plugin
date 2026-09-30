///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    AUDIO_MAX_DECODE_QUEUE,
    AudioPlayer,
    DISCONTINUITY_FADE_SECONDS,
    JITTER_BUFFER_SECONDS,
    MAX_AHEAD_SECONDS,
} from "../../../../apps/shared/relay/AudioPlayer.js";
import { KIND_AUDIO, type Frame } from "../../../../apps/shared/relay/frames.js";
import { createFakeRelayEnv, FakeAudioContext, FakeAudioData, last } from "./relayFakes.js";

function frame(timestampMs: number, data = [1, 2, 3]): Frame {
    return { kind: KIND_AUDIO, keyFrame: true, seq: 0, timestampMs, data: Uint8Array.from(data) };
}

function setup() {
    const fake = createFakeRelayEnv();
    const ctx = new FakeAudioContext(48_000);
    const destination = { stream: "dest" };
    const player = new AudioPlayer(fake.env, ctx, destination);
    return { fake, ctx, player, destination };
}

/** Pushes one packet and has the decoder produce a 20 ms block for it. */
function play(s: ReturnType<typeof setup>, block = new FakeAudioData(960)) {
    s.player.push(frame(0));
    last(s.fake.audioDecoders)?.emit(block);
    return block;
}

describe("AudioPlayer decoding", () => {
    it("creates one Opus mono 48 kHz decoder lazily and feeds it packets as key chunks with unwrapped microseconds", () => {
        const { fake, player } = setup();
        expect(fake.audioDecoders).toHaveLength(0);
        player.push(frame(2 ** 32 - 10, [9]));
        player.push(frame(10, [8]));
        expect(fake.audioDecoders).toHaveLength(1);
        expect(fake.audioDecoders[0].configured).toEqual([{ codec: "opus", sampleRate: 48_000, numberOfChannels: 1 }]);
        expect(fake.encodedAudioChunks.map((c) => [c.type, c.timestamp, Array.from(c.data)])).toEqual([
            ["key", 0, [9]],
            ["key", 20_000, [8]],
        ]);
        expect(fake.audioDecoders[0].inputs).toHaveLength(2);
    });

    it("skips a packet when the decoder is backed up", () => {
        const { fake, player } = setup();
        player.push(frame(0));
        fake.audioDecoders[0].queueSize = AUDIO_MAX_DECODE_QUEUE + 1;
        player.push(frame(20));
        expect(fake.audioDecoders[0].inputs).toHaveLength(1);
        fake.audioDecoders[0].queueSize = AUDIO_MAX_DECODE_QUEUE;
        player.push(frame(40));
        expect(fake.audioDecoders[0].inputs).toHaveLength(2);
    });

    it("discards the decoder when decode() throws and builds a new one for the next packet", () => {
        const { fake, player } = setup();
        player.push(frame(0));
        fake.behavior.audioDecoder.useThrows = true;
        player.push(frame(20));
        expect(fake.audioDecoders[0].closed).toBe(true);
        fake.behavior.audioDecoder.useThrows = false;
        player.push(frame(40));
        expect(fake.audioDecoders).toHaveLength(2);
        expect(fake.audioDecoders[1].inputs).toHaveLength(1);
    });

    it("replaces the decoder after an error callback, and never throws out of it", () => {
        const { fake, player } = setup();
        player.push(frame(0));
        fake.behavior.audioDecoder.closeThrows = true;
        expect(() => fake.audioDecoders[0].fail()).not.toThrow();
        player.push(frame(20));
        expect(fake.audioDecoders).toHaveLength(2);
    });

    it("ignores an error from a decoder that was already replaced", () => {
        const { fake, player } = setup();
        player.push(frame(0));
        fake.behavior.audioDecoder.useThrows = true;
        player.push(frame(20));
        fake.behavior.audioDecoder.useThrows = false;
        player.push(frame(40));
        fake.audioDecoders[0].fail();
        expect(fake.audioDecoders[1].closed).toBe(false);
    });

    it("drops packets when this browser cannot make or configure the decoder, and retries", () => {
        const { fake, player } = setup();
        fake.behavior.audioDecoder.createThrows = true;
        player.push(frame(0));
        fake.behavior.audioDecoder.createThrows = false;
        fake.behavior.audioDecoder.configureThrows = true;
        player.push(frame(20));
        expect(fake.audioDecoders[0].closed).toBe(true);
        fake.behavior.audioDecoder.configureThrows = false;
        player.push(frame(40));
        expect(fake.audioDecoders[1].inputs).toHaveLength(1);
    });

    it("closes its decoder on close()", () => {
        const { fake, player } = setup();
        player.push(frame(0));
        player.close();
        expect(fake.audioDecoders[0].closed).toBe(true);
        player.close();
    });
});

describe("AudioPlayer scheduling", () => {
    it("plays the first block after the jitter buffer, copies its PCM into an AudioBuffer and closes the AudioData", () => {
        const s = setup();
        s.ctx.currentTime = 10;
        const block = play(s);
        expect(s.ctx.buffers).toHaveLength(1);
        expect(s.ctx.buffers[0].length).toBe(960);
        expect(s.ctx.buffers[0].sampleRate).toBe(48_000);
        expect(s.ctx.buffers[0].channelData?.[0]).toBe(0.25);
        expect(block.copyCalls).toEqual([{ planeIndex: 0, format: "f32-planar" }]);
        const source = s.ctx.sources[0];
        expect(source.buffer).toBe(s.ctx.buffers[0]);
        // The first block is a discontinuity (nothing played before it) - faded in through a gain node, not
        // connected to the destination directly. See the "fades in" tests below for the fade itself.
        expect(source.connections).toEqual([s.ctx.gains[0]]);
        expect(s.ctx.gains[0].connections).toEqual([s.destination]);
        expect(source.startedAt).toBeCloseTo(10 + JITTER_BUFFER_SECONDS, 10);
        expect(block.closed).toBe(true);
    });

    it("chains consecutive blocks back to back, with no fade between them", () => {
        const s = setup();
        s.ctx.currentTime = 10;
        play(s);
        play(s);
        play(s);
        const [a, b, c] = s.ctx.sources.map((x) => x.startedAt as number);
        expect(b).toBeCloseTo(a + 0.02, 10);
        expect(c).toBeCloseTo(a + 0.04, 10);
        // Only the first (discontinuous) block got a gain node - the two that pick up exactly where the last one
        // left off connect straight to the destination, and disconnect on their own when they finish.
        expect(s.ctx.gains).toHaveLength(1);
        expect(s.ctx.sources[1].connections).toEqual([s.destination]);
        expect(s.ctx.sources[2].connections).toEqual([s.destination]);
        s.ctx.sources[1].onended?.();
        expect(s.ctx.sources[1].disconnected).toBe(true);
    });

    it("fades in a block that doesn't pick up where the last one left off - the first one, or one after a gap", () => {
        const s = setup();
        s.ctx.currentTime = 10;
        play(s);
        const start = s.ctx.sources[0].startedAt as number;
        const gain = s.ctx.gains[0];
        expect(gain.ramps).toEqual([
            { method: "setValueAtTime", value: 0, time: start },
            { method: "linearRampToValueAtTime", value: 1, time: start + DISCONTINUITY_FADE_SECONDS },
        ]);
    });

    it("restarts with the jitter headroom after an underrun, fading the block that resumes playback", () => {
        const s = setup();
        s.ctx.currentTime = 10;
        play(s);
        s.ctx.currentTime = 20;
        play(s);
        expect(s.ctx.sources[1].startedAt).toBeCloseTo(20 + JITTER_BUFFER_SECONDS, 10);
        // Both the first block and the one after the gap are discontinuities.
        expect(s.ctx.gains).toHaveLength(2);
        expect(s.ctx.sources[1].connections).toEqual([s.ctx.gains[1]]);
    });

    it("drops blocks while the queue runs more than 400 ms ahead, and resumes once it drains", () => {
        const s = setup();
        s.ctx.currentTime = 10;
        // 25 blocks of 20 ms = 500 ms scheduled.
        for (let i = 0; i < 25; i++) play(s);
        const scheduled = s.ctx.sources.length;
        expect(scheduled).toBeLessThan(25);
        const dropped = new FakeAudioData(960);
        play(s, dropped);
        expect(s.ctx.sources).toHaveLength(scheduled);
        // A dropped block's AudioData is still released.
        expect(dropped.closed).toBe(true);
        expect(MAX_AHEAD_SECONDS).toBe(0.4);
        s.ctx.currentTime += 0.2;
        play(s);
        expect(s.ctx.sources).toHaveLength(scheduled + 1);
    });

    it("disconnects a source (and its gain node, faded in as the first block) when it finishes", () => {
        const s = setup();
        play(s);
        s.ctx.sources[0].onended?.();
        expect(s.ctx.sources[0].disconnected).toBe(true);
        expect(s.ctx.gains[0].disconnected).toBe(true);
    });

    it("drops a block the browser will not take, still closing it, and keeps going", () => {
        const s = setup();
        s.ctx.createBufferThrows = true;
        const bad = play(s);
        expect(bad.closed).toBe(true);
        expect(s.ctx.sources).toHaveLength(0);
        s.ctx.createBufferThrows = false;
        play(s);
        expect(s.ctx.sources).toHaveLength(1);
        const failing = new FakeAudioData(960);
        failing.copyThrows = true;
        play(s, failing);
        expect(failing.closed).toBe(true);
        expect(s.ctx.sources).toHaveLength(1);
    });
});
