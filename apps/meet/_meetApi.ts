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

/** Resolves a join token (an invitee's own link) or a public meeting's slug to its meeting info, ICE servers, and
 * either a short-lived guest signaling token (the common anonymous case) or confirmation that the caller's own
 * existing session already grants them signaling access (`authenticated: true` - see
 * `VideoMeetingJoinResult`'s doc comment) - see `BaseVideoMeetingRoute.join()`'s own doc comment. Rejects with
 * `ApiRequestError` (status `404`) for a stale/unknown/malformed token, cancelled meeting, or the wrong
 * private/public token shape for what it's being used against - the caller (`[token].tsx`) shows a single,
 * friendly "this meeting link isn't valid" state for all of those rather than trying to distinguish them, matching
 * `BaseVideoMeetingRoute.requireMeetingByToken()`'s own explicit "never leak which almost-matched" posture. */
export function joinMeeting(token: string): Promise<VideoMeetingJoinResult> {
    return apiFetch(`/mail/video-meetings/join/${encodeURIComponent(token)}`);
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
