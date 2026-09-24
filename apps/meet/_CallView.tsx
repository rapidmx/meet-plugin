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
 * ## Fitting the window
 *
 * The call fills the viewport (`fixed inset-0`) as three rows - a slim header, the tiles (which take whatever room
 * is left and never scroll the page), and the control bar pinned to the bottom - instead of being laid out inside
 * the branded page shell, whose header, footer and padding pushed it off the screen. The local participant's own
 * tile is a small tile in the bottom-right corner while anyone else is in the call (above the control bar on a narrower
 * window, and at the top on a phone, where the bar wraps onto a second row), and fills the tile area while they are
 * alone.
 *
 * ## Who is heard
 *
 * A tile never plays sound. Each remote stream is played by its own hidden `<audio>` element, so a participant is
 * heard whether or not their camera is on and whichever layout is showing. If the browser refuses to start the
 * audio (an autoplay policy), a banner asks for a click, which is the gesture that allows it.
 *
 * ## Layout precedence
 *
 * `computeMainUid()` decides who is shown large, in this order: an active presenter always wins (presentation
 * mode, forcing a focused-like layout regardless of `viewMode`); otherwise a manually pinned participant; else the
 * auto-detected active speaker (silently ignored while presenting, so it never fights the presenter for the main
 * slot); else, in focus mode with nobody yet speaking, the first other participant - so focus mode never shows an
 * empty main slot once someone else has joined.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { playRaisedHandChime } from "../shared/media/chime.js";
import { pickActiveSpeaker } from "../shared/media/activeSpeaker.js";
import { startLevelMeter, type LevelMeterHandle } from "../shared/media/levelMeter.js";
import { requestDisplayMedia, stopStream } from "../shared/media/deviceMedia.js";
import type { LocalMedia } from "../shared/media/useLocalMedia.js";
import { createBrowserPeerConnection } from "../shared/webrtc/realPeerConnection.js";
import { MeshConnectionManager } from "../shared/webrtc/MeshConnectionManager.js";
import type { MeshParticipant } from "../shared/webrtc/types.js";
import { GuestSignalingClient } from "../shared/push/GuestSignalingClient.js";
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
    meetingTitle: string;
    iceServers: RTCIceServer[];
    /** The camera and microphone, owned by the page (`[token].tsx`) - the lobby's tracks carried into the call. */
    media: LocalMedia;
    onLeave: () => void;
}

/** How long a reaction floats on screen. */
const REACTION_MS = 4_000;
/** The most reactions shown at once - a burst beyond this drops the oldest. */
const MAX_REACTIONS = 12;

