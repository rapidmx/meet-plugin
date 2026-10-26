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
    /** The records of meeting `uid`'s own ACL: who it grants which actions. */
    findGrants: (uid: string) => Promise<{ userOrRoleId: string; actions: string[] }[]>;
    /** Sets a meeting's `keyExpiresAt` straight in the datastore. */
    setKeyExpiresAt: (uid: string, at: Date) => Promise<void>;
    /** Runs `MeetingKeyExpiryJob` once, looking at `batchSize` meetings at most when given, after `prepare` has had the job. */
    runExpiry: (batchSize?: number, prepare?: (job: any) => void) => Promise<void>;
    /** `discardMeetingKey()` on `meeting` (a copy read earlier), with the route's stores. */
    discardKey: (meeting: any) => Promise<any>;
    /** `authorizeMeetingSocket()` of the route: why a signaling or relay socket of `user` would be refused, or `undefined`. */
    authorizeSocket: (meetingUid: string, user: any) => Promise<string | undefined>;
    /** The route's waiting-room store (`AdmissionStore`). */
    admissions: () => any;
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
    /** Joins as a guest through each of `meeting`'s invitees' links, returning the guest uids `join()` granted. */
    const joinAll = async (meetingUid: string) => {
        const uids: string[] = [];
        for (const invitee of (await ctx.findInvitees()).filter((invitee) => invitee.meetingUid === meetingUid)) {
            const joined = await request(ctx.app()).get(`${ctx.baseUrl}/join/${invitee.joinToken}`);
            expect(joined.status, JSON.stringify(joined.body)).toBe(200);
            uids.push(joined.body.selfUid);
        }
        return uids;
    };
    const grantees = async (meetingUid: string) => (await ctx.findGrants(meetingUid)).map((record) => record.userOrRoleId).sort();

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

        it("Takes a protected meeting's waiting-room name only sealed, stores and lists it only sealed", async () => {
            const created = await create({ waitingRoomEnabled: true });
            const token = await tokenOf("guest@elsewhere.example");
            const verify = (payload: any) => request(ctx.app()).post(`${ctx.baseUrl}/join/${token}/verify`).send(payload);

            for (const payload of [
                { name: "Grace" },
                { name: "Grace", sealedName: sealed("Grace") },
                { sealedName: "not base64!" },
                { sealedName: "A".repeat(2052) },
                {},
            ]) {
                const refused = await verify(payload);
                expect(refused.status, JSON.stringify(payload)).toBe(400);
            }

            const filed = await verify({ sealedName: sealed("Grace") });
            expect(filed.status, JSON.stringify(filed.body)).toBe(200);
            expect(filed.body.requiresAdmission).toBe(true);
            const stored = await ctx.admissions().get(created.meeting.uid, filed.body.selfUid);
            expect(stored).toMatchObject({ sealedName: sealed("Grace"), status: "pending" });
            expect(stored.name).toBeUndefined();
            expect(JSON.stringify([...(await ctx.admissions().list(created.meeting.uid)).values()])).not.toContain("Grace");

            const waiting = await as(ctx.ownerToken()).get(`${ctx.baseUrl}/${created.meeting.uid}/waiting`);
            expect(waiting.status).toBe(200);
            expect(waiting.body).toEqual([{ uid: filed.body.selfUid, sealedName: sealed("Grace"), requestedAt: expect.any(String) }]);
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

        it("Keeps every invitee's token, link and grant when the key was extended after the discard read the meeting", async () => {
            const created = await create();
            const token = await tokenOf("guest@elsewhere.example");
            const guests = await joinAll(created.meeting.uid);
            // What the job read just after the old expiry...
            const stale = await ctx.findMeeting(created.meeting.uid);
            stale.keyExpiresAt = new Date(Date.now() - 1000);
            // ...while the organizer's extension, read just before it, saves first.
            const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
            const extended = await as(ctx.ownerToken()).put(`${ctx.baseUrl}/${created.meeting.uid}`).send({ keyExpiresAt: nextWeek });
            expect(extended.status, JSON.stringify(extended.body)).toBe(200);

            await expect(ctx.discardKey(stale)).rejects.toThrow();

            const meeting = await ctx.findMeeting(created.meeting.uid);
            expect(meeting.meetingKeyCertificate).toBe(CERTIFICATE);
            expect(meeting.keyDiscardedAt ?? null).toBeNull();
            expect(meeting.keyCleanupPending ?? null).toBeNull();
            expect(await tokenOf("guest@elsewhere.example")).toBe(token);
            expect(await ctx.findLinks()).toHaveLength(2);
            for (const uid of guests) {
                expect(await grantees(created.meeting.uid)).toContain(uid);
            }
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${token}`)).status).toBe(200);
            // The job's next run sees the new expiry and leaves the meeting.
            await ctx.runExpiry();
            expect((await ctx.findMeeting(created.meeting.uid)).meetingKeyCertificate).toBe(CERTIFICATE);
        });

        it("Finishes on the next run the cleanup of a discard whose claim was saved but whose cleanup failed", async () => {
            const created = await create();
            const token = await tokenOf("guest@elsewhere.example");
            await ctx.setKeyExpiresAt(created.meeting.uid, new Date(Date.now() - 1000));

            let failing: any;
            await ctx.runExpiry(undefined, (job) => {
                failing = vi.spyOn(job.inviteeRepo, "find").mockRejectedValueOnce(new Error("store down"));
            });
            failing.mockRestore();

            let meeting = await ctx.findMeeting(created.meeting.uid);
            expect(meeting.meetingKeyCertificate ?? null).toBeNull();
            expect(meeting.keyDiscardedAt).toBeTruthy();
            expect(meeting.keyCleanupPending).toBe(true);
            expect(await ctx.findLinks()).toHaveLength(2);
            // Joining is refused already.
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${token}`)).status).toBe(410);

            await ctx.runExpiry();

            meeting = await ctx.findMeeting(created.meeting.uid);
            expect(meeting.keyCleanupPending ?? null).toBeNull();
            expect(await tokenOf("guest@elsewhere.example")).not.toBe(token);
            expect(await ctx.findLinks()).toEqual([]);
        });

        it("Leaves a meeting whose key hasn't expired yet", async () => {
            const created = await create();
            await ctx.runExpiry();
            expect((await ctx.findMeeting(created.meeting.uid)).meetingKeyCertificate).toBe(CERTIFICATE);
        });

        it("Reaches an expired meeting behind a whole batch of meetings holding long-lived keys", async () => {
            const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString();
            const longLived = [];
            for (let i = 0; i < 3; i++) {
                longLived.push(await create({ calendarEventUid: `series-${i}`, protection: protection({ keyExpiresAt: nextYear }) }));
            }
            const expired = await create({ calendarEventUid: "one-off" });
            await ctx.setKeyExpiresAt(expired.meeting.uid, new Date(Date.now() - 1000));

            await ctx.runExpiry(2);

            expect((await ctx.findMeeting(expired.meeting.uid)).keyDiscardedAt).toBeTruthy();
            for (const meeting of longLived) {
                expect((await ctx.findMeeting(meeting.meeting.uid)).meetingKeyCertificate).toBe(CERTIFICATE);
            }
        });

        it("Removes the participants' grants on the expired meeting's own ACL, keeping its creator's and another meeting's participants'", async () => {
            const expiring = await create();
            const other = await create({ calendarEventUid: "event-2" });
            const expiringGuests = await joinAll(expiring.meeting.uid);
            const otherGuests = await joinAll(other.meeting.uid);
            const creatorOf = async (uid: string) => (await ctx.findGrants(uid)).filter((record) => !record.actions.every((a) => a === "read" || a === "create"));
            const expiringCreator = await creatorOf(expiring.meeting.uid);
            expect(expiringCreator).toHaveLength(1);
            expect(await grantees(expiring.meeting.uid)).toEqual([...expiringGuests, expiringCreator[0].userOrRoleId].sort());
            await ctx.setKeyExpiresAt(expiring.meeting.uid, new Date(Date.now() - 1000));

            await ctx.runExpiry();

            expect(await ctx.findGrants(expiring.meeting.uid)).toEqual(expiringCreator);
            const kept = await grantees(other.meeting.uid);
            for (const uid of otherGuests) {
                expect(kept).toContain(uid);
            }
            // Idempotent: nothing left to remove.
            await ctx.runExpiry();
            expect(await ctx.findGrants(expiring.meeting.uid)).toEqual(expiringCreator);
        });

        it("Keeps the keyed links of another meeting on the same event when one meeting's key expires", async () => {
            const replaced = await create();
            const current = await create();
            expect(await ctx.findLinks()).toHaveLength(4);
            const currentTokens = (await ctx.findInvitees()).filter((invitee) => invitee.meetingUid === current.meeting.uid).map((invitee) => invitee.joinToken);
            await ctx.setKeyExpiresAt(replaced.meeting.uid, new Date(Date.now() - 1000));

            await ctx.runExpiry();

            const links = await ctx.findLinks();
            expect(links).toHaveLength(2);
            for (const link of links) {
                expect(currentTokens.some((token) => link.url.endsWith(`/${token}`))).toBe(true);
            }
            expect((await ctx.findMeeting(current.meeting.uid)).keyDiscardedAt ?? null).toBeNull();
        });

        it("Moves a protected meeting's key expiry for its moved event, and refuses a bad date, an unprotected meeting and an ended one", async () => {
            const created = await create();
            const url = `${ctx.baseUrl}/${created.meeting.uid}`;
            const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
            const moved = await as(ctx.ownerToken()).put(url).send({ keyExpiresAt: nextWeek });
            expect(moved.status, JSON.stringify(moved.body)).toBe(200);
            expect(new Date((await ctx.findMeeting(created.meeting.uid)).keyExpiresAt).toISOString()).toBe(nextWeek);
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${await tokenOf("guest@elsewhere.example")}`)).status).toBe(200);

            for (const keyExpiresAt of [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 6 * 366 * 86_400_000).toISOString(), "soon", 7, null]) {
                const res = await as(ctx.ownerToken()).put(url).send({ keyExpiresAt });
                expect(res.status, String(keyExpiresAt)).toBe(400);
            }
            expect((await as(ctx.strangerToken()).put(url).send({ keyExpiresAt: nextWeek })).status).toBe(403);

            const plain = await as(ctx.ownerToken()).post(ctx.baseUrl).send({ mailboxUid: ctx.mailboxUid(), title: "Plain", visibility: "public" });
            const unprotected = await as(ctx.ownerToken()).put(`${ctx.baseUrl}/${plain.body.meeting.uid}`).send({ keyExpiresAt: nextWeek });
            expect(unprotected.status).toBe(400);

            await ctx.setKeyExpiresAt(created.meeting.uid, new Date(Date.now() - 1000));
            const ended = await as(ctx.ownerToken()).put(url).send({ keyExpiresAt: nextWeek });
            expect(ended.status).toBe(410);
            expect(ended.body.message).toBe("This meeting has ended.");
        });

        it("Discards a protected meeting's key as soon as it is cancelled", async () => {
            const created = await create();
            const token = await tokenOf("guest@elsewhere.example");
            const guests = await joinAll(created.meeting.uid);

            const cancelled = await as(ctx.ownerToken()).put(`${ctx.baseUrl}/${created.meeting.uid}`).send({ status: "cancelled" });
            expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
            expect(cancelled.body.keyDiscardedAt).toBeTruthy();

            const meeting = await ctx.findMeeting(created.meeting.uid);
            expect(meeting.status).toBe("cancelled");
            expect(meeting.meetingKeyCertificate ?? null).toBeNull();
            expect(meeting.keyWraps ?? null).toBeNull();
            expect(meeting.sealedFields ?? null).toBeNull();
            expect(meeting.keyDiscardedAt).toBeTruthy();
            const guest = (await ctx.findInvitees()).find((invitee) => invitee.email === "guest@elsewhere.example");
            expect(guest.joinToken).not.toBe(token);
            expect(guest.sealedFields ?? null).toBeNull();
            expect(await ctx.findLinks()).toEqual([]);
            const left = await grantees(created.meeting.uid);
            expect(left).toHaveLength(1);
            for (const uid of guests) {
                expect(left).not.toContain(uid);
            }
            // Cancelling again has no key left to discard.
            expect((await as(ctx.ownerToken()).put(`${ctx.baseUrl}/${created.meeting.uid}`).send({ status: "cancelled" })).status).toBe(200);
        });

        it("Refuses a participant's signaling and relay sockets once the meeting's key has expired", async () => {
            const created = await create();
            const joined = await request(ctx.app()).get(`${ctx.baseUrl}/join/${await tokenOf("guest@elsewhere.example")}`);
            expect(joined.status).toBe(200);
            const participant = { uid: joined.body.selfUid, roles: [], scopes: [] };
            expect(await ctx.authorizeSocket(created.meeting.uid, participant)).toBeUndefined();

            await ctx.setKeyExpiresAt(created.meeting.uid, new Date(Date.now() - 1000));
            expect(await ctx.authorizeSocket(created.meeting.uid, participant)).toBe("Not permitted.");
        });
    });
}
