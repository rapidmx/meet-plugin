///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The join/lobby step: name entry, a preview of the camera, the microphone and camera on/off buttons and pickers,
 * and the "Join" button. The camera and microphone are `LocalMedia` (`apps/shared/media/useLocalMedia.ts`), owned by
 * the page (`[token].tsx`) rather than by this component - the tracks previewed here are the tracks the call sends,
 * so leaving the lobby for the call must not (and does not) stop them.
 *
 * Access is requested when the lobby opens, and again from the "Allow" / "Try again" button: a click is a user
 * gesture, which some browsers require before they will show a permission prompt at all. When access is refused, or
 * there is no camera or microphone, the lobby says so and why, and joining is still allowed - a participant with
 * nothing to send can still see and hear the call, and turn a camera or microphone on later from the call controls.
 *
 * Per this plugin's Phase 2 spec, the name field is always editable - it is only ever *prefilled* when a session is
 * genuinely known (see this component's `initialName` prop and `[token].tsx`'s own doc comment on why that never
 * actually happens on this page today).
 */
import React, { useEffect, useRef, useState } from "react";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import type { LocalMedia, TrackStatus } from "../shared/media/useLocalMedia.js";
import type { PublicVideoMeeting } from "./_meetApi.js";
import { LevelBars } from "./_CallControls.js";
import { MicIcon, MicOffIcon, VideoIcon, VideoOffIcon } from "./_icons.js";

const INPUT_CLASS =
    "w-full text-base py-2.5 px-3.5 border border-border rounded-md bg-surface text-text focus:outline-none focus:border-primary";

const ROUND_BUTTON =
    "flex items-center justify-center gap-1.5 h-12 min-w-12 px-3 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80";

export interface MeetLobbyProps {
    meeting: PublicVideoMeeting;
    media: LocalMedia;
    /** Prefilled from `Profile.givenName` when a session was detected - still always editable. */
    initialName?: string;
    onJoin: (name: string) => void;
}

/** What the preview says when there is no picture to show. */
function previewMessage(media: LocalMedia): string {
    if (!media.supported) {
        return "This browser can't use a camera or microphone here.";
    }
    if (media.requesting) {
        return "Waiting for camera and microphone access…";
    }
    const status: TrackStatus = media.status.video;
    switch (status) {
        case "off":
            return "Camera is off";
        case "denied":
            return "Camera access is blocked";
        case "unavailable":
            return "No camera found";
        case "error":
            return "Camera couldn't start";
        default:
            return "No camera preview";
    }
}

export default function MeetLobby({ meeting, media, initialName, onJoin }: MeetLobbyProps) {
    const [name, setName] = useState(initialName ?? "");
    const videoRef = useRef<HTMLVideoElement>(null);
    const { requestAccess } = media;

    // Asks once, when the lobby opens - see this module's doc comment for the button that asks again.
    useEffect(() => {
        void requestAccess();
        // Only on mount: `requestAccess` is stable, and a later change of devices is the participant's own doing.
    }, []);

    // The `<video>` element only exists while there is a stream, so its stream is bound whenever it (re)appears.
    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.srcObject = media.videoStream;
        }
    }, [media.videoStream]);

    const cameraOk = media.status.video === "live" || media.status.video === "off";
    const needsAccess = media.supported && !media.requesting && (media.status.audio !== "live" || !cameraOk);
    const nothingToSend = !media.audioTrack && !media.videoTrack && !media.requesting;

    return (
        <div>
            <h1 className="text-2xl font-bold tracking-tight">{meeting.title}</h1>
            {meeting.hostDisplayName && <p className="text-sm text-text-muted mt-1">Hosted by {meeting.hostDisplayName}</p>}

            <div className="mt-6 grid sm:grid-cols-2 gap-6">
                <div>
                    <div className="relative aspect-video bg-[#202124] rounded-lg overflow-hidden flex items-center justify-center">
                        {media.videoStream ? (
                            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover [transform:scaleX(-1)]" />
                        ) : (
                            <p className="px-4 text-center text-white/70 text-sm">{previewMessage(media)}</p>
                        )}
                        <div className="absolute bottom-3 inset-x-0 flex justify-center gap-3">
                            <button
                                type="button"
                                className={`${ROUND_BUTTON} ${media.micOn ? "bg-[#3c4043] text-white hover:bg-[#4b4f53]" : "bg-[#f9dedc] text-[#8c1d18] hover:bg-[#f2c4c0]"}`}
                                aria-label={media.micOn ? "Mute microphone" : "Unmute microphone"}
                                aria-pressed={!media.micOn}
                                onClick={() => void media.toggleMic()}
                            >
                                {media.micOn && <LevelBars level={media.audioLevel} />}
                                {media.micOn ? <MicIcon /> : <MicOffIcon />}
                            </button>
                            <button
                                type="button"
                                className={`${ROUND_BUTTON} ${media.cameraOn ? "bg-[#3c4043] text-white hover:bg-[#4b4f53]" : "bg-[#f9dedc] text-[#8c1d18] hover:bg-[#f2c4c0]"}`}
                                aria-label={media.cameraOn ? "Turn off camera" : "Turn on camera"}
                                aria-pressed={!media.cameraOn}
                                onClick={() => void media.toggleCamera()}
                            >
                                {media.cameraOn ? <VideoIcon /> : <VideoOffIcon />}
                            </button>
                        </div>
                    </div>

                    {!media.supported && (
                        <Alert>
                            This browser (or this page's connection) doesn't support camera/microphone access. Try a current browser
                            over HTTPS - a link opened inside another app often needs to be opened in the browser itself.
                        </Alert>
                    )}
                    {media.error && <Alert>{media.error.message}</Alert>}
                    {needsAccess && (
                        <Button type="button" variant="secondary" className="!w-auto mt-3" onClick={() => void requestAccess()}>
                            {media.error ? "Try again" : "Allow camera and microphone"}
                        </Button>
                    )}
                    {nothingToSend && <p className="text-sm text-text-muted mt-3">You'll join without a camera or microphone.</p>}

                    {media.devices.cameras.length > 1 && (
                        <label className="block text-sm mt-3">
                            Camera
                            <select
                                className={`${INPUT_CLASS} mt-1`}
                                value={media.selectedDeviceIds.video ?? ""}
                                onChange={(e) => void media.selectDevice("video", e.target.value)}
                            >
                                {!media.selectedDeviceIds.video && <option value="">Choose a camera</option>}
                                {media.devices.cameras.map((d, i) => (
                                    <option key={d.deviceId} value={d.deviceId}>
                                        {d.label || `Camera ${i + 1}`}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    {media.devices.microphones.length > 1 && (
                        <label className="block text-sm mt-3">
                            Microphone
                            <select
                                className={`${INPUT_CLASS} mt-1`}
                                value={media.selectedDeviceIds.audio ?? ""}
                                onChange={(e) => void media.selectDevice("audio", e.target.value)}
                            >
                                {!media.selectedDeviceIds.audio && <option value="">Choose a microphone</option>}
                                {media.devices.microphones.map((d, i) => (
                                    <option key={d.deviceId} value={d.deviceId}>
                                        {d.label || `Microphone ${i + 1}`}
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
                    <Button type="button" className="!w-auto" disabled={!name.trim()} onClick={() => onJoin(name.trim())}>
                        Join meeting
                    </Button>
                </div>
            </div>
        </div>
    );
}
