///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { buildBaseUrl } from "./PublicUrlUtils.js";
import { mintJoinToken } from "./TokenUtils.js";
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
 * This is deliberately the ONLY integration point this package exposes: everything else about `VideoMeeting`/
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
): Promise<string | undefined> {
    const meetingRepo: RepoUtils<VM> = await objectFactory.newInstance(RepoUtils, { name: meetingClass.name, args: [meetingClass] });
    const inviteeRepo: RepoUtils<VMI> = await objectFactory.newInstance(RepoUtils, { name: inviteeClass.name, args: [inviteeClass] });
    const configHolder: PublicUrlConfigHolder = await objectFactory.initialize(new PublicUrlConfigHolder());

    const safeTitle: string = title.trim().slice(0, MAX_TITLE_LENGTH) || "Video meeting";

    // Constructed before `create()` is called (rather than inline), so its own, already-generated `uid` (every
    // `BaseEntity` mints one on construction) is what `acl.uid` below claims the meeting's own per-record ACL
    // under - see `BaseVideoMeetingRoute.persistMeeting()`'s identical reasoning.
    const meetingInstance: VM = new meetingClass({
        mailboxUid,
        title: safeTitle,
        visibility: VideoMeetingVisibility.PRIVATE,
        status: VideoMeetingStatus.SCHEDULED,
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
            displayName: invitee.displayName?.trim().slice(0, MAX_DISPLAY_NAME_LENGTH) || undefined,
            joinToken: mintJoinToken(),
        }),
        { ignoreACL: true },
    );

    const base: string | undefined = buildBaseUrl(configHolder.publicUrl);
    return base ? `${base}/${inviteeRow.joinToken}` : undefined;
}
