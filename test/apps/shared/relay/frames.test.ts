///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    decodeFragment,
    FLAG_KEY_FRAME,
    fragmentFrame,
    FrameReassembler,
    HEADER_BYTES,
    KIND_AUDIO,
    KIND_VIDEO,
    DEFAULT_FRAGMENT_BYTES,
    DEFAULT_MESSAGE_BYTES,
    fragmentPayloadSize,
    MAX_FRAGMENT_BYTES,
    MAX_FRAGMENTS,
    MAX_FRAME_BYTES,
    seqIsNewer,
    TimestampUnwrapper,
    type Fragment,
} from "../../../../apps/shared/relay/frames.js";

function bytes(length: number, fill = 7): Uint8Array {
    return new Uint8Array(length).fill(fill);
}

/** Decodes every fragment `fragmentFrame()` produced, failing the test if any is malformed. */
function decodeAll(fragments: Uint8Array[]): Fragment[] {
    return fragments.map((f) => {
        const decoded = decodeFragment(f);
        expect(decoded).toBeDefined();
        return decoded as Fragment;
    });
}

describe("fragmentFrame / decodeFragment", () => {
    it("writes the documented big-endian header", () => {
        const [fragment] = fragmentFrame(KIND_VIDEO, true, 0x1234, 0xaabbccdd, Uint8Array.of(9, 8, 7));
        expect(Array.from(fragment)).toEqual([2, FLAG_KEY_FRAME, 0x12, 0x34, 0, 1, 0xaa, 0xbb, 0xcc, 0xdd, 9, 8, 7]);
    });

    it("produces one header-only fragment for an empty frame", () => {
        const fragments = fragmentFrame(KIND_AUDIO, false, 1, 2, new Uint8Array(0));
        expect(fragments).toHaveLength(1);
        expect(fragments[0]).toHaveLength(HEADER_BYTES);
        expect(decodeFragment(fragments[0])).toMatchObject({ kind: KIND_AUDIO, keyFrame: false, fragCount: 1, fragIndex: 0 });
    });

    it("splits a large frame into ceil(len / 12000) fragments that each fit a WebSocket message", () => {
        const data = Uint8Array.from({ length: 30_000 }, (_, i) => i % 251);
        const fragments = fragmentFrame(KIND_VIDEO, false, 5, 6, data);
        expect(fragments).toHaveLength(3);
        expect(fragments.map((f) => f.length)).toEqual([HEADER_BYTES + 12_000, HEADER_BYTES + 12_000, HEADER_BYTES + 6_000]);
        const decoded = decodeAll(fragments);
        expect(decoded.map((f) => [f.fragIndex, f.fragCount])).toEqual([
            [0, 3],
            [1, 3],
            [2, 3],
        ]);
        expect(DEFAULT_FRAGMENT_BYTES + HEADER_BYTES + 1 + 255).toBeLessThan(16_384);
    });

    it("reduces seq and timestamp modulo their field widths", () => {
        const [fragment] = fragmentFrame(KIND_AUDIO, true, 65_536 + 3, 2 ** 32 + 9, bytes(1));
        expect(decodeFragment(fragment)).toMatchObject({ seq: 3, timestampMs: 9 });
    });

    it("refuses to fragment a frame above the receiver's size cap", () => {
        expect(fragmentFrame(KIND_VIDEO, true, 0, 0, new Uint8Array(MAX_FRAME_BYTES + 1))).toEqual([]);
        expect(fragmentFrame(KIND_VIDEO, true, 0, 0, new Uint8Array(MAX_FRAME_BYTES)).length).toBeGreaterThan(0);
    });

    it("decodes the data as a view starting after the header, even inside a larger buffer", () => {
        const [fragment] = fragmentFrame(KIND_AUDIO, false, 1, 1, Uint8Array.of(1, 2, 3));
        const padded = new Uint8Array(fragment.length + 4);
        padded.set(fragment, 2);
        const decoded = decodeFragment(padded.subarray(2, 2 + fragment.length));
        expect(Array.from(decoded?.data ?? [])).toEqual([1, 2, 3]);
    });

    it("rejects malformed input without throwing", () => {
        expect(decodeFragment(new Uint8Array(0))).toBeUndefined();
        expect(decodeFragment(new Uint8Array(HEADER_BYTES - 1))).toBeUndefined();
        const good = fragmentFrame(KIND_AUDIO, false, 1, 1, bytes(2))[0];
        for (const kind of [0, 3, 255]) {
            const bad = Uint8Array.from(good);
            bad[0] = kind;
            expect(decodeFragment(bad)).toBeUndefined();
        }
        const zeroCount = Uint8Array.from(good);
        zeroCount[5] = 0;
        expect(decodeFragment(zeroCount)).toBeUndefined();
        const indexPastCount = Uint8Array.from(good);
        indexPastCount[4] = 1;
        expect(decodeFragment(indexPastCount)).toBeUndefined();
    });
});

