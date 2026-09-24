///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";

/** A single ICE server entry, matching the shape the browser `RTCPeerConnection` `iceServers` constructor option
 * expects (`RTCIceServer`), so the join response can be handed to it directly with no reshaping. */
export interface IceServerConfig {
    /** One URL, or several that share one credential (a TURN server's UDP and TLS addresses, say). */
    urls: string | string[];
    username?: string;
    credential?: string;
}

/** The `mail:videoconf:turn:*` settings, exactly as configured (empty strings for anything unset). `url` may name several
 * URLs, separated by commas and/or whitespace - see `parseTurnUrls()`. */
export interface TurnSettings {
    url: string;
    username: string;
    credential: string;
    sharedSecret: string;
}

/** The URLs in a `mail:videoconf:turn:url` value: one, or several separated by commas and/or whitespace (for a TURN server
 * listening on both UDP and TLS, `turn:host:3478,turns:host:5349`). Blank entries are dropped. */
export function parseTurnUrls(value: string): string[] {
    return value.split(/[\s,]+/).filter(Boolean);
}

/** Always-available, free public STUN servers - discovery only, no media relay. Two independent providers, so a
 * call still has STUN available if one of them is ever unreachable. */
export const DEFAULT_STUN_SERVERS: readonly IceServerConfig[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
];

/** How long a minted TURN REST credential remains valid for, in seconds. One hour comfortably covers ICE
 * negotiation and reconnection attempts for the length of a typical call without minting a fresh credential on
 * every join. */
export const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS: number = 60 * 60;

/**
 * Generates a coturn-style time-limited REST API credential: `username` is `<unix-expiry-timestamp>:<userPart>`,
 * and `credential` is `base64(HMAC-SHA1(sharedSecret, username))`. This is coturn's own documented
 * `static-auth-secret` mechanism (the `turnserver -a -X` REST credential algorithm) - implemented here exactly,
 * not guessed at: the TURN server derives the same HMAC independently at connection time using the timestamp
 * embedded in the username it's handed, so no round trip to the TURN server is needed to mint one.
 *
 * @param sharedSecret The operator's `mail:videoconf:turn:shared_secret`.
 * @param userPart The identity portion of the username - the configured `mail:videoconf:turn:username`, or a
 * generated one when that's unset (see `buildIceServers()`).
 * @param ttlSeconds How long the credential remains valid for, from `now`.
 * @param now The time to compute the expiry from. Defaults to the real current time; a test may pass a fixed
 * value for a deterministic assertion.
 */
export function turnRestCredential(
    sharedSecret: string,
    userPart: string,
    ttlSeconds: number = DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
    now: Date = new Date(),
): { username: string; credential: string } {
    const expiry: number = Math.floor(now.getTime() / 1000) + Math.max(0, Math.floor(ttlSeconds));
    const username: string = `${expiry}:${userPart}`;
    const credential: string = crypto.createHmac("sha1", sharedSecret).update(username).digest("base64");
    return { username, credential };
}

/**
 * Builds the full ICE server list for a join response: the hardcoded public STUN servers, plus a TURN entry when
 * `settings.url` is configured. When a `sharedSecret` is also configured, the TURN entry carries a fresh,
 * time-limited credential (`turnRestCredential()`) rather than the static `username`/`credential` pair, which is
 * used verbatim only when no shared secret is set. A TURN url with neither a shared secret nor a static
 * credential is still included with no credentials at all - some self-hosted TURN servers are deliberately run
 * without authentication for testing, and it costs nothing to pass the url through as configured.
 *
 * @param settings The `mail:videoconf:turn:*` settings, exactly as configured.
 * @param options `ttlSeconds`/`now` are forwarded to `turnRestCredential()`. `randomUserPart` supplies the
 * generated identity portion of a shared-secret credential's username when `settings.username` is unset -
 * defaults to a fresh random hex string; a test may override it for a deterministic assertion.
 */
export function buildIceServers(
    settings: TurnSettings,
    options?: { ttlSeconds?: number; now?: Date; randomUserPart?: () => string },
): IceServerConfig[] {
    const servers: IceServerConfig[] = [...DEFAULT_STUN_SERVERS];
    const turnUrls: string[] = parseTurnUrls(settings.url);
    if (turnUrls.length === 0) {
        return servers;
    }
    // A single URL stays a string, exactly as before, so a deployment that never sets more than one sees no change.
    const url: string | string[] = turnUrls.length === 1 ? turnUrls[0] : turnUrls;
    if (settings.sharedSecret.trim()) {
        const userPart: string = settings.username.trim() || (options?.randomUserPart ?? (() => crypto.randomBytes(8).toString("hex")))();
        const { username, credential } = turnRestCredential(settings.sharedSecret.trim(), userPart, options?.ttlSeconds, options?.now);
        servers.push({ urls: url, username, credential });
    } else if (settings.username.trim() && settings.credential.trim()) {
        servers.push({ urls: url, username: settings.username.trim(), credential: settings.credential.trim() });
    } else {
        servers.push({ urls: url });
    }
    return servers;
}
