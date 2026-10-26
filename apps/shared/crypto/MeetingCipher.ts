///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The end-to-end encryption of a protected meeting's live traffic (`specs/meeting_privacy.md` §5), with its live key (`deriveLiveKey()`
 * in web-client's `lib/crypto/meetingKeys.ts`):
 *
 * - **Signaling** (version 2): every `SignalMessage` - offers, answers, ICE candidates, presence and names, moderation, chat, whiteboard,
 * cursors, reactions - travels as `{ to?, e }`, `e` being AES-256-GCM of `{ from, peer, n, t, f, data }` bound to the meeting. The server
 * still stamps `from`/`peer` and routes by `to`; a receiver drops a message it can't open, one whose sealed sender differs from the
 * stamped one, one replayed (`n` not above the last it accepted from that peer), one sealed more than `MAX_SIGNAL_AGE_MS` from now
 * (`t`, so what the server kept from an earlier session or occurrence can't be passed off as live), and anything sent in the clear.
 * - **Relay frames** (version 2): each encoded audio packet or video picture is sealed before it is fragmented, bound to its sender
 * and to every header field a receiver acts on (kind, key-frame flag, seq, timestamp - `FrameHeader`), so a relay or peer rewriting
 * one makes the frame fail to open. Its nonce is a 64-bit random salt per sending session and a 32-bit counter (`encryptFrame()`), so
 * the many sessions that share the one long-lived live key don't collide. A receiver drops a frame whose nonce it already accepted
 * from that sender, or one too far behind the newest (`FRAME_REPLAY_WINDOW`). Frames carry no time a receiver can check, so every
 * sealed signal announces its sender's frame salt and counter (`f`), fresh because the signal is: a receiver plays a sender's frames
 * only under the salt it announced and from just below the counter it announced (`acceptFrameAnnouncement()`), so what the server kept
 * of a sender's earlier frames can't be passed off as live to someone who joins later.
 *
 * - **Waiting-room names**: the name a guest gives to wait for the host (`sealWaitingName()`), which the server keeps and lists to
 * the host only sealed (`specs/meeting_privacy.md` §6.1).
 *
 * Authenticating the signaling is also what makes direct peer-to-peer media end to end: the server can no longer swap the DTLS
 * fingerprints in the SDP it relays.
 */
import { fromBase64, fromBase64Url, toBase64, toBase64Url } from "@rapidmx/web-client/lib/crypto/encoding.js";
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
/** A frame nonce's random per-session part. Every participant of every session over the key's whole life (up to years of a recurring
 * series) seals under the one live key, so this is wide enough that no two sessions plausibly draw the same salt: with 4 bytes, a
 * collision - and with it GCM nonce reuse, which leaks the authentication key - was likely within about 100k relay sessions. */
const SALT_BYTES = 8;
/** An announced frame salt (`f.s` of a sealed signal): `SALT_BYTES` as lower-case hex. */
const FRAME_SALT_HEX = new RegExp(`^[0-9a-f]{${SALT_BYTES * 2}}$`);
/** The most frames one session seals: the counter is the nonce's last 4 bytes. */
export const MAX_FRAME_COUNTER = 0xffffffff;
/** What a frame's AAD starts with; the version changes whenever what it binds does. */
const FRAME_AAD_TAG = new TextEncoder().encode("rapidmx-frame-v2|");
/** kind u8, key-frame u8, seq u16, timestamp u32 - see `frameAad()`. */
const FRAME_AAD_HEADER_BYTES = 8;

/** What a sealed waiting-room name's AAD starts with, before the meeting uid. */
const WAITING_NAME_AAD_TAG = "rapidmx-waiting-name-v1|";

/** How far from this tab's clock a signal's sealing time (`t`) may be: room for a message held while the socket reconnects, and for
 * the difference between two participants' clocks. */
export const MAX_SIGNAL_AGE_MS = 5 * 60 * 1000;

/** How many frame counters below the highest one accepted from a sender are still accepted, once each: audio and video share the
 * counter, so their frames don't always complete in the order they were sealed. */
export const FRAME_REPLAY_WINDOW = 128n;

/** What a sealed message's envelope adds around `e`: `{"op":"signal","data":{"to":"<peer id>","e":""}}`, with room for a long peer id. */
const SIGNAL_ENVELOPE_OVERHEAD_BYTES = 512;
/** What the sealed plaintext adds around the message: `{"from":..,"peer":..,"n":..,"t":..,"f":{"s":..,"c":..},"data":}`, with room for
 * long ids. */
const SIGNAL_INNER_OVERHEAD_BYTES = 576;

/** The frames accepted from one sender: its session's salt (the one its signals announced), the highest counter (accepted, or
 * announced), and which of the `FRAME_REPLAY_WINDOW` counters below it were seen (bit `i` is `highest - i`). */
interface FrameReplayState {
    salt: string;
    highest: bigint;
    seen: bigint;
}

/** `bytes` as lower-case hex: how a frame salt is announced and kept. */
function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Moves `state`'s window up to `counter`, a counter above its highest, marking `counter` seen when a frame under it was accepted. */
function advanceFrameWindow(state: FrameReplayState, counter: bigint, seen: boolean): void {
    const shift = counter - state.highest;
    const kept = shift >= FRAME_REPLAY_WINDOW ? 0n : (state.seen << shift) & ((1n << FRAME_REPLAY_WINDOW) - 1n);
    state.seen = seen ? kept | 1n : kept;
    state.highest = counter;
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

/** `name`, the name a guest gives to wait in protected meeting `meetingUid`'s waiting room, sealed with its live key (AES-256-GCM
 * under a random IV, bound to the meeting): base64 of `iv || ciphertext`, what `POST /join/:token/verify` takes as `sealedName`. */
export async function sealWaitingName(liveKey: CryptoKey, meetingUid: string, name: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const additionalData = new TextEncoder().encode(WAITING_NAME_AAD_TAG + meetingUid);
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData as BufferSource }, liveKey, new TextEncoder().encode(name));
    return toBase64(concat(iv, new Uint8Array(sealed)));
}

