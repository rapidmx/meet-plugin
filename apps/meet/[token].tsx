///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The public join/lobby/in-call page, `GET /meet/:token` - resolves an invitee's join token or a public meeting's
 * slug (`BaseVideoMeetingRoute.join()`, both shapes accepted identically - see `_meetApi.ts`), then walks through
 * `loading` -> (`password`, only when a password is required) -> (`admission-request` then `waiting`, only when
 * the meeting has a waiting room - see that phase's own render branch) -> `lobby` -> `in-call` -> `ended`. A
 * waiting room takes over the entire gate (asking for a password too, on the same form) rather than stacking
 * after a separate password screen - see `BaseVideoMeetingRoute.join()`'s own doc comment for why.
 *
 * ## Session-based name prefill - NOT implemented, and why
 *
 * The spec asks this page to prefill the name field from `Profile.givenName` when the visiting browser already
 * holds a RapidMX session (investigating `@rapidmx/web-client`'s `lib/profileApi.ts`/`lib/session.ts` was part of
 * this plugin's Phase 2 work). That turned out not to be wireable from here: `profileApi.ts`'s `getMyProfile()` needs
 * an `authServerUrl` to call auth-server (a *different* origin) with, and `session.ts`'s own doc comment confirms
 * `userUid`/`authServerUrl` are supplied only via server-side `fetchProps` on the `www`/admin console hosts
 * (`wwwRoute`/`AdminConsoleRoute` in `@rapidmx/server`) - never on the `public` host this page is mounted on.
 * `PublicPageRoute` (`@rapidmx/server`, this page's actual host route) returns only branding props; it has no
 * concept of the caller's session at all. There is, today, no public-host plugin page anywhere in this codebase
 * that does this, so there was no convention to extend - only two, cross-repo (`@rapidmx/server`/`web-client`)
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
import useBranding from "@rapidmx/web-client/lib/branding/useBranding.js";
import { Branding } from "@rapidmx/web-client/lib/branding/brandingApi.js";
import { ApiRequestError } from "@rapidmx/web-client/lib/util/api.js";
import Button from "@rapidmx/web-client/lib/components/buttons/Button.js";
import Alert from "@rapidmx/web-client/lib/components/feedback/Alert.js";
import FormField from "@rapidmx/web-client/lib/components/forms/FormField.js";
import { MeetCard, MeetPageShell } from "./_MeetChrome.js";
import { useLocalMedia } from "../shared/media/useLocalMedia.js";
import MeetLobby from "./_MeetLobby.js";
import CallView from "./_CallView.js";
import {
    type PublicVideoMeeting,
    type VideoMeetingJoinResult,
    joinMeeting,
    pollAdmission,
    requestAdmission,
    verifyMeetingPassword,
} from "./_meetApi.js";

type Phase = "loading" | "not-found" | "password" | "admission-request" | "waiting" | "denied" | "lobby" | "in-call" | "ended";

const INPUT_CLASS = "w-full text-base py-2.5 px-3.5 border border-border rounded-md bg-surface text-text focus:outline-none focus:border-primary";

/** How often `MeetJoinContent` polls while in the `"waiting"` phase. */
const ADMISSION_POLL_MS = 3_000;

export default function MeetJoinPage({ params }: { params: { token: string } }) {
    const { branding } = useBranding();
    return <MeetJoinContent token={params.token} branding={branding} />;
}

/** Owns the camera and microphone (`useLocalMedia()`) for the whole visit, so the tracks the lobby previews are the
 * ones the call sends. Every phase but the call is drawn inside the branded page shell; the call fills the whole
 * window instead (see `_CallView.tsx`). */
function MeetJoinContent({ token, branding }: { token: string; branding: Branding | null }) {
    const [phase, setPhase] = useState<Phase>("loading");
    const [name, setName] = useState("");
    const [loadError, setLoadError] = useState<string | null>(null);
    const [joinResult, setJoinResult] = useState<VideoMeetingJoinResult | null>(null);
    /** The restricted `PublicVideoMeeting` `joinMeeting()` returned while this meeting required a password - just
     * enough to show the password prompt's own title/host, since `joinResult` itself stays unset until one is
     * verified (see `handleSubmitPassword()`). Only read while `phase === "password"`. */
    const [passwordMeeting, setPasswordMeeting] = useState<PublicVideoMeeting | null>(null);
    const [passwordInput, setPasswordInput] = useState("");
    const [passwordError, setPasswordError] = useState<string | null>(null);
    /** The restricted `PublicVideoMeeting` `joinMeeting()`/`requestAdmission()` returned while this meeting has a
     * waiting room - read on both the `"admission-request"` and `"waiting"` screens. */
    const [admissionMeeting, setAdmissionMeeting] = useState<PublicVideoMeeting | null>(null);
    const [admissionName, setAdmissionName] = useState("");
    const [admissionPassword, setAdmissionPassword] = useState("");
    const [admissionError, setAdmissionError] = useState<string | null>(null);
    /** The guest token `requestAdmission()` minted, to poll with (`Authorization` header - a guest has no session
     * cookie of their own). `undefined` for an already-authenticated real caller, whose existing session cookie
     * already identifies them to `pollAdmission()` with no header needed. */
    const [pendingGuestToken, setPendingGuestToken] = useState<string | undefined>(undefined);
    /** Set only when the call ended without the participant's own action (currently: kicked by the host) - see
     * `CallView`'s `onLeave` doc comment. Shown instead of the ordinary "you left" message; also hides "Rejoin
     * meeting", since a kicked participant's server-side channel grant has just been revoked and a rejoin attempt
     * would only fail. */
    const [endedReason, setEndedReason] = useState<string | undefined>(undefined);
    const media = useLocalMedia({ effectsAssetsUrl: joinResult?.effectsAssetsUrl, forceMuteOnJoin: joinResult?.meeting.forceMuteOnJoin });
    const { release } = media;

    React.useEffect(() => {
        let cancelled = false;
        joinMeeting(token)
            .then((result) => {
                if (cancelled) {
                    return;
                }
                if ("requiresAdmission" in result) {
                    setAdmissionMeeting(result.meeting);
                    setPhase("admission-request");
                    return;
                }
                if ("requiresPassword" in result) {
                    setPasswordMeeting(result.meeting);
                    setPhase("password");
                    return;
                }
                setJoinResult(result);
                setPhase("lobby");
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

    async function handleSubmitPassword(e: React.FormEvent) {
        e.preventDefault();
        setPasswordError(null);
        try {
            const result = await verifyMeetingPassword(token, passwordInput);
            setJoinResult(result);
            setPhase("lobby");
        } catch (err) {
            setPasswordError(err instanceof ApiRequestError && err.status === 403 ? "Incorrect password." : "Something went wrong. Try again.");
        }
    }

    async function handleRequestAdmission(e: React.FormEvent) {
        e.preventDefault();
        setAdmissionError(null);
        try {
            const result = await requestAdmission(token, {
                name: admissionName.trim(),
                ...(admissionMeeting?.hasPassword && { password: admissionPassword }),
            });
            setName(admissionName.trim());
            setPendingGuestToken(result.token);
            setPhase("waiting");
        } catch (err) {
            setAdmissionError(err instanceof ApiRequestError && err.status === 403 ? "Incorrect password." : "Something went wrong. Try again.");
        }
    }

    // Polls while waiting for the host to respond - stops as soon as this phase is left, one way or the other.
    React.useEffect(() => {
        if (phase !== "waiting") {
            return;
        }
        let cancelled = false;
        const poll = async () => {
            try {
                const result = await pollAdmission(token, pendingGuestToken);
                if (cancelled || "requiresAdmission" in result) {
                    return;
                }
                setJoinResult(result);
                setPhase("lobby");
            } catch (err) {
                if (cancelled || !(err instanceof ApiRequestError) || err.status !== 403) {
                    // A transient failure (network blip, server hiccup) - stay on this screen and try again next
                    // tick, rather than giving up on what might just be one bad request.
                    return;
                }
                setAdmissionError(err.message || "The host did not admit you to this meeting.");
                setPhase("denied");
            }
        };
        void poll();
        const interval = setInterval(() => void poll(), ADMISSION_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [phase, token, pendingGuestToken]);

    function handleLeave(reason?: string) {
        release();
        setEndedReason(reason);
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
                relayEnabled={joinResult.relayEnabled}
                hostUid={joinResult.meeting.hostUid}
                initialForceMuteOnJoin={!!joinResult.meeting.forceMuteOnJoin}
                initialHasPassword={!!joinResult.meeting.hasPassword}
                initialWaitingRoomEnabled={!!joinResult.meeting.waitingRoomEnabled}
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
    } else if (phase === "password") {
        content = (
            <MeetCard>
                <h1 className="text-2xl font-bold tracking-tight">{passwordMeeting?.title}</h1>
                {passwordMeeting?.hostDisplayName && <p className="text-sm text-text-muted mt-1">Hosted by {passwordMeeting.hostDisplayName}</p>}
                <p className="text-base text-text-muted mt-4 mb-3">This meeting requires a password to join.</p>
                <form onSubmit={(e) => void handleSubmitPassword(e)}>
                    <FormField label="Password" htmlFor="meet-password">
                        <input
                            id="meet-password"
                            type="password"
                            autoFocus
                            className={INPUT_CLASS}
                            value={passwordInput}
                            onChange={(e) => setPasswordInput(e.target.value)}
                        />
                    </FormField>
                    {passwordError && <Alert>{passwordError}</Alert>}
                    <Button type="submit" className="!w-auto mt-3" disabled={!passwordInput}>
                        Join meeting
                    </Button>
                </form>
            </MeetCard>
        );
    } else if (phase === "admission-request") {
        content = (
            <MeetCard>
                <h1 className="text-2xl font-bold tracking-tight">{admissionMeeting?.title}</h1>
                {admissionMeeting?.hostDisplayName && <p className="text-sm text-text-muted mt-1">Hosted by {admissionMeeting.hostDisplayName}</p>}
                <p className="text-base text-text-muted mt-4 mb-3">The host must let you in before you can join.</p>
                <form onSubmit={(e) => void handleRequestAdmission(e)}>
                    <FormField label="Your name" htmlFor="admission-name">
                        <input
                            id="admission-name"
                            type="text"
                            autoFocus
                            className={INPUT_CLASS}
                            value={admissionName}
                            onChange={(e) => setAdmissionName(e.target.value)}
                        />
                    </FormField>
                    {admissionMeeting?.hasPassword && (
                        <FormField label="Password" htmlFor="admission-password">
                            <input
                                id="admission-password"
                                type="password"
                                className={`${INPUT_CLASS} mt-3`}
                                value={admissionPassword}
                                onChange={(e) => setAdmissionPassword(e.target.value)}
                            />
                        </FormField>
                    )}
                    {admissionError && <Alert>{admissionError}</Alert>}
                    <Button
                        type="submit"
                        className="!w-auto mt-3"
                        disabled={!admissionName.trim() || (!!admissionMeeting?.hasPassword && !admissionPassword)}
                    >
                        Ask to join
                    </Button>
                </form>
            </MeetCard>
        );
    } else if (phase === "waiting") {
        content = (
            <MeetCard>
                <h1 className="text-2xl font-bold tracking-tight">{admissionMeeting?.title}</h1>
                <p className="text-base text-text-muted mt-4">Waiting for the host to let you in&hellip;</p>
            </MeetCard>
        );
    } else if (phase === "denied") {
        content = (
            <MeetCard>
                <Alert>{admissionError ?? "The host did not admit you to this meeting."}</Alert>
            </MeetCard>
        );
    } else if (phase === "ended") {
        content = (
            <MeetCard>
                <h1 className="text-xl font-bold tracking-tight mb-2">{endedReason ? "Removed from the meeting" : "You left the meeting"}</h1>
                <p className="text-base text-text-muted mb-4">{endedReason ?? "You can close this page now, or rejoin."}</p>
                {!endedReason && (
                    <Button type="button" className="!w-auto" onClick={() => setPhase("lobby")}>
                        Rejoin meeting
                    </Button>
                )}
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
