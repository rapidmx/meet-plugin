///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { BaseEntity } from "@rapidrest/service-core";

/** Whether a `VideoMeeting` is joinable only by its explicitly invited `VideoMeetingInvitee`s (each with their
 * own unguessable `joinToken`), or by anyone holding the meeting's single `publicSlug` link. */
export enum VideoMeetingVisibility {
    PRIVATE = "private",
    PUBLIC = "public",
}

/** The lifecycle of a `VideoMeeting`. Deliberately minimal for Phase 1 - `ACTIVE` and `ENDED` are not yet set by
 * any code in this package (no signaling event currently transitions a meeting automatically); they exist so the
 * shape doesn't need to change once a later phase starts using them. `CANCELLED` is the one transition
 * `BaseVideoMeetingRoute.update()` actually performs today. */
export enum VideoMeetingStatus {
    SCHEDULED = "scheduled",
    ACTIVE = "active",
    ENDED = "ended",
    CANCELLED = "cancelled",
}

/**
 * A WebRTC video meeting owned by a `Mailbox` - joinable directly via this plugin's own API (for now; a later
 * phase wires an "Add video conferencing" hook into calendar event compose, see `calendarEventUid` below) or by
 * anyone holding a valid link (a private invitee's `joinToken`, or a public meeting's `publicSlug`).
 *
 * Anonymous access to this entity is NOT granted through the `AccessControlList`'s class-level default (see
 * `@Protect`'s deny-all `records` on the concrete `VideoMeetingMongo`/`VideoMeetingSQL`) - `BaseVideoMeetingRoute`
 * does its own authorization: the owner's routes check `ACLUtils.hasPermission()` against the meeting's
 * `mailboxUid` (with the caller's trusted roles stripped first - see `util/RouteAccessUtils.ts`), and the
 * anonymous `join()` route resolves a caller by `joinToken`/`publicSlug` directly, the same posture
 * `booking-plugin`'s `BaseBookingRoute` documents for `Booking`/`BookingType`.
 *
 * Unlike `Booking`, this entity DOES get its own per-record `AccessControlList` (`@Protect`'s `recordACL: true`) -
 * its own `uid` doubles as its `/push` signaling channel (see `BaseVideoMeetingRoute`'s class doc comment), and a
 * `/push` channel is authorized purely by whether a per-channel `AccessControlList` document grants the caller an
 * action on it (`ACLUtils.hasPermission(user, channelUid, action)`); there would be no such document to check
 * against at all without `recordACL: true`. Creating a meeting's own ACL with `parentUid` set to its `mailboxUid`
 * (see `BaseVideoMeetingRoute.create()`) lets a mailbox owner/delegate reach it exactly as they reach any other
 * mailbox-scoped record, through the normal ACL parent-chain inheritance - no separate mechanism is needed for
 * the owner's own push access, only for a guest's (see `join()`'s doc comment).
 *
 * @author Jean-Philippe Steinmetz
 */
export interface VideoMeeting extends BaseEntity {
    /** The unique identifier of the `Mailbox` that owns this meeting. Managing it (create/list/delete/cancel) is
     * permission-checked against this mailbox's `AccessControlList`, the same as every other mailbox-scoped child
     * entity - see the architecture note on `Message.mailboxUid` in `@rapidmx/restapi`'s `models/types.ts`. */
    mailboxUid: string;

    /** The unique identifier of the `CalendarEvent` this meeting was minted for, if any. Optional in Phase 1: a
     * meeting can exist with no calendar event at all (created directly through this plugin's own API, e.g. for
     * testing); a later phase wires an "Add video conferencing" control into calendar event compose that sets
     * this when it mints a meeting for a real invite. */
    calendarEventUid?: string;

    title: string;

    visibility: VideoMeetingVisibility;

    /**
     * The public join link's unique identifier, set only when `visibility` is `PUBLIC`. Random rather than
     * name-derived (unlike `booking-plugin`'s human-chosen `BookingType.slug`) - see `util/TokenUtils.ts`'s
     * `mintPublicSlug()` doc comment for the exact shape/entropy and why.
     *
     * The concrete `VideoMeetingMongo`/`VideoMeetingSQL` classes index this unique **globally**, matching exactly
     * what `BaseVideoMeetingRoute.join()`'s public URL actually looks up (`/join/:token`, not
     * `/join/:mailboxUid/:token` - the lookup carries no mailbox segment at all). An initial design considered
     * scoping the database constraint to the owning mailbox instead (mirroring `BookingType.slug`'s own scope,
     * for consistency with `booking-plugin`'s precedent - see this package's `.claude/NOTES.md`'s Phase 1 entry),
     * but a per-mailbox *compound* sparse index doesn't actually work: it still indexes a document carrying at
     * least one of its keys, and every row has `mailboxUid`, so two *private* meetings in one mailbox (both
     * missing `publicSlug`) would collide on `(mailboxUid, null)` and the second could never be created - a real
     * bug, not just a weaker-than-intended constraint, found and fixed before release. A single-field sparse
     * index skips a document missing the field entirely, which both fixes that bug and happens to match the
     * lookup's real (global) scope exactly - see `organizerSlug` below, which hit the identical pitfall.
     */
    publicSlug?: string;

