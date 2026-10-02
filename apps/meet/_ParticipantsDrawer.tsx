///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The participants drawer, opened from the header's participant-count chip: a right-side panel listing everyone in
 * the call, "you" first. The same mic-muted/hand-raised/transport-badge information `_ParticipantTile.tsx` already
 * shows on a tile, as plain rows instead (a list reads better than tiles once there's a reason to scan for one
 * name).
 *
 * A docked sidebar, not an overlay: `_CallView.tsx` renders it as an ordinary flex sibling of the call's own
 * content column, which shrinks to make room rather than being covered by a backdrop - meant to stay open and
 * visible for as long as the participant wants, including while the call continues underneath. Closes on Escape or
 * its own close button; there is no backdrop to click, on purpose.
 *
 * A "Host" tag marks the host's own row (`isSelfHost`/`isParticipantHost` - see `_CallView.tsx`'s doc comment on
 * `hostUid` for what that identity is and isn't). Only while `isSelfHost` does every *other* row also get a "Mute"
 * button (hidden once that participant is already muted - there is no useful "unmute someone else" action to
 * offer) and a "Remove" button (a native `confirm()` first, since removal can't be undone by the participant the
 * way a mute request can) - never on the local participant's own row, and never shown to anyone but the host.
 *
 * The header also gets a host-only "who's waiting" list (`waitingParticipants`/`onAdmit`/`onDeny`), shown whenever
 * `waitingRoomEnabled` is on - `_CallView.tsx` polls the list while this drawer is open and the caller is the host
 * (there is no push signal for a newly filed admission request), so it stays current without the host needing to
 * close and reopen the drawer. The waiting-room toggle itself, along with "mute new participants on join" and the
 * join password, lives in `_SettingsModal.tsx` instead (opened from the navbar's "…" menu) - this drawer only
 * reads `waitingRoomEnabled` to decide whether the list has anywhere to come from, it doesn't set it.
 *
 * While talking-stick mode is on (`talkingStickActive`), every row - including the host's own - shows a "Give
 * stick" button, host-only, hidden on whichever row currently holds it (`talkingStickHolder`); everyone (not just
 * the host) sees a badge on that row instead, same visibility as the "Host" tag. See `_CallView.tsx`'s doc comment
 * on talking-stick mode for what granting it actually does to the recipient's microphone.
 */
import React, { useEffect } from "react";
import type { MeshParticipant } from "../shared/webrtc/types.js";
import type { WaitingParticipant } from "./_meetApi.js";
import { TRANSPORT_BADGES } from "./_ParticipantTile.js";
import { MicOffIcon } from "./_icons.js";

export interface ParticipantsDrawerProps {
    selfName: string;
    micOn: boolean;
    handRaised: boolean;
    participants: MeshParticipant[];
    isSelfHost: boolean;
    isParticipantHost: (uid: string) => boolean;
    /** Sends a mute request to the given participant's `uid` - a no-op from the recipient's end if they're already
     * muted (see `Row`'s own "already muted" guard, which never even shows the button then). */
    onMute: (uid: string) => void;
    /** Removes the given participant's `uid` - see `_CallView.tsx`'s `handleKickParticipant()` for what this
     * actually does (the cooperative signal plus the enforced server-side revoke). */
    onKick: (uid: string) => void;
    /** Whether the meeting currently requires the host to admit each participant - read-only here, set from
     * `_SettingsModal.tsx` instead; this drawer only uses it to decide whether the waiting list has anywhere to
     * come from. */
    waitingRoomEnabled: boolean;
    /** Everyone currently waiting to be admitted - `_CallView.tsx`'s own polled, always-current list; empty
     * whenever this drawer isn't open and host, by construction. */
    waitingParticipants: WaitingParticipant[];
    onAdmit: (uid: string) => void;
    onDeny: (uid: string) => void;
    /** Whether talking-stick mode is currently on - the host-only navbar toggle's own state (see `_CallView.tsx`'s
     * doc comment on talking-stick mode). */
    talkingStickActive: boolean;
    /** This tab's own peer id - needed only so the self row's "Give stick" button can name itself when the host
     * wants to take the stick back. */
    selfPeerId: string;
    /** Whichever peer id (`selfPeerId`, or a participant's `MeshParticipant.uid`) currently holds the stick;
     * undefined while `talkingStickActive` is `false`, or (transiently) once its holder has left the call. */
    talkingStickHolder?: string;
    /** Hands the stick to `uid` - host-only, see `_CallView.tsx`'s `handleGiveTalkingStick()`. */
    onGiveTalkingStick: (uid: string) => void;
    onClose: () => void;
}

/** The host-only "who's waiting" list - shown only while `waitingRoomEnabled` is on, since there is otherwise never
 * anyone to list. Says so explicitly when the list is empty, rather than rendering nothing (silence here would be
 * indistinguishable from the list just not having loaded yet). */
