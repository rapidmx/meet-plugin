// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { deriveLiveKey } from "@rapidmx/web-client/lib/crypto/meetingKeys.js";

const randomSecret = () => crypto.getRandomValues(new Uint8Array(32));
import { MeetingCipher } from "../../../../apps/shared/crypto/MeetingCipher.js";
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
});
