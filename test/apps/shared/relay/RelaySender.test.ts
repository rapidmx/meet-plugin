///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";
import type { FrameHeader } from "../../../../apps/shared/crypto/MeetingCipher.js";
import { decodeFragment, KIND_AUDIO, KIND_VIDEO, MAX_FRAME_BYTES } from "../../../../apps/shared/relay/frames.js";
import { FramePublisher, MAX_FRAMES_SEALING, RelaySender } from "../../../../apps/shared/relay/RelaySender.js";
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

    it("counts each kind's sent and dropped frames, and the bytes of every fragment that went out", () => {
        let accept = true;
        const publisher = new FramePublisher(() => accept);
        publisher.publish(KIND_AUDIO, true, new Uint8Array(100), 0);
        publisher.publish(KIND_VIDEO, true, new Uint8Array(20_000), 0);
        publisher.publish(KIND_VIDEO, true, new Uint8Array(MAX_FRAME_BYTES + 1), 0);
        accept = false;
        publisher.publish(KIND_AUDIO, true, new Uint8Array(100), 0);
        expect(publisher.stats[KIND_AUDIO]).toEqual({ framesSent: 1, framesDropped: 1, bytesSent: 110 });
        // Two fragments (12000 + 8000 bytes), each with its own 10-byte header.
        expect(publisher.stats[KIND_VIDEO]).toEqual({ framesSent: 1, framesDropped: 1, bytesSent: 20_020 });
    });

    it("counts the fragments that did go out of a frame dropped partway", () => {
        let accepted = 1;
        const publisher = new FramePublisher(() => accepted-- > 0);
        publisher.publish(KIND_VIDEO, false, new Uint8Array(30_000), 0);
        expect(publisher.stats[KIND_VIDEO]).toEqual({ framesSent: 0, framesDropped: 1, bytesSent: 12_010 });
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

    it("reports the capture counters and each kind's send counters together", () => {
        const { fake, sender } = setup();
        expect(sender.diagnostics()).toEqual({
            audioCapturedMs: 0,
            audioCaptureWallMs: 0,
            audioSilentMs: 0,
            audioEncoderSkippedMs: 0,
            audio: { framesSent: 0, framesDropped: 0, bytesSent: 0 },
            video: { framesSent: 0, framesDropped: 0, bytesSent: 0 },
        });
        sender.setTrack("audio", track("audio"));
        sender.setActive(true);
        fake.audioContexts[0].processors[0].run(new Float32Array(4800));
        fake.audioEncoders[0].emit(fakeChunk([1, 2, 3], "key", 0));
        const diagnostics = sender.diagnostics();
        expect(diagnostics.audioCapturedMs).toBeCloseTo(100, 6);
        expect(diagnostics.audioSilentMs).toBeCloseTo(100, 6);
        expect(diagnostics.audio).toEqual({ framesSent: 1, framesDropped: 0, bytesSent: 13 });
        // A snapshot: later sends don't change what was already returned.
        fake.audioEncoders[0].emit(fakeChunk([1], "key", 20_000));
        expect(diagnostics.audio.framesSent).toBe(1);
    });
});

