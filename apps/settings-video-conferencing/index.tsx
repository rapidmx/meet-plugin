///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { VideoMeetingDetail, listVideoMeetings, updateVideoMeeting } from "@rapidmx/react-shared/videoconf/videoMeetingsApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "@rapidmx/web-client/shared/components/settings/layout/SettingsShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import PersonalRoomCard from "./_PersonalRoomCard.js";

/** However many of a mailbox's meetings this page ever needs to see at once - generous enough that a real user's
 * whole history fits in one request (this is a personal settings page, not a paged archive), matching
 * `SettingsShell`'s own `listMailboxes({ limit: 100 })` precedent for "large enough not to page in practice". */
const LIST_LIMIT = 200;

const STATUS_LABELS: Record<string, string> = {
    scheduled: "Scheduled",
    active: "In progress",
    ended: "Ended",
    cancelled: "Cancelled",
};

export type SettingsVideoConferencingPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsVideoConferencingPage(props: SettingsVideoConferencingPageProps) {
    return (
        <SettingsShell {...props} active="video-conferencing">
            <VideoConferencingSettingsContent />
        </SettingsShell>
    );
}

/**
 * Picks a mailbox's "personal room" out of `listVideoMeetings()`'s results: the oldest still-active (non-cancelled)
 * `PUBLIC` meeting. `BaseVideoMeetingRoute` has no field or route naming a "personal room" as a concept distinct
 * from any other public meeting a mailbox happens to have - a public meeting IS just a `VideoMeeting` with
 * `visibility: "public"` (see this plugin's `.claude/NOTES.md` Phase 4 entry for the full reasoning behind this
 * convention, and why no backend addition was needed to support it). Oldest-first keeps the identification stable
 * across reloads, regardless of when in the list a later public meeting (created some other way, e.g. directly
 * through the API) happens to land; skipping a cancelled one means cancelling today's room and creating a new one
 * always finds the fresh one on the next load, never a dead link.
 */
export function findPersonalRoom(meetings: VideoMeetingDetail[]): VideoMeetingDetail | undefined {
    return meetings
        .filter((m) => m.visibility === "public" && m.status !== "cancelled")
        .sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime())[0];
}

function VideoConferencingSettingsContent() {
    const { mailboxUid } = useSettingsShell();
    const [meetings, setMeetings] = useState<VideoMeetingDetail[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [copiedUid, setCopiedUid] = useState<string | null>(null);
    const [cancellingUid, setCancellingUid] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    // `SettingsShell` only ever renders its children once `mailboxUid` has resolved - same established non-null
    // pattern as `booking-plugin`'s own settings pages.
    useEffect(() => {
        setLoading(true);
        setLoadError(null);
        listVideoMeetings(mailboxUid!, { limit: LIST_LIMIT })
            .then(setMeetings)
            .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load your video meetings."))
            .finally(() => setLoading(false));
    }, [mailboxUid]);

    const personalRoom = findPersonalRoom(meetings);
    // Every other meeting worth showing here: any other public meeting, or a private one with a linked calendar
    // event (the calendar compose hook's own meetings - Phase 3). A private, calendar-less meeting is an artifact
    // of this plugin's own API used directly (e.g. testing), not something a real user created through this page
    // or a calendar invite, so it's left out. The personal room itself is surfaced above instead of repeated here.
    const otherMeetings = meetings
        .filter((m) => m.uid !== personalRoom?.uid && (m.visibility === "public" || !!m.calendarEventUid))
        .sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());

    async function handleCopy(url: string, uid: string) {
        try {
            await navigator.clipboard.writeText(url);
            setActionError(null);
            setCopiedUid(uid);
            setTimeout(() => setCopiedUid((current) => (current === uid ? null : current)), 2000);
        } catch {
            setActionError("Could not copy the link. Copy it by hand instead.");
        }
    }

    async function handleCancel(uid: string) {
        setCancellingUid(uid);
        setActionError(null);
        try {
            const updated = await updateVideoMeeting(uid, { status: "cancelled" });
            setMeetings((current) => current.map((m) => (m.uid === uid ? { ...m, status: updated.status } : m)));
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not cancel this meeting.");
        } finally {
            setCancellingUid(null);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-4xl">
                <h1 className="text-lg font-bold tracking-tight mb-1">Video Conferencing</h1>
                <p className="text-sm text-text-muted mb-5">
                    Your personal meeting room, and every video meeting created for you - from a calendar invite or directly here.
                </p>

                {loadError && <Alert>{loadError}</Alert>}
                {actionError && <Alert>{actionError}</Alert>}

                {loading ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : (
                    <>
                        <PersonalRoomCard
                            mailboxUid={mailboxUid!}
                            room={personalRoom}
                            onCreated={(meeting) => setMeetings((current) => [meeting, ...current])}
                            onRenamed={(uid, title) => setMeetings((current) => current.map((m) => (m.uid === uid ? { ...m, title } : m)))}
                        />

                        <h2 className="text-sm font-bold mb-2">Meetings</h2>
                        {otherMeetings.length === 0 ? (
                            <p className="text-sm text-text-muted">No other meetings yet.</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm border-collapse">
                                    <thead>
                                        <tr>
                                            {["Title", "Visibility", "Status", "Created", ""].map((h) => (
                                                <th
                                                    key={h}
                                                    className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                                >
                                                    {h}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {otherMeetings.map((meeting) => (
                                            <tr key={meeting.uid}>
                                                <td className="py-2.5 px-2.5 border-b border-border">{meeting.title}</td>
                                                <td className="py-2.5 px-2.5 border-b border-border capitalize">{meeting.visibility}</td>
                                                <td className="py-2.5 px-2.5 border-b border-border">
                                                    {/* v8 ignore next -- unreachable via real usage: `VideoMeetingStatus` has exactly the four keys
                                                        `STATUS_LABELS` defines, and response bodies are typed but not runtime-validated (see
                                                        `videoMeetingsApi.ts`'s own doc comment) - the fallback exists only for forward compatibility
                                                        with a status value this build doesn't know about yet. */}
                                                    {STATUS_LABELS[meeting.status] ?? meeting.status}
                                                </td>
                                                <td className="py-2.5 px-2.5 border-b border-border whitespace-nowrap">
                                                    {new Date(meeting.dateCreated).toLocaleString()}
                                                </td>
                                                <td className="py-2.5 px-2.5 border-b border-border text-right whitespace-nowrap">
                                                    {meeting.visibility === "public" && meeting.publicJoinUrl && (
                                                        <button
                                                            type="button"
                                                            aria-label={`Copy link to ${meeting.title}`}
                                                            className="text-primary-dark hover:underline font-medium mr-4"
                                                            onClick={() => handleCopy(meeting.publicJoinUrl!, meeting.uid)}
                                                        >
                                                            {copiedUid === meeting.uid ? "Copied" : "Copy link"}
                                                        </button>
                                                    )}
                                                    {meeting.status === "scheduled" && (
                                                        <button
                                                            type="button"
                                                            aria-label={`Cancel ${meeting.title}`}
                                                            className="text-danger hover:underline font-medium disabled:opacity-55"
                                                            disabled={cancellingUid === meeting.uid}
                                                            onClick={() => handleCancel(meeting.uid)}
                                                        >
                                                            {cancellingUid === meeting.uid ? "Cancelling…" : "Cancel"}
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
