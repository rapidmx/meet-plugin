// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { deriveLiveKey } from "@rapidmx/web-client/lib/crypto/meetingKeys.js";

const randomSecret = () => crypto.getRandomValues(new Uint8Array(32));
import {
    FRAME_REPLAY_WINDOW,
    type FrameHeader,
    MAX_FRAME_COUNTER,
    MAX_SIGNAL_AGE_MS,
    MeetingCipher,
    openWaitingName,
    sealWaitingName,
} from "../../../../apps/shared/crypto/MeetingCipher.js";
import type { SignalMessage } from "../../../../apps/shared/webrtc/types.js";

const MEETING = "meeting-1";
const ALICE = { uid: "alice", peer: "alice~1" };
const BOB = { uid: "guest:bob", peer: "guest:bob~1" };

async function pair(meeting = MEETING) {
    const secret = randomSecret();
    return {
        alice: new MeetingCipher(await deriveLiveKey(secret, meeting), meeting, ALICE),
        bob: new MeetingCipher(await deriveLiveKey(secret, meeting), meeting, BOB),
        secret,
    };
}

/** A frame header of `kind` (1 audio, 2 video). */
const hdr = (kind: number, fields: Partial<FrameHeader> = {}): FrameHeader => ({ kind, keyFrame: kind === 1, seq: 7, timestampMs: 1234, ...fields });

const chat = (to?: string): SignalMessage => ({ type: "video-meeting-signal", kind: "chat", from: ALICE.uid, peer: ALICE.peer, chat: { text: "secret plans" }, ...(to ? { to } : {}) });
/** What the server delivers: the sent data with its own stamps. */
const stamped = (data: Record<string, unknown>, sender = ALICE) => ({ ...data, from: sender.uid, peer: sender.peer });
/** `receiver` taking a fresh signal of `sender`'s (`as`): what announces the frame salt and counter its frames are then checked against. */
const announce = async (sender: MeetingCipher, receiver: MeetingCipher, as = ALICE) => expect(await receiver.open(stamped(await sender.seal(chat()), as))).toBeDefined();
/** A signal of ALICE's sealed by hand, with `inner` as its plaintext's extra fields. */
async function sealInner(key: CryptoKey, inner: Record<string, unknown>) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ from: ALICE.uid, peer: ALICE.peer, data: chat(), ...inner }));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`rapidmx-signal-v2|${MEETING}`) }, key, plain));
    return stamped({ e: Buffer.from([...iv, ...sealed]).toString("base64url") });
}

