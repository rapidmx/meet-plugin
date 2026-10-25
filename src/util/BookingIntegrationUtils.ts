///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ModelUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { buildBaseUrl } from "./PublicUrlUtils.js";
import { JOIN_TOKEN_PATTERN, mintJoinToken } from "./TokenUtils.js";
import { isMeetingKeyGone, type MeetingProtectionBody, PROTECTED_MEETING_TITLE, validateKeyExpiry, validateProtection } from "./MeetingProtectionUtils.js";
import { VideoMeeting, VideoMeetingInvitee, VideoMeetingStatus, VideoMeetingVisibility } from "../models/types.js";
const { Config } = ObjectDecorators;

/**
 * Mirrors `BaseVideoMeetingRoute`'s own `MAX_TITLE_LENGTH`/`MAX_DISPLAY_NAME_LENGTH` bounds. This function has no
 * HTTP request of its own to reject with a `400` (see the function doc comment below on why a bound is silently
 * clamped here instead), but a caller-supplied title/invitee name is still free text that ends up on a stored row,
 * so the same limits apply.
 */
const MAX_TITLE_LENGTH = 200;
const MAX_DISPLAY_NAME_LENGTH = 200;

/** The sole invitee `createSingleInviteeVideoMeeting()` mints a new private meeting for. */
export interface SingleMeetingInvitee {
    email: string;
    displayName?: string;
}

/**
 * Resolves `mail:videoconf:public_url` the same way `BaseVideoMeetingRoute` resolves it for its own `publicUrl`
 * field. `createSingleInviteeVideoMeeting()` is a plain function, not a route/injectable class, so it has no
 * `@Config`-decorated field of its own for `ObjectFactory` to populate at construction time - this tiny,
 * `ObjectFactory.initialize()`-able holder exists solely to get the same config resolution `@Config` normally
 * provides. Not exported: nothing outside this file needs it.
 */
class PublicUrlConfigHolder {
    @Config("mail:videoconf:public_url", "")
    public publicUrl: string = "";
}

