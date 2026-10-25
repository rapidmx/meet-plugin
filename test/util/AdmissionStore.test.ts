///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    ADMISSION_TTL_MS,
    InMemoryAdmissionStore,
    REDIS_ADMISSIONS_KEY_PREFIX,
    RedisAdmissionStore,
    type PendingAdmission,
} from "../../src/util/AdmissionStore.js";
import { FakeRedisServer } from "./fakeRedis.js";

const redis = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("redis", () => ({ createClient: redis.createClient }));

const START = 1_700_000_000_000;
const request = (name: string, requestedAt: number, status: PendingAdmission["status"] = "pending"): PendingAdmission => ({ name, requestedAt, status });

describe("InMemoryAdmissionStore", () => {
    it("files, reads, lists and removes requests per meeting, handing out copies", async () => {
        const store = new InMemoryAdmissionStore(() => START);
        await store.set("m1", "guest:a", request("Ada", START));
        await store.set("m1", "guest:b", request("Bob", START));
        await store.set("m2", "guest:a", request("Ada elsewhere", START));

        const one = (await store.get("m1", "guest:a"))!;
        one.status = "admitted";
        expect(await store.get("m1", "guest:a")).toEqual(request("Ada", START));
        expect([...(await store.list("m1")).keys()]).toEqual(["guest:a", "guest:b"]);
        expect(await store.list("m3")).toEqual(new Map());

        await store.delete("m1", "guest:a");
        await store.delete("m1", "guest:b");
        await store.delete("m1", "guest:missing");
        await store.delete("m9", "guest:a");
        expect(await store.list("m1")).toEqual(new Map());
        expect(await store.get("m2", "guest:a")).toEqual(request("Ada elsewhere", START));
    });

    it("never returns a request older than ADMISSION_TTL_MS, and forgets abandoned ones on its periodic sweep", async () => {
        let now = START;
        const store = new InMemoryAdmissionStore(() => now);
        await store.set("m1", "guest:old", request("Old", START));
        await store.set("m2", "guest:abandoned", request("Gone", START));
        now = START + ADMISSION_TTL_MS - 1;
        await store.set("m1", "guest:new", request("New", now));
        expect(await store.get("m1", "guest:old")).toBeDefined();

        now = START + ADMISSION_TTL_MS;
        expect(await store.get("m1", "guest:old")).toBeUndefined();
        expect([...(await store.list("m1")).keys()]).toEqual(["guest:new"]);
        // The next sweep, a minute on, drops the abandoned meeting altogether and keeps the live request.
        expect((store as any).meetings.has("m2")).toBe(true);
        now += 60_000;
        await store.list("m1");
        expect((store as any).meetings.has("m2")).toBe(false);
        expect((store as any).meetings.get("m1").size).toBe(1);
    });

    it("defaults to the real clock", async () => {
        const store = new InMemoryAdmissionStore();
        await store.set("m1", "guest:a", request("Ada", Date.now()));
        expect(await store.get("m1", "guest:a")).toBeDefined();
    });
});

