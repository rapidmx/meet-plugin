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

/** Which media path this participant's own tab currently insists on, for every peer - see
 * `MeshConnectionManager.setTransportMode()`'s doc comment for what each one actually does:
 *
 * - `"auto"`: the default waterfall (direct, then TURN, then the server's own WebSocket relay) - unchanged behavior.
 * - `"p2p"`: direct connections only - no TURN server offered to ICE, and a pair that can't connect directly stays
 * `"failed"` rather than falling back to the WebSocket relay.
 * - `"relay"`: TURN-relayed WebRTC only (`RTCPeerConnection`'s own `iceTransportPolicy: "relay"`) - still real
 * WebRTC, just never direct; a pair with no reachable TURN server stays `"failed"`, same "no further fallback" rule
 * as `"p2p"`.
 * - `"websocket"`: skips WebRTC negotiation entirely for every pair and goes straight to the server's own relay.
 *
 * A purely personal, per-tab troubleshooting choice - never transmitted as a setting, and independent of whatever
 * every other participant has chosen for their own tab. */
export type TransportMode = "auto" | "p2p" | "relay" | "websocket";

/**
 * One WebRTC signaling message, published as the JSON body of `POST /push/:meetingUid` (`BasePushRoute.send()`)
 * and received back over `/push`'s WebSocket, exactly as `BaseVideoMeetingRoute`'s doc comment describes ("SDP
 * offers/answers and ICE candidates are ordinary `NotificationUtils.sendMessage()` payloads"). `type` is a fixed
 * literal so a listener on the meeting's channel (which will also see other frame shapes if this server ever
 * grows other push consumers) can cheaply recognize and skip anything that isn't one of these.
 *
 * `hello`/`bye`/`presenter-claim`/`presenter-release`/`state`/`reaction`/`talking-stick` are broadcast (`to` left
 * unset - every participant is relevant); `offer`/`answer`/`ice-candidate`/`mute-request`/`kicked` are
 * point-to-point (`to` is the intended peer's uid) - a recipient that isn't `to` (when set) ignores the message,
 * since a channel's pub/sub fans every message out to every subscriber, sender included.
 *
 * `mute-request`/`kicked`/`talking-stick` are host moderation signals (see `MeshConnectionManager`'s doc comment) -
 * purely cooperative, like every other message here: the recipient's own client decides whether to honor one, and
 * nothing on the wire distinguishes a genuine host's message from any other participant's, since this client
 * protocol has no host identity of its own to check against server-side. `kicked` is paired with the sender also
 * revoking the recipient's server-side channel grant (`BaseVideoMeetingRoute.revokeChannelGrant()`), which is
 * enforced and does not depend on the recipient's client cooperating; `talking-stick` has no server-side
 * counterpart at all (see this module's doc comment on why it is purely an in-call runtime signal).
 *
 * `restart-connection` is broadcast whenever a participant changes their own `TransportMode`
 * (`MeshConnectionManager.setTransportMode()`): every connection of theirs needs rebuilding under the new policy,
 * and a recipient can't rebuild its own half of a pair unilaterally without the other side doing the same at
 * (almost) the same moment, or the two sides end up negotiating against two different `RTCPeerConnection`s. No
 * payload beyond the envelope - `from` already says whose connection to rebuild.
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
        | "reaction"
        | "relay-fallback"
        | "mute-request"
        | "kicked"
        | "talking-stick"
        | "restart-connection";
    /** The sender's authenticated uid - the real caller's own uid when `join()` returned `authenticated: true`, else
     * the `guest:<random>` uid `BaseVideoMeetingRoute.join()` minted. The server refuses a published message whose
     * `from` isn't the authenticated caller's uid (it stops one participant speaking as another), so this must be
     * exactly that uid. */
    from: string;
    /** Which of the sender's tabs or devices this is: `<from>~<random>`. The same account joining from two devices is
     * two participants, not one that ignores its own messages. A `peer` that doesn't start with `<from>~` is
     * ignored, so it can't name someone else's tab. Absent from a sender that predates it (the participant is then
     * identified by `from`). */
    peer?: string;
    /** Set only on a point-to-point message (`offer`/`answer`/`ice-candidate`/`relay-fallback`). */
    to?: string;
    /** `hello` only - the display name the sender chose in the lobby. */
    name?: string;
    /** `hello` and `state` - what the sender is currently sending and whether their hand is up. */
    state?: ParticipantState;
    /** `reaction` only - one of `REACTION_EMOJIS`. */
    emoji?: string;
    /** `talking-stick` only - whether talking-stick mode is currently on. */
    active?: boolean;
    /** `talking-stick` only - the peer id (`MeshParticipant.uid`/this tab's own id) currently holding the stick.
     * Absent when `active` is `false`, or when nobody holds it yet. */
    holder?: string;
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

/** One kind's RTP stream stats, as of one sample - cumulative counters (`bytesSent`/`bytesReceived`), not a rate,
 * since a single `getStats()` snapshot has no "since when" to divide by; a caller wanting a bitrate keeps the
 * previous sample itself and divides the difference by the elapsed time (see `MeshConnectionManager`'s poller).
 * `undefined` for anything this browser (or this stream's direction - an audio-only connection reports nothing for
 * video, and vice versa) doesn't report. */
export interface RtpStreamDiagnostics {
    packetsLost?: number;
    /** Seconds. */
    jitter?: number;
    bytesSent?: number;
    bytesReceived?: number;
}

