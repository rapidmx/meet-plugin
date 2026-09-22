///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The join/lobby step: name entry, device preview and pickers, mute/camera-off starting preferences, and the
 * "Join" button. Per this plugin's Phase 2 spec, the name field is always editable - it is only ever *prefilled*
 * when a session is genuinely known (see this component's `initialName` prop and `[token].tsx`'s own doc comment
 * on why that never actually happens on this page today).
 *
 * Device support/permission errors (`navigator.mediaDevices` missing entirely - e.g. a non-HTTPS context in some
 * browsers - a denied prompt, or no camera/microphone at all) are shown as a plain message rather than crashing;
 * joining is still allowed with no local media in that case (a signaling-only participant - see this plugin's
 * Phase 2 report's known-limitations note on why that participant's peer connections can carry no media at all
 * without this design's simpler, renegotiation-free mesh needing to grow one).
 */
import React, { useEffect, useRef, useState } from "react";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import {
    type DeviceLists,
    type MediaAccessError,
    isMediaDevicesSupported,
    listDevices,
    requestUserMedia,
    setTracksEnabled,
    stopStream,
} from "../shared/media/deviceMedia.js";
import type { PublicVideoMeeting } from "./_meetApi.js";

const INPUT_CLASS =
    "w-full text-base py-2.5 px-3.5 border border-border rounded-md bg-surface text-text focus:outline-none focus:border-primary";

export interface JoinPreferences {
    name: string;
    micOn: boolean;
    cameraOn: boolean;
    /** Never `null` - an empty `MediaStream` when no device access was ever obtained, so the call view always has
     * a stream to work with. */
    stream: MediaStream;
}

export interface MeetLobbyProps {
    meeting: PublicVideoMeeting;
    /** Prefilled from `Profile.givenName` when a session was detected - still always editable. */
    initialName?: string;
    onJoin: (preferences: JoinPreferences) => void;
}

export default function MeetLobby({ meeting, initialName, onJoin }: MeetLobbyProps) {
    const [name, setName] = useState(initialName ?? "");
    const [micOn, setMicOn] = useState(true);
    const [cameraOn, setCameraOn] = useState(true);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [devices, setDevices] = useState<DeviceLists>({ cameras: [], microphones: [] });
    const [error, setError] = useState<MediaAccessError | null>(null);
    const [supported, setSupported] = useState(true);
    const videoRef = useRef<HTMLVideoElement>(null);

    // Requests device access once, on mount - never re-requested just because `micOn`/`cameraOn` toggle (those
    // toggles disable/enable the already-granted tracks instead, see `handleToggleMic`/`handleToggleCamera`).
    useEffect(() => {
        let cancelled = false;
        if (!isMediaDevicesSupported()) {
            setSupported(false);
            return;
        }
        void requestUserMedia({ audio: true, video: true }).then(async (result) => {
            if (cancelled) {
                return;
            }
            if (!result.ok) {
                setError(result.error);
                return;
            }
            setStream(result.value);
            const list = await listDevices();
            if (!cancelled && list.ok) {
                setDevices(list.value);
            }
        });
        return () => {
            cancelled = true;
        };
        // Intentionally empty deps - see this effect's own comment on why this never re-runs.
    }, []);

    // Releases the camera/microphone the moment this component unmounts (leaving the lobby without joining, or
    // transitioning into the call - `[token].tsx` requests its own continuation of these tracks first).
    useEffect(() => stopOnUnmount(stream), [stream]);

    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.srcObject = stream;
        }
    }, [stream]);

    function handleToggleMic() {
        setMicOn((prev) => {
            const next = !prev;
            setTracksEnabled(stream, "audio", next);
            return next;
        });
    }

    function handleToggleCamera() {
        setCameraOn((prev) => {
            const next = !prev;
            setTracksEnabled(stream, "video", next);
            return next;
        });
    }

    async function handleSwitchDevice(kind: "audio" | "video", deviceId: string) {
        const result = await requestUserMedia({ [kind]: { deviceId: { exact: deviceId } }, [kind === "audio" ? "video" : "audio"]: false });
        if (!result.ok) {
            setError(result.error);
            return;
        }
        const [newTrack] = kind === "audio" ? result.value.getAudioTracks() : result.value.getVideoTracks();
        // `stream` is always set by the time this can be called - the device picker this is wired to only ever
        // renders once `devices` is populated, which itself only happens after an initial successful
        // `requestUserMedia()` call has already set `stream` (see the mount effect above).
        if (!newTrack) {
            return;
        }
        const [oldTrack] = kind === "audio" ? stream!.getAudioTracks() : stream!.getVideoTracks();
        if (oldTrack) {
            stream!.removeTrack(oldTrack);
            oldTrack.stop();
        }
        newTrack.enabled = kind === "audio" ? micOn : cameraOn;
        stream!.addTrack(newTrack);
        // Re-triggers the preview `<video>` binding and any downstream consumer without minting a whole new
        // `MediaStream` object (the mesh's already-negotiated connections keep the same stream identity).
        setStream((current) => current);
    }

    function handleJoin() {
        onJoin({
            name: name.trim(),
            micOn,
            cameraOn,
            stream: stream ?? new MediaStream(),
        });
    }

    return (
        <div>
            <h1 className="text-2xl font-bold tracking-tight">{meeting.title}</h1>
            {meeting.hostDisplayName && <p className="text-sm text-text-muted mt-1">Hosted by {meeting.hostDisplayName}</p>}

            <div className="mt-6 grid sm:grid-cols-2 gap-6">
                <div>
                    <div className="aspect-video bg-black/80 rounded-md overflow-hidden flex items-center justify-center">
                        {stream && cameraOn ? (
                            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                        ) : (
                            <p className="text-white/70 text-sm">{cameraOn ? "No camera preview" : "Camera is off"}</p>
                        )}
                    </div>
                    <div className="flex gap-2 mt-3">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={handleToggleMic} disabled={!stream}>
                            {micOn ? "Mute mic" : "Unmute mic"}
                        </Button>
                        <Button type="button" variant="secondary" className="!w-auto" onClick={handleToggleCamera} disabled={!stream}>
                            {cameraOn ? "Turn camera off" : "Turn camera on"}
                        </Button>
                    </div>
                    {!supported && <Alert>This browser (or this page's connection) doesn't support camera/microphone access.</Alert>}
                    {error && <Alert>{error.message}</Alert>}
                    {devices.cameras.length > 1 && (
                        <label className="block text-sm mt-3">
                            Camera
                            <select className={`${INPUT_CLASS} mt-1`} onChange={(e) => handleSwitchDevice("video", e.target.value)}>
                                {devices.cameras.map((d) => (
                                    <option key={d.deviceId} value={d.deviceId}>
                                        {d.label || "Camera"}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    {devices.microphones.length > 1 && (
                        <label className="block text-sm mt-3">
                            Microphone
                            <select className={`${INPUT_CLASS} mt-1`} onChange={(e) => handleSwitchDevice("audio", e.target.value)}>
                                {devices.microphones.map((d) => (
                                    <option key={d.deviceId} value={d.deviceId}>
                                        {d.label || "Microphone"}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                </div>

                <div className="flex flex-col justify-center gap-3">
                    <FormField label="Your name" htmlFor="meet-name">
                        <input
                            id="meet-name"
                            type="text"
                            className={INPUT_CLASS}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Enter your name"
                        />
                    </FormField>
                    <Button type="button" className="!w-auto" disabled={!name.trim()} onClick={handleJoin}>
                        Join meeting
                    </Button>
                </div>
            </div>
        </div>
    );
}

/** `useEffect` cleanup helper for stopping a lobby preview stream on unmount/replacement - a named function
 * (rather than an inline arrow) purely so its intent reads clearly at the call site. */
function stopOnUnmount(stream: MediaStream | null): () => void {
    return () => stopStream(stream);
}
