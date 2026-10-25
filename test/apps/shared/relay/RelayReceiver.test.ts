///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";
import { fragmentFrame, KIND_AUDIO, KIND_VIDEO } from "../../../../apps/shared/relay/frames.js";
import { RelayReceiver } from "../../../../apps/shared/relay/RelayReceiver.js";
import { createFakeRelayEnv, FakeAudioContext, FakeAudioData, FakeVideoFrame } from "./relayFakes.js";

function setup() {
    const fake = createFakeRelayEnv();
    const ctx = new FakeAudioContext(48_000);
    const receiver = new RelayReceiver(fake.env, ctx);
    return { fake, ctx, receiver };
}

describe("RelayReceiver stream", () => {
    it("exposes one audio track (from the destination node) and one video track (from a 15 fps canvas capture)", () => {
        const { fake, ctx, receiver } = setup();
        const kinds = receiver.stream.getTracks().map((t) => t.kind);
        expect(kinds).toEqual(["audio", "video"]);
        expect(receiver.stream.getAudioTracks()[0]).toBe(ctx.streamDestinations[0].stream.getAudioTracks()[0]);
        expect(fake.canvases[0].captureRates).toEqual([15]);
        expect([fake.canvases[0].width, fake.canvases[0].height]).toEqual([320, 240]);
    });

    it("still builds a stream when the canvas has no 2D context, ignoring video frames", () => {
        const fake = createFakeRelayEnv();
        fake.behavior.canvasHasContext = false;
        const receiver = new RelayReceiver(fake.env, new FakeAudioContext(48_000));
        expect(receiver.stream.getTracks()).toHaveLength(2);
        expect(() => receiver.handleMedia(fragmentFrame(KIND_VIDEO, true, 0, 0, Uint8Array.of(1))[0])).not.toThrow();
        expect(fake.videoDecoders).toHaveLength(0);
        receiver.close();
    });

    it("stops its tracks when closed", () => {
        const { receiver } = setup();
        const tracks = receiver.stream.getTracks();
        receiver.close();
        for (const t of tracks) {
            expect(t.stop).toHaveBeenCalled();
        }
    });
});

describe("RelayReceiver.handleMedia", () => {
    it("decodes and plays audio frames", () => {
        const { fake, ctx, receiver } = setup();
        receiver.handleMedia(fragmentFrame(KIND_AUDIO, true, 0, 100, Uint8Array.of(1, 2))[0]);
        expect(fake.encodedAudioChunks.map((c) => Array.from(c.data))).toEqual([[1, 2]]);
        fake.audioDecoders[0].emit(new FakeAudioData(960));
        expect(ctx.sources).toHaveLength(1);
    });

    it("reassembles a fragmented video frame before decoding and draws the result", () => {
        const { fake, receiver } = setup();
        const data = Uint8Array.from({ length: 25_000 }, (_, i) => i % 200);
        const fragments = fragmentFrame(KIND_VIDEO, true, 0, 100, data);
        receiver.handleMedia(fragments[0]);
        receiver.handleMedia(fragments[2]);
        expect(fake.encodedVideoChunks).toHaveLength(0);
        receiver.handleMedia(fragments[1]);
        expect(fake.encodedVideoChunks).toHaveLength(1);
        expect(fake.encodedVideoChunks[0].data).toEqual(data);
        fake.videoDecoders[0].emit(new FakeVideoFrame(480, 360));
        expect(fake.canvases[0].drawn).toHaveLength(1);
    });

    it("keeps audio and video reassembly independent", () => {
        const { fake, receiver } = setup();
        const video = fragmentFrame(KIND_VIDEO, true, 0, 1, new Uint8Array(15_000));
        receiver.handleMedia(video[0]);
        // An audio frame in between must not abandon the video frame in progress.
        receiver.handleMedia(fragmentFrame(KIND_AUDIO, true, 0, 1, Uint8Array.of(1))[0]);
        receiver.handleMedia(video[1]);
        expect(fake.encodedVideoChunks).toHaveLength(1);
        expect(fake.encodedAudioChunks).toHaveLength(1);
    });

    it("ignores garbage without throwing", () => {
        const { fake, receiver } = setup();
        for (const garbage of [new Uint8Array(0), Uint8Array.of(1, 2, 3), new Uint8Array(40).fill(255)]) {
            expect(() => receiver.handleMedia(garbage)).not.toThrow();
        }
        expect(fake.encodedAudioChunks).toHaveLength(0);
        expect(fake.encodedVideoChunks).toHaveLength(0);
    });
});

describe("RelayReceiver in a protected meeting", () => {
    function protectedSetup(open: (kind: number, payload: Uint8Array) => Promise<Uint8Array | undefined>) {
        const fake = createFakeRelayEnv();
        const receiver = new RelayReceiver(fake.env, new FakeAudioContext(48_000), open);
        return { fake, receiver };
    }
    const sealed = (seq: number, byte: number) => fragmentFrame(KIND_AUDIO, true, seq, 100 + seq, Uint8Array.of(byte, 0xee), undefined, true)[0];

    it("plays only sealed frames that open, in the order they arrived", async () => {
        let slow = true;
        const { fake, receiver } = protectedSetup(async (_kind, payload) => {
            if (slow) {
                slow = false;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            return payload[0] === 9 ? undefined : payload.subarray(0, 1);
        });
        receiver.handleMedia(sealed(0, 1));
        receiver.handleMedia(sealed(1, 9));
        receiver.handleMedia(fragmentFrame(KIND_AUDIO, true, 2, 102, Uint8Array.of(3))[0]);
        receiver.handleMedia(sealed(3, 4));
        await vi.waitFor(() => expect(fake.encodedAudioChunks.map((c) => Array.from(c.data))).toEqual([[1], [4]]));
    });

    it("drops what is still being opened when it closes, and an unprotected meeting drops sealed frames", async () => {
        let release: () => void = () => undefined;
        const { fake, receiver } = protectedSetup(() => new Promise((resolve) => (release = () => resolve(Uint8Array.of(1)))));
        receiver.handleMedia(sealed(0, 1));
        receiver.close();
        release();
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(fake.encodedAudioChunks).toHaveLength(0);

        const plain = setup();
        plain.receiver.handleMedia(sealed(0, 1));
        expect(plain.fake.encodedAudioChunks).toHaveLength(0);
    });
});
