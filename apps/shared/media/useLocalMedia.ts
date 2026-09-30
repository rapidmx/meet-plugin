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
 * - **Filters**: while any video filter is on (`setFilters()`), `videoTrack`/`videoStream` are the *filtered*
 * picture (`filters/VideoFilterProcessor.ts`) rather than the camera's own track - so everything downstream, the
 * lobby preview and every path the call sends over, gets it without knowing. The camera's track stays owned here; the
 * processor only reads it. If the filtered picture can't be made there is no video at all rather than an unfiltered
 * one, since the filter may be hiding the participant's room.
 * - **Remembered settings**: the devices picked, whether the microphone and camera were on, and the filters are
 * saved on this device (`mediaPreferences.ts`) and applied the next time - a saved device is asked for as a
 * preference (`ideal`), so one that has since been unplugged falls back to the default instead of failing.
 *
 * Nothing here runs during SSR: browser APIs are only touched from effects and event handlers.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    type DeviceLists,
    type MediaAccessError,
    defaultMediaDevices,
    isMediaDevicesSupported,
    listDevices,
    notFoundError,
    requestUserMedia,
} from "./deviceMedia.js";
import { startLevelMeter } from "./levelMeter.js";
import { loadPicture, prepareBackgroundImage } from "./filters/backgroundImage.js";
import { NO_FILTERS, type VideoFilters, filtersActive } from "./filters/filterTypes.js";
import { type BackgroundPicture, type FilterStatus, VideoFilterProcessor } from "./filters/VideoFilterProcessor.js";
import { type MediaPreferences, loadPreferences, savePreferences } from "./mediaPreferences.js";

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
const FILTERS_UNSUPPORTED =
    "Video effects aren't supported in this browser, so your camera is off. Turn the effects off to show your camera.";

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
    /** The video filters in effect - `NO_FILTERS` when the camera is sent as it is. */
    filters: VideoFilters;
    /** Whether the filters' models are still loading, and why a filter isn't fully working. */
    filterStatus: FilterStatus;
    /** Whether a custom background image has been chosen (and so "custom image" can be switched to at once). */
    hasBackgroundImage: boolean;
    /** Changes some of the filters, keeping the rest. */
    setFilters(patch: Partial<VideoFilters>): void;
    /** Uses `file` as the custom background and switches to it. Resolves to why the file can't be used, or `null`. */
    chooseBackgroundImage(file: File): Promise<string | null>;
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

/** After asking for the camera and the microphone separately (`acquireBoth()`'s fallback, one at a time rather
 * than together), the one error to show for both attempts together - naming both devices when both are actually
 * missing, rather than just whichever of the two happened to be asked about last (which would otherwise say "no
 * camera" even when the microphone is *also* missing, or say nothing at all when only the microphone is missing,
 * since the camera's own success would otherwise clear the error the microphone's failure had just set). `null`
 * when both succeeded. */
function combineErrors(audio: MediaAccessError | null, video: MediaAccessError | null): MediaAccessError | null {
    if (!audio || !video) {
        return audio ?? video;
    }
    if (audio.kind === "not-found" && video.kind === "not-found") {
        return notFoundError(true, true);
    }
    // Different reasons - unusual (e.g. permission denied for one, missing hardware for the other). Permission is
    // the more actionable of the two, so it's what's shown; otherwise there's no single message that honestly
    // describes both, so this just picks one.
    return audio.kind === "permission-denied" ? audio : video;
}

export interface LocalMediaOptions {
    /** Where the filters' models are hosted, when not on the default CDN - see `filters/mlModels.ts`. */
    effectsAssetsUrl?: string;
}

/** `base`, asking for `preferredId` (the device used last time) when there is one - as a preference, not a demand. */
function preferring(base: MediaTrackConstraints, preferredId?: string): MediaTrackConstraints {
    return preferredId ? { ...base, deviceId: { ideal: preferredId } } : base;
}

