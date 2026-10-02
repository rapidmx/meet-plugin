///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The version of the relay wire protocol this module implements - the `v` of `hello`/`ready`. */
export const RELAY_PROTOCOL_VERSION = 1;

/** The largest binary payload (in bytes, excluding the sender header the server adds) a socket may send; anything
 * larger or empty is dropped. Matches `@rapidrest/service-core`'s uWS `DEFAULT_WS_OPTIONS.maxPayloadLength` (16 KiB),
 * which this framework's route registration cannot raise - a larger message closes the socket at the transport. */
export const RELAY_MAX_PAYLOAD_BYTES: number = 16 * 1024;

/** The larger message limit the relay route asks the framework for when the installed `@rapidrest/service-core` lets a
 * `@WebSocket()` route set one (its 2.4.0 and later): a video key frame then fits in one message instead of several,
 * with far less fragmenting and reassembly for the client to get wrong. The hub advertises whichever limit applies to
 * the client in `ready` (`maxMessageBytes`). */
export const RELAY_LARGE_PAYLOAD_BYTES: number = 64 * 1024;

/** How many bytes the framework may hold unsent for one relay socket before it drops further messages to it, when the
 * installed `@rapidrest/service-core` lets a route set that (its default, 64 KiB, is smaller than one key frame's worth
 * of headroom and made a briefly slow receiver lose frames constantly). 128 KiB is roughly 2.7 seconds of
 * `VideoSender.VIDEO_BITRATE` (350 kbps) plus `AudioSender.AUDIO_BITRATE` (24 kbps) combined - (350_000 + 24_000) / 8
 * bytes/s ≈ 46.75 KB/s - comfortably more than one key frame but not so much that a receiver whose downlink is
 * briefly slower than the stream is left playing several seconds stale: this was previously 1 MiB (≈22 seconds at
 * this bitrate, not the "roughly two seconds" the comment claimed - a bits-vs-bytes mix-up), which let a receiver's
 * backlog grow essentially without bound before anything was ever dropped, rather than the "briefly slow" case this
 * budget is meant to cover. `apps/shared/relay/`'s own senders can't import this constant (`tsconfig.apps.json`
 * builds `apps/` as its own program - see its own doc comments), so this is a cross-reference, not a shared import:
 * changing either bitrate should revisit this value too. */
export const RELAY_WS_MAX_BACKPRESSURE_BYTES: number = 128 * 1024;

/** The most sockets (registered or still awaiting their `hello`) one room holds at once. */
export const RELAY_MAX_SOCKETS_PER_ROOM = 16;

/** The most sockets one authenticated uid may hold in one room at once (several tabs or devices of one account). */
export const RELAY_MAX_SOCKETS_PER_UID = 4;

/** Sustained inbound binary budget per socket, in bytes per second (a token bucket refill rate). */
export const RELAY_RATE_BYTES_PER_SECOND: number = 512 * 1024;

/** Burst allowance of a socket's token bucket, in bytes - also the bucket's capacity. */
export const RELAY_BURST_BYTES: number = 1024 * 1024;

/** How long a socket may stay over budget continuously before it is closed with 1008 "Too much data.". */
export const RELAY_OVER_BUDGET_CLOSE_MS = 10_000;

/** Two over-budget drops further apart than this are separate episodes: a socket is "continuously" over budget only
 * while it keeps being dropped at least this often. A sender that exceeds its budget by a hair (one drop every few
 * seconds) is throttled but never closed; one that keeps sending well past it is closed after
 * `RELAY_OVER_BUDGET_CLOSE_MS`. */
export const RELAY_OVER_BUDGET_GRACE_MS = 1_000;

/** How long a new socket has to send its `hello` before it is closed with 1008 "Hello timeout.". */
export const RELAY_HELLO_TIMEOUT_MS = 10_000;

/** The longest peer id, in characters. Its UTF-8 encoding must also fit in the one length byte of a forwarded frame
 * (255), which `isValidRelayPeer()` enforces too. */
