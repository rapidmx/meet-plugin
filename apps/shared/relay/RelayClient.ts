///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The WebSocket to the server's media relay - the transport under the last-resort tier of a call, used for a pair of
 * participants whose WebRTC connection could not be made to work at all.
 *
 * ## Wire protocol (fixed by the server)
 *
 * - The first message is text JSON `{"op":"hello","v":1,"peer":"<peerId>"}`; the server answers `{"op":"ready","v":1}`,
 * plus `"maxMessageBytes"` - the largest client-to-server message it accepts - on a current server (absent on an
 * older one, which accepts `MAX_MESSAGE_BYTES`). Nothing else may be sent before `ready`.
 * - `{"op":"want","peers":[...]}` REPLACES the set of senders this socket receives from (the server accepts at most
 * `MAX_WANTED_PEERS`). It has to be re-sent after every reconnect, because the server's set dies with the socket.
 * - A binary message from the client is an opaque payload of at most `maxMessageBytes`. The server forwards it to
 * every socket that wants this sender as `[1 byte N][N bytes UTF-8 sender peer id][payload]`, stamping the sender
 * itself so a peer cannot speak as another.
 * - Binary messages may be dropped under backpressure and the socket may close at any moment, so this client
 * reconnects with exponential backoff and treats every media send as best effort.
 *
 * Authentication is the `jwt` cookie already in place (see `GuestSignalingClient`), so this client sets no cookie.
 */
import { DEFAULT_MESSAGE_BYTES } from "./frames.js";
import type { RelaySocket } from "./relayEnv.js";

/** The largest binary message an older server accepts - it closes the socket on a larger one (uWS's default limit).
 * Assumed until the server's `ready` announces a different `maxMessageBytes`. */
export const MAX_MESSAGE_BYTES = DEFAULT_MESSAGE_BYTES;
/** A `maxMessageBytes` below this is not believed (nothing useful fits), and one above
 * `MAX_NEGOTIATED_MESSAGE_BYTES` is clamped to it. */
export const MIN_NEGOTIATED_MESSAGE_BYTES = 1024;
export const MAX_NEGOTIATED_MESSAGE_BYTES = 1024 * 1024;
/** The most senders the server lets one socket `want`. */
export const MAX_WANTED_PEERS = 32;
/** A media send is dropped, not queued, while more than this many bytes are still waiting to leave - the
 * connection is slower than the media, and queueing would only add latency to the frames that are still fresh. */
export const MAX_BUFFERED_BYTES = 256 * 1024;
/** Reconnect delay: about a second after the first failure, doubling to a ceiling, jittered so a server restart
 * doesn't bring every client back in the same instant. */
export const RELAY_BACKOFF_BASE_MS = 1_000;
export const RELAY_BACKOFF_MAX_MS = 15_000;
/** How long a socket may take to become `ready` before it is abandoned and retried (a server that accepts the
 * upgrade but never answers the hello would otherwise hang the tier forever). */
export const RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;

const SOCKET_OPEN = 1;

export interface RelayClientOptions {
    url: string;
    peerId: string;
    createSocket: (url: string) => RelaySocket;
    random: () => number;
    /** Called with the sender's peer id (as stamped by the server) and the original payload. */
    onMedia: (peerId: string, payload: Uint8Array) => void;
}

/** Views `data` as bytes when it is binary (an `ArrayBuffer` or a typed array), else `undefined`. Uses
 * `Object.prototype.toString` rather than `instanceof` so it works for a buffer from another realm too. */
function toBytes(data: unknown): Uint8Array | undefined {
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
        return new Uint8Array(data as ArrayBuffer);
    }
    return undefined;
}

export class RelayClient {
    private socket: RelaySocket | undefined;
    private closed = false;
    private started = false;
    private isReady = false;
    private messageLimit = MAX_MESSAGE_BYTES;
    private attempt = 0;
    private wanted: string[] = [];
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly decoder = new TextDecoder();

    constructor(private readonly options: RelayClientOptions) {}

    /** True once the server has answered the hello on the current socket, i.e. media may be sent. */
    get ready(): boolean {
        return this.isReady;
    }

    /** The largest message `sendMedia()` will send: what the server announced in `ready` (validated and clamped), or
     * `MAX_MESSAGE_BYTES` before that, without one, and again after every disconnect until the next `ready`. The
     * frame fragmenter sizes its fragments from this. */
    get maxMessageBytes(): number {
        return this.messageLimit;
    }

    /** Opens the socket (and keeps it open, reconnecting as needed) until `close()`. Idempotent. */
    start(): void {
        if (this.started || this.closed) {
            return;
        }
        this.started = true;
        this.openSocket();
    }