describe("RedisAdmissionStore", () => {
    let server: FakeRedisServer;
    const logger = () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() });

    beforeEach(() => {
        server = new FakeRedisServer();
        redis.createClient.mockReset().mockImplementation((options: any) => server.createClient(options));
    });

    it("shares one meeting's requests between replicas, on a hash that expires an hour after its last write", async () => {
        const replicaA = new RedisAdmissionStore({ url: "redis://events", logger: logger() });
        const replicaB = new RedisAdmissionStore({ url: "redis://events", logger: logger() });
        await replicaA.connect();
        await replicaA.connect();
        await replicaB.connect();
        expect(redis.createClient).toHaveBeenCalledTimes(2);
        expect(redis.createClient).toHaveBeenCalledWith({ url: "redis://events", disableOfflineQueue: true });

        await replicaA.set("m1", "guest:a", request("Ada", Date.now()));
        expect(server.expiries.get(`${REDIS_ADMISSIONS_KEY_PREFIX}m1`)).toBe(ADMISSION_TTL_MS);
        const filed = (await replicaB.get("m1", "guest:a"))!;
        await replicaB.set("m1", "guest:a", { ...filed, status: "admitted" });
        expect(await replicaA.get("m1", "guest:a")).toMatchObject({ name: "Ada", status: "admitted" });
        expect([...(await replicaB.list("m1")).keys()]).toEqual(["guest:a"]);
        expect(await replicaA.get("m1", "guest:nobody")).toBeUndefined();

        await replicaA.delete("m1", "guest:a");
        expect(await replicaB.list("m1")).toEqual(new Map());
        replicaA.close();
        replicaB.close();
    });

    it("ignores, and removes on listing, an expired or garbled request", async () => {
        let now = START;
        const store = new RedisAdmissionStore({ url: "redis://events", logger: logger(), now: () => now });
        await store.connect();
        const key = `${REDIS_ADMISSIONS_KEY_PREFIX}m1`;
        await store.set("m1", "guest:old", request("Old", START));
        await store.set("m1", "guest:live", request("Live", START + 10));
        server.hashes.get(key)!.set("guest:junk", "{not json");
        server.hashes.get(key)!.set("guest:null", "null");
        server.hashes.get(key)!.set("guest:status", JSON.stringify({ name: "x", requestedAt: START, status: "maybe" }));
        server.hashes.get(key)!.set("guest:name", JSON.stringify({ name: 7, requestedAt: START, status: "pending" }));
        server.hashes.get(key)!.set("guest:time", JSON.stringify({ name: "x", requestedAt: "now", status: "pending" }));
        // Exactly one of a readable and a sealed name, and a source only as a string.
        server.hashes.get(key)!.set("guest:both", JSON.stringify({ name: "x", sealedName: "eA==", requestedAt: START + 10, status: "pending" }));
        server.hashes.get(key)!.set("guest:neither", JSON.stringify({ requestedAt: START + 10, status: "pending" }));
        server.hashes.get(key)!.set("guest:source", JSON.stringify({ name: "x", requestedAt: START + 10, status: "pending", source: 7 }));
        await store.set("m1", "guest:sealed", { sealedName: "c2VhbGVk", requestedAt: START + 10, status: "pending", source: "network" });
        now = START + ADMISSION_TTL_MS;

        expect(await store.get("m1", "guest:old")).toBeUndefined();
        expect(await store.get("m1", "guest:junk")).toBeUndefined();
        expect(await store.get("m1", "guest:sealed")).toEqual({ sealedName: "c2VhbGVk", requestedAt: START + 10, status: "pending", source: "network" });
        expect([...(await store.list("m1")).keys()].sort()).toEqual(["guest:live", "guest:sealed"]);
        expect([...server.hashes.get(key)!.keys()].sort()).toEqual(["guest:live", "guest:sealed"]);
        expect(await store.list("m-empty")).toEqual(new Map());
        store.close();
    });

    it("defaults to the real clock", async () => {
        const store = new RedisAdmissionStore({ url: "redis://events", logger: logger() });
        await store.connect();
        await store.set("m1", "guest:a", request("Ada", Date.now()));
        expect(await store.get("m1", "guest:a")).toBeDefined();
        store.close();
    });

    it("fails a command when Redis is unreachable or the store is closed, rather than waiting", async () => {
        const store = new RedisAdmissionStore({ url: "redis://events", logger: logger() });
        await expect(store.get("m1", "guest:a")).rejects.toThrow("The video meeting admission store is closed.");
        await store.connect();
        server.outage();
        await expect(store.set("m1", "guest:a", request("Ada", Date.now()))).rejects.toThrow("The client is offline");
        server.recover();
        server.fail.hash = true;
        await expect(store.list("m1")).rejects.toThrow("hash failed");
        store.close();
        store.close();
        await expect(store.delete("m1", "guest:a")).rejects.toThrow("The video meeting admission store is closed.");
    });

    it("logs a connection that fails, and a client that fails to close", async () => {
        const log = logger();
        server.failConnect = true;
        const store = new RedisAdmissionStore({ url: "redis://events", logger: log });
        await store.connect();
        await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("couldn't connect to Redis yet: connect failed")));

        server.failDestroy = true;
        store.close();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("couldn't close the Redis client: destroy failed"));
    });

    it("logs a connection that fails with no message", async () => {
        const log = logger();
        redis.createClient.mockReset().mockImplementation(() => ({ on: vi.fn(), connect: () => Promise.reject("refused"), destroy: vi.fn() }));
        const store = new RedisAdmissionStore({ url: "redis://events", logger: log });
        await store.connect();
        await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("couldn't connect to Redis yet: refused")));
        store.close();
    });
});
