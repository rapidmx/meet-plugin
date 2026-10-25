///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * A protected meeting's key on the meeting page (`specs/meeting_privacy.md` §4.1): the link carries it after `#k=`, which the browser
 * never sends to the server. It is read once, before anything else runs, kept in memory only, and removed from the address bar so it
 * isn't left in the history or on screen. With it the page opens the meeting's sealed title and derives the live key its signaling and
 * relayed media are encrypted with.
 */
import { fromBase64 } from "@rapidmx/web-client/lib/crypto/encoding.js";
import { importMeetingKey, readMeetingKeyFragment } from "@rapidmx/web-client/lib/crypto/meetingKeys.js";
import { decryptEnvelopedDataWithKeys } from "@rapidmx/web-client/lib/crypto/smime.js";
import { openWaitingName } from "../shared/crypto/MeetingCipher.js";
import type { PublicVideoMeeting, WaitingParticipant } from "./_meetApi.js";

/** What the host is shown for someone waiting whose sealed name won't open with the meeting's key. */
export const UNREADABLE_WAITING_NAME = "Someone";

/** A protected meeting, opened with its link key. */
export interface OpenedMeeting {
    /** The meeting's real title. */
    title: string;
    /** What its signaling and relayed media are sealed with. */
    liveKey: CryptoKey;
}

/** The meeting key in `location`'s `#` part, removing that part from the address bar - or `undefined` when the link carries none. */
export function takeMeetingKey(
    location: Pick<Location, "hash" | "pathname" | "search"> = window.location,
    history: Pick<History, "replaceState"> = window.history,
): Uint8Array | undefined {
    const key = readMeetingKeyFragment(location.hash);
    if (location.hash) {
        history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
    return key;
}

/** `meeting` (a protected one) opened with `pkcs8`, its link key - `undefined` when the key isn't this meeting's, or its title won't
 * open. Never rejects. */
export async function openProtectedMeeting(meeting: PublicVideoMeeting, pkcs8: Uint8Array): Promise<OpenedMeeting | undefined> {
    if (!meeting.meetingKeyCertificate || !meeting.sealedFields?.title) {
        return undefined;
    }
    try {
        const { decryptionKey, liveKey } = await importMeetingKey(pkcs8, fromBase64(meeting.meetingKeyCertificate), meeting.uid);
        const plain = await decryptEnvelopedDataWithKeys(fromBase64(meeting.sealedFields.title), [decryptionKey]);
        const title: unknown = JSON.parse(new TextDecoder().decode(plain));
        return typeof title === "string" ? { title, liveKey } : undefined;
    } catch {
        return undefined;
    }
}

/** `list` (a meeting's waiting room) with every `sealedName` opened into `name` with `liveKey`, the meeting's - `UNREADABLE_WAITING_NAME`
 * for one that won't open, or for any sealed name without a key. A readable `name` is left as it is. Never rejects. */
export async function openWaitingNames(list: WaitingParticipant[], liveKey: CryptoKey | undefined, meetingUid: string): Promise<WaitingParticipant[]> {
    return await Promise.all(
        list.map(async (participant) => {
            if (participant.sealedName === undefined) {
                return participant;
            }
            const name = liveKey ? await openWaitingName(liveKey, meetingUid, participant.sealedName) : undefined;
            return { ...participant, name: name ?? UNREADABLE_WAITING_NAME };
        }),
    );
}
