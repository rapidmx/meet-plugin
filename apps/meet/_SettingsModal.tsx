///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The host-only meeting settings modal, opened from the navbar's "…" menu (`_CallView.tsx`) - host-only because
 * `_CallView.tsx` never renders this for anyone else. Holds the settings that used to live in the participants
 * drawer's header: "Mute new participants on join" (`forceMuteOnJoin`), the join password
 * (`hasPassword`/`onSetPassword`), and "Require the host to admit participants" (`waitingRoomEnabled`) - each a
 * setting for whoever joins *next*, not an action on anyone already here (muting someone already in the call is
 * the participants drawer's own "Mute" button; the drawer also keeps the live waiting-room list, since admitting
 * someone is closer to "who's here" than a setting).
 *
 * An ordinary modal, not a docked panel like the drawer or a persistent window like diagnostics: closes on Escape,
 * a click on the backdrop, or its own close button, matching `_CallControls.tsx`'s menus and this app's general
 * "settings is a focused, modal task" convention.
 */
import React, { useEffect, useState } from "react";

export interface SettingsModalProps {
    forceMuteOnJoin: boolean;
    onToggleForceMuteOnJoin: () => void;
    /** Whether this meeting currently requires a password - never the password itself (see
     * `PublicVideoMeeting.hasPassword`'s own doc comment). */
    hasPassword: boolean;
    /** Sets (a non-empty string), replaces, or removes (`null`) the join password. Rejecting lets `PasswordSection`
     * show its own inline error without this modal needing to know anything about it. */
    onSetPassword: (password: string | null) => Promise<void>;
    waitingRoomEnabled: boolean;
    onToggleWaitingRoomEnabled: () => void;
    onClose: () => void;
}

/** The password form: one text input plus a Set/Change button, and a Remove button once one is set. Owns its own
 * input/error/busy state locally - the modal only needs to know whether a password exists, not what a half-typed
 * one currently says. */
function PasswordSection({ hasPassword, onSetPassword }: { hasPassword: boolean; onSetPassword: (password: string | null) => Promise<void> }) {
    const [input, setInput] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(password: string | null) {
        setBusy(true);
        setError(null);
        try {
            await onSetPassword(password);
            setInput("");
        } catch {
            setError("Could not save - try again.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="py-3 border-b border-white/10 text-sm">
            <p className="text-white/70 mb-1.5">{hasPassword ? "Password protection is on." : "No password required to join."}</p>
            <form
                className="flex gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (input) {
                        void submit(input);
                    }
                }}
            >
                <input
                    type="password"
                    aria-label={hasPassword ? "New password" : "Set a password"}
                    placeholder={hasPassword ? "New password" : "Set a password"}
                    className="flex-1 min-w-0 px-2 py-1 rounded bg-white/10 text-white placeholder:text-white/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    disabled={busy}
                />
                <button
                    type="submit"
                    className="px-2 py-1 rounded text-xs whitespace-nowrap bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-50"
                    disabled={busy || !input}
                >
                    {hasPassword ? "Change" : "Set"}
                </button>
            </form>
            {hasPassword && (
                <button
                    type="button"
                    className="mt-1.5 text-xs text-[#f2b8b5] underline focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void submit(null)}
                >
                    Remove password
                </button>
            )}
            {error && <p className="text-[#f2b8b5] text-xs mt-1.5">{error}</p>}
        </div>
    );
}

export default function SettingsModal({
    forceMuteOnJoin,
    onToggleForceMuteOnJoin,
    hasPassword,
    onSetPassword,
    waitingRoomEnabled,
    onToggleWaitingRoomEnabled,
    onClose,
}: SettingsModalProps) {
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
            <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose} aria-hidden="true" />
            <div
                role="dialog"
                aria-label="Meeting settings"
                className="fixed z-30 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 max-w-[calc(100vw-1.5rem)] max-h-[80vh] overflow-y-auto flex flex-col rounded-2xl bg-[#2b2d30] text-white shadow-xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10">
                    <h2 className="text-sm font-medium">Meeting settings</h2>
                    <button
                        type="button"
                        className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                        aria-label="Close meeting settings"
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </div>
                <div className="px-4">
                    <label className="flex items-center gap-2 py-3 border-b border-white/10 text-sm">
                        <input type="checkbox" checked={forceMuteOnJoin} onChange={onToggleForceMuteOnJoin} className="w-4 h-4" />
                        Mute new participants on join
                    </label>
                    <PasswordSection hasPassword={hasPassword} onSetPassword={onSetPassword} />
                    <label className="flex items-center gap-2 py-3 text-sm">
                        <input type="checkbox" checked={waitingRoomEnabled} onChange={onToggleWaitingRoomEnabled} className="w-4 h-4" />
                        Require the host to admit participants
                    </label>
                </div>
            </div>
        </>
    );
}
