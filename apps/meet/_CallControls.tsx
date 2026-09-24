///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The in-call control bar, fixed to the bottom of the call (`_CallView.tsx` lays it out below the tiles, never over
 * them). Its menus open upward, centered on the whole bar on a phone (where the bar wraps onto two rows and a menu
 * hung from its own button would run off the edge) and from their own button on a wider window: microphone and camera (each a mute/unmute or on/off button next to a menu that picks the device), share
 * screen, reactions, raise hand, grid/focus and leave.
 *
 * The microphone button shows a live level while it is unmuted - bars that move with the sound the microphone is
 * picking up, so a participant can see their audio is being sent - and the camera button shows a green dot while a
 * camera is sending. Both are driven by `LocalMedia` (`apps/shared/media/useLocalMedia.ts`).
 */
import React, { useEffect, useRef, useState } from "react";
import type { LocalMedia, MediaKind } from "../shared/media/useLocalMedia.js";
import { REACTION_EMOJIS } from "../shared/webrtc/types.js";
import {
    ChevronUpIcon,
    EmojiIcon,
    FocusIcon,
    GridIcon,
    HandIcon,
    LeaveIcon,
    MicIcon,
    MicOffIcon,
    ScreenShareIcon,
    VideoIcon,
    VideoOffIcon,
} from "./_icons.js";

export type CallViewMode = "grid" | "focus";

export interface CallControlsProps {
    media: LocalMedia;
    isPresenting: boolean;
    /** Someone else is presenting - the share button is disabled and explains why. */
    presentingElsewhereName?: string;
    onToggleShare: () => void;
    handRaised: boolean;
    onToggleHand: () => void;
    onReaction: (emoji: string) => void;
    viewMode: CallViewMode;
    onToggleViewMode: () => void;
    onLeave: () => void;
}

type OpenMenu = MediaKind | "emoji" | null;

const BUTTON = "flex items-center justify-center h-12 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80";
const NEUTRAL = "bg-[#3c4043] text-white hover:bg-[#4b4f53]";
const ALERT = "bg-[#f9dedc] text-[#8c1d18] hover:bg-[#f2c4c0]";
const ACTIVE = "bg-[#a8c7fa] text-[#062e6f] hover:bg-[#8ab4f8]";

/** Bars that rise and fall with the microphone's level (0-5) - a flat, dim set while there is no sound. */
export function LevelBars({ level }: { level: number }) {
    return (
        <span className="flex items-center gap-[2px] h-5" data-testid="mic-level" data-level={level} aria-hidden="true">
            {[0.6, 1, 0.6].map((weight, i) => (
                <span
                    key={i}
                    className={`w-[3px] rounded-full ${level > 0 ? "bg-[#8ab4f8]" : "bg-white/50"}`}
                    style={{ height: `${4 + weight * level * 3}px` }}
                />
            ))}
        </span>
    );
}

