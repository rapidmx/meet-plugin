///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Where a meeting's waiting room (`VideoMeeting.waitingRoomEnabled`) keeps its admission requests between the requester's
 * `POST /join/:token/verify`, the host's admit or deny, and the requester's polls - which can each reach a different server
 * replica. With the deployment's `events` Redis (`datastores:events`, which the relay bus already needs to cross replicas) every
 * replica shares one hash per meeting (`RedisAdmissionStore`); without one they live in the process (`InMemoryAdmissionStore`), and a
 * waiting room only works when every request of one meeting reaches the same replica - the same limit signaling and the relay have
 * then. Either way a request lasts `ADMISSION_TTL_MS` from when it was filed, so an abandoned one goes away by itself.
 */
import { attachRedisErrorHandler, importRedis } from "@rapidrest/service-core";

/** How long an admission request is kept after it was filed (or filed again). */
export const ADMISSION_TTL_MS = 60 * 60 * 1000;

/** The most requests still waiting for the host's answer one meeting holds at a time - `BaseVideoMeetingRoute` refuses more. One
 * the host admitted or denied no longer counts, so the host can always clear a flood by denying it. */
export const MAX_PENDING_ADMISSIONS = 100;

/** The most of those waiting requests that may come from one network (`PendingAdmission.source`), so someone holding the link can't
 * fill the whole waiting room from one address. High enough for an office joining from behind one address. */
export const MAX_PENDING_ADMISSIONS_PER_SOURCE = 20;

/** The prefix of the Redis hash a meeting's requests are kept in: `videoconf:admissions:<meetingUid>`. */
export const REDIS_ADMISSIONS_KEY_PREFIX = "videoconf:admissions:";

/** How often `InMemoryAdmissionStore` drops every expired request, at most. */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** One admission request, filed under the requester's uid. It carries exactly one of `name` and `sealedName`. */
export interface PendingAdmission {
    /** The name the requester gave - never for a protected meeting, whose waiting room takes it only sealed. */
    name?: string;
    /** A protected meeting's requester name, sealed by the meet page with the meeting's live key (`specs/meeting_privacy.md` §6.1),
     * which the server never holds. */
    sealedName?: string;
    /** When it was filed, in epoch milliseconds. */
    requestedAt: number;
    status: "pending" | "admitted" | "denied";
    /** An opaque digest of the network the request came from (`BaseVideoMeetingRoute.admissionSource()`), for
     * `MAX_PENDING_ADMISSIONS_PER_SOURCE` - never the address itself. Absent when the request's address was unknown. */
    source?: string;
}

/** The admission requests of every meeting - see this module's doc comment. Expired requests are never returned. */
export interface AdmissionStore {
    /** Meeting `meetingUid`'s requests, by requester uid. */
    list(meetingUid: string): Promise<Map<string, PendingAdmission>>;
    get(meetingUid: string, uid: string): Promise<PendingAdmission | undefined>;
    /** Files or replaces `uid`'s request. */
    set(meetingUid: string, uid: string, request: PendingAdmission): Promise<void>;
    delete(meetingUid: string, uid: string): Promise<void>;
}

/** Whether `request` is still within `ADMISSION_TTL_MS` at `now`. */
function isLive(request: PendingAdmission, now: number): boolean {
    return now - request.requestedAt < ADMISSION_TTL_MS;
}

/** The requests of one process - see this module's doc comment. */
export class InMemoryAdmissionStore implements AdmissionStore {
    private readonly meetings = new Map<string, Map<string, PendingAdmission>>();
    private lastSweep = 0;

    constructor(private readonly now: () => number = Date.now) {}

    public async list(meetingUid: string): Promise<Map<string, PendingAdmission>> {
        this.sweep();
        const now = this.now();
        const live = new Map<string, PendingAdmission>();
        for (const [uid, request] of this.meetings.get(meetingUid) ?? []) {
            if (isLive(request, now)) {
                live.set(uid, { ...request });
            }
        }
        return live;
    }

    public async get(meetingUid: string, uid: string): Promise<PendingAdmission | undefined> {
        this.sweep();
        const request = this.meetings.get(meetingUid)?.get(uid);
        return request && isLive(request, this.now()) ? { ...request } : undefined;
    }

    public async set(meetingUid: string, uid: string, request: PendingAdmission): Promise<void> {
        this.sweep();
        let pending = this.meetings.get(meetingUid);
        if (!pending) {
            pending = new Map();
            this.meetings.set(meetingUid, pending);
        }
        pending.set(uid, { ...request });
    }

    public async delete(meetingUid: string, uid: string): Promise<void> {
        const pending = this.meetings.get(meetingUid);
        pending?.delete(uid);
        if (pending?.size === 0) {
            this.meetings.delete(meetingUid);
        }
    }

