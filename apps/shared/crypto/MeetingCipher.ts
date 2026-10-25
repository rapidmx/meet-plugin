///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The end-to-end encryption of a protected meeting's live traffic (`specs/meeting_privacy.md` §5), with its live key (`deriveLiveKey()`
 * in web-client's `lib/crypto/meetingKeys.ts`):
 *
 * - **Signaling** (version 2): every `SignalMessage` - offers, answers, ICE candidates, presence and names, moderation, chat, whiteboard,
 * cursors, reactions - travels as `{ to?, e }`, `e` being AES-256-GCM of `{ from, peer, n, t, data }` bound to the meeting. The server
 * still stamps `from`/`peer` and routes by `to`; a receiver drops a message it can't open, one whose sealed sender differs from the
 * stamped one, one replayed (`n` not above the last it accepted from that peer), one sealed more than `MAX_SIGNAL_AGE_MS` from now
 * (`t`, so what the server kept from an earlier session or occurrence can't be passed off as live), and anything sent in the clear.
 * - **Relay frames** (version 2): each encoded audio packet or video picture is sealed before it is fragmented, bound to its sender
 * and to every header field a receiver acts on (kind, key-frame flag, seq, timestamp - `FrameHeader`), so a relay or peer rewriting
 * one makes the frame fail to open. A receiver drops a frame whose nonce it already accepted from that sender, or one too far behind
 * the newest (`FRAME_REPLAY_WINDOW`).
 *
 * Authenticating the signaling is also what makes direct peer-to-peer media end to end: the server can no longer swap the DTLS
 * fingerprints in the SDP it relays.
 */
import { fromBase64Url, toBase64Url } from "@rapidmx/web-client/lib/crypto/encoding.js";
import type { SignalMessage } from "../webrtc/types.js";

/** What `SignalingClient` seals and opens with (`MeetingCipher` in a protected meeting). */
export interface SignalCipher {
    /** The `data` to send for `message`. */
    seal(message: SignalMessage): Promise<Record<string, unknown>>;
    /** The message in the received `data` (with the server's stamped `from`/`peer`), or `undefined` when it must be dropped. */
    open(data: Record<string, unknown>): Promise<SignalMessage | undefined>;
    /** The most plaintext (UTF-8 bytes of a message's JSON) one message may carry for its sealed envelope to stay within
     * `maxEnvelopeBytes`, the server's limit. */
    plaintextBudget?(maxEnvelopeBytes: number): number;
}

/** The header fields of a relay frame (`apps/shared/relay/frames.ts`) its seal is bound to: everything a receiver acts on besides
 * the fragment numbering, which only splits the sealed bytes (reordering or re-splitting them makes them fail to open). */
export interface FrameHeader {
    kind: number;
    keyFrame: boolean;
    /** As on the wire: the per-kind counter modulo 65536. */
    seq: number;
    /** As on the wire: the sender's clock in milliseconds modulo 2^32. */
    timestampMs: number;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 4;
/** What a frame's AAD starts with; the version changes whenever what it binds does. */
const FRAME_AAD_TAG = new TextEncoder().encode("rapidmx-frame-v2|");
/** kind u8, key-frame u8, seq u16, timestamp u32 - see `frameAad()`. */
const FRAME_AAD_HEADER_BYTES = 8;

/** How far from this tab's clock a signal's sealing time (`t`) may be: room for a message held while the socket reconnects, and for
 * the difference between two participants' clocks. */
export const MAX_SIGNAL_AGE_MS = 5 * 60 * 1000;

/** How many frame counters below the highest one accepted from a sender are still accepted, once each: audio and video share the
 * counter, so their frames don't always complete in the order they were sealed. */
export const FRAME_REPLAY_WINDOW = 128n;

/** What a sealed message's envelope adds around `e`: `{"op":"signal","data":{"to":"<peer id>","e":""}}`, with room for a long peer id. */
const SIGNAL_ENVELOPE_OVERHEAD_BYTES = 512;
/** What the sealed plaintext adds around the message: `{"from":..,"peer":..,"n":..,"t":..,"data":}`, with room for long ids. */
const SIGNAL_INNER_OVERHEAD_BYTES = 512;

/** The frames accepted from one sender: its session's salt, the highest counter, and which of the `FRAME_REPLAY_WINDOW` counters below
 * it were seen (bit `i` is `highest - i`). */
interface FrameReplayState {
    salt: string;
    highest: bigint;
    seen: bigint;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export class MeetingCipher implements SignalCipher {
    private sent = 0;
    /** The highest `n` accepted per peer. */
    private readonly accepted = new Map<string, number>();
    private readonly signalAad: Uint8Array;
    /** This sender's frame nonces: a random salt for this session (drawn with the first frame), then a counter. */
    private frameSalt?: Uint8Array;
    private frameCounter = 0n;
    /** The frames accepted per sender peer - see `acceptFrameNonce()`. */
    private readonly framesAccepted = new Map<string, FrameReplayState>();

    /**
     * @param liveKey The meeting's live AES-GCM key.
     * @param meetingUid The meeting both directions are bound to.
     * @param self Who this tab is: what it seals as its sender.
     * @param now This tab's clock - a test's only reason to set it.
     */
    constructor(
        private readonly liveKey: CryptoKey,
        meetingUid: string,
        private readonly self: { uid: string; peer: string },
        private readonly now: () => number = Date.now,
    ) {
        this.signalAad = new TextEncoder().encode(`rapidmx-signal-v2|${meetingUid}`);
    }

    public async seal(message: SignalMessage): Promise<Record<string, unknown>> {
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const plain = new TextEncoder().encode(JSON.stringify({ from: this.self.uid, peer: this.self.peer, n: ++this.sent, t: this.now(), data: message }));
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.signalAad as BufferSource }, this.liveKey, plain));
        const e = toBase64Url(concat(iv, sealed));
        return message.to !== undefined ? { to: message.to, e } : { e };
    }

    public async open(data: Record<string, unknown>): Promise<SignalMessage | undefined> {
        if (typeof data.e !== "string") {
            return undefined;
        }
        let inner: { from?: unknown; peer?: unknown; n?: unknown; t?: unknown; data?: unknown };
        try {
            const bytes = fromBase64Url(data.e);
            const plain = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) as BufferSource, additionalData: this.signalAad as BufferSource },
                this.liveKey,
                bytes.subarray(IV_BYTES) as BufferSource,
            );
            inner = JSON.parse(new TextDecoder().decode(plain));
        } catch {
            return undefined;
        }
        if (!inner || typeof inner.data !== "object" || inner.data === null || inner.from !== data.from || inner.peer !== data.peer) {
            return undefined;
        }
        const peer = String(data.peer ?? data.from);
        if (typeof inner.n !== "number" || !(inner.n > (this.accepted.get(peer) ?? 0))) {
            return undefined;
        }
        if (typeof inner.t !== "number" || !(Math.abs(this.now() - inner.t) <= MAX_SIGNAL_AGE_MS)) {
            return undefined;
        }
        this.accepted.set(peer, inner.n);
        // The server's stamps, which the sealed sender has just been checked against.
        return { ...(inner.data as SignalMessage), from: data.from as string, peer: data.peer as string | undefined };
    }

    public plaintextBudget(maxEnvelopeBytes: number): number {
        // base64url turns every 3 bytes into 4.
        const sealedBytes = Math.floor(((maxEnvelopeBytes - SIGNAL_ENVELOPE_OVERHEAD_BYTES) * 3) / 4);
        return sealedBytes - IV_BYTES - TAG_BYTES - SIGNAL_INNER_OVERHEAD_BYTES;
    }

    /** `frame` (one encoded packet or picture) sealed to send through the relay under `header`: nonce, then ciphertext. */
    public async encryptFrame(header: FrameHeader, frame: Uint8Array): Promise<Uint8Array> {
        const nonce = new Uint8Array(IV_BYTES);
        this.frameSalt ??= crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        nonce.set(this.frameSalt, 0);
        new DataView(nonce.buffer).setBigUint64(SALT_BYTES, ++this.frameCounter);
        const sealed = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce, additionalData: this.frameAad(header, this.self.peer) as BufferSource },
            this.liveKey,
            frame as BufferSource,
        );
        return concat(nonce, new Uint8Array(sealed));
    }

    /** A relayed frame from `senderPeer` that arrived under `header`, opened - `undefined` when it doesn't open (another key, tampered
     * bytes or header, or not sealed) or is a replay (`acceptFrameNonce()`). */
    public async decryptFrame(header: FrameHeader, senderPeer: string, payload: Uint8Array): Promise<Uint8Array | undefined> {
        if (payload.length <= IV_BYTES) {
            return undefined;
        }
        let frame: Uint8Array;
        try {
            frame = new Uint8Array(
                await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: payload.subarray(0, IV_BYTES) as BufferSource, additionalData: this.frameAad(header, senderPeer) as BufferSource },
                    this.liveKey,
                    payload.subarray(IV_BYTES) as BufferSource,
                ),
            );
        } catch {
            return undefined;
        }
        return this.acceptFrameNonce(senderPeer, payload.subarray(0, IV_BYTES)) ? frame : undefined;
    }

    /**
     * Whether a frame of `senderPeer` that opened under `nonce` is new, recording it when it is. Only frames that opened get here, so a
     * forged nonce can't move anything. The salt is pinned to the first one seen, since a peer id is one session. A counter above the
     * highest so far is accepted; one within `FRAME_REPLAY_WINDOW` below it, once; anything older, or seen before, is a replay.
     */
    private acceptFrameNonce(senderPeer: string, nonce: Uint8Array): boolean {
        const salt = Array.from(nonce.subarray(0, SALT_BYTES), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const counter = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getBigUint64(SALT_BYTES);
        const state = this.framesAccepted.get(senderPeer);
        if (!state) {
            this.framesAccepted.set(senderPeer, { salt, highest: counter, seen: 1n });
            return true;
        }
        if (state.salt !== salt) {
            return false;
        }
        if (counter > state.highest) {
            const shift = counter - state.highest;
            state.seen = shift >= FRAME_REPLAY_WINDOW ? 1n : ((state.seen << shift) | 1n) & ((1n << FRAME_REPLAY_WINDOW) - 1n);
            state.highest = counter;
            return true;
        }
        const offset = state.highest - counter;
        if (offset >= FRAME_REPLAY_WINDOW || (state.seen & (1n << offset)) !== 0n) {
            return false;
        }
        state.seen |= 1n << offset;
        return true;
    }

    /** `"rapidmx-frame-v2|" || kind u8 || keyFrame u8 || seq u16 || timestampMs u32 || UTF-8 sender peer id` (big-endian), the header
     * fields reduced to their wire widths so both ends bind the same values. */
    private frameAad(header: FrameHeader, peer: string): Uint8Array {
        const fields = new Uint8Array(FRAME_AAD_HEADER_BYTES);
        const view = new DataView(fields.buffer);
        view.setUint8(0, header.kind & 0xff);
        view.setUint8(1, header.keyFrame ? 1 : 0);
        view.setUint16(2, header.seq & 0xffff);
        view.setUint32(4, header.timestampMs >>> 0);
        return concat(FRAME_AAD_TAG, fields, new TextEncoder().encode(peer));
    }
}
