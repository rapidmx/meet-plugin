///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, JWTUtils, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ACLUtils,
    ApiErrorMessages,
    ApiErrors,
    DatabaseDecorators,
    DocDecorators,
    HttpRequest,
    ModelUtils,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
    type AccessControlList,
} from "@rapidrest/service-core";
import { CalendarEventAttendeeLink, Mailbox } from "@rapidmx/restapi";
import { buildIceServers, IceServerConfig } from "../util/IceServerUtils.js";
import { buildBaseUrl } from "../util/PublicUrlUtils.js";
import { stripTrustedRoles } from "../util/RouteAccessUtils.js";
import { JOIN_TOKEN_PATTERN, PUBLIC_SLUG_PATTERN, mintJoinToken, mintPublicSlug } from "../util/TokenUtils.js";
import { VideoMeeting, VideoMeetingInvitee, VideoMeetingStatus, VideoMeetingVisibility } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Description, Summary } = DocDecorators;
const { Transactional } = DatabaseDecorators;
const { Delete, Get, Param, Post, Put, Query, RateLimit, Request, User: AuthUser } = RouteDecorators;

/** Upper bounds on caller-supplied text, matching the general shape `booking-plugin`'s `BaseBookingRoute` bounds
 * its own free-text fields with. */
const MAX_TITLE_LENGTH = 200;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;

/** The most invitees a single private meeting may be created with - a defensive cap, not a real product limit
 * (this plugin's "full-mesh, up to 4-6 participants" design already makes a larger list impractical - see
 * `.claude/NOTES.md`), so a single request can't mint an unbounded number of invitee rows/tokens. */
const MAX_INVITEES = 50;

/** A very small sanity check on an invitee's supplied address - deliberately not a full RFC 5322 parser, matching
 * `BaseBookingRoute`'s identical `EMAIL_PATTERN`. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

/** How long a guest JWT minted by `join()` remains valid for. Four hours comfortably covers a realistic call's
 * length (including some run-over) without a guest's session dying mid-call; there is no refresh mechanism in
 * Phase 1, so a guest who is still on the call past this needs to re-open the join link. */
export const GUEST_JWT_TTL_SECONDS: number = 4 * 60 * 60;

/** The fixed prefix every guest uid `mintGuestToken()` mints starts with - also how `join()` tells a genuine,
 * already-authenticated RapidMX identity apart from a returning guest presenting a JWT from an earlier `join()`
 * call (see `join()`'s doc comment): a guest uid is never a real mailbox-owning identity, so this prefix is a safe,
 * cheap discriminator with no separate "is this a guest" flag needed anywhere. */
export const GUEST_UID_PREFIX = "guest:";

/** How many times `ensureChannelGrant()` retries an optimistic-lock conflict on the meeting's own ACL before
 * giving up - see that method's doc comment. */
const GUEST_GRANT_MAX_ATTEMPTS = 5;

/** The `label` of every `CalendarEventAttendeeLink` `persistMeeting()` writes. */
const ATTENDEE_LINK_LABEL = "Join video call";

/** The request body accepted by `create()`. */
export interface CreateVideoMeetingBody {
    mailboxUid?: string;
    title?: string;
    visibility?: string;
    /** The `CalendarEvent` this meeting is being minted for, if any - see `VideoMeeting.calendarEventUid`. */
    calendarEventUid?: string;
    startTime?: string;
    endTime?: string;
    /** Required (and non-empty), only when `visibility` is `"private"`. */
    invitees?: { email?: string; displayName?: string }[];
}

/** One invitee of a newly created private meeting, as returned by `create()` - everything a caller needs to build
 * that invitee's own share of the calendar invite (Phase 3's job). */
export interface VideoMeetingInviteeJoinInfo {
    uid: string;
    email: string;
    displayName?: string;
    /** `undefined` when `mail:videoconf:public_url` isn't configured - see `BaseVideoMeetingRoute`'s class doc
     * comment. */
    joinUrl?: string;
}

/** `create()`'s response: the persisted meeting, plus whatever link(s) a caller needs to invite people to it. */
export interface VideoMeetingCreateResult<T extends VideoMeeting = VideoMeeting> {
    meeting: T;
    /** Present (possibly empty only if `invitees` validation somehow let that through - it never does, see
     * `validateCreateBody()`) exactly when `meeting.visibility` is `"private"`. */
    invitees?: VideoMeetingInviteeJoinInfo[];
    /** Present exactly when `meeting.visibility` is `"public"`; `undefined` within that case only when
     * `mail:videoconf:public_url` isn't configured. */
    publicJoinUrl?: string;
    /** The organizer's own join link, present exactly when `meeting.organizerSlug` is set - i.e. for every private
     * meeting this route creates, *alongside* `invitees` rather than instead of it (`undefined` within that case
     * only when `mail:videoconf:public_url` isn't configured). The organizer of a private meeting is deliberately
     * never one of its own `invitees`, so this is the only link that resolves to the meeting for them - see
     * `VideoMeeting.organizerSlug` and `join()`'s doc comment for why holding it is not by itself a credential. */
    organizerJoinUrl?: string;
}

/** Which field of which row `requireMeetingByToken()` matched the caller's token against - `join()` authorizes each
 * differently, so the resolution is returned explicitly rather than re-derived by comparing strings afterwards. */
export type VideoMeetingTokenResolution = "invitee" | "publicSlug" | "organizerSlug";

/** The public projection of a `VideoMeeting`, as returned to an anonymous joiner - deliberately narrow: a guest
 * never sees `mailboxUid`, `calendarEventUid` or any other internal identifier. */
export interface PublicVideoMeeting {
    uid: string;
    title: string;
    visibility: VideoMeetingVisibility;
    status: VideoMeetingStatus;
    /** The host mailbox's `displayName`, when it has one. */
    hostDisplayName?: string;
}

/**
 * `join()`'s response.
 *
 * **`authenticated`/`selfUid`/`token` - reading this shape correctly.** A caller who already presented a valid
 * session for a real, non-guest RapidMX identity (see `join()`'s doc comment for exactly how that's told apart
 * from a returning guest) gets `authenticated: true` and no `token`/`expiresAt` at all - there is no guest JWT to
 * hand over, because the caller's own already-existing session cookie/header already authenticates `/push` for
 * them, with zero new client-side auth handling. The frontend must not write any cookie in that case (doing so
 * would be pointless at best, and at worst overwrite the caller's real cookie with... the value it already has).
 * The common anonymous case (`authenticated: false`) is unchanged from Phase 1: `token`/`expiresAt` are present
 * and the frontend applies `token` as the `jwt` cookie before connecting - see
 * `apps/shared/push/GuestSignalingClient.ts`.
 */
