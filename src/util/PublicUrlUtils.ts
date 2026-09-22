///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Normalizes a `mail:videoconf:public_url`-shaped setting into a base URL (origin plus path, no trailing slash),
 * or `undefined` when it's unset or unsafe to advertise - mirroring `@rapidmx/autodiscover`'s `BaseAutodiscoverRoute`
 * private `baseUrl` getter exactly (that helper isn't exported from `@rapidmx/restapi` for reuse, so this is a
 * small, independent copy of the same validation): the value must parse as a URL, use `https:` (plain `http:` is
 * only tolerated for a loopback host, for local development), and carry no credentials, query string or fragment -
 * any of which would produce a broken or insecure join link once a token is appended.
 *
 * @param rawUrl The configured setting value, e.g. `https://mail.example.com/meet`.
 */
export function buildBaseUrl(rawUrl: string | undefined): string | undefined {
    const value: string = (rawUrl ?? "").trim();
    if (!value) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    const loopback: boolean = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        return undefined;
    }
    // Checked on the raw string: `URL.search`/`hash` are empty for a bare trailing `?`/`#`.
    if (value.includes("?") || value.includes("#") || url.username || url.password) {
        return undefined;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
