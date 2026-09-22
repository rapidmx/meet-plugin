///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";

/**
 * The exact shape `mintJoinToken()` produces: 32 random bytes, base64url without padding - mirroring
 * `booking-plugin`'s `Booking.manageToken` shape/entropy exactly (see its `BaseBookingRoute.MANAGE_TOKEN_PATTERN`).
 * Checked before any lookup, so a candidate value is always a plain literal by the time it reaches a query.
 */
export const JOIN_TOKEN_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

/**
 * The exact shape `mintPublicSlug()` produces: 8 random bytes, base64url without padding - deliberately a
 * different length than `JOIN_TOKEN_PATTERN` (11 characters vs. 43), so the two can never collide and
 * `BaseVideoMeetingRoute.join()` can tell which kind of value it was handed from its length alone, without
 * ambiguity, rather than trying both lookups against a value that only matched one of them (see that method's
 * doc comment for the disambiguation this enables).
 */
export const PUBLIC_SLUG_PATTERN: RegExp = /^[A-Za-z0-9_-]{11}$/;

/** Mints a private meeting invitee's `joinToken`: 32 random bytes, base64url. Matches `JOIN_TOKEN_PATTERN`. */
export function mintJoinToken(): string {
    return crypto.randomBytes(32).toString("base64url");
}

/**
 * Mints a public meeting's `publicSlug`: 8 random bytes, base64url (~48 bits of entropy). Matches
 * `PUBLIC_SLUG_PATTERN`. Random rather than name-derived (unlike `booking-plugin`'s human-authored
 * `BookingType.slug`) since nothing about a video meeting is memorable or worth choosing by hand - it only ever
 * appears embedded in a link.
 */
export function mintPublicSlug(): string {
    return crypto.randomBytes(8).toString("base64url");
}
