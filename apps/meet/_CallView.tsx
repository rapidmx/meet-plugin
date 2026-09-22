///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The in-call view: connects the full-mesh `MeshConnectionManager` to the meeting's signaling channel
 * (`GuestSignalingClient`), mirrors its events into React state, and renders the grid/focused/presentation
 * layouts - see `apps/shared/webrtc/MeshConnectionManager.ts`'s doc comment for the who-calls-whom and
 * single-presenter rules this view relies on rather than re-deciding. These reusable, non-UI modules live under
 * `apps/shared/` rather than this plugin's backend `src/` - `tsconfig.apps.json` builds `apps/` as its own
 * program rooted at `apps/`, which cannot reference files outside it (`TS6059`), matching `booking-plugin`'s own
 * identical `apps/shared/` convention for reusable frontend-only code.
 *
 * ## Layout precedence
 *
 * `computeMainUid()` decides who is shown large, in this order: an active presenter always wins (presentation
 * mode, forcing a focused-like layout regardless of `viewMode`); otherwise a manually pinned participant; else the
 * auto-detected active speaker (silently ignored while presenting, so it never fights the presenter for the main
 * slot); else, in focus mode with nobody yet speaking, the first other participant - so focus mode never shows an
 * empty main slot once someone else has joined.
 */
import React, { useEffect, useRef, useState } from "react";
import { pickActiveSpeaker } from "../shared/media/activeSpeaker.js";
import { startLevelMeter, type LevelMeterHandle } from "../shared/media/levelMeter.js";
import { requestDisplayMedia, setTracksEnabled, stopStream } from "../shared/media/deviceMedia.js";
import { createBrowserPeerConnection } from "../shared/webrtc/realPeerConnection.js";
import { MeshConnectionManager } from "../shared/webrtc/MeshConnectionManager.js";
import type { MeshParticipant } from "../shared/webrtc/types.js";
import { GuestSignalingClient } from "../shared/push/GuestSignalingClient.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import CallControls, { type CallViewMode } from "./_CallControls.js";
import ParticipantTile from "./_ParticipantTile.js";

export interface CallViewProps {
    channel: string;
    /** Omitted when the caller already authenticated as a real RapidMX identity in `join()` - there is then no
     * guest token to hand `GuestSignalingClient`, which relies entirely on the browser's own already-existing
     * `jwt` session cookie instead (see its own doc comment). */
    token?: string;
    selfUid: string;
    selfName: string;
    iceServers: RTCIceServer[];
    initialStream: MediaStream;
    initialMicOn: boolean;
    initialCameraOn: boolean;
    onLeave: () => void;
}

/** Who is shown large - see this module's doc comment. `undefined` when nobody but the local participant has
 * joined yet (the grid/focus toggle still works, there's just nobody else to focus on). */
export function computeMainUid(options: {
    presenterUid?: string;
    pinnedUid?: string;
    activeSpeakerUid?: string;
    otherUids: readonly string[];
}): string | undefined {
    if (options.presenterUid) {
        return options.presenterUid;
    }
    if (options.pinnedUid) {
        return options.pinnedUid;
    }
    if (options.activeSpeakerUid) {
        return options.activeSpeakerUid;
    }
    return options.otherUids[0];
}

