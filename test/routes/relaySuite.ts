///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The WebSocket media relay route (`BaseVideoMeetingRoute.relay()`) - identical on both backends. Run from the
// VideoMeetingRoute test files, which supply a started server and fixtures. Most cases open real sockets against the
// test server (Node's built-in `WebSocket`, authenticated with the `auth_token` query parameter the test config
// allows - a client cannot set a header on a browser-style WebSocket either), so the route's real registration,
// upgrade authentication and binary handling are what is exercised; a few drive `relay()` directly with a fake socket
// for the paths a real socket can't reach deterministically.
import { EventEmitter } from "events";
import { ACLAction, RouteDecorators } from "@rapidrest/service-core";
import { request } from "@rapidrest/service-core/test";
import type { VideoMeetingSecuritySuiteContext } from "./videoMeetingSecuritySuite.js";

export interface RelaySuiteContext extends VideoMeetingSecuritySuiteContext {
    /** The port the test server listens on. */
    wsPort: () => number;
    /** The route instance the server mounted - its `relayEnabledSetting` is what the tests toggle. */
    route: () => any;
}

/** A thin client over Node's `WebSocket` that records everything the server sends and how it closed the socket. */
class RelayClient {
    public readonly messages: (string | Buffer)[] = [];
    public closeInfo?: { code: number; reason: string };
    public readonly opened: Promise<void>;
    private readonly ws: WebSocket;

    constructor(url: string) {
        this.ws = new WebSocket(url);
        this.ws.binaryType = "arraybuffer";
        this.ws.addEventListener("message", (event: MessageEvent) => {
            this.messages.push(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer));
        });
        this.ws.addEventListener("close", (event: CloseEvent) => {
            this.closeInfo = { code: event.code, reason: event.reason };
        });
        this.opened = new Promise((resolve, reject) => {
            this.ws.addEventListener("open", () => resolve());
            this.ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")));
        });
    }

    public sendText(message: unknown): void {
        this.ws.send(JSON.stringify(message));
    }

    public sendBinary(payload: Uint8Array): void {
        this.ws.send(payload as BufferSource);
    }

    public close(): void {
        this.ws.close();
    }

    /** Polls until `probe()` returns something other than `undefined`, or fails after `timeoutMs`. */
    public async waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
        const deadline: number = Date.now() + timeoutMs;
        for (;;) {
            const value: T | undefined = probe();
            if (value !== undefined) {
                return value;
            }
            if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for ${what}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    public async closed(): Promise<{ code: number; reason: string }> {
        return await this.waitFor("the socket to close", () => this.closeInfo);
    }

    public async binaryMessage(index = 0): Promise<Buffer> {
        return await this.waitFor(`binary message ${index}`, () => this.messages.filter((m): m is Buffer => typeof m !== "string")[index]);
    }

    public async readyMessage(): Promise<void> {
        await this.waitFor("ready", () => this.messages.find((m) => typeof m === "string" && JSON.parse(m).op === "ready" && JSON.parse(m).v === 1));
    }
}

