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

    it("logs a meeting it couldn't discard yet, and leaves it for the next run", async () => {
        const job: any = new MeetingKeyExpiryJobMongo();
        job.logger = { warn: vi.fn() };
        job.meetingRepo = { find: vi.fn().mockResolvedValue([{ uid: "m1", keyExpiresAt: new Date(Date.now() - 1000) }]), update: vi.fn() };
        job.inviteeRepo = { find: vi.fn().mockRejectedValue(new Error("store down")) };
        await job.run();
        expect(job.logger.warn).toHaveBeenCalledWith(expect.stringContaining("couldn't discard the key of meeting m1 yet: store down"));
        expect(job.meetingRepo.update).not.toHaveBeenCalled();
    });
});
