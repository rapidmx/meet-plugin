///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The meeting's signaling WebSocket route (`BaseVideoMeetingRoute.signal()`) and `kick()` closing a removed
// participant's signaling sockets - identical on both backends. Run from the VideoMeetingRoute test files, which
// supply a started server and fixtures. Like `relaySuite`, most cases open real sockets against the test server
// (authenticated with the `auth_token` query parameter), and a few drive `signal()` directly with a fake socket for
// the paths a real socket can't reach deterministically.
import { EventEmitter } from "events";
import { request } from "@rapidrest/service-core/test";
import { RelayClient, type RelaySuiteContext } from "./relaySuite.js";

/** The `data` of every `signal` message a client received. */
const signalsOf = (client: RelayClient): any[] =>
    client.messages
        .filter((m): m is string => typeof m === "string")
        .map((m) => JSON.parse(m))
        .filter((m) => m.op === "signal")
        .map((m) => m.data);

export function signalingSuite(ctx: RelaySuiteContext): void {
    const clients: RelayClient[] = [];
    const url = (meetingUid: string, token: string): string => `ws://localhost:${ctx.wsPort()}${ctx.baseUrl}/signal/${meetingUid}?auth_token=${token}`;
    const connect = (meetingUid: string, token: string): RelayClient => {
        const client = new RelayClient(url(meetingUid, token));
        clients.push(client);
        return client;
    };
    /** Connects and says hello straight away, as a real client does. */
    const hello = async (meetingUid: string, token: string, peer: string): Promise<RelayClient> => {
        const client = connect(meetingUid, token);
        await client.opened;
        client.sendText({ op: "hello", v: 1, peer });
        return client;
    };
    const joinAsGuest = async (publicSlug: string): Promise<{ token: string; uid: string }> => {
        const joined = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`);
        return { token: joined.body.token, uid: joined.body.selfUid };
    };

    afterEach(() => {
        for (const client of clients.splice(0)) {
            client.close();
        }
    });

    describe("signal() at /signal/:id", () => {
        it("Lets two participants in, answers hello with ready, and carries a stamped message from one to the other.", async () => {
            const { uid, publicSlug } = await ctx.createPublicMeeting();
            const guest = await joinAsGuest(publicSlug);
            const ownerPeer = `${ctx.ownerUid()}~laptop`;
            const guestPeer = `${guest.uid}~phone`;

            const owner = await hello(uid, ctx.ownerToken(), ownerPeer);
            const guestClient = await hello(uid, guest.token, guestPeer);
            await owner.readyMessage();
            await guestClient.readyMessage();

            // A forged sender is overwritten; `to` reaches only the named peer.
            guestClient.sendText({ op: "signal", data: { type: "offer", to: ownerPeer, from: "someone-else", peer: "someone-else" } });
            const received = await owner.waitFor("the offer", () => signalsOf(owner)[0]);
            expect(received).toEqual({ type: "offer", to: ownerPeer, from: guest.uid, peer: guestPeer });

            owner.sendText({ op: "signal", data: { type: "chat", text: "hi" } });
            expect(await guestClient.waitFor("the chat", () => signalsOf(guestClient)[0])).toEqual({ type: "chat", text: "hi", from: ctx.ownerUid(), peer: ownerPeer });
            expect(signalsOf(owner)).toHaveLength(1);
            expect(owner.closeInfo).toBeUndefined();
        });

        it("Refuses a stranger with no grant, closing with 1008 \"Not permitted.\".", async () => {
            const { uid } = await ctx.createPublicMeeting();
            expect(await connect(uid, ctx.strangerToken()).closed()).toEqual({ code: 1008, reason: "Not permitted." });
            expect(await connect(uid, ctx.adminToken()).closed()).toEqual({ code: 1008, reason: "Not permitted." });
        });

        it("Refuses a meeting that does not exist, a cancelled one and an ended one with the very same reason.", async () => {
            expect(await connect("00000000-0000-4000-8000-000000000000", ctx.ownerToken()).closed()).toEqual({ code: 1008, reason: "Not permitted." });

            const cancelled = await ctx.createPublicMeeting();
            await ctx.cancelMeeting(cancelled.uid);
            expect(await connect(cancelled.uid, ctx.ownerToken()).closed()).toEqual({ code: 1008, reason: "Not permitted." });

            const { uid } = await ctx.createPublicMeeting();
            const route: any = ctx.route();
            await route.initialize();
            const spy = vi.spyOn(route.meetingRepo, "findOne").mockResolvedValue({ uid, status: "ended" });
            try {
                expect(await connect(uid, ctx.ownerToken()).closed()).toEqual({ code: 1008, reason: "Not permitted." });
            } finally {
                spy.mockRestore();
            }
        });

        it("Still works when the media relay is turned off - signaling is never switched off.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const route: any = ctx.route();
            const original = route.relayEnabledSetting;
            route.relayEnabledSetting = "false";
            try {
                await (await hello(uid, ctx.ownerToken(), ctx.ownerUid())).readyMessage();
            } finally {
                route.relayEnabledSetting = original;
            }
        });

        it("Closes a kicked participant's signaling socket with 1008 \"Removed from the meeting.\", leaving the others open.", async () => {
            const { uid, publicSlug } = await ctx.createPublicMeeting();
            const guest = await joinAsGuest(publicSlug);
            const owner = await hello(uid, ctx.ownerToken(), ctx.ownerUid());
            const guestClient = await hello(uid, guest.token, guest.uid);
            await owner.readyMessage();
            await guestClient.readyMessage();

            const kicked = await request(ctx.app())
                .post(`${ctx.baseUrl}/${uid}/kick/${encodeURIComponent(guest.uid)}`)
                .set("Authorization", "jwt " + ctx.ownerToken());
            expect(kicked.status).toBe(204);

            expect(await guestClient.closed()).toEqual({ code: 1008, reason: "Removed from the meeting." });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(owner.closeInfo).toBeUndefined();
            // And the revoked grant keeps them out.
            expect(await connect(uid, guest.token).closed()).toEqual({ code: 1008, reason: "Not permitted." });
        });

        it("Releases the room when its last socket closes.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const hub = ctx.route().signalingHub;
            const client = await hello(uid, ctx.ownerToken(), ctx.ownerUid());
            await client.readyMessage();
            expect(hub.socketCount(uid)).toBe(1);
            client.close();
            await client.waitFor("the room to be released", () => (hub.socketCount(uid) === 0 ? true : undefined));
        });
    });

    describe("signal() with a fake socket", () => {
        const fakeSocket = (): any => {
            const sock: any = new EventEmitter();
            sock.send = vi.fn();
            sock.close = vi.fn();
            return sock;
        };
        const owner = () => ({ uid: ctx.ownerUid(), roles: [], scopes: [], elevated: Date.now() });
        const helloText = (peer: string): string => JSON.stringify({ op: "hello", v: 1, peer });

        /** Runs `signal()` for the owner with `authorizeMeetingSocket()` held until `release()` is called. */
        const withHeldAuthorization = async (meetingUid: string, body: (sock: any, release: () => void, done: Promise<void>) => Promise<void>): Promise<void> => {
            const route: any = ctx.route();
            const original = route.authorizeMeetingSocket.bind(route);
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const spy = vi.spyOn(route, "authorizeMeetingSocket").mockImplementation(async (...args: any[]) => {
                const [id, user] = args;
                await gate;
                return original(id, user);
            });
            try {
                const sock = fakeSocket();
                const done: Promise<void> = route.signal(meetingUid, {}, sock, owner());
                await body(sock, release, done);
            } finally {
                spy.mockRestore();
            }
        };

        it("Refuses a missing user and an empty meeting id with 1008 \"Not permitted.\".", async () => {
            const route: any = ctx.route();
            const noUser = fakeSocket();
            await route.signal("some-meeting", {}, noUser, undefined);
            expect(noUser.close).toHaveBeenCalledWith(1008, "Not permitted.");
            const noId = fakeSocket();
            await route.signal(undefined, {}, noId, owner());
            expect(noId.close).toHaveBeenCalledWith(1008, "Not permitted.");
        });

        it("Reads the meeting uid from the request path when the router supplies no path parameter.", async () => {
            const route: any = ctx.route();
            const { uid } = await ctx.createPublicMeeting();
            const attach = vi.spyOn(route.signalingHub, "attach");
            try {
                const sock = fakeSocket();
                await route.signal(undefined, { path: `${ctx.baseUrl}/signal/${uid}` }, sock, owner());
                expect(sock.close).not.toHaveBeenCalled();
                expect(attach).toHaveBeenLastCalledWith(uid, ctx.ownerUid(), sock);
                sock.emit("close");
            } finally {
                attach.mockRestore();
            }
        });

        it("Closes with 1011 \"Signaling unavailable.\" when authorizing throws, rather than leaking the error.", async () => {
            const route: any = ctx.route();
            const { uid } = await ctx.createPublicMeeting();
            await route.initialize();
            for (const failure of [new Error("database exploded"), "plain string"]) {
                const spy = vi.spyOn(route.meetingRepo, "findOne").mockRejectedValue(failure);
                try {
                    const sock = fakeSocket();
                    await route.signal(uid, {}, sock, owner());
                    expect(sock.close).toHaveBeenCalledWith(1011, "Signaling unavailable.");
                    expect(sock.close).toHaveBeenCalledTimes(1);
                } finally {
                    spy.mockRestore();
                }
            }
        });

        it("Holds what a socket sends while it is being authorized and replays it once admitted.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            await withHeldAuthorization(uid, async (sock, release, done) => {
                sock.emit("message", helloText(ctx.ownerUid()), false);
                expect(sock.send).not.toHaveBeenCalled();
                release();
                await done;
                expect(sock.send).toHaveBeenCalledWith(expect.stringMatching(/^\{"op":"ready","v":1,"maxMessageBytes":\d+\}$/));

                // And it is wired up for what comes after.
                sock.emit("message", JSON.stringify({ op: "ping", t: 5 }), false);
                expect(sock.send).toHaveBeenLastCalledWith(JSON.stringify({ op: "pong", t: 5 }));
                sock.emit("close");
                expect(ctx.route().signalingHub.socketCount(uid)).toBe(0);
            });
        });

        it("Holds only a handful of messages while authorizing, dropping the rest.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            await withHeldAuthorization(uid, async (sock, release, done) => {
                for (let i = 0; i < 8; i++) {
                    sock.emit("message", "junk", false);
                }
                sock.emit("message", helloText(ctx.ownerUid()), false);
                release();
                await done;
                expect(sock.send).not.toHaveBeenCalled();
                sock.emit("close");
            });
        });

        it("Attaches nothing when the socket closed while it was being authorized.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            await withHeldAuthorization(uid, async (sock, release, done) => {
                sock.emit("close");
                release();
                await done;
                expect(ctx.route().signalingHub.socketCount(uid)).toBe(0);
                expect(sock.close).not.toHaveBeenCalled();
            });
        });

        it("Leaves a socket the hub refused (room full) alone, replaying nothing.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const route: any = ctx.route();
            const spy = vi.spyOn(route.signalingHub, "attach").mockReturnValue(undefined);
            try {
                await withHeldAuthorization(uid, async (sock, release, done) => {
                    sock.emit("message", helloText(ctx.ownerUid()), false);
                    release();
                    await done;
                    sock.emit("message", helloText(ctx.ownerUid()), false);
                    expect(sock.send).not.toHaveBeenCalled();
                    sock.emit("close");
                });
            } finally {
                spy.mockRestore();
            }
        });
    });
}
