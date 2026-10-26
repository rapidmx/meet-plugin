///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `MeetingKeyExpiryJob`'s paths the route suites (`test/routes/meetingProtectionSuite.ts`) don't reach.
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { MeetingKeyExpiryJobMongo } from "../../src/jobs/mongo/MeetingKeyExpiryJobMongo.js";

describe("MeetingKeyExpiryJob (isolated)", () => {
    it("can't be initialized without an ObjectFactory, runs every five minutes, and has no-op lifecycle hooks", async () => {
        const job: any = new MeetingKeyExpiryJobMongo();
        await expect(job.initialize()).rejects.toThrow("objectFactory is not set.");
        expect(job.schedule).toBe("0 */5 * * * *");
        expect(job.start()).toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("logs a meeting it couldn't discard yet, and leaves it for the next run, touching nothing before the meeting is claimed", async () => {
        const job: any = new MeetingKeyExpiryJobMongo();
        job.logger = { warn: vi.fn() };
        job.meetingRepo = {
            find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ uid: "m1", keyExpiresAt: new Date(Date.now() - 1000) }]),
            update: vi.fn().mockRejectedValue(new Error("must be of the same version")),
        };
        job.inviteeRepo = { find: vi.fn() };
        await job.run();
        expect(job.logger.warn).toHaveBeenCalledWith(expect.stringContaining("couldn't discard the key of meeting m1 yet: must be of the same version"));
        expect(job.inviteeRepo.find).not.toHaveBeenCalled();
    });

    it("finishes the cleanup of a meeting whose discard was claimed first, and logs one that fails again", async () => {
        const job: any = new MeetingKeyExpiryJobMongo();
        job.logger = { warn: vi.fn() };
        job.meetingRepo = { find: vi.fn().mockResolvedValueOnce([{ uid: "p1", keyCleanupPending: true }]).mockResolvedValueOnce([]), update: vi.fn() };
        job.inviteeRepo = { find: vi.fn().mockRejectedValue(new Error("store down")) };
        await job.run();
        expect(job.meetingRepo.find.mock.calls[0][0]).toEqual({ keyCleanupPending: true, limit: 200 });
        expect(job.logger.warn).toHaveBeenCalledWith(expect.stringContaining("couldn't discard the key of meeting p1 yet: store down"));
        expect(job.meetingRepo.update).not.toHaveBeenCalled();
    });

    it("takes the soonest expiry first, skips a meeting with none, and stops at the first that hasn't expired", async () => {
        const job: any = new MeetingKeyExpiryJobMongo();
        const past = new Date(Date.now() - 1000);
        const future = new Date(Date.now() + 60_000);
        job.meetingRepo = {
            find: vi
                .fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ uid: "none" }, { uid: "m1", keyExpiresAt: past }, { uid: "m2", keyExpiresAt: future }, { uid: "m3", keyExpiresAt: past }]),
        };
        const attempt = vi.spyOn(job, "attempt").mockResolvedValue(undefined);
        await job.run();
        expect(job.meetingRepo.find).toHaveBeenLastCalledWith(expect.objectContaining({ sort: { keyExpiresAt: "ASC", uid: "ASC" }, limit: 200 }), expect.objectContaining({ limit: 200 }));
        expect(attempt.mock.calls.map(([meeting]: any[]) => meeting.uid)).toEqual(["m1"]);
    });
});
