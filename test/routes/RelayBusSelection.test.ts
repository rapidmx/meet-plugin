///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Which bus `BaseVideoMeetingRoute` carries relay frames on - Redis when `datastores:events` is configured, else
// in-process - and the relay working across two routes (two server replicas) on one fake Redis. No server is started:
// the route is constructed and initialized by hand, `authorizeRelay()` is stubbed, and the sockets are fakes.
import { EventEmitter } from "events";
import { BaseVideoMeetingRoute } from "../../src/routes/BaseVideoMeetingRoute.js";
import { RedisRelayBus } from "../../src/util/RedisRelayBus.js";
import { InProcessRelayBus } from "../../src/util/RelayHub.js";
import { FakeRedisServer } from "../util/fakeRedis.js";

const redis = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("redis", () => ({ createClient: redis.createClient }));

class TestRoute extends BaseVideoMeetingRoute<any, any, any> {
    protected meetingClass: any = class {};
    protected inviteeClass: any = class {};
    protected mailboxClass: any = class {};
    protected attendeeLinkClass: any = class {};
}

describe("BaseVideoMeetingRoute relay bus", () => {
    let server: FakeRedisServer;
    let logger: any;

    /** A route as the object factory would leave it: config injected, then `@Init` run. */
    async function route(events: { url?: string } | null): Promise<any> {
        const r: any = new TestRoute();
        r.logger = logger;
        r.eventsConfig = events;
        r.authorizeRelay = async () => undefined;
        await r.initRelayBus();
        return r;
    }

    const busOf = (r: any): unknown => r.relayHub.bus;

    beforeEach(() => {
        server = new FakeRedisServer();
        logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        redis.createClient.mockReset().mockImplementation((options: any) => server.createClient(options));
    });

    it("Starts out on an in-process bus, before it is initialized.", () => {
        const r: any = new TestRoute();
        expect(busOf(r)).toBeInstanceOf(InProcessRelayBus);
    });

    it("Uses the Redis bus when the events datastore is configured, connecting to its url.", async () => {
        const r = await route({ url: "redis://events:6379" });
        expect(busOf(r)).toBeInstanceOf(RedisRelayBus);
        expect(redis.createClient).toHaveBeenCalledWith(expect.objectContaining({ url: "redis://events:6379" }));
        expect(server.clients).toHaveLength(2);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("Falls back to the in-process bus, with a single warning, when the events datastore is not configured.", async () => {
        for (const events of [null, {}, { url: "" }]) {
            logger.warn.mockClear();
            const r = await route(events);
            expect(busOf(r)).toBeInstanceOf(InProcessRelayBus);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain("not between server replicas");
        }
        expect(redis.createClient).not.toHaveBeenCalled();
    });

    it("Falls back to the in-process bus, logging the error, when the Redis bus cannot be created.", async () => {
        server.throwOnCreate = 1;
        const r = await route({ url: "not a url" });
        expect(busOf(r)).toBeInstanceOf(InProcessRelayBus);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error.mock.calls[0][0]).toContain("Invalid URL");
    });

    it("Logs a Redis bus failure that is not an Error object as it is.", async () => {
        redis.createClient.mockReset().mockImplementation(() => {
            // eslint-disable-next-line no-throw-literal -- a dependency may throw anything
            throw "plain string reason";
        });
        const r = await route({ url: "redis://events:6379" });
        expect(busOf(r)).toBeInstanceOf(InProcessRelayBus);
        expect(logger.error.mock.calls[0][0]).toContain("plain string reason");
    });

    it("Disconnects the Redis bus when destroyed, and is fine to destroy without one.", async () => {
        const r = await route({ url: "redis://events:6379" });
        r.destroyRelayBus();
        expect(server.clients.map((c) => c.destroyed)).toEqual([true, true]);
        r.destroyRelayBus();
        (await route(null)).destroyRelayBus();
    });

    it("Relays a socket's media to a participant connected to another replica.", async () => {
        const replica1 = await route({ url: "redis://events:6379" });
        const replica2 = await route({ url: "redis://events:6379" });

        const connect = async (r: any, uid: string, wanted: string[]): Promise<any> => {
            const sock: any = new EventEmitter();
            sock.send = vi.fn();
            sock.close = vi.fn();
            await r.relay("meeting-1", { path: "/relay/meeting-1" }, sock, { uid });
            sock.emit("message", JSON.stringify({ op: "hello", v: 1, peer: uid }), false);
            sock.emit("message", JSON.stringify({ op: "want", peers: wanted }), false);
            return sock;
        };
        const alice = await connect(replica1, "alice", []);
        const bob = await connect(replica2, "bob", ["alice"]);

        alice.emit("message", Buffer.from([1, 2, 3]), true);
        await server.settle();

        const frames = bob.send.mock.calls.map((c: any[]) => c[0]).filter((d: any) => typeof d !== "string");
        expect(frames.map((f: Buffer) => [...f])).toEqual([[5, ...Buffer.from("alice"), 1, 2, 3]]);
        expect(alice.send.mock.calls.filter((c: any[]) => typeof c[0] !== "string")).toHaveLength(0);

        // The hub of a Redis-bus route logs through the route's logger.
        bob.send.mockImplementation(() => {
            throw new Error("socket is gone");
        });
        alice.emit("message", Buffer.from([4]), true);
        await server.settle();
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Dropped a relay frame for bob"));

        alice.emit("close");
        bob.emit("close");
        replica1.destroyRelayBus();
        replica2.destroyRelayBus();
    });
});