export const RELAY_MAX_PEER_LENGTH = 128;

/** The most peers one `want` message may name; further valid entries are ignored. */
export const RELAY_MAX_WANT_PEERS = 32;

/** The minimal socket surface the hub needs - satisfied by the framework's uWS/Bun/`ws` sockets and by a trivial
 * fake in a test. */
export interface RelaySocket {
    /** Sends a text or binary message. `cb` is called with an error when the message could not be sent - for the
     * framework's uWS shim that includes "dropped because the receiver's backpressure limit was reached". */
    send(data: string | Uint8Array, cb?: (err?: Error | null) => void): void;
    close(code?: number, reason?: string): void;
}

/** Receives every frame published to a room, whichever replica published it. */
export type RelayBusListener = (sender: string, frame: Buffer) => void;

/**
 * **The seam between sockets.** How a frame gets from the socket that sent it to the sockets that want it. The hub
 * never delivers directly: it `publish()`es the stamped frame and delivers whatever its own `subscribe()`d listener
 * receives, so a bus that also carries frames between server replicas (a Redis pub/sub channel per room, say) makes
 * the whole relay multi-replica without touching the hub. `InProcessRelayBus` delivers within this process only;
 * `RedisRelayBus` (`util/RedisRelayBus.ts`) also crosses server replicas over Redis pub/sub.
 */
export interface RelayBus {
    /** Registers `listener` for `roomId`'s frames - including frames this very process publishes - and returns a
     * function that removes it. */
    subscribe(roomId: string, listener: RelayBusListener): () => void;
    /** Publishes `frame` (the complete forwarded message, sender header included) that `sender` (a peer id) sent
     * to `roomId`. */
    publish(roomId: string, sender: string, frame: Buffer): void;
}

/** A `RelayBus` that delivers synchronously to the listeners of this one process - see `RelayHub`'s doc comment for
 * what that means for a deployment with several server replicas. */
export class InProcessRelayBus implements RelayBus {
    private readonly listeners: Map<string, Set<RelayBusListener>> = new Map();

    public subscribe(roomId: string, listener: RelayBusListener): () => void {
        let set: Set<RelayBusListener> | undefined = this.listeners.get(roomId);
        if (!set) {
            set = new Set();
            this.listeners.set(roomId, set);
        }
        set.add(listener);
        return () => {
            set.delete(listener);
            if (set.size === 0 && this.listeners.get(roomId) === set) {
                this.listeners.delete(roomId);
            }
        };
    }

    public publish(roomId: string, sender: string, frame: Buffer): void {
        for (const listener of this.listeners.get(roomId) ?? []) {
            listener(sender, frame);
        }
    }
}

/** What the hub tells a caller about one socket it accepted; the caller feeds it the socket's events. */
export interface RelayConnection {
    /** Handles one message received from the socket. Never throws, whatever the payload. */
    message(data: string | Uint8Array, isBinary: boolean): void;
    /** Handles the socket having closed. Idempotent, and safe after the hub itself closed the socket. */
    close(): void;
}

/** Counters of what the hub did with frames - for tests and diagnostics. */
export interface RelayStats {
    /** Frames handed to a receiver's `send()`, including any of them it then reported as dropped. */
    framesForwarded: number;
    /** Frames a receiver's `send()` reported as dropped (uWS backpressure) or threw on - a subset of the above,
     * apart from a throw, which is not counted as forwarded. */
    framesDroppedBackpressure: number;
    /** Frames dropped because their sender was over its token-bucket budget. */
    framesDroppedBudget: number;
    /** Frames dropped for being empty, oversized, or sent before `hello`. */
    framesDroppedInvalid: number;
}