/**
 * **The integration surface other plugins call.** This is the one thing `@rapidmx/meet-plugin` exposes for
 * another, independently-installed plugin to use in-process: mints a private `VideoMeeting` for exactly one
 * invitee and returns just that invitee's join URL. `booking-plugin` is today's only caller - a video-location
 * booking with no host-preset URL mints one of these automatically (the booker as the sole invitee, matching this
 * plugin's own "one link per invitee" private-meeting design) - see that package's `BaseBookingRoute`/`.claude/
 * NOTES.md` for the calling side, and this plugin's own `.claude/NOTES.md` for the design this integration was
 * built against.
 *
 * This and `extendSingleInviteeMeetingKey()` (its companion for a rescheduled booking) are deliberately the ONLY
 * integration points this package exposes: everything else about `VideoMeeting`/
 * `VideoMeetingInvitee` (routes, signaling, the join flow, cancellation, ...) is reached only through this
 * package's own HTTP API. A caller never gets a `VideoMeeting`/`VideoMeetingInvitee` instance back, only the one
 * value it actually needs, so this package stays free to change anything else about their shape without breaking
 * a caller compiled against an older version.
 *
 * Mirrors `BaseVideoMeetingRoute.create()`'s own private-meeting-plus-single-invitee path exactly, including its
 * `acl: { uid: instance.uid, parentUid: mailboxUid, records: [] }` claim (see that class's doc comment on why
 * `VideoMeeting` needs its own per-record `AccessControlList`) - but skips everything about validating an HTTP
 * request body or checking a caller's own permission on the mailbox: this is an in-process call from code that has
 * already established both by its own means (e.g. `booking-plugin`'s already-authorized, already-validated
 * booking flow).
 *
 * A caller-supplied `title`/`invitee.displayName` longer than this package's own route-level limits is silently
 * truncated rather than rejected - there is no request here to answer with a `400`, and a slightly-shortened title
 * is a far better outcome than throwing back into whatever the caller's own flow was doing. (`booking-plugin`'s own
 * call site additionally wraps this whole function in a `try`/`catch` so even a genuine failure here - a database
 * error, a stale/misconfigured deployment - never blocks the caller's own operation; see its doc comment.)
 *
 * @param objectFactory The caller's own `ObjectFactory` - used exactly as `BaseVideoMeetingRoute` uses its own, to
 * build the repos this needs and to resolve `mail:videoconf:public_url`.
 * @param meetingClass The concrete `VideoMeeting` model class for the caller's own backend (`VideoMeetingMongo`/
 * `VideoMeetingSQL`, from this package's `./mongo`/`./sql` entry points) - this package has no notion of "Mongo" vs.
 * "SQL" itself (see `BaseVideoMeetingRoute`'s identical `meetingClass` constructor parameter), so the caller
 * supplies it, the same way `booking-plugin`'s own `BookingRouteMongo`/`BookingRouteSQL` supply their own concrete
 * classes to `BaseBookingRoute`.
 * @param inviteeClass The concrete `VideoMeetingInvitee` model class for the same backend.
 * @param mailboxUid The mailbox the meeting is minted under - the caller's own already-authorized mailbox.
 * @param title A short, human-readable meeting title (e.g. the caller's own meeting/event name).
 * @param invitee The sole invitee of the new private meeting.
 * @param protection Makes the meeting protected end to end (`specs/meeting_privacy.md`), as a booking whose host has zero-access is: its
 * key's certificate, the host's wrap of the key, its sealed title and when the key is discarded - validated as `BaseVideoMeetingRoute`
 * validates a protected meeting (a `400` `ApiError` otherwise). The title is then stored as `"Meeting"`, the invitee's name isn't
 * stored, and the returned link needs the meeting key after `#`, which the caller adds where it sends the link.
 * @returns The invitee's join URL, or `undefined` when `mail:videoconf:public_url` isn't configured on this
 * deployment - mirroring `VideoMeetingInviteeJoinInfo.joinUrl`'s identical semantics exactly. Never throws for
 * that reason alone; a genuine failure (a bad `objectFactory`, a database error, ...) still propagates.
 */
export async function createSingleInviteeVideoMeeting<VM extends VideoMeeting, VMI extends VideoMeetingInvitee>(
    objectFactory: ObjectFactory,
    meetingClass: new (...args: any[]) => VM,
    inviteeClass: new (...args: any[]) => VMI,
    mailboxUid: string,
    title: string,
    invitee: SingleMeetingInvitee,
    protection?: MeetingProtectionBody,
): Promise<string | undefined> {
    const secured = protection ? validateProtection(protection, mailboxUid, Date.now(), 4) : undefined;
    const meetingRepo: RepoUtils<VM> = await objectFactory.newInstance(RepoUtils, { name: meetingClass.name, args: [meetingClass] });
    const inviteeRepo: RepoUtils<VMI> = await objectFactory.newInstance(RepoUtils, { name: inviteeClass.name, args: [inviteeClass] });
    const configHolder: PublicUrlConfigHolder = await objectFactory.initialize(new PublicUrlConfigHolder());

    const safeTitle: string = title.trim().slice(0, MAX_TITLE_LENGTH) || "Video meeting";

    // Constructed before `create()` is called (rather than inline), so its own, already-generated `uid` (every
    // `BaseEntity` mints one on construction) is what `acl.uid` below claims the meeting's own per-record ACL
    // under - see `BaseVideoMeetingRoute.persistMeeting()`'s identical reasoning.
    const meetingInstance: VM = new meetingClass({
        mailboxUid,
        title: secured ? PROTECTED_MEETING_TITLE : safeTitle,
        visibility: VideoMeetingVisibility.PRIVATE,
        status: VideoMeetingStatus.SCHEDULED,
        ...(secured
            ? {
                  keyProtected: true,
                  meetingKeyCertificate: secured.certificate,
                  meetingKeyFingerprint: secured.fingerprint,
                  keyExpiresAt: secured.keyExpiresAt,
                  keyWraps: secured.keyWraps,
                  sealedFields: { title: secured.sealedTitle },
              }
            : {}),
    });
    const meeting: VM = await meetingRepo.create(meetingInstance, {
        ignoreACL: true,
        acl: { uid: meetingInstance.uid, parentUid: mailboxUid, records: [] },
    });

    const inviteeRow: VMI = await inviteeRepo.create(
        new inviteeClass({
            meetingUid: meeting.uid,
            mailboxUid,
            email: invitee.email.trim().toLowerCase(),
            displayName: secured ? undefined : invitee.displayName?.trim().slice(0, MAX_DISPLAY_NAME_LENGTH) || undefined,
            joinToken: mintJoinToken(),
        }),
        { ignoreACL: true },
    );

    const base: string | undefined = buildBaseUrl(configHolder.publicUrl);
    return base ? `${base}/${inviteeRow.joinToken}` : undefined;
}

