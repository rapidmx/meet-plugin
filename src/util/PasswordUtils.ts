///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";

/** scrypt's own derived-key length, in bytes - 64 is the common choice (double SHA-512's output size), with no
 * project convention to match since nothing in this codebase hashed a credential before `VideoMeeting.passwordHash`
 * (see this module's own doc comment). */
const SCRYPT_KEY_LENGTH = 64;

/** A random salt's length, in bytes - 16 is scrypt's own usual recommendation. */
const SALT_LENGTH = 16;

/**
 * Hashes and verifies a `VideoMeeting`'s own optional join password (`VideoMeeting.passwordHash`) - the one
 * plaintext credential this plugin stores anything derived from. There is no existing password-hashing utility
 * anywhere in this codebase's dependency tree (`@rapidrest/*`/`@rapidmx/*` only ever deal with already-opaque JWTs
 * and unguessable random tokens - see `util/TokenUtils.ts`), so this uses Node's own built-in `crypto.scrypt`
 * directly rather than adding a new dependency (bcrypt/argon2) for one call site - the same "built-in `crypto`,
 * no new dependency" choice `TokenUtils.ts` already made for this plugin's other secrets.
 *
 * The stored format is `<salt>:<derived key>`, both base64url (matching `TokenUtils.ts`'s own encoding) - one
 * column holds both, so no separate salt column is needed. scrypt's default cost parameters (N=16384, r=8, p=1)
 * are used throughout; there is no per-call tuning here.
 */
export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const derivedKey = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
    return `${salt.toString("base64url")}:${derivedKey.toString("base64url")}`;
}

/** Checks `password` against a hash `hashPassword()` produced. Constant-time on the derived keys themselves
 * (`crypto.timingSafeEqual()`), so a wrong guess's rejection takes the same time regardless of how much of it
 * matched - the scrypt computation itself still dominates the timing either way, which is the point of using it. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const separator = stored.indexOf(":");
    /* v8 ignore if -- unreachable via real usage: every stored value was produced by hashPassword() above, which
       always includes exactly one separator; this guards only a corrupted/foreign value. */
    if (separator === -1) {
        return false;
    }
    const salt = Buffer.from(stored.slice(0, separator), "base64url");
    const expected = Buffer.from(stored.slice(separator + 1), "base64url");
    const derivedKey = await scrypt(password, salt, expected.length);
    return derivedKey.length === expected.length && crypto.timingSafeEqual(derivedKey, expected);
}

function scrypt(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keyLength, (err, derivedKey) =>
            /* v8 ignore next -- unreachable via real usage: scrypt fails only for invalid parameters (a bad salt
               type, a keyLength past its internal limit), never for the arguments this module ever passes it. */
            err ? reject(err) : resolve(derivedKey),
        );
    });
}
