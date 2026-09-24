///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Shared types for `MeshConnectionManager.ts` and its signaling transport (`apps/shared/push/GuestSignalingClient.ts`) -
 * kept in their own module so a test can depend on the shapes alone. `GuestSignalingClient` itself now also serves
 * an already-authenticated real caller (`VideoMeetingJoinResult.authenticated`), not only a synthetic guest - see
 * its own doc comment. */

/** What a participant is sending, and whether their hand is up. Announced in `hello` and re-sent as a `state`
 * message on every change, so a tile can show a muted microphone, an avatar for a camera that is off, and a raised
 * hand without inspecting the media itself (the far end of a `replaceTrack(null)` gives no dependable signal that
 * the track stopped). */
export interface ParticipantState {
    audioOn: boolean;
    videoOn: boolean;
    handRaised: boolean;
}

/** The emoji a participant can send during a call. A received `reaction` outside this list is ignored, so an
 * arbitrary string from another participant is never rendered. */
export const REACTION_EMOJIS = ["👍", "👏", "❤️", "🎉", "😂", "😮", "😢", "👋"] as const;

/**
 * One WebRTC signaling message, published as the JSON body of `POST /push/:meetingUid` (`BasePushRoute.send()`)
 * and received back over `/push`'s WebSocket, exactly as `BaseVideoMeetingRoute`'s doc comment describes ("SDP
 * offers/answers and ICE candidates are ordinary `NotificationUtils.sendMessage()` payloads"). `type` is a fixed
 * literal so a listener on the meeting's channel (which will also see other frame shapes if this server ever
 * grows other push consumers) can cheaply recognize and skip anything that isn't one of these.
 *
 * `hello`/`bye`/`presenter-claim`/`presenter-release`/`state`/`reaction` are broadcast (`to` left unset - every
 * participant is relevant); `offer`/`answer`/`ice-candidate` are point-to-point (`to` is the intended peer's uid) -
 * a recipient that isn't `to` (when set) ignores the message, since a channel's pub/sub fans every message out to
 * every subscriber, sender included.
 */
export interface SignalMessage {
    type: "video-meeting-signal";
    kind:
        | "hello"
        | "bye"
        | "offer"
        | "answer"
        | "ice-candidate"
        | "presenter-claim"
        | "presenter-release"
        | "state"
        | "reaction";
    /** The sender's per-call peer id - `CallView` derives it from `VideoMeetingJoinResult.selfUid` plus a random
     * suffix, so the same account joining from two devices (or two tabs) is two participants, not one that ignores
     * its own messages. */
    from: string;
    /** Set only on a point-to-point message (`offer`/`answer`/`ice-candidate`). */
    to?: string;
    /** `hello` only - the display name the sender chose in the lobby. */
    name?: string;
    /** `hello` and `state` - what the sender is currently sending and whether their hand is up. */
    state?: ParticipantState;
    /** `reaction` only - one of `REACTION_EMOJIS`. */
    emoji?: string;
    /** `offer`/`answer` only. */
    sdp?: RTCSessionDescriptionInit;
    /** `ice-candidate` only. */
    candidate?: RTCIceCandidateInit;
}

/** What `MeshConnectionManager` needs from a signaling transport - implemented by
 * `apps/shared/push/GuestSignalingClient.ts` for a real call, and by an in-memory fake for `MeshConnectionManager`'s own
 * tests (see `test/webrtc/MeshConnectionManager.test.ts`), which never opens a real network connection. */
export interface SignalingChannel {
    send(message: SignalMessage): void;
    /** Calls `handler` with every message received on the channel (including, per the pub/sub fan-out this
     * transport is built on, this same client's own sends - `MeshConnectionManager` filters those out itself
     * rather than relying on the transport to). Returns the function that stops listening. */
    onMessage(handler: (message: SignalMessage) => void): () => void;
}

/** The subset of `RTCRtpSender` `MeshConnectionManager.setLocalTrack()` uses. Every connection carries one audio and
 * one video sender for its whole life (see `MeshConnectionManager`'s doc comment), so turning a camera on or off,
 * switching a device or sharing a screen only ever replaces the track a sender sends - no renegotiation. A real
 * `RTCRtpSender` already satisfies this shape. */
export interface RTCRtpSenderLike {
    track: MediaStreamTrack | null;
    replaceTrack(track: MediaStreamTrack | null): Promise<void>;
}

/** The subset of `RTCPeerConnection` `MeshConnectionManager` uses - what a test's fake implements, and what
 * `apps/shared/webrtc/realPeerConnection.ts` adapts the real browser constructor to. Event handlers are plain settable
 * properties (`RTCPeerConnection`'s own `on*` style) rather than `addEventListener`, matching the browser API
 * this stands in for and keeping a test fake to the bare minimum. */
export interface RTCPeerConnectionLike {
    /** The offerer's side: adds a send-and-receive transceiver for `kind`, sending `track` when there is one and
     * nothing until `replaceTrack()` supplies it otherwise. */
    addTransceiver(kind: "audio" | "video", track: MediaStreamTrack | null): { sender: RTCRtpSenderLike };
    /** The answerer's side: once the remote offer is applied, turns the transceivers that offer created into
     * send-and-receive ones and returns their senders by kind. (A browser only matches an offer's m-lines to
     * transceivers it created for the offer itself - one the answerer added up front with `addTransceiver()` is left
     * unused, and everything the answerer sends is silently lost.) */
    claimTransceivers(): Partial<Record<"audio" | "video", RTCRtpSenderLike>>;
    createOffer(): Promise<RTCSessionDescriptionInit>;
    createAnswer(): Promise<RTCSessionDescriptionInit>;
    setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
    setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
    addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
    close(): void;
    onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null;
    ontrack: ((event: { track: MediaStreamTrack }) => void) | null;
    onconnectionstatechange: (() => void) | null;
    connectionState: string;
}

export type RTCPeerConnectionFactory = (config: { iceServers: RTCIceServer[] }) => RTCPeerConnectionLike;

/** One other participant currently known to be in the call - `MeshConnectionManager.participants` never includes
 * the local participant themselves (the UI already knows its own name/uid without asking the manager). */
export interface MeshParticipant extends ParticipantState {
    uid: string;
    name: string;
}

export type MeshEvent =
    | { type: "participant-joined"; participant: MeshParticipant }
    | { type: "participant-updated"; participant: MeshParticipant }
    | { type: "participant-left"; uid: string }
    | { type: "remote-stream"; uid: string; stream: MediaStream }
    | { type: "hand-raised"; uid: string; name: string }
    | { type: "reaction"; uid: string; name: string; emoji: string }
    | { type: "presenter-changed"; uid: string | undefined };
