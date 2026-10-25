///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The `SignalingChannel` (`../webrtc/types.js`) of a call: one WebSocket to this plugin's own signaling route
 * (`BaseVideoMeetingRoute.signal()`, `wss://<origin>/api/mail/video-meetings/signal/<meetingUid>`), carrying every
 * `SignalMessage` both ways - see the backend's `SignalingHub` for the protocol this speaks:
 *
 * - Once the socket opens, it says `{"op":"hello","v":1,"peer":<this tab's peer id>}`; the server answers
 * `{"op":"ready","v":1,"maxMessageBytes":N}` and `connect()` resolves.
 * - `send()` writes `{"op":"signal","data":<message>}`. The server stamps `from`/`peer` itself, and delivers a message
 * with `to` to that peer only - so unlike the shared `/push` channel this replaced, nobody receives offers, answers or
 * ICE candidates meant for someone else, and the client never sees its own messages echoed back.
 * - A message the server delivers arrives as `{"op":"signal","data":...}` and is handed to every `onMessage()` listener.
 * - `{"op":"removed","uid":<account uid>}` is the server's own notice that the host removed that participant; it is
 * handed to every `onRemoved()` listener. It is never sealed - the server sends it, and knows who it removed - and no
 * participant can send one, since everything a participant sends arrives wrapped in a `signal`.
 * - A `ping` every `SIGNALING_KEEPALIVE_MS` keeps proxies from closing an idle socket.
 *
 * ## Authentication
 *
 * A browser `WebSocket` cannot send an `Authorization` header, so the upgrade is authenticated by the `jwt` cookie.
 * For a guest (`token` given - `VideoMeetingJoinResult.authenticated` is `false`) this client sets that cookie to the
 * guest token right before connecting (`applyAuthCookie()`), and expires it on `close()`; the media relay's own
 * socket (`../relay/RelayClient.ts`) then authenticates with the same cookie. For a caller already signed in to RapidMX
 * (`token` omitted) it writes nothing: a script cannot overwrite the real `HttpOnly` session cookie anyway, and that
 * session is the identity `join()` granted.
 *
 * ## Losing the connection
 *
 * A socket that drops after `connect()` resolved is reopened with jittered exponential backoff, says `hello` again
 * and carries on; whatever was sent meanwhile is held (up to `SIGNALING_MAX_QUEUED`, oldest dropped first) and sent
 * once the new socket is ready. A close with 1008 is the server refusing the socket - no grant, the meeting ended,
 * the participant was removed - and is final: before `connect()` resolved it rejects `connect()`, after that it
 * calls `onClosed` with the server's reason. (The one 1008 that is not final, "Replaced.", only ever reaches a socket
 * this client has already let go of.)
 */
import type { SignalCipher } from "../crypto/MeetingCipher.js";
import { apiOrigin } from "@rapidmx/web-client/lib/util/api.js";
import type { SignalMessage, SignalingChannel } from "../webrtc/types.js";

/** The version of the signaling wire protocol this client speaks - `SignalingHub`'s `SIGNALING_PROTOCOL_VERSION`. */
export const SIGNALING_PROTOCOL_VERSION = 1;

/** The first reconnect waits about this long, doubling on each further failure up to `SIGNALING_BACKOFF_MAX_MS`. */
export const SIGNALING_BACKOFF_BASE_MS = 1_000;
export const SIGNALING_BACKOFF_MAX_MS = 30_000;

/** How often an idle socket is pinged. */
export const SIGNALING_KEEPALIVE_MS = 25_000;

/** The most messages held while the socket is not ready. */
export const SIGNALING_MAX_QUEUED = 256;

/** What the server allows per message until it says otherwise in `ready` - its smallest possible limit. */
export const SIGNALING_DEFAULT_MAX_MESSAGE_BYTES: number = 16 * 1024;

/** The reason the server closes the socket with once the participant is removed from the meeting - `SignalingHub`'s
 * `SIGNALING_EVICTED_REASON` (`apps/` cannot import from the backend's `src/`, so this mirrors it). */
export const SIGNALING_EVICTED_REASON = "Removed from the meeting.";

