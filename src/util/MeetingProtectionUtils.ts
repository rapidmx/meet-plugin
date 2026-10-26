///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The validation of a protected meeting's key material (`specs/meeting_privacy.md` §3-4, §6.1): what the organizer's client sends when
 * it creates one. Everything here is public or sealed - a certificate, CMS wraps, sealed fields - and is checked for shape only: the
 * server can't open any of it, and never holds the meeting's private key.
 */
import * as crypto from "crypto";
import { ApiError } from "@rapidrest/core";
import { type AccessControlList, ACLAction, type ACLRecord, type ACLUtils, ApiErrors, ModelUtils, type RepoUtils } from "@rapidrest/service-core";
import type { CalendarEventAttendeeLink } from "@rapidmx/restapi";
import type { MeetingKeyWrap, VideoMeeting, VideoMeetingInvitee } from "../models/types.js";
import { mintJoinToken } from "./TokenUtils.js";

/** What a protected meeting's readable title holds: its real one is sealed. */
export const PROTECTED_MEETING_TITLE = "Meeting";

/** The longest sealed value or wrap accepted (base64): a CMS of a short field to a handful of recipients is far smaller. */
const MAX_SEALED_LENGTH = 64 * 1024;
/** The longest certificate accepted (base64 DER). */
const MAX_CERTIFICATE_LENGTH = 8 * 1024;
/** The furthest ahead a key may expire: a long recurring series. */
const MAX_KEY_LIFETIME_MS = 5 * 366 * 24 * 60 * 60 * 1000;
/** How many times `revokeParticipantGrants()` retries an optimistic-lock conflict on the meeting's ACL (a join saving at once). */
const GRANT_REVOKE_MAX_ATTEMPTS = 5;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** A create body's `protection`. */
export interface MeetingProtectionBody {
    /** The meeting key's certificate. */
    meetingKey?: { certificate?: unknown };
    /** When the key is discarded (ISO 8601). */
    keyExpiresAt?: unknown;
    keyWraps?: unknown;
    sealedFields?: { title?: unknown };
}

/** `protection`, validated. */
export interface MeetingProtection {
    certificate: string;
    fingerprint: string;
    keyExpiresAt: Date;
    keyWraps: MeetingKeyWrap[];
    sealedTitle: string;
}

function invalid(message: string): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
}

/** Whether `value` is a sealed value (base64, bounded). */
export function isSealedValue(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_SEALED_LENGTH && BASE64.test(value);
}

/** `value` as a protected meeting's key expiry at `now` (400 otherwise): an ISO 8601 date in the future, at most five years ahead. `field`
 * names it in the error. */
export function validateKeyExpiry(value: unknown, now: number, field: string): Date {
    const expires: Date = new Date(typeof value === "string" ? value : NaN);
    if (isNaN(expires.valueOf()) || expires.valueOf() <= now || expires.valueOf() > now + MAX_KEY_LIFETIME_MS) {
        throw invalid(`'${field}' must be a date in the future, at most five years ahead.`);
    }
    return expires;
}

/** Whether protected `meeting`'s key is gone at `now`: discarded, or past `keyExpiresAt` though `MeetingKeyExpiryJob` hasn't run yet
 * (`specs/meeting_privacy.md` §8). Always `false` for an unprotected meeting. */
export function isMeetingKeyGone(meeting: VideoMeeting, now: number): boolean {
    return !!meeting.keyProtected && (!!meeting.keyDiscardedAt || (!!meeting.keyExpiresAt && new Date(meeting.keyExpiresAt).valueOf() <= now));
}

/** The stores `discardMeetingKey()` writes to. */
export interface MeetingKeyRepos<VM extends VideoMeeting = VideoMeeting> {
    meetingRepo: RepoUtils<VM>;
    inviteeRepo: RepoUtils<any>;
    attendeeLinkRepo: RepoUtils<CalendarEventAttendeeLink>;
    /** Where the meeting's own `AccessControlList`, holding its participants' grants, is kept. */
    aclUtils: ACLUtils;
}

/** Whether `record` is a participant's channel grant: exactly `READ` and `CREATE`, what `BaseVideoMeetingRoute.ensureChannelGrant()` adds
 * for each joiner. The creator's record (`RepoUtils.create()` grants CRUD) and anything else the owner put there differ. */
function isParticipantGrant(record: ACLRecord): boolean {
    return record.actions.length === 2 && record.actions.includes(ACLAction.READ) && record.actions.includes(ACLAction.CREATE);
}

/**
 * Removes every participant's channel grant (`isParticipantGrant()`) from meeting `meetingUid`'s own `AccessControlList`, which only that
 * meeting's records are kept on, so no other meeting's participants lose anything. One read and at most one save per attempt, whatever
 * the number of grants. A no-op when there are none (already revoked) or the meeting has no ACL. Retries a version conflict (a join
 * saving at the same time) against the re-read ACL; throws any other error, or the last conflict.
 */
export async function revokeParticipantGrants(meetingUid: string, aclUtils: ACLUtils): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        const acl: AccessControlList | undefined = await aclUtils.findACL(meetingUid, [], { skipCache: true, skipParents: true });
        if (!acl || !acl.records.some(isParticipantGrant)) {
            return;
        }
        acl.records = acl.records.filter((record) => !isParticipantGrant(record));
        try {
            await aclUtils.saveACL(acl);
            return;
        } catch (err: any) {
            if (attempt >= GRANT_REVOKE_MAX_ATTEMPTS || !/must be of the same version/.test(err?.message ?? "")) {
                throw err;
            }
        }
    }
}

