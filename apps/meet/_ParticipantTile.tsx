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
 * in the current layout - can never silence anyone. */
import React, { useEffect, useRef } from "react";
import { MicOffIcon } from "./_icons.js";

export interface ParticipantTileProps {
    name: string;
    stream?: MediaStream | null;
    isLocal?: boolean;
    /** Shows the initial instead of the video. */
    cameraOff?: boolean;
    micMuted?: boolean;
    handRaised?: boolean;
    /** Highlights this tile as the current presenter/focus. */
    isFocused?: boolean;
    /** Fits the whole picture inside the tile instead of filling it - a shared screen must not be cropped. */
    contain?: boolean;
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
    isFocused,
    contain,
    onClick,
    className,
}: ParticipantTileProps) {
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
                <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full ${contain ? "object-contain bg-black" : "object-cover"} ${isLocal && !contain ? "[transform:scaleX(-1)]" : ""}`}
                />
            ) : (
                <div className="w-16 h-16 rounded-full bg-primary text-white flex items-center justify-center text-2xl font-bold" aria-hidden="true">
                    {initialOf(name)}
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
            <div className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate px-2 py-0.5 rounded bg-black/60 text-white text-sm">
                {name}
                {isLocal ? " (you)" : ""}
            </div>
        </div>
    );
}
