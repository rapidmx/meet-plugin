///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** One participant's video tile - used by the grid, the focused/thumbnail-strip layouts and the local participant's
 * corner tile in `_CallView.tsx`. Renders a placeholder (the participant's initial) instead of a `<video>` element
 * whenever there's no stream or their camera is off, rather than showing a black/frozen frame.
 *
 * A tile never plays sound: its `<video>` is always muted, and what a participant says is played by the call view's
 * own `<audio>` elements (`_CallView.tsx`'s `RemoteAudio`), so a tile that isn't showing video - or isn't on screen
 * in the current layout - can never silence anyone.
 *
 * The local tile is shown mirrored (`scaleX(-1)`), like a real mirror, so a participant's own movements feel
 * natural - this is a local display transform only, never applied to the video actually sent to anyone, so
 * everyone else always sees the participant the right way round. `mirrored={false}` (`_CallView.tsx`, when a custom
 * background image is on) turns that off: the picture the participant chose is a fixed reference, not a live
 * reflection, and mirroring it would show it backwards to no one but themselves. */
import React, { useEffect, useRef } from "react";
import type { MediaTransport } from "../shared/webrtc/types.js";
import { MicOffIcon } from "./_icons.js";

/** What a tile says about how its participant's media is arriving, for the paths that are not the ordinary direct one
 * (which needs no comment). Text rather than only an icon, so the reason a picture is degraded is never a guess.
 * Exported so `_DiagnosticsPanel.tsx` shows the identical label/title rather than describing the same paths in
 * slightly different words. */
export const TRANSPORT_BADGES: Partial<Record<MediaTransport, { label: string; title: string }>> = {
    turn: { label: "Relayed", title: "Connected through the relay server, because a direct connection was not possible." },
    "turn-tcp": {
        label: "Relayed (TCP)",
        title:
            "Connected through the relay server over TCP, because this network blocks the relay's usual UDP connection too. " +
            "Audio or video may pause briefly under network strain rather than just glitching - a property of TCP, not a dropped connection.",
    },
    websocket: {
        label: "Server relay",
        title: "Sent through the server as a last resort, because no other connection was possible. Video is lower quality and sound may lag.",
    },
    failed: { label: "Can't connect", title: "This participant could not be reached from your network." },
};

/** A short line saying the connection is still being made, with a spinner - a polite live region (not `role="status"`,
 * which the call view's own announcement region already is), so a participant who cannot see the tile still learns
 * why nothing is happening yet. */
function StatusPill({ status, className }: { status: string; className?: string }) {
    return (
        <span
            aria-live="polite"
            data-testid="tile-status"
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 text-white text-xs ${className ?? ""}`}
        >
            <span className="inline-block w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" aria-hidden="true" />
            {status}
        </span>
    );
}

export interface ParticipantTileProps {
    name: string;
    stream?: MediaStream | null;
    isLocal?: boolean;
    /** Shows the initial instead of the video. */
    cameraOff?: boolean;
    micMuted?: boolean;
    handRaised?: boolean;
    /** How this participant's media reaches you - a badge is shown for everything but a direct or still-connecting one. */
    transport?: MediaTransport;
    /** Says the connection is still being made, e.g. "Connecting..." on the local tile and "Awaiting connection..." on a
     * participant's - shown with a spinner until the caller clears it. */
    status?: string;
    /** Highlights this tile as the current presenter/focus. */
    isFocused?: boolean;
    /** Fits the whole picture inside the tile instead of filling it - a shared screen must not be cropped. */
    contain?: boolean;
    /** Whether the local tile is shown mirrored, like a real mirror - ignored for a remote tile, which is never
     * mirrored. Default `true`; see this module's doc comment. */
    mirrored?: boolean;
    onClick?: () => void;
    className?: string;
}

function initialOf(name: string): string {
    return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

export default function ParticipantTile({
    name,
    stream,
    isLocal,
    cameraOff,
    micMuted,
    handRaised,
    transport,
    status,
    isFocused,
    contain,
    mirrored = true,
    onClick,
    className,
}: ParticipantTileProps) {
    const badge = transport ? TRANSPORT_BADGES[transport] : undefined;
    const videoRef = useRef<HTMLVideoElement>(null);
    const showVideo = !!stream && !cameraOff;

    // The `<video>` element only exists while `showVideo`, so its stream is bound whenever it (re)appears too.
    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.srcObject = stream ?? null;
        }
    }, [stream, showVideo]);

    return (
        <div
            className={`relative overflow-hidden rounded-xl bg-[#3c4043] flex items-center justify-center min-h-[90px] ${
                isFocused ? "ring-2 ring-[#8ab4f8]" : ""
            } ${className ?? ""}`}
            onClick={onClick}
            role={onClick ? "button" : undefined}
            tabIndex={onClick ? 0 : undefined}
            aria-label={onClick ? `${name}${isLocal ? " (you)" : ""}` : undefined}
        >
            {showVideo ? (
                <>
                    <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className={`w-full h-full ${contain ? "object-contain bg-black" : "object-cover"} ${isLocal && !contain && mirrored ? "[transform:scaleX(-1)]" : ""}`}
                    />
                    {status && <StatusPill status={status} className="absolute top-2 left-1/2 -translate-x-1/2 whitespace-nowrap" />}
                </>
            ) : (
                <div className="flex flex-col items-center gap-2 max-w-full px-1">
                    <div className="w-16 h-16 rounded-full bg-primary text-white flex items-center justify-center text-2xl font-bold" aria-hidden="true">
                        {initialOf(name)}
                    </div>
                    {status && <StatusPill status={status} />}
                </div>
            )}
            {handRaised && (
                <span className="absolute top-2 left-2 flex items-center justify-center w-8 h-8 rounded-full bg-[#a8c7fa] text-base" role="img" aria-label="Hand raised">
                    ✋
                </span>
            )}
            {micMuted && (
                <span className="absolute top-2 right-2 flex items-center justify-center w-7 h-7 rounded-full bg-black/60 text-white" role="img" aria-label="Muted">
                    <span className="w-4 h-4 [&>svg]:w-4 [&>svg]:h-4">
                        <MicOffIcon />
                    </span>
                </span>
            )}
            {badge && (
                <span
                    className={`absolute bottom-2 right-2 px-2 py-0.5 rounded text-xs ${
                        transport === "failed" ? "bg-[#601410] text-[#f9dedc]" : "bg-black/60 text-white"
                    }`}
                    title={badge.title}
                    data-testid="transport-badge"
                >
                    {badge.label}
                </span>
            )}
            <div className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate px-2 py-0.5 rounded bg-black/60 text-white text-sm">
                {name}
                {isLocal ? " (you)" : ""}
            </div>
        </div>
    );
}