describe("fragmentPayloadSize", () => {
    it("keeps the un-negotiated 16384 limit at the historical 12000 byte payload", () => {
        expect(DEFAULT_FRAGMENT_BYTES).toBe(12_000);
        expect(fragmentPayloadSize(DEFAULT_MESSAGE_BYTES)).toBe(12_000);
    });

    it("uses whatever a smaller limit leaves after the header", () => {
        expect(fragmentPayloadSize(2048)).toBe(2038);
        expect(fragmentPayloadSize(12_010)).toBe(12_000);
        expect(fragmentPayloadSize(12_000)).toBe(11_990);
        // Never zero or negative, however small the limit.
        expect(fragmentPayloadSize(5)).toBe(1);
    });

    it("uses the whole message above the default limit, up to the 60000 ceiling", () => {
        expect(fragmentPayloadSize(16_385)).toBe(16_375);
        expect(fragmentPayloadSize(65_536)).toBe(60_000);
        expect(fragmentPayloadSize(70_000)).toBe(60_000);
        expect(fragmentPayloadSize(1024 * 1024)).toBe(MAX_FRAGMENT_BYTES);
        expect(MAX_FRAGMENT_BYTES).toBe(60_000);
        expect(fragmentPayloadSize(60_010)).toBe(60_000);
        expect(fragmentPayloadSize(50_010)).toBe(50_000);
    });
});

describe("fragmentFrame with a negotiated message limit", () => {
    const key = (length: number) => Uint8Array.from({ length }, (_, i) => i % 253);

    it("puts a 30 KB key frame in one message when the limit is 65536", () => {
        const fragments = fragmentFrame(KIND_VIDEO, true, 1, 2, key(30_000), 65_536);
        expect(fragments).toHaveLength(1);
        expect(fragments[0]).toHaveLength(HEADER_BYTES + 30_000);
        expect(decodeFragment(fragments[0])).toMatchObject({ fragCount: 1, fragIndex: 0 });
    });

    it("never exceeds the limit: 16384 gives the historical 12000 byte fragments, byte for byte", () => {
        const explicit = fragmentFrame(KIND_VIDEO, true, 7, 9, key(30_000), 16_384);
        const implicit = fragmentFrame(KIND_VIDEO, true, 7, 9, key(30_000));
        expect(explicit).toEqual(implicit);
        expect(explicit.map((f) => f.length)).toEqual([12_010, 12_010, 6_010]);
        expect(Math.max(...explicit.map((f) => f.length))).toBeLessThanOrEqual(16_384);
    });

    it("caps fragments at 60000 payload bytes however large the limit", () => {
        const fragments = fragmentFrame(KIND_VIDEO, true, 1, 2, key(150_000), 1024 * 1024);
        expect(fragments.map((f) => f.length - HEADER_BYTES)).toEqual([60_000, 60_000, 30_000]);
        const smaller = fragmentFrame(KIND_VIDEO, true, 1, 2, key(150_000), 65_536);
        expect(smaller.map((f) => f.length)).toEqual([60_010, 60_010, 30_010]);
    });

    it("refuses a frame that would need more than 255 fragments", () => {
        // 1014 payload bytes per message: 260 KB is 257 fragments.
        expect(fragmentFrame(KIND_VIDEO, true, 1, 2, key(1014 * 256), 1024)).toEqual([]);
        expect(fragmentFrame(KIND_VIDEO, true, 1, 2, key(1014 * MAX_FRAGMENTS), 1024)).toHaveLength(MAX_FRAGMENTS);
    });

    it("reassembles fragments of any size up to the ceiling", () => {
        for (const limit of [1024, 2048, 16_384, 20_000, 65_536, 1024 * 1024]) {
            const data = key(150_000 > (limit - HEADER_BYTES) * 200 ? 100_000 : 150_000);
            const fragments = fragmentFrame(KIND_VIDEO, true, 3, 4, data, limit);
            expect(fragments.length).toBeGreaterThan(0);
            const reassembler = new FrameReassembler();
            const out = decodeAll(fragments).map((f) => reassembler.push(f)).filter(Boolean);
            expect(out).toHaveLength(1);
            expect(out[0]?.data).toEqual(data);
        }
    });
});