export interface VideoMeetingJoinResult {
    meeting: PublicVideoMeeting;
    iceServers: IceServerConfig[];
    /** `true` when the caller already presented a valid session for a real RapidMX identity when calling `join()`;
     * `false` for the common anonymous case, where a fresh guest identity was just minted instead. */
    authenticated: boolean;
    /** The identity now holding `READ`/`CREATE` on the meeting's own push channel, and the uid the frontend's mesh
     * connection manager (`apps/shared/webrtc/MeshConnectionManager.ts`) must identify itself as: the caller's own
     * real uid when `authenticated` is `true`, otherwise the freshly minted synthetic `guest:<random>` uid `token`
     * authenticates as. Always present - this replaces Phase 1's guest-only `guestUid` field now that the same
     * grant-and-identify step also runs for a real, already-authenticated caller. */
    selfUid: string;
    /** A short-lived guest JWT, immediately usable against `/push` to subscribe to and publish on `meeting.uid` -
     * and nothing else. Present only when `authenticated` is `false`; omitted entirely for an already-authenticated
     * real caller, who has no guest token minted for them at all (see `join()`). See this class's doc comment. */
    token?: string;
    /** ISO 8601 instant `token` expires at. Present only when `authenticated` is `false`, exactly when `token`
     * itself is. */
    expiresAt?: string;
}

