///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { decodeFragment, KIND_AUDIO, KIND_VIDEO, MAX_FRAME_BYTES } from "../../../../apps/shared/relay/frames.js";
import { FramePublisher, RelaySender } from "../../../../apps/shared/relay/RelaySender.js";
import { createFakeRelayEnv, fakeChunk, track } from "./relayFakes.js";

describe("FramePublisher", () => {
    it("fragments a frame and sends every fragment", () => {
        const sent: Uint8Array[] = [];
        const publisher = new FramePublisher((m) => {
            sent.push(m);
            return true;
        });
        expect(publisher.publish(KIND_VIDEO, true, new Uint8Array(30_000), 1234)).toBe(true);
        expect(sent).toHaveLength(3);
        expect(sent.map((m) => decodeFragment(m)?.fragIndex)).toEqual([0, 1, 2]);
        expect(decodeFragment(sent[0])).toMatchObject({ kind: KIND_VIDEO, keyFrame: true, timestampMs: 1234, seq: 0 });
    });

    it("sizes fragments from the socket's current limit, read for every frame", () => {
        const sent: Uint8Array[] = [];
        let limit = 16_384;
        const publisher = new FramePublisher(
            (m) => {
                sent.push(m);
                return true;
            },
            () => limit,
        );
        publisher.publish(KIND_VIDEO, true, new Uint8Array(30_000), 0);
        expect(sent).toHaveLength(3);
        limit = 65_536;
        publisher.publish(KIND_VIDEO, true, new Uint8Array(30_000), 0);
        expect(sent).toHaveLength(4);
        expect(sent[3]).toHaveLength(30_010);
    });

    it("drops a frame that needs more fragments than allowed at a tiny limit", () => {
        const sent: Uint8Array[] = [];
        const publisher = new FramePublisher(
            (m) => {
                sent.push(m);
                return true;
            },
            () => 1024,
        );
        expect(publisher.publish(KIND_VIDEO, true, new Uint8Array(300_000), 0)).toBe(false);
        expect(sent).toHaveLength(0);
    });

    it("numbers each kind's frames separately and wraps at 65536", () => {
        const sent: Uint8Array[] = [];
        const publisher = new FramePublisher((m) => {
            sent.push(m);
            return true;
        });
        publisher.publish(KIND_AUDIO, true, Uint8Array.of(1), 0);
        publisher.publish(KIND_AUDIO, true, Uint8Array.of(1), 0);
        publisher.publish(KIND_VIDEO, true, Uint8Array.of(1), 0);
        expect(sent.map((m) => decodeFragment(m)?.seq)).toEqual([0, 1, 0]);
        for (let i = 0; i < 65_534; i++) {
            publisher.publish(KIND_AUDIO, true, Uint8Array.of(1), 0);
        }
        publisher.publish(KIND_AUDIO, true, Uint8Array.of(1), 0);
        expect(decodeFragment(sent[sent.length - 2])?.seq).toBe(65_535);
        expect(decodeFragment(sent[sent.length - 1])?.seq).toBe(0);
    });

    it("stops at the first fragment the socket refuses and reports the frame as dropped", () => {
        let accepted = 1;
        const sent: Uint8Array[] = [];
        const publisher = new FramePublisher((m) => {
            if (accepted-- <= 0) return false;
            sent.push(m);
            return true;
        });
        expect(publisher.publish(KIND_VIDEO, false, new Uint8Array(30_000), 0)).toBe(false);
        expect(sent).toHaveLength(1);
    });

    it("reports a frame too large to send as dropped, but still consumes its sequence number", () => {
        const sent: Uint8Array[] = [];
        const publisher = new FramePublisher((m) => {
            sent.push(m);
            return true;
        });
        expect(publisher.publish(KIND_VIDEO, true, new Uint8Array(MAX_FRAME_BYTES + 1), 0)).toBe(false);
        expect(sent).toHaveLength(0);
        publisher.publish(KIND_VIDEO, true, Uint8Array.of(1), 0);
        expect(decodeFragment(sent[0])?.seq).toBe(1);
    });
});

describe("RelaySender", () => {
    function setup() {
        const fake = createFakeRelayEnv();
        const sent: Uint8Array[] = [];
        const state = { canSend: true };
        const sender = new RelaySender({
            env: fake.env,
            send: (m) => {
                sent.push(m);
                return true;
            },
            canSend: () => state.canSend,
        });
        return { fake, sender, sent, state };
    }

    it("passes the socket's limit through to the fragmenter", () => {
        const fake = createFakeRelayEnv();
        const sent: Uint8Array[] = [];
        const sender = new RelaySender({
            env: fake.env,
            send: (m) => (sent.push(m), true),
            canSend: () => true,
            maxMessageBytes: () => 65_536,
        });
        sender.setTrack("video", track("video"));
        sender.setActive(true);
        fake.tick();
        fake.videoEncoders[0].emit(fakeChunk(new Array(30_000).fill(1), "key", 0));
        expect(sent).toHaveLength(1);
    });

    it("routes each kind's track to its own capture path and stops both when deactivated", () => {
        const { fake, sender } = setup();
        sender.setTrack("audio", track("audio"));
        sender.setTrack("video", track("video"));
        expect(fake.audioContexts).toHaveLength(0);
        expect(fake.videos).toHaveLength(0);
        sender.setActive(true);
        expect(fake.audioContexts).toHaveLength(1);
        expect(fake.videos).toHaveLength(1);
        sender.setTrack("video", null);
        expect(fake.intervals.size).toBe(0);
        expect(fake.audioContexts[0].closed).toBe(false);
        sender.setActive(false);
        expect(fake.audioContexts[0].closed).toBe(true);
    });

    it("fragments what the encoders produce and hands it to the socket, gated on canSend", () => {
        const { fake, sender, sent, state } = setup();
        sender.setTrack("audio", track("audio"));
        sender.setTrack("video", track("video"));
        sender.setActive(true);
        fake.audioContexts[0].processors[0].run(new Float32Array(2048));
        fake.audioEncoders[0].emit(fakeChunk([1, 2, 3], "key", 0));
        fake.tick();
        fake.videoEncoders[0].emit(fakeChunk(new Array(20_000).fill(4), "key", 0));
        expect(sent.map((m) => decodeFragment(m)?.kind)).toEqual([KIND_AUDIO, KIND_VIDEO, KIND_VIDEO]);
        state.canSend = false;
        fake.tick();
        expect(fake.videoFrames).toHaveLength(1);
    });
});
