///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `GET /personal-room` - identical on both backends. Run from the VideoMeetingRoute test files, which supply a started
// server and the fixture helpers below. Mirrors `videoMeetingSecuritySuite.ts`'s shared-suite-across-both-backends shape.
import { request } from "@rapidrest/service-core/test";

export interface PersonalRoomSuiteContext {
    app: () => any;
    baseUrl: string;
    ownerToken: () => string;
    ownerUid: () => string;
    strangerToken: () => string;
    strangerUid: () => string;
    adminToken: () => string;
    /** Creates a mailbox whose `ownerUserUid` is `ownerUserUid` and, when `grantFullTo` is given, an ACL granting that
     * uid FULL on it (omit to model an owned mailbox the owner has since lost all access to). Returns its uid. */
    createMailbox: (ownerUserUid: string, grantFullTo?: string) => Promise<string>;
    /** Creates a meeting in `mailboxUid` straight in the datastore, so the fixture needs no ACL of its own. */
    createMeeting: (
        mailboxUid: string,
        fields: { title: string; visibility: "public" | "private"; status?: string; dateCreated: Date; publicSlug?: string },
    ) => Promise<void>;
    /** Sets a mailbox's `dateCreated` straight in the datastore. */
    setMailboxDateCreated: (mailboxUid: string, dateCreated: Date) => Promise<void>;
}

