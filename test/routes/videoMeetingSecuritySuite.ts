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
     * meeting and that invitee's join token. */
    createPrivateMeeting: () => Promise<{ uid: string; joinToken: string }>;
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
}
