///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Protected meetings (`specs/meeting_privacy.md`), identical on both backends - run by `test/routes/{mongo,sql}/VideoMeetingRoute.test.ts`.
import * as crypto from "crypto";
import { request } from "@rapidrest/service-core/test";

export interface MeetingProtectionSuiteContext {
    app: () => any;
    baseUrl: string;
    ownerToken: () => string;
    strangerToken: () => string;
    /** The owner's mailbox (FULL for the owner). */
    mailboxUid: () => string;
    findMeeting: (uid: string) => Promise<any>;
    findInvitees: () => Promise<any[]>;
    findLinks: () => Promise<any[]>;
    /** Sets a meeting's `keyExpiresAt` straight in the datastore. */
    setKeyExpiresAt: (uid: string, at: Date) => Promise<void>;
    runExpiry: () => Promise<void>;
}

const sealed = (text: string) => Buffer.from(`sealed:${text}`).toString("base64");
const CERTIFICATE = Buffer.from("a meeting certificate").toString("base64");
const FINGERPRINT = crypto.createHash("sha256").update(Buffer.from(CERTIFICATE, "base64")).digest("hex");
const RECIPIENT = "ab".repeat(32);

export function meetingProtectionSuite(ctx: MeetingProtectionSuiteContext): void {
    const as = (token: string) => ({
        post: (url: string) => request(ctx.app()).post(url).set("Authorization", "jwt " + token),
        put: (url: string) => request(ctx.app()).put(url).set("Authorization", "jwt " + token),
        get: (url: string) => request(ctx.app()).get(url).set("Authorization", "jwt " + token),
    });
    const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
    const protection = (overrides: any = {}) => ({
        meetingKey: { certificate: CERTIFICATE },
        keyExpiresAt: inAnHour(),
        keyWraps: [{ mailboxUid: ctx.mailboxUid(), recipientFingerprint: RECIPIENT, kind: "meeting-key", cms: sealed("organizer copy") }],
        sealedFields: { title: sealed("Board meeting") },
        ...overrides,
    });
    const body = (overrides: any = {}) => ({
        mailboxUid: ctx.mailboxUid(),
        visibility: "private",
        calendarEventUid: "event-1",
        invitees: [{ email: "guest@elsewhere.example", sealedFields: { displayName: sealed("Grace") } }, { email: "colleague@example.com" }],
        protection: protection(),
        ...overrides,
    });
    const create = async (overrides: any = {}) => {
        const res = await as(ctx.ownerToken()).post(ctx.baseUrl).send(body(overrides));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body;
    };
    const tokenOf = async (email: string) => (await ctx.findInvitees()).find((invitee) => invitee.email === email).joinToken;

    describe("protected meetings", () => {
        it("Stores only the placeholder title, sealed fields, the certificate and the organizer's wrap - and keys every invitee's link", async () => {
            const created = await create();

            const meeting = await ctx.findMeeting(created.meeting.uid);
            expect(meeting).toMatchObject({
                title: "Meeting",
                keyProtected: true,
                meetingKeyCertificate: CERTIFICATE,
                meetingKeyFingerprint: FINGERPRINT,
                sealedFields: { title: sealed("Board meeting") },
            });
            expect(meeting.keyWraps).toEqual([expect.objectContaining({ mailboxUid: ctx.mailboxUid(), cms: sealed("organizer copy") })]);
            expect(new Date(meeting.keyExpiresAt).valueOf()).toBeGreaterThan(Date.now());
            const guest = (await ctx.findInvitees()).find((invitee) => invitee.email === "guest@elsewhere.example");
            expect(guest.displayName ?? null).toBeNull();
            expect(guest).toMatchObject({ sealedFields: { displayName: sealed("Grace") } });
            const links = await ctx.findLinks();
            expect(links.map((link) => [link.attendeeAddress, link.keyed]).sort()).toEqual([
                ["colleague@example.com", true],
                ["guest@elsewhere.example", true],
            ]);
        });

        it.each([
            ["a readable title", () => ({ title: "Board meeting" })],
            ["a readable invitee name", () => ({ invitees: [{ email: "g@elsewhere.example", displayName: "Grace" }] })],
            ["an invitee name that isn't sealed", () => ({ invitees: [{ email: "g@elsewhere.example", sealedFields: { displayName: "not base64!" } }] })],
            ["no meeting key", () => ({ protection: protection({ meetingKey: undefined }) })],
            ["a wrap for another mailbox", () => ({ protection: protection({ keyWraps: [{ mailboxUid: "someone-else", recipientFingerprint: RECIPIENT, kind: "meeting-key", cms: sealed("x") }] }) })],
            ["a wrap of another kind", () => ({ protection: protection({ keyWraps: [{ mailboxUid: ctx.mailboxUid(), recipientFingerprint: RECIPIENT, kind: "live-secret", cms: sealed("x") }] }) })],
            ["too many wraps", () => ({ protection: protection({ keyWraps: Array.from({ length: 5 }, () => ({ mailboxUid: ctx.mailboxUid(), recipientFingerprint: RECIPIENT, kind: "meeting-key", cms: sealed("x") })) }) })],
            ["no wraps", () => ({ protection: protection({ keyWraps: [] }) })],
            ["a past expiry", () => ({ protection: protection({ keyExpiresAt: new Date(Date.now() - 1000).toISOString() }) })],
            ["a malformed certificate", () => ({ protection: protection({ meetingKey: { certificate: "not base64!" } }) })],
            ["a title that isn't sealed", () => ({ protection: protection({ sealedFields: { title: 7 } }) })],
            ["no protection object", () => ({ protection: null })],
            ["a protection that isn't an object", () => ({ protection: "yes" })],
        ])("Refuses a protected meeting with %s (400)", async (_name, overrides) => {
            const res = await as(ctx.ownerToken()).post(ctx.baseUrl).send(body(overrides()));
            expect(res.status, JSON.stringify(res.body)).toBe(400);
        });

        it("Gives a guest the sealed fields and certificate, and the organizer's wrap only to whoever may read the organizer's mailbox", async () => {
            const created = await create();

            const guest = await request(ctx.app()).get(`${ctx.baseUrl}/join/${await tokenOf("guest@elsewhere.example")}`);
            expect(guest.status, JSON.stringify(guest.body)).toBe(200);
            expect(guest.body.meeting).toMatchObject({ title: "Meeting", protected: true, sealedFields: { title: sealed("Board meeting") }, meetingKeyCertificate: CERTIFICATE });
            expect(guest.body.meeting.keyWraps).toBeUndefined();

            const organizer = await as(ctx.ownerToken()).get(`${ctx.baseUrl}/join/${created.meeting.organizerSlug}`);
            expect(organizer.status, JSON.stringify(organizer.body)).toBe(200);
            expect(organizer.body.meeting.keyWraps).toEqual([expect.objectContaining({ mailboxUid: ctx.mailboxUid(), cms: sealed("organizer copy") })]);

            const stranger = await as(ctx.strangerToken()).get(`${ctx.baseUrl}/join/${await tokenOf("colleague@example.com")}`);
            expect(stranger.status).toBe(200);
            expect(stranger.body.meeting.keyWraps).toBeUndefined();
        });

        it("Takes a protected meeting's title only sealed, and an unprotected one's never sealed", async () => {
            const created = await create();
            const url = `${ctx.baseUrl}/${created.meeting.uid}`;
            expect((await as(ctx.ownerToken()).put(url).send({ title: "Readable" })).status).toBe(400);
            expect((await as(ctx.ownerToken()).put(url).send({ sealedFields: { title: "not base64!" } })).status).toBe(400);
            const renamed = await as(ctx.ownerToken()).put(url).send({ sealedFields: { title: sealed("Renamed") } });
            expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
            expect((await ctx.findMeeting(created.meeting.uid)).sealedFields).toEqual({ title: sealed("Renamed") });

            const plain = await as(ctx.ownerToken()).post(ctx.baseUrl).send({ mailboxUid: ctx.mailboxUid(), title: "Plain", visibility: "public" });
            expect((await as(ctx.ownerToken()).put(`${ctx.baseUrl}/${plain.body.meeting.uid}`).send({ sealedFields: { title: sealed("x") } })).status).toBe(400);
        });

        it("Ends joining at expiry, then discards the key, the wraps, the guest-readable copies, the join tokens and the keyed links", async () => {
            const created = await create();
            const token = await tokenOf("guest@elsewhere.example");
            await ctx.setKeyExpiresAt(created.meeting.uid, new Date(Date.now() - 1000));

            const ended = await request(ctx.app()).get(`${ctx.baseUrl}/join/${token}`);
            expect(ended.status).toBe(410);
            expect(ended.body.message).toBe("This meeting has ended.");

            await ctx.runExpiry();

            const meeting = await ctx.findMeeting(created.meeting.uid);
            expect(meeting.meetingKeyCertificate ?? null).toBeNull();
            expect(meeting.keyWraps ?? null).toBeNull();
            expect(meeting.sealedFields ?? null).toBeNull();
            expect(meeting.keyDiscardedAt).toBeTruthy();
            const guest = (await ctx.findInvitees()).find((invitee) => invitee.email === "guest@elsewhere.example");
            expect(guest.joinToken).not.toBe(token);
            expect(guest.sealedFields ?? null).toBeNull();
            expect(await ctx.findLinks()).toEqual([]);
            // Already discarded: a second run changes nothing, and the new token still finds an ended meeting.
            await ctx.runExpiry();
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${guest.joinToken}`)).status).toBe(410);
        });

        it("Leaves a meeting whose key hasn't expired yet", async () => {
            const created = await create();
            await ctx.runExpiry();
            expect((await ctx.findMeeting(created.meeting.uid)).meetingKeyCertificate).toBe(CERTIFICATE);
        });
    });
}
