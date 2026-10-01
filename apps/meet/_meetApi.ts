///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed client for this plugin's one public, unauthenticated endpoint - `GET /api/mail/video-meetings/join/:token`
 * (`BaseVideoMeetingRoute.join()`) - mirroring `booking-plugin`'s own `apps/shared/bookingApi.ts` convention of
 * redefining the response shape locally rather than importing it from `../../src/...`: `apps/` compiles under its
 * own `tsconfig.apps.json` (bundler resolution, DOM-facing), independent of the backend's `tsconfig.json` (NodeNext),
 * and every other plugin app in this codebase keeps that boundary the same way.
 */
import { apiFetch } from "@rapidmx/web-client/lib/util/api.js";

export type VideoMeetingVisibility = "private" | "public";
export type VideoMeetingStatus = "scheduled" | "active" | "ended" | "cancelled";

/** Mirrors `BaseVideoMeetingRoute.ts`'s `IceServerConfig` - already the exact shape `RTCPeerConnection`'s
 * `iceServers` constructor option expects, passed straight through with no reshaping. */
export interface IceServerConfig {
    urls: string | string[];
    username?: string;
    credential?: string;
}

/** Mirrors `BaseVideoMeetingRoute.ts`'s `PublicVideoMeeting`. */
export interface PublicVideoMeeting {
    uid: string;
    title: string;
    visibility: VideoMeetingVisibility;
    status: VideoMeetingStatus;
    hostDisplayName?: string;
    /** The account uid that owns the meeting - the sole source of a "host" identity on the client. Absent when the
     * server can't resolve one (an orphaned mailbox, or a server that predates this field), in which case no host
     * controls are shown to anyone. */
    hostUid?: string;
    /** When `true`, a joining participant's microphone starts muted - see `useLocalMedia`'s `forceMuteOnJoin`
     * option, which this is threaded into. Absent reads as `false`. */
    forceMuteOnJoin?: boolean;
    /** Whether this meeting currently requires a password - never the password or its hash, just whether one is
     * set. Absent reads as `false`. */
    hasPassword?: boolean;
    /** Whether this meeting currently requires the host to admit each participant before they join - see
     * `requestAdmission()`. Absent reads as `false`. */
    waitingRoomEnabled?: boolean;
}

/**
 * Mirrors `BaseVideoMeetingRoute.ts`'s `VideoMeetingJoinResult`. `authenticated: true` means the visiting browser
 * already held a valid session for a real RapidMX identity when it called `join()` - `token`/`expiresAt` are then
 * omitted entirely (there is no guest token to hand over), and the caller (`[token].tsx`) must not write any
 * cookie of its own before connecting to `/push`: the browser's own already-existing `jwt` session cookie already
 * authenticates it there, with zero new client-side auth handling. `authenticated: false` (the common anonymous
 * case) is unchanged from Phase 1: `token`/`expiresAt` are present, and `GuestSignalingClient` applies `token` as a
 * cookie before connecting.
 */
export interface VideoMeetingJoinResult {
    meeting: PublicVideoMeeting;
    iceServers: IceServerConfig[];
    authenticated: boolean;
    /** The identity to identify as on the signaling channel/mesh - the caller's own real uid when `authenticated`
     * is `true`, otherwise a freshly minted synthetic `guest:<random>` uid. Always present. */
    selfUid: string;
    /** A short-lived guest JWT, usable against `/push`. Present only when `authenticated` is `false`. */
    token?: string;
    /** ISO 8601 instant `token` expires at. Present only when `authenticated` is `false`. */
    expiresAt?: string;
    /** Whether the server offers the WebSocket media relay - the last-resort path for a participant neither a direct
     * connection nor the TURN server can reach. Absent from a server that predates it, which reads as off. */
    relayEnabled?: boolean;
    /** The base URL the video filters' machine-learning runtime and models are hosted under, when the administrator
     * hosts them (`mail:videoconf:effects:assets_url`). Absent means the public CDN defaults. */
    effectsAssetsUrl?: string;
}

/** Mirrors `BaseVideoMeetingRoute.ts`'s `VideoMeetingPasswordRequiredResult` - returned by `joinMeeting()` in place
 * of a `VideoMeetingJoinResult` when the meeting requires a password that hasn't been submitted yet. Carries only
 * enough to show a password prompt (the meeting's title/host); nothing here grants anything. Narrow on
 * `"requiresPassword" in result && result.requiresPassword`. */