export function useLocalMedia({ effectsAssetsUrl }: LocalMediaOptions = {}): LocalMedia {
    const [supported, setSupported] = useState(true);
    const [requesting, setRequesting] = useState(false);
    const [error, setError] = useState<MediaAccessError | null>(null);
    const [tracks, setTracks] = useState<Record<MediaKind, MediaStreamTrack | null>>({ audio: null, video: null });
    const [status, setStatus] = useState<Record<MediaKind, TrackStatus>>({ audio: "pending", video: "pending" });
    const [micEnabled, setMicEnabled] = useState(true);
    const [devices, setDevices] = useState<DeviceLists>({ cameras: [], microphones: [] });
    const [audioLevel, setAudioLevel] = useState(0);
    const [filters, setFiltersState] = useState<VideoFilters>(NO_FILTERS);
    const [background, setBackground] = useState<BackgroundPicture | null>(null);
    const [filterStatus, setFilterStatus] = useState<FilterStatus>({ loading: false, error: null });
    const [processed, setProcessed] = useState<MediaStreamTrack | null>(null);

    const tracksRef = useRef<Record<MediaKind, MediaStreamTrack | null>>({ audio: null, video: null });
    const micEnabledRef = useRef(true);
    const mountedRef = useRef(true);
    const prefsRef = useRef<MediaPreferences | null>(null);
    const filtersRef = useRef<VideoFilters>(NO_FILTERS);
    const backgroundRef = useRef<BackgroundPicture | null>(null);
    const processorRef = useRef<VideoFilterProcessor | null>(null);

    const applyFilters = useCallback((next: VideoFilters) => {
        filtersRef.current = next;
        setFiltersState(next);
    }, []);

    const applyBackground = useCallback((picture: BackgroundPicture) => {
        backgroundRef.current = picture;
        setBackground(picture);
    }, []);

    /** What was remembered from last time - read once, the first time anything needs it, and applied to the state it
     * covers. Never during render: storage doesn't exist on the server, and reading it would make the first client
     * render differ from the server's. */
    const ensurePrefs = useCallback((): MediaPreferences => {
        if (prefsRef.current) {
            return prefsRef.current;
        }
        const prefs = loadPreferences();
        prefsRef.current = prefs;
        if (prefs.micEnabled === false) {
            micEnabledRef.current = false;
            setMicEnabled(false);
        }
        if (prefs.filters) {
            applyFilters(prefs.filters);
        }
        if (prefs.backgroundImage) {
            loadPicture(prefs.backgroundImage).then(
                (picture) => {
                    if (mountedRef.current) {
                        applyBackground(picture);
                    }
                },
                () => undefined,
            );
        }
        return prefs;
    }, [applyBackground, applyFilters]);

    /** Saves a change to the remembered settings. */
    const remember = useCallback(
        (patch: Partial<MediaPreferences>) => {
            prefsRef.current = { ...ensurePrefs(), ...patch };
            savePreferences(patch);
        },
        [ensurePrefs],
    );

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
        if (kind === "video") {
            remember({ cameraEnabled: true });
        }
    }, [remember]);

    const adoptStream = useCallback(
        (stream: MediaStream) => {
            for (const track of stream.getTracks()) {
                adoptTrack(track);
            }
        },
        [adoptTrack],
    );

    /** Asks for one kind on its own - a specific device when `deviceId` is given, else the one used last time. */
    const acquire = useCallback(
        async (kind: MediaKind, deviceId?: string): Promise<MediaAccessError | null> => {
            const base = kind === "audio" ? AUDIO_CONSTRAINTS : VIDEO_CONSTRAINTS;
            const prefs = ensurePrefs();
            const constraint: MediaTrackConstraints = deviceId
                ? { ...base, deviceId: { exact: deviceId } }
                : preferring(base, kind === "audio" ? prefs.microphoneId : prefs.cameraId);
            const result = await requestUserMedia({ [kind]: constraint });
            if (!result.ok) {
                if (mountedRef.current) {
                    setError(result.error);
                    setStatus((prev) => ({ ...prev, [kind]: statusFor(result.error) }));
                }
                return result.error;
            }
            adoptStream(result.value);
            if (mountedRef.current) {
                setError(null);
            }
            return null;
        },
        [adoptStream, ensurePrefs],
    );

    /** Asks for the camera and the microphone in a single prompt. */
    const acquireBoth = useCallback(async () => {
        const prefs = ensurePrefs();
        if (prefs.cameraEnabled === false) {
            // The camera was off when the participant last left: join with it off, without switching it on first.
            if (mountedRef.current) {
                setStatus((prev) => ({ ...prev, video: "off" }));
            }
            await acquire("audio");
            return;
        }
        const both = await requestUserMedia({
            audio: preferring(AUDIO_CONSTRAINTS, prefs.microphoneId),
            video: preferring(VIDEO_CONSTRAINTS, prefs.cameraId),
        });
        if (both.ok) {
            adoptStream(both.value);
        } else if (both.error.kind === "permission-denied") {
            if (mountedRef.current) {
                setError(both.error);
                setStatus({ audio: "denied", video: "denied" });
            }
        } else {
            // No camera, no microphone, or the two together couldn't be satisfied: ask for each on its own, so one
            // missing device doesn't cost the participant the other - then combine what each found into one
            // message (see `combineErrors()`) rather than showing whichever of the two ran last.
            const audioError = await acquire("audio");
            const videoError = await acquire("video");
            if (mountedRef.current) {
                setError(combineErrors(audioError, videoError));
            }
        }
    }, [acquire, adoptStream, ensurePrefs]);

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
            remember({ micEnabled: true });
            await acquire("audio");
            await refreshDevices();
            return;
        }
        const next = !micEnabledRef.current;
        micEnabledRef.current = next;
        track.enabled = next;
        setMicEnabled(next);
        remember({ micEnabled: next });
    }, [acquire, refreshDevices, remember]);

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
        remember({ cameraEnabled: false });
    }, [acquire, refreshDevices, remember]);

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
            if ((await acquire(kind, deviceId)) === null) {
                remember(kind === "audio" ? { microphoneId: deviceId } : { cameraId: deviceId });
            }
            await refreshDevices();
        },
        [acquire, refreshDevices, remember],
    );

    const setFilters = useCallback(
        (patch: Partial<VideoFilters>) => {
            const next = { ...filtersRef.current, ...patch };
            applyFilters(next);
            remember({ filters: next });
        },
        [applyFilters, remember],
    );

    const chooseBackgroundImage = useCallback(
        async (file: File): Promise<string | null> => {
            const prepared = await prepareBackgroundImage(file);
            if (!prepared.ok) {
                return prepared.message;
            }
            if (mountedRef.current) {
                applyBackground(prepared.picture);
                remember({ backgroundImage: prepared.dataUrl });
                setFilters({ background: "image" });
            }
            return null;
        },
        [applyBackground, remember, setFilters],
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

    // Puts the camera through the filters for as long as any is on - see this module's doc comment. A layout effect,
    // so the filtered track is in place before the first frame is painted rather than after an unfiltered one.
    const filtersOn = filtersActive(filters);
    const source = tracks.video;
    useLayoutEffect(() => {
        if (!source || !filtersOn) {
            return;
        }
        let processor: VideoFilterProcessor;
        try {
            processor = new VideoFilterProcessor({
                source,
                filters: filtersRef.current,
                backgroundImage: backgroundRef.current,
                assetsUrl: effectsAssetsUrl,
                onStatus: setFilterStatus,
            });
        } catch {
            setFilterStatus({ loading: false, error: FILTERS_UNSUPPORTED });
            // Turning the filters off (or the camera) clears the message again.
            return () => setFilterStatus({ loading: false, error: null });
        }
        processorRef.current = processor;
        setProcessed(processor.track);
        return () => {
            processor.stop();
            processorRef.current = null;
            setProcessed(null);
            setFilterStatus({ loading: false, error: null });
        };
    }, [source, filtersOn, effectsAssetsUrl]);

    // Passes a change of filters (or of the background picture) on to the running processor.
    useEffect(() => {
        processorRef.current?.update(filters, background);
    }, [filters, background]);

    // While filters are on, the camera's own track is never what's sent: the filtered one is, or nothing.
    const videoTrack = filtersOn ? (source ? processed : null) : source;

    const videoStream = useMemo(() => (videoTrack ? new MediaStream([videoTrack]) : null), [videoTrack]);

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
        videoTrack,
        videoStream,
        micEnabled,
        micOn: !!tracks.audio && micEnabled,
        cameraOn: !!tracks.video,
        status,
        devices,
        selectedDeviceIds,
        audioLevel,
        filters,
        filterStatus,
        hasBackgroundImage: !!background,
        setFilters,
        chooseBackgroundImage,
        requestAccess,
        toggleMic,
        toggleCamera,
        selectDevice,
        release,
    };
}
