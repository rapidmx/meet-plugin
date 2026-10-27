///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as restapi from "@rapidmx/restapi";

/** What this file uses from `@rapidmx/restapi` that a server from before Integrations doesn't export. Read through the
 * module namespace, never imported by name: a named import of a missing export fails the whole plugin's load (the
 * server never checks a plugin's peer range against its own restapi), where reading it here finds it unset and keeps
 * the built-in STUN servers. */
const hostApi: Partial<Pick<typeof restapi, "HostConfig" | "normalizeStunUrls">> = restapi;

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

/**
 * Adds the TCP flavour of every plain `turn:` URL that does not name a transport itself. A browser given
 * `turn:host:3478` speaks only UDP to the TURN server, and UDP is precisely what a restrictive firewall blocks while
 * still letting outbound TCP through - so a client behind one never reaches a TURN server that was listening on TCP
 * all along. Offering both lets ICE try UDP first and settle for TCP when UDP goes nowhere. `turns:` URLs are TCP
 * (TLS) already, and a URL with an explicit `transport=` is the operator's own choice and is left exactly as given.
 *
 * @param urls The URLs from `parseTurnUrls()`, in the order the operator wrote them.
 * @returns The same URLs, each plain `turn:` one followed by its `?transport=tcp` twin, without duplicates.
 */
export function withTcpFallback(urls: string[]): string[] {
    const expanded: string[] = [];
    for (const url of urls) {
        expanded.push(url);
        if (/^turn:/i.test(url) && !/[?&]transport=/i.test(url)) {
            expanded.push(`${url}${url.includes("?") ? "&" : "?"}transport=tcp`);
        }
    }
    return [...new Set(expanded)];
}

/** Always-available, free public STUN servers - discovery only, no media relay. Two independent providers, so a
 * call still has STUN available if one of them is ever unreachable. */
export const DEFAULT_STUN_SERVERS: readonly IceServerConfig[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
];

/** The host's config key for the STUN servers an administrator sets under Integrations in the admin console
 * (`integrations:stun:urls`, set by the server's integrations layer, or by the deployment's own configuration). Written
 * out rather than taken from restapi's `INTEGRATION_CONFIG_KEYS`, which a server from before Integrations lacks. */
export const STUN_URLS_CONFIG_KEY: string = "integrations:stun:urls";

/** Where `stunServers()` reports an `integrations:stun:urls` value it ignored part or all of. */
export interface StunWarningLogger {
    warn(message: string): void;
}

/** What `readStunUrls()` made of a value: the usable URIs, how many entries it had and how many of them were ignored,
 * and `unreadable` for a value that isn't a list in any form `parseStunUrls()` reads. */
interface StunUrlsReading {
    urls: string[];
    entries: number;
    ignored: number;
    unreadable: boolean;
}

/** Reads an `integrations:stun:urls` value for `parseStunUrls()` and the warning in `stunServers()`. Blank entries (a
 * trailing comma, say) aren't counted as entries at all, and a repeat isn't an ignored one. */
function readStunUrls(value: unknown): StunUrlsReading {
    let entries: unknown[] = [];
    let unreadable: boolean = false;
    if (Array.isArray(value)) {
        entries = value;
    } else if (typeof value === "string" && value.trim().startsWith("[")) {
        try {
            // Text starting with `[` that parses at all is a list.
            entries = JSON.parse(value) as unknown[];
        } catch {
            unreadable = true;
        }
    } else if (typeof value === "string") {
        entries = value.split(",");
    } else if (value !== undefined && value !== null) {
        unreadable = true;
    }
    const urls: string[] = [];
    let counted: number = 0;
    let ignored: number = 0;
    for (const entry of entries) {
        if (typeof entry === "string" && !entry.trim()) {
            continue;
        }
        counted++;
        try {
            // Missing only on a server from before Integrations, where nothing is accepted (`stunServers()` checks first).
            const [url] = hostApi.normalizeStunUrls!([entry]);
            if (!urls.includes(url)) {
                urls.push(url);
            }
        } catch {
            ignored++;
        }
    }
    return { urls, entries: counted, ignored, unreadable };
}

/**
 * The STUN URIs in an `integrations:stun:urls` value, read as the server reads the deployment's value for the console: a
 * list, JSON text of a list, or URIs separated by commas. Each is checked as the console checks the administrator's
 * (`normalizeStunUrls()`: `stun:`/`stuns:`, a host and an optional port), lowercased and kept once. Anything else is
 * dropped rather than handed out: a browser refuses the whole `iceServers` list over one malformed URL, so a bad entry in
 * the deployment's configuration would otherwise break every call.
 */