    /** Replaces the set of senders to receive from. Sent now if the socket is ready, and again after each reconnect. */
    setWanted(peers: Iterable<string>): void {
        this.wanted = [...peers].slice(0, MAX_WANTED_PEERS);
        if (this.isReady) {
            this.sendText({ op: "want", peers: this.wanted });
        }
    }

    /** Sends one media message. Returns whether it was handed to the socket - `false` (dropped) when the socket is
     * not ready, is backed up, or the message is too large for the server to accept. */
    sendMedia(bytes: Uint8Array): boolean {
        const socket = this.socket;
        if (
            !socket ||
            !this.isReady ||
            socket.readyState !== SOCKET_OPEN ||
            socket.bufferedAmount > MAX_BUFFERED_BYTES ||
            bytes.length > this.messageLimit
        ) {
            return false;
        }
        try {
            socket.send(bytes);
            return true;
        } catch {
            // The close that follows a dead socket reconnects.
            return false;
        }
    }

    /** Closes the socket and stops reconnecting for good. Idempotent. */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.isReady = false;
        this.messageLimit = MAX_MESSAGE_BYTES;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.handshakeTimer);
        this.reconnectTimer = this.handshakeTimer = undefined;
        this.detach();
    }

    private openSocket(): void {
        let socket: RelaySocket;
        try {
            socket = this.options.createSocket(this.options.url);
        } catch {
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.binaryType = "arraybuffer";
        socket.onopen = () => this.sendText({ op: "hello", v: 1, peer: this.options.peerId });
        socket.onmessage = (event) => this.handleMessage(socket, event.data);
        socket.onclose = () => this.handleClose(socket);
        socket.onerror = () => undefined;
        this.handshakeTimer = setTimeout(() => {
            this.handshakeTimer = undefined;
            // Give up on this attempt as if the socket had closed; the close event of a socket we abandon is ignored.
            this.handleClose(socket);
        }, RELAY_HANDSHAKE_TIMEOUT_MS);
    }

    private handleMessage(socket: RelaySocket, data: unknown): void {
        if (socket !== this.socket) {
            return;
        }
        if (typeof data === "string") {
            this.handleText(data);
            return;
        }
        const bytes = toBytes(data);
        if (!bytes || !this.isReady) {
            return;
        }
        const idLength = bytes.length > 0 ? bytes[0] : 0;
        if (idLength === 0 || bytes.length < 1 + idLength) {
            return;
        }
        // A malformed id decodes to replacement characters, which match no receiver, so it needs no separate check.
        const peerId = this.decoder.decode(bytes.subarray(1, 1 + idLength));
        this.options.onMedia(peerId, bytes.subarray(1 + idLength));
    }

    private handleText(text: string): void {
        let message: unknown;
        try {
            message = JSON.parse(text);
        } catch {
            return;
        }
        if (!message || typeof message !== "object" || (message as { op?: unknown }).op !== "ready" || this.isReady) {
            return;
        }
        this.isReady = true;
        this.attempt = 0;
        const announced = (message as { maxMessageBytes?: unknown }).maxMessageBytes;
        if (typeof announced === "number" && Number.isInteger(announced) && announced >= MIN_NEGOTIATED_MESSAGE_BYTES) {
            this.messageLimit = Math.min(announced, MAX_NEGOTIATED_MESSAGE_BYTES);
        }
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        // The server's wanted set is per socket, so it starts empty on every (re)connect.
        this.sendText({ op: "want", peers: this.wanted });
    }

    private handleClose(socket: RelaySocket): void {
        if (socket !== this.socket) {
            return;
        }
        this.isReady = false;
        // The next server might be a different one (a rolling upgrade), so the limit is learned afresh.
        this.messageLimit = MAX_MESSAGE_BYTES;
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.detach();
        this.scheduleReconnect();
    }

    /** Detaches and closes the current socket, if any, so its late events can't reach this client. */
    private detach(): void {
        const socket = this.socket;
        this.socket = undefined;
        if (!socket) {
            return;
        }
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        try {
            socket.close(1000, "closing");
        } catch {
            // Already gone.
        }
    }

    private scheduleReconnect(): void {
        const ceiling = Math.min(RELAY_BACKOFF_MAX_MS, RELAY_BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 10));
        const delay = ceiling / 2 + (this.options.random() * ceiling) / 2;
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.openSocket();
        }, delay);
    }

    private sendText(message: object): void {
        const socket = this.socket;
        if (!socket || socket.readyState !== SOCKET_OPEN) {
            return;
        }
        try {
            socket.send(JSON.stringify(message));
        } catch {
            // The close that follows a dead socket reconnects and re-sends.
        }
    }
}
