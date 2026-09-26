///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The media frame format carried inside a relay WebSocket message - see `RelayClient.ts` for the envelope the
 * server wraps around it. The server treats the payload as opaque bytes, so everything in this module is a contract
 * between two browsers running this same code, and it has to survive an unreliable transport: a WebSocket to the
 * relay is ordered and lossless per connection, but the server drops binary messages under backpressure, so a
 * receiver must cope with missing fragments without throwing or growing its memory without bound.
 *
 * ## Layout (all big-endian)
 *
 * A frame (one encoded audio packet or one encoded video picture) is split into fragments sized to the largest
 * WebSocket message the server accepts (`fragmentPayloadSize()`): an older server allows only 16384 bytes (a larger
 * message closes the socket) and a key frame easily runs to tens of kilobytes, while a current one announces a
 * larger limit in its `ready` reply. Each fragment is
 *
 * `[kind u8][flags u8][seq u16][fragIndex u8][fragCount u8][timestampMs u32][fragment bytes]`
 *
 * `seq` is a per-kind frame counter that wraps at 65536, so a receiver can tell fragments of different frames
 * apart and notice a gap. `timestampMs` is the sender's monotonic clock and also wraps (at about 49.7 days), which
 * is why the receiver runs it through `TimestampUnwrapper` before handing it to a decoder.
 */

export const KIND_AUDIO = 1;
export const KIND_VIDEO = 2;
export type FrameKind = typeof KIND_AUDIO | typeof KIND_VIDEO;

/** Bit 0 of the flags byte: this frame is independently decodable (always set for audio packets). */
export const FLAG_KEY_FRAME = 1;

export const HEADER_BYTES = 10;
/** The largest client-to-server message an older server accepts, and what a client assumes until the server's
 * `ready` says otherwise. */
export const DEFAULT_MESSAGE_BYTES = 16_384;
/** The payload size used under the default limit. It is well below 16384 - 10 so an older server keeps behaving
 * exactly as it always has, with headroom besides. */
export const DEFAULT_FRAGMENT_BYTES = 12_000;
/** The ceiling on the payload of one fragment, however large a message the server accepts: bigger messages gain
 * nothing for a 480x360 stream and make one lost message cost more. */
export const MAX_FRAGMENT_BYTES = 60_000;
/** The most fragments a frame may have (`fragCount` is one byte). */
export const MAX_FRAGMENTS = 255;
/** The largest frame a receiver will buffer. A 480x360 VP8 key frame at the rates the sender uses is a small
 * fraction of this; the cap exists so a hostile or buggy peer cannot make a receiver allocate without bound. */
export const MAX_FRAME_BYTES = 1024 * 1024;

const SEQ_MODULUS = 0x10000;
const HALF_SEQ = 0x8000;
/** How many consecutive fragments from an "older" sequence are ignored before the receiver decides the sender
 * restarted its counter and resynchronises to it. */
const RESYNC_AFTER_STALE = 64;

/** One decoded fragment header plus a view of its bytes. */
export interface Fragment {
    kind: FrameKind;
    keyFrame: boolean;
    seq: number;
    fragIndex: number;
    fragCount: number;
    timestampMs: number;
    data: Uint8Array;
}

/** A completely reassembled frame. */
export interface Frame {
    kind: FrameKind;
    keyFrame: boolean;
    seq: number;
    timestampMs: number;
    data: Uint8Array;
}

/** The payload bytes per fragment for a server that accepts messages of `maxMessageBytes`. At or below the
 * default limit that is `DEFAULT_FRAGMENT_BYTES` (or less, for a smaller limit); above it, everything the limit
 * leaves after the header, capped at `MAX_FRAGMENT_BYTES`. A message is therefore never larger than the limit. */
export function fragmentPayloadSize(maxMessageBytes: number): number {
    const room = Math.max(1, maxMessageBytes - HEADER_BYTES);
    return maxMessageBytes <= DEFAULT_MESSAGE_BYTES ? Math.min(DEFAULT_FRAGMENT_BYTES, room) : Math.min(MAX_FRAGMENT_BYTES, room);
}

/** Splits `data` into wire-ready fragments (header included), each at most `maxMessageBytes` long (default: what an
 * older server accepts). An empty frame still produces one (header-only) fragment. Returns an empty array for a frame
 * the receiver would refuse anyway - larger than `MAX_FRAME_BYTES`, or needing more than `MAX_FRAGMENTS` fragments at
 * this message size - so it is not worth sending. `seq` and `timestampMs` are reduced modulo their field widths, so a
 * caller can pass a free-running counter or clock. */
export function fragmentFrame(
    kind: FrameKind,
    keyFrame: boolean,
    seq: number,
    timestampMs: number,
    data: Uint8Array,
    maxMessageBytes = DEFAULT_MESSAGE_BYTES,
): Uint8Array[] {
    const payload = fragmentPayloadSize(maxMessageBytes);
    const fragCount = Math.max(1, Math.ceil(data.length / payload));
    if (data.length > MAX_FRAME_BYTES || fragCount > MAX_FRAGMENTS) {
        return [];
    }
    const fragments: Uint8Array[] = [];
    for (let index = 0; index < fragCount; index++) {
        const part = data.subarray(index * payload, (index + 1) * payload);
        const out = new Uint8Array(HEADER_BYTES + part.length);
        const view = new DataView(out.buffer);
        view.setUint8(0, kind);
        view.setUint8(1, keyFrame ? FLAG_KEY_FRAME : 0);
        view.setUint16(2, seq % SEQ_MODULUS);
        view.setUint8(4, index);
        view.setUint8(5, fragCount);
        view.setUint32(6, timestampMs >>> 0);
        out.set(part, HEADER_BYTES);
        fragments.push(out);
    }
    return fragments;
}

