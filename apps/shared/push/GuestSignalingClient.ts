///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * A standalone `SignalingChannel` (`../webrtc/types.js`) over `@rapidrest/service-core`'s `/push` WebSocket -
 * built from scratch rather than reusing `@rapidmx/react-shared`'s `PushClient`/`getPushClient()`.
 *
 * ## Why not `PushClient`
 *
 * `PushClient` was investigated first, as this plugin's Phase 2 `.claude/NOTES.md` entry required. Its `connect()`
 * opens a bare `new WebSocket(url)` and relies entirely on the browser automatically attaching this deployment's
 * `jwt` `HttpOnly` cookie to the upgrade request - it never sends a token of its own (see its own doc comment:
 * "a script can't read that cookie, so there is no token to send"). That fits the webmail tab's own authenticated
 * session perfectly, but this plugin's anonymous guest has no such cookie at all - only the bearer `token`
 * `BaseVideoMeetingRoute.join()` minted, handed to this client explicitly. `PushClient`'s API has no parameter
 * anywhere to supply that token, and its shared-singleton design (`getPushClient()`, one client per tab) is itself
 * the wrong shape here too: a guest's signaling identity must never be confused with (or silently share a socket
 * with) whatever webmail session, if any, happens to already be open in the same browser. So this module
 * implements the same wire protocol independently instead - see `../../.claude/NOTES.md` and
 * `BasePushRoute`/`JWTStrategy` (`@rapidrest/service-core`) for the protocol this matches:
 *
 * - `wss://<origin>/push` - authenticated at the WebSocket upgrade. A real browser `WebSocket` cannot attach a
 * custom `Authorization` header to that upgrade request at all (a WHATWG API limitation, not something any
 * client-side code can work around) - `JWTStrategy.getAuthToken()`'s only other source is the same `jwt` cookie
 * `PushClient` already relies on. When `token` is supplied (the common anonymous/guest case -
 * `VideoMeetingJoinResult.authenticated` is `false`), this client sets that cookie itself, to `token`, immediately
 * before connecting (`applyAuthCookie()`). When `token` is omitted (the caller already authenticated as a real
 * RapidMX identity in `join()` - `authenticated: true` - see the FIXED LIMITATION below), this client writes no
 * cookie at all and simply lets the browser attach whatever real `jwt` session cookie already exists for this
 * origin, exactly as `PushClient` does for an ordinary webmail session.
 * - Right after connecting, the server sends `{ id: 0, type: "SUBSCRIBED", data: [...] }` (channels the socket
 * already holds - the caller's own uid channel, never this meeting's). `connect()` then explicitly `SUBSCRIBE`s to
 * the one meeting channel and waits for the matching `{ id, type: "SUBSCRIBED", data }` reply, resolving once
 * `channel` is actually in that reply's `data` (rejecting otherwise - an unauthorized/expired token, or the
 * meeting's ACL grant somehow missing).
 * - Publishing (`send()`) is **not** a WebSocket message at all - `BasePushRoute.send()` is `POST /push/:id`, a
 * perfectly ordinary authenticated HTTP endpoint. When `token` is supplied it's sent there as a normal
 * `Authorization: Bearer` header (no browser limitation applies to a plain `fetch()`); when it's omitted, the
 * request carries no `Authorization` header at all and instead relies on `fetch()`'s own default same-origin
 * credentials mode, which already attaches the browser's real `jwt` cookie to a same-origin request with zero
 * extra code - `JWTStrategy.getAuthToken()`'s cookie fallback authenticates it exactly as it would any other
 * same-origin authenticated call. Fire-and-forget either way, matching every other push publish in this codebase -
 * a failed send is logged, never thrown, since a caller (`MeshConnectionManager`) has no meaningful per-message
 * retry of its own.
 * - An incoming meeting message arrives wrapped `{ type: "MESSAGE", channel, data: <the posted body> }` - this
 * client unwraps it and delivers `data` (expected to be a `SignalMessage`) to `onMessage()` listeners.
 *
 * ## FIXED: the browser-session-collision limitation this module used to carry
 *
 * Phase 2 originally always wrote the guest `token` as the `jwt` cookie before connecting, unconditionally. If the
 * visiting browser already held a *real*, `HttpOnly` `jwt` session cookie for this exact origin (a logged-in
 * RapidMX user, e.g. with webmail open), that write was silently blocked by the browser's own "script cannot
 * override an `HttpOnly` cookie of the same name" protection - the WebSocket then authenticated as that real
 * session instead of the intended guest identity, and since the meeting's `AccessControlList` grant only named the
 * guest uid, the real session's `SUBSCRIBE` was simply refused. Net effect: a logged-in user could never actually
 * join a call at all (safe - never a cross-identity leak - but broken).
 *
 * The fix is in `BaseVideoMeetingRoute.join()` (backend): when the caller already presents a valid session for a
 * real RapidMX identity, it grants *that* identity's own uid on the meeting's channel directly and returns
 * `authenticated: true` with no guest `token` at all - see `VideoMeetingJoinResult`'s doc comment. This module's
 * own half of the fix is simply to stop writing a cookie (and stop sending a bearer header) whenever `token` is
 * absent, as described above - the browser's real cookie was always going to win that write anyway, so the
 * correct behavior is to not fight it and let it authenticate normally instead.
 */
