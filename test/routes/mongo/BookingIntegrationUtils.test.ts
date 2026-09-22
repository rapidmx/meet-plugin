///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Exercises `createSingleInviteeVideoMeeting()` - the integration surface `booking-plugin` calls in-process -
// directly, the same way a caller in another plugin's own route handler would: with its own `ObjectFactory` and
// the concrete Mongo model classes for this backend. No HTTP request is ever made here; `test/server-mongo`
// exists only to boot real Mongo connections/model registration to call the function against.
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import * as uuid from "uuid";
import { MailboxMongo } from "@rapidmx/restapi/mongo";
import { VideoMeetingMongo } from "../../../src/models/mongo/VideoMeetingMongo.js";
import { VideoMeetingInviteeMongo } from "../../../src/models/mongo/VideoMeetingInviteeMongo.js";
import { VideoMeetingStatus, VideoMeetingVisibility } from "../../../src/models/types.js";
import { createSingleInviteeVideoMeeting } from "../../../src/util/BookingIntegrationUtils.js";

const redis = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("redis", () => ({ createClient: redis.createClient }));

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { port: 9998, dbName: "rrst-test" } });

describe("BookingIntegrationUtils:Mongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let meetingRepo: MongoRepository<VideoMeetingMongo>;
    let inviteeRepo: MongoRepository<VideoMeetingInviteeMongo>;

    let mailbox: MailboxMongo;

    beforeAll(async () => {
        await mongod.start();
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            meetingRepo = conn.getMongoRepository("VideoMeetingMongo");
            inviteeRepo = conn.getMongoRepository("VideoMeetingInviteeMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, meetingRepo, inviteeRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        mailbox = await mailboxRepo.save(
            new MailboxMongo({
                ownerUserUid: uuid.v4(),
                primarySmtpAddress: `ada-${uuid.v4()}@example.com`,
                aliasAddresses: [],
                displayName: "Ada Lovelace",
                timezone: "UTC",
                quotaBytes: 1_000_000_000,
                usedBytes: 0,
            }),
        );
    });

    it("Mints a private meeting with exactly one invitee and returns their resolved join URL.", async () => {
        const joinUrl = await createSingleInviteeVideoMeeting(
            objectFactory,
            VideoMeetingMongo,
            VideoMeetingInviteeMongo,
            mailbox.uid,
            "Intro Call with Grace Hopper",
            { email: "Grace@Example.com", displayName: "Grace Hopper" },
        );

        const meetings = await meetingRepo.find({}).toArray();
        expect(meetings).toHaveLength(1);
        expect(meetings[0].mailboxUid).toBe(mailbox.uid);
        expect(meetings[0].title).toBe("Intro Call with Grace Hopper");
        expect(meetings[0].visibility).toBe(VideoMeetingVisibility.PRIVATE);
        expect(meetings[0].status).toBe(VideoMeetingStatus.SCHEDULED);
        expect(meetings[0].calendarEventUid).toBeUndefined();

        const invitees = await inviteeRepo.find({}).toArray();
        expect(invitees).toHaveLength(1);
        expect(invitees[0].meetingUid).toBe(meetings[0].uid);
        expect(invitees[0].mailboxUid).toBe(mailbox.uid);
        // The address is normalized on the way in, exactly like `BaseVideoMeetingRoute.create()`.
        expect(invitees[0].email).toBe("grace@example.com");
        expect(invitees[0].displayName).toBe("Grace Hopper");
        expect(invitees[0].joinToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

        expect(joinUrl).toBe(`https://videoconf.rapidmx-test.example.com/meet/${invitees[0].joinToken}`);
    });

    it("Falls back to a default title when given an empty/blank one.", async () => {
        await createSingleInviteeVideoMeeting(objectFactory, VideoMeetingMongo, VideoMeetingInviteeMongo, mailbox.uid, "   ", {
            email: "grace@example.com",
        });

        const meetings = await meetingRepo.find({}).toArray();
        expect(meetings[0].title).toBe("Video meeting");
    });

    it("Clamps an overlong title to 200 characters.", async () => {
        await createSingleInviteeVideoMeeting(objectFactory, VideoMeetingMongo, VideoMeetingInviteeMongo, mailbox.uid, "x".repeat(500), {
            email: "grace@example.com",
        });

        const meetings = await meetingRepo.find({}).toArray();
        expect(meetings[0].title).toHaveLength(200);
    });

    it("Omits displayName on the invitee row when none is supplied.", async () => {
        await createSingleInviteeVideoMeeting(objectFactory, VideoMeetingMongo, VideoMeetingInviteeMongo, mailbox.uid, "No Name", {
            email: "grace@example.com",
        });

        const invitees = await inviteeRepo.find({}).toArray();
        expect(invitees[0].displayName).toBeUndefined();
    });

    it("Still persists the meeting/invitee but returns undefined when mail:videoconf:public_url isn't configured.", async () => {
        // Same mutate-then-restore idiom `VideoMeetingRoute.test.ts` uses for its own route instance's `publicUrl`
        // field - here there is no long-lived instance to mutate (`createSingleInviteeVideoMeeting()` builds a
        // fresh `PublicUrlConfigHolder` every call), so the underlying config value itself is toggled instead.
        const original: string = config.get("mail:videoconf:public_url");
        config.set("mail:videoconf:public_url", "");
        try {
            const joinUrl = await createSingleInviteeVideoMeeting(objectFactory, VideoMeetingMongo, VideoMeetingInviteeMongo, mailbox.uid, "No URL", {
                email: "grace@example.com",
            });
            expect(joinUrl).toBeUndefined();

            const invitees = await inviteeRepo.find({}).toArray();
            expect(invitees).toHaveLength(1);
            expect(invitees[0].joinToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        } finally {
            config.set("mail:videoconf:public_url", original);
        }
    });
});