/** One point-in-time sample of a connection's own quality stats, for the diagnostics panel. */
export interface ConnectionDiagnostics {
    /** Seconds - the selected candidate pair's own current round-trip time. `undefined` when this browser doesn't
     * report one (a connection still connecting, or simply not supported). */
    roundTripTimeSeconds?: number;
    audio: RtpStreamDiagnostics;
    video: RtpStreamDiagnostics;
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
    /** Which path the connected pair is using - read from the selected candidate pair once `connectionState` is
     * `connected`. `"unknown"` when the browser does not report one (treated as direct by the caller). */
    connectionType(): Promise<"p2p" | "turn" | "turn-tcp" | "unknown">;
    /** One point-in-time sample of this connection's own quality stats, for the diagnostics panel - polled
     * periodically and independently of `connectionType()` (see `MeshConnectionManager`'s doc comment). */
    collectDiagnostics(): Promise<ConnectionDiagnostics>;
}

/** Which of the three media paths a participant's audio and video currently take, in the order they are tried:
 *
 * - `"p2p"`: a direct peer-to-peer WebRTC connection, the preferred path.
 * - `"turn"`: still WebRTC, but relayed through the TURN server, for a participant a direct path cannot reach.
 * - `"turn-tcp"`: the same, but the relay hop itself is TCP (or `turns:`, TLS being TCP-based too) rather than UDP -
 * a network that blocks UDP outright. TCP's reliable, ordered delivery means one lost or delayed packet stalls
 * everything queued behind it instead of just being dropped, so this can sound like pauses rather than the clicks
 * plain packet loss would - worth telling apart from ordinary `"turn"` for exactly that reason.
 * - `"websocket"`: not WebRTC at all - encoded frames proxied by this server over a WebSocket (see
 * `apps/shared/relay/`), the last resort when neither of the above connects.
 * - `"connecting"`: no path established yet. `"failed"`: every path this browser can try has failed. */
export type MediaTransport = "connecting" | "p2p" | "turn" | "turn-tcp" | "websocket" | "failed";

/** What `MeshConnectionManager` needs from the WebSocket media relay (`apps/shared/relay/RelayTransport.ts` implements
 * it) - declared here so the mesh, and its tests, depend on the shape alone. */
export interface RelayTransportLike {
    /** `false` when this browser cannot do it (no WebSocket, no WebCodecs) - the mesh then never falls back to it. */
    readonly supported: boolean;
    /** Starts receiving `peerId`'s media. `onStream` is given the `MediaStream` that plays it. */
    receiveFrom(peerId: string, onStream: (stream: MediaStream) => void): void;
    stopReceivingFrom(peerId: string): void;
    /** Starts or stops publishing the local tracks to the relay. */
    setSending(active: boolean): void;
    /** Same as `MeshConnectionManager.setLocalTrack()` - `null` sends nothing for that kind. */
    setLocalTrack(kind: "audio" | "video", track: MediaStreamTrack | null): void;
    close(): void;
}

/** `iceTransportPolicy` mirrors the real `RTCConfiguration` field of the same name - `"relay"` forces ICE to use
 * only a TURN relay candidate, never a direct one (`TransportMode.relay`); omitted (or `"all"`) is the ordinary,
 * unconstrained default. */
export type RTCPeerConnectionFactory = (config: { iceServers: RTCIceServer[]; iceTransportPolicy?: "all" | "relay" }) => RTCPeerConnectionLike;

/** One other participant currently known to be in the call - `MeshConnectionManager.participants` never includes
 * the local participant themselves (the UI already knows its own name/uid without asking the manager). */
export interface MeshParticipant extends ParticipantState {
    uid: string;
    name: string;
    /** How this participant's media currently reaches the local one - see `MediaTransport`. */
    transport: MediaTransport;
    /** This connection's most recently polled quality stats, for the diagnostics panel - `undefined` until the
     * first poll completes (shortly after `transport` first leaves `"connecting"`), and never present at all for
     * a `"websocket"`-relayed participant (there is no `RTCPeerConnection` to poll). */
    diagnostics?: ConnectionDiagnostics;
}

export type MeshEvent =
    | { type: "participant-joined"; participant: MeshParticipant }
    | { type: "participant-updated"; participant: MeshParticipant }
    | { type: "participant-left"; uid: string }
    | { type: "remote-stream"; uid: string; stream: MediaStream }
    | { type: "hand-raised"; uid: string; name: string }
    | { type: "reaction"; uid: string; name: string; emoji: string }
    | { type: "presenter-changed"; uid: string | undefined }
    /** Someone (implicitly the host, on the client's own say-so - see `SignalMessage`'s doc comment) asked the local
     * participant to mute. The caller (`_CallView.tsx`) mutes only if currently unmuted; this never unmutes anyone. */
    | { type: "mute-requested" }
    /** The local participant was removed from the call. The caller tears down the mesh and shows a distinct
     * "removed by the host" state rather than the ordinary "you left" one. */
    | { type: "kicked" }
    /** Talking-stick mode turned on or off, or the stick changed hands - see this module's doc comment and
     * `MeshConnectionManager.setTalkingStick()`. `holder` is the peer id now holding it; absent while `active` is
     * `false`, or (transiently) if whoever held it has since left the call. */
    | { type: "talking-stick-changed"; active: boolean; holder?: string };
