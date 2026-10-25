///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `revokeParticipantGrants()`'s conflict handling, which the route suites (`test/routes/meetingProtectionSuite.ts`) can't provoke.
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { revokeParticipantGrants } from "../../src/util/MeetingProtectionUtils.js";

const CONFLICT = () => new Error("The ACL must be of the same version as the one stored.");
const acl = () => ({
    uid: "m1",
    records: [
        { userOrRoleId: "owner", actions: ["count", "create", "delete", "read", "update"] },
        { userOrRoleId: "guest:a", actions: ["read", "create"] },
        { userOrRoleId: "viewer", actions: ["read"] },
    ],
});

describe("revokeParticipantGrants", () => {
    it("keeps every record but the participants' READ/CREATE grants, retrying against the re-read ACL after a version conflict", async () => {
        const aclUtils: any = { findACL: vi.fn(async () => acl()), saveACL: vi.fn().mockRejectedValueOnce(CONFLICT()).mockResolvedValue(undefined) };
        await revokeParticipantGrants("m1", aclUtils);
        expect(aclUtils.findACL).toHaveBeenCalledTimes(2);
        expect(aclUtils.findACL).toHaveBeenCalledWith("m1", [], { skipCache: true, skipParents: true });
        expect(aclUtils.saveACL).toHaveBeenLastCalledWith({
            uid: "m1",
            records: [
                { userOrRoleId: "owner", actions: ["count", "create", "delete", "read", "update"] },
                { userOrRoleId: "viewer", actions: ["read"] },
            ],
        });
    });

    it("saves nothing without an ACL or a grant to remove", async () => {
        const saveACL = vi.fn();
        await revokeParticipantGrants("m1", { findACL: vi.fn(async () => undefined), saveACL } as any);
        await revokeParticipantGrants("m1", { findACL: vi.fn(async () => ({ uid: "m1", records: [{ userOrRoleId: "owner", actions: ["*"] }] })), saveACL } as any);
        expect(saveACL).not.toHaveBeenCalled();
    });

    it("throws any other error at once, and a conflict that outlasts its retries", async () => {
        const failing: any = { findACL: vi.fn(async () => acl()), saveACL: vi.fn().mockRejectedValue(new Error("store down")) };
        await expect(revokeParticipantGrants("m1", failing)).rejects.toThrow("store down");
        expect(failing.saveACL).toHaveBeenCalledTimes(1);
        await expect(revokeParticipantGrants("m1", { findACL: vi.fn(async () => acl()), saveACL: vi.fn().mockRejectedValue(undefined) } as any)).rejects.toBeUndefined();

        const contended: any = { findACL: vi.fn(async () => acl()), saveACL: vi.fn().mockRejectedValue(CONFLICT()) };
        await expect(revokeParticipantGrants("m1", contended)).rejects.toThrow("same version");
        expect(contended.saveACL).toHaveBeenCalledTimes(5);
    });
});
