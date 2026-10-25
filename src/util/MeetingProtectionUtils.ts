///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The validation of a protected meeting's key material (`specs/meeting_privacy.md` §3-4, §6.1): what the organizer's client sends when
 * it creates one. Everything here is public or sealed - a certificate, CMS wraps, sealed fields - and is checked for shape only: the
 * server can't open any of it, and never holds the meeting's private key.
 */
import * as crypto from "crypto";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import type { MeetingKeyWrap } from "../models/types.js";

/** What a protected meeting's readable title holds: its real one is sealed. */
export const PROTECTED_MEETING_TITLE = "Meeting";

/** The longest sealed value or wrap accepted (base64): a CMS of a short field to a handful of recipients is far smaller. */
const MAX_SEALED_LENGTH = 64 * 1024;
/** The longest certificate accepted (base64 DER). */
const MAX_CERTIFICATE_LENGTH = 8 * 1024;
/** The furthest ahead a key may expire: a long recurring series. */
const MAX_KEY_LIFETIME_MS = 5 * 366 * 24 * 60 * 60 * 1000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** A create body's `protection`. */
export interface MeetingProtectionBody {
    /** The meeting key's certificate. */
    meetingKey?: { certificate?: unknown };
    /** When the key is discarded (ISO 8601). */
    keyExpiresAt?: unknown;
    keyWraps?: unknown;
    sealedFields?: { title?: unknown };
}

/** `protection`, validated. */
export interface MeetingProtection {
    certificate: string;
    fingerprint: string;
    keyExpiresAt: Date;
    keyWraps: MeetingKeyWrap[];
    sealedTitle: string;
}

function invalid(message: string): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
}

/** Whether `value` is a sealed value (base64, bounded). */
export function isSealedValue(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_SEALED_LENGTH && BASE64.test(value);
}

/**
 * `body` (a create body's `protection`) validated for meeting `mailboxUid` at `now` (400 otherwise): a future `keyExpiresAt` within five
 * years; a sealed title; the meeting key's certificate, whose fingerprint is computed here; and one to `maxWraps` wraps of the key, for
 * `mailboxUid` (the organizer's) only.
 */
export function validateProtection(body: MeetingProtectionBody, mailboxUid: string, now: number, maxWraps: number): MeetingProtection {
    if (!body || typeof body !== "object") {
        throw invalid("'protection' must be an object.");
    }
    const expires: Date = new Date(typeof body.keyExpiresAt === "string" ? body.keyExpiresAt : NaN);
    if (isNaN(expires.valueOf()) || expires.valueOf() <= now || expires.valueOf() > now + MAX_KEY_LIFETIME_MS) {
        throw invalid("'protection.keyExpiresAt' must be a date in the future, at most five years ahead.");
    }
    if (!isSealedValue(body.sealedFields?.title)) {
        throw invalid("'protection.sealedFields.title' must be the sealed title.");
    }
    const certificate: unknown = body.meetingKey?.certificate;
    if (typeof certificate !== "string" || certificate.length > MAX_CERTIFICATE_LENGTH || !BASE64.test(certificate)) {
        throw invalid("'protection.meetingKey.certificate' must be a base64 DER certificate.");
    }
    const fingerprint: string = crypto.createHash("sha256").update(Buffer.from(certificate, "base64")).digest("hex");
    const wraps: unknown = body.keyWraps;
    if (!Array.isArray(wraps) || wraps.length === 0 || wraps.length > maxWraps) {
        throw invalid(`'protection.keyWraps' must list 1 to ${maxWraps} wraps.`);
    }
    const keyWraps: MeetingKeyWrap[] = wraps.map((wrap: any) => {
        if (
            wrap?.mailboxUid !== mailboxUid ||
            typeof wrap.recipientFingerprint !== "string" ||
            !FINGERPRINT.test(wrap.recipientFingerprint) ||
            wrap.kind !== "meeting-key" ||
            !isSealedValue(wrap.cms)
        ) {
            throw invalid("Each wrap is the organizer's: its 'mailboxUid', a SHA-256 'recipientFingerprint', 'kind' \"meeting-key\" and a sealed 'cms'.");
        }
        return { mailboxUid, recipientFingerprint: wrap.recipientFingerprint, kind: "meeting-key", cms: wrap.cms };
    });
    return { certificate, fingerprint, keyExpiresAt: expires, keyWraps, sealedTitle: body.sealedFields.title };
}
