///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The in-call control bar, fixed to the bottom of the call (`_CallView.tsx` lays it out below the tiles, never over
 * them). Its menus open upward, centered on the whole bar on a phone (where the bar wraps onto two rows and a menu
 * hung from its own button would run off the edge) and from their own button on a wider window: microphone and camera (each a mute/unmute or on/off button next to a menu that picks the device), share
 * screen, reactions, raise hand, grid/focus and leave. The effects button opens the video filter picker
 * (`_EffectsPanel.tsx`) and lights up while any filter is on.
 *
 * The microphone button shows a live level while it is unmuted - bars that move with the sound the microphone is
 * picking up, so a participant can see their audio is being sent - and the camera button shows a green dot while a
 * camera is sending. Both are driven by `LocalMedia` (`apps/shared/media/useLocalMedia.ts`). The microphone button
 * is disabled (`micLocked`) while talking-stick mode is on and this participant isn't the current holder - see
 * `_CallView.tsx`'s doc comment.
 *
 * ## The "…" menu
 *
 * Sits between the grid/focus toggle and Leave, a catch-all for controls that don't need a dedicated button of
 * their own: "Diagnostics" (`onOpenDiagnostics`) and "Settings" (`onOpenSettings`, host-only) each open their own
 * persistent window/modal in `_CallView.tsx` and close this menu; "Connection method" is a four-way
 * `menuitemradio` group (`TransportMode` - see `MeshConnectionManager.setTransportMode()`'s own doc comment)
 * forcing how *this tab's* media reaches everyone else, independent of what anyone else has chosen; "Hide self"/
 * "Show self" (`selfHidden`/`onToggleSelfHidden`) is the only way to bring the local tile back once hidden from
 * grid view, where there's no tile left to offer its own "show" control - see `_CallView.tsx`'s doc comment on
 * where the local tile appears. Otherwise an ordinary menu of this bar's own shape (`openMenu`, closes on
 * Escape/outside click like every other one here).
 */
import React, { useEffect, useRef, useState } from "react";
import { filtersActive } from "../shared/media/filters/filterTypes.js";
import type { ScreenTransformState } from "../shared/media/filters/ScreenTransform.js";
import type { LocalMedia, MediaKind } from "../shared/media/useLocalMedia.js";
import { REACTION_EMOJIS, type MeshParticipant, type TransportMode } from "../shared/webrtc/types.js";
import EffectsPanel from "./_EffectsPanel.js";
import {
    ChevronUpIcon,
    EffectsIcon,
    EmojiIcon,
    FlipIcon,
    FocusIcon,
    GridIcon,
    HandIcon,
    LeaveIcon,
    MicIcon,
    MicOffIcon,
    OverflowIcon,
    RotateIcon,
    ScreenShareIcon,
    VideoIcon,
    VideoOffIcon,
} from "./_icons.js";

/** The "…" menu's "Connection method" options, in display order - see `TransportMode`'s own doc comment. */
const TRANSPORT_MODE_OPTIONS: { mode: TransportMode; label: string }[] = [
    { mode: "auto", label: "Auto" },
    { mode: "p2p", label: "P2P" },
    { mode: "relay", label: "Relay" },
    { mode: "websocket", label: "WebSocket Relay" },
];

export type CallViewMode = "grid" | "focus";

export interface CallControlsProps {
    media: LocalMedia;
    participants: MeshParticipant[];
    isPresenting: boolean;
    /** Someone else is presenting - the share button is disabled and explains why. */
    presentingElsewhereName?: string;
    onToggleShare: () => void;
    /** The current presenter's own rotate/flip correction - shown (and changeable) only while `isPresenting`. */
    screenTransform: ScreenTransformState;
    onRotateScreen: () => void;
    onFlipScreen: () => void;
    handRaised: boolean;
    onToggleHand: () => void;
    onReaction: (emoji: string) => void;
    viewMode: CallViewMode;
    /** Disabled while alone (`participants.length === 0`) - with nobody else here, grid and focused view both just
     * show the local tile filling the stage, so there is nothing for this to visibly toggle yet. Enabled from the
     * very first other participant: focus view corners the local tile and gives the other participant the main
     * slot, which already looks different from grid view's two equal-sized tiles - see `_CallView.tsx`'s doc
     * comment on where the local tile appears. */
    onToggleViewMode: () => void;
    /** True while talking-stick mode is on and this participant doesn't currently hold it - see `_CallView.tsx`'s
     * doc comment on talking-stick mode. Disables the microphone toggle (not the device-picker chevron, which
     * doesn't change whether anyone can hear them) rather than merely nudging it, unlike a `mute-request`. */
    micLocked?: boolean;
    /** Whether the "…" menu's "Settings" item is offered at all - see this module's doc comment on the menu. */
    isHost: boolean;
    transportMode: TransportMode;
    onSetTransportMode: (mode: TransportMode) => void;
    onOpenDiagnostics: () => void;
    onOpenSettings: () => void;
    /** Whether the local tile is currently hidden - the "…" menu's "Hide self"/"Show self" item reflects and
     * toggles this; see `_CallView.tsx`'s doc comment on where the local tile appears. */
    selfHidden: boolean;
    onToggleSelfHidden: () => void;
    onLeave: () => void;
}