    /**
     * The organizer's own join link identifier, minted only for a `PRIVATE` meeting, at creation. It exists solely
     * so the meeting's organizer has *some* token `BaseVideoMeetingRoute.requireMeetingByToken()` can resolve to
     * their own meeting: a private meeting's only other resolvable credentials are its invitees' `joinToken`s, and
     * the calendar integration that mints a meeting per event deliberately builds `invitees` from the event's
     * attendees *excluding* the organizer (the organizer manages the meeting through ownership, not as a guest), so
     * without this the organizer of their own private meeting would have no link that resolves at all.
     *
     * **Unlike `publicSlug`, holding this value is not by itself a credential.** Resolving a token through this
     * field never grants anonymous or guest access: `BaseVideoMeetingRoute.join()` additionally requires a real,
     * already-authenticated (non-guest) caller who holds `READ` on the meeting's own `mailboxUid`, and answers the
     * same bare `404` as an entirely unknown token for anyone else - see that method's doc comment. The value is
     * unguessable all the same (the same `mintPublicSlug()` shape/entropy as `publicSlug`, stored in its own
     * column), but that unguessability is defense in depth here, not the authorization itself.
     *
     * A meeting's `visibility` never changes after creation, and neither does this field. It is never set for a
     * `PUBLIC` meeting. It is, however, genuinely optional even for a private one: a private meeting minted through
     * `createSingleInviteeVideoMeeting()` (`util/BookingIntegrationUtils.ts` - `booking-plugin`'s in-process
     * integration, whose meetings are managed from the booking flow and have no organizer to hand a link to) has
     * none, so code must check for its presence rather than infer it from `visibility` alone.
     *
     * The concrete `VideoMeetingMongo`/`VideoMeetingSQL` classes index this unique globally, single-field sparse -
     * the same shape `publicSlug`'s own index was corrected to (see above); this field never had the per-mailbox
     * version to begin with, having been added after that pitfall was already found.
     */
    organizerSlug?: string;

    status: VideoMeetingStatus;

    /** Informational only in Phase 1 - not used for any availability or conflict checking (a video meeting has no
     * concept of "busy" the way a `Booking` does). */
    startTime?: Date;

    /** Informational only in Phase 1 - see `startTime`. */
    endTime?: Date;
}

/**
 * One invited participant of a `PRIVATE` `VideoMeeting`, minted server-side by `BaseVideoMeetingRoute.create()` -
 * one row per `{ email, displayName? }` the owner supplied at creation time. `joinToken` is this invitee's only
 * credential (mirroring `Booking.manageToken` exactly - see `util/TokenUtils.ts`'s `mintJoinToken()`): possession
 * of the link is what lets an anonymous invitee reach `BaseVideoMeetingRoute.join()`, never an
 * `AccessControlList` grant of its own (this entity's class ACL is deny-all, like `Booking`'s - see
 * `@Protect` on the concrete `VideoMeetingInviteeMongo`/`VideoMeetingInviteeSQL`).
 *
 * @author Jean-Philippe Steinmetz
 */
export interface VideoMeetingInvitee extends BaseEntity {
    /** The unique identifier of the `VideoMeeting` this invitee belongs to. */
    meetingUid: string;

    /**
     * The unique identifier of the host `Mailbox`, denormalized from the meeting - mirroring `Booking.mailboxUid`'s
     * own doc comment exactly: this lets `ErasureExecutionJob` find and purge every invitee of an erased mailbox's
     * meetings by `mailboxUid` alone (the `@MailboxScopedData()` contract), without a join back through
     * `VideoMeeting`, and lets a host's invitees be listed without one either.
     */
    mailboxUid: string;

    /** The invitee's email address, normalized to lowercase. */
    email: string;

    displayName?: string;

    /** The unguessable token embedded in this invitee's join link, minted server-side (32 random bytes) and
     * immutable thereafter. Like `Booking.manageToken`, this has no expiry and no GC job of its own - see
     * `BaseVideoMeetingRoute`'s class doc comment for the same documented tradeoff. */
    joinToken: string;
}
