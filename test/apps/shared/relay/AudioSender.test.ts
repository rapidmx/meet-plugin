///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    AUDIO_BITRATE,
    AUDIO_MAX_ENCODE_QUEUE,
    AUDIO_PROCESS_FRAMES,
    AUDIO_SAMPLE_RATE,
    AudioSender,
} from "../../../../apps/shared/relay/AudioSender.js";
import { KIND_AUDIO } from "../../../../apps/shared/relay/frames.js";
import { createFakeRelayEnv, fakeChunk, track, last } from "./relayFakes.js";

function setup(canSend = true) {
    const fake = createFakeRelayEnv();
    const published: { kind: number; key: boolean; data: number[]; timestampMs: number }[] = [];
    const state = { canSend };
    const sender = new AudioSender({
        env: fake.env,
        publish: (kind, key, data, timestampMs) => {
            published.push({ kind, key, data: Array.from(data), timestampMs });
            return true;
        },
        canSend: () => state.canSend,
    });
    return { fake, sender, published, state };
}

/** A sender with a live track and one processed block, so an encoder exists. */
function running() {
    const s = setup();
    s.sender.setTrack(track("audio"));
    s.sender.setActive(true);
    s.fake.audioContexts[0].processors[0].run(new Float32Array(AUDIO_PROCESS_FRAMES).fill(0.1));
    return { ...s, ctx: s.fake.audioContexts[0], processor: s.fake.audioContexts[0].processors[0], encoder: s.fake.audioEncoders[0] };
}

describe("AudioSender graph", () => {
    it("builds nothing until it is both active and has a track", () => {
        const { fake, sender } = setup();
        sender.setActive(true);
        expect(fake.audioContexts).toHaveLength(0);
        sender.setActive(false);
        sender.setTrack(track("audio"));
        expect(fake.audioContexts).toHaveLength(0);
    });

    it("wires source -> script processor -> zero gain -> destination at 48 kHz", () => {
        const { fake, sender } = setup();
        const t = track("audio");
        sender.setTrack(t);
        sender.setActive(true);
        const ctx = fake.audioContexts[0];
        expect(ctx.sampleRate).toBe(AUDIO_SAMPLE_RATE);
        expect(last(fake.mediaStreams)?.tracks).toEqual([t]);
        const [source] = ctx.sourceNodes;
        const [processor] = ctx.processors;
        const [gain] = ctx.gains;
        expect(source.connections).toEqual([processor]);
        expect(processor.connections).toEqual([gain]);
        expect(gain.connections).toEqual([ctx.destination]);
        expect(gain.gain.value).toBe(0);
    });

    it("tries to resume a suspended context and listens for a gesture to retry", () => {
        const fake = createFakeRelayEnv();
        fake.behavior.audioContextState = "suspended";
        const sender = new AudioSender({ env: fake.env, publish: () => true, canSend: () => true });
        sender.setTrack(track("audio"));
        sender.setActive(true);
        expect(fake.audioContexts[0].resume).toHaveBeenCalled();
        expect(fake.document.count()).toBeGreaterThan(0);
        sender.setActive(false);
        expect(fake.document.count()).toBe(0);
    });

    it("tears everything down when stopped, and is quiet if stopped again", () => {
        const { fake, sender, ctx, processor, encoder } = running();
        sender.setActive(false);
        expect(processor.onaudioprocess).toBeNull();
        expect(processor.disconnected).toBe(true);
        expect(ctx.sourceNodes[0].disconnected).toBe(true);
        expect(ctx.gains[0].disconnected).toBe(true);
        expect(ctx.close).toHaveBeenCalled();
        expect(encoder.closed).toBe(true);
        sender.setActive(false);
        sender.setTrack(null);
        expect(fake.audioContexts).toHaveLength(1);
    });

    it("tears down when the track is removed", () => {
        const { sender, ctx } = running();
        sender.setTrack(null);
        expect(ctx.closed).toBe(true);
    });

    it("rebuilds for a replaced track but not for the same one", () => {
        const { fake, sender } = setup();
        const first = track("audio", "a1");
        sender.setTrack(first);
        sender.setActive(true);
        sender.setTrack(first);
        expect(fake.audioContexts).toHaveLength(1);
        const second = track("audio", "a2");
        sender.setTrack(second);
        expect(fake.audioContexts).toHaveLength(2);
        expect(fake.audioContexts[0].closed).toBe(true);
        expect(last(fake.mediaStreams)?.tracks).toEqual([second]);
    });

    it("ignores a rejecting AudioContext.close()", async () => {
        const { sender, ctx } = running();
        ctx.closeRejects = true;
        sender.setActive(false);
        await Promise.resolve();
        expect(ctx.close).toHaveBeenCalled();
    });

    it("gives up quietly (and can retry) when the browser will not build the audio graph", () => {
        const { fake, sender } = setup();
        fake.behavior.audioContextThrows = true;
        sender.setTrack(track("audio"));
        expect(() => sender.setActive(true)).not.toThrow();
        expect(fake.audioContexts).toHaveLength(0);
        fake.behavior.audioContextThrows = false;
        sender.setActive(true);
        expect(fake.audioContexts).toHaveLength(1);
    });

    it("cleans up a half-built graph", () => {
        const { fake, sender } = setup();
        fake.behavior.mediaStreamThrows = true;
        sender.setTrack(track("audio"));
        sender.setActive(true);
        // The context was created before the failure and must not be leaked.
        expect(fake.audioContexts[0].closed).toBe(true);
    });
});