export interface VideoMeetingPasswordRequiredResult {
    meeting: PublicVideoMeeting;
    requiresPassword: true;
}

/** Mirrors `BaseVideoMeetingRoute.ts`'s `VideoMeetingAdmissionRequiredResult` - returned by `requestAdmission()`
 * (and re-returned by `pollAdmission()`) while a `waitingRoomEnabled` meeting's admission request is still
 * pending. Unlike `VideoMeetingPasswordRequiredResult`, this carries `selfUid` (and, for a guest, `token`) - a
 * caller needs a stable, authenticated identity to poll with. `joinMeeting()` itself also answers this shape, with
 * none of those fields, when a waiting room applies and no request has been filed yet. Narrow on
 * `"requiresAdmission" in result`. */
export interface VideoMeetingAdmissionRequiredResult {
    meeting: PublicVideoMeeting;
    requiresAdmission: true;
    authenticated?: boolean;
    selfUid?: string;
    token?: string;
    expiresAt?: string;
}

/** `joinMeeting()`'s actual return type - see `VideoMeetingPasswordRequiredResult`'s and
 * `VideoMeetingAdmissionRequiredResult`'s own doc comments. */
export type VideoMeetingJoinResponse = VideoMeetingJoinResult | VideoMeetingPasswordRequiredResult | VideoMeetingAdmissionRequiredResult;

/** Resolves a join token (an invitee's own link) or a public meeting's slug to its meeting info, ICE servers, and
 * either a short-lived guest signaling token (the common anonymous case) or confirmation that the caller's own
 * existing session already grants them signaling access (`authenticated: true` - see
 * `VideoMeetingJoinResult`'s doc comment) - see `BaseVideoMeetingRoute.join()`'s own doc comment. Rejects with
 * `ApiRequestError` (status `404`) for a stale/unknown/malformed token, cancelled meeting, or the wrong
 * private/public token shape for what it's being used against - the caller (`[token].tsx`) shows a single,
 * friendly "this meeting link isn't valid" state for all of those rather than trying to distinguish them, matching
 * `BaseVideoMeetingRoute.requireMeetingByToken()`'s own explicit "never leak which almost-matched" posture. */
export function joinMeeting(token: string): Promise<VideoMeetingJoinResponse> {
    return apiFetch(`/mail/video-meetings/join/${encodeURIComponent(token)}`);
}

/** Submits a password for a meeting `joinMeeting()` reported `requiresPassword` for. On success, returns an
 * ordinary granted `VideoMeetingJoinResult` - the same shape and same meaning as `joinMeeting()`'s own non-password
 * case. Rejects with `ApiRequestError` (status `403`) for a wrong or missing password. */
export function verifyMeetingPassword(token: string, password: string): Promise<VideoMeetingJoinResult> {
    return apiFetch(`/mail/video-meetings/join/${encodeURIComponent(token)}/verify`, {
        method: "POST",
        body: JSON.stringify({ password }),
    });
}

/** Sets, replaces, or removes (`password: null`) the meeting's join password - host only, enforced the same way
 * as every other owner-side video-meeting update. Hashed server-side; the plaintext is never stored or returned. */
export function setMeetingPassword(meetingUid: string, password: string | null): Promise<void> {
    return apiFetch(`/mail/video-meetings/${encodeURIComponent(meetingUid)}`, {
        method: "PUT",
        body: JSON.stringify({ password }),
    });
}

/** Files an admission request for a meeting `joinMeeting()` reported `requiresAdmission` for - `password` only
 * when `meeting.hasPassword` is also set (both are checked together on this one call, never in two steps). On
 * success returns `VideoMeetingAdmissionRequiredResult` with a `selfUid` (and, for a guest, `token`) to poll with
 * via `pollAdmission()` - nothing is granted yet. Rejects with `ApiRequestError` (status `403`) for a wrong
 * password, or `400` if `meeting.hasPassword` and no password was given. */