/** The subset of the browser's `WebSocket` this client uses, so a test's fake can be a plain object. */
export interface SignalingSocket {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

export type SignalingSocketFactory = (url: string) => SignalingSocket;

const SOCKET_OPEN = 1;

/** The cookie name `JWTStrategyOptions.cookieName` defaults to (and this deployment always uses). */
const AUTH_COOKIE_NAME = "jwt";

/** The signaling WebSocket's URL for a meeting - the same origin derivation as the relay's `relayUrl()`. `undefined`
 * when there is no origin at all (not running in a browser). */
export function signalingUrl(meetingUid: string): string | undefined {
    const origin = apiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
    return origin ? `${origin.replace(/^http/i, "ws")}/api/mail/video-meetings/signal/${encodeURIComponent(meetingUid)}` : undefined;
}

function defaultSocketFactory(): SignalingSocketFactory | undefined {
    return typeof WebSocket === "undefined" ? undefined : (url) => new WebSocket(url) as unknown as SignalingSocket;
}

export interface SignalingClientOptions {
    /** The meeting's uid. */
    meetingUid: string;
    /** This tab's peer id (`<uid>~<random>` - see `_CallView.tsx`'s `newPeerId()`), announced in `hello`. */
    peerId: string;
    /** The guest JWT from `VideoMeetingJoinResult.token`; omitted for a caller already signed in - see this module's
     * doc comment on authentication. */
    token?: string;
    /** Called once when the server closes the socket for good after `connect()` resolved, with its reason. */
    onClosed?: (reason: string) => void;
    /** Overrides `signalingUrl(meetingUid)`. */
    url?: string;
    createSocket?: SignalingSocketFactory;
    /** Overrides `document`, for a test - see `applyAuthCookie()`. */
    documentRef?: Pick<Document, "cookie"> & { location?: Pick<Location, "protocol"> };
    random?: () => number;
    /** A protected meeting's cipher (`MeetingCipher`, `specs/meeting_privacy.md` §5.1): every message is sealed before it is sent and
     * opened before listeners see it, in order, and nothing travels in the clear. Absent: messages go as they are. */
    cipher?: SignalCipher;
}

export class SignalingClient implements SignalingChannel {
    private socket: SignalingSocket | undefined;
    private ready = false;
    private closed = false;
    private everReady = false;
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    private cookieApplied = false;
    private maxBytes: number = SIGNALING_DEFAULT_MAX_MESSAGE_BYTES;
    private readonly queue: string[] = [];
    private readonly listeners = new Set<(message: SignalMessage) => void>();
    private readonly removedListeners = new Set<(uid: string) => void>();
    private pendingConnect: { resolve: () => void; reject: (err: Error) => void } | undefined;
    /** Seals, then opens, one message at a time, so neither direction is reordered by encryption. */
    private sealing: Promise<void> = Promise.resolve();
    private opening: Promise<void> = Promise.resolve();

    constructor(private readonly options: SignalingClientOptions) {}

    /** The largest message (the whole `signal` envelope, in bytes) the server accepts - what its `ready` said. */
    get maxMessageBytes(): number {
        return this.maxBytes;
    }

    /** The most a message's own JSON may take (UTF-8 bytes) for what goes on the wire to stay within `maxMessageBytes`: smaller in a
     * protected meeting, where sealing and base64 add about a third. */
    get maxPlainMessageBytes(): number {
        return this.options.cipher?.plaintextBudget?.(this.maxBytes) ?? this.maxBytes;
    }

    /** Opens the socket and resolves once the server is ready; rejects when the server refuses it, or there is no way
     * to open one at all (no `WebSocket`, no origin). Calling it on a closed client rejects at once. */
    connect(): Promise<void> {
        if (this.closed) {
            return Promise.reject(new Error("This signaling client has already been closed."));
        }
        return new Promise<void>((resolve, reject) => {
            this.pendingConnect = { resolve, reject };
            this.openSocket();
        });
    }

    /** Closes the socket, stops reconnecting and clears the guest auth cookie this client applied - idempotent. */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.ready = false;
        clearTimeout(this.reconnectTimer);
        this.stopKeepalive();
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
        this.removedListeners.clear();
        this.queue.length = 0;
        this.pendingConnect?.reject(new Error("Closed before the signaling channel connected."));
        this.pendingConnect = undefined;
    }

    onMessage(handler: (message: SignalMessage) => void): () => void {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }

    onRemoved(handler: (uid: string) => void): () => void {
        this.removedListeners.add(handler);
        return () => this.removedListeners.delete(handler);
    }

    /** Sends `message` now, or once the socket is ready again - see this module's doc comment. A no-op once closed. */
    send(message: SignalMessage): void {
        if (this.closed) {
            return;
        }
        const cipher = this.options.cipher;
        if (cipher) {
            // A message that fails to seal is dropped alone: the chain itself never stays rejected.
            this.sealing = this.sealing
                .then(async () => {
                    const data = await cipher.seal(message);
                    if (!this.closed) {
                        this.enqueue(JSON.stringify({ op: "signal", data }));
                    }
                })
                .catch(() => undefined);
            return;
        }
        this.enqueue(JSON.stringify({ op: "signal", data: message }));
    }

    private enqueue(text: string): void {
        // Straight out only when nothing is waiting, so a message never overtakes one queued before it.
        if (this.ready && this.queue.length === 0 && this.write(text)) {
            return;
        }
        if (this.queue.length >= SIGNALING_MAX_QUEUED) {
            this.queue.shift();
        }
        this.queue.push(text);
    }