export default function CallView({
    channel,
    token,
    selfUid,
    selfName,
    iceServers,
    initialStream,
    initialMicOn,
    initialCameraOn,
    onLeave,
}: CallViewProps) {
    const [connectError, setConnectError] = useState<string | null>(null);
    const [participants, setParticipants] = useState<MeshParticipant[]>([]);
    const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
    const [levels, setLevels] = useState<Record<string, number>>({});
    const [presenterUid, setPresenterUid] = useState<string | undefined>(undefined);
    const [micOn, setMicOn] = useState(initialMicOn);
    const [cameraOn, setCameraOn] = useState(initialCameraOn);
    const [isPresenting, setIsPresenting] = useState(false);
    const [viewMode, setViewMode] = useState<CallViewMode>("grid");
    const [pinnedUid, setPinnedUid] = useState<string | undefined>(undefined);
    const [activeSpeakerUid, setActiveSpeakerUid] = useState<string | undefined>(undefined);

    const managerRef = useRef<MeshConnectionManager | null>(null);
    const clientRef = useRef<GuestSignalingClient | null>(null);
    const localStreamRef = useRef(initialStream);
    const screenStreamRef = useRef<MediaStream | null>(null);
    const cameraTrackRef = useRef<MediaStreamTrack | null>(initialStream.getVideoTracks()[0] ?? null);
    const levelMetersRef = useRef<Record<string, LevelMeterHandle>>({});
    const isPresentingRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        const client = new GuestSignalingClient({ channel, token });
        clientRef.current = client;
        const manager = new MeshConnectionManager({
            selfUid,
            selfName,
            iceServers,
            channel: client,
            createPeerConnection: createBrowserPeerConnection,
            localStream: localStreamRef.current,
        });
        managerRef.current = manager;

        const unsubscribe = manager.onEvent((event) => {
            switch (event.type) {
                case "participant-joined":
                    setParticipants((prev) => [...prev.filter((p) => p.uid !== event.participant.uid), event.participant]);
                    return;
                case "participant-left":
                    setParticipants((prev) => prev.filter((p) => p.uid !== event.uid));
                    setRemoteStreams((prev) => {
                        const { [event.uid]: _removed, ...rest } = prev;
                        return rest;
                    });
                    stopLevelMeter(levelMetersRef, event.uid);
                    setLevels((prev) => {
                        const { [event.uid]: _removed, ...rest } = prev;
                        return rest;
                    });
                    setPinnedUid((prev) => (prev === event.uid ? undefined : prev));
                    return;
                case "remote-stream":
                    setRemoteStreams((prev) => ({ ...prev, [event.uid]: event.stream }));
                    startTrackingLevel(levelMetersRef, event.uid, event.stream, (level) =>
                        setLevels((prev) => ({ ...prev, [event.uid]: level })),
                    );
                    return;
                case "presenter-changed":
                    setPresenterUid(event.uid);
                    if (event.uid !== selfUid && isPresentingRef.current) {
                        // Lost a presenter-claim collision (see `MeshConnectionManager`'s doc comment) - stop our
                        // own capture without re-sending a release the manager already handled internally.
                        stopLocalPresentation(false);
                    }
                    return;
            }
        });

        client
            .connect()
            .then(() => {
                if (!cancelled) {
                    manager.start();
                }
            })
            .catch((err: Error) => {
                if (!cancelled) {
                    setConnectError(err.message);
                }
            });

        return () => {
            cancelled = true;
            unsubscribe();
            manager.stop();
            client.close();
            for (const handle of Object.values(levelMetersRef.current)) {
                handle.stop();
            }
            levelMetersRef.current = {};
            stopStream(localStreamRef.current);
            stopStream(screenStreamRef.current);
        };
        // Deliberately runs once - the call's identity (channel/token/selfUid) never changes for the life of this
        // component; a real identity change is a new call, which unmounts/remounts this view from `[token].tsx`.
    }, []);

    useEffect(() => {
        if (!presenterUid) {
            setActiveSpeakerUid((prev) => pickActiveSpeaker(levels, prev));
        }
    }, [levels, presenterUid]);

    function stopLocalPresentation(alsoRelease: boolean): void {
        isPresentingRef.current = false;
        setIsPresenting(false);
        if (alsoRelease) {
            managerRef.current?.releasePresenter();
        }
        stopStream(screenStreamRef.current);
        screenStreamRef.current = null;
        // Restores the camera track as the outgoing video sender - its own `enabled` flag (toggled by
        // `handleToggleCamera`, untouched by presenting) already governs whether it actually sends frames, so
        // this is correct whether or not the camera happens to be off right now.
        managerRef.current?.replaceLocalVideoTrack(cameraTrackRef.current);
    }

    async function handleToggleShare() {
        if (isPresenting) {
            stopLocalPresentation(true);
            return;
        }
        const result = await requestDisplayMedia();
        if (!result.ok) {
            setConnectError(result.error.message);
            return;
        }
        const claimed = managerRef.current?.claimPresenter() ?? false;
        if (!claimed) {
            stopStream(result.value);
            return;
        }
        screenStreamRef.current = result.value;
        const [screenTrack] = result.value.getVideoTracks();
        managerRef.current?.replaceLocalVideoTrack(screenTrack);
        isPresentingRef.current = true;
        setIsPresenting(true);
        screenTrack.onended = () => stopLocalPresentation(true);
    }

    function handleToggleMic() {
        setMicOn((prev) => {
            const next = !prev;
            setTracksEnabled(localStreamRef.current, "audio", next);
            return next;
        });
    }

    function handleToggleCamera() {
        setCameraOn((prev) => {
            const next = !prev;
            // Just the track's own `enabled` flag (see `deviceMedia.ts`'s `setTracksEnabled()` doc comment) -
            // whether that track is actually the one being sent (camera) or has been swapped out for a screen
            // share (`replaceLocalVideoTrack()`) is an orthogonal concern this toggle never touches.
            setTracksEnabled(localStreamRef.current, "video", next);
            return next;
        });
    }

    function handleLeave() {
        onLeave();
    }

    function togglePin(uid: string) {
        setPinnedUid((prev) => (prev === uid ? undefined : uid));
    }

    const otherUids = participants.map((p) => p.uid);
    const showFocusLayout = !!presenterUid || viewMode === "focus";
    const mainUid = showFocusLayout ? computeMainUid({ presenterUid, pinnedUid, activeSpeakerUid, otherUids }) : undefined;
    const presenterName = presenterUid ? (presenterUid === selfUid ? selfName : (participants.find((p) => p.uid === presenterUid)?.name ?? "Someone")) : undefined;

    const localTile = (
        <ParticipantTile
            key="__self"
            name={selfName}
            stream={isPresenting ? null : localStreamRef.current}
            isLocal
            cameraOff={!cameraOn && !isPresenting}
            micMuted={!micOn}
            isFocused={mainUid === selfUid}
            onClick={() => togglePin(selfUid)}
        />
    );

    const remoteTiles = participants.map((p) => (
        <ParticipantTile
            key={p.uid}
            name={p.name}
            stream={remoteStreams[p.uid] ?? null}
            cameraOff={!remoteStreams[p.uid]}
            isFocused={mainUid === p.uid}
            onClick={() => togglePin(p.uid)}
        />
    ));

    const allTiles = [localTile, ...remoteTiles];
    // The presenter's own screen content is rendered from their local capture, not their (replaced) outgoing
    // video sender - `mainStream` picks whichever is right for `mainUid`.
    const mainStream =
        mainUid === selfUid ? (isPresenting ? screenStreamRef.current : localStreamRef.current) : mainUid ? (remoteStreams[mainUid] ?? null) : null;
    const mainName = mainUid === selfUid ? selfName : (participants.find((p) => p.uid === mainUid)?.name ?? "");
    const thumbnailTiles = showFocusLayout ? allTiles.filter((tile) => tile.key !== (mainUid === selfUid ? "__self" : mainUid)) : allTiles;

    return (
        <div className="min-h-screen flex flex-col bg-surface-alt">
            {connectError && <Alert>{connectError}</Alert>}
            <div className="flex-1 p-3 flex flex-col gap-3 min-h-0">
                {showFocusLayout && mainUid ? (
                    <>
                        <div className="flex-1 min-h-0">
                            <ParticipantTile name={mainName} stream={mainStream} isLocal={mainUid === selfUid} isFocused className="h-full" />
                        </div>
                        <div className="flex gap-2 overflow-x-auto h-24 shrink-0">
                            {thumbnailTiles.map((tile) => (
                                <div key={tile.key} className="w-32 shrink-0">
                                    {tile}
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="flex-1 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">{allTiles}</div>
                )}
            </div>
            <CallControls
                micOn={micOn}
                onToggleMic={handleToggleMic}
                cameraOn={cameraOn}
                onToggleCamera={handleToggleCamera}
                isPresenting={isPresenting}
                presentingElsewhereName={presenterUid && presenterUid !== selfUid ? presenterName : undefined}
                onToggleShare={handleToggleShare}
                viewMode={viewMode}
                onToggleViewMode={() => setViewMode((prev) => (prev === "grid" ? "focus" : "grid"))}
                onLeave={handleLeave}
            />
        </div>
    );
}

function stopLevelMeter(ref: React.MutableRefObject<Record<string, LevelMeterHandle>>, uid: string): void {
    ref.current[uid]?.stop();
    delete ref.current[uid];
}

function startTrackingLevel(
    ref: React.MutableRefObject<Record<string, LevelMeterHandle>>,
    uid: string,
    stream: MediaStream,
    onLevel: (level: number) => void,
): void {
    stopLevelMeter(ref, uid);
    const handle = startLevelMeter(stream, onLevel);
    if (handle) {
        ref.current[uid] = handle;
    }
}
