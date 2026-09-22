///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Exercises `createSingleInviteeVideoMeeting()` - the integration surface `booking-plugin` calls in-process -
// directly, the same way a caller in another plugin's own route handler would: with its own `ObjectFactory` and
// the concrete SQL model classes for this backend. No HTTP request is ever made here; `test/server-sql` exists
// only to boot a real SQL connection/model registration to call the function against.
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "@rapidmx/restapi/sql";
import { VideoMeetingSQL } from "../../../src/models/sql/VideoMeetingSQL.js";
import { VideoMeetingInviteeSQL } from "../../../src/models/sql/VideoMeetingInviteeSQL.js";
import { VideoMeetingStatus, VideoMeetingVisibility } from "../../../src/models/types.js";
import { createSingleInviteeVideoMeeting } from "../../../src/util/BookingIntegrationUtils.js";

const redis = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("redis", () => ({ createClient: redis.createClient }));

describe("BookingIntegrationUtils:SQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let meetingRepo: Repository<VideoMeetingSQL>;
    let inviteeRepo: Repository<VideoMeetingInviteeSQL>;

    let mailbox: MailboxSQL;

    beforeAll(async () => {
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
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
    });

    it("Mints a private meeting with exactly one invitee and returns their resolved join URL.", async () => {
        const joinUrl = await createSingleInviteeVideoMeeting(
            objectFactory,
            VideoMeetingSQL,
            VideoMeetingInviteeSQL,
            mailbox.uid,
            "Intro Call with Grace Hopper",
            { email: "Grace@Example.com", displayName: "Grace Hopper" },
        );

        const meetings = await meetingRepo.find();
        expect(meetings).toHaveLength(1);
        expect(meetings[0].mailboxUid).toBe(mailbox.uid);
        expect(meetings[0].title).toBe("Intro Call with Grace Hopper");
        expect(meetings[0].visibility).toBe(VideoMeetingVisibility.PRIVATE);
        expect(meetings[0].status).toBe(VideoMeetingStatus.SCHEDULED);
        // TypeORM's SQL driver returns `null` (not `undefined`) for an unset nullable column.
        expect(meetings[0].calendarEventUid).toBeFalsy();

        const invitees = await inviteeRepo.find();
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
        await createSingleInviteeVideoMeeting(objectFactory, VideoMeetingSQL, VideoMeetingInviteeSQL, mailbox.uid, "   ", {
            email: "grace@example.com",
        });

        const meetings = await meetingRepo.find();
        expect(meetings[0].title).toBe("Video meeting");
    });

    it("Clamps an overlong title to 200 characters.", async () => {
        await createSingleInviteeVideoMeeting(objectFactory, VideoMeetingSQL, VideoMeetingInviteeSQL, mailbox.uid, "x".repeat(500), {
            email: "grace@example.com",
        });

        const meetings = await meetingRepo.find();
        expect(meetings[0].title).toHaveLength(200);
    });

    it("Omits displayName on the invitee row when none is supplied.", async () => {
        await createSingleInviteeVideoMeeting(objectFactory, VideoMeetingSQL, VideoMeetingInviteeSQL, mailbox.uid, "No Name", {
            email: "grace@example.com",
        });

        const invitees = await inviteeRepo.find();
        // TypeORM's SQL driver returns `null` (not `undefined`) for an unset nullable column.
        expect(invitees[0].displayName).toBeFalsy();
    });

    it("Still persists the meeting/invitee but returns undefined when mail:videoconf:public_url isn't configured.", async () => {
        // Same mutate-then-restore idiom `VideoMeetingRoute.test.ts` uses for its own route instance's `publicUrl`
        // field - here there is no long-lived instance to mutate (`createSingleInviteeVideoMeeting()` builds a
        // fresh `PublicUrlConfigHolder` every call), so the underlying config value itself is toggled instead.
        const original: string = config.get("mail:videoconf:public_url");
        config.set("mail:videoconf:public_url", "");
        try {
            const joinUrl = await createSingleInviteeVideoMeeting(objectFactory, VideoMeetingSQL, VideoMeetingInviteeSQL, mailbox.uid, "No URL", {
                email: "grace@example.com",
            });
            expect(joinUrl).toBeUndefined();

            const invitees = await inviteeRepo.find();
            expect(invitees).toHaveLength(1);
            expect(invitees[0].joinToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        } finally {
            config.set("mail:videoconf:public_url", original);
        }
    });
});