export default function CallControls({
    media,
    isPresenting,
    presentingElsewhereName,
    onToggleShare,
    handRaised,
    onToggleHand,
    onReaction,
    viewMode,
    onToggleViewMode,
    onLeave,
}: CallControlsProps) {
    const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const shareDisabled = !isPresenting && !!presentingElsewhereName;

    // A menu closes on Escape or a press anywhere outside the bar.
    useEffect(() => {
        if (!openMenu) {
            return;
        }
        const onPointerDown = (event: PointerEvent) => {
            if (!barRef.current?.contains(event.target as Node)) {
                setOpenMenu(null);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpenMenu(null);
            }
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [openMenu]);

    function toggleMenu(menu: Exclude<OpenMenu, null>) {
        setOpenMenu((prev) => (prev === menu ? null : menu));
    }

    return (
        <div ref={barRef} className="relative flex flex-wrap items-center justify-center gap-2 px-3" role="toolbar" aria-label="Call controls">
            <div className="sm:relative flex items-stretch gap-px">
                <button
                    type="button"
                    className={`${BUTTON} w-9 rounded-r-none ${media.micOn ? NEUTRAL : ALERT}`}
                    aria-label="Choose microphone"
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "audio"}
                    onClick={() => toggleMenu("audio")}
                >
                    <ChevronUpIcon />
                </button>
                <button
                    type="button"
                    className={`${BUTTON} min-w-14 gap-1.5 px-3 rounded-l-none ${media.micOn ? NEUTRAL : ALERT}`}
                    aria-label={media.micOn ? "Mute microphone" : "Unmute microphone"}
                    aria-pressed={!media.micOn}
                    onClick={() => void media.toggleMic()}
                >
                    {media.micOn && <LevelBars level={media.audioLevel} />}
                    {media.micOn ? <MicIcon /> : <MicOffIcon />}
                </button>
                {openMenu === "audio" && <DeviceMenu kind="audio" media={media} onClose={() => setOpenMenu(null)} />}
            </div>

            <div className="sm:relative flex items-stretch gap-px">
                <button
                    type="button"
                    className={`${BUTTON} w-9 rounded-r-none ${media.cameraOn ? NEUTRAL : ALERT}`}
                    aria-label="Choose camera"
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "video"}
                    onClick={() => toggleMenu("video")}
                >
                    <ChevronUpIcon />
                </button>
                <button
                    type="button"
                    className={`${BUTTON} relative min-w-14 px-3 rounded-l-none ${media.cameraOn ? NEUTRAL : ALERT}`}
                    aria-label={media.cameraOn ? "Turn off camera" : "Turn on camera"}
                    aria-pressed={!media.cameraOn}
                    onClick={() => void media.toggleCamera()}
                >
                    {media.cameraOn ? <VideoIcon /> : <VideoOffIcon />}
                    {media.cameraOn && (
                        <span
                            className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#34a853] animate-pulse"
                            data-testid="camera-live"
                            title="Your camera is sending"
                        />
                    )}
                </button>
                {openMenu === "video" && <DeviceMenu kind="video" media={media} onClose={() => setOpenMenu(null)} />}
            </div>

            <button
                type="button"
                className={`${BUTTON} w-12 ${isPresenting ? ACTIVE : NEUTRAL} disabled:opacity-40 disabled:cursor-not-allowed`}
                aria-label={isPresenting ? "Stop sharing" : "Share screen"}
                aria-pressed={isPresenting}
                disabled={shareDisabled}
                title={shareDisabled ? `${presentingElsewhereName} is presenting - stop their share to present yourself.` : undefined}
                onClick={onToggleShare}
            >
                <ScreenShareIcon />
            </button>

            <div className="sm:relative">
                <button
                    type="button"
                    className={`${BUTTON} w-12 ${NEUTRAL}`}
                    aria-label="Send a reaction"
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "emoji"}
                    onClick={() => toggleMenu("emoji")}
                >
                    <EmojiIcon />
                </button>
                {openMenu === "emoji" && (
                    <div
                        role="menu"
                        aria-label="Reactions"
                        className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 w-max grid grid-cols-4 gap-1 p-2 rounded-2xl bg-[#2b2d30] shadow-xl"
                    >
                        {REACTION_EMOJIS.map((emoji) => (
                            <button
                                key={emoji}
                                type="button"
                                role="menuitem"
                                className="w-11 h-11 rounded-lg text-2xl hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                                aria-label={`Send ${emoji}`}
                                onClick={() => {
                                    onReaction(emoji);
                                    setOpenMenu(null);
                                }}
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <button
                type="button"
                className={`${BUTTON} w-12 ${handRaised ? ACTIVE : NEUTRAL}`}
                aria-label={handRaised ? "Lower hand" : "Raise hand"}
                aria-pressed={handRaised}
                onClick={onToggleHand}
            >
                <HandIcon />
            </button>

            <button
                type="button"
                className={`${BUTTON} w-12 ${NEUTRAL}`}
                aria-label={viewMode === "grid" ? "Switch to focused view" : "Switch to grid view"}
                onClick={onToggleViewMode}
            >
                {viewMode === "grid" ? <FocusIcon /> : <GridIcon />}
            </button>

            <button type="button" className={`${BUTTON} w-16 bg-[#d93025] text-white hover:bg-[#b3261e]`} aria-label="Leave call" onClick={onLeave}>
                <LeaveIcon />
            </button>
        </div>
    );
}

/** The device picker opened from the chevron beside the microphone/camera button: the available devices with the
 * one in use ticked, or - while there are none to list - why, with a way to ask for access again. */
function DeviceMenu({ kind, media, onClose }: { kind: MediaKind; media: LocalMedia; onClose: () => void }) {
    const list = kind === "audio" ? media.devices.microphones : media.devices.cameras;
    const noun = kind === "audio" ? "microphone" : "camera";
    const selected = media.selectedDeviceIds[kind];
    const denied = media.status[kind] === "denied";
    return (
        <div
            role="menu"
            aria-label={kind === "audio" ? "Microphones" : "Cameras"}
            className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 sm:left-0 sm:translate-x-0 w-max min-w-64 max-w-[calc(100vw-1rem)] p-1 rounded-lg bg-[#2b2d30] text-white text-sm shadow-xl"
        >
            {list.map((device, index) => (
                <button
                    key={device.deviceId}
                    type="button"
                    role="menuitemradio"
                    aria-checked={device.deviceId === selected}
                    className="flex w-full items-center gap-2 px-3 py-2 rounded-md text-left hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    onClick={() => {
                        void media.selectDevice(kind, device.deviceId);
                        onClose();
                    }}
                >
                    <span className="w-4 text-[#8ab4f8]" aria-hidden="true">
                        {device.deviceId === selected ? "✓" : ""}
                    </span>
                    <span className="truncate">{device.label || `${noun[0].toUpperCase()}${noun.slice(1)} ${index + 1}`}</span>
                </button>
            ))}
            {list.length === 0 && (
                <p className="px-3 py-2 text-white/70">{denied ? `Access to your ${noun} was blocked.` : `No ${noun} found.`}</p>
            )}
            {(list.length === 0 || denied) && (
                <button
                    type="button"
                    role="menuitem"
                    className="w-full px-3 py-2 rounded-md text-left text-[#8ab4f8] hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    onClick={() => {
                        void media.requestAccess(kind);
                        onClose();
                    }}
                >
                    Allow access to {noun}
                </button>
            )}
        </div>
    );
}