type OpenMenu = MediaKind | "emoji" | "effects" | "overflow" | null;

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
    participants,
    isPresenting,
    presentingElsewhereName,
    onToggleShare,
    screenTransform,
    onRotateScreen,
    onFlipScreen,
    handRaised,
    onToggleHand,
    onReaction,
    viewMode,
    onToggleViewMode,
    micLocked,
    isHost,
    transportMode,
    onSetTransportMode,
    onOpenDiagnostics,
    onOpenSettings,
    selfHidden,
    onToggleSelfHidden,
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
                    className={`${BUTTON} min-w-14 gap-1.5 px-3 rounded-l-none ${media.micOn ? NEUTRAL : ALERT} disabled:opacity-50 disabled:cursor-not-allowed`}
                    aria-label={media.micOn ? "Mute microphone" : "Unmute microphone"}
                    aria-pressed={!media.micOn}
                    disabled={micLocked}
                    title={micLocked ? "Only the current talking-stick holder can unmute." : undefined}
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

            <div className="sm:relative">
                <button
                    type="button"
                    className={`${BUTTON} w-12 ${filtersActive(media.filters) ? ACTIVE : NEUTRAL}`}
                    aria-label="Video effects"
                    aria-haspopup="dialog"
                    aria-expanded={openMenu === "effects"}
                    onClick={() => toggleMenu("effects")}
                >
                    <EffectsIcon />
                </button>
                {openMenu === "effects" && (
                    <div
                        role="dialog"
                        aria-label="Video effects"
                        className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 w-96 max-w-[calc(100vw-1rem)] max-h-[60vh] overflow-y-auto p-3 rounded-2xl bg-[#2b2d30] text-white shadow-xl"
                    >
                        <EffectsPanel media={media} tone="dark" />
                    </div>
                )}
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

            {isPresenting && (
                <>
                    <button
                        type="button"
                        className={`${BUTTON} w-12 ${NEUTRAL}`}
                        aria-label="Rotate shared screen"
                        title="If your shared window looks sideways or upside down to everyone, rotate it here - this is a correction for your own capture, not a browser bug this app can fix automatically."
                        onClick={onRotateScreen}
                    >
                        <RotateIcon />
                    </button>
                    <button
                        type="button"
                        className={`${BUTTON} w-12 ${screenTransform.flipped ? ACTIVE : NEUTRAL}`}
                        aria-label={screenTransform.flipped ? "Unflip shared screen" : "Flip shared screen"}
                        aria-pressed={screenTransform.flipped}
                        onClick={onFlipScreen}
                    >
                        <FlipIcon />
                    </button>
                </>
            )}

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
                className={`${BUTTON} w-12 ${NEUTRAL} disabled:opacity-40 disabled:cursor-not-allowed`}
                aria-label={viewMode === "grid" ? "Switch to focused view" : "Switch to grid view"}
                disabled={participants.length === 0}
                title={participants.length === 0 ? "Grid and focused view look the same while you're alone." : undefined}
                onClick={onToggleViewMode}
            >
                {viewMode === "grid" ? <FocusIcon /> : <GridIcon />}
            </button>

            <div className="sm:relative">
                <button
                    type="button"
                    className={`${BUTTON} w-12 ${openMenu === "overflow" ? ACTIVE : NEUTRAL}`}
                    aria-label="More options"
                    aria-haspopup="menu"
                    aria-expanded={openMenu === "overflow"}
                    onClick={() => toggleMenu("overflow")}
                >
                    <OverflowIcon />
                </button>
                {openMenu === "overflow" && (
                    <div
                        role="menu"
                        aria-label="More options"
                        className="absolute bottom-full mb-3 right-0 w-56 max-w-[calc(100vw-1rem)] rounded-2xl bg-[#2b2d30] text-white shadow-xl py-1 text-sm"
                    >
                        <button
                            type="button"
                            role="menuitem"
                            className="w-full px-3 py-2 text-left hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                            onClick={() => {
                                onOpenDiagnostics();
                                setOpenMenu(null);
                            }}
                        >
                            Diagnostics
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            className="w-full px-3 py-2 text-left hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                            onClick={() => {
                                onToggleSelfHidden();
                                setOpenMenu(null);
                            }}
                        >
                            {selfHidden ? "Show self" : "Hide self"}
                        </button>
                        <div className="my-1 border-t border-white/10" />
                        <p className="px-3 pt-1 pb-0.5 text-xs font-semibold uppercase tracking-wide text-white/60">Connection method</p>
                        {TRANSPORT_MODE_OPTIONS.map(({ mode, label }) => (
                            <button
                                key={mode}
                                type="button"
                                role="menuitemradio"
                                aria-checked={transportMode === mode}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                                onClick={() => {
                                    onSetTransportMode(mode);
                                    setOpenMenu(null);
                                }}
                            >
                                <span className="w-4 text-[#8ab4f8]" aria-hidden="true">
                                    {transportMode === mode ? "✓" : ""}
                                </span>
                                {label}
                            </button>
                        ))}
                        {isHost && (
                            <>
                                <div className="my-1 border-t border-white/10" />
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="w-full px-3 py-2 text-left hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                                    onClick={() => {
                                        onOpenSettings();
                                        setOpenMenu(null);
                                    }}
                                >
                                    Settings
                                </button>
                            </>
                        )}
                    </div>
                )}
            </div>

            <button type="button" className={`${BUTTON} w-16 bg-[#d93025] text-white hover:bg-[#b3261e]`} aria-label="Leave call" onClick={() => onLeave()}>
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
