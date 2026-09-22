///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { VideoMeetingDetail, createVideoMeeting, updateVideoMeeting } from "@rapidmx/react-shared/videoconf/videoMeetingsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** The title a freshly created personal room starts with - editable afterward like any other meeting's title. */
export const PERSONAL_ROOM_TITLE = "Personal Meeting Room";

export interface PersonalRoomCardProps {
    mailboxUid: string;
    /** The mailbox's personal room, as `index.tsx`'s `findPersonalRoom()` identified it - `undefined` when the
     * mailbox has none yet. See that function's own doc comment for the "oldest non-cancelled public meeting"
     * convention this plugin uses instead of a dedicated field/route (`.claude/NOTES.md`'s Phase 4 entry). */
    room: VideoMeetingDetail | undefined;
    /** Called with the freshly created room (`createVideoMeeting()`'s own response, reshaped to a
     * `VideoMeetingDetail`) so the parent's meeting list picks it up without a full reload. */
    onCreated: (meeting: VideoMeetingDetail) => void;
    /** Called after a successful rename, so the parent's meeting list (and this card, on its next render) show
     * the new title without a full reload. */
    onRenamed: (uid: string, title: string) => void;
}

/**
 * The "get and manage your own persistent public link" card - see this plugin's `.claude/NOTES.md` Phase 4 entry
 * for why a personal room is simply the mailbox's own oldest non-cancelled `PUBLIC` `VideoMeeting`, not a distinct
 * model concept. Offers to create one when there is none, and otherwise shows its (editable) title and its
 * shareable link, exactly as `create()`/`findById()` compute it server-side.
 */
export default function PersonalRoomCard({ mailboxUid, room, onCreated, onRenamed }: PersonalRoomCardProps) {
    const [titleDraft, setTitleDraft] = useState(room?.title ?? "");
    const [creating, setCreating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset the draft whenever the identified room itself changes (freshly created, or renamed elsewhere) - not
    // on every parent re-render, so an in-progress edit here survives an unrelated state update on the page (e.g.
    // cancelling a different meeting in the list below).
    useEffect(() => {
        setTitleDraft(room?.title ?? "");
    }, [room?.uid, room?.title]);

    async function handleCreate() {
        setCreating(true);
        setError(null);
        try {
            const result = await createVideoMeeting({ mailboxUid, title: PERSONAL_ROOM_TITLE, visibility: "public" });
            onCreated({ ...result.meeting, publicJoinUrl: result.publicJoinUrl });
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create your personal room.");
        } finally {
            setCreating(false);
        }
    }

    async function handleRename(e: FormEvent) {
        e.preventDefault();
        const trimmed = titleDraft.trim();
        if (!room || !trimmed || trimmed === room.title) {
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const updated = await updateVideoMeeting(room.uid, { title: trimmed });
            onRenamed(room.uid, updated.title);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not rename your personal room.");
        } finally {
            setSaving(false);
        }
    }

    async function handleCopy(url: string) {
        try {
            await navigator.clipboard.writeText(url);
            setError(null);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setError("Could not copy the link. Copy it by hand instead.");
        }
    }

    return (
        <section aria-label="Your personal room" className="border border-border rounded-md p-5 mb-6">
            <h2 className="text-sm font-bold">Your personal room</h2>
            <p className="text-sm text-text-muted mb-3">
                A permanent link you can share any time - anyone with it can join, no account needed on their end.
            </p>
            {error && <Alert>{error}</Alert>}
            {!room ? (
                <Button type="button" className="!w-auto" loading={creating} disabled={creating} onClick={handleCreate}>
                    Create my personal room
                </Button>
            ) : (
                <div className="flex flex-col gap-3">
                    <form onSubmit={handleRename} className="flex items-end gap-2">
                        <label className="flex-1 flex flex-col gap-1">
                            <span className="text-xs text-text-muted">Room name</span>
                            <input type="text" className={INPUT_CLASS} value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
                        </label>
                        <Button
                            type="submit"
                            variant="secondary"
                            className="!w-auto shrink-0"
                            loading={saving}
                            disabled={saving || !titleDraft.trim() || titleDraft.trim() === room.title}
                        >
                            Save
                        </Button>
                    </form>
                    {room.publicJoinUrl ? (
                        <div className="flex items-center gap-2">
                            <code className="flex-1 text-xs bg-surface-alt border border-border rounded-sm py-2 px-3 overflow-x-auto whitespace-nowrap">
                                {room.publicJoinUrl}
                            </code>
                            <Button type="button" variant="secondary" className="!w-auto shrink-0" onClick={() => handleCopy(room.publicJoinUrl!)}>
                                {copied ? "Copied" : "Copy"}
                            </Button>
                        </div>
                    ) : (
                        <p className="text-sm text-text-muted">
                            No public join page URL is configured for this deployment yet - ask an administrator to set one in the Video
                            Conferencing plugin&apos;s settings before sharing this room.
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}
