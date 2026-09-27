///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads the `mail:videoconf:effects:assets_url` setting: the base URL an administrator hosts the video filters'
 * machine-learning runtime and models under, in place of the public CDNs they are otherwise fetched from. It is
 * handed to every participant's browser, so only an absolute `http(s)` URL or a path on this server is accepted;
 * anything else (a `javascript:` URL, a typo, nothing at all) is treated as unset. A trailing slash is dropped.
 *
 * @param value The setting as configured.
 * @returns The URL to hand to clients, or `undefined` to have them use the defaults.
 */
export function parseEffectsAssetsUrl(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim().replace(/\/+$/, "");
    return /^(https?:\/\/[^\s]+|\/[^\s/][^\s]*)$/i.test(trimmed) ? trimmed : undefined;
}
