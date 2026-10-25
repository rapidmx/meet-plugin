///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The end-to-end encryption of a protected meeting's live traffic (`specs/meeting_privacy.md` §5), with its live key (`deriveLiveKey()`
 * in web-client's `lib/crypto/meetingKeys.ts`):
 *
 * - **Signaling** (version 2): every `SignalMessage` - offers, answers, ICE candidates, presence and names, moderation, chat, whiteboard,
 * cursors, reactions - travels as `{ to?, e }`, `e` being AES-256-GCM of `{ from, peer, n, data }` bound to the meeting. The server
 * still stamps `from`/`peer` and routes by `to`; a receiver drops a message it can't open, one whose sealed sender differs from the
 * stamped one, one replayed (`n` not above the last it accepted from that peer), and anything sent in the clear.
 * - **Relay frames**: each encoded audio packet or video picture is sealed before it is fragmented, bound to its kind and sender.
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
}

const IV_BYTES = 12;
const SALT_BYTES = 4;

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

    /**
     * @param liveKey The meeting's live AES-GCM key.
     * @param meetingUid The meeting both directions are bound to.
     * @param self Who this tab is: what it seals as its sender.
     */
    constructor(
        private readonly liveKey: CryptoKey,
        meetingUid: string,
        private readonly self: { uid: string; peer: string },
    ) {
        this.signalAad = new TextEncoder().encode(`rapidmx-signal-v2|${meetingUid}`);
    }

    public async seal(message: SignalMessage): Promise<Record<string, unknown>> {
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const plain = new TextEncoder().encode(JSON.stringify({ from: this.self.uid, peer: this.self.peer, n: ++this.sent, data: message }));
        const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.signalAad as BufferSource }, this.liveKey, plain));
        const e = toBase64Url(concat(iv, sealed));
        return message.to !== undefined ? { to: message.to, e } : { e };
    }

    public async open(data: Record<string, unknown>): Promise<SignalMessage | undefined> {
        if (typeof data.e !== "string") {
            return undefined;
        }
        let inner: { from?: unknown; peer?: unknown; n?: unknown; data?: unknown };
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
        this.accepted.set(peer, inner.n);
        // The server's stamps, which the sealed sender has just been checked against.
        return { ...(inner.data as SignalMessage), from: data.from as string, peer: data.peer as string | undefined };
    }

    /** `frame` (one encoded packet or picture of `kind`) sealed to send through the relay: nonce, then ciphertext. */
    public async encryptFrame(kind: number, frame: Uint8Array): Promise<Uint8Array> {
        const nonce = new Uint8Array(IV_BYTES);
        this.frameSalt ??= crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        nonce.set(this.frameSalt, 0);
        new DataView(nonce.buffer).setBigUint64(SALT_BYTES, ++this.frameCounter);
        const sealed = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce, additionalData: this.frameAad(kind, this.self.peer) as BufferSource },
            this.liveKey,
            frame as BufferSource,
        );
        return concat(nonce, new Uint8Array(sealed));
    }

    /** A relayed frame of `kind` from `senderPeer`, opened - `undefined` when it doesn't open (another key, tampered, or not sealed). */
    public async decryptFrame(kind: number, senderPeer: string, payload: Uint8Array): Promise<Uint8Array | undefined> {
        if (payload.length <= IV_BYTES) {
            return undefined;
        }
        try {
            return new Uint8Array(
                await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: payload.subarray(0, IV_BYTES) as BufferSource, additionalData: this.frameAad(kind, senderPeer) as BufferSource },
                    this.liveKey,
                    payload.subarray(IV_BYTES) as BufferSource,
                ),
            );
        } catch {
            return undefined;
        }
    }

    private frameAad(kind: number, peer: string): Uint8Array {
        return concat(Uint8Array.of(kind), new TextEncoder().encode(peer));
    }
}