/** Parses one fragment, or returns `undefined` for anything that is not a well-formed one (too short, unknown
 * kind, a zero fragment count, an index beyond the count). Never throws: the bytes come off the network. */
export function decodeFragment(bytes: Uint8Array): Fragment | undefined {
    if (bytes.length < HEADER_BYTES) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const kind = view.getUint8(0);
    if (kind !== KIND_AUDIO && kind !== KIND_VIDEO) {
        return undefined;
    }
    const fragIndex = view.getUint8(4);
    const fragCount = view.getUint8(5);
    if (fragCount === 0 || fragIndex >= fragCount) {
        return undefined;
    }
    return {
        kind,
        keyFrame: (view.getUint8(1) & FLAG_KEY_FRAME) !== 0,
        seq: view.getUint16(2),
        fragIndex,
        fragCount,
        timestampMs: view.getUint32(6),
        data: bytes.subarray(HEADER_BYTES),
    };
}

/** True when `a` is a later sequence number than `b`, treating the 16 bit counter as circular. */
export function seqIsNewer(a: number, b: number): boolean {
    const diff = (a - b + SEQ_MODULUS) % SEQ_MODULUS;
    return diff !== 0 && diff < HALF_SEQ;
}

/** A frame being collected. */
interface Pending {
    seq: number;
    fragCount: number;
    keyFrame: boolean;
    timestampMs: number;
    parts: (Uint8Array | undefined)[];
    received: number;
    bytes: number;
}

/**
 * Collects the fragments of one sender's one media kind back into whole frames. It holds at most one frame in
 * flight: the moment a fragment of a newer sequence arrives, an incomplete older frame is abandoned (its missing
 * piece was dropped by the server, and waiting longer would only add latency). Everything is validated and nothing
 * throws, so a garbage or hostile stream can at worst cost the frames it corrupts.
 */
export class FrameReassembler {
    private pending: Pending | undefined;
    private lastSeq: number | undefined;
    private stale = 0;

    /** Feeds one fragment. Returns the frame if this fragment completed it. */
    push(fragment: Fragment): Frame | undefined {
        if (this.lastSeq === undefined || seqIsNewer(fragment.seq, this.lastSeq)) {
            this.stale = 0;
            this.lastSeq = fragment.seq;
            this.pending = undefined;
        } else if (fragment.seq !== this.lastSeq) {
            // Older than what is already being (or has been) collected: a straggler, unless the sender restarted its
            // counter and everything it sends now looks older, in which case follow it after a run of them.
            this.stale += 1;
            if (this.stale < RESYNC_AFTER_STALE) {
                return undefined;
            }
            this.stale = 0;
            this.lastSeq = fragment.seq;
            this.pending = undefined;
        } else if (!this.pending) {
            // A further fragment of a frame that was already delivered, or that was abandoned as too big.
            return undefined;
        }

        if (fragment.fragCount === 1 && !this.pending) {
            // The common case (every audio packet, most delta frames): nothing to collect.
            return this.finish(fragment, [fragment.data], fragment.data.length);
        }
        return this.collect(fragment);
    }

    /** Drops any frame in flight, e.g. after the consumer reset its decoder. */
    reset(): void {
        this.pending = undefined;
        this.lastSeq = undefined;
        this.stale = 0;
    }

    private collect(fragment: Fragment): Frame | undefined {
        let pending = this.pending;
        if (!pending) {
            pending = {
                seq: fragment.seq,
                fragCount: fragment.fragCount,
                keyFrame: fragment.keyFrame,
                timestampMs: fragment.timestampMs,
                parts: new Array<Uint8Array | undefined>(fragment.fragCount).fill(undefined),
                received: 0,
                bytes: 0,
            };
            this.pending = pending;
        }
        if (
            fragment.fragCount !== pending.fragCount ||
            fragment.keyFrame !== pending.keyFrame ||
            fragment.timestampMs !== pending.timestampMs ||
            pending.parts[fragment.fragIndex] !== undefined
        ) {
            // Inconsistent with the frame being built (or a duplicate): ignore this fragment, keep what is there.
            return undefined;
        }
        pending.bytes += fragment.data.length;
        if (pending.bytes > MAX_FRAME_BYTES) {
            // Too big to be a frame this sender could legitimately have produced. Abandon it; `lastSeq` stays put so
            // its remaining fragments are ignored rather than starting a fresh collection.
            this.pending = undefined;
            return undefined;
        }
        pending.parts[fragment.fragIndex] = fragment.data;
        pending.received += 1;
        if (pending.received < pending.fragCount) {
            return undefined;
        }
        this.pending = undefined;
        return this.finish(fragment, pending.parts as Uint8Array[], pending.bytes);
    }

    private finish(fragment: Fragment, parts: Uint8Array[], total: number): Frame {
        const data = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
            data.set(part, offset);
            offset += part.length;
        }
        return { kind: fragment.kind, keyFrame: fragment.keyFrame, seq: fragment.seq, timestampMs: fragment.timestampMs, data };
    }
}

/**
 * Turns the wrapping 32 bit millisecond timestamps into a monotonic number a decoder can be given. The signed
 * difference from the previous value is taken modulo 2^32, so it is correct across the wrap point and also for a
 * frame that arrives slightly out of order (a small negative step).
 */
export class TimestampUnwrapper {
    private last: number | undefined;
    private unwrapped = 0;

    /** Returns the unwrapped time in milliseconds relative to the first timestamp seen. */
    next(timestampMs: number): number {
        if (this.last !== undefined) {
            this.unwrapped += (timestampMs - this.last) | 0;
        }
        this.last = timestampMs;
        return this.unwrapped;
    }
}
