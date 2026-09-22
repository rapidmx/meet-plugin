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
import { Mailbox } from "@rapidmx/restapi";
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

/** How many times `ensureGuestChannelGrant()` retries an optimistic-lock conflict on the meeting's own ACL before
 * giving up - see that method's doc comment. */
const GUEST_GRANT_MAX_ATTEMPTS = 5;

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
}

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

/** `join()`'s response. */
export interface VideoMeetingJoinResult {
    meeting: PublicVideoMeeting;
    iceServers: IceServerConfig[];
    /** A short-lived guest JWT, immediately usable against `/push` to subscribe to and publish on
     * `meeting.uid` - and nothing else. See this class's doc comment. */
    token: string;
    /** The synthetic identity `token` authenticates as (`guest:<random>`) - included mainly for diagnostics /
     * tests; a caller has no independent use for it beyond what `token` already grants. */
    guestUid: string;
    /** ISO 8601 instant `token` expires at. */
    expiresAt: string;
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
 * ## The guest-JWT-to-push-channel-ACL-grant mechanism
 *
 * An anonymous guest holds no `AccessControlList` grant of their own and has no `JWTUser` to authenticate `/push`
 * with in the first place - `join()` therefore does two things together: it mints a short-lived, scope-limited
 * guest JWT (`mintGuestToken()`: a synthetic `guest:<random>` uid, no roles, `GUEST_JWT_TTL_SECONDS` expiry, real and
 * verifiable since it's signed with the same `auth` config every other token is), and it adds an explicit
 * `ACLRecord` for that exact uid onto the meeting's own `AccessControlList` (`ensureGuestChannelGrant()`), granting
 * `READ` (so `BasePushRoute`'s SUBSCRIBE succeeds) and `CREATE` (so a publish does - see `MailPushRoute`'s doc
 * comment: "publishing to a channel needs CREATE on it as an ordinary user would"). The grant is scoped to exactly
 * that one meeting's uid, nothing else - the same "possession of a link is the credential" pattern
 * `BaseBookingRoute.requireBookingByToken()`/`resolveEffectiveUser()`'s `share:<token>` identity already establish
 * elsewhere in this codebase, extended one step further because signaling needs a channel *subscription*, not just
 * a stateless REST call.
 *
 * **Known limitation, documented rather than silently assumed away**: because each `join()` call mints a *fresh*
 * random guest uid (so simultaneous participants of one shared link are distinguishable from each other in the
 * signaling channel), each join adds one more `ACLRecord` to the meeting's own ACL document, and nothing in Phase 1
 * ever removes one. A meeting joined many times over its lifetime accumulates unused records; there is no GC job,
 * matching this codebase's own precedent for `Booking.manageToken` (documented as never expiring, no GC job either).
 * Since the guest JWTs themselves expire, an accumulated record is inert (unusable) well before it becomes a real
 * concern - a cleanup pass is a reasonable thing for a later phase to add, not a Phase 1 requirement.
 *
 * ## Other known limitations
 *
 * **`VideoMeetingInvitee.joinToken` never expires** and has no GC job - identical tradeoff to `Booking.manageToken`.
 *
 * **`VideoMeeting.publicSlug` is only uniqueness-checked within its own mailbox** by the database, while `join()`'s
 * lookup is global (the public join URL carries no mailbox segment) - see the `VideoMeeting.publicSlug` doc comment
 * for the full reasoning; a cross-mailbox collision is not actually prevented, only made astronomically unlikely by
 * the slug's own entropy.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseVideoMeetingRoute<VM extends VideoMeeting, VMI extends VideoMeetingInvitee, M extends Mailbox> {
    protected abstract meetingClass: any;
    protected abstract inviteeClass: any;
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private meetingRepo?: RepoUtils<VM>;
    private inviteeRepo?: RepoUtils<VMI>;
    private mailboxRepo?: RepoUtils<M>;

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
        }
        return { meeting, invitees };
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
        return result;
    }

    @Summary("Lists the owner's video meetings.")
    @Description("Returns the meetings owned by the given mailbox. Requires LIST on that mailbox.")
    @Get()
    public async find(
        @Query("mailboxUid") mailboxUid: string | undefined,
        @Query("limit") limit: string | undefined,
        @Query("page") page: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<VM[]> {
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
        return await this.meetingRepo!.find(
            { mailboxUid: ModelUtils.literal(mailboxUid), limit: parsedLimit, page: parsedPage } as any,
            { ignoreACL: true, limit: parsedLimit, page: parsedPage },
        );
    }

    @Summary("Retrieves one of the owner's video meetings.")
    @Description("Requires READ on the meeting's owning mailbox.")
    @Get("/:id")
    public async findById(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<VM> {
        await this.init();
        return await this.requireOwnedMeeting(id, user, ACLAction.READ);
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
        return await this.meetingRepo!.update(patch as any, meeting, { user: stripTrustedRoles(user, this.trustedRoles), ignoreACL: true });
    }

    @Summary("Deletes a video meeting.")
    @Description(
        "Deletes the meeting and every one of its invitees. Deleting the meeting also removes its own " +
            "per-record AccessControlList (RepoUtils.delete()'s standard recordACL cleanup - see the VideoMeeting " +
            "interface's doc comment), so its uid stops working as a push channel immediately. Requires DELETE on " +
            "the meeting's owning mailbox.",
    )
    @Delete("/:id")
    public async delete(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<void> {
        await this.init();
        const meeting: VM = await this.requireOwnedMeeting(id, user, ACLAction.DELETE);
        const strippedUser: JWTUser | undefined = stripTrustedRoles(user, this.trustedRoles);
        const invitees: VMI[] = await this.inviteeRepo!.find({ meetingUid: ModelUtils.literal(meeting.uid) } as any, { ignoreACL: true });
        for (const invitee of invitees) {
            await this.inviteeRepo!.delete(invitee.uid, { user: strippedUser, ignoreACL: true });
        }
        await this.meetingRepo!.delete(meeting.uid, { user: strippedUser, ignoreACL: true });
    }

    /**
     * Resolves `token` to the meeting it names: an invitee's `joinToken` (43 base64url characters -
     * `JOIN_TOKEN_PATTERN`) or a public meeting's `publicSlug` (11 base64url characters - `PUBLIC_SLUG_PATTERN`).
     * The two lengths never overlap (see `util/TokenUtils.ts`), so exactly one lookup is ever attempted - unlike
     * trying both in sequence, this can't accidentally treat an invitee token as a slug (or vice versa) just
     * because the other lookup happened to also miss. A stale/unknown/malformed/wrongly-shaped token, a cancelled
     * meeting, or a meeting whose visibility no longer matches how the token was resolved (defense in depth - a
     * meeting's `visibility` cannot actually change after creation in Phase 1) all answer identically: a plain
     * `404`, matching `BaseBookingRoute.requireBookingByToken()`'s exact posture of never leaking whether a token
     * almost-matched something.
     */
    private async requireMeetingByToken(token: string): Promise<VM> {
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
            return meeting;
        }
        if (PUBLIC_SLUG_PATTERN.test(token)) {
            const matches: VM[] = await this.meetingRepo!.find({ publicSlug: ModelUtils.literal(token) } as any, {
                ignoreACL: true,
                limit: 1,
                skipCache: true,
            });
            const meeting: VM | undefined = matches[0];
            if (!meeting || meeting.visibility !== VideoMeetingVisibility.PUBLIC || meeting.status === VideoMeetingStatus.CANCELLED) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            return meeting;
        }
        throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
    }

    /**
     * Adds an `ACLRecord` granting `guestUid` `READ`/`CREATE` on `meetingUid`'s own `AccessControlList`, unless one
     * already exists (idempotent - a retried/duplicate call for the same guest is a no-op). Retries a handful of
     * times on an optimistic-lock conflict (`saveACL()`'s version check): a public meeting can be joined by several
     * guests at once, each racing to add their own record to the very same ACL document, and a lost race must be
     * retried against the freshly re-read version rather than surfaced to the guest as an error.
     */
    private async ensureGuestChannelGrant(meetingUid: string, guestUid: string): Promise<void> {
        for (let attempt = 0; attempt < GUEST_GRANT_MAX_ATTEMPTS; attempt++) {
            const acl: AccessControlList | undefined = await this.aclUtils!.findACL(meetingUid, [], { skipCache: true, skipParents: true });
            /* v8 ignore if -- unreachable via real usage: the meeting's own per-record ACL is claimed at creation
               time (see `persistMeeting()`) and never removed except alongside the meeting itself (see `delete()`)
               - `requireMeetingByToken()` already proved the meeting still exists, so one is always found here. */
            if (!acl) {
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
            }
            if (acl.records.some((record) => record.userOrRoleId === guestUid)) {
                return;
            }
            acl.records.push({ userOrRoleId: guestUid, actions: [ACLAction.READ, ACLAction.CREATE] });
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
     * Mints a short-lived, scope-limited guest identity - see this class's doc comment on the guest-JWT-to-
     * push-channel-ACL-grant mechanism. The deployment's real `auth` config normally carries its own
     * `options.expiresIn` (every other token's session length), which `jsonwebtoken` refuses to combine with an
     * explicit `exp` claim in the payload ("Bad 'options.expiresIn' option the payload already has an 'exp'
     * property") - so this signs with a shallow copy of `authConfig` that omits `options.expiresIn`, letting the
     * payload's own `exp` (this guest token's own, shorter `GUEST_JWT_TTL_SECONDS` lifetime) govern instead.
     * Everything else about `authConfig` - the secret, the algorithm, `audience`/`issuer` - is unchanged, so this
     * guest token verifies through the exact same `JWTStrategy` every other token does.
     */
    private mintGuestToken(): { guestUid: string; token: string; expiresAt: Date } {
        const guestUid: string = `guest:${crypto.randomBytes(16).toString("base64url")}`;
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

    @Summary("Joins a video meeting anonymously.")
    @Description(
        "Resolves an invitee's join token or a public meeting's slug, and mints a short-lived guest JWT (see " +
            "GUEST_JWT_TTL_SECONDS) already granted READ/CREATE on the meeting's own push channel, ready to use " +
            "against /push to exchange WebRTC signaling messages. Requires no authentication beyond the token " +
            "itself; a stale/unknown token answers 404.",
    )
    @RateLimit()
    @Get("/join/:token")
    public async join(@Param("token") token: string): Promise<VideoMeetingJoinResult> {
        await this.init();
        const meeting: VM = await this.requireMeetingByToken(token);
        const { guestUid, token: guestToken, expiresAt } = this.mintGuestToken();
        await this.ensureGuestChannelGrant(meeting.uid, guestUid);
        return {
            meeting: {
                uid: meeting.uid,
                title: meeting.title,
                visibility: meeting.visibility,
                status: meeting.status,
                hostDisplayName: await this.hostDisplayName(meeting.mailboxUid),
            },
            iceServers: buildIceServers({
                url: this.turnUrl,
                username: this.turnUsername,
                credential: this.turnCredential,
                sharedSecret: this.turnSharedSecret,
            }),
            token: guestToken,
            guestUid,
            expiresAt: expiresAt.toISOString(),
        };
    }
}