/**
 * Moves the key expiry of a protected meeting `createSingleInviteeVideoMeeting()` minted - the companion `booking-plugin` calls when a
 * protected booking is rescheduled, so the meeting's key lasts to the new slot (`specs/meeting_privacy.md` §8) instead of joining
 * answering 410 from the old slot's end on. The meeting is found by the invitee join token `joinUrl` ends in (anything after `#` or
 * `?` is ignored), and must belong to `mailboxUid`. Nothing is changed, and `false` returned, when the URL names no meeting of that
 * mailbox, or names one that isn't protected, is cancelled, or whose key has already expired or been discarded.
 *
 * @param objectFactory The caller's own `ObjectFactory` - as for `createSingleInviteeVideoMeeting()`.
 * @param meetingClass The concrete `VideoMeeting` model class for the caller's backend.
 * @param inviteeClass The concrete `VideoMeetingInvitee` model class for the same backend.
 * @param mailboxUid The mailbox the meeting was minted under.
 * @param joinUrl The invitee's join URL `createSingleInviteeVideoMeeting()` returned.
 * @param keyExpiresAt The new expiry: in the future and at most five years ahead (a `400` `ApiError` otherwise).
 * @returns Whether the meeting's expiry was moved.
 */
export async function extendSingleInviteeMeetingKey<VM extends VideoMeeting, VMI extends VideoMeetingInvitee>(
    objectFactory: ObjectFactory,
    meetingClass: new (...args: any[]) => VM,
    inviteeClass: new (...args: any[]) => VMI,
    mailboxUid: string,
    joinUrl: string,
    keyExpiresAt: Date,
): Promise<boolean> {
    const now: number = Date.now();
    const expires: Date = validateKeyExpiry(keyExpiresAt.toISOString(), now, "keyExpiresAt");
    const token: string = joinUrl.split(/[#?]/)[0].split("/").pop()!;
    if (!JOIN_TOKEN_PATTERN.test(token)) {
        return false;
    }
    const meetingRepo: RepoUtils<VM> = await objectFactory.newInstance(RepoUtils, { name: meetingClass.name, args: [meetingClass] });
    const inviteeRepo: RepoUtils<VMI> = await objectFactory.newInstance(RepoUtils, { name: inviteeClass.name, args: [inviteeClass] });
    const [invitee]: VMI[] = await inviteeRepo.find({ joinToken: ModelUtils.literal(token) } as any, { ignoreACL: true, limit: 1, skipCache: true });
    const meeting: VM | undefined = invitee ? await meetingRepo.findOne(invitee.meetingUid, { ignoreACL: true }) : undefined;
    if (
        !meeting ||
        meeting.mailboxUid !== mailboxUid ||
        !meeting.keyProtected ||
        meeting.status === VideoMeetingStatus.CANCELLED ||
        isMeetingKeyGone(meeting, now)
    ) {
        return false;
    }
    await meetingRepo.update({ uid: meeting.uid, version: (meeting as any).version, keyExpiresAt: expires } as any, meeting, { ignoreACL: true });
    return true;
}