/**
 * Discards protected `meeting`'s key (`specs/meeting_privacy.md` §8), at expiry (`MeetingKeyExpiryJob`) or when the meeting is cancelled.
 * First claims the meeting, with an update checked against the version the caller read: it clears the certificate, the wraps and the
 * sealed title, marks it `keyDiscardedAt` and sets `keyCleanupPending`. Only then does `finishMeetingKeyDiscard()` touch the invitees,
 * their links and the grants. So a change made since the caller's read (an extended `keyExpiresAt` above all) makes the discard throw
 * before anything is lost, and once the claim is saved no extension can succeed, since the key is gone. Returns the updated meeting.
 * Throws whatever the store throws (a version conflict included); a failure after the claim leaves `keyCleanupPending` set, and
 * `MeetingKeyExpiryJob` finishes the cleanup on its next run.
 */
export async function discardMeetingKey<VM extends VideoMeeting>(meeting: VM, repos: MeetingKeyRepos<VM>): Promise<VM> {
    const claimed: VM = await repos.meetingRepo.update(
        {
            uid: meeting.uid,
            version: (meeting as any).version,
            meetingKeyCertificate: null,
            meetingKeyFingerprint: null,
            keyWraps: null,
            sealedFields: null,
            keyDiscardedAt: new Date(),
            keyCleanupPending: true,
        } as any,
        meeting,
        { ignoreACL: true },
    );
    return await finishMeetingKeyDiscard(claimed, repos);
}

/**
 * The cleanup of discarded `meeting` (`discardMeetingKey()`, which has already cleared its key and marked it). Deletes the keyed attendee
 * links of the meeting's own invitees, matched by their join tokens as `BaseVideoMeetingRoute.deleteAttendeeLinks()` matches them, so
 * another meeting on the same calendar event keeps its links. Then replaces the invitees' join tokens and clears their sealed names,
 * removes the participants' grants from the meeting's own ACL (`revokeParticipantGrants()`), and finally clears `keyCleanupPending`.
 * Returns the updated meeting. Every step is safe to do again, so a failure (thrown) leaves the flag for the next run of the job.
 */
export async function finishMeetingKeyDiscard<VM extends VideoMeeting>(meeting: VM, repos: MeetingKeyRepos<VM>): Promise<VM> {
    const invitees: VideoMeetingInvitee[] = await repos.inviteeRepo.find({ meetingUid: ModelUtils.literal(meeting.uid) } as any, { ignoreACL: true });
    if (meeting.calendarEventUid) {
        const links: CalendarEventAttendeeLink[] = await repos.attendeeLinkRepo.find(
            { mailboxUid: ModelUtils.literal(meeting.mailboxUid), calendarEventUid: ModelUtils.literal(meeting.calendarEventUid), keyed: true } as any,
            { ignoreACL: true, skipCache: true },
        );
        for (const link of links) {
            if (invitees.some((invitee) => link.url.endsWith(`/${invitee.joinToken}`))) {
                await repos.attendeeLinkRepo.delete(link.uid, { ignoreACL: true });
            }
        }
    }
    for (const invitee of invitees) {
        await repos.inviteeRepo.update(
            { uid: invitee.uid, version: (invitee as any).version, sealedFields: null, joinToken: mintJoinToken() } as any,
            invitee,
            { ignoreACL: true },
        );
    }
    await revokeParticipantGrants(meeting.uid, repos.aclUtils);
    return await repos.meetingRepo.update({ uid: meeting.uid, version: (meeting as any).version, keyCleanupPending: null } as any, meeting, {
        ignoreACL: true,
    });
}

/**
 * `body` (a create body's `protection`) validated for meeting `mailboxUid` at `now` (400 otherwise): a future `keyExpiresAt` within five
 * years; a sealed title; the meeting key's certificate, whose fingerprint is computed here; and one to `maxWraps` wraps of the key, for
 * `mailboxUid` (the organizer's) only.
 */
export function validateProtection(body: MeetingProtectionBody, mailboxUid: string, now: number, maxWraps: number): MeetingProtection {
    if (!body || typeof body !== "object") {
        throw invalid("'protection' must be an object.");
    }
    const expires: Date = validateKeyExpiry(body.keyExpiresAt, now, "protection.keyExpiresAt");
    if (!isSealedValue(body.sealedFields?.title)) {
        throw invalid("'protection.sealedFields.title' must be the sealed title.");
    }
    const certificate: unknown = body.meetingKey?.certificate;
    if (typeof certificate !== "string" || certificate.length > MAX_CERTIFICATE_LENGTH || !BASE64.test(certificate)) {
        throw invalid("'protection.meetingKey.certificate' must be a base64 DER certificate.");
    }
    const fingerprint: string = crypto.createHash("sha256").update(Buffer.from(certificate, "base64")).digest("hex");
    const wraps: unknown = body.keyWraps;
    if (!Array.isArray(wraps) || wraps.length === 0 || wraps.length > maxWraps) {
        throw invalid(`'protection.keyWraps' must list 1 to ${maxWraps} wraps.`);
    }
    const keyWraps: MeetingKeyWrap[] = wraps.map((wrap: any) => {
        if (
            wrap?.mailboxUid !== mailboxUid ||
            typeof wrap.recipientFingerprint !== "string" ||
            !FINGERPRINT.test(wrap.recipientFingerprint) ||
            wrap.kind !== "meeting-key" ||
            !isSealedValue(wrap.cms)
        ) {
            throw invalid("Each wrap is the organizer's: its 'mailboxUid', a SHA-256 'recipientFingerprint', 'kind' \"meeting-key\" and a sealed 'cms'.");
        }
        return { mailboxUid, recipientFingerprint: wrap.recipientFingerprint, kind: "meeting-key", cms: wrap.cms };
    });
    return { certificate, fingerprint, keyExpiresAt: expires, keyWraps, sealedTitle: body.sealedFields.title };
}
