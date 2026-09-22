///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unlike the Mongo twin, `@Transactional()` on `persistMeeting()` opens a REAL transaction here - the SQL
// datasource supports them, where the standalone `MongoMemoryServer` the Mongo tests run against does not. So this
// file, not its twin, is what actually exercises the transactional path.
import { EventEmitter } from "events";
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource, RateLimiter, ACLUtils, ACLAction, AccessControlListSQL } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { MailPushRoute } from "@rapidmx/restapi";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "@rapidmx/restapi/sql";
import { VideoMeetingSQL } from "../../../src/models/sql/VideoMeetingSQL.js";
import { VideoMeetingInviteeSQL } from "../../../src/models/sql/VideoMeetingInviteeSQL.js";
import { VideoMeetingStatus, VideoMeetingVisibility } from "../../../src/models/types.js";
import { GUEST_JWT_TTL_SECONDS } from "../../../src/routes/BaseVideoMeetingRoute.js";
import { turnRestCredential } from "../../../src/util/IceServerUtils.js";
import { videoMeetingSecuritySuite } from "../videoMeetingSecuritySuite.js";

const redis = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("redis", () => ({ createClient: redis.createClient }));

describe("Route:VideoMeetingSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/video-meetings";
    let mailboxRepo: Repository<MailboxSQL>;
    let meetingRepo: Repository<VideoMeetingSQL>;
    let inviteeRepo: Repository<VideoMeetingInviteeSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    let mailbox: MailboxSQL;

    const owner: any = { uid: uuid.v4(), roles: [], scopes: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const stranger: any = { uid: uuid.v4(), roles: [], scopes: [], elevated: Date.now() };
    const strangerToken = JWTUtils.createTokenSync(config.get("auth"), stranger);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], scopes: [], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);
    const delegate: any = { uid: uuid.v4(), roles: [], scopes: [], elevated: Date.now() };
    const delegateToken = JWTUtils.createTokenSync(config.get("auth"), delegate);

    const authed = (token: string) => ({
        get: (url: string) => request(server.getApplication()).get(url).set("Authorization", "jwt " + token),
        post: (url: string) => request(server.getApplication()).post(url).set("Authorization", "jwt " + token),
        put: (url: string) => request(server.getApplication()).put(url).set("Authorization", "jwt " + token),
        delete: (url: string) => request(server.getApplication()).delete(url).set("Authorization", "jwt " + token),
    });

    beforeAll(async () => {
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (isSqlDataSource(conn)) {
            aclRepo = conn.getRepository(AccessControlListSQL);
        } else {
            throw new Error("Could not find sql acl connection");
        }
        conn = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            meetingRepo = conn.getRepository(VideoMeetingSQL);
            inviteeRepo = conn.getRepository(VideoMeetingInviteeSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        // Child rows first - these tables are shared on disk with every other SQL test file in the run.
        for (const repo of [inviteeRepo, meetingRepo, mailboxRepo]) {
            await repo.clear();
        }
        mailbox = await mailboxRepo.save(
            new MailboxSQL({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `ada-${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Ada Lovelace",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );
        await aclRepo.save({
            uid: mailbox.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: owner.uid, actions: [ACLAction.FULL] }],
            parentUid: "Mailbox",
        } as any);
    });

    describe("POST / (create)", () => {
        it("Creates a private meeting, minting one invitee with its own join token and resolved join URL.", async () => {
            const result = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "Weekly Sync", visibility: "private", invitees: [{ email: "Grace@Example.com", displayName: "Grace Hopper" }] });

            expect(result.status).toBe(200);
            expect(result.body.meeting.title).toBe("Weekly Sync");
            expect(result.body.meeting.mailboxUid).toBe(mailbox.uid);
            expect(result.body.meeting.visibility).toBe(VideoMeetingVisibility.PRIVATE);
            expect(result.body.meeting.status).toBe(VideoMeetingStatus.SCHEDULED);
            expect(result.body.meeting.publicSlug).toBeUndefined();
            expect(result.body.invitees).toHaveLength(1);
            expect(result.body.invitees[0].email).toBe("grace@example.com");
            expect(result.body.invitees[0].displayName).toBe("Grace Hopper");
            expect(result.body.publicJoinUrl).toBeUndefined();

            const invitees = await inviteeRepo.find();
            expect(invitees).toHaveLength(1);
            expect(invitees[0].joinToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(invitees[0].mailboxUid).toBe(mailbox.uid);
            expect(result.body.invitees[0].joinUrl).toBe(`https://videoconf.rapidmx-test.example.com/meet/${invitees[0].joinToken}`);
        });

        it("Creates a public meeting, minting a public slug and its resolved join URL.", async () => {
            const result = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "Town Hall", visibility: "public" });

            expect(result.status).toBe(200);
            expect(result.body.meeting.visibility).toBe(VideoMeetingVisibility.PUBLIC);
            expect(result.body.meeting.publicSlug).toMatch(/^[A-Za-z0-9_-]{11}$/);
            expect(result.body.invitees).toBeUndefined();
            expect(result.body.publicJoinUrl).toBe(`https://videoconf.rapidmx-test.example.com/meet/${result.body.meeting.publicSlug}`);
        });

        it("Persists optional calendarEventUid, startTime and endTime.", async () => {
            const start = "2099-06-01T13:00:00.000Z";
            const end = "2099-06-01T14:00:00.000Z";
            const result = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "Scheduled", visibility: "public", calendarEventUid: "event-1", startTime: start, endTime: end });

            expect(result.status).toBe(200);
            expect(result.body.meeting.calendarEventUid).toBe("event-1");
            expect(new Date(result.body.meeting.startTime).toISOString()).toBe(start);
            expect(new Date(result.body.meeting.endTime).toISOString()).toBe(end);
        });

        it("Omits joinUrl/publicJoinUrl when no public_url is configured.", async () => {
            const route: any = objectFactory.getInstance("routes.VideoMeetingRoute");
            const original = route.publicUrl;
            route.publicUrl = "";
            try {
                const priv = await authed(ownerToken)
                    .post(baseUrl)
                    .send({ mailboxUid: mailbox.uid, title: "No URL", visibility: "private", invitees: [{ email: "a@example.com" }] });
                expect(priv.body.invitees[0].joinUrl).toBeUndefined();

                const pub = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "No URL Public", visibility: "public" });
                expect(pub.body.publicJoinUrl).toBeUndefined();
            } finally {
                route.publicUrl = original;
            }
        });

        it("Rejects a missing mailboxUid (400).", async () => {
            const result = await authed(ownerToken).post(baseUrl).send({ title: "x", visibility: "private", invitees: [{ email: "a@example.com" }] });
            expect(result.status).toBe(400);
        });

        it("Rejects a missing/blank title (400).", async () => {
            const result = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "   ", visibility: "public" });
            expect(result.status).toBe(400);
        });

        it("Rejects a title over the length limit (400).", async () => {
            const result = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x".repeat(201), visibility: "public" });
            expect(result.status).toBe(400);
        });

        it("Rejects an invalid visibility value (400).", async () => {
            const result = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "everyone" });
            expect(result.status).toBe(400);
        });

        it("Rejects a private meeting with no invitees (400).", async () => {
            const result = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "private", invitees: [] });
            expect(result.status).toBe(400);
        });

        it("Rejects a private meeting with more than the maximum number of invitees (400).", async () => {
            const invitees = Array.from({ length: 51 }, (_, i) => ({ email: `user${i}@example.com` }));
            const result = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "private", invitees });
            expect(result.status).toBe(400);
        });

        it("Rejects an invitee with an invalid email (400).", async () => {
            const result = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "private", invitees: [{ email: "not-an-address" }] });
            expect(result.status).toBe(400);
        });

        it("Rejects an invitee with a displayName over the length limit (400).", async () => {
            const result = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "private", invitees: [{ email: "a@example.com", displayName: "x".repeat(201) }] });
            expect(result.status).toBe(400);
        });

        it("Rejects an unparseable startTime/endTime (400).", async () => {
            expect((await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public", startTime: "not-a-date" })).status).toBe(400);
            expect((await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public", endTime: "not-a-date" })).status).toBe(400);
        });

        it("Rejects a request with no body at all (400).", async () => {
            const result = await authed(ownerToken).post(baseUrl).send(undefined);
            expect(result.status).toBe(400);
        });
    });

    describe("GET / (find)", () => {
        it("Requires mailboxUid (400).", async () => {
            const result = await authed(ownerToken).get(baseUrl);
            expect(result.status).toBe(400);
        });

        it("Lists only the given mailbox's meetings, paged/limited when asked.", async () => {
            await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "One", visibility: "public" });
            await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "Two", visibility: "public" });

            const result = await authed(ownerToken).get(`${baseUrl}?mailboxUid=${mailbox.uid}`);
            expect(result.status).toBe(200);
            expect(result.body).toHaveLength(2);

            const limited = await authed(ownerToken).get(`${baseUrl}?mailboxUid=${mailbox.uid}&limit=1&page=0`);
            expect(limited.body).toHaveLength(1);
        });
    });

    describe("GET /:id (findById)", () => {
        it("Returns 404 for an unknown id.", async () => {
            const result = await authed(ownerToken).get(`${baseUrl}/${uuid.v4()}`);
            expect(result.status).toBe(404);
        });
    });

    describe("PUT /:id (update)", () => {
        it("Updates the title.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "Old", visibility: "public" });
            const result = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ title: "New" });
            expect(result.status).toBe(200);
            expect(result.body.title).toBe("New");
        });

        it("Cancels the meeting via status.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ status: "cancelled" });
            expect(result.status).toBe(200);
            expect(result.body.status).toBe(VideoMeetingStatus.CANCELLED);
        });

        it("Rejects an empty title (400).", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ title: "   " });
            expect(result.status).toBe(400);
        });

        it("Rejects any status other than 'cancelled' (400).", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ status: "active" });
            expect(result.status).toBe(400);
        });

        it("Rejects a body with nothing to update (400).", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({});
            expect(result.status).toBe(400);
        });

        it("Returns 404 for an unknown id.", async () => {
            const result = await authed(ownerToken).put(`${baseUrl}/${uuid.v4()}`).send({ title: "x" });
            expect(result.status).toBe(404);
        });
    });

    describe("DELETE /:id", () => {
        it("Deletes the meeting, its invitees, and its own per-record ACL.", async () => {
            const created = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "private", invitees: [{ email: "a@example.com" }] });
            const uid = created.body.meeting.uid;
            expect(await aclRepo.find({ where: { uid } })).toHaveLength(1);

            const result = await authed(ownerToken).delete(`${baseUrl}/${uid}`);
            expect(result.status).toBe(204);
            expect(await meetingRepo.find({ where: { uid } })).toHaveLength(0);
            expect(await inviteeRepo.find({ where: { meetingUid: uid } })).toHaveLength(0);
            expect(await aclRepo.find({ where: { uid } })).toHaveLength(0);
        });

        it("Returns 404 for an unknown id.", async () => {
            const result = await authed(ownerToken).delete(`${baseUrl}/${uuid.v4()}`);
            expect(result.status).toBe(404);
        });
    });

    describe("GET /join/:token", () => {
        it("Returns the meeting's public info, ICE servers and a usable guest token for a valid private token.", async () => {
            const created = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "Private Meeting", visibility: "private", invitees: [{ email: "a@example.com" }] });
            const joinToken = (await inviteeRepo.find({ where: { meetingUid: created.body.meeting.uid } }))[0].joinToken;

            const result = await request(server.getApplication()).get(`${baseUrl}/join/${joinToken}`);

            expect(result.status).toBe(200);
            expect(result.body.meeting.uid).toBe(created.body.meeting.uid);
            expect(result.body.meeting.title).toBe("Private Meeting");
            expect(result.body.meeting.visibility).toBe(VideoMeetingVisibility.PRIVATE);
            expect(result.body.meeting.hostDisplayName).toBe("Ada Lovelace");
            expect(result.body.meeting.mailboxUid).toBeUndefined();
            expect(result.body.iceServers.length).toBeGreaterThanOrEqual(2);
            expect(result.body.guestUid).toMatch(/^guest:/);
            expect(new Date(result.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
            expect(new Date(result.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + GUEST_JWT_TTL_SECONDS * 1000 + 5000);

            const decoded: any = await JWTUtils.decodeToken(config.get("auth"), result.body.token);
            expect(decoded.profile.uid).toBe(result.body.guestUid);
            expect(decoded.profile.roles).toEqual([]);
        });

        it("Falls back to no host display name when the mailbox no longer exists.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            await mailboxRepo.clear();

            const result = await request(server.getApplication()).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
            expect(result.status).toBe(200);
            expect(result.body.meeting.hostDisplayName).toBeUndefined();
        });

        it("Adds a TURN entry with a static credential when configured.", async () => {
            const route: any = objectFactory.getInstance("routes.VideoMeetingRoute");
            route.turnUrl = "turn:turn.example.com:3478";
            route.turnUsername = "static-user";
            route.turnCredential = "static-pass";
            try {
                const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
                const result = await request(server.getApplication()).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
                expect(result.body.iceServers).toContainEqual({ urls: "turn:turn.example.com:3478", username: "static-user", credential: "static-pass" });
            } finally {
                route.turnUrl = "";
                route.turnUsername = "";
                route.turnCredential = "";
            }
        });

        it("Adds a TURN entry with a time-limited REST credential when a shared secret is configured.", async () => {
            const route: any = objectFactory.getInstance("routes.VideoMeetingRoute");
            route.turnUrl = "turns:turn.example.com:5349";
            route.turnUsername = "alice";
            route.turnSharedSecret = "sharedsecret123";
            try {
                const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
                const before = Math.floor(Date.now() / 1000);
                const result = await request(server.getApplication()).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
                const turnServer = result.body.iceServers.find((s: any) => s.urls === "turns:turn.example.com:5349");
                expect(turnServer.username).toMatch(/^\d+:alice$/);
                const expiry = Number(turnServer.username.split(":")[0]);
                expect(expiry).toBeGreaterThanOrEqual(before);
                expect(turnServer.credential).toBe(turnRestCredential("sharedsecret123", "alice", expiry - before, new Date(before * 1000)).credential);
            } finally {
                route.turnUrl = "";
                route.turnUsername = "";
                route.turnSharedSecret = "";
            }
        });

        it("Rate limits repeated join attempts against the same token (429).", async () => {
            const rateLimiter: any = objectFactory.getInstance(RateLimiter);
            const original = rateLimiter.config;
            rateLimiter.config = { enabled: true, maxAttempts: 2, windowSeconds: 300, ip: { enabled: false } };
            try {
                const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
                const slug = created.body.meeting.publicSlug;
                expect((await request(server.getApplication()).get(`${baseUrl}/join/${slug}`)).status).toBe(200);
                expect((await request(server.getApplication()).get(`${baseUrl}/join/${slug}`)).status).toBe(200);
                const third = await request(server.getApplication()).get(`${baseUrl}/join/${slug}`);
                expect(third.status).toBe(429);
            } finally {
                rateLimiter.config = original;
            }
        });
    });

    videoMeetingSecuritySuite({
        app: () => server.getApplication(),
        baseUrl,
        mailboxUid: () => mailbox.uid,
        ownerToken: () => ownerToken,
        strangerToken: () => strangerToken,
        adminToken: () => adminToken,
        delegateToken: () => delegateToken,
        delegateUid: () => delegate.uid,
        grantMailboxAccess: async (userOrRoleId: string, actions: string[]) => {
            const acl: any = await aclRepo.findOne({ where: { uid: mailbox.uid } });
            acl.records.push({ userOrRoleId, actions });
            await aclRepo.save(acl);
            const aclUtils: ACLUtils | undefined = objectFactory.getInstance(ACLUtils);
            await aclUtils?.invalidateACLs([mailbox.uid]);
        },
        createPrivateMeeting: async () => {
            const created = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "Private", visibility: "private", invitees: [{ email: "a@example.com" }] });
            const invitee = (await inviteeRepo.find({ where: { meetingUid: created.body.meeting.uid } }))[0];
            return { uid: created.body.meeting.uid, joinToken: invitee.joinToken };
        },
        createPublicMeeting: async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "Public", visibility: "public" });
            return { uid: created.body.meeting.uid, publicSlug: created.body.meeting.publicSlug };
        },
        cancelMeeting: async (uid: string) => {
            await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ status: "cancelled" });
        },
    });

    describe("push channel access (real ACLs, fake Redis)", () => {
        beforeEach(() => {
            redis.createClient.mockReset().mockImplementation(() => ({
                on: vi.fn(),
                connect: vi.fn().mockResolvedValue(undefined),
                subscribe: vi.fn().mockResolvedValue(undefined),
                unsubscribe: vi.fn().mockResolvedValue(undefined),
                disconnect: vi.fn().mockResolvedValue(undefined),
                isOpen: true,
            }));
        });

        /** A `MailPushRoute` wired to the real ACL store, a fake socket for `user`. */
        async function connectPush(user: any): Promise<{ route: any; sock: any; granted: (channels: string[]) => Promise<string[]> }> {
            const route: any = new MailPushRoute();
            route.aclUtils = objectFactory.getInstance(ACLUtils);
            route.redisConfig = { url: "redis://fake" };
            route.logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
            route.redisPub = { publish: vi.fn().mockResolvedValue(1) };
            const sock: any = new EventEmitter();
            sock.readyState = 1;
            sock.send = vi.fn();
            sock.close = vi.fn();
            await route.connect(sock, user);
            let id = 1;
            const granted = async (channels: string[]): Promise<string[]> => {
                const requestId: number = id++;
                sock.emit("message", JSON.stringify({ id: requestId, type: "SUBSCRIBE", data: channels }), false);
                for (let i = 0; i < 200; i++) {
                    const reply = sock.send.mock.calls.map((c: any[]) => JSON.parse(c[0])).find((m: any) => m.id === requestId);
                    if (reply) {
                        return reply.data;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 5));
                }
                throw new Error("no SUBSCRIBED reply");
            };
            return { route, sock, granted };
        }

        it("Grants the owner READ (subscribe) and CREATE (publish) on their own meeting's channel.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const meetingUid = created.body.meeting.uid;

            const { granted } = await connectPush(owner);
            expect(await granted([meetingUid])).toEqual([meetingUid]);

            const { route } = await connectPush(owner);
            await route.send(meetingUid, { type: "offer" }, owner);
            expect(route.redisPub.publish).toHaveBeenCalledTimes(1);
        });

        it("Grants a joined guest READ and CREATE on that one meeting's channel, and nothing else.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const meetingUid = created.body.meeting.uid;
            const joined = await request(server.getApplication()).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
            const guest: any = { uid: joined.body.guestUid, roles: [], scopes: [], elevated: -1 };

            const { granted } = await connectPush(guest);
            expect(await granted([meetingUid, mailbox.uid, uuid.v4()])).toEqual([meetingUid]);

            const { route } = await connectPush(guest);
            await route.send(meetingUid, { type: "answer" }, guest);
            expect(route.redisPub.publish).toHaveBeenCalledTimes(1);
        });

        it("Grants an unrelated caller nothing on the meeting's channel.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const meetingUid = created.body.meeting.uid;

            const { granted } = await connectPush(stranger);
            expect(await granted([meetingUid])).toEqual([]);

            const forStranger = await connectPush(stranger);
            await expect(forStranger.route.send(meetingUid, { type: "x" }, stranger)).rejects.toMatchObject({ status: 403 });
        });

        it("Never grants a trusted+elevated administrator with no explicit grant on the meeting's channel.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const meetingUid = created.body.meeting.uid;

            const { granted } = await connectPush(admin);
            expect(await granted([meetingUid])).toEqual([]);
        });

        it("Distinguishes two guests of the same public meeting as two different identities.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const slug = created.body.meeting.publicSlug;
            const joinedA = await request(server.getApplication()).get(`${baseUrl}/join/${slug}`);
            const joinedB = await request(server.getApplication()).get(`${baseUrl}/join/${slug}`);

            expect(joinedA.body.guestUid).not.toBe(joinedB.body.guestUid);

            const guestA: any = { uid: joinedA.body.guestUid, roles: [], scopes: [], elevated: -1 };
            const guestB: any = { uid: joinedB.body.guestUid, roles: [], scopes: [], elevated: -1 };
            expect(await (await connectPush(guestA)).granted([created.body.meeting.uid])).toEqual([created.body.meeting.uid]);
            expect(await (await connectPush(guestB)).granted([created.body.meeting.uid])).toEqual([created.body.meeting.uid]);
        });
    });
});