import { apiOrigin } from "@rapidmx/react-shared/util/api.js";
import { pushUrl } from "@rapidmx/react-shared/mail/pushClient.js";
import type { SignalMessage, SignalingChannel } from "../webrtc/types.js";

/** The subset of the browser's `WebSocket` this client uses - matches `PushClient`'s own identical seam, so a
 * test's fake can be a plain object with no real socket behind it. */
export interface PushSocket {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

export type PushSocketFactory = (url: string) => PushSocket;

const SOCKET_OPEN = 1;

function defaultSocketFactory(): PushSocketFactory | undefined {
    return typeof WebSocket === "undefined" ? undefined : (url) => new WebSocket(url) as unknown as PushSocket;
}

/** The cookie name `JWTStrategyOptions.cookieName` defaults to (and this deployment always uses - see
 * `BaseVideoMeetingRoute`'s guest JWT doc comment, signed with the same `auth` config every other token is). */
const AUTH_COOKIE_NAME = "jwt";

export interface GuestSignalingClientOptions {
    /** The meeting's own uid - both its push channel and the `POST /push/:id` target. */
    channel: string;
    /** The guest JWT from `VideoMeetingJoinResult.token`. Omitted when the caller already authenticated as a real
     * RapidMX identity (`VideoMeetingJoinResult.authenticated`) - this client then writes no cookie and sends no
     * `Authorization` header at all, relying entirely on the browser's own already-existing `jwt` session cookie
     * for both the WebSocket upgrade and each `POST /push/:id` publish - see this module's doc comment. */
    token?: string;
    /** Defaults to `@rapidmx/react-shared`'s `pushUrl()` - the exact URL `PushClient` itself connects to. */
    url?: () => string | undefined;
    createSocket?: PushSocketFactory;
    fetchImpl?: typeof fetch;
    /** Overrides `document`, for a test - see `applyAuthCookie()`. */
    documentRef?: Pick<Document, "cookie"> & { location?: Pick<Location, "protocol"> };
    random?: () => number;
}

/** The first reconnect waits about this long, doubling on each further failure, matching `PushClient`'s own
 * constants (kept independent rather than imported, since this module deliberately doesn't depend on
 * `pushClient.ts` beyond its `pushUrl()` helper - see this module's doc comment on why it isn't `PushClient` itself). */
export const SIGNALING_BACKOFF_BASE_MS = 1_000;
export const SIGNALING_BACKOFF_MAX_MS = 30_000;

export class GuestSignalingClient implements SignalingChannel {
    private socket: PushSocket | undefined;
    private closed = false;
    private nextRequestId = 1;
    private attempt = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private cookieApplied = false;
    private readonly listeners = new Set<(message: SignalMessage) => void>();
    private pendingConnect: { resolve: () => void; reject: (err: Error) => void } | undefined;