export interface RelayHubOptions {
    /** Where frames travel between sockets. Defaults to a new `InProcessRelayBus`. */
    bus?: RelayBus;
    logger?: { debug(message: string): void };
    /** The largest binary message (and text message) a socket may send, and what `ready` tells the client. Defaults to
     * `RELAY_MAX_PAYLOAD_BYTES`; the route sets `RELAY_LARGE_PAYLOAD_BYTES` when the framework was asked for that much. */
    maxPayloadBytes?: number;
}

/**
 * Returns whether `peer` is a well-formed relay peer id: a string of 1 to `RELAY_MAX_PEER_LENGTH` characters with no
 * whitespace, separator, control or other invisible (Unicode category C or Z) character, whose UTF-8 encoding fits in
 * the single length byte of a forwarded frame.
 */
export function isValidRelayPeer(peer: unknown): peer is string {
    return (
        typeof peer === "string" &&
        peer.length >= 1 &&
        peer.length <= RELAY_MAX_PEER_LENGTH &&
        /^[^\s\p{C}\p{Z}]+$/u.test(peer) &&
        Buffer.byteLength(peer, "utf8") <= 255
    );
}

/**
 * Reads the `mail:videoconf:relay:enabled` setting. Environment-variable config arrives as a string ("true", "false",
 * "0", "1") and nconf may parse it into a boolean or a number, so all of those are accepted; `false`, `0`, `"false"`
 * and `"0"` (case-insensitive, trimmed) disable the relay and anything else - including an unset or unrecognizable
 * value - leaves it enabled, the default.
 */
export function parseRelayEnabled(value: unknown): boolean {
    if (typeof value === "string") {
        const normalized: string = value.trim().toLowerCase();
        return normalized !== "false" && normalized !== "0";
    }
    return value !== false && value !== 0;
}

