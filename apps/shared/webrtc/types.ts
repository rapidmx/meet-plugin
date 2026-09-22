///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Shared types for `MeshConnectionManager.ts` and its signaling transport (`apps/shared/push/GuestSignalingClient.ts`) -
 * kept in their own module so a test can depend on the shapes alone. `GuestSignalingClient` itself now also serves
 * an already-authenticated real caller (`VideoMeetingJoinResult.authenticated`), not only a synthetic guest - see
 * its own doc comment. */

/**
 * One WebRTC signaling message, published as the JSON body of `POST /push/:meetingUid` (`BasePushRoute.send()`)
 * and received back over `/push`'s WebSocket, exactly as `BaseVideoMeetingRoute`'s doc comment describes ("SDP
 * offers/answers and ICE candidates are ordinary `NotificationUtils.sendMessage()` payloads"). `type` is a fixed
 * literal so a listener on the meeting's channel (which will also see other frame shapes if this server ever
 * grows other push consumers) can cheaply recognize and skip anything that isn't one of these.
 *
 * `hello`/`bye`/`presenter-claim`/`presenter-release` are broadcast (`to` left unset - every participant is
 * relevant); `offer`/`answer`/`ice-candidate` are point-to-point (`to` is the intended peer's uid) - a recipient
 * that isn't `to` (when set) ignores the message, since a channel's pub/sub fans every message out to every
 * subscriber, sender included.
 */
export interface SignalMessage {
    type: "video-meeting-signal";
    kind: "hello" | "bye" | "offer" | "answer" | "ice-candidate" | "presenter-claim" | "presenter-release";
    /** The sender's uid - the real, already-authenticated caller's own uid when `join()` returned
     * `authenticated: true`, else the `guest:<random>` uid `BaseVideoMeetingRoute.join()` minted (either way, see
     * `VideoMeetingJoinResult.selfUid`). */
    from: string;
    /** Set only on a point-to-point message (`offer`/`answer`/`ice-candidate`). */
    to?: string;
    /** `hello` only - the display name the sender chose in the lobby. */
    name?: string;
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

/** The subset of `RTCRtpSender` `MeshConnectionManager.replaceLocalVideoTrack()` uses (presentation mode - see
 * this plugin's Phase 2 `.claude/NOTES.md` entry: sharing replaces the outgoing camera track rather than adding a
 * second video track, so no renegotiation is ever needed). A real `RTCRtpSender` already satisfies this shape. */
export interface RTCRtpSenderLike {
    track: MediaStreamTrack | null;
    replaceTrack(track: MediaStreamTrack | null): Promise<void>;
}

/** The subset of `RTCPeerConnection` `MeshConnectionManager` uses - what a test's fake implements, and what
 * `apps/shared/webrtc/realPeerConnection.ts` adapts the real browser constructor to. Event handlers are plain settable
 * properties (`RTCPeerConnection`'s own `on*` style) rather than `addEventListener`, matching the browser API
 * this stands in for and keeping a test fake to the bare minimum. */
export interface RTCPeerConnectionLike {
    addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSenderLike;
    getSenders(): RTCRtpSenderLike[];
    createOffer(): Promise<RTCSessionDescriptionInit>;
    createAnswer(): Promise<RTCSessionDescriptionInit>;
    setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
    setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
    addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
    close(): void;
    onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null;
    ontrack: ((event: { streams: readonly MediaStream[] }) => void) | null;
    onconnectionstatechange: (() => void) | null;
    connectionState: string;
}

export type RTCPeerConnectionFactory = (config: { iceServers: RTCIceServer[] }) => RTCPeerConnectionLike;

/** One other participant currently known to be in the call - `MeshConnectionManager.participants` never includes
 * the local participant themselves (the UI already knows its own name/uid without asking the manager). */
export interface MeshParticipant {
    uid: string;
    name: string;
}

export type MeshEvent =
    | { type: "participant-joined"; participant: MeshParticipant }
    | { type: "participant-left"; uid: string }
    | { type: "remote-stream"; uid: string; stream: MediaStream }
    | { type: "presenter-changed"; uid: string | undefined };
