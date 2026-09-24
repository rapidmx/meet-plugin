///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The local participant's camera and microphone, owned by one component for the whole visit (`apps/meet/[token].tsx`)
 * and handed to both the lobby and the call - so the tracks the lobby previews are the very tracks the call sends.
 * (The lobby used to own its stream and stop it when it unmounted, which is exactly when the call starts using it:
 * everyone who joined had dead tracks.) Every track is stopped once, when the owner unmounts or `release()` is
 * called.
 *
 * - **Permission**: `requestAccess()` asks for the camera and microphone in one browser prompt, and falls back to
 * asking for each on its own if that fails for any reason other than an outright denial - a machine with no camera
 * still gets its microphone. It is safe to call again (a "try again" button is a user gesture, which some browsers
 * require before they will prompt at all), and the per-kind `status` says what is and isn't working.
 * - **Mute**: the microphone track is kept and disabled (`micEnabled`), so unmuting is instant. If there is no
 * microphone track yet, unmuting asks for one.
 * - **Camera**: turning the camera off stops its track (the camera light goes out and the device is released);
 * turning it on asks for a new one.
 * - **Devices**: `selectDevice()` swaps in another camera or microphone; `devicechange` refreshes the lists.
 * - **Level**: `audioLevel` (0-5) follows the microphone while it is unmuted, for the "your audio is being sent"
 * indicator.
 *
 * Nothing here runs during SSR: browser APIs are only touched from effects and event handlers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    type DeviceLists,
    type MediaAccessError,
    defaultMediaDevices,
    isMediaDevicesSupported,
    listDevices,
    requestUserMedia,
} from "./deviceMedia.js";
import { startLevelMeter } from "./levelMeter.js";

export type MediaKind = "audio" | "video";

/** `pending`: not asked yet, or being asked. `live`: a track is running. `off`: the participant turned the camera
 * off. `denied`/`unavailable`/`error`: the browser said no, there is no such device (or it was unplugged), or
 * something else went wrong. */
export type TrackStatus = "pending" | "live" | "off" | "denied" | "unavailable" | "error";

const AUDIO_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO_CONSTRAINTS: MediaTrackConstraints = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };

/** The mean deviation (the level meter's 0-100 scale) that fills the whole indicator - ordinary speech sits well
 * below full scale. */
const LEVEL_FULL_SCALE = 20;
export const AUDIO_LEVEL_STEPS = 5;

export interface LocalMedia {
    /** `false` when this browser (or page connection) has no `getUserMedia` at all. */
    supported: boolean;
    /** A permission request is in flight. */
    requesting: boolean;
    /** The message for the most recent failed request, ready to show. */
    error: MediaAccessError | null;
    audioTrack: MediaStreamTrack | null;
    videoTrack: MediaStreamTrack | null;
    /** A stream holding just the camera track, for a `<video>` element - `null` while the camera is off. */
    videoStream: MediaStream | null;
    /** The user wants the microphone live (unmuted). */
    micEnabled: boolean;
    /** The microphone is live and unmuted: there is a track and `micEnabled`. */
    micOn: boolean;
    cameraOn: boolean;
    status: Record<MediaKind, TrackStatus>;
    devices: DeviceLists;
    selectedDeviceIds: Partial<Record<MediaKind, string>>;
    /** 0-`AUDIO_LEVEL_STEPS`: how loud the microphone is right now - always 0 while muted. */
    audioLevel: number;
    /** Asks for the camera and microphone (or just `kind`), see this module's doc comment. */
    requestAccess(kind?: MediaKind): Promise<void>;
    toggleMic(): Promise<void>;
    toggleCamera(): Promise<void>;
    selectDevice(kind: MediaKind, deviceId: string): Promise<void>;
    /** Stops both tracks. */
    release(): void;
}

function statusFor(error: MediaAccessError): TrackStatus {
    switch (error.kind) {
        case "permission-denied":
            return "denied";
        case "not-found":
            return "unavailable";
        default:
            return "error";
    }
}