function toBuffer(data: string | Uint8Array): Buffer {
    if (typeof data === "string") {
        return Buffer.from(data, "utf8");
    }
    return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** A token bucket: `capacity` tokens (bytes), refilled at `rate` per second, starting full. */
class TokenBucket {
    private tokens: number = RELAY_BURST_BYTES;
    private last: number;

    constructor(now: number) {
        this.last = now;
    }

    /** Takes `amount` tokens if that many are available; returns whether it did. */
    public take(amount: number, now: number): boolean {
        this.tokens = Math.min(RELAY_BURST_BYTES, this.tokens + ((now - this.last) / 1000) * RELAY_RATE_BYTES_PER_SECOND);
        this.last = now;
        if (this.tokens < amount) {
            return false;
        }
        this.tokens -= amount;
        return true;
    }
}

interface Room {
    id: string;
    /** Every accepted socket, including ones still awaiting their `hello`. */
    conns: Set<Connection>;
    /** Sockets that have said `hello`, by peer id. */
    peers: Map<string, Connection>;
    unsubscribe: () => void;
}

/** What a `Connection` needs from the hub that owns it. */
interface ConnectionEnv {
    stats: RelayStats;
    bus: RelayBus;
    /** The largest message a socket may send - see `RelayHubOptions.maxPayloadBytes`. */
    maxPayloadBytes: number;
    debug(message: string): void;
    /** Forgets a connection, and its room once that is empty. */
    remove(conn: Connection): void;
}

class Connection implements RelayConnection {
    public peer?: string;
    /** The peer ids this socket wants frames from - see `want`. */
    public wanted: Set<string> = new Set();
    private peerBytes?: Buffer;
    private closed = false;
    private helloTimer?: ReturnType<typeof setTimeout>;
    private readonly bucket: TokenBucket = new TokenBucket(Date.now());
    private overBudgetSince?: number;
    private lastOverBudget = 0;

    constructor(
        private readonly env: ConnectionEnv,
        public readonly room: Room,
        public readonly uid: string,
        private readonly socket: RelaySocket,
    ) {
        this.helloTimer = setTimeout(() => this.evict("Hello timeout."), RELAY_HELLO_TIMEOUT_MS);
        this.helloTimer.unref();
    }

    public message(data: string | Uint8Array, isBinary: boolean): void {
        if (this.closed) {
            return;
        }
        if (isBinary) {
            this.binary(toBuffer(data));
        } else {
            this.text(typeof data === "string" ? data : toBuffer(data).toString("utf8"));
        }
    }

    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearTimeout(this.helloTimer);
        this.env.remove(this);
    }

    /** Closes the socket from this side with 1008 and `reason`, and forgets it. Only ever called on a live
     * connection: `message()` ignores a closed one, its hello timer is cleared on close, and a closed one is no
     * longer in its room's `peers`. */
    public evict(reason: string): void {
        this.close();
        this.socket.close(1008, reason);
    }

    /** Sends `frame` to this socket. A send the socket reports as dropped, or throws on, is counted and skipped. */
    public forward(frame: Buffer): void {
        const fail = (err: unknown): void => {
            this.env.stats.framesDroppedBackpressure++;
            this.env.debug(`Dropped a relay frame for ${this.peer} in ${this.room.id}: ${(err as Error)?.message ?? err}`);
        };
        try {
            this.socket.send(frame, (err) => {
                if (err) {
                    fail(err);
                }
            });
            this.env.stats.framesForwarded++;
        } catch (err) {
            fail(err);
        }
    }

    /** Sends `text` to this socket, ignoring a failure - a lost `ready` shows as a client that never gets ready. */
    private sendText(text: string): void {
        try {
            this.socket.send(text);
        } catch {
            // The socket is going away; its close event cleans up.
        }
    }

    private text(text: string): void {
        // A character is at least one byte, so this bounds the parse below by the payload limit.
        if (text.length > this.env.maxPayloadBytes) {
            return;
        }
        let message: any;
        try {
            message = JSON.parse(text);
        } catch {
            return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
            return;
        }
        if (!this.peer) {
            if (message.op === "hello") {
                this.hello(message);
            }
        } else if (message.op === "want") {
            this.want(message);
        }
    }

    private hello(message: any): void {
        if (message.v !== RELAY_PROTOCOL_VERSION) {
            this.evict("Unsupported version.");
            return;
        }
        const peer: unknown = message.peer;
        if (!isValidRelayPeer(peer) || (peer !== this.uid && !peer.startsWith(`${this.uid}~`))) {
            this.evict("Invalid peer.");
            return;
        }
        // A reconnecting client's new socket replaces the old one, which may not have noticed it is dead yet.
        this.room.peers.get(peer)?.evict("Replaced.");
        this.room.peers.set(peer, this);
        this.peer = peer;
        this.peerBytes = Buffer.from(peer, "utf8");
        clearTimeout(this.helloTimer);
        this.sendText(JSON.stringify({ op: "ready", v: RELAY_PROTOCOL_VERSION, maxMessageBytes: this.env.maxPayloadBytes }));
    }

    private want(message: any): void {
        if (!Array.isArray(message.peers)) {
            return;
        }
        const wanted: Set<string> = new Set();
        for (const peer of message.peers) {
            if (wanted.size >= RELAY_MAX_WANT_PEERS) {
                break;
            }
            if (isValidRelayPeer(peer)) {
                wanted.add(peer);
            }
        }
        this.wanted = wanted;
    }

    private binary(payload: Buffer): void {
        if (!this.peer || payload.length === 0 || payload.length > this.env.maxPayloadBytes) {
            this.env.stats.framesDroppedInvalid++;
            return;
        }
        const now: number = Date.now();
        if (!this.bucket.take(payload.length, now)) {
            this.env.stats.framesDroppedBudget++;
            if (this.overBudgetSince === undefined || now - this.lastOverBudget > RELAY_OVER_BUDGET_GRACE_MS) {
                this.overBudgetSince = now;
            }
            this.lastOverBudget = now;
            if (now - this.overBudgetSince > RELAY_OVER_BUDGET_CLOSE_MS) {
                this.evict("Too much data.");
            }
            return;
        }
        // Stamped here from the `hello`, never read from the payload: [sender length][sender][payload].
        const sender: Buffer = this.peerBytes!;
        const frame: Buffer = Buffer.allocUnsafe(1 + sender.length + payload.length);
        frame[0] = sender.length;
        sender.copy(frame, 1);
        payload.copy(frame, 1 + sender.length);
        this.env.bus.publish(this.room.id, this.peer, frame);
    }
}