export function relaySuite(ctx: RelaySuiteContext): void {
    const clients: RelayClient[] = [];
    const url = (meetingUid: string, token: string): string => `ws://localhost:${ctx.wsPort()}${ctx.baseUrl}/relay/${meetingUid}?auth_token=${token}`;
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
    const withRelaySetting = async (value: unknown, body: () => Promise<void>): Promise<void> => {
        const route: any = ctx.route();
        const original = route.relayEnabledSetting;
        route.relayEnabledSetting = value;
        try {
            await body();
        } finally {
            route.relayEnabledSetting = original;
        }
    };

    afterEach(() => {
        for (const client of clients.splice(0)) {
            client.close();
        }
    });

    describe("relay() at /relay/:id", () => {
        it("Lets the owner in and answers hello with ready - which also proves the route is registered at <base>/relay/<meetingUid>.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const client = await hello(uid, ctx.ownerToken(), ctx.ownerUid());
            await client.readyMessage();
            expect(client.closeInfo).toBeUndefined();
        });

        it("Lets a guest holding the grant join() gave them in, with a `<uid>~tab` peer id.", async () => {
            const { uid, publicSlug } = await ctx.createPublicMeeting();
            const guest = await joinAsGuest(publicSlug);
            const client = await hello(uid, guest.token, `${guest.uid}~tab-1`);
            await client.readyMessage();
        });

        it("Lets an already-authenticated real caller in once join() granted them their own uid.", async () => {
            const { uid, publicSlug } = await ctx.createPublicMeeting();
            await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`).set("Authorization", "jwt " + ctx.strangerToken());
            const client = await hello(uid, ctx.strangerToken(), ctx.strangerUid());
            await client.readyMessage();
        });

        it("Refuses a stranger with no grant, closing with 1008 \"Not permitted.\".", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const client = connect(uid, ctx.strangerToken());
            expect(await client.closed()).toEqual({ code: 1008, reason: "Not permitted." });
        });

        it("Refuses a trusted+elevated administrator with no explicit grant, exactly as /push does.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const client = connect(uid, ctx.adminToken());
            expect(await client.closed()).toEqual({ code: 1008, reason: "Not permitted." });
        });

        it("Refuses a caller holding READ but not CREATE - both are required.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const route: any = ctx.route();
            const aclUtils: any = route.aclUtils;
            const original = aclUtils.hasPermission.bind(aclUtils);
            const spy = vi.spyOn(aclUtils, "hasPermission").mockImplementation(async (...args: any[]) => {
                const [user, acl, action] = args;
                return action === ACLAction.CREATE ? false : original(user, acl, action);
            });
            try {
                const client = connect(uid, ctx.ownerToken());
                expect(await client.closed()).toEqual({ code: 1008, reason: "Not permitted." });
                expect(spy.mock.calls.map((c) => c[2])).toContain(ACLAction.CREATE);
            } finally {
                spy.mockRestore();
            }
        });

        it("Refuses a meeting that does not exist with the very same reason, never revealing whether it does.", async () => {
            const owner = connect("00000000-0000-4000-8000-000000000000", ctx.ownerToken());
            expect(await owner.closed()).toEqual({ code: 1008, reason: "Not permitted." });
            const stranger = connect("00000000-0000-4000-8000-000000000000", ctx.strangerToken());
            expect(await stranger.closed()).toEqual({ code: 1008, reason: "Not permitted." });
        });

        it("Refuses a cancelled meeting, even for its owner and a guest who joined before it was cancelled.", async () => {
            const { uid, publicSlug } = await ctx.createPublicMeeting();
            const guest = await joinAsGuest(publicSlug);
            await ctx.cancelMeeting(uid);

            expect(await connect(uid, ctx.ownerToken()).closed()).toEqual({ code: 1008, reason: "Not permitted." });
            expect(await connect(uid, guest.token).closed()).toEqual({ code: 1008, reason: "Not permitted." });
        });

        it("Refuses an ended meeting.", async () => {
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

        it("Refuses every socket with 1008 \"Relay disabled.\" when the relay is turned off, however the setting is spelled.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            for (const value of [false, "false", "FALSE", "0", 0]) {
                await withRelaySetting(value, async () => {
                    expect(await connect(uid, ctx.ownerToken()).closed()).toEqual({ code: 1008, reason: "Relay disabled." });
                });
            }
            // Turned back on (or spelled as a string, as an environment variable arrives), it works again.
            await withRelaySetting("true", async () => {
                await (await hello(uid, ctx.ownerToken(), ctx.ownerUid())).readyMessage();
            });
        });

        it("Reports relayEnabled from join(), on both the guest and the authenticated branch.", async () => {
            const { publicSlug } = await ctx.createPublicMeeting();
            const guest = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`);
            expect(guest.body.authenticated).toBe(false);
            expect(guest.body.relayEnabled).toBe(true);
            const real = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`).set("Authorization", "jwt " + ctx.strangerToken());
            expect(real.body.authenticated).toBe(true);
            expect(real.body.relayEnabled).toBe(true);

            await withRelaySetting("false", async () => {
                const offGuest = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`);
                expect(offGuest.body.relayEnabled).toBe(false);
                const offReal = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`).set("Authorization", "jwt " + ctx.strangerToken());
                expect(offReal.body.relayEnabled).toBe(false);
            });
        });

        it("Closes a socket that answers a bad hello with 1008 \"Invalid peer.\".", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const client = await hello(uid, ctx.ownerToken(), "somebody-else");
            expect(await client.closed()).toEqual({ code: 1008, reason: "Invalid peer." });
        });

        it("Relays a binary frame from one participant to another that asked for it, stamped with the sender's peer id.", async () => {
            const { uid, publicSlug } = await ctx.createPublicMeeting();
            const guest = await joinAsGuest(publicSlug);
            const ownerPeer = `${ctx.ownerUid()}~laptop`;
            const guestPeer = `${guest.uid}~phone`;

            const owner = await hello(uid, ctx.ownerToken(), ownerPeer);
            const guestClient = await hello(uid, guest.token, guestPeer);
            await owner.readyMessage();
            await guestClient.readyMessage();

            guestClient.sendText({ op: "want", peers: [ownerPeer] });
            owner.sendText({ op: "want", peers: ["nobody"] });
            // Text is processed in order per socket but not across sockets: give the want a moment to land.
            await new Promise((resolve) => setTimeout(resolve, 100));

            const payload = Buffer.from([1, 2, 3, 4, 5]);
            owner.sendBinary(payload);
            guestClient.sendBinary(Buffer.from([9]));

            const frame = await guestClient.binaryMessage();
            const senderLength = frame[0];
            expect(senderLength).toBe(Buffer.byteLength(ownerPeer));
            expect(frame.subarray(1, 1 + senderLength).toString("utf8")).toBe(ownerPeer);
            expect(frame.subarray(1 + senderLength)).toEqual(payload);

            // The owner wanted only "nobody", so the guest's frame went nowhere - and the owner got nothing else.
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(owner.messages.filter((m) => typeof m !== "string")).toEqual([]);
            expect(guestClient.messages.filter((m) => typeof m !== "string")).toHaveLength(1);
        });

        // A real uWS server: the framework only accepts a message over 16 KiB on this route when the relay route asked it to
        // (`@WebSocket(path, options)`, @rapidrest/service-core 2.4.0), which is what makes a key frame one message.
        const supportsLargeMessages = "MAX_WEBSOCKET_PAYLOAD_LENGTH" in RouteDecorators;

        it.skipIf(!supportsLargeMessages)("Relays a message well over the framework's default 16 KiB limit, and says the limit in ready.", async () => {
            const { uid, publicSlug } = await ctx.createPublicMeeting();
            const guest = await joinAsGuest(publicSlug);
            const ownerPeer = `${ctx.ownerUid()}~laptop`;
            const guestPeer = `${guest.uid}~phone`;
            const owner = await hello(uid, ctx.ownerToken(), ownerPeer);
            const guestClient = await hello(uid, guest.token, guestPeer);
            await owner.readyMessage();
            await guestClient.readyMessage();
            expect(owner.messages.find((m) => typeof m === "string" && JSON.parse(m).op === "ready")).toBe(
                JSON.stringify({ op: "ready", v: 1, maxMessageBytes: 64 * 1024 }),
            );

            guestClient.sendText({ op: "want", peers: [ownerPeer] });
            await new Promise((resolve) => setTimeout(resolve, 100));
            const payload = Buffer.alloc(60 * 1024, 0xab);
            owner.sendBinary(payload);

            const frame = await guestClient.binaryMessage();
            expect(frame.subarray(1 + frame[0])).toEqual(payload);
            expect(owner.closeInfo).toBeUndefined();
        });

        it("Accepts a hello sent the instant the socket opens, before the meeting has been looked up.", async () => {
            // `hello()` above already does; this is the same path repeated back to back so a listener attached
            // only after an await would lose at least one of them.
            const { uid } = await ctx.createPublicMeeting();
            const clients = await Promise.all(
                [0, 1, 2, 3].map((i) => hello(uid, ctx.ownerToken(), `${ctx.ownerUid()}~${i}`)),
            );
            for (const client of clients) {
                await client.readyMessage();
            }
        });

        it("Replaces a socket that registers an already registered peer, and tells it so.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const first = await hello(uid, ctx.ownerToken(), `${ctx.ownerUid()}~tab`);
            await first.readyMessage();
            const second = await hello(uid, ctx.ownerToken(), `${ctx.ownerUid()}~tab`);
            await second.readyMessage();
            expect(await first.closed()).toEqual({ code: 1008, reason: "Replaced." });
        });

        it("Releases the room when its last socket closes.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const hub = ctx.route().relayHub;
            const client = await hello(uid, ctx.ownerToken(), ctx.ownerUid());
            await client.readyMessage();
            expect(hub.socketCount(uid)).toBe(1);
            client.close();
            await client.waitFor("the room to be released", () => (hub.roomCount === 0 ? true : undefined));
            expect(hub.socketCount(uid)).toBe(0);
        });
    });

    // The paths below need timing a real socket can't give deterministically, so `relay()` is driven directly with
    // a fake socket (the same shape the framework's uWS shim has: an EventEmitter with send/close).
    describe("relay() with a fake socket", () => {
        const fakeSocket = (): any => {
            const sock: any = new EventEmitter();
            sock.send = vi.fn();
            sock.close = vi.fn();
            return sock;
        };
        const owner = () => ({ uid: ctx.ownerUid(), roles: [], scopes: [], elevated: Date.now() });
        const helloText = (peer: string): string => JSON.stringify({ op: "hello", v: 1, peer });

        /** Runs `relay()` for the owner with `authorizeRelay()` held until `release()` is called. */
        const withHeldAuthorization = async (meetingUid: string, body: (sock: any, release: () => void, done: Promise<void>) => Promise<void>): Promise<void> => {
            const route: any = ctx.route();
            const original = route.authorizeRelay.bind(route);
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const spy = vi.spyOn(route, "authorizeRelay").mockImplementation(async (...args: any[]) => {
                const [id, user] = args;
                await gate;
                return original(id, user);
            });
            try {
                const sock = fakeSocket();
                const done: Promise<void> = route.relay(meetingUid, {}, sock, owner());
                await body(sock, release, done);
            } finally {
                spy.mockRestore();
            }
        };

        it("Refuses a missing user and an empty meeting id with 1008 \"Not permitted.\" without consulting the ACL.", async () => {
            const route: any = ctx.route();
            const aclSpy = vi.spyOn(route.aclUtils, "hasPermission");
            try {
                const noUser = fakeSocket();
                await route.relay("some-meeting", {}, noUser, undefined);
                expect(noUser.close).toHaveBeenCalledWith(1008, "Not permitted.");

                const noId = fakeSocket();
                await route.relay("", {}, noId, owner());
                expect(noId.close).toHaveBeenCalledWith(1008, "Not permitted.");
                expect(aclSpy).not.toHaveBeenCalled();
            } finally {
                aclSpy.mockRestore();
            }
        });

        it("Reads the meeting uid from the request path when the router supplies no path parameter (uWS never does for a WebSocket), and refuses a path with none.", async () => {
            const route: any = ctx.route();
            const { uid } = await ctx.createPublicMeeting();
            const attach = vi.spyOn(route.relayHub, "attach");
            try {
                for (const path of [`${ctx.baseUrl}/relay/${uid}`, `${ctx.baseUrl}/relay/${uid}/`, `${ctx.baseUrl}/relay/${encodeURIComponent(uid)}`]) {
                    const sock = fakeSocket();
                    await route.relay(undefined, { path }, sock, owner());
                    expect(sock.close).not.toHaveBeenCalled();
                    expect(attach).toHaveBeenLastCalledWith(uid, ctx.ownerUid(), sock);
                    sock.emit("close");
                }
            } finally {
                attach.mockRestore();
            }

            // No parameter and no usable path: the same refusal as for any other unauthorized caller.
            for (const req of [undefined, {}, { path: "/" }, { path: `${ctx.baseUrl}/relay/%E0%A4%A` }]) {
                const sock = fakeSocket();
                await route.relay(undefined, req, sock, owner());
                expect(sock.close).toHaveBeenCalledWith(1008, "Not permitted.");
            }
        });

        it("Closes with 1011 \"Relay unavailable.\" when authorizing throws, rather than leaking the error.", async () => {
            const route: any = ctx.route();
            const { uid } = await ctx.createPublicMeeting();
            await route.initialize();
            const spy = vi.spyOn(route.meetingRepo, "findOne").mockRejectedValue(new Error("database exploded"));
            try {
                const sock = fakeSocket();
                await route.relay(uid, {}, sock, owner());
                expect(sock.close).toHaveBeenCalledWith(1011, "Relay unavailable.");
                expect(sock.close).toHaveBeenCalledTimes(1);
            } finally {
                spy.mockRestore();
            }
            // A non-Error rejection is reported the same way.
            const spy2 = vi.spyOn(route.meetingRepo, "findOne").mockRejectedValue("plain string");
            try {
                const sock = fakeSocket();
                await route.relay(uid, {}, sock, owner());
                expect(sock.close).toHaveBeenCalledWith(1011, "Relay unavailable.");
            } finally {
                spy2.mockRestore();
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

                // And it is wired up for what comes after: a bad message now closes it directly.
                sock.emit("message", helloText("ignored, already registered"), false);
                sock.emit("close");
                expect(ctx.route().relayHub.roomCount).toBe(0);
            });
        });

        it("Holds only a handful of messages while authorizing, dropping the rest.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            await withHeldAuthorization(uid, async (sock, release, done) => {
                for (let i = 0; i < 8; i++) {
                    sock.emit("message", "junk", false);
                }
                // The ninth would be the hello - it is dropped, so the socket never says ready.
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
                expect(ctx.route().relayHub.roomCount).toBe(0);
                expect(sock.close).not.toHaveBeenCalled();
            });
        });

        it("Logs, at debug level, a frame a receiver's socket dropped for backpressure, and keeps relaying.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const route: any = ctx.route();
            const debug = vi.spyOn(route.logger, "debug");
            try {
                const sender = fakeSocket();
                const receiver = fakeSocket();
                await route.relay(uid, {}, sender, owner());
                await route.relay(uid, {}, receiver, owner());
                sender.emit("message", helloText(ctx.ownerUid()), false);
                receiver.emit("message", helloText(`${ctx.ownerUid()}~2`), false);
                receiver.emit("message", JSON.stringify({ op: "want", peers: [ctx.ownerUid()] }), false);
                receiver.send = vi.fn((_data: any, cb?: (err?: Error) => void) => cb?.(new Error("uWS backpressure limit reached: message dropped")));

                sender.emit("message", Buffer.from([1, 2, 3]), true);

                expect(receiver.send).toHaveBeenCalledTimes(1);
                expect(debug.mock.calls.some((call: any[]) => String(call[0]).includes("Dropped a relay frame"))).toBe(true);
                expect(sender.close).not.toHaveBeenCalled();
                expect(receiver.close).not.toHaveBeenCalled();
                sender.emit("close");
                receiver.emit("close");
            } finally {
                debug.mockRestore();
            }
        });

        it("Leaves a socket the hub refused (room full) alone, replaying nothing.", async () => {
            const { uid } = await ctx.createPublicMeeting();
            const route: any = ctx.route();
            const spy = vi.spyOn(route.relayHub, "attach").mockReturnValue(undefined);
            try {
                const sock = fakeSocket();
                await route.relay(uid, {}, sock, owner());
                sock.emit("message", helloText(ctx.ownerUid()), false);
                expect(sock.send).not.toHaveBeenCalled();
                sock.emit("close");
            } finally {
                spy.mockRestore();
            }
        });
    });
}
