// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { toBase64 } from "@rapidmx/web-client/lib/crypto/encoding.js";
import { generateMeetingKey, meetingKeyFragment } from "@rapidmx/web-client/lib/crypto/meetingKeys.js";
import { encryptForRecipients } from "@rapidmx/web-client/lib/crypto/smime.js";
import { openProtectedMeeting, openWaitingNames, takeMeetingKey, UNREADABLE_WAITING_NAME } from "../../../apps/meet/_meetingKey.js";
import { sealWaitingName } from "../../../apps/shared/crypto/MeetingCipher.js";

async function protectedMeeting(title: unknown) {
    const key = await generateMeetingKey(new Date(Date.now() + 3_600_000));
    const sealed = await encryptForRecipients(new TextEncoder().encode(JSON.stringify(title)), [key.certificateDer]);
    const meeting: any = { uid: "m1", title: "Meeting", protected: true, meetingKeyCertificate: toBase64(key.certificateDer), sealedFields: { title: toBase64(sealed) } };
    return { key, meeting };
}

describe("_meetingKey", () => {
    it("takes the key from the link's # part and removes it from the address bar, and leaves a link without one alone", async () => {
        const { key } = await protectedMeeting("x");
        const history = { replaceState: vi.fn() };
        expect(takeMeetingKey({ hash: `#${meetingKeyFragment(key.pkcs8)}`, pathname: "/meet/tok", search: "?a=1" }, history)).toEqual(key.pkcs8);
        expect(history.replaceState).toHaveBeenCalledWith(null, "", "/meet/tok?a=1");
        history.replaceState.mockClear();
        expect(takeMeetingKey({ hash: "", pathname: "/meet/tok", search: "" }, history)).toBeUndefined();
        expect(history.replaceState).not.toHaveBeenCalled();
    });

    it("opens the sealed title and derives the live key with the meeting's key, and nothing with another", async () => {
        const { key, meeting } = await protectedMeeting("Board meeting");
        const opened = await openProtectedMeeting(meeting, key.pkcs8);
        expect(opened?.title).toBe("Board meeting");
        expect(opened?.liveKey.algorithm.name).toBe("AES-GCM");
        const other = await generateMeetingKey(new Date(Date.now() + 3_600_000));
        expect(await openProtectedMeeting(meeting, other.pkcs8)).toBeUndefined();
        expect(await openProtectedMeeting({ ...meeting, sealedFields: undefined }, key.pkcs8)).toBeUndefined();
        // An unprotected projection, which a link carrying a key must not join in the clear.
        expect(await openProtectedMeeting({ uid: "m1", title: "Meeting" } as any, key.pkcs8)).toBeUndefined();
        expect(await openProtectedMeeting((await protectedMeeting(7)).meeting, key.pkcs8)).toBeUndefined();
        const numeric = await protectedMeeting(7);
        expect(await openProtectedMeeting(numeric.meeting, numeric.key.pkcs8)).toBeUndefined();
    });

    it("opens a protected waiting room's sealed names with the live key, leaves readable ones, and shows one that won't open as unreadable", async () => {
        const { key, meeting } = await protectedMeeting("Board meeting");
        const { liveKey } = (await openProtectedMeeting(meeting, key.pkcs8))!;
        const other = (await openProtectedMeeting(meeting, key.pkcs8))!.liveKey;
        const list = [
            { uid: "guest:a", sealedName: await sealWaitingName(liveKey, "m1", "Grace"), requestedAt: "t1" },
            { uid: "guest:b", name: "Readable", requestedAt: "t2" },
            { uid: "guest:c", sealedName: await sealWaitingName(liveKey, "another-meeting", "Mallory"), requestedAt: "t3" },
        ];
        expect(await openWaitingNames(list, other, "m1")).toEqual([
            { ...list[0], name: "Grace" },
            list[1],
            { ...list[2], name: UNREADABLE_WAITING_NAME },
        ]);
        // Without the key nothing sealed is readable.
        expect((await openWaitingNames(list, undefined, "m1")).map((p) => p.name)).toEqual([UNREADABLE_WAITING_NAME, "Readable", UNREADABLE_WAITING_NAME]);
    });
});