export function requestAdmission(token: string, body: { name: string; password?: string }): Promise<VideoMeetingAdmissionRequiredResult> {
    return apiFetch(`/mail/video-meetings/join/${encodeURIComponent(token)}/verify`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

/** Polls whether the host has responded to a pending admission request - authenticated as whichever identity
 * `requestAdmission()` (or a previous poll) returned: `guestToken`, when given, is sent as an `Authorization`
 * header (a guest has no session cookie of their own); omitted for an already-authenticated real caller, whose
 * existing session cookie already identifies them. Resolves to a granted `VideoMeetingJoinResult` once admitted,
 * or re-resolves to `VideoMeetingAdmissionRequiredResult` while still pending. Rejects with `ApiRequestError`
 * (status `403`) once denied, or `404` if this identity never requested admission (or already polled past a final
 * answer). */
export function pollAdmission(token: string, guestToken?: string): Promise<VideoMeetingJoinResult | VideoMeetingAdmissionRequiredResult> {
    return apiFetch(`/mail/video-meetings/join/${encodeURIComponent(token)}/status`, {
        headers: guestToken ? { Authorization: `jwt ${guestToken}` } : undefined,
    });
}

/** One pending admission request, as `listWaitingParticipants()` returns it. */
export interface WaitingParticipant {
    uid: string;
    name: string;
    requestedAt: string;
}

/** Lists a meeting's pending admission requests, oldest first - host only. */
export function listWaitingParticipants(meetingUid: string): Promise<WaitingParticipant[]> {
    return apiFetch(`/mail/video-meetings/${encodeURIComponent(meetingUid)}/waiting`);
}

/** Admits a pending admission request - host only. The requester's own next `pollAdmission()` call completes
 * their join; this alone does not notify them of anything. A no-op if `uid` has no pending request. */
export function admitParticipant(meetingUid: string, uid: string): Promise<void> {
    return apiFetch(`/mail/video-meetings/${encodeURIComponent(meetingUid)}/admit/${encodeURIComponent(uid)}`, { method: "POST" });
}

/** Denies a pending admission request - host only. The requester's own next `pollAdmission()` call then rejects
 * with a 403. A no-op if `uid` has no pending request. */
export function denyParticipant(meetingUid: string, uid: string): Promise<void> {
    return apiFetch(`/mail/video-meetings/${encodeURIComponent(meetingUid)}/deny/${encodeURIComponent(uid)}`, { method: "POST" });
}

/** Sets whether the meeting requires the host to admit each participant (`PublicVideoMeeting.waitingRoomEnabled`) -
 * host only, enforced the same way as every other owner-side video-meeting update. Takes effect for anyone who
 * joins (or reloads the join link and joins again) after this call resolves. */
export function setWaitingRoomEnabled(meetingUid: string, waitingRoomEnabled: boolean): Promise<void> {
    return apiFetch(`/mail/video-meetings/${encodeURIComponent(meetingUid)}`, {
        method: "PUT",
        body: JSON.stringify({ waitingRoomEnabled }),
    });
}

/** Removes a participant from the meeting - host only, enforced server-side with the caller's own authenticated
 * session (the same mailbox-ACL check every other owner-side video-meeting route uses), not by anything the
 * client claims. Revokes `uid`'s grant on the meeting's own push channel, so they can no longer signal or relay
 * media even if their client ignores the cooperative "kicked" signal a host's UI sends alongside this
 * (`MeshConnectionManager.sendKick()`). `uid` is the participant's real account uid (`MeshParticipant.uid` minus
 * its tab-scoped suffix - see `_CallView.tsx`'s `accountUidOf()`), not their tab-scoped peer id. */
export function kickParticipant(meetingUid: string, uid: string): Promise<void> {
    return apiFetch(`/mail/video-meetings/${encodeURIComponent(meetingUid)}/kick/${encodeURIComponent(uid)}`, { method: "POST" });
}

/** Sets whether a newly joining participant starts muted (`PublicVideoMeeting.forceMuteOnJoin`) - host only,
 * enforced the same way as every other owner-side video-meeting update. Takes effect for anyone who joins (or
 * reloads the join link and joins again) after this call resolves; it does not retroactively mute anyone already
 * in the call - the host's own "Mute" button (see `kickParticipant()`) is the tool for that. */
export function setForceMuteOnJoin(meetingUid: string, forceMuteOnJoin: boolean): Promise<void> {
    return apiFetch(`/mail/video-meetings/${encodeURIComponent(meetingUid)}`, {
        method: "PUT",
        body: JSON.stringify({ forceMuteOnJoin }),
    });
}
