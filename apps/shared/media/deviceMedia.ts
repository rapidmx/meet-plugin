///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Thin, dependency-injectable wrappers over `navigator.mediaDevices` - `enumerateDevices()`/`getUserMedia()`/
 * `getDisplayMedia()` - used by both the join/lobby page's device preview and the in-call view's mute/camera/share
 * controls (see this plugin's Phase 2 `.claude/NOTES.md` entry). Kept under `src/` rather than `apps/meet/` because
 * it is pure logic with no JSX, reused by more than one page/component.
 *
 * Every function accepts an optional `MediaDevicesLike` so a test can inject a fake without a real browser; the
 * real `navigator.mediaDevices` is used by default, resolved lazily inside each function (never at module scope)
 * so importing this module is safe during this plugin's page SSR, where no browser globals exist at all.
 *
 * Nothing here ever throws: every browser-API call is wrapped in `classifyMediaError()` and returned as a
 * discriminated `{ ok: false, error }` result, so a caller (a React component) never needs a try/catch of its own.
 */

/** The subset of `MediaDevices` this module calls - what a test's fake implements. */
export interface MediaDevicesLike {
    enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    getDisplayMedia?: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
}

export type MediaAccessErrorKind = "unsupported" | "permission-denied" | "not-found" | "unknown";

export interface MediaAccessError {
    kind: MediaAccessErrorKind;
    /** Already a complete, user-facing sentence - a caller shows this directly, no further mapping needed. */
    message: string;
}

export type MediaResult<T> = { ok: true; value: T } | { ok: false; error: MediaAccessError };

/** `navigator.mediaDevices`, or `undefined` where there is none (SSR, a non-HTTPS/insecure context in some
 * browsers, or a very old browser) - resolved lazily so this is safe to call from module code executed under SSR,
 * where `navigator` itself does not exist. */
export function defaultMediaDevices(): MediaDevicesLike | undefined {
    return typeof navigator === "undefined" ? undefined : (navigator.mediaDevices);
}

/** Whether `devices.getUserMedia` is actually callable - the one capability every caller here needs at minimum. */
export function isMediaDevicesSupported(devices: MediaDevicesLike | undefined = defaultMediaDevices()): boolean {
    return typeof devices?.getUserMedia === "function";
}

const UNSUPPORTED_ERROR: MediaAccessError = {
    kind: "unsupported",
    message: "This browser (or this page's connection) doesn't support camera/microphone access. Try a modern browser over HTTPS.",
};

/** Maps a `getUserMedia()`/`getDisplayMedia()`/`enumerateDevices()` rejection to a friendly, already-complete
 * message - the handful of `DOMException` names a browser actually raises for these calls, matched by name rather
 * than `instanceof DOMException` (a test's fake rejection need not be a real `DOMException`). */
export function classifyMediaError(err: unknown): MediaAccessError {
    const name: string = err instanceof Error ? err.name : "";
    switch (name) {
        case "NotAllowedError":
        case "SecurityError":
            return { kind: "permission-denied", message: "Camera/microphone access was denied. Allow access in your browser and try again." };
        case "NotFoundError":
        case "OverconstrainedError":
            return { kind: "not-found", message: "No camera or microphone was found on this device." };
        default:
            return { kind: "unknown", message: "Could not access your camera or microphone. Please try again." };
    }
}

export interface DeviceLists {
    cameras: MediaDeviceInfo[];
    microphones: MediaDeviceInfo[];
}

/**
 * Lists the available camera/microphone devices. Labels are only populated once permission has been granted (a
 * browser rule, not something this function can work around) - a caller wanting labeled devices should call
 * `requestUserMedia()` first, then this again.
 */
export async function listDevices(devices: MediaDevicesLike | undefined = defaultMediaDevices()): Promise<MediaResult<DeviceLists>> {
    if (!devices?.enumerateDevices) {
        return { ok: false, error: UNSUPPORTED_ERROR };
    }
    try {
        const all: MediaDeviceInfo[] = await devices.enumerateDevices();
        return {
            ok: true,
            value: {
                cameras: all.filter((d) => d.kind === "videoinput"),
                microphones: all.filter((d) => d.kind === "audioinput"),
            },
        };
    } catch (err) {
        return { ok: false, error: classifyMediaError(err) };
    }
}

/** Requests camera/microphone access. `constraints` lets the caller ask for a specific `deviceId` (device
 * switching) or disable a track kind entirely (e.g. `{ video: false, audio: true }` for a mic-only preview). */
export async function requestUserMedia(
    constraints: MediaStreamConstraints,
    devices: MediaDevicesLike | undefined = defaultMediaDevices(),
): Promise<MediaResult<MediaStream>> {
    if (!devices?.getUserMedia) {
        return { ok: false, error: UNSUPPORTED_ERROR };
    }
    try {
        return { ok: true, value: await devices.getUserMedia(constraints) };
    } catch (err) {
        return { ok: false, error: classifyMediaError(err) };
    }
}

/** Requests a screen/window/tab share via the browser's own picker. Audio is never requested (this design shares
 * camera-equivalent video only - see this plugin's Phase 2 `.claude/NOTES.md` entry on presentation mode). */
export async function requestDisplayMedia(devices: MediaDevicesLike | undefined = defaultMediaDevices()): Promise<MediaResult<MediaStream>> {
    if (!devices?.getDisplayMedia) {
        return { ok: false, error: UNSUPPORTED_ERROR };
    }
    try {
        return { ok: true, value: await devices.getDisplayMedia({ video: true, audio: false }) };
    } catch (err) {
        return { ok: false, error: classifyMediaError(err) };
    }
}

/** Stops every track of `stream` (releasing the camera/microphone/screen-share indicator) - tolerates `undefined`/
 * `null` so a caller never needs its own guard. */
export function stopStream(stream: MediaStream | undefined | null): void {
    stream?.getTracks().forEach((track) => track.stop());
}

/** Enables/disables every track of `stream` matching `kind`, for the mute/camera-off toggles - tracks are kept
 * (not stopped/removed), matching every mainstream video-call app's "mute" behavior: instant, reversible, and
 * without re-requesting `getUserMedia()` or renegotiating the `RTCPeerConnection`. */
export function setTracksEnabled(stream: MediaStream | undefined | null, kind: "audio" | "video", enabled: boolean): void {
    const tracks: MediaStreamTrack[] = kind === "audio" ? (stream?.getAudioTracks() ?? []) : (stream?.getVideoTracks() ?? []);
    for (const track of tracks) {
        track.enabled = enabled;
    }
}