/**
 * A fan-out relay of opaque binary frames between the participants of a room (one meeting) - the last-resort tier
 * for participants whose network allows neither a direct WebRTC connection nor a TURN relay, only a WebSocket to this
 * server. It knows nothing about meetings, users, HTTP or any framework: a caller authorizes a socket however it
 * likes, hands it to `attach()` and feeds the returned `RelayConnection` the socket's `message` and `close` events.
 *
 * ## Wire protocol (version 1)
 *
 * Client to server, the first message must be a text message
 * `{"op":"hello","v":1,"peer":"<peerId>"}`, sent within `RELAY_HELLO_TIMEOUT_MS`. `peer` is the caller's uid (the `uid`
 * given to `attach()`) or starts with `<uid>~` - a per-tab or per-device id - and passes `isValidRelayPeer()`. Anything
 * else closes the socket with 1008 "Invalid peer."; a wrong `v` closes it with 1008 "Unsupported version.". The server
 * answers with the text message `{"op":"ready","v":1,"maxMessageBytes":<the limit below>}`. A second socket registering an already registered peer in the
 * same room replaces the older one, which is closed with 1008 "Replaced.".
 *
 * After that, `{"op":"want","peers":["<peerId>", ...]}` REPLACES the socket's interest set with the valid entries, at
 * most `RELAY_MAX_WANT_PEERS` of them; every other or malformed text message is ignored. Binary messages of 1 to
 * `RelayHubOptions.maxPayloadBytes` bytes (`RELAY_MAX_PAYLOAD_BYTES` unless the route asked for more; opaque to the hub) are forwarded to every other socket of the room whose interest
 * set contains the sender's peer id; binary before `hello`, empty and oversized messages are dropped.
 *
 * Server to client: `{"op":"ready","v":1,"maxMessageBytes":N}` once, then binary messages `[1 byte: UTF-8 length N of the sender's peer
 * id][N bytes: the sender's peer id][the original payload]`. The sender is stamped by the hub from the `hello`,
 * never trusted from the payload.
 *
 * ## Limits
 *
 * At most `RELAY_MAX_SOCKETS_PER_ROOM` sockets per room and `RELAY_MAX_SOCKETS_PER_UID` per uid per room, counting
 * a socket from `attach()` on (a socket refused for either is closed with 1008 "Room full." / "Too many
 * connections."). Each socket's inbound binary traffic is metered by a token bucket of `RELAY_RATE_BYTES_PER_SECOND`
 * sustained with a `RELAY_BURST_BYTES` burst: an over-budget message is dropped silently, and a socket kept over
 * budget for more than `RELAY_OVER_BUDGET_CLOSE_MS` (see `RELAY_OVER_BUDGET_GRACE_MS`) is closed with 1008 "Too
 * much data.". A receiver whose `send()` reports the message as dropped (uWS backpressure) simply misses that
 * frame - counted in `stats`, never queued or retried. Sockets and rooms are released when their socket closes; an
 * empty room is deleted.
 *
 * ## Replicas
 *
 * The transport between sockets is the `RelayBus` given to the constructor, `InProcessRelayBus` by default, which
 * delivers only within this process: **with several server replicas, participants whose sockets landed on different
 * replicas cannot relay to each other** - a room exists independently on each replica and its members see only the
 * members connected to the same one. Give the hub a `RedisRelayBus` and frames cross replicas over Redis pub/sub (one
 * channel per room; `BaseVideoMeetingRoute` does that whenever `datastores:events` is configured); nothing else in the
 * hub changes for it.
 *
 * Every limit above is enforced **per replica**, because a hub only knows its own sockets. A room's capacity across
 * replicas is therefore up to `replicas x RELAY_MAX_SOCKETS_PER_ROOM` sockets (and `replicas x
 * RELAY_MAX_SOCKETS_PER_UID` for one uid) in the worst case, where the load balancer spreads a meeting's sockets
 * evenly. A peer id that registers on two replicas is not detected as a duplicate either (the "Replaced." rule is
 * per replica), and each frame reaches every socket that wants its sender on every replica.
 *
 * @author Jean-Philippe Steinmetz
 */