    private openSocket(): void {
        const url = this.options.url ?? signalingUrl(this.options.meetingUid);
        const createSocket = this.options.createSocket ?? defaultSocketFactory();
        if (!url || !createSocket) {
            this.fail(new Error("This browser (or this page's connection) doesn't support the signaling channel."));
            return;
        }
        this.applyAuthCookie();
        let socket: SignalingSocket;
        try {
            socket = createSocket(url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.onopen = () => this.write(JSON.stringify({ op: "hello", v: SIGNALING_PROTOCOL_VERSION, peer: this.options.peerId }));
        socket.onmessage = (event) => this.handleFrame(event.data);
        socket.onclose = (event) => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = undefined;
            this.ready = false;
            this.stopKeepalive();
            if (event?.code === 1008) {
                this.refused(event.reason || "The meeting refused the connection.");
                return;
            }
            this.scheduleReconnect();
        };
        // An error is always followed by a close, which decides what happens next.
        socket.onerror = () => undefined;
    }

    private handleFrame(raw: unknown): void {
        if (typeof raw !== "string") {
            return;
        }
        let frame: { op?: unknown; data?: unknown; maxMessageBytes?: unknown; uid?: unknown };
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") {
                return;
            }
            frame = parsed;
        } catch {
            return;
        }
        if (frame.op === "ready") {
            this.handleReady(frame.maxMessageBytes);
        } else if (frame.op === "removed") {
            if (typeof frame.uid === "string" && frame.uid) {
                this.deliverRemoved(frame.uid);
            }
        } else if (frame.op === "signal" && frame.data && typeof frame.data === "object") {
            const cipher = this.options.cipher;
            const data = frame.data as Record<string, unknown>;
            if (!cipher) {
                this.deliver(data as unknown as SignalMessage);
                return;
            }
            this.opening = this.opening
                .then(async () => {
                    const message = await cipher.open(data);
                    if (message && !this.closed) {
                        this.deliver(message);
                    }
                })
                .catch(() => undefined);
        }
    }

    /** Hands `message` to every listener. One that throws neither keeps the others from it nor stops what arrives next: its error goes
     * to the page's error reporting (`reportError()`) instead. */
    private deliver(message: SignalMessage): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(message);
            } catch (err) {
                (globalThis as { reportError?: (error: unknown) => void }).reportError?.(err);
            }
        }
    }

    /** Hands a `removed` notice's `uid` to every `onRemoved()` listener, a throwing one reported as `deliver()` does. */
    private deliverRemoved(uid: string): void {
        for (const listener of [...this.removedListeners]) {
            try {
                listener(uid);
            } catch (err) {
                (globalThis as { reportError?: (error: unknown) => void }).reportError?.(err);
            }
        }
    }

    private handleReady(maxMessageBytes: unknown): void {
        if (typeof maxMessageBytes === "number" && Number.isFinite(maxMessageBytes) && maxMessageBytes > 0) {
            this.maxBytes = maxMessageBytes;
        }
        this.ready = true;
        this.everReady = true;
        this.attempt = 0;
        this.startKeepalive();
        while (this.queue.length > 0 && this.write(this.queue[0])) {
            this.queue.shift();
        }
        this.pendingConnect?.resolve();
        this.pendingConnect = undefined;
    }

    /** Writes `text` to the open socket; `false` when there is none or it threw. */
    private write(text: string): boolean {
        const socket = this.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN) {
            return false;
        }
        try {
            socket.send(text);
            return true;
        } catch {
            return false;
        }
    }

    private startKeepalive(): void {
        this.stopKeepalive();
        this.keepaliveTimer = setInterval(() => this.write(JSON.stringify({ op: "ping", t: Date.now() })), SIGNALING_KEEPALIVE_MS);
    }

    private stopKeepalive(): void {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = undefined;
    }

    private scheduleReconnect(): void {
        if (this.closed) {
            return;
        }
        const ceiling = Math.min(SIGNALING_BACKOFF_MAX_MS, SIGNALING_BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 10));
        const delay = ceiling / 2 + ((this.options.random ?? Math.random)() * ceiling) / 2;
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.openSocket();
        }, delay);
    }

    /** The server closed the socket for good - see this module's doc comment. */
    private refused(reason: string): void {
        if (this.pendingConnect) {
            this.fail(new Error(reason));
            return;
        }
        if (this.everReady) {
            this.options.onClosed?.(reason);
        }
    }

    private fail(err: Error): void {
        this.pendingConnect?.reject(err);
        this.pendingConnect = undefined;
    }

    /** Sets the `jwt` cookie to the guest `token`, so the browser attaches it to the upgrade this client is about to
     * open - see this module's doc comment. A no-op without a token or a document. */
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

    /** Expires the cookie `applyAuthCookie()` set; a no-op when it set none. */
    private clearAuthCookie(): void {
        if (!this.cookieApplied) {
            return;
        }
        const doc = this.options.documentRef ?? (typeof document === "undefined" ? undefined : document);
        doc!.cookie = `${AUTH_COOKIE_NAME}=; path=/; Max-Age=0`;
    }
}
