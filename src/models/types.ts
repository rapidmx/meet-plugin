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
     * The concrete `VideoMeetingMongo`/`VideoMeetingSQL` classes enforce this unique only *within* the owning
     * mailbox (mirroring `BookingType.slug`'s own uniqueness scope, by explicit design decision - see this
     * package's `.claude/NOTES.md`), but `BaseVideoMeetingRoute.join()`'s public URL carries no mailbox segment
     * (`/join/:token`, not `/join/:mailboxUid/:token`), so the lookup a join actually performs is NOT scoped to a
     * mailbox - it is a plain, global match on this field. The per-mailbox database constraint is a defense
     * against an unlucky RNG collision inside one mailbox (matching the `BookingType` precedent for consistency);
     * with ~48 bits of entropy per slug, a *cross*-mailbox collision is astronomically unlikely but is not
     * actually prevented by any database constraint. This is a deliberate, documented tradeoff, not an oversight.
     */
    publicSlug?: string;

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