describe("FramePublisher in a protected meeting", () => {
    it("seals every frame before fragmenting it, marks it sealed, and keeps the order", async () => {
        const sent: Uint8Array[] = [];
        const headers: FrameHeader[] = [];
        let slow = true;
        const cipher = {
            encryptFrame: async (header: FrameHeader, frame: Uint8Array) => {
                headers.push(header);
                if (slow) {
                    slow = false;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                return Uint8Array.of(0xaa, ...frame);
            },
            decryptFrame: async () => undefined,
        };
        const publisher = new FramePublisher((m) => (sent.push(m), true), undefined, cipher);
        expect(publisher.publish(KIND_AUDIO, true, Uint8Array.of(1), 0)).toBe(true);
        expect(publisher.publish(KIND_AUDIO, true, Uint8Array.of(2), 2 ** 32 + 20)).toBe(true);
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        const fragments = sent.map((m) => decodeFragment(m)!);
        expect(fragments.map((f) => [f.seq, f.encrypted, Array.from(f.data)])).toEqual([
            [0, true, [0xaa, 1]],
            [1, true, [0xaa, 2]],
        ]);
        // Each frame is sealed bound to the header it goes out under, as the receiver reads it off the wire.
        expect(headers).toEqual([
            { kind: KIND_AUDIO, keyFrame: true, seq: 0, timestampMs: 0 },
            { kind: KIND_AUDIO, keyFrame: true, seq: 1, timestampMs: 20 },
        ]);
        expect(fragments[1].timestampMs).toBe(20);
        expect(publisher.stats[KIND_AUDIO].framesSent).toBe(2);
    });

    it("drops a frame when too many wait to be sealed, and counts one that fails to seal", async () => {
        let fail = false;
        const pending: (() => void)[] = [];
        const cipher = {
            encryptFrame: (_header: FrameHeader, frame: Uint8Array) =>
                new Promise<Uint8Array>((resolve, reject) => pending.push(() => (fail ? reject(new Error("no key")) : resolve(frame)))),
            decryptFrame: async () => undefined,
        };
        const publisher = new FramePublisher(() => true, undefined, cipher);
        for (let i = 0; i < MAX_FRAMES_SEALING; i++) {
            expect(publisher.publish(KIND_VIDEO, false, Uint8Array.of(i), i)).toBe(true);
        }
        expect(publisher.publish(KIND_VIDEO, false, Uint8Array.of(99), 99)).toBe(false);
        expect(publisher.stats[KIND_VIDEO].framesDropped).toBe(1);
        fail = true;
        while (publisher.stats[KIND_VIDEO].framesDropped < 1 + MAX_FRAMES_SEALING) {
            await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
            pending.shift()!();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        // The failures are reported on the next frame, so the video sender asks for a key frame.
        expect(publisher.publish(KIND_VIDEO, false, Uint8Array.of(1), 1)).toBe(false);
        expect(publisher.publish(KIND_VIDEO, false, Uint8Array.of(2), 2)).toBe(true);
    });

    it("reports a sealed frame the socket refused on that kind's next delta frame, and lets a key frame through", async () => {
        const accepted: boolean[] = [true, false];
        const sent: Uint8Array[] = [];
        const cipher = { encryptFrame: async (_header: FrameHeader, frame: Uint8Array) => frame, decryptFrame: async () => undefined };
        const publisher = new FramePublisher((m) => {
            const ok = accepted.shift() ?? true;
            if (ok) {
                sent.push(m);
            }
            return ok;
        }, undefined, cipher);
        expect(publisher.publish(KIND_VIDEO, true, Uint8Array.of(1), 0)).toBe(true);
        expect(publisher.publish(KIND_VIDEO, false, Uint8Array.of(2), 1)).toBe(true);
        await vi.waitFor(() => expect(publisher.stats[KIND_VIDEO].framesDropped).toBe(1));
        // Audio has its own flag.
        expect(publisher.publish(KIND_AUDIO, true, Uint8Array.of(9), 1)).toBe(true);
        expect(publisher.publish(KIND_VIDEO, false, Uint8Array.of(3), 2)).toBe(false);
        expect(publisher.stats[KIND_VIDEO].framesDropped).toBe(2);
        expect(publisher.publish(KIND_VIDEO, false, Uint8Array.of(4), 3)).toBe(true);

        await vi.waitFor(() => expect(sent).toHaveLength(3));
        accepted.push(false);
        expect(publisher.publish(KIND_VIDEO, false, Uint8Array.of(5), 4)).toBe(true);
        await vi.waitFor(() => expect(publisher.stats[KIND_VIDEO].framesDropped).toBe(3));
        expect(publisher.publish(KIND_VIDEO, true, Uint8Array.of(6), 5)).toBe(true);
        await vi.waitFor(() => expect(sent).toHaveLength(4));
        expect(decodeFragment(sent[3])!.keyFrame).toBe(true);
    });
});