function WaitingSection({
    waitingParticipants,
    onAdmit,
    onDeny,
}: {
    waitingParticipants: WaitingParticipant[];
    onAdmit: (uid: string) => void;
    onDeny: (uid: string) => void;
}) {
    return (
        <div className="px-3 py-2 border-b border-white/10 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/60 mb-1.5">Waiting to join</p>
            {waitingParticipants.length === 0 ? (
                <p className="text-white/70">Nobody is waiting right now.</p>
            ) : (
                <ul>
                    {waitingParticipants.map((p) => (
                        <li key={p.uid} className="flex items-center gap-2 py-1">
                            <span className="flex-1 min-w-0 truncate">{p.name}</span>
                            <button
                                type="button"
                                className="px-2 py-0.5 rounded text-xs whitespace-nowrap bg-[#a8c7fa] text-[#062e6f] hover:bg-[#8ab4f8] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                                aria-label={`Admit ${p.name}`}
                                onClick={() => onAdmit(p.uid)}
                            >
                                Admit
                            </button>
                            <button
                                type="button"
                                className="px-2 py-0.5 rounded text-xs whitespace-nowrap bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                                aria-label={`Deny ${p.name}`}
                                onClick={() => onDeny(p.uid)}
                            >
                                Deny
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function Row({
    name,
    isSelf,
    isHost,
    micMuted,
    handRaised,
    transport,
    canModerate,
    onMute,
    onKick,
    hasStick,
    canGiveStick,
    onGiveStick,
}: {
    name: string;
    isSelf?: boolean;
    isHost: boolean;
    micMuted: boolean;
    handRaised: boolean;
    transport?: MeshParticipant["transport"];
    /** Whether to show this row's Mute/Remove buttons - `isSelfHost && !isSelf`, decided by the caller. */
    canModerate?: boolean;
    onMute?: () => void;
    onKick?: () => void;
    /** Whether this row currently holds the talking stick - shown to every viewer, not just the host. */
    hasStick?: boolean;
    /** Whether to show this row's "Give stick" button - `isSelfHost && talkingStickActive`, decided by the caller;
     * never shown on the row that already holds it. */
    canGiveStick?: boolean;
    onGiveStick?: () => void;
}) {
    const badge = transport ? TRANSPORT_BADGES[transport] : undefined;
    return (
        <li className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/5">
            <span className="flex-1 min-w-0 truncate">
                {name}
                {isSelf ? " (you)" : ""}
            </span>
            {isHost && <span className="px-2 py-0.5 rounded text-xs whitespace-nowrap bg-[#a8c7fa] text-[#062e6f]">Host</span>}
            {hasStick && (
                <span className="px-2 py-0.5 rounded text-xs whitespace-nowrap bg-[#a8c7fa] text-[#062e6f]" role="img" aria-label="Holding the talking stick">
                    🎙️
                </span>
            )}
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
            {canGiveStick && !hasStick && (
                <button
                    type="button"
                    className="px-2 py-0.5 rounded text-xs whitespace-nowrap bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    aria-label={`Give the talking stick to ${name}`}
                    onClick={onGiveStick}
                >
                    Give stick
                </button>
            )}
            {canModerate && !micMuted && (
                <button
                    type="button"
                    className="px-2 py-0.5 rounded text-xs whitespace-nowrap bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    aria-label={`Mute ${name}`}
                    onClick={onMute}
                >
                    Mute
                </button>
            )}
            {canModerate && (
                <button
                    type="button"
                    className="px-2 py-0.5 rounded text-xs whitespace-nowrap bg-[#601410] text-[#f9dedc] hover:bg-[#7a1b16] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    aria-label={`Remove ${name}`}
                    onClick={() => {
                        if (window.confirm(`Remove ${name} from the call?`)) {
                            onKick?.();
                        }
                    }}
                >
                    Remove
                </button>
            )}
        </li>
    );
}

export default function ParticipantsDrawer({
    selfName,
    micOn,
    handRaised,
    participants,
    isSelfHost,
    isParticipantHost,
    onMute,
    onKick,
    waitingRoomEnabled,
    waitingParticipants,
    onAdmit,
    onDeny,
    talkingStickActive,
    selfPeerId,
    talkingStickHolder,
    onGiveTalkingStick,
    onClose,
}: ParticipantsDrawerProps) {
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
        <aside
            role="dialog"
            aria-label="Participants"
            className="relative z-10 shrink-0 w-72 max-w-[85vw] h-full flex flex-col bg-[#2b2d30] text-white shadow-xl border-l border-white/10"
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
            {isSelfHost && waitingRoomEnabled && (
                <WaitingSection waitingParticipants={waitingParticipants} onAdmit={onAdmit} onDeny={onDeny} />
            )}
            <ul className="flex-1 min-h-0 overflow-y-auto p-2 text-sm">
                <Row
                    name={selfName}
                    isSelf
                    isHost={isSelfHost}
                    micMuted={!micOn}
                    handRaised={handRaised}
                    hasStick={talkingStickActive && talkingStickHolder === selfPeerId}
                    canGiveStick={isSelfHost && talkingStickActive}
                    onGiveStick={() => onGiveTalkingStick(selfPeerId)}
                />
                {participants.map((p) => (
                    <Row
                        key={p.uid}
                        name={p.name}
                        isHost={isParticipantHost(p.uid)}
                        micMuted={!p.audioOn}
                        handRaised={p.handRaised}
                        transport={p.transport}
                        canModerate={isSelfHost}
                        onMute={() => onMute(p.uid)}
                        onKick={() => onKick(p.uid)}
                        hasStick={talkingStickActive && talkingStickHolder === p.uid}
                        canGiveStick={isSelfHost && talkingStickActive}
                        onGiveStick={() => onGiveTalkingStick(p.uid)}
                    />
                ))}
            </ul>
        </aside>
    );
}
