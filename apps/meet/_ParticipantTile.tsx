///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** One participant's video tile - used by both the grid and the focused/thumbnail-strip layouts in `_CallView.tsx`.
 * Renders a placeholder (the participant's initial) instead of a `<video>` element whenever there's no stream or
 * their camera is off, rather than showing a black/frozen frame. */
import React, { useEffect, useRef } from "react";

export interface ParticipantTileProps {
    name: string;
    stream?: MediaStream | null;
    /** The local participant's own tile must be `muted` (never plays back its own audio) - a real remote tile
     * never sets this. */
    isLocal?: boolean;
    cameraOff?: boolean;
    micMuted?: boolean;
    /** Highlights this tile as the current presenter/focus. */
    isFocused?: boolean;
    onClick?: () => void;
    className?: string;
}

function initialOf(name: string): string {
    return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

export default function ParticipantTile({ name, stream, isLocal, cameraOff, micMuted, isFocused, onClick, className }: ParticipantTileProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const showVideo = !!stream && !cameraOff;

    useEffect(() => {
        if (videoRef.current) {
            /* v8 ignore next -- unreachable via real usage: the `<video>` element only ever renders at all when
               `showVideo` (`!!stream && !cameraOff`) is true, so `stream` is always truthy whenever `videoRef.current`
               is non-null here; the `?? null` exists purely to satisfy `srcObject`'s type, not for a real code path. */
            videoRef.current.srcObject = stream ?? null;
        }
    }, [stream]);

    return (
        <div
            className={`relative overflow-hidden rounded-md bg-black/80 flex items-center justify-center min-h-[90px] ${
                isFocused ? "ring-2 ring-accent" : ""
            } ${className ?? ""}`}
            onClick={onClick}
            role={onClick ? "button" : undefined}
            tabIndex={onClick ? 0 : undefined}
        >
            {showVideo ? (
                <video ref={videoRef} autoPlay playsInline muted={isLocal} className="w-full h-full object-cover" />
            ) : (
                <div className="w-14 h-14 rounded-full bg-primary text-white flex items-center justify-center text-xl font-bold" aria-hidden="true">
                    {initialOf(name)}
                </div>
            )}
            <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/60 text-white text-xs">
                {micMuted && <span title="Muted">(muted)</span>}
                <span>
                    {name}
                    {isLocal ? " (you)" : ""}
                </span>
            </div>
        </div>
    );
}