export function parseStunUrls(value: unknown): string[] {
    return readStunUrls(value).urls;
}

/** A hash of the value `stunServers()` last warned about, so a bad value is reported once rather than at every join.
 * Cleared by a value with nothing ignored, so one that goes bad again is reported again. */
let lastWarnedStunValue: string | undefined;

/** Warns, once per distinct value, that `integrations:stun:urls` was ignored in part or whole. The message gives counts
 * only, never the value: the console shows that to whoever may see it. */
function warnIgnoredStunUrls(value: unknown, reading: StunUrlsReading, logger: StunWarningLogger): void {
    // `String()`: `JSON.stringify` gives `undefined` for a function or symbol, which no hash takes.
    const text: string = typeof value === "string" ? value : String(JSON.stringify(value));
    const fingerprint: string = crypto.createHash("sha256").update(text).digest("hex");
    if (fingerprint === lastWarnedStunValue) {
        return;
    }
    lastWarnedStunValue = fingerprint;
    const fallback: string = reading.urls.length === 0 ? "; using the built-in STUN servers instead" : "";
    logger.warn(
        reading.unreadable
            ? `${STUN_URLS_CONFIG_KEY} isn't a list of STUN URIs and is ignored${fallback}.`
            : `${STUN_URLS_CONFIG_KEY}: ${reading.ignored} of ${reading.entries} entries aren't STUN URIs (stun: or stuns:, a host and an optional port) and are ignored${fallback}.`,
    );
}

/**
 * The STUN servers to hand out right now: the administrator's (`STUN_URLS_CONFIG_KEY`), read through `HostConfig` on
 * every call, since the plugin's `@Config` fields are a startup snapshot and the setting changes while the server runs.
 * Falls back to `DEFAULT_STUN_SERVERS` when the setting names none: unset (no host configuration installed, or a server
 * from before Integrations, whose restapi has no `HostConfig` at all), an empty list, or nothing usable
 * (`parseStunUrls()`).
 *
 * @param logger Told, once per distinct value, when entries of the setting (or all of it) are ignored. The console shows
 * a deployment's value as configured, so without this an operator would see servers listed that no call uses.
 */
export function stunServers(logger?: StunWarningLogger): IceServerConfig[] {
    const { HostConfig, normalizeStunUrls } = hostApi;
    if (!HostConfig || !normalizeStunUrls) {
        return [...DEFAULT_STUN_SERVERS];
    }
    const value: unknown = HostConfig.get(STUN_URLS_CONFIG_KEY);
    const reading: StunUrlsReading = readStunUrls(value);
    if (reading.ignored === 0 && !reading.unreadable) {
        lastWarnedStunValue = undefined;
    } else if (logger) {
        warnIgnoredStunUrls(value, reading, logger);
    }
    return reading.urls.length > 0 ? reading.urls.map((url) => ({ urls: url })) : [...DEFAULT_STUN_SERVERS];
}

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
 * Builds the full ICE server list for a join response: the STUN servers (`stunServers()`), plus a TURN entry when
 * `settings.url` is configured (see `withTcpFallback()` for the URLs it carries). When a `sharedSecret` is also configured, the TURN entry carries a fresh,
 * time-limited credential (`turnRestCredential()`) rather than the static `username`/`credential` pair, which is
 * used verbatim only when no shared secret is set. A TURN url with neither a shared secret nor a static
 * credential is still included with no credentials at all - some self-hosted TURN servers are deliberately run
 * without authentication for testing, and it costs nothing to pass the url through as configured.
 *
 * @param settings The `mail:videoconf:turn:*` settings, exactly as configured.
 * @param options `ttlSeconds`/`now` are forwarded to `turnRestCredential()`. `randomUserPart` supplies the
 * generated identity portion of a shared-secret credential's username when `settings.username` is unset -
 * defaults to a fresh random hex string; a test may override it for a deterministic assertion. `logger` is handed to
 * `stunServers()`.
 */
export function buildIceServers(
    settings: TurnSettings,
    options?: { ttlSeconds?: number; now?: Date; randomUserPart?: () => string; logger?: StunWarningLogger },
): IceServerConfig[] {
    const servers: IceServerConfig[] = stunServers(options?.logger);
    const configured: string[] = parseTurnUrls(settings.url);
    if (configured.length === 0) {
        return servers;
    }
    const turnUrls: string[] = withTcpFallback(configured);
    // One URL stays a string, so an operator who names a single `turns:` or `?transport=` URL sees no change.
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