export class RelayHub {
    /** What has happened to frames so far. */
    public readonly stats: RelayStats = {
        framesForwarded: 0,
        framesDroppedBackpressure: 0,
        framesDroppedBudget: 0,
        framesDroppedInvalid: 0,
    };

    private readonly bus: RelayBus;
    private readonly logger?: { debug(message: string): void };
    private readonly rooms: Map<string, Room> = new Map();
    private readonly env: ConnectionEnv;

    constructor(options: RelayHubOptions = {}) {
        this.bus = options.bus ?? new InProcessRelayBus();
        this.logger = options.logger;
        this.env = {
            stats: this.stats,
            bus: this.bus,
            maxPayloadBytes: options.maxPayloadBytes ?? RELAY_MAX_PAYLOAD_BYTES,
            debug: (message: string) => this.logger?.debug(message),
            remove: (conn: Connection) => this.remove(conn),
        };
    }

    /** The number of rooms that currently hold at least one socket. */
    public get roomCount(): number {
        return this.rooms.size;
    }

    /** The number of sockets in `roomId` (0 for an unknown room). */
    public socketCount(roomId: string): number {
        return this.rooms.get(roomId)?.conns.size ?? 0;
    }

    /**
     * Accepts an already-authorized `socket` of `uid` into room `roomId`, or refuses it (closing it with 1008) when
     * the room or the uid is at its limit. Returns the connection to feed the socket's events to, or `undefined`
     * when refused.
     */
    public attach(roomId: string, uid: string, socket: RelaySocket): RelayConnection | undefined {
        let room: Room | undefined = this.rooms.get(roomId);
        if (room) {
            if (room.conns.size >= RELAY_MAX_SOCKETS_PER_ROOM) {
                socket.close(1008, "Room full.");
                return undefined;
            }
            let ofUid = 0;
            for (const conn of room.conns) {
                if (conn.uid === uid) {
                    ofUid++;
                }
            }
            if (ofUid >= RELAY_MAX_SOCKETS_PER_UID) {
                socket.close(1008, "Too many connections.");
                return undefined;
            }
        } else {
            room = {
                id: roomId,
                conns: new Set(),
                peers: new Map(),
                unsubscribe: this.bus.subscribe(roomId, (sender, frame) => this.deliver(roomId, sender, frame)),
            };
            this.rooms.set(roomId, room);
        }
        const conn: Connection = new Connection(this.env, room, uid, socket);
        room.conns.add(conn);
        return conn;
    }

    /** Forgets `conn`, and its room once that is empty. */
    private remove(conn: Connection): void {
        const room: Room = conn.room;
        room.conns.delete(conn);
        if (conn.peer && room.peers.get(conn.peer) === conn) {
            room.peers.delete(conn.peer);
        }
        if (room.conns.size === 0 && this.rooms.get(room.id) === room) {
            room.unsubscribe();
            this.rooms.delete(room.id);
        }
    }

    /** Hands `frame` from `sender` to every other socket of room `roomId` that wants it. A bus that delivers
     * asynchronously (across replicas) may deliver a frame for a room that has just emptied; that is ignored. */
    private deliver(roomId: string, sender: string, frame: Buffer): void {
        for (const conn of this.rooms.get(roomId)?.peers.values() ?? []) {
            if (conn.peer !== sender && conn.wanted.has(sender)) {
                conn.forward(frame);
            }
        }
    }
}
