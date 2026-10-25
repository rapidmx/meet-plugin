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
import { openProtectedMeeting, takeMeetingKey } from "../../../apps/meet/_meetingKey.js";

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
        expect(await openProtectedMeeting((await protectedMeeting(7)).meeting, key.pkcs8)).toBeUndefined();
        const numeric = await protectedMeeting(7);
        expect(await openProtectedMeeting(numeric.meeting, numeric.key.pkcs8)).toBeUndefined();
    });
});