describe("AudioSender encoding", () => {
    it("encodes each block as f32-planar AudioData with a sample-clock timestamp, then closes it", () => {
        const { fake, encoder, processor } = running();
        expect(encoder.configured).toEqual([
            { codec: "opus", sampleRate: 48_000, numberOfChannels: 1, bitrate: AUDIO_BITRATE, opus: { frameDuration: 20_000 } },
        ]);
        expect(fake.audioData).toHaveLength(1);
        expect(fake.audioData[0].init).toMatchObject({
            format: "f32-planar",
            sampleRate: 48_000,
            numberOfFrames: AUDIO_PROCESS_FRAMES,
            numberOfChannels: 1,
            timestamp: 0,
        });
        expect(fake.audioData[0].closed).toBe(true);
        expect(encoder.inputs).toEqual([fake.audioData[0]]);
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        // 2048 samples at 48 kHz = 42666.67 us.
        expect(fake.audioData[1].init?.timestamp).toBe(42_667);
    });

    it("copies the block, because the browser reuses its buffer", () => {
        const { fake, processor } = running();
        const block = new Float32Array(AUDIO_PROCESS_FRAMES).fill(0.5);
        processor.run(block);
        block.fill(0.9);
        expect(fake.audioData[1].init?.data[0]).toBe(0.5);
    });

    it("publishes each encoded packet as a key frame on the sender's monotonic clock", () => {
        const { fake, encoder, published } = running();
        fake.clock.now = 5000;
        encoder.emit(fakeChunk([1, 2, 3], "key", 40_000));
        expect(published).toEqual([{ kind: KIND_AUDIO, key: true, data: [1, 2, 3], timestampMs: 1000 + 40 }]);
    });

    it("keeps one encoder across blocks", () => {
        const { fake, processor } = running();
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioEncoders).toHaveLength(1);
    });

    it("does not encode while the socket cannot take frames, but keeps the sample clock moving", () => {
        const { fake, processor, state } = running();
        state.canSend = false;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioData).toHaveLength(1);
        state.canSend = true;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioData[1].init?.timestamp).toBe(85_333);
    });

    it("skips a block when the encoder is backed up", () => {
        const { fake, processor, encoder } = running();
        encoder.queueSize = AUDIO_MAX_ENCODE_QUEUE + 1;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioData).toHaveLength(1);
        encoder.queueSize = AUDIO_MAX_ENCODE_QUEUE;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioData).toHaveLength(2);
    });

    it("discards the encoder when encode() throws, closes the AudioData and builds a new encoder for the next block", () => {
        const { fake, processor, encoder } = running();
        fake.behavior.audioEncoder.useThrows = true;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioData[1].closed).toBe(true);
        expect(encoder.closed).toBe(true);
        fake.behavior.audioEncoder.useThrows = false;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioEncoders).toHaveLength(2);
        expect(fake.audioEncoders[1].inputs).toHaveLength(1);
    });

    it("discards the encoder when AudioData cannot be built", () => {
        const { fake, processor, encoder } = running();
        fake.behavior.audioDataThrows = true;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(encoder.closed).toBe(true);
    });

    it("replaces the encoder after an error callback, and never throws out of it", () => {
        const { fake, processor, encoder } = running();
        fake.behavior.audioEncoder.closeThrows = true;
        expect(() => encoder.fail()).not.toThrow();
        expect(encoder.closed).toBe(true);
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioEncoders).toHaveLength(2);
    });

    it("ignores an error from an encoder that was already replaced", () => {
        const { fake, processor, encoder } = running();
        fake.behavior.audioEncoder.useThrows = true;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        fake.behavior.audioEncoder.useThrows = false;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        const replacement = fake.audioEncoders[1];
        encoder.fail();
        expect(replacement.closed).toBe(false);
    });

    it("skips encoding when this browser cannot make or configure the encoder, and retries", () => {
        const { fake, sender } = setup();
        sender.setTrack(track("audio"));
        sender.setActive(true);
        const processor = fake.audioContexts[0].processors[0];
        fake.behavior.audioEncoder.createThrows = true;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioData).toHaveLength(0);
        fake.behavior.audioEncoder.createThrows = false;
        fake.behavior.audioEncoder.configureThrows = true;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioData).toHaveLength(0);
        // The encoder that failed to configure is closed rather than leaked.
        expect(fake.audioEncoders[0].closed).toBe(true);
        fake.behavior.audioEncoder.configureThrows = false;
        processor.run(new Float32Array(AUDIO_PROCESS_FRAMES));
        expect(fake.audioData).toHaveLength(1);
    });

    it("does not throw when a packet arrives after stopping", () => {
        const { sender, encoder, published } = running();
        sender.setActive(false);
        expect(() => encoder.emit(fakeChunk([1]))).not.toThrow();
        expect(published).toHaveLength(1);
    });
});
