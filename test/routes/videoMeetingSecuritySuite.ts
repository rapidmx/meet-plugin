///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Owner-side ACL enforcement and anonymous join-token/slug hardening - identical on both backends. Run from the
// VideoMeetingRoute test files, which supply a started server and fixtures (a mailbox owned by `owner`, recreated
// before every test). Mirrors `booking-plugin`'s `bookingSecuritySuite.ts` shared-suite-across-both-backends shape.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";

export interface VideoMeetingSecuritySuiteContext {
    app: () => any;
    baseUrl: string;
    mailboxUid: () => string;
    ownerToken: () => string;
    /** The uid `ownerToken()` authenticates as - the fixture mailbox's owner, used to prove a private meeting's
     * `organizerSlug` resolves for them (and only for a caller holding real permission on that mailbox). */
    ownerUid: () => string;
    strangerToken: () => string;
    /** The uid `strangerToken()` authenticates as - a real, non-guest RapidMX identity with no grant on the
     * fixture mailbox, used to prove `join()` grants an already-authenticated real caller their own uid rather
     * than minting a guest identity for them. */
    strangerUid: () => string;
    /** A trusted (`admin` role), elevated token with NO explicit grant on the fixture mailbox - proves the
     * framework's "trusted users always have permission" shortcut never applies to a video meeting. */
    adminToken: () => string;
    /** A token whose uid `grantMailboxAccess()` grants READ/LIST on the fixture mailbox for the "read-only
     * delegate" scenario below. */
    delegateToken: () => string;
    delegateUid: () => string;
    /** Grants `userOrRoleId` `actions` on the fixture mailbox's own ACL, on top of whatever it already has. */
    grantMailboxAccess: (userOrRoleId: string, actions: string[]) => Promise<void>;
    /** Creates a private meeting directly through the route (as `owner`) with one invitee, returning the created
     * meeting, that invitee's join token, and the meeting's own organizer slug. */
    createPrivateMeeting: () => Promise<{ uid: string; joinToken: string; organizerSlug: string }>;
    /** Creates a public meeting directly through the route (as `owner`), returning the created meeting and its
     * public slug. */
    createPublicMeeting: () => Promise<{ uid: string; publicSlug: string }>;
    /** Marks the given meeting cancelled directly against the datastore (bypassing the route). */
    cancelMeeting: (uid: string) => Promise<void>;
}

