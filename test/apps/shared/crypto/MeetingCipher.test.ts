// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { deriveLiveKey } from "@rapidmx/web-client/lib/crypto/meetingKeys.js";

const randomSecret = () => crypto.getRandomValues(new Uint8Array(32));
import { FRAME_REPLAY_WINDOW, MAX_SIGNAL_AGE_MS, MeetingCipher } from "../../../../apps/shared/crypto/MeetingCipher.js";
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

const chat = (to?: string): SignalMessage => ({ type: "video-meeting-signal", kind: "chat", from: ALICE.uid, peer: ALICE.peer, chat: { text: "secret plans" }, ...(to ? { to } : {}) });
/** What the server delivers: the sent data with its own stamps. */
const stamped = (data: Record<string, unknown>, sender = ALICE) => ({ ...data, from: sender.uid, peer: sender.peer });

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

    it("seals relay frames bound to their kind and sender, each with a fresh nonce", async () => {
        const { alice, bob } = await pair();
        const frame = new TextEncoder().encode("encoded video picture");
        const one = await alice.encryptFrame(2, frame);
        const two = await alice.encryptFrame(2, frame);
        expect(Buffer.from(one.subarray(0, 12)).equals(Buffer.from(two.subarray(0, 12)))).toBe(false);
        expect(new TextDecoder().decode(await bob.decryptFrame(2, ALICE.peer, one))).toBe("encoded video picture");
        expect(await bob.decryptFrame(1, ALICE.peer, one)).toBeUndefined();
        expect(await bob.decryptFrame(2, "mallory~1", one)).toBeUndefined();
        expect(await bob.decryptFrame(2, ALICE.peer, frame)).toBeUndefined();
        expect(await bob.decryptFrame(2, ALICE.peer, new Uint8Array(12))).toBeUndefined();
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

    it("drops a replayed relay frame, one too far behind its sender's newest, and one under another salt for the same peer", async () => {
        const { alice, bob, secret } = await pair();
        const frame = new TextEncoder().encode("picture");
        const first = await alice.encryptFrame(2, frame);
        const second = await alice.encryptFrame(1, frame);
        // Out of order within the window is fine, once.
        expect(await bob.decryptFrame(1, ALICE.peer, second)).toBeDefined();
        expect(await bob.decryptFrame(2, ALICE.peer, first)).toBeDefined();
        expect(await bob.decryptFrame(2, ALICE.peer, first)).toBeUndefined();
        expect(await bob.decryptFrame(1, ALICE.peer, second)).toBeUndefined();

        const old = await alice.encryptFrame(2, frame);
        for (let i = 0n; i < FRAME_REPLAY_WINDOW; i++) {
            expect(await bob.decryptFrame(2, ALICE.peer, await alice.encryptFrame(2, frame))).toBeDefined();
        }
        expect(await bob.decryptFrame(2, ALICE.peer, old)).toBeUndefined();
        // A jump past the whole window starts it afresh.
        for (let i = 0n; i < FRAME_REPLAY_WINDOW; i++) {
            await alice.encryptFrame(2, frame);
        }
        const recent = await alice.encryptFrame(2, frame);
        const latest = await alice.encryptFrame(2, frame);
        expect(await bob.decryptFrame(2, ALICE.peer, latest)).toBeDefined();
        expect(await bob.decryptFrame(2, ALICE.peer, recent)).toBeDefined();

        // A second session under the same peer id (another salt) is refused; another peer's frames are tracked apart.
        const replayer = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, ALICE);
        expect(await bob.decryptFrame(2, ALICE.peer, await replayer.encryptFrame(2, frame))).toBeUndefined();
        const carol = new MeetingCipher(await deriveLiveKey(secret, MEETING), MEETING, { uid: "carol", peer: "carol~1" });
        expect(await bob.decryptFrame(2, "carol~1", await carol.encryptFrame(2, frame))).toBeDefined();
    });
});