describe("seqIsNewer", () => {
    it("compares 16 bit sequence numbers circularly", () => {
        expect(seqIsNewer(2, 1)).toBe(true);
        expect(seqIsNewer(1, 2)).toBe(false);
        expect(seqIsNewer(5, 5)).toBe(false);
        expect(seqIsNewer(0, 65_535)).toBe(true);
        expect(seqIsNewer(65_535, 0)).toBe(false);
        expect(seqIsNewer(0x8000, 0)).toBe(false);
        expect(seqIsNewer(0x7fff, 0)).toBe(true);
    });
});

describe("FrameReassembler", () => {
    function push(reassembler: FrameReassembler, fragments: Uint8Array[]) {
        return decodeAll(fragments).map((f) => reassembler.push(f));
    }

    it("delivers a single-fragment frame immediately", () => {
        const reassembler = new FrameReassembler();
        const [frame] = push(reassembler, fragmentFrame(KIND_AUDIO, true, 1, 100, Uint8Array.of(1, 2)));
        expect(frame).toMatchObject({ kind: KIND_AUDIO, keyFrame: true, seq: 1, timestampMs: 100 });
        expect(Array.from(frame?.data ?? [])).toEqual([1, 2]);
    });

    it("reassembles fragments arriving in any order", () => {
        const data = Uint8Array.from({ length: 30_000 }, (_, i) => i % 199);
        const fragments = decodeAll(fragmentFrame(KIND_VIDEO, true, 9, 1234, data));
        const reassembler = new FrameReassembler();
        expect(reassembler.push(fragments[2])).toBeUndefined();
        expect(reassembler.push(fragments[0])).toBeUndefined();
        const frame = reassembler.push(fragments[1]);
        expect(frame).toMatchObject({ kind: KIND_VIDEO, keyFrame: true, seq: 9, timestampMs: 1234 });
        expect(frame?.data).toEqual(data);
    });

    it("abandons an incomplete frame when a newer one starts", () => {
        const reassembler = new FrameReassembler();
        const old = decodeAll(fragmentFrame(KIND_VIDEO, false, 1, 1, bytes(20_000)));
        expect(reassembler.push(old[0])).toBeUndefined();
        const next = decodeAll(fragmentFrame(KIND_VIDEO, false, 2, 2, bytes(20_000, 9)));
        expect(reassembler.push(next[0])).toBeUndefined();
        // The straggler of the abandoned frame is now older than what is being collected.
        expect(reassembler.push(old[1])).toBeUndefined();
        const frame = reassembler.push(next[1]);
        expect(frame?.seq).toBe(2);
        expect(frame?.data.every((b) => b === 9)).toBe(true);
    });

    it("abandons an incomplete frame in favour of a newer single-fragment frame", () => {
        const reassembler = new FrameReassembler();
        reassembler.push(decodeAll(fragmentFrame(KIND_VIDEO, false, 1, 1, bytes(20_000)))[0]);
        const [frame] = push(reassembler, fragmentFrame(KIND_VIDEO, false, 2, 2, bytes(5)));
        expect(frame?.seq).toBe(2);
    });

    it("ignores a duplicate of a frame it already delivered", () => {
        const reassembler = new FrameReassembler();
        const [fragment] = decodeAll(fragmentFrame(KIND_AUDIO, true, 4, 4, bytes(3)));
        expect(reassembler.push(fragment)).toBeDefined();
        expect(reassembler.push(fragment)).toBeUndefined();
        const multi = decodeAll(fragmentFrame(KIND_VIDEO, true, 5, 5, bytes(15_000)));
        reassembler.push(multi[0]);
        expect(reassembler.push(multi[1])).toBeDefined();
        expect(reassembler.push(multi[1])).toBeUndefined();
    });

    it("ignores a duplicate fragment of the frame being collected", () => {
        const reassembler = new FrameReassembler();
        const fragments = decodeAll(fragmentFrame(KIND_VIDEO, true, 5, 5, bytes(15_000)));
        reassembler.push(fragments[0]);
        expect(reassembler.push(fragments[0])).toBeUndefined();
        expect(reassembler.push(fragments[1])?.data).toHaveLength(15_000);
    });

    it("ignores fragments inconsistent with the frame being collected", () => {
        const reassembler = new FrameReassembler();
        const fragments = decodeAll(fragmentFrame(KIND_VIDEO, true, 5, 5, bytes(15_000)));
        reassembler.push(fragments[0]);
        expect(reassembler.push({ ...fragments[1], fragCount: 3 })).toBeUndefined();
        expect(reassembler.push({ ...fragments[1], keyFrame: false })).toBeUndefined();
        expect(reassembler.push({ ...fragments[1], timestampMs: 6 })).toBeUndefined();
        // A single-fragment claim for the same seq cannot replace the frame in progress either.
        expect(reassembler.push({ ...fragments[1], fragCount: 1, fragIndex: 0 })).toBeUndefined();
        // The genuine fragment still completes it.
        expect(reassembler.push(fragments[1])?.data).toHaveLength(15_000);
    });

    it("abandons a frame that grows past the size cap and ignores its remaining fragments", () => {
        const reassembler = new FrameReassembler();
        const count = 100;
        const make = (index: number): Fragment => ({
            kind: KIND_VIDEO,
            keyFrame: true,
            seq: 1,
            fragIndex: index,
            fragCount: count,
            timestampMs: 1,
            data: bytes(DEFAULT_FRAGMENT_BYTES),
        });
        let delivered = false;
        for (let i = 0; i < count; i++) {
            delivered = reassembler.push(make(i)) !== undefined || delivered;
        }
        expect(delivered).toBe(false);
        // 100 x 12000 bytes exceeds 1 MiB: nothing was ever delivered, and a following frame still works.
        expect(push(reassembler, fragmentFrame(KIND_VIDEO, true, 2, 2, bytes(4)))[0]?.seq).toBe(2);
    });

    it("handles the sequence counter wrapping", () => {
        const reassembler = new FrameReassembler();
        expect(push(reassembler, fragmentFrame(KIND_AUDIO, true, 65_535, 1, bytes(1)))[0]?.seq).toBe(65_535);
        expect(push(reassembler, fragmentFrame(KIND_AUDIO, true, 0, 2, bytes(1)))[0]?.seq).toBe(0);
    });

    it("ignores stragglers from before the current sequence, but follows a sender that restarted its counter", () => {
        const reassembler = new FrameReassembler();
        push(reassembler, fragmentFrame(KIND_AUDIO, true, 5_000, 1, bytes(1)));
        // A sender that restarted at seq 0 looks 5000 frames old; a short run of it is treated as stragglers...
        for (let i = 0; i < 63; i++) {
            expect(push(reassembler, fragmentFrame(KIND_AUDIO, true, i, 1, bytes(1)))[0]).toBeUndefined();
        }
        // ... and the 64th resynchronises and is delivered.
        expect(push(reassembler, fragmentFrame(KIND_AUDIO, true, 63, 1, bytes(1)))[0]?.seq).toBe(63);
        expect(push(reassembler, fragmentFrame(KIND_AUDIO, true, 64, 1, bytes(1)))[0]?.seq).toBe(64);
    });

    it("a newer frame resets the straggler count", () => {
        const reassembler = new FrameReassembler();
        push(reassembler, fragmentFrame(KIND_AUDIO, true, 100, 1, bytes(1)));
        for (let i = 0; i < 40; i++) {
            push(reassembler, fragmentFrame(KIND_AUDIO, true, 50, 1, bytes(1)));
        }
        push(reassembler, fragmentFrame(KIND_AUDIO, true, 101, 1, bytes(1)));
        for (let i = 0; i < 40; i++) {
            expect(push(reassembler, fragmentFrame(KIND_AUDIO, true, 50, 1, bytes(1)))[0]).toBeUndefined();
        }
    });

    it("reset() forgets everything, so any sequence is accepted next", () => {
        const reassembler = new FrameReassembler();
        push(reassembler, fragmentFrame(KIND_AUDIO, true, 5_000, 1, bytes(1)));
        reassembler.reset();
        expect(push(reassembler, fragmentFrame(KIND_AUDIO, true, 3, 1, bytes(1)))[0]?.seq).toBe(3);
    });
});

describe("TimestampUnwrapper", () => {
    it("is relative to the first timestamp and monotonic", () => {
        const unwrapper = new TimestampUnwrapper();
        expect(unwrapper.next(1000)).toBe(0);
        expect(unwrapper.next(1020)).toBe(20);
        expect(unwrapper.next(1040)).toBe(40);
    });

    it("survives the u32 wrap", () => {
        const unwrapper = new TimestampUnwrapper();
        const start = 2 ** 32 - 30;
        expect(unwrapper.next(start)).toBe(0);
        expect(unwrapper.next(2 ** 32 - 10)).toBe(20);
        expect(unwrapper.next(10)).toBe(40);
        expect(unwrapper.next(30)).toBe(60);
    });

    it("steps back for a frame that arrives slightly out of order", () => {
        const unwrapper = new TimestampUnwrapper();
        unwrapper.next(1000);
        unwrapper.next(1040);
        expect(unwrapper.next(1020)).toBe(20);
    });
});
