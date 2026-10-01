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
import { CalendarEventAttendeeLinkSQL, MailboxSQL } from "@rapidmx/restapi/sql";
import { VideoMeetingSQL } from "../../../src/models/sql/VideoMeetingSQL.js";
import { VideoMeetingInviteeSQL } from "../../../src/models/sql/VideoMeetingInviteeSQL.js";
import { VideoMeetingStatus, VideoMeetingVisibility } from "../../../src/models/types.js";
import { GUEST_JWT_TTL_SECONDS, GUEST_UID_PREFIX } from "../../../src/routes/BaseVideoMeetingRoute.js";
import { turnRestCredential } from "../../../src/util/IceServerUtils.js";
import { effectsSuite } from "../effectsSuite.js";
import { relaySuite } from "../relaySuite.js";
import { personalRoomSuite } from "../personalRoomSuite.js";
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
    let linkRepo: Repository<CalendarEventAttendeeLinkSQL>;
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

    const findLinks = async (): Promise<CalendarEventAttendeeLinkSQL[]> => await linkRepo.find();

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
            linkRepo = conn.getRepository(CalendarEventAttendeeLinkSQL);
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
        for (const repo of [linkRepo, inviteeRepo, meetingRepo, mailboxRepo]) {
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
            expect(result.body.meeting.organizerSlug).toMatch(/^[A-Za-z0-9_-]{11}$/);
            expect(result.body.organizerJoinUrl).toBe(`https://videoconf.rapidmx-test.example.com/meet/${result.body.meeting.organizerSlug}`);
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
            expect(result.body.meeting.organizerSlug).toBeUndefined();
            expect(result.body.invitees).toBeUndefined();
            expect(result.body.publicJoinUrl).toBe(`https://videoconf.rapidmx-test.example.com/meet/${result.body.meeting.publicSlug}`);
            expect(result.body.organizerJoinUrl).toBeUndefined();
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

        it("Persists forceMuteOnJoin when creating with it set, and returns it to the owner on join().", async () => {
            const result = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "public", forceMuteOnJoin: true });
            expect(result.status).toBe(200);
            expect(result.body.meeting.forceMuteOnJoin).toBe(true);

            const joined = await request(server.getApplication()).get(`${baseUrl}/join/${result.body.meeting.publicSlug}`);
            expect(joined.body.meeting.forceMuteOnJoin).toBe(true);
        });

        it("Omits forceMuteOnJoin from join() when it was never set.", async () => {
            const result = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const joined = await request(server.getApplication()).get(`${baseUrl}/join/${result.body.meeting.publicSlug}`);
            expect(joined.body.meeting.forceMuteOnJoin).toBeUndefined();
        });

        it("Rejects a non-boolean forceMuteOnJoin (400).", async () => {
            const result = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "public", forceMuteOnJoin: "yes" });
            expect(result.status).toBe(400);
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
                expect(priv.body.organizerJoinUrl).toBeUndefined();

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

        it("Sets and clears forceMuteOnJoin.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const uid = created.body.meeting.uid;

            const set = await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ forceMuteOnJoin: true });
            expect(set.status).toBe(200);
            expect(set.body.forceMuteOnJoin).toBe(true);

            const cleared = await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ forceMuteOnJoin: false });
            expect(cleared.status).toBe(200);
            expect(cleared.body.forceMuteOnJoin).toBe(false);
        });

        it("Rejects a non-boolean forceMuteOnJoin (400).", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ forceMuteOnJoin: "yes" });
            expect(result.status).toBe(400);
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

    describe("calendar invite attendee links", () => {
        const privateBody = (extra: Record<string, any> = {}) => ({
            mailboxUid: mailbox.uid,
            title: "Invite Links",
            visibility: "private",
            calendarEventUid: "event-1",
            invitees: [{ email: "  Grace@Example.com " }, { email: "alan@example.com" }],
            ...extra,
        });

        it("Writes one link per invitee for a private meeting with a calendarEventUid, carrying that invitee's exact join URL and normalized address.", async () => {
            const result = await authed(ownerToken).post(baseUrl).send(privateBody());

            expect(result.status).toBe(200);
            const links = await findLinks();
            expect(links).toHaveLength(2);
            for (const invitee of result.body.invitees) {
                const link = links.find((l) => l.attendeeAddress === invitee.email)!;
                expect(link).toBeDefined();
                expect(link.url).toBe(invitee.joinUrl);
                expect(link.mailboxUid).toBe(mailbox.uid);
                expect(link.calendarEventUid).toBe("event-1");
                expect(link.label).toBe("Join video call");
            }
            expect(links.map((l) => l.attendeeAddress).sort()).toEqual(["alan@example.com", "grace@example.com"]);
            // Each invitee's link is their own: no two share a URL, and none is the organizer's link.
            expect(new Set(links.map((l) => l.url)).size).toBe(2);
            expect(links.map((l) => l.url)).not.toContain(result.body.organizerJoinUrl);
        });

        it("Writes no links for a public meeting, even with a calendarEventUid.", async () => {
            const result = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "Town Hall", visibility: "public", calendarEventUid: "event-1" });
            expect(result.status).toBe(200);
            expect(await findLinks()).toHaveLength(0);
        });

        it("Writes no links for a private meeting with no calendarEventUid.", async () => {
            const result = await authed(ownerToken).post(baseUrl).send(privateBody({ calendarEventUid: undefined }));
            expect(result.status).toBe(200);
            expect(await findLinks()).toHaveLength(0);
        });

        it("Writes no links when no public url is configured (there is no join URL to put in one).", async () => {
            const route: any = objectFactory.getInstance("routes.VideoMeetingRoute");
            const original = route.publicUrl;
            route.publicUrl = "";
            try {
                const result = await authed(ownerToken).post(baseUrl).send(privateBody());
                expect(result.status).toBe(200);
                expect(await findLinks()).toHaveLength(0);
            } finally {
                route.publicUrl = original;
            }
        });

        it("Deletes the meeting's links with the meeting, leaving other events' and other meetings' links alone.", async () => {
            const first = await authed(ownerToken).post(baseUrl).send(privateBody());
            const sameEvent = await authed(ownerToken).post(baseUrl).send(privateBody({ invitees: [{ email: "zed@example.com" }] }));
            const otherEvent = await authed(ownerToken).post(baseUrl).send(privateBody({ calendarEventUid: "event-2" }));
            expect(await findLinks()).toHaveLength(5);

            const result = await authed(ownerToken).delete(`${baseUrl}/${first.body.meeting.uid}`);

            expect(result.status).toBe(204);
            const remaining = await findLinks();
            expect(remaining.map((l) => l.url).sort()).toEqual(
                [...sameEvent.body.invitees, ...otherEvent.body.invitees].map((i: any) => i.joinUrl).sort(),
            );
        });

        it("Deletes the meeting's links when it is cancelled, but keeps them for an ordinary title update.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send(privateBody());

            const renamed = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ title: "Renamed" });
            expect(renamed.status).toBe(200);
            expect(await findLinks()).toHaveLength(2);

            const cancelled = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ status: "cancelled" });
            expect(cancelled.status).toBe(200);
            expect(await findLinks()).toHaveLength(0);
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
            expect(result.body.authenticated).toBe(false);
            expect(result.body.selfUid).toMatch(/^guest:/);
            expect(new Date(result.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
            expect(new Date(result.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + GUEST_JWT_TTL_SECONDS * 1000 + 5000);

            const decoded: any = await JWTUtils.decodeToken(config.get("auth"), result.body.token);
            expect(decoded.profile.uid).toBe(result.body.selfUid);
            expect(decoded.profile.roles).toEqual([]);
        });

        it("Grants the caller's own real uid (no guest token minted) when already authenticated.", async () => {
            const created = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "Private Meeting", visibility: "private", invitees: [{ email: "a@example.com" }] });
            const joinToken = (await inviteeRepo.find({ where: { meetingUid: created.body.meeting.uid } }))[0].joinToken;

            const result = await authed(strangerToken).get(`${baseUrl}/join/${joinToken}`);

            expect(result.status).toBe(200);
            expect(result.body.authenticated).toBe(true);
            expect(result.body.selfUid).toBe(stranger.uid);
            expect(result.body.token).toBeUndefined();
            expect(result.body.expiresAt).toBeUndefined();

            const acl: any = await aclRepo.findOne({ where: { uid: created.body.meeting.uid } });
            const record = acl.records.find((r: any) => r.userOrRoleId === stranger.uid);
            expect(record?.actions).toEqual(expect.arrayContaining([ACLAction.READ, ACLAction.CREATE]));
        });

        it("Mints a real channel grant for the caller's own uid when joining a private meeting via its organizer slug.", async () => {
            // A delegate holding only READ/LIST on the mailbox - a caller with real permission but, unlike the
            // creator, no pre-existing record of their own on the meeting's ACL, so the grant this proves is the
            // one join() just made and nothing else.
            const mailboxAcl: any = await aclRepo.findOne({ where: { uid: mailbox.uid } });
            mailboxAcl.records.push({ userOrRoleId: delegate.uid, actions: [ACLAction.READ, ACLAction.LIST] });
            await aclRepo.save(mailboxAcl);
            await objectFactory.getInstance(ACLUtils)?.invalidateACLs([mailbox.uid]);

            const created = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "Organizer Slug Meeting", visibility: "private", invitees: [{ email: "a@example.com" }] });
            const meetingUid = created.body.meeting.uid;
            const before: any = await aclRepo.findOne({ where: { uid: meetingUid } });
            expect(before.records.find((r: any) => r.userOrRoleId === delegate.uid)).toBeUndefined();

            const result = await authed(delegateToken).get(`${baseUrl}/join/${created.body.meeting.organizerSlug}`);

            expect(result.status).toBe(200);
            expect(result.body.authenticated).toBe(true);
            expect(result.body.selfUid).toBe(delegate.uid);
            expect(result.body.token).toBeUndefined();
            expect(result.body.meeting.visibility).toBe(VideoMeetingVisibility.PRIVATE);

            const acl: any = await aclRepo.findOne({ where: { uid: meetingUid } });
            const record = acl.records.find((r: any) => r.userOrRoleId === delegate.uid);
            expect(record?.actions).toEqual(expect.arrayContaining([ACLAction.READ, ACLAction.CREATE]));
        });

        it("Treats a returning guest presenting its own prior guest JWT as still anonymous, not as an authenticated real user.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const first = await request(server.getApplication()).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
            expect(first.body.selfUid.startsWith(GUEST_UID_PREFIX)).toBe(true);

            const second = await authed(first.body.token).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
            expect(second.status).toBe(200);
            expect(second.body.authenticated).toBe(false);
            expect(second.body.selfUid.startsWith(GUEST_UID_PREFIX)).toBe(true);
            expect(second.body.token).toBeTruthy();
            expect(second.body.selfUid).not.toBe(first.body.selfUid);
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
                expect(result.body.iceServers).toContainEqual({ urls: ["turn:turn.example.com:3478", "turn:turn.example.com:3478?transport=tcp"], username: "static-user", credential: "static-pass" });
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

    describe("password-protected meetings (GET /join/:token, POST /join/:token/verify)", () => {
        const createProtected = async (password = "s3cret") => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "Protected", visibility: "public", password });
            return created.body.meeting as { uid: string; publicSlug: string };
        };

        it("Persists a hash (never the plaintext, never in create()'s own response) when creating with a password.", async () => {
            const meeting = await createProtected("s3cret");
            expect(meeting.passwordHash).toBeUndefined();
            const row = await meetingRepo.findOne({ where: { uid: meeting.uid } });
            expect(row!.passwordHash).toBeTruthy();
            expect(row!.passwordHash).not.toBe("s3cret");
        });

        it("Sets no passwordHash at all when none was given.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const row = await meetingRepo.findOne({ where: { uid: created.body.meeting.uid } });
            expect(row!.passwordHash).toBeFalsy();
        });

        it("Returns requiresPassword with no grant at all from GET /join/:token when a password is set.", async () => {
            const meeting = await createProtected();
            const result = await request(server.getApplication()).get(`${baseUrl}/join/${meeting.publicSlug}`);

            expect(result.status).toBe(200);
            expect(result.body.requiresPassword).toBe(true);
            expect(result.body.meeting.hasPassword).toBe(true);
            expect(result.body.meeting.title).toBe("Protected");
            expect(result.body.iceServers).toBeUndefined();
            expect(result.body.authenticated).toBeUndefined();
            expect(result.body.selfUid).toBeUndefined();
            expect(result.body.token).toBeUndefined();
        });

        it("Grants a full join via POST /join/:token/verify with the correct password.", async () => {
            const meeting = await createProtected("s3cret");
            const result = await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ password: "s3cret" });

            expect(result.status).toBe(200);
            expect(result.body.requiresPassword).toBeUndefined();
            expect(result.body.authenticated).toBe(false);
            expect(result.body.selfUid).toMatch(/^guest:/);
            expect(result.body.iceServers.length).toBeGreaterThanOrEqual(2);
        });

        it("Rejects an incorrect password with 403, granting nothing.", async () => {
            const meeting = await createProtected("s3cret");
            const result = await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ password: "wrong" });
            expect(result.status).toBe(403);
            expect(result.body.selfUid).toBeUndefined();
        });

        it("Rejects a missing password with 403.", async () => {
            const meeting = await createProtected("s3cret");
            const result = await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({});
            expect(result.status).toBe(403);
        });

        it("Succeeds unconditionally via verify() when the meeting has no password at all.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await request(server.getApplication())
                .post(`${baseUrl}/join/${created.body.meeting.publicSlug}/verify`)
                .send({});
            expect(result.status).toBe(200);
            expect(result.body.authenticated).toBe(false);
        });

        it("Lets the real, already-authenticated organizer bypass the password entirely via their own organizerSlug.", async () => {
            const created = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "private", invitees: [{ email: "a@example.com" }], password: "s3cret" });
            const result = await authed(ownerToken).get(`${baseUrl}/join/${created.body.meeting.organizerSlug}`);
            expect(result.status).toBe(200);
            expect(result.body.requiresPassword).toBeUndefined();
            expect(result.body.authenticated).toBe(true);
        });

        it("Sets, replaces, and clears the password via PUT /:id, each time hashing or nulling server-side.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const uid = created.body.meeting.uid;
            const slug = created.body.meeting.publicSlug;
            expect((await request(server.getApplication()).get(`${baseUrl}/join/${slug}`)).body.requiresPassword).toBeUndefined();

            const set = await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ password: "first" });
            expect(set.status).toBe(200);
            expect(set.body.passwordHash).toBeUndefined();
            expect((await request(server.getApplication()).get(`${baseUrl}/join/${slug}`)).body.requiresPassword).toBe(true);
            expect((await request(server.getApplication()).post(`${baseUrl}/join/${slug}/verify`).send({ password: "first" })).status).toBe(200);

            await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ password: "second" });
            expect((await request(server.getApplication()).post(`${baseUrl}/join/${slug}/verify`).send({ password: "first" })).status).toBe(403);
            expect((await request(server.getApplication()).post(`${baseUrl}/join/${slug}/verify`).send({ password: "second" })).status).toBe(200);

            const cleared = await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ password: null });
            expect(cleared.status).toBe(200);
            const afterClear = await request(server.getApplication()).get(`${baseUrl}/join/${slug}`);
            expect(afterClear.body.requiresPassword).toBeUndefined();
            expect(afterClear.body.authenticated).toBe(false);
        });

        it("Rejects an empty-string password on update (400) - use null to clear instead.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ password: "" });
            expect(result.status).toBe(400);
        });

        it("Rejects a non-string, non-null password on update (400).", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ password: 12345 });
            expect(result.status).toBe(400);
        });

        it("Rejects a password over the length limit on create (400).", async () => {
            const result = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "public", password: "x".repeat(201) });
            expect(result.status).toBe(400);
        });

        it("Never includes passwordHash in find()/findById() responses even when one is set.", async () => {
            const meeting = await createProtected();
            const listed = await authed(ownerToken).get(`${baseUrl}?mailboxUid=${mailbox.uid}`);
            expect(listed.body.find((m: any) => m.uid === meeting.uid).passwordHash).toBeUndefined();
            const read = await authed(ownerToken).get(`${baseUrl}/${meeting.uid}`);
            expect(read.body.passwordHash).toBeUndefined();
        });
    });

    describe("waiting room (GET /join/:token, POST /join/:token/verify, GET /join/:token/status, waiting/admit/deny)", () => {
        const createWaiting = async (extra: Record<string, any> = {}) => {
            const created = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "Waiting Room", visibility: "public", waitingRoomEnabled: true, ...extra });
            return created.body.meeting as { uid: string; publicSlug: string; organizerSlug?: string };
        };

        it("Sets and clears waitingRoomEnabled via PUT /:id.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const uid = created.body.meeting.uid;

            const set = await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ waitingRoomEnabled: true });
            expect(set.status).toBe(200);
            expect(set.body.waitingRoomEnabled).toBe(true);

            const cleared = await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ waitingRoomEnabled: false });
            expect(cleared.status).toBe(200);
            expect(cleared.body.waitingRoomEnabled).toBe(false);
        });

        it("Rejects a non-boolean waitingRoomEnabled on create and update (400).", async () => {
            const create = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "public", waitingRoomEnabled: "yes" });
            expect(create.status).toBe(400);

            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const update = await authed(ownerToken).put(`${baseUrl}/${created.body.meeting.uid}`).send({ waitingRoomEnabled: "yes" });
            expect(update.status).toBe(400);
        });

        it("Returns requiresAdmission with no grant at all from GET /join/:token when enabled.", async () => {
            const meeting = await createWaiting();
            const result = await request(server.getApplication()).get(`${baseUrl}/join/${meeting.publicSlug}`);

            expect(result.status).toBe(200);
            expect(result.body.requiresAdmission).toBe(true);
            expect(result.body.meeting.waitingRoomEnabled).toBe(true);
            expect(result.body.iceServers).toBeUndefined();
            expect(result.body.selfUid).toBeUndefined();
        });

        it("Rejects an admission request with no name (400).", async () => {
            const meeting = await createWaiting();
            const result = await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({});
            expect(result.status).toBe(400);
        });

        it("Files a guest's admission request, returning a usable guest token to poll with, still gated.", async () => {
            const meeting = await createWaiting();
            const result = await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ name: "Grace" });

            expect(result.status).toBe(200);
            expect(result.body.requiresAdmission).toBe(true);
            expect(result.body.authenticated).toBe(false);
            expect(result.body.selfUid).toMatch(/^guest:/);
            expect(result.body.token).toBeTruthy();
            expect(result.body.iceServers).toBeUndefined();
        });

        it("Lists nothing for a meeting nobody has ever requested admission to.", async () => {
            const meeting = await createWaiting();
            const waiting = await authed(ownerToken).get(`${baseUrl}/${meeting.uid}/waiting`);
            expect(waiting.status).toBe(200);
            expect(waiting.body).toEqual([]);
        });

        it("Lists more than one pending request, oldest first.", async () => {
            const meeting = await createWaiting();
            await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ name: "Alice" });
            await new Promise((resolve) => setTimeout(resolve, 5));
            await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ name: "Bob" });

            const waiting = await authed(ownerToken).get(`${baseUrl}/${meeting.uid}/waiting`);
            expect(waiting.body.map((r: any) => r.name)).toEqual(["Alice", "Bob"]);
        });

        it("Lists a filed request to the host, admits it, and grants full access once the guest polls again.", async () => {
            const meeting = await createWaiting();
            const filed = await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ name: "Grace" });
            const guestUid = filed.body.selfUid;
            const guestToken = filed.body.token;

            const waiting = await authed(ownerToken).get(`${baseUrl}/${meeting.uid}/waiting`);
            expect(waiting.status).toBe(200);
            expect(waiting.body).toEqual([{ uid: guestUid, name: "Grace", requestedAt: expect.any(String) }]);

            const stillPending = await authed(guestToken).get(`${baseUrl}/join/${meeting.publicSlug}/status`);
            expect(stillPending.status).toBe(200);
            expect(stillPending.body.requiresAdmission).toBe(true);

            const admitted = await authed(ownerToken).post(`${baseUrl}/${meeting.uid}/admit/${guestUid}`);
            expect(admitted.status).toBe(204);

            const granted = await authed(guestToken).get(`${baseUrl}/join/${meeting.publicSlug}/status`);
            expect(granted.status).toBe(200);
            expect(granted.body.requiresAdmission).toBeUndefined();
            expect(granted.body.authenticated).toBe(false);
            expect(granted.body.selfUid).toBe(guestUid);
            expect(granted.body.iceServers.length).toBeGreaterThanOrEqual(2);

            // Resolved, so the host's waiting list is empty again and a repeat poll answers 404.
            expect((await authed(ownerToken).get(`${baseUrl}/${meeting.uid}/waiting`)).body).toEqual([]);
            expect((await authed(guestToken).get(`${baseUrl}/join/${meeting.publicSlug}/status`)).status).toBe(404);
        });

        it("Denies a request, answering 403 on the next poll and removing it from the waiting list.", async () => {
            const meeting = await createWaiting();
            const filed = await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ name: "Grace" });
            const guestUid = filed.body.selfUid;
            const guestToken = filed.body.token;

            const denied = await authed(ownerToken).post(`${baseUrl}/${meeting.uid}/deny/${guestUid}`);
            expect(denied.status).toBe(204);

            const result = await authed(guestToken).get(`${baseUrl}/join/${meeting.publicSlug}/status`);
            expect(result.status).toBe(403);

            expect((await authed(guestToken).get(`${baseUrl}/join/${meeting.publicSlug}/status`)).status).toBe(404);
        });

        it("Is a no-op (still 204) to admit or deny a uid with no pending request.", async () => {
            const meeting = await createWaiting();
            expect((await authed(ownerToken).post(`${baseUrl}/${meeting.uid}/admit/${uuid.v4()}`)).status).toBe(204);
            expect((await authed(ownerToken).post(`${baseUrl}/${meeting.uid}/deny/${uuid.v4()}`)).status).toBe(204);
        });

        it("Rejects polling with no authentication at all.", async () => {
            const meeting = await createWaiting();
            await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ name: "Grace" });
            const result = await request(server.getApplication()).get(`${baseUrl}/join/${meeting.publicSlug}/status`);
            expect(result.status).toBeGreaterThanOrEqual(400);
        });

        it("Returns 404 polling for an identity that never requested admission.", async () => {
            const meeting = await createWaiting();
            const result = await authed(strangerToken).get(`${baseUrl}/join/${meeting.publicSlug}/status`);
            expect(result.status).toBe(404);
        });

        it("Grants an already-authenticated real caller their own uid directly, with no guest token minted.", async () => {
            const meeting = await createWaiting();
            const filed = await authed(strangerToken).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ name: "Stranger" });
            expect(filed.body.authenticated).toBe(true);
            expect(filed.body.selfUid).toBe(stranger.uid);
            expect(filed.body.token).toBeUndefined();

            await authed(ownerToken).post(`${baseUrl}/${meeting.uid}/admit/${stranger.uid}`);
            const granted = await authed(strangerToken).get(`${baseUrl}/join/${meeting.publicSlug}/status`);
            expect(granted.status).toBe(200);
            expect(granted.body.authenticated).toBe(true);
            expect(granted.body.selfUid).toBe(stranger.uid);
        });

        it("Lets the organizer bypass the waiting room entirely via their own organizerSlug.", async () => {
            const created = await authed(ownerToken)
                .post(baseUrl)
                .send({ mailboxUid: mailbox.uid, title: "x", visibility: "private", invitees: [{ email: "a@example.com" }], waitingRoomEnabled: true });
            const result = await authed(ownerToken).get(`${baseUrl}/join/${created.body.meeting.organizerSlug}`);
            expect(result.status).toBe(200);
            expect(result.body.requiresAdmission).toBeUndefined();
            expect(result.body.authenticated).toBe(true);
        });

        it("Reports requiresAdmission, not requiresPassword, from GET /join/:token when both are set - and verify() requires both on one combined submission.", async () => {
            const meeting = await createWaiting({ password: "s3cret" });
            const result = await request(server.getApplication()).get(`${baseUrl}/join/${meeting.publicSlug}`);
            expect(result.body.requiresAdmission).toBe(true);
            expect(result.body.requiresPassword).toBeUndefined();
            expect(result.body.meeting.hasPassword).toBe(true);

            const wrongPassword = await request(server.getApplication())
                .post(`${baseUrl}/join/${meeting.publicSlug}/verify`)
                .send({ password: "wrong", name: "Grace" });
            expect(wrongPassword.status).toBe(403);

            const noName = await request(server.getApplication()).post(`${baseUrl}/join/${meeting.publicSlug}/verify`).send({ password: "s3cret" });
            expect(noName.status).toBe(400);

            const both = await request(server.getApplication())
                .post(`${baseUrl}/join/${meeting.publicSlug}/verify`)
                .send({ password: "s3cret", name: "Grace" });
            expect(both.status).toBe(200);
            expect(both.body.requiresAdmission).toBe(true);
        });

        describe("waiting-room host route authorization", () => {
            it("Rejects a caller with no account at all on every host route.", async () => {
                const meeting = await createWaiting();
                expect((await request(server.getApplication()).get(`${baseUrl}/${meeting.uid}/waiting`)).status).toBeGreaterThanOrEqual(400);
                expect((await request(server.getApplication()).post(`${baseUrl}/${meeting.uid}/admit/${uuid.v4()}`)).status).toBeGreaterThanOrEqual(400);
                expect((await request(server.getApplication()).post(`${baseUrl}/${meeting.uid}/deny/${uuid.v4()}`)).status).toBeGreaterThanOrEqual(400);
            });

            it("Rejects a stranger with no grant on the mailbox (403) on every host route.", async () => {
                const meeting = await createWaiting();
                expect((await authed(strangerToken).get(`${baseUrl}/${meeting.uid}/waiting`)).status).toBe(403);
                expect((await authed(strangerToken).post(`${baseUrl}/${meeting.uid}/admit/${uuid.v4()}`)).status).toBe(403);
                expect((await authed(strangerToken).post(`${baseUrl}/${meeting.uid}/deny/${uuid.v4()}`)).status).toBe(403);
            });

            it("Rejects a trusted+elevated administrator with no explicit grant (403) on every host route.", async () => {
                const meeting = await createWaiting();
                expect((await authed(adminToken).get(`${baseUrl}/${meeting.uid}/waiting`)).status).toBe(403);
                expect((await authed(adminToken).post(`${baseUrl}/${meeting.uid}/admit/${uuid.v4()}`)).status).toBe(403);
                expect((await authed(adminToken).post(`${baseUrl}/${meeting.uid}/deny/${uuid.v4()}`)).status).toBe(403);
            });

            it("Returns 404 for an unknown meeting id on every host route.", async () => {
                expect((await authed(ownerToken).get(`${baseUrl}/${uuid.v4()}/waiting`)).status).toBe(404);
                expect((await authed(ownerToken).post(`${baseUrl}/${uuid.v4()}/admit/${uuid.v4()}`)).status).toBe(404);
                expect((await authed(ownerToken).post(`${baseUrl}/${uuid.v4()}/deny/${uuid.v4()}`)).status).toBe(404);
            });
        });
    });

    const suiteContext = {
        app: () => server.getApplication(),
        baseUrl,
        mailboxUid: () => mailbox.uid,
        ownerToken: () => ownerToken,
        ownerUid: () => owner.uid,
        strangerToken: () => strangerToken,
        strangerUid: () => stranger.uid,
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
            return { uid: created.body.meeting.uid, joinToken: invitee.joinToken, organizerSlug: created.body.meeting.organizerSlug };
        },
        createPublicMeeting: async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "Public", visibility: "public" });
            return { uid: created.body.meeting.uid, publicSlug: created.body.meeting.publicSlug };
        },
        cancelMeeting: async (uid: string) => {
            await authed(ownerToken).put(`${baseUrl}/${uid}`).send({ status: "cancelled" });
        },
    };

    personalRoomSuite({
        app: () => server.getApplication(),
        baseUrl,
        ownerToken: () => ownerToken,
        ownerUid: () => owner.uid,
        strangerToken: () => strangerToken,
        strangerUid: () => stranger.uid,
        adminToken: () => adminToken,
        createMailbox: async (ownerUserUid: string, grantFullTo?: string) => {
            const created = await mailboxRepo.save(
                new MailboxSQL({
                    ownerUserUid,
                    primarySmtpAddress: `box-${uuid.v4()}@example.com`,
                    aliasAddresses: [],
                    displayName: "Personal Room Fixture",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                }),
            );
            if (grantFullTo) {
                await aclRepo.save({
                    uid: created.uid,
                    dateCreated: new Date(),
                    dateModified: new Date(),
                    version: 0,
                    records: [{ userOrRoleId: grantFullTo, actions: [ACLAction.FULL] }],
                    parentUid: "Mailbox",
                } as any);
            }
            return created.uid;
        },
        createMeeting: async (mailboxUid: string, fields) => {
            const meeting = new VideoMeetingSQL({
                mailboxUid,
                title: fields.title,
                visibility: fields.visibility as VideoMeetingVisibility,
                status: (fields.status as VideoMeetingStatus) ?? VideoMeetingStatus.SCHEDULED,
                publicSlug: fields.publicSlug,
            });
            meeting.dateCreated = fields.dateCreated;
            await meetingRepo.save(meeting);
        },
        setMailboxDateCreated: async (mailboxUid: string, dateCreated: Date) => {
            const doc: any = await mailboxRepo.findOne({ where: { uid: mailboxUid } });
            doc.dateCreated = dateCreated;
            await mailboxRepo.save(doc);
        },
    });

    videoMeetingSecuritySuite(suiteContext);
    relaySuite({
        ...suiteContext,
        wsPort: () => (server.getApplication() as any).listenPort,
        route: () => objectFactory.getInstance("routes.VideoMeetingRoute"),
    });
    effectsSuite({
        ...suiteContext,
        route: () => objectFactory.getInstance("routes.VideoMeetingRoute"),
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
            const guest: any = { uid: joined.body.selfUid, roles: [], scopes: [], elevated: -1 };

            const { granted } = await connectPush(guest);
            expect(await granted([meetingUid, mailbox.uid, uuid.v4()])).toEqual([meetingUid]);

            const { route } = await connectPush(guest);
            await route.send(meetingUid, { type: "answer" }, guest);
            expect(route.redisPub.publish).toHaveBeenCalledTimes(1);
        });

        it("Grants an already-authenticated real caller (not a guest) READ and CREATE on the meeting's channel under their own uid - the browser-session-collision fix.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const meetingUid = created.body.meeting.uid;
            const joined = await authed(strangerToken).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
            expect(joined.body.authenticated).toBe(true);
            expect(joined.body.selfUid).toBe(stranger.uid);

            const { granted } = await connectPush(stranger);
            expect(await granted([meetingUid, mailbox.uid, uuid.v4()])).toEqual([meetingUid]);

            const { route } = await connectPush(stranger);
            await route.send(meetingUid, { type: "answer" }, stranger);
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

            expect(joinedA.body.selfUid).not.toBe(joinedB.body.selfUid);

            const guestA: any = { uid: joinedA.body.selfUid, roles: [], scopes: [], elevated: -1 };
            const guestB: any = { uid: joinedB.body.selfUid, roles: [], scopes: [], elevated: -1 };
            expect(await (await connectPush(guestA)).granted([created.body.meeting.uid])).toEqual([created.body.meeting.uid]);
            expect(await (await connectPush(guestB)).granted([created.body.meeting.uid])).toEqual([created.body.meeting.uid]);
        });

        it("Revokes a joined guest's grant on kick(), so a channel subscription they'd have been granted no longer is.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const meetingUid = created.body.meeting.uid;
            const joined = await request(server.getApplication()).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
            const guest: any = { uid: joined.body.selfUid, roles: [], scopes: [], elevated: -1 };
            expect(await (await connectPush(guest)).granted([meetingUid])).toEqual([meetingUid]);

            const kicked = await authed(ownerToken).post(`${baseUrl}/${meetingUid}/kick/${encodeURIComponent(guest.uid)}`);
            expect(kicked.status).toBe(204);

            expect(await (await connectPush(guest)).granted([meetingUid])).toEqual([]);
        });

        it("Leaves the owner's own grant untouched when a different, unrelated uid is kicked.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const meetingUid = created.body.meeting.uid;

            await authed(ownerToken).post(`${baseUrl}/${meetingUid}/kick/${encodeURIComponent(stranger.uid)}`);

            const { granted } = await connectPush(owner);
            expect(await granted([meetingUid])).toEqual([meetingUid]);
        });
    });

    describe("POST /:id/kick/:uid", () => {
        it("Resolves hostUid on join() to the mailbox's own ownerUserUid.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const joined = await request(server.getApplication()).get(`${baseUrl}/join/${created.body.meeting.publicSlug}`);
            expect(joined.body.meeting.hostUid).toBe(mailbox.ownerUserUid);
        });

        it("Is a no-op (still 204) for a uid holding no grant on the meeting at all.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(ownerToken).post(`${baseUrl}/${created.body.meeting.uid}/kick/${uuid.v4()}`);
            expect(result.status).toBe(204);
        });

        it("Rejects a caller with no account at all.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await request(server.getApplication()).post(`${baseUrl}/${created.body.meeting.uid}/kick/${uuid.v4()}`);
            expect(result.status).toBeGreaterThanOrEqual(400);
        });

        it("Rejects a stranger with no grant on the mailbox (403).", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(strangerToken).post(`${baseUrl}/${created.body.meeting.uid}/kick/${uuid.v4()}`);
            expect(result.status).toBe(403);
        });

        it("Rejects a trusted+elevated administrator with no explicit grant - the superuser shortcut never applies here either.", async () => {
            const created = await authed(ownerToken).post(baseUrl).send({ mailboxUid: mailbox.uid, title: "x", visibility: "public" });
            const result = await authed(adminToken).post(`${baseUrl}/${created.body.meeting.uid}/kick/${uuid.v4()}`);
            expect(result.status).toBe(403);
        });

        it("Returns 404 for an unknown meeting id.", async () => {
            const result = await authed(ownerToken).post(`${baseUrl}/${uuid.v4()}/kick/${uuid.v4()}`);
            expect(result.status).toBe(404);
        });
    });
});