/**
 * The owner's management of their own `VideoMeeting`s (JWT-authenticated, mailbox-ACL-checked exactly like any
 * other mailbox-scoped entity - see `booking-plugin`'s `BaseBookingTypeRoute` for the same "must own or hold a
 * grant on the mailbox" pattern this class hand-implements) and the anonymous `join()` endpoint a private
 * invitee's `joinToken` or a public meeting's `publicSlug` resolves through.
 *
 * Like `BaseBookingRoute`, this is a standalone class, NOT a `CRUDRoute`/`BaseScopedChildRoute` subclass: `create()`'s
 * response is not itself a bare `VideoMeeting` (it also carries invitee join links / the public join link, which the
 * generic CRUD return type can't express), and `join()` is anonymous and token-resolved, the same shape of
 * requirement that keeps `BaseBookingRoute` standalone. Every repo call passes `ignoreACL: true` because this class
 * performs its own authorization: the owner-side methods check `ACLUtils.hasPermission()` against the meeting's
 * `mailboxUid` with the caller's trusted roles stripped first (`util/RouteAccessUtils.ts` - see that module's doc
 * comment for why: without it, `ACLUtils.hasPermission()`'s own "trusted users always have permission" rule would
 * let an administrator read or manage a mailbox they hold no grant on, which is never true for mail here), and
 * `join()` resolves an anonymous caller purely by the token/slug's own database match. Like `Booking`/`BookingType`,
 * the concrete `VideoMeetingMongo`/`VideoMeetingSQL`/`VideoMeetingInviteeMongo`/`VideoMeetingInviteeSQL` classes carry
 * an ordinary deny-all class ACL; `"anonymous"` is never granted an action anywhere.
 *
 * Like `BaseBookingRoute`/`BaseMailIngestRoute`/`BasePushRoute`, this class carries no `@Route`/`@ApiRoute` of its
 * own - the consuming Mongo/SQL concrete subclass applies one (`mail/video-meetings`).
 *
 * ## Path shape
 *
 * `join()` lives at the literal `/join/:token` (not `/:token` at the root), the same reasoning `BaseBookingRoute`'s
 * doc comment gives for its own `/manage/<token>` vs. `/:slug/slots` split: a bare `/:token` at the root would
 * collide with (and make router registration order decide between) this class's own `/:id` owner routes.
 *
 * ## Why `VideoMeeting` gets its own per-record `AccessControlList`
 *
 * Unlike `Booking`, `VideoMeeting.uid` doubles as a `/push` signaling channel (see `.claude/NOTES.md`'s "Signaling"
 * design note): SDP offers/answers and ICE candidates are ordinary `NotificationUtils.sendMessage()` payloads
 * published to it, exactly as `MailPushRoute`'s doc comment describes for a `Mailbox`/`Folder` channel. A `/push`
 * channel is authorized purely by `ACLUtils.hasPermission(user, channelUid, action)` against a per-record
 * `AccessControlList` document keyed by that exact uid - there being no such document at all (the case for
 * `Booking`, whose `@Protect` sets `recordACL: false`) makes `hasPermission()` always answer `false`. So
 * `VideoMeetingMongo`/`VideoMeetingSQL` set `recordACL: true`, and `create()` below claims that per-record ACL
 * with `parentUid` set to the meeting's own `mailboxUid` (mirroring `BaseFolderRoute`'s identical `acl: { uid,
 * parentUid: mailboxUid, records: [] }` pattern) - which is also what lets a mailbox owner/delegate reach the
 * meeting (and its channel) through the ordinary ACL parent-chain, with no extra mechanism needed on top of what
 * `RepoUtils.create()`'s automatic per-record ACL claim already does (it grants the creator full rights on the
 * fresh ACL - see `RepoUtils.claimRecordACL()`).
 *
 * ## The channel-ACL-grant mechanism
 *
 * An anonymous guest holds no `AccessControlList` grant of their own and has no `JWTUser` to authenticate `/push`
 * with in the first place - `join()` therefore does two things together: it mints a short-lived, scope-limited
 * guest JWT (`mintGuestToken()`: a synthetic `guest:<random>` uid, no roles, `GUEST_JWT_TTL_SECONDS` expiry, real and
 * verifiable since it's signed with the same `auth` config every other token is), and it adds an explicit
 * `ACLRecord` for that exact uid onto the meeting's own `AccessControlList` (`ensureChannelGrant()`), granting
 * `READ` (so `BasePushRoute`'s SUBSCRIBE succeeds) and `CREATE` (so a publish does - see `MailPushRoute`'s doc
 * comment: "publishing to a channel needs CREATE on it as an ordinary user would"). The grant is scoped to exactly
 * that one meeting's uid, nothing else - the same "possession of a link is the credential" pattern
 * `BaseBookingRoute.requireBookingByToken()`/`resolveEffectiveUser()`'s `share:<token>` identity already establish
 * elsewhere in this codebase, extended one step further because signaling needs a channel *subscription*, not just
 * a stateless REST call.
 *
 * **Known limitation, documented rather than silently assumed away**: because each `join()` call for an anonymous
 * caller mints a *fresh* random guest uid (so simultaneous participants of one shared link are distinguishable from
 * each other in the signaling channel), each such join adds one more `ACLRecord` to the meeting's own ACL document,
 * and nothing in Phase 1 ever removes one. A meeting joined many times over its lifetime accumulates unused records;
 * there is no GC job, matching this codebase's own precedent for `Booking.manageToken` (documented as never
 * expiring, no GC job either). Since the guest JWTs themselves expire, an accumulated record is inert (unusable)
 * well before it becomes a real concern - a cleanup pass is a reasonable thing for a later phase to add, not a
 * Phase 1 requirement. An already-authenticated real caller (see below) is granted their own stable uid instead, so
 * repeated joins by the same real identity never add more than the one record `ensureChannelGrant()`'s own
 * idempotency check already collapses them to.
 *
 * ## Real, already-authenticated callers (the browser-session-collision fix)
 *
 * `join()` also accepts an optional `@AuthUser`: whatever `req.user` the framework's own `JWTStrategy` already
 * populated from the caller's existing `Authorization` header or `jwt` cookie, exactly like every other
 * authenticated-optional endpoint in this codebase's family (e.g. `BaseScopedChildRoute.resolveEffectiveUser()`'s
 * "prefer the real authenticated user, fall back to the anonymous token" precedent). This matters because a
 * logged-in RapidMX user's browser already carries a real, `HttpOnly` `jwt` session cookie for this origin - a
 * cookie `apps/shared/push/GuestSignalingClient.ts` cannot overwrite with a guest token even if `join()` minted one
 * (browsers refuse to let a script override an `HttpOnly` cookie of the same name), so a guest-only `join()` would
 * leave that browser's `/push` WebSocket authenticating as the real session while the meeting's ACL only names a
 * synthetic guest uid - the subscribe is simply, safely refused, and the real user could never actually join.
 *
 * The fix: when `user` is present and is a *real* identity - not a guest uid from a previous `join()` call, told
 * apart by the `GUEST_UID_PREFIX` a guest uid always starts with and a real, mailbox-owning identity never can -
 * `join()` grants `user.uid` itself (not a synthetic one) `READ`/`CREATE` on the meeting's channel via
 * `ensureChannelGrant()`, mints no guest JWT at all, and returns `authenticated: true` with `selfUid: user.uid`. The
 * caller's own already-existing session cookie now already authenticates `/push` for them with zero new
 * client-side auth handling - the frontend must not write a cookie of its own in this case (see
 * `VideoMeetingJoinResult`'s doc comment). When `user` is absent (the common, true-anonymous case - no existing
 * session at all), behavior is exactly Phase 1's: a fresh guest identity is minted and granted instead.
 *
 * ## The organizer's own slug (`VideoMeeting.organizerSlug`)
 *
 * The fix above lets a real, already-authenticated caller join *if they already hold something that resolves to the
 * meeting*. The organizer of their own private meeting does not: the calendar integration that mints a meeting per
 * event builds `invitees` from the event's attendees **excluding the organizer** (who manages the meeting through
 * ownership, not as a guest), and `publicSlug` is minted only for a public meeting - so the one person who owns the
 * meeting had no token `requireMeetingByToken()` could resolve for them at all. `persistMeeting()` therefore also
 * mints an `organizerSlug` for every private meeting, `create()` returns it as `organizerJoinUrl` alongside the
 * per-invitee links, and `findById()` returns the same link for a meeting loaded later.
 *
 * **This does not widen the `"private"` invariant by one caller.** The other two resolutions are credentials in
 * themselves - possession of an invitee `joinToken` or a `publicSlug` is exactly what authorizes the join, by
 * design. An `organizerSlug` is not: `requireMeetingByToken()` reports *which* field resolved the match, and for
 * `"organizerSlug"` `join()` requires, before computing or returning anything about the meeting, both that the
 * caller is a real already-authenticated identity (the same non-guest `GUEST_UID_PREFIX` check as above, so a
 * returning guest presenting a prior `join()`'s own guest JWT never qualifies) and that this identity holds `READ`
 * on the meeting's own `mailboxUid` - the very same `ACLUtils.hasPermission()` call, trusted roles stripped, that
 * `requireMailboxAccess()` makes for every owner-side route, so a trusted administrator with no explicit grant is
 * refused here exactly as they are there. Every caller who fails either condition - a true anonymous stranger, a
 * returning guest, or a real but unrelated logged-in user - gets the identical bare `404` an entirely unknown token
 * gets, never a `403`: this class never leaks whether a token almost-matched something, and an
 * organizer-slug-shaped probe must be indistinguishable from a slug naming nothing at all. A caller who satisfies
 * both proceeds through exactly the authenticated branch described above, with no new response field.
 *
 * ## Recovering a join link on a later read (`find()`/`findById()`, Phase 4)
 *
 * `create()`'s response computes `organizerJoinUrl`/`publicJoinUrl` inline, once, from the slug it just minted -
 * fine for the moment of creation, but Phase 4's settings page (`apps/settings-video-conferencing`) needs a
 * meeting's own persistent link on every later page load too, not only the one response `create()` ever sent (a
 * user's "personal room", by this codebase's Phase 4 convention, is simply their oldest non-cancelled `PUBLIC`
 * meeting - see `.claude/NOTES.md`'s Phase 4 entry for why no new field/route was needed to name it as such). Since
 * a plain `RepoUtils.find()`/`findOne()` returns only the persisted slug columns, `find()` and `findById()` both
 * now run every loaded meeting through `withJoinUrls()` - the exact same computation `create()` already did,
 * applied uniformly on read instead of only once on write.
 *
 * ## Other known limitations
 *
 * **`VideoMeetingInvitee.joinToken` never expires** and has no GC job - identical tradeoff to `Booking.manageToken`.
 *
 * **`VideoMeeting.publicSlug` is only uniqueness-checked within its own mailbox** by the database, while `join()`'s
 * lookup is global (the public join URL carries no mailbox segment) - see the `VideoMeeting.publicSlug` doc comment
 * for the full reasoning; a cross-mailbox collision is not actually prevented, only made astronomically unlikely by
 * the slug's own entropy. `VideoMeeting.organizerSlug` has the same shape and entropy but is indexed unique
 * *globally*, which is exactly the scope its own lookup uses - see its doc comment for why a per-mailbox compound
 * index cannot work for a field only half the rows carry. Less rides on it either way: resolving through it grants
 * nothing by itself, so an unlucky collision there would cost a caller a `404`, never access.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseVideoMeetingRoute<VM extends VideoMeeting, VMI extends VideoMeetingInvitee, M extends Mailbox> {
    protected abstract meetingClass: any;
    protected abstract inviteeClass: any;
    protected abstract mailboxClass: any;
    /** The concrete `CalendarEventAttendeeLink` class for this backend (`CalendarEventAttendeeLinkMongo`/
     * `CalendarEventAttendeeLinkSQL`, from `@rapidmx/restapi`) - see `persistMeeting()`. */
    protected abstract attendeeLinkClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private meetingRepo?: RepoUtils<VM>;
    private inviteeRepo?: RepoUtils<VMI>;
    private mailboxRepo?: RepoUtils<M>;
    private attendeeLinkRepo?: RepoUtils<CalendarEventAttendeeLink>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    /** The `auth` config every other JWT in this deployment is signed/verified with - used by `mintGuestToken()` to
     * mint a guest's own, short-lived token with the exact same signature the framework's `JWTStrategy` verifies. */
    @Config("auth")
    private authConfig: any;

    /** The externally reachable base URL of the public join pages, used to build the invite links `create()`
     * returns. Same single-value-config pattern as `mail:booking:public_url`/`mail:autodiscover:public_url`; when
     * unset (or unsafe - see `buildBaseUrl()`) a join link is simply omitted rather than returning a broken one. */
    @Config("mail:videoconf:public_url", "")
    private publicUrl: string = "";

    @Config("mail:videoconf:turn:url", "")
    private turnUrl: string = "";

    @Config("mail:videoconf:turn:username", "")
    private turnUsername: string = "";

    @Config("mail:videoconf:turn:credential", "")
    private turnCredential: string = "";

    @Config("mail:videoconf:turn:shared_secret", "")
    private turnSharedSecret: string = "";

    @Logger
    private logger: any;

    /**
     * Exposes the `@Model(...)`-supplied entity class as an instance property so `@Transactional()` on
     * `persistMeeting()` can resolve which datasource to open a transaction against - identical to
     * `BaseBookingRoute`'s own `modelClass` getter, for the same reason (this class deliberately doesn't extend
     * `ModelRoute`, which defines the same getter for its own subclasses).
     */
    public get modelClass(): any {
        return (this.constructor as any).modelClass;
    }

    private async init(): Promise<void> {
        if (!this.meetingRepo) {
            this.meetingRepo = await this._objectFactory!.newInstance(RepoUtils, { name: this.meetingClass.name, args: [this.meetingClass] });
        }
        if (!this.inviteeRepo) {
            this.inviteeRepo = await this._objectFactory!.newInstance(RepoUtils, { name: this.inviteeClass.name, args: [this.inviteeClass] });
        }
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, { name: this.mailboxClass.name, args: [this.mailboxClass] });
        }
        if (!this.attendeeLinkRepo) {
            this.attendeeLinkRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.attendeeLinkClass.name,
                args: [this.attendeeLinkClass],
            });
        }
    }

    /** Rejects a `403` unless `user` (with its trusted roles stripped - see `util/RouteAccessUtils.ts`) holds
     * `action` on `mailboxUid`, by ownership or an explicit ACL grant. */
    private async requireMailboxAccess(mailboxUid: string, user: JWTUser | undefined, action: string): Promise<void> {
        if (!mailboxUid || !(await this.aclUtils!.hasPermission(stripTrustedRoles(user, this.trustedRoles), mailboxUid, action))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    /** Loads the meeting `id` names, `404` if it doesn't exist, then enforces `requireMailboxAccess()` against its
     * `mailboxUid`. Used by every owner-side method that acts on a single existing meeting. */
    private async requireOwnedMeeting(id: string, user: JWTUser | undefined, action: string): Promise<VM> {
        const meeting: VM | undefined = await this.meetingRepo!.findOne(id, { ignoreACL: true });
        if (!meeting) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await this.requireMailboxAccess(meeting.mailboxUid, user, action);
        return meeting;
    }

    /** Pure shape/format validation of `create()`'s body - independent of any permission check, matching
     * `BaseBookingRoute.validateBook()`'s split between format checks (here) and business-rule checks (in the
     * handler itself, which needs a DB round trip this does not). */
    private validateCreateBody(body: CreateVideoMeetingBody | undefined): { mailboxUid: string; visibility: VideoMeetingVisibility } {
        if (typeof body?.mailboxUid !== "string" || !body.mailboxUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'mailboxUid' is required.");
        }
        if (typeof body.title !== "string" || !body.title.trim()) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'title' is required.");
        }
        if (body.title.trim().length > MAX_TITLE_LENGTH) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'title' must be at most ${MAX_TITLE_LENGTH} characters.`);
        }
        if (body.visibility !== VideoMeetingVisibility.PRIVATE && body.visibility !== VideoMeetingVisibility.PUBLIC) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'visibility' must be 'private' or 'public'.");
        }
        if (body.visibility === VideoMeetingVisibility.PRIVATE) {
            const invitees: { email?: string; displayName?: string }[] = body.invitees ?? [];
            if (!Array.isArray(invitees) || invitees.length === 0) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A private meeting requires at least one invitee.");
            }
            if (invitees.length > MAX_INVITEES) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A meeting may have at most ${MAX_INVITEES} invitees.`);
            }
            for (const invitee of invitees) {
                if (
                    typeof invitee?.email !== "string" ||
                    invitee.email.trim().length > MAX_EMAIL_LENGTH ||
                    !EMAIL_PATTERN.test(invitee.email.trim())
                ) {
                    throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Each invitee requires a valid 'email'.");
                }
                if (invitee.displayName != null && (typeof invitee.displayName !== "string" || invitee.displayName.length > MAX_DISPLAY_NAME_LENGTH)) {
                    throw new ApiError(
                        ApiErrors.INVALID_REQUEST,
                        400,
                        `'displayName' must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
                    );
                }
            }
        }
        return { mailboxUid: body.mailboxUid, visibility: body.visibility };
    }

    /** Parses a caller-supplied ISO timestamp, rejecting anything unparseable with a `400` - matches
     * `BaseBookingRoute.requireDate()`. `startTime`/`endTime` are optional, so this is only called when present. */
    private requireOptionalDate(value: string | undefined, fieldName: string): Date | undefined {
        if (value === undefined) {
            return undefined;
        }
        const parsed: Date = new Date(value);
        if (isNaN(parsed.valueOf())) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${fieldName}' must be a valid ISO 8601 date/time.`);
        }
        return parsed;
    }

    /**
     * Writes the `VideoMeeting`/`VideoMeetingInvitee` rows for a new meeting. `@Transactional()` (resolving its
     * datasource from the `@Model(...)` on the concrete subclass, via the `modelClass` getter above) makes every
     * write atomic, matching `BaseBookingRoute.persistBooking()`'s identical reasoning.
     */
    @Transactional()
    protected async persistMeeting(
        mailboxUid: string,
        body: CreateVideoMeetingBody,
        visibility: VideoMeetingVisibility,
        startTime: Date | undefined,
        endTime: Date | undefined,
        user: JWTUser | undefined,
    ): Promise<{ meeting: VM; invitees: VMI[] }> {
        const strippedUser: JWTUser | undefined = stripTrustedRoles(user, this.trustedRoles);
        const publicSlug: string | undefined = visibility === VideoMeetingVisibility.PUBLIC ? mintPublicSlug() : undefined;
        // The organizer is deliberately never one of their own private meeting's `invitees` (see
        // `VideoMeeting.organizerSlug`), so a private meeting also mints the one slug that resolves to it for them.
        // Same mint function - and so the same shape/entropy - as `publicSlug`: the two live in separate columns, so
        // the only collision namespace either shares is its own, exactly as in Phase 1.
        const organizerSlug: string | undefined = visibility === VideoMeetingVisibility.PRIVATE ? mintPublicSlug() : undefined;

        // Constructed before `create()` is called (rather than inline) because its own, already-generated `uid`
        // (every `BaseEntity` mints one on construction) is what `acl.uid` below claims the meeting's own
        // per-record ACL under - mirroring `BaseFolderRoute.create()`'s identical `acl: { uid: instance.uid, ... }`
        // pattern exactly.
        const instance: VM = new this.meetingClass({
            mailboxUid,
            title: body.title!.trim(),
            visibility,
            calendarEventUid: body.calendarEventUid?.trim() || undefined,
            status: VideoMeetingStatus.SCHEDULED,
            startTime,
            endTime,
            publicSlug,
            organizerSlug,
        });
        const meeting: VM = await this.meetingRepo!.create(instance, {
            user: strippedUser,
            ignoreACL: true,
            acl: { uid: instance.uid, parentUid: mailboxUid, records: [] },
        });

        const invitees: VMI[] = [];
        if (visibility === VideoMeetingVisibility.PRIVATE) {
            // `validateCreateBody()` already guarantees a non-empty array here for a private meeting.
            for (const raw of body.invitees!) {
                invitees.push(
                    await this.inviteeRepo!.create(
                        new this.inviteeClass({
                            meetingUid: meeting.uid,
                            mailboxUid,
                            email: raw.email!.trim().toLowerCase(),
                            displayName: raw.displayName?.trim() || undefined,
                            joinToken: mintJoinToken(),
                        }),
                        { user: strippedUser, ignoreACL: true },
                    ),
                );
            }

            // The meeting's calendar event is invited by `MeetingSchedulingJob`, which gives each attendee their own
            // `LOCATION`/body link from the `CalendarEventAttendeeLink` rows written for that event here - without
            // them every invitee only receives the event's shared placeholder location, never a working join link.
            // Written in this same transaction, so a meeting never exists without the links its invite needs.
            if (meeting.calendarEventUid) {
                for (const invitee of invitees) {
                    const url: string | undefined = this.joinUrl(invitee.joinToken);
                    if (url) {
                        await this.attendeeLinkRepo!.create(
                            new this.attendeeLinkClass({
                                mailboxUid,
                                calendarEventUid: meeting.calendarEventUid,
                                attendeeAddress: invitee.email,
                                url,
                                label: ATTENDEE_LINK_LABEL,
                            }),
                            { user: strippedUser, ignoreACL: true },
                        );
                    }
                }
            }
        }
        return { meeting, invitees };
    }

    /**
     * Deletes the `CalendarEventAttendeeLink` rows `persistMeeting()` wrote for `meeting`'s invitees, so a
     * cancelled or deleted meeting's calendar event never keeps handing out join links to it. A row belongs to this
     * meeting when it is for the meeting's own event and its `url` ends in one of `invitees`' own join tokens - the
     * tokens (unlike the addresses, or the configured base URL, which may since have changed) name exactly this
     * meeting's rows, so another meeting sharing the same event is never touched. A no-op for a meeting with no
     * `calendarEventUid` (it never had any).
     */
    private async deleteAttendeeLinks(meeting: VM, invitees: VMI[], user: JWTUser | undefined): Promise<void> {
        if (!meeting.calendarEventUid) {
            return;
        }
        const links: CalendarEventAttendeeLink[] = await this.attendeeLinkRepo!.find(
            { mailboxUid: ModelUtils.literal(meeting.mailboxUid), calendarEventUid: ModelUtils.literal(meeting.calendarEventUid) } as any,
            { ignoreACL: true, skipCache: true },
        );
        for (const link of links) {
            if (invitees.some((invitee) => link.url.endsWith(`/${invitee.joinToken}`))) {
                await this.attendeeLinkRepo!.delete(link.uid, { user, ignoreACL: true });
            }
        }
    }

    /** The meeting's own invitees. */
    private async findInvitees(meeting: VM): Promise<VMI[]> {
        return await this.inviteeRepo!.find({ meetingUid: ModelUtils.literal(meeting.uid) } as any, { ignoreACL: true });
    }

    /** The join URL for a token/slug, or `undefined` when no public URL is configured - see this class's doc
     * comment on `mail:videoconf:public_url`. */
    private joinUrl(tokenOrSlug: string): string | undefined {
        const base: string | undefined = buildBaseUrl(this.publicUrl);
        return base ? `${base}/${tokenOrSlug}` : undefined;
    }

    @Summary("Creates a video meeting.")
    @Description(
        "Creates a video meeting owned by the given mailbox. A 'private' meeting requires at least one invitee, " +
            "each minted their own join link; a 'public' meeting mints a single shareable join link. Requires " +
            "CREATE on the owning mailbox.",
    )
    @Post()
    public async create(
        rawBody: CreateVideoMeetingBody | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<VideoMeetingCreateResult<VM>> {
        await this.init();
        const { mailboxUid, visibility } = this.validateCreateBody(rawBody);
        const body: CreateVideoMeetingBody = rawBody!;
        const startTime: Date | undefined = this.requireOptionalDate(body.startTime, "startTime");
        const endTime: Date | undefined = this.requireOptionalDate(body.endTime, "endTime");
        await this.requireMailboxAccess(mailboxUid, user, ACLAction.CREATE);

        const { meeting, invitees } = await this.persistMeeting(mailboxUid, body, visibility, startTime, endTime, user);

        const result: VideoMeetingCreateResult<VM> = { meeting };
        if (visibility === VideoMeetingVisibility.PRIVATE) {
            result.invitees = invitees.map((invitee) => ({
                uid: invitee.uid,
                email: invitee.email,
                displayName: invitee.displayName,
                joinUrl: this.joinUrl(invitee.joinToken),
            }));
        } else {
            // `persistMeeting()` always mints `publicSlug` for a public meeting.
            result.publicJoinUrl = this.joinUrl(meeting.publicSlug!);
        }
        if (meeting.organizerSlug) {
            result.organizerJoinUrl = this.joinUrl(meeting.organizerSlug);
        }
        return result;
    }

    /**
     * Adds `organizerJoinUrl`/`publicJoinUrl` (see `joinUrl()`) to a persisted meeting for a caller re-reading it
     * later. `create()`'s own response computes the same links inline from values it just minted, but `find()`/
     * `findById()` load the plain persisted entity, which carries only the slugs themselves - so a caller who
     * didn't keep `create()`'s one-time response (e.g. this plugin's own settings page, reloaded after the meeting
     * that IS a user's "personal room" - see `.claude/NOTES.md`'s Phase 4 entry - was created in an earlier visit)
     * would otherwise have no way to recover a public meeting's shareable link, or a private meeting's organizer
     * link, at all. Spreads rather than mutates: the loaded instance is the repo's own entity, and both fields are
     * response-only.
     */
    private withJoinUrls<T extends VM>(meeting: T): T & { organizerJoinUrl?: string; publicJoinUrl?: string } {
        const result: T & { organizerJoinUrl?: string; publicJoinUrl?: string } = { ...meeting };
        if (meeting.organizerSlug) {
            result.organizerJoinUrl = this.joinUrl(meeting.organizerSlug);
        }
        if (meeting.publicSlug) {
            result.publicJoinUrl = this.joinUrl(meeting.publicSlug);
        }
        return result;
    }

    @Summary("Lists the owner's video meetings.")
    @Description(
        "Returns the meetings owned by the given mailbox, each carrying 'organizerJoinUrl'/'publicJoinUrl' " +
            "exactly as findById() would for that meeting (see withJoinUrls()). Requires LIST on that mailbox.",
    )
    @Get()
    public async find(
        @Query("mailboxUid") mailboxUid: string | undefined,
        @Query("limit") limit: string | undefined,
        @Query("page") page: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<(VM & { organizerJoinUrl?: string; publicJoinUrl?: string })[]> {
        await this.init();
        if (typeof mailboxUid !== "string" || !mailboxUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        await this.requireMailboxAccess(mailboxUid, user, ACLAction.LIST);
        const parsedLimit: number | undefined = limit ? Number(limit) : undefined;
        const parsedPage: number | undefined = page ? Number(page) : undefined;
        // `limit`/`page` are passed both in the criteria (which the SQL query builder reads them from) and in
        // `options` (which the Mongo backend, and the ACL-filtered result trimming, read them from) - matching
        // every other paged `RepoUtils.find()` call in this codebase (e.g. `BaseBookingRoute.findAllEvents()`).
        const meetings: VM[] = await this.meetingRepo!.find(
            { mailboxUid: ModelUtils.literal(mailboxUid), limit: parsedLimit, page: parsedPage } as any,
            { ignoreACL: true, limit: parsedLimit, page: parsedPage },
        );
        return meetings.map((meeting) => this.withJoinUrls(meeting));
    }

    @Summary("Retrieves one of the owner's video meetings.")
    @Description(
        "Returns the meeting, plus 'organizerJoinUrl' when it has an organizerSlug (every private meeting this " +
            "route created) and/or 'publicJoinUrl' when it has a publicSlug - so a caller loading an existing " +
            "meeting later still gets a working link, not only the one create() returned once. Requires READ on " +
            "the meeting's owning mailbox.",
    )
    @Get("/:id")
    public async findById(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<VM & { organizerJoinUrl?: string; publicJoinUrl?: string }> {
        await this.init();
        const meeting: VM = await this.requireOwnedMeeting(id, user, ACLAction.READ);
        return this.withJoinUrls(meeting);
    }

    @Summary("Updates a video meeting's title, or cancels it.")
    @Description(
        "Deliberately minimal for Phase 1: only 'title' and cancellation ('status': 'cancelled') may be changed. " +
            "Requires UPDATE on the meeting's owning mailbox.",
    )
    @Put("/:id")
    public async update(
        @Param("id") id: string,
        body: { title?: string; status?: string } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<VM> {
        await this.init();
        const meeting: VM = await this.requireOwnedMeeting(id, user, ACLAction.UPDATE);
        const patch: Record<string, any> = { uid: meeting.uid, version: (meeting as any).version };
        if (body?.title !== undefined) {
            if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > MAX_TITLE_LENGTH) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'title' must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters.`);
            }
            patch.title = body.title.trim();
        }
        if (body?.status !== undefined) {
            if (body.status !== VideoMeetingStatus.CANCELLED) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'status' may only be set to 'cancelled'.");
            }
            patch.status = VideoMeetingStatus.CANCELLED;
        }
        if (patch.title === undefined && patch.status === undefined) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Nothing to update: supply 'title' and/or 'status'.");
        }
        const strippedUser: JWTUser | undefined = stripTrustedRoles(user, this.trustedRoles);
        const updated: VM = await this.meetingRepo!.update(patch as any, meeting, { user: strippedUser, ignoreACL: true });
        if (patch.status === VideoMeetingStatus.CANCELLED) {
            await this.deleteAttendeeLinks(meeting, await this.findInvitees(meeting), strippedUser);
        }
        return updated;
    }

    @Summary("Deletes a video meeting.")
    @Description(
        "Deletes the meeting, every one of its invitees and the calendar invite links written for them. Deleting the meeting also removes its own " +
            "per-record AccessControlList (RepoUtils.delete()'s standard recordACL cleanup - see the VideoMeeting " +
            "interface's doc comment), so its uid stops working as a push channel immediately. Requires DELETE on " +
            "the meeting's owning mailbox.",
    )
    @Delete("/:id")
    public async delete(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<void> {
        await this.init();
        const meeting: VM = await this.requireOwnedMeeting(id, user, ACLAction.DELETE);
        const strippedUser: JWTUser | undefined = stripTrustedRoles(user, this.trustedRoles);
        const invitees: VMI[] = await this.findInvitees(meeting);
        await this.deleteAttendeeLinks(meeting, invitees, strippedUser);
        for (const invitee of invitees) {
            await this.inviteeRepo!.delete(invitee.uid, { user: strippedUser, ignoreACL: true });
        }
        await this.meetingRepo!.delete(meeting.uid, { user: strippedUser, ignoreACL: true });
    }

    /**
     * Resolves `token` to the meeting it names, and to *how* it named it: an invitee's `joinToken` (43 base64url
     * characters - `JOIN_TOKEN_PATTERN`), or one of the two 11-character slugs (`PUBLIC_SLUG_PATTERN`) - a public
     * meeting's `publicSlug` or a private meeting's `organizerSlug`. The token and slug lengths never overlap (see
     * `util/TokenUtils.ts`), so an invitee token is never tried as a slug or vice versa - unlike trying both in
     * sequence, this can't accidentally treat one as the other just because the lookup that should have matched
     * happened to miss. A stale/unknown/malformed/wrongly-shaped token, a cancelled meeting, or a meeting whose
     * visibility no longer matches how the token was resolved (defense in depth - a meeting's `visibility` cannot
     * actually change after creation) all answer identically: a plain `404`, matching
     * `BaseBookingRoute.requireBookingByToken()`'s exact posture of never leaking whether a token almost-matched
     * something.
     *
     * The two slug columns are disjoint by construction (`persistMeeting()` mints `publicSlug` only for a public
     * meeting and `organizerSlug` only for a private one), so a slug-shaped token is looked up against `publicSlug`
     * first - exactly Phase 1's lookup, with exactly Phase 1's outcome whenever it matches a row at all - and only
     * a token that matches no `publicSlug` row is then looked up against `organizerSlug`.
     *
     * The resolution is returned alongside the meeting because `join()` authorizes the three cases differently: an
     * invitee token and a `publicSlug` are each a self-contained credential ("possession of the link"), while an
     * `organizerSlug` is not - see `join()`'s doc comment and `VideoMeeting.organizerSlug`.
     */
    private async requireMeetingByToken(token: string): Promise<{ meeting: VM; resolvedVia: VideoMeetingTokenResolution }> {
        /* v8 ignore if -- unreachable via real usage: `@Param("token")` always supplies a string (a URL path
           segment can't be anything else); this guards only a directly-invoked, non-HTTP call. */
        if (typeof token !== "string") {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (JOIN_TOKEN_PATTERN.test(token)) {
            const matches: VMI[] = await this.inviteeRepo!.find({ joinToken: ModelUtils.literal(token) } as any, {
                ignoreACL: true,
                limit: 1,
                skipCache: true,
            });
            const invitee: VMI | undefined = matches[0];
            if (!invitee) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            const meeting: VM | undefined = await this.meetingRepo!.findOne(invitee.meetingUid, { ignoreACL: true });
            if (!meeting || meeting.visibility !== VideoMeetingVisibility.PRIVATE || meeting.status === VideoMeetingStatus.CANCELLED) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            return { meeting, resolvedVia: "invitee" };
        }
        if (PUBLIC_SLUG_PATTERN.test(token)) {
            const publicMatches: VM[] = await this.meetingRepo!.find({ publicSlug: ModelUtils.literal(token) } as any, {
                ignoreACL: true,
                limit: 1,
                skipCache: true,
            });
            const publicMeeting: VM | undefined = publicMatches[0];
            if (publicMeeting) {
                if (publicMeeting.visibility !== VideoMeetingVisibility.PUBLIC || publicMeeting.status === VideoMeetingStatus.CANCELLED) {
                    throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
                }
                return { meeting: publicMeeting, resolvedVia: "publicSlug" };
            }
            const organizerMatches: VM[] = await this.meetingRepo!.find({ organizerSlug: ModelUtils.literal(token) } as any, {
                ignoreACL: true,
                limit: 1,
                skipCache: true,
            });
            const organizerMeeting: VM | undefined = organizerMatches[0];
            if (!organizerMeeting || organizerMeeting.visibility !== VideoMeetingVisibility.PRIVATE || organizerMeeting.status === VideoMeetingStatus.CANCELLED) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            return { meeting: organizerMeeting, resolvedVia: "organizerSlug" };
        }
        throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
    }

    /**
     * Adds an `ACLRecord` granting `uid` `READ`/`CREATE` on `meetingUid`'s own `AccessControlList`, unless one
     * already exists (idempotent - a retried/duplicate call for the same uid, guest or real, is a no-op). Retries a
     * handful of times on an optimistic-lock conflict (`saveACL()`'s version check): a public meeting can be joined
     * by several callers at once, each racing to add their own record to the very same ACL document, and a lost
     * race must be retried against the freshly re-read version rather than surfaced to the caller as an error.
     * Named generically (not `ensureGuestChannelGrant()`, its Phase 1 name) since `join()` now calls this for a
     * real, already-authenticated caller's own uid too - see this class's doc comment on "Real, already-
     * authenticated callers".
     */
    private async ensureChannelGrant(meetingUid: string, uid: string): Promise<void> {
        for (let attempt = 0; attempt < GUEST_GRANT_MAX_ATTEMPTS; attempt++) {
            const acl: AccessControlList | undefined = await this.aclUtils!.findACL(meetingUid, [], { skipCache: true, skipParents: true });
            /* v8 ignore if -- unreachable via real usage: the meeting's own per-record ACL is claimed at creation
               time (see `persistMeeting()`) and never removed except alongside the meeting itself (see `delete()`)
               - `requireMeetingByToken()` already proved the meeting still exists, so one is always found here. */
            if (!acl) {
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
            }
            if (acl.records.some((record) => record.userOrRoleId === uid)) {
                return;
            }
            acl.records.push({ userOrRoleId: uid, actions: [ACLAction.READ, ACLAction.CREATE] });
            try {
                await this.aclUtils!.saveACL(acl);
                return;
            } catch (err: any) {
                if (attempt === GUEST_GRANT_MAX_ATTEMPTS - 1 || !/must be of the same version/.test(err?.message ?? "")) {
                    throw err;
                }
                // A concurrent joiner (or the owner, editing the meeting's own ACL directly) saved first - loop
                // around and retry against the freshly re-read version.
            }
        }
    }

    /**
     * Mints a short-lived, scope-limited guest identity - see this class's doc comment on the channel-ACL-grant
     * mechanism. Only called for the true-anonymous case (`join()`'s `user` is absent, or presents a prior guest
     * uid rather than a real one). The deployment's real `auth` config normally carries its own `options.expiresIn`
     * (every other token's session length), which `jsonwebtoken` refuses to combine with an explicit `exp` claim in
     * the payload ("Bad 'options.expiresIn' option the payload already has an 'exp' property") - so this signs with
     * a shallow copy of `authConfig` that omits `options.expiresIn`, letting the payload's own `exp` (this guest
     * token's own, shorter `GUEST_JWT_TTL_SECONDS` lifetime) govern instead. Everything else about `authConfig` -
     * the secret, the algorithm, `audience`/`issuer` - is unchanged, so this guest token verifies through the exact
     * same `JWTStrategy` every other token does.
     */
    private mintGuestToken(): { guestUid: string; token: string; expiresAt: Date } {
        const guestUid: string = `${GUEST_UID_PREFIX}${crypto.randomBytes(16).toString("base64url")}`;
        const expiresAt: Date = new Date(Date.now() + GUEST_JWT_TTL_SECONDS * 1000);
        const { expiresIn: _expiresIn, ...guestOptions } = this.authConfig?.options ?? {};
        const guestAuthConfig: any = { ...this.authConfig, options: guestOptions };
        const token: string = JWTUtils.createTokenSync(
            guestAuthConfig,
            { uid: guestUid, roles: [], scopes: [] },
            { sessionUid: crypto.randomUUID(), exp: Math.floor(expiresAt.getTime() / 1000) },
        );
        return { guestUid, token, expiresAt };
    }

    /** The host mailbox's `displayName`, or `undefined` when the mailbox has none (or no longer exists - an
     * orphaned meeting should still be joinable, just without a host name to show). */
    private async hostDisplayName(mailboxUid: string): Promise<string | undefined> {
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
        return mailbox?.displayName || undefined;
    }

    @Summary("Joins a video meeting.")
    @Description(
        "Resolves an invitee's join token or a public meeting's slug. If the caller already presents a valid " +
            "session for a real RapidMX identity (not a returning guest), that identity is granted READ/CREATE " +
            "on the meeting's own push channel directly and the response carries 'authenticated: true' with no " +
            "guest token at all - the caller's own existing session cookie/header already authenticates /push " +
            "for them. Otherwise (the common anonymous case) mints a short-lived guest JWT (see " +
            "GUEST_JWT_TTL_SECONDS) already granted READ/CREATE on the same channel, ready to use against /push " +
            "to exchange WebRTC signaling messages. Requires no authentication beyond the token itself; a " +
            "stale/unknown token answers 404. The one exception is a private meeting's organizerSlug, which is " +
            "never an anonymous surface: it additionally requires an already-authenticated caller holding READ on " +
            "the meeting's owning mailbox, and answers the very same 404 for anyone else.",
    )
    @RateLimit()
    @Get("/join/:token")
    public async join(@Param("token") token: string, @AuthUser user?: JWTUser): Promise<VideoMeetingJoinResult> {
        await this.init();
        const { meeting, resolvedVia } = await this.requireMeetingByToken(token);

        // An `organizerSlug` is not a credential of its own (unlike an invitee `joinToken` or a `publicSlug`): it
        // only exists so the owner of a private meeting has something that resolves to it at all, since they are
        // deliberately never one of its invitees. So it is gated here on BOTH conditions, before anything about
        // the meeting is computed or returned: a real, already-authenticated identity (the same non-guest check
        // the authenticated branch below uses - a returning guest presenting a prior join()'s guest JWT is not
        // one), AND that identity actually holding READ on this meeting's own mailbox, with its trusted roles
        // stripped first exactly as `requireMailboxAccess()` does. A failure answers the bare 404
        // `requireMeetingByToken()` already throws for a token that matched nothing whatsoever - deliberately NOT
        // `requireMailboxAccess()`'s 403, which would tell an anonymous prober that this slug named a real meeting.
        // Nothing here changes how an invitee token or a publicSlug resolves.
        if (resolvedVia === "organizerSlug") {
            const isRealCaller: boolean = !!user && !user.uid.startsWith(GUEST_UID_PREFIX);
            if (!isRealCaller || !(await this.aclUtils!.hasPermission(stripTrustedRoles(user, this.trustedRoles), meeting.mailboxUid, ACLAction.READ))) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
        }

        const publicMeeting: PublicVideoMeeting = {
            uid: meeting.uid,
            title: meeting.title,
            visibility: meeting.visibility,
            status: meeting.status,
            hostDisplayName: await this.hostDisplayName(meeting.mailboxUid),
        };
        const iceServers: IceServerConfig[] = buildIceServers({
            url: this.turnUrl,
            username: this.turnUsername,
            credential: this.turnCredential,
            sharedSecret: this.turnSharedSecret,
        });

        // A real, already-authenticated RapidMX identity - never a guest uid from an earlier join() call
        // presenting its own guest JWT back (a guest uid is never a valid mailbox-owning identity anyway, so this
        // prefix check is a safe, cheap discriminator - see this class's doc comment and GUEST_UID_PREFIX).
        if (user && !user.uid.startsWith(GUEST_UID_PREFIX)) {
            await this.ensureChannelGrant(meeting.uid, user.uid);
            return { meeting: publicMeeting, iceServers, authenticated: true, selfUid: user.uid };
        }

        const { guestUid, token: guestToken, expiresAt } = this.mintGuestToken();
        await this.ensureChannelGrant(meeting.uid, guestUid);
        return {
            meeting: publicMeeting,
            iceServers,
            authenticated: false,
            selfUid: guestUid,
            token: guestToken,
            expiresAt: expiresAt.toISOString(),
        };
    }
}