export function personalRoomSuite(ctx: PersonalRoomSuiteContext): void {
    const get = (token?: string) => {
        const req = request(ctx.app()).get(`${ctx.baseUrl}/personal-room`);
        return token ? req.set("Authorization", "jwt " + token) : req;
    };
    let slugCounter = 0;
    const slug = () => `room${String(++slugCounter).padStart(7, "0")}`;
    const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

    describe("GET /personal-room", () => {
        it("Answers 404 when the caller owns no mailbox at all.", async () => {
            expect((await get(ctx.ownerToken())).status).toBe(404);
        });

        it("Answers 404 when the caller's mailbox has no meetings.", async () => {
            await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            expect((await get(ctx.ownerToken())).status).toBe(404);
        });

        it("Answers 404 when the only public meeting is cancelled.", async () => {
            const mailboxUid = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            await ctx.createMeeting(mailboxUid, { title: "Old", visibility: "public", status: "cancelled", dateCreated: at(1), publicSlug: slug() });
            expect((await get(ctx.ownerToken())).status).toBe(404);
        });

        it("Answers 404 when the caller only has private meetings.", async () => {
            const mailboxUid = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            await ctx.createMeeting(mailboxUid, { title: "Secret", visibility: "private", dateCreated: at(1) });
            expect((await get(ctx.ownerToken())).status).toBe(404);
        });

        it("Answers 404 when the only public meeting has no slug (nothing to link to).", async () => {
            const mailboxUid = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            await ctx.createMeeting(mailboxUid, { title: "Slugless", visibility: "public", dateCreated: at(1) });
            expect((await get(ctx.ownerToken())).status).toBe(404);
        });

        it("Returns the caller's public meeting as a /meet/<slug> href, labelled with its title.", async () => {
            const mailboxUid = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            const publicSlug = slug();
            await ctx.createMeeting(mailboxUid, { title: "Ada's Room", visibility: "public", dateCreated: at(1), publicSlug });
            const result = await get(ctx.ownerToken());
            expect(result.status).toBe(200);
            expect(result.body).toEqual({ href: `/meet/${publicSlug}`, label: "Ada's Room" });
        });

        it("Picks the oldest still-active public meeting when there are several, ignoring cancelled and private ones.", async () => {
            const mailboxUid = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            const winner = slug();
            await ctx.createMeeting(mailboxUid, { title: "Newest", visibility: "public", dateCreated: at(50), publicSlug: slug() });
            await ctx.createMeeting(mailboxUid, { title: "Oldest but cancelled", visibility: "public", status: "cancelled", dateCreated: at(1), publicSlug: slug() });
            await ctx.createMeeting(mailboxUid, { title: "Oldest but private", visibility: "private", dateCreated: at(2) });
            await ctx.createMeeting(mailboxUid, { title: "Winner", visibility: "public", dateCreated: at(10), publicSlug: winner });
            await ctx.createMeeting(mailboxUid, { title: "Middle", visibility: "public", dateCreated: at(20), publicSlug: slug() });
            const result = await get(ctx.ownerToken());
            expect(result.status).toBe(200);
            expect(result.body).toEqual({ href: `/meet/${winner}`, label: "Winner" });
        });

        it("Falls through to the caller's next owned mailbox when the first has no room, oldest mailbox first.", async () => {
            const first = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            const second = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            const third = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            await ctx.setMailboxDateCreated(first, at(1));
            await ctx.setMailboxDateCreated(second, at(2));
            await ctx.setMailboxDateCreated(third, at(3));
            const secondSlug = slug();
            await ctx.createMeeting(first, { title: "Private only", visibility: "private", dateCreated: at(1) });
            await ctx.createMeeting(second, { title: "Second's room", visibility: "public", dateCreated: at(30), publicSlug: secondSlug });
            await ctx.createMeeting(third, { title: "Third's room", visibility: "public", dateCreated: at(5), publicSlug: slug() });
            const result = await get(ctx.ownerToken());
            expect(result.body).toEqual({ href: `/meet/${secondSlug}`, label: "Second's room" });
        });

        it("Never exposes another user's room: a stranger with a room of their own only ever sees theirs.", async () => {
            const ownerMailbox = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            await ctx.createMeeting(ownerMailbox, { title: "Owner's room", visibility: "public", dateCreated: at(1), publicSlug: slug() });
            const strangerSlug = slug();
            const strangerMailbox = await ctx.createMailbox(ctx.strangerUid(), ctx.strangerUid());
            await ctx.createMeeting(strangerMailbox, { title: "Stranger's room", visibility: "public", dateCreated: at(99), publicSlug: strangerSlug });

            expect((await get(ctx.strangerToken())).body).toEqual({ href: `/meet/${strangerSlug}`, label: "Stranger's room" });
        });

        it("Answers 404 for a caller who only has other users' meetings around.", async () => {
            const ownerMailbox = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            await ctx.createMeeting(ownerMailbox, { title: "Owner's room", visibility: "public", dateCreated: at(1), publicSlug: slug() });
            expect((await get(ctx.strangerToken())).status).toBe(404);
        });

        it("Ignores a delegated mailbox (one the caller has a grant on but does not own).", async () => {
            const mailboxUid = await ctx.createMailbox(ctx.ownerUid(), ctx.strangerUid());
            await ctx.createMeeting(mailboxUid, { title: "Owner's room", visibility: "public", dateCreated: at(1), publicSlug: slug() });
            expect((await get(ctx.strangerToken())).status).toBe(404);
        });

        it("Skips an owned mailbox the caller no longer holds any grant on.", async () => {
            const revoked = await ctx.createMailbox(ctx.ownerUid());
            await ctx.createMeeting(revoked, { title: "Unreachable", visibility: "public", dateCreated: at(1), publicSlug: slug() });
            expect((await get(ctx.ownerToken())).status).toBe(404);
        });

        it("Does not let a trusted administrator see anyone else's room.", async () => {
            const ownerMailbox = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            await ctx.createMeeting(ownerMailbox, { title: "Owner's room", visibility: "public", dateCreated: at(1), publicSlug: slug() });
            expect((await get(ctx.adminToken())).status).toBe(404);
        });

        it("Rejects an unauthenticated caller (401), and is not captured by the /:id route.", async () => {
            const mailboxUid = await ctx.createMailbox(ctx.ownerUid(), ctx.ownerUid());
            await ctx.createMeeting(mailboxUid, { title: "Ada's Room", visibility: "public", dateCreated: at(1), publicSlug: slug() });
            expect((await get()).status).toBe(401);
        });
    });
}