    /** Drops every expired request, of every meeting - at most once per `SWEEP_INTERVAL_MS`, so memory stays bounded by what was
     * filed within the last `ADMISSION_TTL_MS`. */
    private sweep(): void {
        const now = this.now();
        if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
            return;
        }
        this.lastSweep = now;
        for (const [meetingUid, pending] of this.meetings) {
            for (const [uid, request] of pending) {
                if (!isLive(request, now)) {
                    pending.delete(uid);
                }
            }
            if (pending.size === 0) {
                this.meetings.delete(meetingUid);
            }
        }
    }
}

/** The part of a node-redis client `RedisAdmissionStore` uses (structurally typed so the plugin needs no `redis` types). */
interface AdmissionRedisClient {
    connect(): Promise<unknown>;
    hGetAll(key: string): Promise<Record<string, string>>;
    hGet(key: string, field: string): Promise<string | null | undefined>;
    hSet(key: string, field: string, value: string): Promise<unknown>;
    hDel(key: string, field: string): Promise<unknown>;
    pExpire(key: string, milliseconds: number): Promise<unknown>;
    destroy(): void;
}

export interface RedisAdmissionStoreOptions {
    /** The `datastores:events` Redis URL. */
    url: string;
    logger: { debug(message: string): void; warn(message: string): void; error(message: string): void };
    now?: () => number;
}

/**
 * The requests every replica shares, on the `events` Redis - see this module's doc comment. One hash per meeting, a field per requester
 * holding its JSON; the hash itself expires `ADMISSION_TTL_MS` after its last write, and a request older than that is ignored (and
 * removed) on read. Commands are never queued while Redis is unreachable: a request then fails rather than hanging.
 */
export class RedisAdmissionStore implements AdmissionStore {
    private client?: AdmissionRedisClient;

    constructor(private readonly options: RedisAdmissionStoreOptions) {}

    /** Creates the client and starts connecting it, without waiting. Throws when the `redis` package is not installed or the URL is
     * unusable. Does nothing when already connected. */
    public async connect(): Promise<void> {
        if (this.client) {
            return;
        }
        const { createClient } = await importRedis();
        const client: AdmissionRedisClient = attachRedisErrorHandler(
            createClient({ url: this.options.url, disableOfflineQueue: true }),
            this.options.logger,
            "events (video meeting admissions)",
        );
        this.client = client;
        client.connect().catch((err: any) => this.options.logger.warn(`Video meeting admissions: couldn't connect to Redis yet: ${err?.message ?? err}`));
    }

    /** Destroys the client. Safe to call repeatedly. */
    public close(): void {
        const client = this.client;
        this.client = undefined;
        try {
            client?.destroy();
        } catch (err: any) {
            this.options.logger.warn(`Video meeting admissions: couldn't close the Redis client: ${err?.message ?? err}`);
        }
    }

    public async list(meetingUid: string): Promise<Map<string, PendingAdmission>> {
        const key = REDIS_ADMISSIONS_KEY_PREFIX + meetingUid;
        const raw: Record<string, string> = await this.redis().hGetAll(key);
        const live = new Map<string, PendingAdmission>();
        for (const [uid, value] of Object.entries(raw ?? {})) {
            const request = this.parse(value);
            if (request) {
                live.set(uid, request);
            } else {
                await this.redis().hDel(key, uid);
            }
        }
        return live;
    }

    public async get(meetingUid: string, uid: string): Promise<PendingAdmission | undefined> {
        return this.parse(await this.redis().hGet(REDIS_ADMISSIONS_KEY_PREFIX + meetingUid, uid));
    }

    public async set(meetingUid: string, uid: string, request: PendingAdmission): Promise<void> {
        const key = REDIS_ADMISSIONS_KEY_PREFIX + meetingUid;
        await this.redis().hSet(key, uid, JSON.stringify(request));
        await this.redis().pExpire(key, ADMISSION_TTL_MS);
    }

    public async delete(meetingUid: string, uid: string): Promise<void> {
        await this.redis().hDel(REDIS_ADMISSIONS_KEY_PREFIX + meetingUid, uid);
    }

    private redis(): AdmissionRedisClient {
        if (!this.client) {
            throw new Error("The video meeting admission store is closed.");
        }
        return this.client;
    }

    /** A stored request, or `undefined` when there is none, it is garbled, or it has expired. */
    private parse(value: string | null | undefined): PendingAdmission | undefined {
        if (typeof value !== "string") {
            return undefined;
        }
        let request: PendingAdmission;
        try {
            request = JSON.parse(value);
        } catch {
            return undefined;
        }
        if (
            !request ||
            (typeof request.name !== "string") === (typeof request.sealedName !== "string") ||
            (request.source !== undefined && typeof request.source !== "string") ||
            typeof request.requestedAt !== "number" ||
            !["pending", "admitted", "denied"].includes(request.status) ||
            !isLive(request, (this.options.now ?? Date.now)())
        ) {
            return undefined;
        }
        return request;
    }
}
