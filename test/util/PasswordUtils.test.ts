///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { hashPassword, verifyPassword } from "../../src/util/PasswordUtils.js";

describe("hashPassword", () => {
    it("Never stores the plaintext.", async () => {
        const hash = await hashPassword("s3cret");
        expect(hash).not.toContain("s3cret");
    });

    it("Mints a fresh salt (and so a different hash) on every call, even for the same password.", async () => {
        const a = await hashPassword("s3cret");
        const b = await hashPassword("s3cret");
        expect(a).not.toBe(b);
    });

    it("Stores the salt and derived key together as 'salt:key', both base64url.", async () => {
        const hash = await hashPassword("s3cret");
        const parts = hash.split(":");
        expect(parts).toHaveLength(2);
        for (const part of parts) {
            expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    });
});

describe("verifyPassword", () => {
    it("Verifies the exact password that was hashed.", async () => {
        const hash = await hashPassword("s3cret");
        expect(await verifyPassword("s3cret", hash)).toBe(true);
    });

    it("Rejects a wrong password.", async () => {
        const hash = await hashPassword("s3cret");
        expect(await verifyPassword("wrong", hash)).toBe(false);
    });

    it("Rejects the empty string against a real hash.", async () => {
        const hash = await hashPassword("s3cret");
        expect(await verifyPassword("", hash)).toBe(false);
    });

    it("Is case-sensitive.", async () => {
        const hash = await hashPassword("S3cret");
        expect(await verifyPassword("s3cret", hash)).toBe(false);
    });

    it("Rejects a corrupted/foreign stored value with no separator, rather than throwing.", async () => {
        expect(await verifyPassword("s3cret", "not-a-valid-stored-hash")).toBe(false);
    });
});
