///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The in-call view: connects the full-mesh `MeshConnectionManager` to the meeting's signaling channel
 * (`GuestSignalingClient`), mirrors its events into React state, and renders the grid/focused/presentation
 * layouts - see `apps/shared/webrtc/MeshConnectionManager.ts`'s doc comment for the who-calls-whom and
 * single-presenter rules this view relies on rather than re-deciding. These reusable, non-UI modules live under
 * `apps/shared/` rather than this plugin's backend `src/` - `tsconfig.apps.json` builds `apps/` as its own
 * program rooted at `apps/`, which cannot reference files outside it (`TS6059`), matching `booking-plugin`'s own
 * identical `apps/shared/` convention for reusable frontend-only code.
 *
 * ## Fitting the window
 *
 * The call fills the viewport (`fixed inset-0`) as three rows - a slim header, the tiles (which take whatever room
 * is left and never scroll the page), and the control bar pinned to the bottom - instead of being laid out inside
 * the branded page shell, whose header, footer and padding pushed it off the screen. The local participant's own
 * tile is a small tile in the bottom-right corner while anyone else is in the call (above the control bar on a narrower
 * window, and at the top on a phone, where the bar wraps onto a second row), and fills the tile area while they are
 * alone.
 *
 * ## Who is heard
 *
 * A tile never plays sound. Each remote stream is played by its own hidden `<audio>` element, so a participant is
 * heard whether or not their camera is on and whichever layout is showing. If the browser refuses to start the
 * audio (an autoplay policy), a banner asks for a click, which is the gesture that allows it.
 *
 * ## Layout precedence
 *
 * `computeMainUid()` decides who is shown large, in this order: an active presenter always wins (presentation
 * mode, forcing a focused-like layout regardless of `viewMode`); otherwise a manually pinned participant; else the
 * auto-detected active speaker (silently ignored while presenting, so it never fights the presenter for the main
 * slot); else, in focus mode with nobody yet speaking, the first other participant - so focus mode never shows an
 * empty main slot once someone else has joined.
 *
 * ## Talking stick mode
 *
 * A host-only navbar toggle (`handleToggleTalkingStick()`) that, once on, lets at most one participant's microphone
 * be unmuted at a time - the host assigns who from the participants drawer (`handleGiveTalkingStick()`), everyone
 * else sees a header chip naming who currently holds it. Purely an in-call runtime state signaled peer-to-peer over
 * the mesh (`MeshConnectionManager.setTalkingStick()`/`"talking-stick-changed"`), the same shape as `mute-request`/
 * `kicked`: no `VideoMeeting` field, no backend route, and only as "enforced" as a cooperating client makes it (see
 * `types.ts`'s `SignalMessage` doc comment on why the signaling layer has no host identity to check against). What
 * *is* new here versus `mute-request`'s one-time nudge: becoming or ceasing to be the holder force-toggles this
 * tab's own mic to match (`selfHasTalkingStick`'s effect, below), and the mic button itself is disabled
 * (`micLocked`, passed to `CallControls`) the whole time a non-holder would otherwise be able to tap it straight
 * back on - a real restriction for as long as this tab's own UI is the one in front of the participant, not just a
 * suggestion. Turning the mode off touches nobody's mic state, matching every other host toggle's "never
 * retroactive" posture. A holder who leaves the call is not specially reassigned - see
 * `MeshConnectionManager`'s own doc comment on why that needs no extra code - the header chip then says nobody has
 * the floor, until the host picks someone (or themselves) again.
 *
 * ## Diagnostics, connection method and settings
 *
 * All three are opened from `_CallControls.tsx`'s own "…" menu (its doc comment covers the menu itself) via
 * callback props, but owned here: `diagnosticsOpen` renders `_DiagnosticsWindow.tsx` (a persistent, draggable
 * window - not a popover like the menus in the control bar, since troubleshooting a connection is something a
 * participant wants to keep open while they poke at the rest of the call, not something that closes the moment
 * they click elsewhere); `transportMode`/`handleSetTransportMode()` forces how *this tab's* media reaches everyone
 * else (`TransportMode` - see `MeshConnectionManager.setTransportMode()`'s own doc comment), independent of what
 * anyone else has chosen; `settingsOpen` renders `_SettingsModal.tsx`, which used to be the participants drawer's
 * own header (mute-on-join, the join password, the waiting-room toggle) - moved out because none of those are
 * about *who* is in the call, which is what the drawer is for.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { playRaisedHandChime } from "../shared/media/chime.js";
import { pickActiveSpeaker } from "../shared/media/activeSpeaker.js";
import { startLevelMeter, type LevelMeterHandle } from "../shared/media/levelMeter.js";
import { requestDisplayMedia, stopStream } from "../shared/media/deviceMedia.js";
import { NO_SCREEN_TRANSFORM, ScreenTransformProcessor, rotateClockwise, type ScreenTransformState } from "../shared/media/filters/ScreenTransform.js";
import type { LocalMedia } from "../shared/media/useLocalMedia.js";
import { createBrowserPeerConnection } from "../shared/webrtc/realPeerConnection.js";
import { MeshConnectionManager } from "../shared/webrtc/MeshConnectionManager.js";
import type { MeshParticipant, RelayTransportLike, TransportMode } from "../shared/webrtc/types.js";
import { createRelayTransport } from "../shared/relay/RelayTransport.js";
import { GuestSignalingClient } from "../shared/push/GuestSignalingClient.js";
import CallControls, { type CallViewMode } from "./_CallControls.js";
import { BatonIcon } from "./_icons.js";
import {
    admitParticipant,
    denyParticipant,
    kickParticipant,
    listWaitingParticipants,
    setForceMuteOnJoin as apiSetForceMuteOnJoin,
    setMeetingPassword,
    setWaitingRoomEnabled as apiSetWaitingRoomEnabled,
    type WaitingParticipant,
} from "./_meetApi.js";
import DiagnosticsPanel from "./_DiagnosticsPanel.js";
import DiagnosticsWindow from "./_DiagnosticsWindow.js";
import ParticipantTile from "./_ParticipantTile.js";
import ParticipantsDrawer from "./_ParticipantsDrawer.js";
import SettingsModal from "./_SettingsModal.js";

export interface CallViewProps {
    channel: string;
    /** Omitted when the caller already authenticated as a real RapidMX identity in `join()` - there is then no
     * guest token to hand `GuestSignalingClient`, which relies entirely on the browser's own already-existing
     * `jwt` session cookie instead (see its own doc comment). */
    token?: string;
    selfUid: string;
    selfName: string;
    meetingTitle: string;
    iceServers: RTCIceServer[];
    /** Whether the server offers the WebSocket media relay, the last-resort path for a participant neither a direct
     * connection nor the TURN server can reach - `VideoMeetingJoinResult.relayEnabled`. Off when absent. */
    relayEnabled?: boolean;
    /** The meeting's host account uid (`PublicVideoMeeting.hostUid`) - this client's only source of a "host"
     * identity, purely for deciding which controls to show (see `BaseVideoMeetingRoute`'s class doc comment on why
     * this is a client-side-only check, not a server-enforced one for every moderation action). Absent when the
     * server couldn't resolve one, in which case nobody sees host controls. */
    hostUid?: string;
    /** `PublicVideoMeeting.forceMuteOnJoin` as of this call's own `join()` - the starting value for the host's
     * toggle in the settings modal, which this view then owns and keeps current itself (see
     * `handleToggleForceMuteOnJoin()`). Does not update if changed elsewhere while this view is mounted - there is
     * no signal for that today, matching every other meeting-settings field's lack of live sync. */
    initialForceMuteOnJoin?: boolean;
    /** `PublicVideoMeeting.hasPassword` as of this call's own `join()` - the starting value for the host's password
     * section in the settings modal, same "owned and kept current by this view" shape as
     * `initialForceMuteOnJoin`. */
    initialHasPassword?: boolean;
    /** `PublicVideoMeeting.waitingRoomEnabled` as of this call's own `join()` - the starting value for the host's
     * waiting-room toggle, same "owned and kept current by this view" shape as `initialForceMuteOnJoin`. */
    initialWaitingRoomEnabled?: boolean;
    /** The camera and microphone, owned by the page (`[token].tsx`) - the lobby's tracks carried into the call. */
    media: LocalMedia;
    /** Called once the participant leaves, for any reason. `reason` is set only when the call ended without the
     * participant's own action - currently, being kicked by the host - so the caller can show a distinct message
     * instead of the ordinary "you left" one; omitted for an ordinary voluntary leave. */
    onLeave: (reason?: string) => void;
}

/** How long a reaction floats on screen. */
const REACTION_MS = 4_000;
/** The most reactions shown at once - a burst beyond this drops the oldest. */
const MAX_REACTIONS = 12;
/** How often the host's drawer refreshes its own waiting-room list while open. */
const DEFAULT_WAITING_POLL_MS = 3_000;

interface Reaction {
    id: number;
    emoji: string;
    name: string;
}

/** Who is shown large - see this module's doc comment. `undefined` when nobody but the local participant has
 * joined yet (the grid/focus toggle still works, there's just nobody else to focus on). */
export function computeMainUid(options: {
    presenterUid?: string;
    pinnedUid?: string;
    activeSpeakerUid?: string;
    otherUids: readonly string[];
}): string | undefined {
    if (options.presenterUid) {
        return options.presenterUid;
    }
    if (options.pinnedUid) {
        return options.pinnedUid;
    }
    if (options.activeSpeakerUid) {
        return options.activeSpeakerUid;
    }
    return options.otherUids[0];
}

/** This tab's identity in the call: the account (or guest) uid plus a random suffix, so the same account joining
 * from two devices - or two tabs - is two participants rather than one that ignores itself. It travels as the
 * `peer` of each message; `from` stays the exact authenticated uid, which the server requires. */
export function newPeerId(selfUid: string): string {
    return `${selfUid}~${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

/** The real, server-enforced account uid behind a participant's tab-scoped `MeshParticipant.uid` (`newPeerId()`'s
 * `<account uid>~<random>` shape) - what the kick route's ACL grant is actually keyed by, unlike the tab-scoped id
 * this view otherwise addresses a specific tab with. Neither a real account uid nor a minted guest uid (see
 * `GUEST_UID_PREFIX`/`mintGuestToken()` on the backend) can itself contain "~", so the last one found is always
 * exactly this suffix's own separator. */
export function accountUidOf(peerUid: string): string {
    const i = peerUid.lastIndexOf("~");
    return i === -1 ? peerUid : peerUid.slice(0, i);
}

export default function CallView({
    channel,
    token,
    selfUid,
    selfName,
    meetingTitle,
    iceServers,
    relayEnabled,
    hostUid,
    initialForceMuteOnJoin,
    initialHasPassword,
    initialWaitingRoomEnabled,
    media,
    onLeave,
}: CallViewProps) {
    const [peerId] = useState(() => newPeerId(selfUid));
    const [connectError, setConnectError] = useState<string | null>(null);
    const [participants, setParticipants] = useState<MeshParticipant[]>([]);
    const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
    const [levels, setLevels] = useState<Record<string, number>>({});
    const [presenterUid, setPresenterUid] = useState<string | undefined>(undefined);
    const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
    const [screenTransform, setScreenTransform] = useState<ScreenTransformState>(NO_SCREEN_TRANSFORM);
    const [handRaised, setHandRaised] = useState(false);
    const [viewMode, setViewMode] = useState<CallViewMode>("grid");
    const [pinnedUid, setPinnedUid] = useState<string | undefined>(undefined);
    const [activeSpeakerUid, setActiveSpeakerUid] = useState<string | undefined>(undefined);
    const [reactions, setReactions] = useState<Reaction[]>([]);
    const [announcement, setAnnouncement] = useState("");
    const [audioBlocked, setAudioBlocked] = useState(false);
    const [audioNonce, setAudioNonce] = useState(0);
    const [signalingReady, setSignalingReady] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [forceMuteOnJoin, setForceMuteOnJoinState] = useState(!!initialForceMuteOnJoin);
    const [hasPassword, setHasPassword] = useState(!!initialHasPassword);
    const [waitingRoomEnabled, setWaitingRoomEnabledState] = useState(!!initialWaitingRoomEnabled);
    const [waitingParticipants, setWaitingParticipants] = useState<WaitingParticipant[]>([]);
    const [talkingStickActive, setTalkingStickActive] = useState(false);
    const [talkingStickHolder, setTalkingStickHolder] = useState<string | undefined>(undefined);
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [transportMode, setTransportModeState] = useState<TransportMode>("auto");

    const managerRef = useRef<MeshConnectionManager | null>(null);
    /** The raw capture from `getDisplayMedia()` - only ever used to stop it (releasing the OS's own share
     * indicator) and to notice the participant ending the share from the browser's own UI (`track.onended`). What's
     * actually shown and sent is `screenTransformRef`'s output (`screenStream` state) - see `handleToggleShare()`. */
    const screenStreamRef = useRef<MediaStream | null>(null);
    const screenTransformRef = useRef<ScreenTransformProcessor | null>(null);
    const levelMetersRef = useRef<Record<string, LevelMeterHandle>>({});
    const reactionSeqRef = useRef(0);
    const reactionTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    /** The latest `media`, for the mesh-event handler below - that effect runs once at mount (see its own comment),
     * so it would otherwise see only the mic state/toggle function from that first render. */
    const mediaRef = useRef(media);
    useEffect(() => {
        mediaRef.current = media;
    }, [media]);
    const isPresenting = !!screenStream;

    const showReaction = useCallback((emoji: string, name: string) => {
        const id = ++reactionSeqRef.current;
        setReactions((prev) => [...prev.slice(-(MAX_REACTIONS - 1)), { id, emoji, name }]);
        const timer = setTimeout(() => {
            reactionTimersRef.current.delete(timer);
            setReactions((prev) => prev.filter((reaction) => reaction.id !== id));
        }, REACTION_MS);
        reactionTimersRef.current.add(timer);
    }, []);

    useEffect(() => {
        let cancelled = false;
        const client = new GuestSignalingClient({ channel, token });
        const manager = new MeshConnectionManager({
            selfUid,
            peerId,
            selfName,
            iceServers,
            channel: client,
            createPeerConnection: createBrowserPeerConnection,
            relay: relayEnabled ? createRelay(channel, peerId) : undefined,
            localAudioTrack: media.audioTrack,
            localVideoTrack: media.videoTrack,
            localState: { audioOn: media.micOn, videoOn: media.cameraOn },
        });
        managerRef.current = manager;

        const unsubscribe = manager.onEvent((event) => {
            switch (event.type) {
                case "participant-joined":
                    setParticipants((prev) => [...prev.filter((p) => p.uid !== event.participant.uid), event.participant]);
                    return;
                case "participant-updated":
                    setParticipants((prev) => prev.map((p) => (p.uid === event.participant.uid ? event.participant : p)));
                    return;
                case "participant-left":
                    setParticipants((prev) => prev.filter((p) => p.uid !== event.uid));
                    setRemoteStreams((prev) => {
                        const { [event.uid]: _removed, ...rest } = prev;
                        return rest;
                    });
                    stopLevelMeter(levelMetersRef, event.uid);
                    setLevels((prev) => {
                        const { [event.uid]: _removed, ...rest } = prev;
                        return rest;
                    });
                    setPinnedUid((prev) => (prev === event.uid ? undefined : prev));
                    return;
                case "remote-stream":
                    setRemoteStreams((prev) => ({ ...prev, [event.uid]: event.stream }));
                    startTrackingLevel(levelMetersRef, event.uid, event.stream, (level) =>
                        setLevels((prev) => ({ ...prev, [event.uid]: level })),
                    );
                    return;
                case "hand-raised":
                    playRaisedHandChime();
                    setAnnouncement(`${event.name} raised a hand`);
                    return;
                case "reaction":
                    showReaction(event.emoji, event.name);
                    return;
                case "presenter-changed":
                    setPresenterUid(event.uid);
                    if (event.uid !== peerId && screenStreamRef.current) {
                        // Lost a presenter-claim collision (see `MeshConnectionManager`'s doc comment) - stop our
                        // own capture without re-sending a release the manager already handled internally.
                        stopLocalPresentation(false);
                    }
                    return;
                case "mute-requested":
                    if (mediaRef.current.micOn) {
                        void mediaRef.current.toggleMic();
                    }
                    return;
                case "kicked":
                    onLeave("The host removed you from this call.");
                    return;
                case "talking-stick-changed":
                    setTalkingStickActive(event.active);
                    setTalkingStickHolder(event.holder);
                    return;
            }
        });

        client
            .connect()
            .then(() => {
                if (!cancelled) {
                    manager.start();
                    setSignalingReady(true);
                }
            })
            .catch((err: Error) => {
                if (!cancelled) {
                    setConnectError(err.message);
                }
            });

        // A closing tab doesn't unmount React, so say goodbye explicitly - otherwise everyone else keeps a tile for a
        // participant who is gone.
        const onPageHide = () => manager.stop();
        window.addEventListener("pagehide", onPageHide);

        const timers = reactionTimersRef.current;
        return () => {
            cancelled = true;
            window.removeEventListener("pagehide", onPageHide);
            unsubscribe();
            manager.stop();
            client.close();
            for (const handle of Object.values(levelMetersRef.current)) {
                handle.stop();
            }
            levelMetersRef.current = {};
            // Only the screen capture is this view's to stop - the camera and microphone belong to the page, which
            // releases them when the participant leaves.
            stopStream(screenStreamRef.current);
            screenTransformRef.current?.stop();
            for (const timer of timers) {
                clearTimeout(timer);
            }
            timers.clear();
        };
        // Deliberately runs once - the call's identity (channel/token/selfUid) never changes for the life of this
        // component; a real identity change is a new call, which unmounts/remounts this view from `[token].tsx`.
    }, []);

    // What is sent follows what the participant has: the camera or the shared screen, and the microphone.
    useEffect(() => {
        managerRef.current?.setLocalTrack("audio", media.audioTrack);
    }, [media.audioTrack]);
    useEffect(() => {
        managerRef.current?.setLocalTrack("video", screenStream?.getVideoTracks()[0] ?? media.videoTrack);
    }, [media.videoTrack, screenStream]);
    useEffect(() => {
        managerRef.current?.setLocalState({ audioOn: media.micOn, videoOn: media.cameraOn || isPresenting, handRaised });
    }, [media.micOn, media.cameraOn, isPresenting, handRaised]);

    // Talking-stick mode forces exactly one microphone on at a time: whoever just became the holder (including the
    // host, on activation) is unmuted; everyone else is muted. Unlike `mute-requested`'s one-time nudge, this is
    // paired with disabling the mic button itself (`micLocked`, passed to `CallControls` below) while it applies,
    // so it isn't merely a suggestion - though still cooperative at the signaling layer, like every other
    // moderation feature here (see `MeshConnectionManager`'s doc comment). Turning the mode off touches nobody's
    // mic - states are left exactly as they are, the same "never retroactive" posture as every other host toggle.
    const selfHasTalkingStick = talkingStickActive && talkingStickHolder === peerId;
    const micLocked = talkingStickActive && !selfHasTalkingStick;
    useEffect(() => {
        if (!talkingStickActive) {
            return;
        }
        if (selfHasTalkingStick && !mediaRef.current.micOn) {
            void mediaRef.current.toggleMic();
        } else if (!selfHasTalkingStick && mediaRef.current.micOn) {
            void mediaRef.current.toggleMic();
        }
    }, [talkingStickActive, selfHasTalkingStick]);

    useEffect(() => {
        if (!presenterUid) {
            setActiveSpeakerUid((prev) => pickActiveSpeaker(levels, prev));
        }
    }, [levels, presenterUid]);

    function stopLocalPresentation(alsoRelease: boolean): void {
        if (alsoRelease) {
            managerRef.current?.releasePresenter();
        }
        stopStream(screenStreamRef.current);
        screenStreamRef.current = null;
        screenTransformRef.current?.stop();
        screenTransformRef.current = null;
        // The sync effect above swaps the camera back in as the outgoing video track. The rotation/flip is reset
        // for the next share - each share starts from the capture the browser hands back, not the last one's fix.
        setScreenStream(null);
        setScreenTransform(NO_SCREEN_TRANSFORM);
    }

    async function handleToggleShare() {
        if (screenStreamRef.current) {
            stopLocalPresentation(true);
            return;
        }
        const result = await requestDisplayMedia();
        if (!result.ok) {
            setConnectError(result.error.message);
            return;
        }
        const claimed = managerRef.current?.claimPresenter() ?? false;
        if (!claimed) {
            stopStream(result.value);
            return;
        }
        screenStreamRef.current = result.value;
        const rawTrack = result.value.getVideoTracks()[0];
        rawTrack.onended = () => stopLocalPresentation(true);
        try {
            // Runs the capture through the rotate/flip processor before anyone (presenter included) sees it - see
            // ScreenTransform.ts's doc comment on why window capture sometimes needs this correction.
            const processor = new ScreenTransformProcessor({ source: rawTrack, state: screenTransform });
            screenTransformRef.current = processor;
            setScreenStream(new MediaStream([processor.track]));
        } catch {
            // This browser can't draw the correction - share the raw capture rather than not sharing at all; the
            // rotate/flip buttons simply won't do anything (screenTransformRef stays null).
            setScreenStream(result.value);
        }
    }

    function handleRotateScreen() {
        setScreenTransform((prev) => {
            const next = rotateClockwise(prev);
            screenTransformRef.current?.setState(next);
            return next;
        });
    }

    function handleFlipScreen() {
        setScreenTransform((prev) => {
            const next = { ...prev, flipped: !prev.flipped };
            screenTransformRef.current?.setState(next);
            return next;
        });
    }

    function handleToggleHand() {
        setHandRaised((prev) => !prev);
    }

    function handleReaction(emoji: string) {
        if (managerRef.current?.sendReaction(emoji)) {
            showReaction(emoji, "You");
        }
    }

    function togglePin(uid: string) {
        setPinnedUid((prev) => (prev === uid ? undefined : uid));
    }

    /** Asks `peerUid`'s participant to mute - the host-only button in the participants drawer calls this
     * directly, with no confirmation (unlike removing someone, muting is easily undone by the participant
     * themselves). */
    function handleMuteParticipant(peerUid: string) {
        managerRef.current?.sendMuteRequest(peerUid);
    }

    /** Removes `peerUid`'s participant from the call: the cooperative signal (immediate, so a cooperating client
     * leaves without waiting on the network round trip below) and the enforced server-side revoke together - see
     * `kickParticipant()`'s own doc comment for why both matter. The REST call's failure is swallowed rather than
     * surfaced: the host already asked them to leave, and there is no useful recovery action to offer from here
     * for what is almost always a transient network issue. */
    function handleKickParticipant(peerUid: string) {
        managerRef.current?.sendKick(peerUid);
        kickParticipant(channel, accountUidOf(peerUid)).catch(() => undefined);
    }

    /** Flips the host's "mute new participants on join" setting: applied optimistically (the toggle itself is the
     * only feedback this small a control needs) and reverted if the save fails, so the drawer never keeps claiming
     * a setting that isn't actually persisted. Takes effect for whoever joins next - never retroactive, see
     * `setForceMuteOnJoin()`'s own doc comment. */
    function handleToggleForceMuteOnJoin() {
        const next = !forceMuteOnJoin;
        setForceMuteOnJoinState(next);
        apiSetForceMuteOnJoin(channel, next).catch(() => setForceMuteOnJoinState(!next));
    }

    /** Sets, changes, or removes (`password: null`) the host's join password - unlike the force-mute toggle, this
     * is not applied optimistically: the drawer's own `PasswordSection` awaits the result itself (clearing its
     * input on success, showing an inline error on failure), so there is nothing here to revert. `hasPassword`
     * updates only once the save actually succeeds. */
    async function handleSetPassword(password: string | null): Promise<void> {
        await setMeetingPassword(channel, password);
        setHasPassword(!!password);
    }

    /** Flips the host's waiting-room setting - same optimistic-and-revert shape as `handleToggleForceMuteOnJoin()`,
     * for the same reason. Takes effect for whoever joins next; nobody already admitted is retroactively gated. */
    function handleToggleWaitingRoomEnabled() {
        const next = !waitingRoomEnabled;
        setWaitingRoomEnabledState(next);
        apiSetWaitingRoomEnabled(channel, next).catch(() => setWaitingRoomEnabledState(!next));
    }

    /** Starts or stops talking-stick mode - host-only, see this module's doc comment. Starting makes the host the
     * initial holder; stopping clears the holder too, leaving mic states exactly as they are rather than
     * retroactively unmuting anyone. */
    function handleToggleTalkingStick() {
        managerRef.current?.setTalkingStick(!talkingStickActive, talkingStickActive ? undefined : peerId);
    }

    /** Hands the talking stick to `uid` (a participant's `MeshParticipant.uid`, or this tab's own `peerId` for the
     * host taking it back) - host-only, called from the participants drawer's per-row "Give stick" button. */
    function handleGiveTalkingStick(uid: string) {
        managerRef.current?.setTalkingStick(true, uid);
    }

    /** Forces this tab's own transport policy - see `MeshConnectionManager.setTransportMode()`'s doc comment for
     * what each mode actually does, and `_CallControls.tsx`'s doc comment on its "…" menu for why this is a
     * personal, per-tab choice rather than a meeting setting. */
    function handleSetTransportMode(mode: TransportMode) {
        setTransportModeState(mode);
        managerRef.current?.setTransportMode(mode);
    }

    /** Admits one pending request - optimistically removed from the drawer's own list (the next poll would drop it
     * anyway, once the requester's own next poll completes their join; removing it here just avoids the visible
     * delay). Re-added if the save itself fails, so a failure doesn't silently lose the request from the list. */
    function handleAdmitParticipant(uid: string) {
        setWaitingParticipants((prev) => prev.filter((p) => p.uid !== uid));
        admitParticipant(channel, uid).catch(() => void listWaitingParticipants(channel).then(setWaitingParticipants, () => undefined));
    }

    /** Denies one pending request - same optimistic-removal shape as `handleAdmitParticipant()`. */
    function handleDenyParticipant(uid: string) {
        setWaitingParticipants((prev) => prev.filter((p) => p.uid !== uid));
        denyParticipant(channel, uid).catch(() => void listWaitingParticipants(channel).then(setWaitingParticipants, () => undefined));
    }

    function handleAudioBlocked() {
        setAudioBlocked(true);
    }

    function handleResumeAudio() {
        setAudioBlocked(false);
        setAudioNonce((prev) => prev + 1);
    }

    // A participant's `uid` is their tab-scoped peer id (`<account uid>~<random>` - see `newPeerId()`), while
    // `hostUid` is the plain account uid `PublicVideoMeeting.hostUid` names - so telling the host's own tab(s) apart
    // needs the prefix match, not equality. Purely a client-side check (see `hostUid`'s own doc comment on this
    // prop): nobody's tab is prevented from claiming it, only from being shown host controls for it.
    const isHost = !!hostUid && selfUid === hostUid;
    const isParticipantHost = (uid: string): boolean => !!hostUid && uid.startsWith(`${hostUid}~`);

    // Refreshes the drawer's own waiting-room list while the host has the drawer open - there is no push signal
    // for a newly filed admission request, so polling is the only way the list stays current without the host
    // having to close and reopen the drawer. Stops (and the list is dropped) the moment either condition ends.
    useEffect(() => {
        if (!isHost || !drawerOpen) {
            setWaitingParticipants([]);
            return;
        }
        let cancelled = false;
        const poll = () => {
            listWaitingParticipants(channel).then((list) => {
                if (!cancelled) {
                    setWaitingParticipants(list);
                }
            }, () => undefined);
        };
        poll();
        const interval = setInterval(poll, DEFAULT_WAITING_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [isHost, drawerOpen, channel]);
    const otherUids = participants.map((p) => p.uid);
    // A pin or an active-speaker pick can name someone who has just left, until the state catches up.
    const stillHere = (uid: string | undefined) => (uid && otherUids.includes(uid) ? uid : undefined);
    const showFocusLayout = !!presenterUid || viewMode === "focus";
    const mainUid = showFocusLayout
        ? computeMainUid({ presenterUid, pinnedUid: stillHere(pinnedUid), activeSpeakerUid: stillHere(activeSpeakerUid), otherUids })
        : undefined;
    const presenterName = presenterUid ? (presenterUid === peerId ? selfName : (participants.find((p) => p.uid === presenterUid)?.name ?? "Someone")) : undefined;
    const raisedNames = [...(handRaised ? ["You"] : []), ...participants.filter((p) => p.handRaised).map((p) => p.name)];
    // Absent (not "Someone") once the holder has left the call - see `MeshConnectionManager`'s doc comment on why
    // nothing reassigns it automatically; the header then says so rather than naming someone no longer here.
    const talkingStickHolderName = !talkingStickActive
        ? undefined
        : selfHasTalkingStick
          ? "You"
          : participants.find((p) => p.uid === talkingStickHolder)?.name;
    const alone = participants.length === 0;
    // This participant has no working link yet: the signaling channel is still opening, or there is someone in the call
    // and every connection to them is still being made. Once any one is up (or nobody else is here) it is not shown,
    // so someone already in the call is not told they are "connecting" each time a newcomer arrives.
    const selfConnecting = !connectError && (!signalingReady || (!alone && participants.every((p) => p.transport === "connecting")));

    const remoteTile = (p: MeshParticipant, className?: string) => (
        <ParticipantTile
            key={p.uid}
            name={p.name}
            stream={remoteStreams[p.uid] ?? null}
            cameraOff={!p.videoOn}
            micMuted={!p.audioOn}
            handRaised={p.handRaised}
            transport={p.transport}
            status={p.transport === "connecting" ? "Awaiting connection…" : undefined}
            isFocused={mainUid === p.uid}
            contain={presenterUid === p.uid}
            className={className}
            onClick={() => togglePin(p.uid)}
        />
    );

    const selfTile = (className?: string) => (
        <ParticipantTile
            name={selfName}
            stream={media.videoStream}
            isLocal
            cameraOff={!media.cameraOn}
            micMuted={!media.micOn}
            handRaised={handRaised}
            status={selfConnecting ? "Connecting…" : undefined}
            // A custom background is a fixed picture, not a live reflection - mirroring it would show it backwards
            // to no one but the participant themselves (see `_ParticipantTile.tsx`'s doc comment).
            mirrored={media.filters.background !== "image"}
            className={className}
        />
    );

    const mainParticipant = participants.find((p) => p.uid === mainUid);
    const thumbnails = participants.filter((p) => p.uid !== mainUid);

    let stage: React.ReactNode;
    if (alone) {
        // Nobody else yet: the local participant fills the tile area, presenting or not.
        stage = isPresenting ? (
            <ParticipantTile name={selfName} stream={screenStream} isLocal contain isFocused className="h-full" />
        ) : (
            selfTile("h-full")
        );
    } else if (showFocusLayout && (mainParticipant || isPresenting)) {
        stage = (
            <div className="h-full flex flex-col gap-2">
                <div className="flex-1 min-h-0" data-testid="main-tile">
                    {mainParticipant ? (
                        remoteTile(mainParticipant, "h-full")
                    ) : (
                        <ParticipantTile name={selfName} stream={screenStream} isLocal contain isFocused className="h-full" />
                    )}
                </div>
                {thumbnails.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto h-24 shrink-0" data-testid="thumbnails">
                        {thumbnails.map((p) => (
                            <div key={p.uid} className="w-36 shrink-0">
                                {remoteTile(p, "h-full")}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    } else {
        stage = (
            <div className="h-full grid gap-2 auto-rows-fr [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
                {participants.map((p) => remoteTile(p, "h-full"))}
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 flex bg-[#202124] text-white overflow-hidden">
            <style>{`@keyframes meet-float { 0% { transform: translateY(0) scale(.6); opacity: 0; } 12% { opacity: 1; transform: translateY(-4vh) scale(1); } 100% { transform: translateY(-45vh) scale(1); opacity: 0; } }`}</style>
            <div className="relative flex-1 min-w-0 flex flex-col overflow-hidden">
                <header className="shrink-0 flex items-center justify-between gap-3 px-4 py-3">
                    <h1 className="min-w-0 truncate text-base font-medium">{meetingTitle}</h1>
                    <div className="flex items-center gap-2 shrink-0">
                        {raisedNames.length > 0 && (
                            <span className="max-w-[45vw] truncate px-3 py-1.5 rounded-full bg-[#a8c7fa] text-[#062e6f] text-sm font-medium" data-testid="raised-hands">
                                ✋ {raisedNames.join(", ")}
                            </span>
                        )}
                        {talkingStickActive && (
                            <span className="max-w-[45vw] truncate px-3 py-1.5 rounded-full bg-[#a8c7fa] text-[#062e6f] text-sm font-medium" data-testid="talking-stick-status">
                                🎙️ {talkingStickHolderName ? `${talkingStickHolderName} ${talkingStickHolderName === "You" ? "have" : "has"} the floor` : "Waiting for the host to choose a speaker"}
                            </span>
                        )}
                        {isHost && (
                            <button
                                type="button"
                                className={`w-9 h-9 flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${talkingStickActive ? "bg-[#a8c7fa] text-[#062e6f] hover:bg-[#8ab4f8]" : "bg-[#3c4043] hover:bg-[#4b4f53]"}`}
                                aria-label={talkingStickActive ? "End talking stick" : "Talking stick"}
                                aria-pressed={talkingStickActive}
                                title={talkingStickActive ? "End talking stick" : "Start talking stick mode"}
                                onClick={handleToggleTalkingStick}
                            >
                                <BatonIcon />
                            </button>
                        )}
                        <button
                            type="button"
                            className="px-3 py-1.5 rounded-full bg-[#3c4043] hover:bg-[#4b4f53] text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                            aria-label={`${participants.length + 1} participants`}
                            aria-haspopup="dialog"
                            aria-expanded={drawerOpen}
                            onClick={() => setDrawerOpen((prev) => !prev)}
                        >
                            {participants.length + 1}
                        </button>
                    </div>
                </header>
                {connectError && (
                    <div role="alert" className="shrink-0 mx-3 mb-2 px-3 py-2 rounded-lg bg-[#601410] text-[#f9dedc] text-sm">
                        {connectError}
                    </div>
                )}
                {audioBlocked && (
                    <button
                        type="button"
                        className="shrink-0 mx-3 mb-2 px-3 py-2 rounded-lg bg-[#a8c7fa] text-[#062e6f] text-sm font-medium"
                        onClick={handleResumeAudio}
                    >
                        Click here to turn on sound
                    </button>
                )}
                <main className="relative flex-1 min-h-0 px-3 pb-3">
                    {stage}
                    {presenterName && presenterUid !== peerId && (
                        <p className="absolute top-2 left-5 px-2 py-0.5 rounded bg-black/60 text-sm">{presenterName} is presenting</p>
                    )}
                </main>
                <footer className="shrink-0 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                    <CallControls
                        media={media}
                        participants={participants}
                        isPresenting={isPresenting}
                        presentingElsewhereName={presenterUid && presenterUid !== peerId ? presenterName : undefined}
                        onToggleShare={() => void handleToggleShare()}
                        screenTransform={screenTransform}
                        onRotateScreen={handleRotateScreen}
                        onFlipScreen={handleFlipScreen}
                        handRaised={handRaised}
                        onToggleHand={handleToggleHand}
                        onReaction={handleReaction}
                        viewMode={viewMode}
                        onToggleViewMode={() => setViewMode((prev) => (prev === "grid" ? "focus" : "grid"))}
                        micLocked={micLocked}
                        isHost={isHost}
                        transportMode={transportMode}
                        onSetTransportMode={handleSetTransportMode}
                        onOpenDiagnostics={() => setDiagnosticsOpen(true)}
                        onOpenSettings={() => setSettingsOpen(true)}
                        onLeave={onLeave}
                    />
                </footer>

                {!alone && (
                    <div
                        className="absolute z-10 right-3 top-14 w-28 sm:top-auto sm:bottom-24 sm:w-52 aspect-video shadow-xl xl:right-4 xl:bottom-4"
                        data-testid="self-view"
                    >
                        {selfTile("h-full")}
                    </div>
                )}

                <div className="pointer-events-none absolute left-4 bottom-28 w-40 h-[45vh]" aria-hidden="true">
                    {reactions.map((reaction) => (
                        <div
                            key={reaction.id}
                            className="absolute bottom-0 flex flex-col items-center"
                            style={{ left: `${(reaction.id % 4) * 36}px`, animation: `meet-float ${REACTION_MS}ms ease-out forwards` }}
                            data-testid="reaction"
                        >
                            <span className="text-4xl leading-none">{reaction.emoji}</span>
                            <span className="mt-1 px-1.5 rounded-full bg-[#a8c7fa] text-[#062e6f] text-xs">{reaction.name}</span>
                        </div>
                    ))}
                </div>

                {participants.map((p) => {
                    const stream = remoteStreams[p.uid];
                    return stream ? <RemoteAudio key={`${p.uid}:${audioNonce}`} stream={stream} onBlocked={handleAudioBlocked} /> : null;
                })}
                <div role="status" aria-live="polite" className="sr-only">
                    {announcement}
                </div>
            </div>

            {drawerOpen && (
                <ParticipantsDrawer
                    selfName={selfName}
                    micOn={media.micOn}
                    handRaised={handRaised}
                    participants={participants}
                    isSelfHost={isHost}
                    isParticipantHost={isParticipantHost}
                    onMute={handleMuteParticipant}
                    onKick={handleKickParticipant}
                    waitingRoomEnabled={waitingRoomEnabled}
                    waitingParticipants={waitingParticipants}
                    onAdmit={handleAdmitParticipant}
                    onDeny={handleDenyParticipant}
                    talkingStickActive={talkingStickActive}
                    selfPeerId={peerId}
                    talkingStickHolder={talkingStickHolder}
                    onGiveTalkingStick={handleGiveTalkingStick}
                    onClose={() => setDrawerOpen(false)}
                />
            )}

            {diagnosticsOpen && (
                <DiagnosticsWindow onClose={() => setDiagnosticsOpen(false)}>
                    <DiagnosticsPanel selfName={selfName} micOn={media.micOn} cameraOn={media.cameraOn} participants={participants} />
                </DiagnosticsWindow>
            )}

            {settingsOpen && isHost && (
                <SettingsModal
                    forceMuteOnJoin={forceMuteOnJoin}
                    onToggleForceMuteOnJoin={handleToggleForceMuteOnJoin}
                    hasPassword={hasPassword}
                    onSetPassword={handleSetPassword}
                    waitingRoomEnabled={waitingRoomEnabled}
                    onToggleWaitingRoomEnabled={handleToggleWaitingRoomEnabled}
                    onClose={() => setSettingsOpen(false)}
                />
            )}
        </div>
    );
}

/** Plays one remote participant's stream through a hidden `<audio>` element. `onBlocked` fires if the browser
 * refuses to start it (an autoplay policy) - the view then asks for a click. */
function RemoteAudio({ stream, onBlocked }: { stream: MediaStream; onBlocked: () => void }) {
    const audioRef = useRef<HTMLAudioElement>(null);
    useEffect(() => {
        const element = audioRef.current!;
        element.srcObject = stream;
        void Promise.resolve(element.play()).catch(onBlocked);
    }, [stream, onBlocked]);
    return <audio ref={audioRef} autoPlay data-testid="remote-audio" />;
}

/** The WebSocket media relay for this call, or `undefined` when this browser cannot run it (no WebCodecs) - the
 * mesh then never falls back to it, and says so by marking an unreachable participant `"failed"`. */
function createRelay(meetingUid: string, peerId: string): RelayTransportLike | undefined {
    const relay = createRelayTransport({ meetingUid, peerId });
    return relay.supported ? relay : undefined;
}

function stopLevelMeter(ref: React.MutableRefObject<Record<string, LevelMeterHandle>>, uid: string): void {
    ref.current[uid]?.stop();
    delete ref.current[uid];
}

function startTrackingLevel(
    ref: React.MutableRefObject<Record<string, LevelMeterHandle>>,
    uid: string,
    stream: MediaStream,
    onLevel: (level: number) => void,
): void {
    stopLevelMeter(ref, uid);
    const handle = startLevelMeter(stream, onLevel);
    if (handle) {
        ref.current[uid] = handle;
    }
}