/** A name `sealWaitingName()` sealed for `meetingUid`, opened - `undefined` when it doesn't open (another key or meeting, or
 * tampered). Never rejects. */
export async function openWaitingName(liveKey: CryptoKey, meetingUid: string, sealedName: string): Promise<string | undefined> {
    try {
        const bytes = fromBase64(sealedName);
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) as BufferSource, additionalData: new TextEncoder().encode(WAITING_NAME_AAD_TAG + meetingUid) as BufferSource },
            liveKey,
            bytes.subarray(IV_BYTES) as BufferSource,
        );
        return new TextDecoder().decode(plain);
    } catch {
        return undefined;
    }
}

export class MeetingCipher implements SignalCipher {
    private sent = 0;
    /** The highest `n` accepted per peer. */
    private readonly accepted = new Map<string, number>();
    private readonly signalAad: Uint8Array;
    /** This sender's frame nonces: a random salt for this session (drawn up front, since every signal announces it), then a counter. */
    private readonly frameSalt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    private frameCounter = 0;
    /** The frames accepted per sender peer, from its first fresh signal on - see `acceptFrameAnnouncement()`, `acceptFrameNonce()`. */
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
        // `f`: this session's frame salt and the last counter it sealed, so a receiver knows which of its frames can still be live.
        const f = { s: toHex(this.frameSalt), c: this.frameCounter };
        const plain = new TextEncoder().encode(JSON.stringify({ from: this.self.uid, peer: this.self.peer, n: ++this.sent, t: this.now(), f, data: message }));
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.signalAad as BufferSource }, this.liveKey, plain));
        const e = toBase64Url(concat(iv, sealed));
        return message.to !== undefined ? { to: message.to, e } : { e };
    }

    public async open(data: Record<string, unknown>): Promise<SignalMessage | undefined> {
        if (typeof data.e !== "string") {
            return undefined;
        }
        let inner: { from?: unknown; peer?: unknown; n?: unknown; t?: unknown; f?: unknown; data?: unknown };
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
        this.acceptFrameAnnouncement(peer, inner.f);
        // The server's stamps, which the sealed sender has just been checked against.
        return { ...(inner.data as SignalMessage), from: data.from as string, peer: data.peer as string | undefined };
    }

    public plaintextBudget(maxEnvelopeBytes: number): number {
        // base64url turns every 3 bytes into 4.
        const sealedBytes = Math.floor(((maxEnvelopeBytes - SIGNAL_ENVELOPE_OVERHEAD_BYTES) * 3) / 4);
        return sealedBytes - IV_BYTES - TAG_BYTES - SIGNAL_INNER_OVERHEAD_BYTES;
    }

    /** `frame` (one encoded packet or picture) sealed to send through the relay under `header`: nonce (`salt[8] || counter u32`), then
     * ciphertext. Throws, sealing nothing, once the session has sealed `MAX_FRAME_COUNTER` frames, rather than reuse a nonce. */
    public async encryptFrame(header: FrameHeader, frame: Uint8Array): Promise<Uint8Array> {
        if (this.frameCounter >= MAX_FRAME_COUNTER) {
            throw new Error("This session has sealed as many relay frames as its nonces allow.");
        }
        const nonce = new Uint8Array(IV_BYTES);
        nonce.set(this.frameSalt, 0);
        new DataView(nonce.buffer).setUint32(SALT_BYTES, ++this.frameCounter);
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
     * Records the frame salt and counter (`f`) that a signal of `senderPeer` announced - only one that opened, from that peer, sealed
     * within `MAX_SIGNAL_AGE_MS` of this tab's clock, gets here. The first announcement pins the salt (a peer id is one session) and
     * makes the announced counter the highest, none of the `FRAME_REPLAY_WINDOW` below it seen yet: frames sealed just before the signal,
     * still on their way, play, and anything older doesn't. A later one moves the window up when the sender's frames have stopped
     * reaching this tab, so what the server held back meanwhile can't be played late. Anything malformed, or another salt, is ignored.
     */
    private acceptFrameAnnouncement(senderPeer: string, announced: unknown): void {
        const { s, c } = (announced ?? {}) as { s?: unknown; c?: unknown };
        if (typeof s !== "string" || !FRAME_SALT_HEX.test(s) || typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > MAX_FRAME_COUNTER) {
            return;
        }
        const counter = BigInt(c);
        const state = this.framesAccepted.get(senderPeer);
        if (!state) {
            this.framesAccepted.set(senderPeer, { salt: s, highest: counter, seen: 0n });
        } else if (state.salt === s && counter > state.highest) {
            advanceFrameWindow(state, counter, false);
        }
    }

    /**
     * Whether a frame of `senderPeer` that opened under `nonce` is new, recording it when it is. Only frames that opened get here, so a
     * forged nonce can't move anything. A frame of a sender none of whose fresh signals has arrived yet, or under a salt other than the
     * one it announced, is dropped (`acceptFrameAnnouncement()`). A counter above the highest so far is accepted; one within
     * `FRAME_REPLAY_WINDOW` below it, once; anything older, or seen before, is a replay.
     */
    private acceptFrameNonce(senderPeer: string, nonce: Uint8Array): boolean {
        const salt = toHex(nonce.subarray(0, SALT_BYTES));
        const counter = BigInt(new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getUint32(SALT_BYTES));
        const state = this.framesAccepted.get(senderPeer);
        if (!state || state.salt !== salt) {
            return false;
        }
        if (counter > state.highest) {
            advanceFrameWindow(state, counter, true);
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
