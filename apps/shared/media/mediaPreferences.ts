///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * What a participant chose last time - which camera and microphone, whether each was on, and their video filters -
 * kept in this browser's `localStorage` so the next meeting starts the same way.
 *
 * It lives on the device rather than on the server on purpose: most participants are guests with no account, and a
 * camera's id means nothing on another machine anyway. Nothing here is sent anywhere.
 *
 * Storage can be missing or refuse to work (private windows, blocked site data, a full quota, server-side rendering),
 * and none of that is worth failing a call over: every function tolerates it and behaves as if nothing was saved.
 * Whatever is read back is validated, since it may be from another version of this plugin or edited by hand.
 *
 * The custom background picture is stored under its own key: it is by far the largest thing kept, and if it doesn't
 * fit the rest of the settings should still be saved.
 */
import { type VideoFilters, sanitizeFilters } from "./filters/filterTypes.js";

export interface MediaPreferences {
    /** The camera and microphone the participant picked, by `deviceId`. */
    cameraId?: string;
    microphoneId?: string;
    /** Whether the microphone / camera was on when they left. */
    micEnabled?: boolean;
    cameraEnabled?: boolean;
    filters?: VideoFilters;
    /** The custom background, as a (downscaled) image data URL. */
    backgroundImage?: string;
}

export const PREFERENCES_KEY = "rapidmx.meet.preferences";
export const BACKGROUND_KEY = "rapidmx.meet.background";

/** The `Storage` to use, or `undefined` where there is none - looked up lazily and guarded, since merely reading
 * `localStorage` can throw (a browser blocking site data) and it doesn't exist on the server. */
export function defaultStorage(): Storage | undefined {
    try {
        return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
        return undefined;
    }
}

function readJson(storage: Storage, key: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(storage.getItem(key) ?? "{}");
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const flag = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

export function loadPreferences(storage: Storage | undefined = defaultStorage()): MediaPreferences {
    if (!storage) {
        return {};
    }
    const raw = readJson(storage, PREFERENCES_KEY);
    let backgroundImage: string | undefined;
    try {
        const stored = storage.getItem(BACKGROUND_KEY);
        backgroundImage = stored?.startsWith("data:image/") ? stored : undefined;
    } catch {
        backgroundImage = undefined;
    }
    return {
        cameraId: text(raw.cameraId),
        microphoneId: text(raw.microphoneId),
        micEnabled: flag(raw.micEnabled),
        cameraEnabled: flag(raw.cameraEnabled),
        filters: raw.filters === undefined ? undefined : sanitizeFilters(raw.filters),
        backgroundImage,
    };
}

/** Merges `patch` into what is saved. A key set to `undefined` is forgotten; a failure to save is ignored. */
export function savePreferences(patch: Partial<MediaPreferences>, storage: Storage | undefined = defaultStorage()): void {
    if (!storage) {
        return;
    }
    const { backgroundImage, ...rest } = patch;
    if (Object.keys(rest).length > 0) {
        try {
            const merged = { ...readJson(storage, PREFERENCES_KEY), ...rest };
            storage.setItem(PREFERENCES_KEY, JSON.stringify(merged));
        } catch {
            // Nowhere to save - the settings just won't carry over.
        }
    }
    if ("backgroundImage" in patch) {
        try {
            if (backgroundImage) {
                storage.setItem(BACKGROUND_KEY, backgroundImage);
            } else {
                storage.removeItem(BACKGROUND_KEY);
            }
        } catch {
            // Most likely the image is too big for what is left of the quota.
        }
    }
}