    constructor(private readonly options: GuestSignalingClientOptions) {}

    /** Connects, authenticates (see this module's doc comment) and subscribes to the meeting's own channel.
     * Resolves once genuinely ready to send/receive; rejects if the channel is refused (an invalid/expired token,
     * or - now fixed rather than merely possible, see the FIXED LIMITATION section above - a stale grant) or there
     * is nothing to connect with at all (no `WebSocket`, e.g. a non-HTTPS context in some browsers - the lobby's
     * own device-support checks already cover the more common case of no `mediaDevices`, but this is an
     * independent capability). Calling this a second time on an already-closed client rejects immediately. */
    connect(): Promise<void> {
        if (this.closed) {
            return Promise.reject(new Error("This signaling client has already been closed."));
        }
        return new Promise<void>((resolve, reject) => {
            this.pendingConnect = { resolve, reject };
            this.openSocket();
        });
    }

    /** Closes the socket, stops reconnecting and clears the guest auth cookie this client applied (see
     * `applyAuthCookie()`) - idempotent. */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.timer);
        this.timer = undefined;
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
            try {
                socket.close(1000, "closing");
            } catch {
                // Already gone.
            }
        }
        this.clearAuthCookie();
        this.listeners.clear();
        this.pendingConnect?.reject(new Error("Closed before the signaling channel connected."));
        this.pendingConnect = undefined;
    }

    onMessage(handler: (message: SignalMessage) => void): () => void {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }

    /** Publishes over `POST /push/:id`, with `token` as a bearer credential when present - see this module's doc
     * comment on why this, unlike subscribing, needs no cookie workaround at all, and on the omitted-`token` case
     * (an already-authenticated real caller), which relies on the browser's own real `jwt` cookie instead.
     * Fire-and-forget: a failure is swallowed (there is nothing a signaling message's own sender can usefully do
     * about a dropped publish beyond what the mesh's own `hello` re-announcement/renegotiation already tolerates -
     * see `MeshConnectionManager`'s doc comment on fire-and-forget delivery). */
    send(message: SignalMessage): void {
        const fetchImpl = this.options.fetchImpl ?? (typeof fetch === "undefined" ? undefined : fetch);
        if (!fetchImpl) {
            return;
        }
        const origin = apiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.options.token) {
            headers.Authorization = `Bearer ${this.options.token}`;
        }
        void fetchImpl(`${origin}/push/${encodeURIComponent(this.options.channel)}`, {
            method: "POST",
            headers,
            body: JSON.stringify(message),
            // Lets a `bye` sent as the page unloads still go out.
            keepalive: true,
        }).catch(() => {
            // Best-effort - see this method's doc comment.
        });
    }

    private openSocket(): void {
        const url = (this.options.url ?? pushUrl)();
        const createSocket = this.options.createSocket ?? defaultSocketFactory();
        if (!url || !createSocket) {
            this.failConnect(new Error("This browser (or this page's connection) doesn't support the signaling channel."));
            return;
        }
        this.applyAuthCookie();
        let socket: PushSocket;
        try {
            socket = createSocket(url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.onmessage = (event) => this.handleFrame(event.data);
        socket.onclose = () => {
            // Guards against a stale socket's belated close event: `close()` always sets `this.socket = undefined`
            // synchronously (before this handler could possibly be detached asynchronously), so once this client
            // is closed, `this.socket` can never equal `socket` again and this always returns here first.
            if (this.socket !== socket) {
                return;
            }
            this.socket = undefined;
            this.scheduleReconnect();
        };
        socket.onerror = () => undefined;
    }

    private scheduleReconnect(): void {
        const ceiling = Math.min(SIGNALING_BACKOFF_MAX_MS, SIGNALING_BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 10));
        const delay = ceiling / 2 + ((this.options.random ?? Math.random)() * ceiling) / 2;
        this.attempt += 1;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.openSocket();
        }, delay);
    }

    private handleFrame(raw: unknown): void {
        if (typeof raw !== "string") {
            return;
        }
        let frame: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") {
                return;
            }
            frame = parsed as Record<string, unknown>;
        } catch {
            return;
        }
        if (frame.type === "SUBSCRIBED") {
            this.handleSubscribed(frame);
            return;
        }
        if (frame.type === "MESSAGE" && frame.channel === this.options.channel) {
            const data = frame.data;
            if (data && typeof data === "object" && (data as { type?: unknown }).type === "video-meeting-signal") {
                this.emit(data as SignalMessage);
            }
        }
    }

    private handleSubscribed(frame: Record<string, unknown>): void {
        const channels = Array.isArray(frame.data) ? frame.data.filter((c): c is string => typeof c === "string") : [];
        if (frame.id === 0) {
            // The connect-time greeting: now actually subscribe to the one channel this client cares about.
            const id = this.nextRequestId++;
            this.send0({ id, type: "SUBSCRIBE", data: [this.options.channel] });
            return;
        }
        if (channels.includes(this.options.channel)) {
            this.attempt = 0;
            this.pendingConnect?.resolve();
            this.pendingConnect = undefined;
        } else if (this.pendingConnect) {
            this.failConnect(new Error("This meeting's signaling channel refused the subscription."));
        }
    }

    private send0(message: object): void {
        const socket = this.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN) {
            return;
        }
        try {
            socket.send(JSON.stringify(message));
        } catch {
            // The close that follows a dead socket reconnects and re-subscribes.
        }
    }

    private failConnect(err: Error): void {
        this.pendingConnect?.reject(err);
        this.pendingConnect = undefined;
    }

    private emit(message: SignalMessage): void {
        for (const listener of [...this.listeners]) {
            listener(message);
        }
    }

    /** Sets the `jwt` cookie to `token` for this origin, so the browser attaches it (as `PushClient`'s own doc
     * comment describes for a real session) to the WebSocket upgrade this client is about to open - see this
     * module's doc comment for the full reasoning. A no-op when `token` is omitted (the caller already
     * authenticated as a real RapidMX identity - see the FIXED LIMITATION section above): there is then no guest
     * token to apply, and writing nothing leaves the browser's own real `jwt` session cookie, whatever it is,
     * untouched and free to authenticate the connection normally. */
    private applyAuthCookie(): void {
        if (!this.options.token) {
            return;
        }
        const doc = this.options.documentRef ?? (typeof document === "undefined" ? undefined : document);
        if (!doc) {
            return;
        }
        this.cookieApplied = true;
        const secure = (doc.location ?? (typeof location === "undefined" ? undefined : location))?.protocol === "https:" ? "; Secure" : "";
        doc.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(this.options.token)}; path=/; SameSite=Lax${secure}`;
    }

    /** Expires the cookie `applyAuthCookie()` set - a no-op if that write was itself silently blocked, or never
     * attempted at all because `token` was omitted (see `applyAuthCookie()`'s own doc comment), either way leaving
     * whatever real session cookie was already there untouched. `cookieApplied` is only ever set once
     * `applyAuthCookie()` has already confirmed both a `token` to write and a `doc` to write it to, and neither
     * `this.options.token`, `this.options.documentRef` nor the real global `document` can change mid-call, so
     * resolving it here is guaranteed to succeed too - no second `!doc` guard needed. */
    private clearAuthCookie(): void {
        if (!this.cookieApplied) {
            return;
        }
        const doc = this.options.documentRef ?? (typeof document === "undefined" ? undefined : document);
        doc!.cookie = `${AUTH_COOKIE_NAME}=; path=/; Max-Age=0`;
    }
}