describe("MeetingCipher", () => {
    it("seals a signal to an opaque envelope - only `to` readable - that the other participant opens with the server's stamps", async () => {
        const { alice, bob } = await pair();
        const sealed = await alice.seal(chat(BOB.peer));
        expect(Object.keys(sealed).sort()).toEqual(["e", "to"]);
        expect(sealed.to).toBe(BOB.peer);
        expect(JSON.stringify(sealed)).not.toContain("secret plans");
        expect(await bob.open(stamped(sealed))).toMatchObject({ kind: "chat", chat: { text: "secret plans" }, from: ALICE.uid, peer: ALICE.peer, to: BOB.peer });
        expect(Object.keys(await alice.seal(chat()))).toEqual(["e"]);
    });

    it("drops a signal sent in the clear, one it can't open, a forged sender, a replay, and one sealed for another meeting", async () => {
        const { alice, bob } = await pair();
        expect(await bob.open(stamped({ kind: "chat", chat: { text: "plain" } }))).toBeUndefined();
        expect(await bob.open(stamped({ e: "AAAA" }))).toBeUndefined();

        const first = await alice.seal(chat());
        // The server stamping someone else as the sender: the sealed sender doesn't match.
        expect(await bob.open(stamped(first, { uid: "mallory", peer: "mallory~1" }))).toBeUndefined();
        expect(await bob.open(stamped(first))).toBeDefined();
        expect(await bob.open(stamped(first))).toBeUndefined();

        const tampered = await alice.seal(chat());
        const bytes = Buffer.from(tampered.e as string, "base64url");
        bytes[bytes.length - 1] ^= 1;
        expect(await bob.open(stamped({ e: bytes.toString("base64url") }))).toBeUndefined();

        const elsewhere = new MeetingCipher(await deriveLiveKey(randomSecret(), MEETING), MEETING, ALICE);
        expect(await bob.open(stamped(await elsewhere.seal(chat())))).toBeUndefined();
        const otherMeeting = await pair("meeting-2");
        expect(await otherMeeting.bob.open(stamped(await alice.seal(chat())))).toBeUndefined();
    });

    it("seals relay frames bound to their sender and every header field, each with a fresh nonce", async () => {
        const { alice, bob } = await pair();
        await announce(alice, bob);
        const frame = new TextEncoder().encode("encoded video picture");
        const one = await alice.encryptFrame(hdr(2), frame);
        const two = await alice.encryptFrame(hdr(2), frame);
        expect(Buffer.from(one.subarray(0, 12)).equals(Buffer.from(two.subarray(0, 12)))).toBe(false);
        expect(new TextDecoder().decode(await bob.decryptFrame(hdr(2), ALICE.peer, one))).toBe("encoded video picture");
        expect(await bob.decryptFrame(hdr(1), ALICE.peer, one)).toBeUndefined();
        expect(await bob.decryptFrame(hdr(2), "mallory~1", one)).toBeUndefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, frame)).toBeUndefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, new Uint8Array(12))).toBeUndefined();
    });

    it("drops a relay frame whose seq, timestamp, key-frame flag or kind was rewritten, and binds them at their wire widths", async () => {
        const { alice, bob } = await pair();
        await announce(alice, bob);
        const frame = new TextEncoder().encode("delta picture");
        const header = hdr(2, { keyFrame: false, seq: 40, timestampMs: 5000 });
        const sealed = await alice.encryptFrame(header, frame);
        for (const rewritten of [{ seq: 41 }, { timestampMs: 5001 }, { keyFrame: true }, { kind: 1 }]) {
            expect(await bob.decryptFrame({ ...header, ...rewritten }, ALICE.peer, sealed)).toBeUndefined();
        }
        // A failed open records nothing, so the untouched frame still opens.
        expect(new TextDecoder().decode(await bob.decryptFrame(header, ALICE.peer, sealed))).toBe("delta picture");

        // The receiver reads the fields off the wire reduced modulo their widths.
        const wide = await alice.encryptFrame(hdr(2, { seq: 0x10000 + 3, timestampMs: 2 ** 32 + 9 }), frame);
        expect(await bob.decryptFrame(hdr(2, { seq: 3, timestampMs: 9 }), ALICE.peer, wide)).toBeDefined();
    });

    it("drops a signal sealed too long ago or too far ahead - what the server kept from an earlier session can't pass as live", async () => {
        const secret = randomSecret();
        let aliceNow = 1_000_000_000_000;
        const alice = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, ALICE, () => aliceNow);
        // A participant who joins later and has never heard from this peer id.
        const late = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, BOB, () => 1_000_000_000_000 + MAX_SIGNAL_AGE_MS + 1);
        const kept = await alice.seal(chat());
        expect(await late.open(stamped(kept))).toBeUndefined();

        aliceNow += 2 * MAX_SIGNAL_AGE_MS + 2;
        expect(await late.open(stamped(await alice.seal(chat())))).toBeUndefined();
        aliceNow -= MAX_SIGNAL_AGE_MS + 1;
        expect(await late.open(stamped(await alice.seal(chat())))).toBeDefined();
    });

    it("drops a signal whose sealed time isn't a number", async () => {
        const secret = randomSecret();
        const key = await deriveLiveKey(secret, MEETING);
        const bob = new MeetingCipher(key, MEETING, BOB);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plain = new TextEncoder().encode(JSON.stringify({ from: ALICE.uid, peer: ALICE.peer, n: 1, t: "now", data: chat() }));
        const sealed = new Uint8Array(
            await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`rapidmx-signal-v2|${MEETING}`) }, key, plain),
        );
        expect(await bob.open(stamped({ e: Buffer.from([...iv, ...sealed]).toString("base64url") }))).toBeUndefined();
    });

    it("budgets a message's plaintext so its sealed envelope stays within the server's limit", async () => {
        const { alice } = await pair();
        for (const limit of [16 * 1024, 64 * 1024]) {
            const budget = alice.plaintextBudget(limit);
            const text = "x".repeat(budget - JSON.stringify(chat("guest:bob~" + "9".repeat(60))).length);
            const message = { ...chat("guest:bob~" + "9".repeat(60)), chat: { text } };
            expect(JSON.stringify(message).length).toBeLessThanOrEqual(budget);
            const wire = JSON.stringify({ op: "signal", data: await alice.seal(message) });
            expect(wire.length).toBeLessThanOrEqual(limit);
            expect(wire.length).toBeGreaterThan(limit * 0.9);
        }
    });

    it("nonces a session's frames with one 8-byte random salt and a 4-byte counter from 1, a fresh salt per session", async () => {
        const { alice, secret } = await pair();
        const frame = new TextEncoder().encode("picture");
        const first = await alice.encryptFrame(hdr(2), frame);
        const second = await alice.encryptFrame(hdr(1), frame);
        const view = (sealed: Uint8Array) => new DataView(sealed.buffer, sealed.byteOffset, 12);
        expect(Buffer.from(first.subarray(0, 8))).toEqual(Buffer.from(second.subarray(0, 8)));
        expect(view(first).getUint32(8)).toBe(1);
        expect(view(second).getUint32(8)).toBe(2);

        // Another session under the same key - another participant, or the same one's next tab - draws its own salt.
        const again = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, ALICE);
        const other = await again.encryptFrame(hdr(2), frame);
        expect(view(other).getUint32(8)).toBe(1);
        expect(Buffer.from(other.subarray(0, 8))).not.toEqual(Buffer.from(first.subarray(0, 8)));
    });

    it("refuses to seal past the counter's last value rather than reuse a nonce, and still opens the last one sealed", async () => {
        const { alice, bob } = await pair();
        await announce(alice, bob);
        const frame = new TextEncoder().encode("picture");
        (alice as any).frameCounter = MAX_FRAME_COUNTER - 1;
        const last = await alice.encryptFrame(hdr(2), frame);
        expect(new DataView(last.buffer, last.byteOffset, 12).getUint32(8)).toBe(MAX_FRAME_COUNTER);
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, last)).toEqual(frame);
        await expect(alice.encryptFrame(hdr(2), frame)).rejects.toThrow(/as many relay frames/);
        await expect(alice.encryptFrame(hdr(2), frame)).rejects.toThrow(/as many relay frames/);
    });

    it("seals a waiting-room name with the live key, bound to its meeting, opening only with that key and meeting", async () => {
        const secret = randomSecret();
        const key = await deriveLiveKey(secret, MEETING);
        const sealed = await sealWaitingName(key, MEETING, "Grace Hopper");
        expect(sealed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        expect(Buffer.from(sealed, "base64").toString("latin1")).not.toContain("Grace");
        expect(await openWaitingName(key, MEETING, sealed)).toBe("Grace Hopper");
        // Another meeting, another key, or tampered bytes don't open.
        expect(await openWaitingName(key, "meeting-2", sealed)).toBeUndefined();
        expect(await openWaitingName(await deriveLiveKey(randomSecret(), MEETING), MEETING, sealed)).toBeUndefined();
        const bytes = Buffer.from(sealed, "base64");
        bytes[bytes.length - 1] ^= 1;
        expect(await openWaitingName(key, MEETING, bytes.toString("base64"))).toBeUndefined();
        // A fresh IV each time.
        expect(await sealWaitingName(key, MEETING, "Grace Hopper")).not.toBe(sealed);
    });

    it("drops a replayed relay frame, one too far behind its sender's newest, and one under another salt for the same peer", async () => {
        const { alice, bob, secret } = await pair();
        await announce(alice, bob);
        const frame = new TextEncoder().encode("picture");
        const first = await alice.encryptFrame(hdr(2), frame);
        const second = await alice.encryptFrame(hdr(1), frame);
        // Out of order within the window is fine, once.
        expect(await bob.decryptFrame(hdr(1), ALICE.peer, second)).toBeDefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, first)).toBeDefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, first)).toBeUndefined();
        expect(await bob.decryptFrame(hdr(1), ALICE.peer, second)).toBeUndefined();

        const old = await alice.encryptFrame(hdr(2), frame);
        for (let i = 0n; i < FRAME_REPLAY_WINDOW; i++) {
            expect(await bob.decryptFrame(hdr(2), ALICE.peer, await alice.encryptFrame(hdr(2), frame))).toBeDefined();
        }
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, old)).toBeUndefined();
        // A jump past the whole window starts it afresh.
        for (let i = 0n; i < FRAME_REPLAY_WINDOW; i++) {
            await alice.encryptFrame(hdr(2), frame);
        }
        const recent = await alice.encryptFrame(hdr(2), frame);
        const latest = await alice.encryptFrame(hdr(2), frame);
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, latest)).toBeDefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, recent)).toBeDefined();

        // A second session under the same peer id (another salt) is refused; another peer's frames are tracked apart.
        const replayer = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, ALICE);
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, await replayer.encryptFrame(hdr(2), frame))).toBeUndefined();
        const CAROL = { uid: "carol", peer: "carol~1" };
        const carol = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, CAROL);
        await announce(carol, bob, CAROL);
        expect(await bob.decryptFrame(hdr(2), "carol~1", await carol.encryptFrame(hdr(2), frame))).toBeDefined();
    });

    it("plays a sender's frames only once a fresh signal announced its salt and counter, so frames the server kept can't pass as live to a later joiner", async () => {
        const secret = randomSecret();
        let now = 1_000_000_000_000;
        const alice = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, ALICE, () => now);
        const frame = new TextEncoder().encode("what alice said an hour ago");
        // What the relay kept of alice's frames: a window's worth an announcement of her counter no longer covers, then one still covered.
        const kept: Uint8Array[] = [];
        for (let i = 0n; i < 2n * FRAME_REPLAY_WINDOW; i++) {
            kept.push(await alice.encryptFrame(hdr(2), frame));
        }
        // Someone joining later, having heard nothing from alice yet, plays none of her frames.
        const late = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, BOB, () => now);
        expect(await late.decryptFrame(hdr(2), ALICE.peer, kept[0])).toBeUndefined();
        // A signal too old to be live announces nothing either.
        const stale = await alice.seal(chat());
        now += MAX_SIGNAL_AGE_MS + 1;
        expect(await late.open(stamped(stale))).toBeUndefined();
        expect(await late.decryptFrame(hdr(2), ALICE.peer, kept[kept.length - 1])).toBeUndefined();

        // Alice's fresh hello announces the counter she has reached: what she sealed before the window below it stays dead.
        await announce(alice, late);
        for (const old of kept.slice(0, Number(FRAME_REPLAY_WINDOW))) {
            expect(await late.decryptFrame(hdr(2), ALICE.peer, old)).toBeUndefined();
        }
        // The frames sealed just before her hello, still on their way, play once; what she seals from now on plays.
        expect(await late.decryptFrame(hdr(2), ALICE.peer, kept[kept.length - 1])).toBeDefined();
        expect(await late.decryptFrame(hdr(2), ALICE.peer, kept[Number(FRAME_REPLAY_WINDOW)])).toBeDefined();
        expect(await late.decryptFrame(hdr(2), ALICE.peer, kept[kept.length - 1])).toBeUndefined();
        expect(await late.decryptFrame(hdr(2), ALICE.peer, await alice.encryptFrame(hdr(2), frame))).toBeDefined();

        // Another session of the same peer id - a salt she didn't announce - is refused, and its signal doesn't re-pin the salt.
        const other = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, ALICE, () => now);
        const otherFrame = await other.encryptFrame(hdr(2), frame);
        const otherSalt = Buffer.from(otherFrame.subarray(0, 8)).toString("hex");
        expect(await late.open(await sealInner(await deriveLiveKey(secret, MEETING), { n: 100, t: now, f: { s: otherSalt, c: 1 } }))).toBeDefined();
        expect(await late.decryptFrame(hdr(2), ALICE.peer, otherFrame)).toBeUndefined();
        expect(await late.decryptFrame(hdr(2), ALICE.peer, await alice.encryptFrame(hdr(2), frame))).toBeDefined();
    });

    it("moves a sender's window up to a later announcement, so frames the server held back while none reached this tab don't play late", async () => {
        const { alice, bob } = await pair();
        const frame = new TextEncoder().encode("picture");
        await announce(alice, bob);
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, await alice.encryptFrame(hdr(2), frame))).toBeDefined();
        const held: Uint8Array[] = [];
        for (let i = 0n; i < 2n * FRAME_REPLAY_WINDOW; i++) {
            held.push(await alice.encryptFrame(hdr(2), frame));
        }
        await announce(alice, bob);
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, held[0])).toBeUndefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, held[held.length - 1])).toBeDefined();

        // An announcement behind what already played changes nothing.
        const behind = await alice.seal(chat());
        const played = await alice.encryptFrame(hdr(2), frame);
        const next = await alice.encryptFrame(hdr(2), frame);
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, next)).toBeDefined();
        expect(await bob.open(stamped(behind))).toBeDefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, played)).toBeDefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, next)).toBeUndefined();
    });

    it("announces nothing from a signal without a well-formed frame salt and counter, though the signal itself is delivered", async () => {
        const key = await deriveLiveKey(randomSecret(), MEETING);
        const alice = new MeetingCipher(key, MEETING, ALICE);
        const sealedFrame = await alice.encryptFrame(hdr(2), new TextEncoder().encode("picture"));
        const salt = Buffer.from(sealedFrame.subarray(0, 8)).toString("hex");
        let n = 0;
        const bob = new MeetingCipher(key, MEETING, BOB);
        const malformed = [undefined, null, "f", { c: 0 }, { s: "z".repeat(16), c: 0 }, { s: salt + "00", c: 0 }, { s: salt, c: "0" }, { s: salt, c: 0.5 }, { s: salt, c: -1 }, { s: salt, c: MAX_FRAME_COUNTER + 1 }];
        for (const f of malformed) {
            expect(await bob.open(await sealInner(key, { n: ++n, t: Date.now(), f }))).toBeDefined();
            expect(await bob.decryptFrame(hdr(2), ALICE.peer, sealedFrame)).toBeUndefined();
        }
        expect(await bob.open(await sealInner(key, { n: ++n, t: Date.now(), f: { s: salt, c: 0 } }))).toBeDefined();
        expect(await bob.decryptFrame(hdr(2), ALICE.peer, sealedFrame)).toBeDefined();
    });
});
