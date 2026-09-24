///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The public join/lobby/in-call page, `GET /meet/:token` - resolves an invitee's join token or a public meeting's
 * slug (`BaseVideoMeetingRoute.join()`, both shapes accepted identically - see `_meetApi.ts`), then walks through
 * `loading` -> `lobby` -> `in-call` -> `ended`.
 *
 * ## Session-based name prefill - NOT implemented, and why
 *
 * The spec asks this page to prefill the name field from `Profile.givenName` when the visiting browser already
 * holds a RapidMX session (investigating `@rapidmx/react-shared`'s `profileApi.ts`/`session.ts` was part of this
 * plugin's Phase 2 work). That turned out not to be wireable from here: `profileApi.ts`'s `getMyProfile()` needs
 * an `authServerUrl` to call auth-server (a *different* origin) with, and `session.ts`'s own doc comment confirms
 * `userUid`/`authServerUrl` are supplied only via server-side `fetchProps` on the `www`/admin console hosts
 * (`wwwRoute`/`AdminConsoleRoute` in `@rapidmx/server`) - never on the `public` host this page is mounted on.
 * `PublicPageRoute` (`@rapidmx/server`, this page's actual host route) returns only branding props; it has no
 * concept of the caller's session at all. There is, today, no public-host plugin page anywhere in this codebase
 * that does this, so there was no convention to extend - only two, cross-repo (`@rapidmx/server`/`react-shared`)
 * ways to add one (flagged in this plugin's Phase 2 report rather than built here, both out of this frontend-only
 * phase's scope):
 *
 * 1. Have `PublicPageRoute.fetchProps()` check the incoming `jwt` cookie itself (the way `wwwRoute` already does)
 * and pass `userUid`/`authServerUrl` through like the `www`/admin hosts do.
 * 2. Add a small authenticated "who am I" endpoint on this server's own origin (no `authServerUrl` needed at all),
 * which this page could call with `apiFetch()` the same way any other same-origin authenticated call works.
 *
 * Per the spec, the name field is always left empty and editable instead - correct for the common case (most
 * invitees have no RapidMX account at all), just never prefilled even for a mailbox owner testing their own link.
 */
import React, { useState } from "react";
import useBranding from "@rapidmx/react-shared/branding/useBranding.js";
import { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import { MeetCard, MeetPageShell } from "./_MeetChrome.js";
import { useLocalMedia } from "../shared/media/useLocalMedia.js";
import MeetLobby from "./_MeetLobby.js";
import CallView from "./_CallView.js";
import { type VideoMeetingJoinResult, joinMeeting } from "./_meetApi.js";

type Phase = "loading" | "not-found" | "lobby" | "in-call" | "ended";

export default function MeetJoinPage({ params }: { params: { token: string } }) {
    const { branding } = useBranding();
    return <MeetJoinContent token={params.token} branding={branding} />;
}

/** Owns the camera and microphone (`useLocalMedia()`) for the whole visit, so the tracks the lobby previews are the
 * ones the call sends. Every phase but the call is drawn inside the branded page shell; the call fills the whole
 * window instead (see `_CallView.tsx`). */
function MeetJoinContent({ token, branding }: { token: string; branding: Branding | null }) {
    const [phase, setPhase] = useState<Phase>("loading");
    const [joinResult, setJoinResult] = useState<VideoMeetingJoinResult | null>(null);
    const [name, setName] = useState("");
    const [loadError, setLoadError] = useState<string | null>(null);
    const media = useLocalMedia();
    const { release } = media;

    React.useEffect(() => {
        let cancelled = false;
        joinMeeting(token)
            .then((result) => {
                if (!cancelled) {
                    setJoinResult(result);
                    setPhase("lobby");
                }
            })
            .catch((err) => {
                if (cancelled) {
                    return;
                }
                if (err instanceof ApiRequestError && err.status === 404) {
                    setPhase("not-found");
                    return;
                }
                setLoadError(err instanceof ApiRequestError ? err.message : "Could not load this meeting.");
                setPhase("not-found");
            });
        return () => {
            cancelled = true;
        };
    }, [token]);

    function handleJoin(joinName: string) {
        setName(joinName);
        setPhase("in-call");
    }

    function handleLeave() {
        release();
        setPhase("ended");
    }

    if (phase === "in-call" && joinResult) {
        return (
            <CallView
                channel={joinResult.meeting.uid}
                // `token` is present only for the common anonymous case (`authenticated: false`) - when the
                // caller's own existing session already authenticated them (`authenticated: true`), there is no
                // guest token to apply as a cookie at all, and `GuestSignalingClient` relies entirely on the
                // browser's own already-existing `jwt` session cookie instead (see its own doc comment and
                // `VideoMeetingJoinResult`'s doc comment in `_meetApi.ts`).
                token={joinResult.token}
                selfUid={joinResult.selfUid}
                selfName={name}
                meetingTitle={joinResult.meeting.title}
                iceServers={joinResult.iceServers}
                media={media}
                onLeave={handleLeave}
            />
        );
    }

    let content: React.ReactNode;
    if (phase === "loading") {
        content = (
            <MeetCard>
                <p className="text-base text-text-muted">Loading&hellip;</p>
            </MeetCard>
        );
    } else if (phase === "not-found") {
        content = (
            <MeetCard>
                <Alert>{loadError ?? "This meeting link isn't valid."}</Alert>
            </MeetCard>
        );
    } else if (phase === "ended") {
        content = (
            <MeetCard>
                <h1 className="text-xl font-bold tracking-tight mb-2">You left the meeting</h1>
                <p className="text-base text-text-muted mb-4">You can close this page now, or rejoin.</p>
                <Button type="button" className="!w-auto" onClick={() => setPhase("lobby")}>
                    Rejoin meeting
                </Button>
            </MeetCard>
        );
    } else {
        // phase === "lobby" (joinResult is always set by then - see the effect above).
        content = (
            <MeetCard maxWidth="max-w-4xl">
                <MeetLobby meeting={joinResult!.meeting} media={media} initialName={name} onJoin={handleJoin} />
            </MeetCard>
        );
    }
    return <MeetPageShell branding={branding}>{content}</MeetPageShell>;
}