interface Reaction {
    id: number;
    emoji: string;
    name: string;
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

/** This tab's identity on the signaling channel: the account (or guest) uid plus a random suffix, so the same
 * account joining from two devices - or two tabs - is two participants rather than one that ignores itself. */
export function newPeerId(selfUid: string): string {
    return `${selfUid}~${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export default function CallView({ channel, token, selfUid, selfName, meetingTitle, iceServers, media, onLeave }: CallViewProps) {
    const [peerId] = useState(() => newPeerId(selfUid));
    const [connectError, setConnectError] = useState<string | null>(null);
    const [participants, setParticipants] = useState<MeshParticipant[]>([]);
    const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
    const [levels, setLevels] = useState<Record<string, number>>({});
    const [presenterUid, setPresenterUid] = useState<string | undefined>(undefined);
    const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
    const [handRaised, setHandRaised] = useState(false);
    const [viewMode, setViewMode] = useState<CallViewMode>("grid");
    const [pinnedUid, setPinnedUid] = useState<string | undefined>(undefined);
    const [activeSpeakerUid, setActiveSpeakerUid] = useState<string | undefined>(undefined);
    const [reactions, setReactions] = useState<Reaction[]>([]);
    const [announcement, setAnnouncement] = useState("");
    const [audioBlocked, setAudioBlocked] = useState(false);
    const [audioNonce, setAudioNonce] = useState(0);

    const managerRef = useRef<MeshConnectionManager | null>(null);
    const screenStreamRef = useRef<MediaStream | null>(null);
    const levelMetersRef = useRef<Record<string, LevelMeterHandle>>({});
    const reactionSeqRef = useRef(0);
    const reactionTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    const isPresenting = !!screenStream;

    const showReaction = useCallback((emoji: string, name: string) => {
        const id = ++reactionSeqRef.current;
        setReactions((prev) => [...prev.slice(-(MAX_REACTIONS - 1)), { id, emoji, name }]);
        const timer = setTimeout(() => {
            reactionTimersRef.current.delete(timer);
            setReactions((prev) => prev.filter((reaction) => reaction.id !== id));
        }, REACTION_MS);
        reactionTimersRef.current.add(timer);
    }, []);

    useEffect(() => {
        let cancelled = false;
        const client = new GuestSignalingClient({ channel, token });
        const manager = new MeshConnectionManager({
            selfUid: peerId,
            selfName,
            iceServers,
            channel: client,
            createPeerConnection: createBrowserPeerConnection,
            localAudioTrack: media.audioTrack,
            localVideoTrack: media.videoTrack,
            localState: { audioOn: media.micOn, videoOn: media.cameraOn },
        });
        managerRef.current = manager;

        const unsubscribe = manager.onEvent((event) => {
            switch (event.type) {
                case "participant-joined":
                    setParticipants((prev) => [...prev.filter((p) => p.uid !== event.participant.uid), event.participant]);
                    return;
                case "participant-updated":
                    setParticipants((prev) => prev.map((p) => (p.uid === event.participant.uid ? event.participant : p)));
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
                case "hand-raised":
                    playRaisedHandChime();
                    setAnnouncement(`${event.name} raised a hand`);
                    return;
                case "reaction":
                    showReaction(event.emoji, event.name);
                    return;
                case "presenter-changed":
                    setPresenterUid(event.uid);
                    if (event.uid !== peerId && screenStreamRef.current) {
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

        // A closing tab doesn't unmount React, so say goodbye explicitly - otherwise everyone else keeps a tile for a
        // participant who is gone.
        const onPageHide = () => manager.stop();
        window.addEventListener("pagehide", onPageHide);

        const timers = reactionTimersRef.current;
        return () => {
            cancelled = true;
            window.removeEventListener("pagehide", onPageHide);
            unsubscribe();
            manager.stop();
            client.close();
            for (const handle of Object.values(levelMetersRef.current)) {
                handle.stop();
            }
            levelMetersRef.current = {};
            // Only the screen capture is this view's to stop - the camera and microphone belong to the page, which
            // releases them when the participant leaves.
            stopStream(screenStreamRef.current);
            for (const timer of timers) {
                clearTimeout(timer);
            }
            timers.clear();
        };
        // Deliberately runs once - the call's identity (channel/token/selfUid) never changes for the life of this
        // component; a real identity change is a new call, which unmounts/remounts this view from `[token].tsx`.
    }, []);

    // What is sent follows what the participant has: the camera or the shared screen, and the microphone.
    useEffect(() => {
        managerRef.current?.setLocalTrack("audio", media.audioTrack);
    }, [media.audioTrack]);
    useEffect(() => {
        managerRef.current?.setLocalTrack("video", screenStream?.getVideoTracks()[0] ?? media.videoTrack);
    }, [media.videoTrack, screenStream]);
    useEffect(() => {
        managerRef.current?.setLocalState({ audioOn: media.micOn, videoOn: media.cameraOn || isPresenting, handRaised });
    }, [media.micOn, media.cameraOn, isPresenting, handRaised]);

    useEffect(() => {
        if (!presenterUid) {
            setActiveSpeakerUid((prev) => pickActiveSpeaker(levels, prev));
        }
    }, [levels, presenterUid]);

    function stopLocalPresentation(alsoRelease: boolean): void {
        if (alsoRelease) {
            managerRef.current?.releasePresenter();
        }
        stopStream(screenStreamRef.current);
        screenStreamRef.current = null;
        // The sync effect above swaps the camera back in as the outgoing video track.
        setScreenStream(null);
    }

    async function handleToggleShare() {
        if (screenStreamRef.current) {
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
        setScreenStream(result.value);
        result.value.getVideoTracks()[0].onended = () => stopLocalPresentation(true);
    }

    function handleToggleHand() {
        setHandRaised((prev) => !prev);
    }

    function handleReaction(emoji: string) {
        if (managerRef.current?.sendReaction(emoji)) {
            showReaction(emoji, "You");
        }
    }

    function togglePin(uid: string) {
        setPinnedUid((prev) => (prev === uid ? undefined : uid));
    }

    function handleAudioBlocked() {
        setAudioBlocked(true);
    }

    function handleResumeAudio() {
        setAudioBlocked(false);
        setAudioNonce((prev) => prev + 1);
    }

    const otherUids = participants.map((p) => p.uid);
    // A pin or an active-speaker pick can name someone who has just left, until the state catches up.
    const stillHere = (uid: string | undefined) => (uid && otherUids.includes(uid) ? uid : undefined);
    const showFocusLayout = !!presenterUid || viewMode === "focus";
    const mainUid = showFocusLayout
        ? computeMainUid({ presenterUid, pinnedUid: stillHere(pinnedUid), activeSpeakerUid: stillHere(activeSpeakerUid), otherUids })
        : undefined;
    const presenterName = presenterUid ? (presenterUid === peerId ? selfName : (participants.find((p) => p.uid === presenterUid)?.name ?? "Someone")) : undefined;
    const raisedNames = [...(handRaised ? ["You"] : []), ...participants.filter((p) => p.handRaised).map((p) => p.name)];
    const alone = participants.length === 0;

    const remoteTile = (p: MeshParticipant, className?: string) => (
        <ParticipantTile
            key={p.uid}
            name={p.name}
            stream={remoteStreams[p.uid] ?? null}
            cameraOff={!p.videoOn}
            micMuted={!p.audioOn}
            handRaised={p.handRaised}
            isFocused={mainUid === p.uid}
            contain={presenterUid === p.uid}
            className={className}
            onClick={() => togglePin(p.uid)}
        />
    );

    const selfTile = (className?: string) => (
        <ParticipantTile
            name={selfName}
            stream={media.videoStream}
            isLocal
            cameraOff={!media.cameraOn}
            micMuted={!media.micOn}
            handRaised={handRaised}
            className={className}
        />
    );

    const mainParticipant = participants.find((p) => p.uid === mainUid);
    const thumbnails = participants.filter((p) => p.uid !== mainUid);

    let stage: React.ReactNode;
    if (alone) {
        // Nobody else yet: the local participant fills the tile area, presenting or not.
        stage = isPresenting ? (
            <ParticipantTile name={selfName} stream={screenStream} isLocal contain isFocused className="h-full" />
        ) : (
            selfTile("h-full")
        );
    } else if (showFocusLayout && (mainParticipant || isPresenting)) {
        stage = (
            <div className="h-full flex flex-col gap-2">
                <div className="flex-1 min-h-0" data-testid="main-tile">
                    {mainParticipant ? (
                        remoteTile(mainParticipant, "h-full")
                    ) : (
                        <ParticipantTile name={selfName} stream={screenStream} isLocal contain isFocused className="h-full" />
                    )}
                </div>
                {thumbnails.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto h-24 shrink-0" data-testid="thumbnails">
                        {thumbnails.map((p) => (
                            <div key={p.uid} className="w-36 shrink-0">
                                {remoteTile(p, "h-full")}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    } else {
        stage = (
            <div className="h-full grid gap-2 auto-rows-fr [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
                {participants.map((p) => remoteTile(p, "h-full"))}
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#202124] text-white overflow-hidden">
            <style>{`@keyframes meet-float { 0% { transform: translateY(0) scale(.6); opacity: 0; } 12% { opacity: 1; transform: translateY(-4vh) scale(1); } 100% { transform: translateY(-45vh) scale(1); opacity: 0; } }`}</style>
            <header className="shrink-0 flex items-center justify-between gap-3 px-4 py-3">
                <h1 className="min-w-0 truncate text-base font-medium">{meetingTitle}</h1>
                <div className="flex items-center gap-2 shrink-0">
                    {raisedNames.length > 0 && (
                        <span className="max-w-[45vw] truncate px-3 py-1.5 rounded-full bg-[#a8c7fa] text-[#062e6f] text-sm font-medium" data-testid="raised-hands">
                            ✋ {raisedNames.join(", ")}
                        </span>
                    )}
                    <span className="px-3 py-1.5 rounded-full bg-[#3c4043] text-sm" aria-label={`${participants.length + 1} participants`}>
                        {participants.length + 1}
                    </span>
                </div>
            </header>
            {connectError && (
                <div role="alert" className="shrink-0 mx-3 mb-2 px-3 py-2 rounded-lg bg-[#601410] text-[#f9dedc] text-sm">
                    {connectError}
                </div>
            )}
            {audioBlocked && (
                <button
                    type="button"
                    className="shrink-0 mx-3 mb-2 px-3 py-2 rounded-lg bg-[#a8c7fa] text-[#062e6f] text-sm font-medium"
                    onClick={handleResumeAudio}
                >
                    Click here to turn on sound
                </button>
            )}
            <main className="relative flex-1 min-h-0 px-3 pb-3">
                {stage}
                {presenterName && presenterUid !== peerId && (
                    <p className="absolute top-2 left-5 px-2 py-0.5 rounded bg-black/60 text-sm">{presenterName} is presenting</p>
                )}
            </main>
            <footer className="shrink-0 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                <CallControls
                    media={media}
                    isPresenting={isPresenting}
                    presentingElsewhereName={presenterUid && presenterUid !== peerId ? presenterName : undefined}
                    onToggleShare={() => void handleToggleShare()}
                    handRaised={handRaised}
                    onToggleHand={handleToggleHand}
                    onReaction={handleReaction}
                    viewMode={viewMode}
                    onToggleViewMode={() => setViewMode((prev) => (prev === "grid" ? "focus" : "grid"))}
                    onLeave={onLeave}
                />
            </footer>

            {!alone && (
                <div
                    className="absolute z-10 right-3 top-14 w-28 sm:top-auto sm:bottom-24 sm:w-52 aspect-video shadow-xl xl:right-4 xl:bottom-4"
                    data-testid="self-view"
                >
                    {selfTile("h-full")}
                </div>
            )}

            <div className="pointer-events-none absolute left-4 bottom-28 w-40 h-[45vh]" aria-hidden="true">
                {reactions.map((reaction) => (
                    <div
                        key={reaction.id}
                        className="absolute bottom-0 flex flex-col items-center"
                        style={{ left: `${(reaction.id % 4) * 36}px`, animation: `meet-float ${REACTION_MS}ms ease-out forwards` }}
                        data-testid="reaction"
                    >
                        <span className="text-4xl leading-none">{reaction.emoji}</span>
                        <span className="mt-1 px-1.5 rounded-full bg-[#a8c7fa] text-[#062e6f] text-xs">{reaction.name}</span>
                    </div>
                ))}
            </div>

            {participants.map((p) => {
                const stream = remoteStreams[p.uid];
                return stream ? <RemoteAudio key={`${p.uid}:${audioNonce}`} stream={stream} onBlocked={handleAudioBlocked} /> : null;
            })}
            <div role="status" aria-live="polite" className="sr-only">
                {announcement}
            </div>
        </div>
    );
}

/** Plays one remote participant's stream through a hidden `<audio>` element. `onBlocked` fires if the browser
 * refuses to start it (an autoplay policy) - the view then asks for a click. */
function RemoteAudio({ stream, onBlocked }: { stream: MediaStream; onBlocked: () => void }) {
    const audioRef = useRef<HTMLAudioElement>(null);
    useEffect(() => {
        const element = audioRef.current!;
        element.srcObject = stream;
        void Promise.resolve(element.play()).catch(onBlocked);
    }, [stream, onBlocked]);
    return <audio ref={audioRef} autoPlay data-testid="remote-audio" />;
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