export function useLocalMedia(): LocalMedia {
    const [supported, setSupported] = useState(true);
    const [requesting, setRequesting] = useState(false);
    const [error, setError] = useState<MediaAccessError | null>(null);
    const [tracks, setTracks] = useState<Record<MediaKind, MediaStreamTrack | null>>({ audio: null, video: null });
    const [status, setStatus] = useState<Record<MediaKind, TrackStatus>>({ audio: "pending", video: "pending" });
    const [micEnabled, setMicEnabled] = useState(true);
    const [devices, setDevices] = useState<DeviceLists>({ cameras: [], microphones: [] });
    const [audioLevel, setAudioLevel] = useState(0);

    const tracksRef = useRef<Record<MediaKind, MediaStreamTrack | null>>({ audio: null, video: null });
    const micEnabledRef = useRef(true);
    const mountedRef = useRef(true);

    const refreshDevices = useCallback(async () => {
        const list = await listDevices();
        if (list.ok && mountedRef.current) {
            setDevices(list.value);
        }
    }, []);

    /** Makes `track` the current track of its kind, stopping whatever it replaces - or stops it at once if the
     * owner has already gone away (a request that resolved after unmount). */
    const adoptTrack = useCallback((track: MediaStreamTrack) => {
        const kind = track.kind as MediaKind;
        if (!mountedRef.current) {
            track.stop();
            return;
        }
        const previous = tracksRef.current[kind];
        if (previous && previous !== track) {
            previous.onended = null;
            previous.stop();
        }
        if (kind === "audio") {
            track.enabled = micEnabledRef.current;
        }
        track.onended = () => {
            // The device went away (unplugged, or the browser revoked permission).
            if (tracksRef.current[kind] === track) {
                tracksRef.current = { ...tracksRef.current, [kind]: null };
                setTracks(tracksRef.current);
                setStatus((prev) => ({ ...prev, [kind]: "unavailable" }));
            }
        };
        tracksRef.current = { ...tracksRef.current, [kind]: track };
        setTracks(tracksRef.current);
        setStatus((prev) => ({ ...prev, [kind]: "live" }));
    }, []);

    const adoptStream = useCallback(
        (stream: MediaStream) => {
            for (const track of stream.getTracks()) {
                adoptTrack(track);
            }
        },
        [adoptTrack],
    );

    /** Asks for one kind on its own - a specific device when `deviceId` is given. */
    const acquire = useCallback(
        async (kind: MediaKind, deviceId?: string): Promise<boolean> => {
            const base = kind === "audio" ? AUDIO_CONSTRAINTS : VIDEO_CONSTRAINTS;
            const constraint: MediaTrackConstraints = deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
            const result = await requestUserMedia({ [kind]: constraint });
            if (!result.ok) {
                if (mountedRef.current) {
                    setError(result.error);
                    setStatus((prev) => ({ ...prev, [kind]: statusFor(result.error) }));
                }
                return false;
            }
            adoptStream(result.value);
            if (mountedRef.current) {
                setError(null);
            }
            return true;
        },
        [adoptStream],
    );

    /** Asks for the camera and the microphone in a single prompt. */
    const acquireBoth = useCallback(async () => {
        const both = await requestUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS });
        if (both.ok) {
            adoptStream(both.value);
        } else if (both.error.kind === "permission-denied") {
            if (mountedRef.current) {
                setError(both.error);
                setStatus({ audio: "denied", video: "denied" });
            }
        } else {
            // No camera, no microphone, or the two together couldn't be satisfied: ask for each on its own, so one
            // missing device doesn't cost the participant the other.
            await acquire("audio");
            await acquire("video");
        }
    }, [acquire, adoptStream]);

    const requestAccess = useCallback(
        async (kind?: MediaKind) => {
            if (!isMediaDevicesSupported()) {
                setSupported(false);
                return;
            }
            setRequesting(true);
            setError(null);
            await (kind ? acquire(kind) : acquireBoth());
            await refreshDevices();
            if (mountedRef.current) {
                setRequesting(false);
            }
        },
        [acquire, acquireBoth, refreshDevices],
    );

    const toggleMic = useCallback(async () => {
        const track = tracksRef.current.audio;
        if (!track) {
            micEnabledRef.current = true;
            setMicEnabled(true);
            await acquire("audio");
            await refreshDevices();
            return;
        }
        const next = !micEnabledRef.current;
        micEnabledRef.current = next;
        track.enabled = next;
        setMicEnabled(next);
    }, [acquire, refreshDevices]);

    const toggleCamera = useCallback(async () => {
        const track = tracksRef.current.video;
        if (!track) {
            await acquire("video");
            await refreshDevices();
            return;
        }
        track.onended = null;
        track.stop();
        tracksRef.current = { ...tracksRef.current, video: null };
        setTracks(tracksRef.current);
        setStatus((prev) => ({ ...prev, video: "off" }));
    }, [acquire, refreshDevices]);

    const selectDevice = useCallback(
        async (kind: MediaKind, deviceId: string) => {
            if (kind === "video") {
                // Some phones can't open a second camera while the first is still running.
                const current = tracksRef.current.video;
                if (current) {
                    current.onended = null;
                    current.stop();
                    tracksRef.current = { ...tracksRef.current, video: null };
                    setTracks(tracksRef.current);
                }
            }
            await acquire(kind, deviceId);
            await refreshDevices();
        },
        [acquire, refreshDevices],
    );

    const release = useCallback(() => {
        for (const track of Object.values(tracksRef.current)) {
            if (track) {
                track.onended = null;
                track.stop();
            }
        }
        tracksRef.current = { audio: null, video: null };
        setTracks(tracksRef.current);
        setStatus({ audio: "pending", video: "pending" });
    }, []);

    // Stops everything when the owner goes away.
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            for (const track of Object.values(tracksRef.current)) {
                track?.stop();
            }
            tracksRef.current = { audio: null, video: null };
        };
    }, []);

    // Keeps the device lists current as devices are plugged in and out.
    useEffect(() => {
        const devicesApi = defaultMediaDevices() as (MediaDevices | undefined);
        if (!devicesApi?.addEventListener) {
            return;
        }
        const onChange = () => void refreshDevices();
        devicesApi.addEventListener("devicechange", onChange);
        return () => devicesApi.removeEventListener("devicechange", onChange);
    }, [refreshDevices]);

    // The "your audio is being sent" level: follows the microphone while it is live and unmuted.
    useEffect(() => {
        if (!tracks.audio || !micEnabled) {
            setAudioLevel(0);
            return;
        }
        const handle = startLevelMeter(new MediaStream([tracks.audio]), (level) => {
            const step = Math.round(Math.min(1, level / LEVEL_FULL_SCALE) * AUDIO_LEVEL_STEPS);
            setAudioLevel((prev) => (prev === step ? prev : step));
        });
        return () => {
            handle?.stop();
            setAudioLevel(0);
        };
    }, [tracks.audio, micEnabled]);

    const videoStream = useMemo(() => (tracks.video ? new MediaStream([tracks.video]) : null), [tracks.video]);

    const selectedDeviceIds = useMemo(
        () => ({
            audio: tracks.audio?.getSettings?.().deviceId,
            video: tracks.video?.getSettings?.().deviceId,
        }),
        [tracks.audio, tracks.video],
    );

    return {
        supported,
        requesting,
        error,
        audioTrack: tracks.audio,
        videoTrack: tracks.video,
        videoStream,
        micEnabled,
        micOn: !!tracks.audio && micEnabled,
        cameraOn: !!tracks.video,
        status,
        devices,
        selectedDeviceIds,
        audioLevel,
        requestAccess,
        toggleMic,
        toggleCamera,
        selectDevice,
        release,
    };
}