export function videoMeetingSecuritySuite(ctx: VideoMeetingSecuritySuiteContext): void {
    const authed = (token: string) => ({
        get: (url: string) => request(ctx.app()).get(url).set("Authorization", "jwt " + token),
        post: (url: string) => request(ctx.app()).post(url).set("Authorization", "jwt " + token),
        put: (url: string) => request(ctx.app()).put(url).set("Authorization", "jwt " + token),
        delete: (url: string) => request(ctx.app()).delete(url).set("Authorization", "jwt " + token),
    });
    const createBody = () => ({ mailboxUid: ctx.mailboxUid(), title: "Security Suite Meeting", visibility: "private", invitees: [{ email: "a@example.com" }] });

    describe("owner-side ACL enforcement", () => {
        it("Lets the owner create, list, read, update and delete their own meeting.", async () => {
            const created = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            expect(created.status).toBe(200);
            const uid = created.body.meeting.uid;

            expect((await authed(ctx.ownerToken()).get(`${ctx.baseUrl}?mailboxUid=${ctx.mailboxUid()}`)).status).toBe(200);
            expect((await authed(ctx.ownerToken()).get(`${ctx.baseUrl}/${uid}`)).status).toBe(200);
            expect((await authed(ctx.ownerToken()).put(`${ctx.baseUrl}/${uid}`).send({ title: "Renamed" })).status).toBe(200);
            expect((await authed(ctx.ownerToken()).delete(`${ctx.baseUrl}/${uid}`)).status).toBe(204);
        });

        it("Rejects a caller with no account at all (401/403) on every owner-side endpoint.", async () => {
            const created = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            const uid = created.body.meeting.uid;

            expect((await request(ctx.app()).post(ctx.baseUrl).send(createBody())).status).toBeGreaterThanOrEqual(400);
            expect((await request(ctx.app()).get(`${ctx.baseUrl}?mailboxUid=${ctx.mailboxUid()}`)).status).toBeGreaterThanOrEqual(400);
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/${uid}`)).status).toBeGreaterThanOrEqual(400);
            expect((await request(ctx.app()).put(`${ctx.baseUrl}/${uid}`).send({ title: "x" })).status).toBeGreaterThanOrEqual(400);
            expect((await request(ctx.app()).delete(`${ctx.baseUrl}/${uid}`)).status).toBeGreaterThanOrEqual(400);
        });

        it("Rejects a stranger with no grant on the mailbox (403) on every owner-side endpoint.", async () => {
            const created = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            const uid = created.body.meeting.uid;

            expect((await authed(ctx.strangerToken()).post(ctx.baseUrl).send(createBody())).status).toBe(403);
            expect((await authed(ctx.strangerToken()).get(`${ctx.baseUrl}?mailboxUid=${ctx.mailboxUid()}`)).status).toBe(403);
            expect((await authed(ctx.strangerToken()).get(`${ctx.baseUrl}/${uid}`)).status).toBe(403);
            expect((await authed(ctx.strangerToken()).put(`${ctx.baseUrl}/${uid}`).send({ title: "x" })).status).toBe(403);
            expect((await authed(ctx.strangerToken()).delete(`${ctx.baseUrl}/${uid}`)).status).toBe(403);
        });

        it("Rejects a trusted+elevated administrator with no explicit grant (403) - the framework's superuser shortcut never applies.", async () => {
            const created = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            const uid = created.body.meeting.uid;

            expect((await authed(ctx.adminToken()).post(ctx.baseUrl).send(createBody())).status).toBe(403);
            expect((await authed(ctx.adminToken()).get(`${ctx.baseUrl}?mailboxUid=${ctx.mailboxUid()}`)).status).toBe(403);
            expect((await authed(ctx.adminToken()).get(`${ctx.baseUrl}/${uid}`)).status).toBe(403);
            expect((await authed(ctx.adminToken()).put(`${ctx.baseUrl}/${uid}`).send({ title: "x" })).status).toBe(403);
            expect((await authed(ctx.adminToken()).delete(`${ctx.baseUrl}/${uid}`)).status).toBe(403);
        });

        it("Lets a read-only delegate list and read, but not create, update or delete.", async () => {
            await ctx.grantMailboxAccess(ctx.delegateUid(), [ACLAction.READ, ACLAction.LIST]);
            const created = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            const uid = created.body.meeting.uid;

            expect((await authed(ctx.delegateToken()).get(`${ctx.baseUrl}?mailboxUid=${ctx.mailboxUid()}`)).status).toBe(200);
            expect((await authed(ctx.delegateToken()).get(`${ctx.baseUrl}/${uid}`)).status).toBe(200);
            expect((await authed(ctx.delegateToken()).post(ctx.baseUrl).send(createBody())).status).toBe(403);
            expect((await authed(ctx.delegateToken()).put(`${ctx.baseUrl}/${uid}`).send({ title: "x" })).status).toBe(403);
            expect((await authed(ctx.delegateToken()).delete(`${ctx.baseUrl}/${uid}`)).status).toBe(403);
        });

        it("Lets an owner create a second private meeting in the same mailbox (regression: a compound sparse index on mailboxUid+publicSlug once made the second one collide, since both meetings have no publicSlug at all).", async () => {
            const first = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            expect(first.status).toBe(200);
            const second = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            expect(second.status).toBe(200);
            expect(second.body.meeting.uid).not.toBe(first.body.meeting.uid);
        });
    });

    describe("join() token/slug resolution", () => {
        it("Returns 404 for an unknown token shaped like a join token.", async () => {
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${"A".repeat(43)}`);
            expect(result.status).toBe(404);
        });

        it("Returns 404 for an unknown token shaped like a public slug.", async () => {
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${"A".repeat(11)}`);
            expect(result.status).toBe(404);
        });

        it("Returns 404 for a value matching neither pattern's length.", async () => {
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/short`)).status).toBe(404);
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${"A".repeat(50)}`)).status).toBe(404);
        });

        it("Never resolves a query operator in place of a token.", async () => {
            const { joinToken } = await ctx.createPrivateMeeting();
            for (const token of ["like(*)", "regex(^)", `regex(^${joinToken[0]})`, "ne(x)", "exists(true)", "in(a,b)"]) {
                expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${encodeURIComponent(token)}`)).status).toBe(404);
            }
            // A real, valid token still works after all those attempts.
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${joinToken}`)).status).toBe(200);
        });

        it("Joins successfully with a valid private invitee token.", async () => {
            const { joinToken } = await ctx.createPrivateMeeting();
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${joinToken}`);
            expect(result.status).toBe(200);
            expect(result.body.authenticated).toBe(false);
            expect(result.body.token).toBeTruthy();
            expect(result.body.selfUid).toMatch(/^guest:/);
        });

        it("Joins as the caller's own real uid (no guest token) when already authenticated on a private invitee token.", async () => {
            const { joinToken } = await ctx.createPrivateMeeting();
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${joinToken}`).set("Authorization", "jwt " + ctx.strangerToken());
            expect(result.status).toBe(200);
            expect(result.body.authenticated).toBe(true);
            expect(result.body.selfUid).toBe(ctx.strangerUid());
            expect(result.body.token).toBeUndefined();
            expect(result.body.expiresAt).toBeUndefined();
        });

        it("Joins successfully with a valid public slug.", async () => {
            const { publicSlug } = await ctx.createPublicMeeting();
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`);
            expect(result.status).toBe(200);
        });

        it("Joins as the caller's own real uid (no guest token) when already authenticated on a public slug.", async () => {
            const { publicSlug } = await ctx.createPublicMeeting();
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`).set("Authorization", "jwt " + ctx.strangerToken());
            expect(result.status).toBe(200);
            expect(result.body.authenticated).toBe(true);
            expect(result.body.selfUid).toBe(ctx.strangerUid());
            expect(result.body.token).toBeUndefined();
        });

        it("Still takes the guest path for a returning guest presenting a prior join()'s own guest JWT, never the authenticated one.", async () => {
            const { publicSlug } = await ctx.createPublicMeeting();
            const first = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`);
            const second = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`).set("Authorization", "jwt " + first.body.token);
            expect(second.status).toBe(200);
            expect(second.body.authenticated).toBe(false);
            expect(second.body.selfUid).toMatch(/^guest:/);
            expect(second.body.token).toBeTruthy();
            // A fresh guest identity is minted each time - never reusing the presented guest uid.
            expect(second.body.selfUid).not.toBe(first.body.selfUid);
        });

        it("Returns 404 once the meeting has been cancelled, for both a private token and a public slug.", async () => {
            const priv = await ctx.createPrivateMeeting();
            await ctx.cancelMeeting(priv.uid);
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${priv.joinToken}`)).status).toBe(404);

            const pub = await ctx.createPublicMeeting();
            await ctx.cancelMeeting(pub.uid);
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${pub.publicSlug}`)).status).toBe(404);
        });
    });

    // A private meeting's `organizerSlug` exists only so its owner - deliberately never one of its own invitees -
    // has something that resolves to it at all. Unlike an invitee token or a public slug, holding it is NOT the
    // credential: `join()` additionally demands a real, already-authenticated caller holding READ on the meeting's
    // own mailbox, and answers the same bare 404 as a slug naming nothing for everyone else. These cases are the
    // whole security argument for the field, so they live here, backend-agnostic, next to the rest of the posture.
    describe("join() via the organizer's own slug", () => {
        it("Joins as the mailbox owner's own real identity, never a guest one.", async () => {
            const { uid, organizerSlug } = await ctx.createPrivateMeeting();
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${organizerSlug}`).set("Authorization", "jwt " + ctx.ownerToken());

            expect(result.status).toBe(200);
            expect(result.body.meeting.uid).toBe(uid);
            expect(result.body.authenticated).toBe(true);
            expect(result.body.selfUid).toBe(ctx.ownerUid());
            expect(result.body.token).toBeUndefined();
            expect(result.body.expiresAt).toBeUndefined();
        });

        it("Returns 404 for a true anonymous caller - an organizer slug is never an anonymous surface.", async () => {
            const { organizerSlug } = await ctx.createPrivateMeeting();
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/join/${organizerSlug}`)).status).toBe(404);
        });

        it("Returns 404 for a returning guest presenting a prior join()'s own guest JWT.", async () => {
            const { joinToken, organizerSlug } = await ctx.createPrivateMeeting();
            const guest = await request(ctx.app()).get(`${ctx.baseUrl}/join/${joinToken}`);
            expect(guest.body.selfUid).toMatch(/^guest:/);

            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${organizerSlug}`).set("Authorization", "jwt " + guest.body.token);
            expect(result.status).toBe(404);
        });

        it("Returns 404 for a real, logged-in stranger holding no grant on the meeting's mailbox.", async () => {
            const { organizerSlug } = await ctx.createPrivateMeeting();
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${organizerSlug}`).set("Authorization", "jwt " + ctx.strangerToken());
            expect(result.status).toBe(404);
        });

        it("Returns 404 for a trusted+elevated administrator with no explicit grant - the superuser shortcut never applies here either.", async () => {
            const { organizerSlug } = await ctx.createPrivateMeeting();
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${organizerSlug}`).set("Authorization", "jwt " + ctx.adminToken());
            expect(result.status).toBe(404);
        });

        it("Returns 404 once the meeting has been cancelled, even for the owner.", async () => {
            const { uid, organizerSlug } = await ctx.createPrivateMeeting();
            await ctx.cancelMeeting(uid);
            const result = await request(ctx.app()).get(`${ctx.baseUrl}/join/${organizerSlug}`).set("Authorization", "jwt " + ctx.ownerToken());
            expect(result.status).toBe(404);
        });
    });

    describe("the organizer/public join link (create/find/findById)", () => {
        it("Returns a working organizer join URL when creating a private meeting, alongside the invitee links.", async () => {
            const created = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());

            expect(created.status).toBe(200);
            expect(created.body.meeting.organizerSlug).toMatch(/^[A-Za-z0-9_-]{11}$/);
            expect(created.body.invitees).toHaveLength(1);
            expect(created.body.organizerJoinUrl.endsWith(`/${created.body.meeting.organizerSlug}`)).toBe(true);

            // "Working": the returned link's own final segment really does resolve for the owner.
            const joined = await request(ctx.app())
                .get(`${ctx.baseUrl}/join/${created.body.organizerJoinUrl.split("/").pop()}`)
                .set("Authorization", "jwt " + ctx.ownerToken());
            expect(joined.status).toBe(200);
            expect(joined.body.meeting.uid).toBe(created.body.meeting.uid);
        });

        it("Mints no organizer slug and returns no organizer join URL for a public meeting.", async () => {
            const created = await authed(ctx.ownerToken()).post(ctx.baseUrl).send({ mailboxUid: ctx.mailboxUid(), title: "Town Hall", visibility: "public" });

            expect(created.status).toBe(200);
            expect(created.body.meeting.organizerSlug).toBeUndefined();
            expect(created.body.organizerJoinUrl).toBeUndefined();
        });

        it("Includes the organizer join URL when re-reading a private meeting later, and the public join URL when re-reading a public one - never both on the same meeting.", async () => {
            const priv = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            const readPriv = await authed(ctx.ownerToken()).get(`${ctx.baseUrl}/${priv.body.meeting.uid}`);
            expect(readPriv.status).toBe(200);
            expect(readPriv.body.uid).toBe(priv.body.meeting.uid);
            expect(readPriv.body.organizerJoinUrl).toBe(priv.body.organizerJoinUrl);
            expect(readPriv.body.publicJoinUrl).toBeUndefined();

            const pub = await authed(ctx.ownerToken()).post(ctx.baseUrl).send({ mailboxUid: ctx.mailboxUid(), title: "Town Hall", visibility: "public" });
            const readPub = await authed(ctx.ownerToken()).get(`${ctx.baseUrl}/${pub.body.meeting.uid}`);
            expect(readPub.status).toBe(200);
            expect(readPub.body.organizerJoinUrl).toBeUndefined();
            expect(readPub.body.publicJoinUrl).toBe(pub.body.publicJoinUrl);
        });

        it("Includes the same organizerJoinUrl/publicJoinUrl on each listed meeting as create()/findById() return for it.", async () => {
            const priv = await authed(ctx.ownerToken()).post(ctx.baseUrl).send(createBody());
            const pub = await authed(ctx.ownerToken()).post(ctx.baseUrl).send({ mailboxUid: ctx.mailboxUid(), title: "Town Hall", visibility: "public" });

            const listed = await authed(ctx.ownerToken()).get(`${ctx.baseUrl}?mailboxUid=${ctx.mailboxUid()}`);
            expect(listed.status).toBe(200);
            const listedPriv = listed.body.find((m: any) => m.uid === priv.body.meeting.uid);
            const listedPub = listed.body.find((m: any) => m.uid === pub.body.meeting.uid);
            expect(listedPriv.organizerJoinUrl).toBe(priv.body.organizerJoinUrl);
            expect(listedPriv.publicJoinUrl).toBeUndefined();
            expect(listedPub.publicJoinUrl).toBe(pub.body.publicJoinUrl);
            expect(listedPub.organizerJoinUrl).toBeUndefined();
        });
    });
}
