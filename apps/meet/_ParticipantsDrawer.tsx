///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The participants drawer, opened from the header's participant-count chip: a right-side panel listing everyone in
 * the call, "you" first. Display-only for now - the same mic-muted/hand-raised/transport-badge information
 * `_ParticipantTile.tsx` already shows on a tile, as plain rows instead (a list reads better than tiles once
 * there's a reason to scan for one name). Host controls (mute/kick) arrive in a later phase once a "host" identity
 * exists in the client protocol; this phase intentionally shows the same rows to everyone.
 *
 * Closes on Escape, on a click on the backdrop behind it, or its own close button - never on a click inside the
 * drawer itself, matching `_CallControls.tsx`'s menus.
 *
 * A "Host" tag marks the host's own row (`isSelfHost`/`isParticipantHost` - see `_CallView.tsx`'s doc comment on
 * `hostUid` for what that identity is and isn't) - informational only in this phase; the mute/kick buttons that
 * actually use `isSelfHost` to decide who sees them arrive in a later phase.
 */
import React, { useEffect } from "react";
import type { MeshParticipant } from "../shared/webrtc/types.js";
import { TRANSPORT_BADGES } from "./_ParticipantTile.js";
import { MicOffIcon } from "./_icons.js";

export interface ParticipantsDrawerProps {
    selfName: string;
    micOn: boolean;
    handRaised: boolean;
    participants: MeshParticipant[];
    isSelfHost: boolean;
    isParticipantHost: (uid: string) => boolean;
    onClose: () => void;
}

function Row({
    name,
    isSelf,
    isHost,
    micMuted,
    handRaised,
    transport,
}: {
    name: string;
    isSelf?: boolean;
    isHost: boolean;
    micMuted: boolean;
    handRaised: boolean;
    transport?: MeshParticipant["transport"];
}) {
    const badge = transport ? TRANSPORT_BADGES[transport] : undefined;
    return (
        <li className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/5">
            <span className="flex-1 min-w-0 truncate">
                {name}
                {isSelf ? " (you)" : ""}
            </span>
            {isHost && <span className="px-2 py-0.5 rounded text-xs whitespace-nowrap bg-[#a8c7fa] text-[#062e6f]">Host</span>}
            {handRaised && (
                <span role="img" aria-label="Hand raised">
                    ✋
                </span>
            )}
            {micMuted && (
                <span className="w-4 h-4 text-white/70 [&>svg]:w-4 [&>svg]:h-4" role="img" aria-label="Muted">
                    <MicOffIcon />
                </span>
            )}
            {badge && (
                <span
                    className={`px-2 py-0.5 rounded text-xs whitespace-nowrap ${transport === "failed" ? "bg-[#601410] text-[#f9dedc]" : "bg-black/40 text-white"}`}
                    title={badge.title}
                >
                    {badge.label}
                </span>
            )}
        </li>
    );
}

export default function ParticipantsDrawer({ selfName, micOn, handRaised, participants, isSelfHost, isParticipantHost, onClose }: ParticipantsDrawerProps) {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    return (
        <>
            <div className="absolute inset-0 z-20 bg-black/40" onClick={onClose} aria-hidden="true" />
            <aside
                role="dialog"
                aria-label="Participants"
                className="absolute z-20 inset-y-0 right-0 w-72 max-w-[85vw] flex flex-col bg-[#2b2d30] text-white shadow-xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-2 px-3 py-3 border-b border-white/10">
                    <h2 className="text-sm font-medium">Participants ({participants.length + 1})</h2>
                    <button
                        type="button"
                        className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                        aria-label="Close participants"
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </div>
                <ul className="flex-1 min-h-0 overflow-y-auto p-2 text-sm">
                    <Row name={selfName} isSelf isHost={isSelfHost} micMuted={!micOn} handRaised={handRaised} />
                    {participants.map((p) => (
                        <Row
                            key={p.uid}
                            name={p.name}
                            isHost={isParticipantHost(p.uid)}
                            micMuted={!p.audioOn}
                            handRaised={p.handRaised}
                            transport={p.transport}
                        />
                    ))}
                </ul>
            </aside>
        </>
    );
}
