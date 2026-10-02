///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Full-mesh WebRTC connection management: one direct `RTCPeerConnection` per other participant, signaled entirely
 * over the meeting's own push channel (`SignalingChannel` - see `types.ts`) as this plugin's Phase 2
 * `.claude/NOTES.md` entry lays out. Pure state machine, no JSX/DOM rendering - `apps/meet/_CallView.tsx` owns one
 * instance per call and mirrors its events into React state.
 *
 * ## Who calls whom
 *
 * On learning of another participant (via `hello`), a peer connection for that pair is created by whichever side
 * has the lexicographically smaller uid (`isOfferer()`) - a well-known, deterministic, race-free rule for a mesh:
 * both sides independently compute the same answer with no coordination round trip, and exactly one side ever
 * calls `createOffer()` for a given pair.
 *
 * ## Media: two permanent transceivers, tracks swapped in and out
 *
 * Every connection carries one send-and-receive audio transceiver and one send-and-receive video transceiver,
 * whether or not the local participant has a microphone or camera to send yet. The offerer adds them before its
 * offer; the answerer takes the ones the offer created (`claimTransceivers()`) - a browser does not match an offer's
 * m-lines to transceivers the answerer added itself, so adding them up front on both sides leaves the answerer
 * sending nothing at all. A participant who declined permission, has no camera, or turns the camera on halfway
 * through therefore still negotiates both directions from the first offer, and later `setLocalTrack()` calls just
 * `replaceTrack()` on the existing senders - never a renegotiation. (Attaching tracks once at connection creation,
 * as this manager used to, meant a participant with nothing to send at that moment negotiated no media in either
 * direction, for the whole call.)
 * The remote side's tracks are collected into one `MediaStream` per peer (`remote-stream` events), rather than
 * read from `event.streams[0]`: a transceiver whose sender has no track yet announces no stream to the far end.
 *
 * ## Join announcement and roster discovery
 *
 * The channel has no history (a push event published while a socket was down is never replayed - see
 * `@rapidmx/web-client`'s `lib/mail/pushClient.ts` doc comment for the identical guarantee on the mail push channel this
 * one shares its transport with), so a newcomer's `hello` would only reach participants who happened to already be
 * subscribed *and* who joined before them - never the other way around. Every participant who learns of a
 * genuinely new peer (from any message, not just `hello`) therefore echoes its own `hello` right back, once, the
 * first time it becomes aware of that peer - so within one extra round trip everyone converges on the same full
 * roster regardless of join order. This is naturally bounded (each participant echoes at most once per peer it
 * ever discovers) rather than a risk of runaway flooding.
 *
 * Each message is its own `POST`, so nothing guarantees they arrive in the order they were sent. Two consequences
 * are handled here: an `offer` that beats its sender's `hello` creates the peer under a placeholder name that the
 * `hello` then replaces (`participant-updated`), and an ICE candidate that beats its offer is held until the peer
 * exists rather than dropped.
 *
 * ## Participant state, hands and reactions
 *
 * What each participant is sending (`audioOn`/`videoOn`) and whether their hand is up travels in `hello` and in a
 * `state` message on every change (`setLocalState()`), because a remote track gives no dependable signal that its
 * sender stopped. `reaction` messages carry one emoji from `REACTION_EMOJIS`; anything else is ignored.
 *
 * ## Presenter (single-writer screen share)
 *
 * `presenter-claim` is only ever sent locally when `presenterUid` is unset (`claimPresenter()` refuses otherwise).
 * A claim is applied optimistically and locally at once; every recipient (including the claimant) applies the
 * *first* claim it sees. If two claims genuinely race (both sent before either claimant heard the other's), every
 * participant converges on the same winner by resolving the collision deterministically: the lexicographically
 * smaller uid wins, and the losing claimant self-revokes (stops its own share locally and sends
 * `presenter-release`) once it observes the winning claim. See `handlePresenterClaim()`.
 *
 * Sharing a screen is `setLocalTrack("video", screenTrack)`; stopping is `setLocalTrack("video", cameraTrack)`.
 *
 * ## Host moderation (`mute-request`, `kicked`)
 *
 * `sendMuteRequest()`/`sendKick()` send a point-to-point signal to one peer; the manager itself does not decide who
 * may send one - a "host" identity exists only in `_CallView.tsx`, which shows the controls that call these
 * methods to nobody but the host (see `types.ts`'s `SignalMessage` doc comment for why this is cooperative, not
 * enforced, at the signaling layer). Receiving one emits `mute-requested`/`kicked` for the caller to act on; this
 * manager takes no action of its own beyond that - it doesn't mute a track or tear itself down, since a kicked
 * participant's actual departure is `stop()`, which the caller decides to call.
 *
 * ## Talking stick (`talking-stick`)
 *
 * One exclusive "floor" - at most one participant may be unmuted at a time, host-assigned - but unlike presenter,
 * there is no claim race to resolve: only the host's own client ever calls `setTalkingStick()` (same trust level as
 * `sendMuteRequest()`/`sendKick()` - nothing here checks that), so the manager carries no state of its own and
 * simply relays the latest message it sees as `talking-stick-changed`, applying it to itself too via an immediate
 * local emit (the same "optimistic, no round trip" shape `claimPresenter()`/`releasePresenter()` use). A holder who
 * leaves the call is not specially reassigned - every other participant's existing `participant-left` handling
 * already drops them from the roster, and "the stick's holder is no longer in the call" is simply "nobody is holder
 * right now" without any manager needing to say so, until the host picks someone (or themselves) again. There is no
 * backend route or persisted field for this at all: like `mute-request`/`kicked`, it only matters while people are
 * actually in the call together.
 *
 * ## Three media paths, tried in order
 *
 * Each pair of participants reaches for the best path that works, and `MeshParticipant.transport` says which one it
 * got:
 *
 * 1. **Direct peer-to-peer** (`"p2p"`). The `RTCPeerConnection` is given the STUN servers and the TURN server
 * together, and ICE ranks a direct pair above a relayed one, so this is what a pair gets whenever it can.
 * 2. **Relayed through the TURN server** (`"turn"`). The same connection, on the relay candidate ICE falls back to
 * when the direct pairs fail - a participant behind a symmetric NAT or a firewall that blocks direct UDP. Which of
 * the two ICE picked is read from the selected candidate pair once connected (`RTCPeerConnectionLike.connectionType()`).
 * 3. **Proxied by this server over a WebSocket** (`"websocket"`, `apps/shared/relay/`). For a participant whose
 * network lets nothing but ordinary HTTPS out, neither of the above ever connects. A pair whose connection has not
 * come up within `connectTimeoutMs`, has failed, or has stayed `disconnected` for `disconnectedGraceMs` gives up
 * on WebRTC and switches to it, telling the other side with a `relay-fallback` message so both switch even when
 * only one of them noticed. Nothing is renegotiated - the pair simply stops using the `RTCPeerConnection` - and the
 * relay's stream replaces the one WebRTC would have filled (a `remote-stream` event again). When the relay is
 * unavailable (turned off by the operator, or a browser without WebCodecs) the pair is marked `"failed"` and stays
 * in the roster, rather than the participant vanishing with no explanation as it used to.
 *
 * A pair never moves back up: once on the relay it stays there for the rest of the call - except that the whole
 * waterfall is itself only what `"auto"` mode does; see the next section.
 *
 * ## Forcing a transport (`setTransportMode()`)
 *
 * `TransportMode` (`types.ts`) lets a participant override the waterfall above for their own tab: `"p2p"` offers
 * ICE no TURN servers at all and never falls back past a failed direct attempt; `"relay"` sets
 * `RTCPeerConnectionLike`'s `iceTransportPolicy: "relay"` (still real WebRTC, just never direct) and likewise never
 * falls back further; `"websocket"` skips WebRTC negotiation entirely and jumps straight to the server relay for
 * every peer, via the very same `fallBack()` the `"auto"` waterfall uses once it gives up (same cooperative
 * `relay-fallback` notification, same "no relay available -> `failed`" handling - `"websocket"` mode just calls it
 * immediately instead of after a timeout). `"p2p"`/`"relay"` skip the waterfall in the other direction:
 * `giveUpOnWebRTC()` is what `createPeer()`'s connect timeout and `handleConnectionState()`'s `disconnected`/
 * `failed` branches call instead of `fallBack()` directly, and it marks the pair `"failed"` outright in forced
 * `"p2p"`/`"relay"` mode rather than degrading to the relay - a participant who explicitly chose "peer-to-peer
 * only" or "TURN relay only" to troubleshoot a connection does not want it quietly becoming something else.
 *
 * Switching modes mid-call (not just at join) rebuilds every current peer connection under the new policy
 * (`restartPeer()`): the old `RTCPeerConnection` is closed and a fresh one created in its place, exactly as
 * `createPeer()` builds one for a brand-new peer, but keeping the existing roster entry (name/audioOn/videoOn/
 * handRaised) and emitting `participant-updated` rather than a `participant-left`/`participant-joined` pair - from
 * the UI's perspective this looks like the existing `"connecting"` state any reconnect already uses, not someone
 * leaving and rejoining. This can't be done unilaterally: a participant cannot rebuild their own half of a pair
 * without the other side rebuilding its matching half at (almost) the same moment, or the two ends negotiate
 * against two different objects that have no idea about each other. `setTransportMode()` therefore also broadcasts
 * `restart-connection` (no payload beyond the envelope - `types.ts`'s `SignalMessage` doc comment), and every
 * recipient calls `restartPeer()` for just that one sender's connection in response - each side always rebuilds
 * using whatever mode *it* currently has configured, never the sender's, since this is a personal, per-tab choice,
 * not something a meeting agrees on together.
 */
import {
    type MediaTransport,
    type MeshEvent,
    type MeshParticipant,
    type ParticipantState,
    type RTCPeerConnectionFactory,
    type RTCPeerConnectionLike,
    type RTCRtpSenderLike,
    type RelayTransportLike,
    type SignalMessage,
    type SignalingChannel,
    type TransportMode,
    REACTION_EMOJIS,
} from "./types.js";

/** The lexicographically smaller uid is always the offerer for that pair - see this module's doc comment. */
export function isOfferer(selfId: string, peerId: string): boolean {
    return selfId < peerId;
}

/** How many peers' worth of early ICE candidates are held, and how many candidates per peer - bounds the memory a
 * misbehaving participant could make this hold for peers that never materialize. */
const MAX_ORPHAN_PEERS = 32;
const MAX_ORPHAN_CANDIDATES = 64;

/** How long a connection may stay in `connecting` before the pair gives up on WebRTC. ICE with an unreachable TURN
 * server can take the better part of a minute to report `failed`; a person waiting on a call will not. It is still long
 * enough for a slow TURN allocation and a few round trips of signaling. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** How long a connection may stay `disconnected` (ICE lost the path but may still recover) before giving up on it. */
export const DEFAULT_DISCONNECTED_GRACE_MS = 8_000;

/** How often a connected pair's quality stats (the diagnostics panel) are refreshed - low frequency on purpose:
 * this is for a participant occasionally checking why a call feels off, not a live chart, and `getStats()` is not
 * free to call every frame. */
export const DEFAULT_DIAGNOSTICS_POLL_MS = 3_000;

type MediaKind = "audio" | "video";

interface PeerState extends MeshParticipant {
    pc: RTCPeerConnectionLike;
    /** Empty on an answerer until the offer arrives - see `handleOffer()`. */
    senders: Partial<Record<MediaKind, RTCRtpSenderLike>>;
    remoteStream: MediaStream;
    remoteDescriptionSet: boolean;
    pendingCandidates: RTCIceCandidateInit[];
    /** Gives up on WebRTC when the connection is still `connecting` after `connectTimeoutMs`. */
    connectTimer: ReturnType<typeof setTimeout> | undefined;
    /** Gives up on WebRTC when the connection has stayed `disconnected` for `disconnectedGraceMs`. */
    disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    /** Refreshes `diagnostics` (`MeshParticipant`) while this pair is on a real `RTCPeerConnection` - started once
     * it first connects, stopped the moment it leaves WebRTC for the relay or the pair ends. */
    diagnosticsTimer: ReturnType<typeof setInterval> | undefined;
}

export interface MeshConnectionManagerOptions {
    /** The authenticated uid - what `from` must be on the wire (see `SignalMessage.from`). */
    selfUid: string;
    /** This tab's identity in the call, `<selfUid>~<random>` - defaults to `selfUid`. Everything the manager keys on
     * (the roster, who offers, who presents) is a peer id, so two tabs of one account are two participants. */
    peerId?: string;
    selfName: string;
    iceServers: RTCIceServer[];
    channel: SignalingChannel;
    createPeerConnection: RTCPeerConnectionFactory;
    /** The tracks to send from the start - either may be absent (no permission, no device) and supplied or
     * replaced later with `setLocalTrack()`. */
    localAudioTrack?: MediaStreamTrack | null;
    localVideoTrack?: MediaStreamTrack | null;
    /** What to announce at first - defaults to "sending whatever tracks were given, hand down". */
    localState?: Partial<ParticipantState>;
    /** Builds the (initially empty) stream one peer's incoming tracks are gathered into. Defaults to
     * `new MediaStream()`; a test supplies a fake. */
    createMediaStream?: () => MediaStream;
    /** The WebSocket media relay, the last-resort path - see this module's doc comment. Leave unset when the
     * operator has turned it off; without one a pair WebRTC cannot connect is marked `"failed"`. */
    relay?: RelayTransportLike;
    /** Defaults to `DEFAULT_CONNECT_TIMEOUT_MS`. */
    connectTimeoutMs?: number;
    /** Defaults to `DEFAULT_DISCONNECTED_GRACE_MS`. */
    disconnectedGraceMs?: number;
    /** Defaults to `DEFAULT_DIAGNOSTICS_POLL_MS`. */
    diagnosticsPollMs?: number;
    /** Defaults to `"auto"` - see this module's doc comment on `setTransportMode()`. */
    transportMode?: TransportMode;
}

export class MeshConnectionManager {
    private readonly peers = new Map<string, PeerState>();
    private readonly listeners = new Set<(event: MeshEvent) => void>();
    private readonly orphanCandidates = new Map<string, RTCIceCandidateInit[]>();
    private readonly localTracks: Record<MediaKind, MediaStreamTrack | null>;
    private localState: ParticipantState;
    private unsubscribe: (() => void) | undefined;
    private started = false;
    private stopped = false;
    private currentPresenterUid: string | undefined;
    private currentTransportMode: TransportMode;
    private readonly selfId: string;

    constructor(private readonly options: MeshConnectionManagerOptions) {
        this.selfId = options.peerId ?? options.selfUid;
        this.currentTransportMode = options.transportMode ?? "auto";
        this.localTracks = { audio: options.localAudioTrack ?? null, video: options.localVideoTrack ?? null };
        this.localState = {
            audioOn: !!options.localAudioTrack,
            videoOn: !!options.localVideoTrack,
            handRaised: false,
            ...options.localState,
        };
        options.relay?.setLocalTrack("audio", this.localTracks.audio);
        options.relay?.setLocalTrack("video", this.localTracks.video);
    }

    get participants(): MeshParticipant[] {
        return [...this.peers.values()].map((peer) => toParticipant(peer));
    }

    get presenterUid(): string | undefined {
        return this.currentPresenterUid;
    }

    get transportMode(): TransportMode {
        return this.currentTransportMode;
    }

    onEvent(listener: (event: MeshEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Subscribes to the channel and announces this participant. Idempotent - a second call is a no-op. */
    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        this.unsubscribe = this.options.channel.onMessage((message) => this.handleMessage(message));
        this.sendHello();
    }

    /** Announces departure, closes every peer connection and unsubscribes - idempotent, and safe to call whether
     * or not `start()` ever ran. Never removes the camera/microphone indicator itself - stopping the local
     * tracks is the caller's job (see `deviceMedia.ts`'s `stopStream()`), since this manager never owns their
     * lifecycle, only sends them. */
    stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.started) {
            this.send({ kind: "bye" });
        }
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        for (const peer of this.peers.values()) {
            this.clearTimers(peer);
            this.stopDiagnosticsPolling(peer);
            peer.pc.close();
        }
        this.peers.clear();
        this.orphanCandidates.clear();
        this.listeners.clear();
        this.options.relay?.close();
    }

    /** Sets the track sent as `kind` (`null` to send nothing) on every connection, now and for every peer that
     * joins later - see this module's doc comment. */
    setLocalTrack(kind: MediaKind, track: MediaStreamTrack | null): void {
        this.localTracks[kind] = track;
        for (const peer of this.peers.values()) {
            void peer.senders[kind]?.replaceTrack(track);
        }
        this.options.relay?.setLocalTrack(kind, track);
    }

    /** Updates what this participant announces (`audioOn`/`videoOn`/`handRaised`) and tells everyone if anything
     * actually changed. Before `start()` it only records the state, which `hello` then carries. */
    setLocalState(partial: Partial<ParticipantState>): void {
        const next = { ...this.localState, ...partial };
        if (sameState(next, this.localState)) {
            return;
        }
        this.localState = next;
        if (this.started && !this.stopped) {
            this.send({ kind: "state", state: next });
        }
    }

    /** Sends one emoji to everyone. Returns `false`, sending nothing, for an emoji outside `REACTION_EMOJIS`. */
    sendReaction(emoji: string): boolean {
        if (!isReactionEmoji(emoji)) {
            return false;
        }
        this.send({ kind: "reaction", emoji });
        return true;
    }

    /** Claims presenter status for the local participant. Refuses (returns `false`, sends nothing) when someone
     * else already presents - the caller (`_CallView.tsx`) uses this to disable its own "share screen" control
     * rather than let a claim silently do nothing. */
    claimPresenter(): boolean {
        if (this.currentPresenterUid !== undefined && this.currentPresenterUid !== this.selfId) {
            return false;
        }
        this.currentPresenterUid = this.selfId;
        this.send({ kind: "presenter-claim" });
        this.emit({ type: "presenter-changed", uid: this.currentPresenterUid });
        return true;
    }

    /** Releases presenter status - a no-op unless the local participant currently holds it. */
    releasePresenter(): void {
        if (this.currentPresenterUid !== this.selfId) {
            return;
        }
        this.currentPresenterUid = undefined;
        this.send({ kind: "presenter-release" });
        this.emit({ type: "presenter-changed", uid: undefined });
    }

    /** Asks `peerUid`'s participant to mute - a cooperative signal (see this module's doc comment on host
     * moderation), not enforcement. Nothing here checks that the local participant is actually the host; the caller
     * is responsible for only offering this to one. */
    sendMuteRequest(peerUid: string): void {
        this.send({ kind: "mute-request", to: peerUid });
    }

    /** Tells `peerUid`'s participant they have been removed from the call. Sends only the cooperative signal - it
     * does not itself revoke `peerUid`'s server-side channel grant (see `BaseVideoMeetingRoute.revokeChannelGrant()`,
     * which the caller is expected to call alongside this for an enforced removal). */
    sendKick(peerUid: string): void {
        this.send({ kind: "kicked", to: peerUid });
    }

    /** Turns talking-stick mode on (naming `holder`, the initial speaker) or off (`active: false`, `holder`
     * omitted), or hands an already-active stick to a different `holder` - see this module's doc comment on why
     * there is no collision to resolve here, unlike presenter. Broadcasts and applies locally at once, trusting
     * there is only ever one sender; the caller (`_CallView.tsx`) is responsible for only offering this to the
     * host. */
    setTalkingStick(active: boolean, holder?: string): void {
        this.send({ kind: "talking-stick", active, holder });
        this.emit({ type: "talking-stick-changed", active, holder });
    }

    /** Switches this tab's own transport policy - see this module's doc comment on `TransportMode`. A no-op for the
     * mode it already has. Rebuilds every current peer connection under the new policy and, once `start()` has
     * run, tells every peer to rebuild their matching half too (`restart-connection`) - see `restartPeer()`. */
    setTransportMode(mode: TransportMode): void {
        if (this.currentTransportMode === mode) {
            return;
        }
        this.currentTransportMode = mode;
        if (this.started && !this.stopped) {
            this.send({ kind: "restart-connection" });
        }
        for (const uid of [...this.peers.keys()]) {
            this.restartPeer(uid);
        }
    }

    private sendHello(): void {
        this.send({ kind: "hello", name: this.options.selfName, state: this.localState });
    }

    private send(partial: Omit<SignalMessage, "type" | "from">): void {
        this.options.channel.send({ type: "video-meeting-signal", from: this.options.selfUid, peer: this.selfId, ...partial });
    }

    private emit(event: MeshEvent): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }

    private handleMessage(raw: SignalMessage): void {
        if (raw.type !== "video-meeting-signal") {
            return;
        }
        // From here on `from` is the sender's peer id - see `SignalMessage.peer`.
        if (raw.peer !== undefined && raw.peer !== raw.from && !raw.peer.startsWith(`${raw.from}~`)) {
            return;
        }
        const message: SignalMessage = { ...raw, from: raw.peer ?? raw.from };
        if (message.from === this.selfId) {
            return;
        }
        if (message.to !== undefined && message.to !== this.selfId) {
            return;
        }
        switch (message.kind) {
            case "hello":
                this.handleHello(message);
                return;
            case "bye":
                this.handleBye(message.from);
                return;
            case "offer":
                void this.handleOffer(message);
                return;
            case "answer":
                void this.handleAnswer(message);
                return;
            case "ice-candidate":
                void this.handleIceCandidate(message);
                return;
            case "presenter-claim":
                this.handlePresenterClaim(message.from);
                return;
            case "presenter-release":
                this.handlePresenterRelease(message.from);
                return;
            case "state":
                this.handleState(message);
                return;
            case "reaction":
                this.handleReaction(message);
                return;
            case "relay-fallback":
                this.handleRelayFallback(message.from);
                return;
            case "mute-request":
                this.emit({ type: "mute-requested" });
                return;
            case "kicked":
                this.emit({ type: "kicked" });
                return;
            case "talking-stick":
                this.emit({ type: "talking-stick-changed", active: message.active === true, holder: typeof message.holder === "string" ? message.holder : undefined });
                return;
            case "restart-connection":
                this.restartPeer(message.from);
                return;
        }
    }

    private handleHello(message: SignalMessage): void {
        const known = this.peers.get(message.from);
        if (known) {
            // An offer that beat this hello created the peer under a placeholder name - fill in the real one.
            this.updatePeer(known, message.name, message.state);
            return;
        }
        const offerer = isOfferer(this.selfId, message.from);
        const peer = this.createPeer(message.from, message.name ?? message.from, message.state, offerer);
        this.emit({ type: "participant-joined", participant: toParticipant(peer) });
        // Let a newcomer who couldn't have seen our own original `hello` learn about us too - see this module's
        // doc comment on roster discovery.
        this.sendHello();
        if (this.currentTransportMode === "websocket") {
            // Forced relay-only: don't negotiate WebRTC at all - see this module's doc comment on `setTransportMode()`.
            this.fallBack(peer, true);
            return;
        }
        if (offerer) {
            void this.initiateOffer(peer);
        }
    }

    private handleState(message: SignalMessage): void {
        const peer = this.peers.get(message.from);
        if (peer) {
            this.updatePeer(peer, undefined, message.state);
        }
    }

    private handleReaction(message: SignalMessage): void {
        const peer = this.peers.get(message.from);
        if (peer && isReactionEmoji(message.emoji)) {
            this.emit({ type: "reaction", uid: peer.uid, name: peer.name, emoji: message.emoji });
        }
    }

    /** Applies a newly learned name and/or state to `peer`, emitting `participant-updated` (and `hand-raised` on a
     * hand going up) only when something actually changed. */
    private updatePeer(peer: PeerState, name: string | undefined, state: ParticipantState | undefined): void {
        const nextName = name ?? peer.name;
        const next = state ? sanitizeState(state) : undefined;
        const handWentUp = !!next && next.handRaised && !peer.handRaised;
        if (nextName === peer.name && (!next || sameState(next, peer))) {
            return;
        }
        peer.name = nextName;
        if (next) {
            peer.audioOn = next.audioOn;
            peer.videoOn = next.videoOn;
            peer.handRaised = next.handRaised;
        }
        this.emit({ type: "participant-updated", participant: toParticipant(peer) });
        if (handWentUp) {
            this.emit({ type: "hand-raised", uid: peer.uid, name: peer.name });
        }
    }

    private handleBye(uid: string): void {
        this.orphanCandidates.delete(uid);
        const peer = this.peers.get(uid);
        if (!peer) {
            return;
        }
        this.clearTimers(peer);
        this.stopDiagnosticsPolling(peer);
        peer.pc.close();
        this.peers.delete(uid);
        if (peer.transport === "websocket") {
            this.options.relay?.stopReceivingFrom(uid);
            this.syncRelaySending();
        }
        this.emit({ type: "participant-left", uid });
        if (this.currentPresenterUid === uid) {
            this.currentPresenterUid = undefined;
            this.emit({ type: "presenter-changed", uid: undefined });
        }
    }

    private createPeer(uid: string, name: string, state: ParticipantState | undefined, offerer: boolean): PeerState {
        const pc = this.options.createPeerConnection(this.pcConfig());
        const peer: PeerState = {
            uid,
            name,
            ...(state ? sanitizeState(state) : { audioOn: false, videoOn: false, handRaised: false }),
            pc,
            senders: offerer
                ? {
                      audio: pc.addTransceiver("audio", this.localTracks.audio).sender,
                      video: pc.addTransceiver("video", this.localTracks.video).sender,
                  }
                : {},
            remoteStream: (this.options.createMediaStream ?? (() => new MediaStream()))(),
            remoteDescriptionSet: false,
            pendingCandidates: this.orphanCandidates.get(uid) ?? [],
            transport: "connecting",
            connectTimer: undefined,
            disconnectTimer: undefined,
            diagnosticsTimer: undefined,
        };
        this.orphanCandidates.delete(uid);
        this.peers.set(uid, peer);
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.send({ kind: "ice-candidate", to: uid, candidate: event.candidate });
            }
        };
        pc.ontrack = (event) => {
            if (!peer.remoteStream.getTracks().includes(event.track)) {
                peer.remoteStream.addTrack(event.track);
            }
            this.emit({ type: "remote-stream", uid, stream: peer.remoteStream });
        };
        pc.onconnectionstatechange = () => this.handleConnectionState(peer);
        // Cleared the moment the connection comes up, so this only ever fires for a pair still waiting on WebRTC.
        peer.connectTimer = setTimeout(() => this.giveUpOnWebRTC(peer), this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
        return peer;
    }

    /** The `RTCPeerConnection` config for a peer created right now - `this.options.iceServers` as given for `"auto"`
     * and `"websocket"` (the latter never actually uses them - see `handleHello()`/`handleOffer()`), STUN-only (no
     * TURN offered to ICE at all) for `"p2p"`, and the same servers with `iceTransportPolicy: "relay"` for
     * `"relay"` - see this module's doc comment on `TransportMode`. */
    private pcConfig(): { iceServers: RTCIceServer[]; iceTransportPolicy?: "all" | "relay" } {
        switch (this.currentTransportMode) {
            case "p2p":
                return { iceServers: stunOnlyServers(this.options.iceServers) };
            case "relay":
                return { iceServers: this.options.iceServers, iceTransportPolicy: "relay" };
            default:
                return { iceServers: this.options.iceServers };
        }
    }

    /** Reacts to the peer connection's state: notes which path a connected pair got, and gives up on WebRTC for a
     * pair that failed or stays disconnected - see `fallBack()`. Ignores a pair that already left WebRTC. */
    private handleConnectionState(peer: PeerState): void {
        if (peer.transport === "websocket" || this.peers.get(peer.uid) !== peer) {
            return;
        }
        switch (peer.pc.connectionState) {
            case "connected":
                this.clearTimers(peer);
                void this.detectTransport(peer);
                return;
            case "disconnected":
                // ICE often recovers from this on its own, so it is only given up on after a grace period.
                peer.disconnectTimer ??= setTimeout(() => this.giveUpOnWebRTC(peer), this.options.disconnectedGraceMs ?? DEFAULT_DISCONNECTED_GRACE_MS);
                return;
            case "failed":
                this.giveUpOnWebRTC(peer);
                return;
            case "closed":
                this.handleBye(peer.uid);
                return;
        }
    }

    /** Records whether a connected pair is direct, relayed through TURN, or relayed through TURN over TCP (see
     * `MediaTransport`'s doc comment), from the candidate pair ICE selected. */
    private async detectTransport(peer: PeerState): Promise<void> {
        let type: "p2p" | "turn" | "turn-tcp" | "unknown";
        try {
            type = await peer.pc.connectionType();
        } catch {
            type = "unknown";
        }
        // The pair may have moved on (fallen back, left, or dropped again) while the stats were being read.
        if (peer.transport !== "websocket" && this.peers.get(peer.uid) === peer && peer.pc.connectionState === "connected") {
            this.setTransport(peer, type === "turn" || type === "turn-tcp" ? type : "p2p");
            this.startDiagnosticsPolling(peer);
        }
    }

    /** Idempotent - a pair that reconnects without ever leaving WebRTC (`connected` -> `disconnected` -> `connected`
     * again) does not get a second timer. */
    private startDiagnosticsPolling(peer: PeerState): void {
        if (peer.diagnosticsTimer !== undefined) {
            return;
        }
        const pollMs = this.options.diagnosticsPollMs ?? DEFAULT_DIAGNOSTICS_POLL_MS;
        peer.diagnosticsTimer = setInterval(() => void this.pollDiagnostics(peer), pollMs);
        void this.pollDiagnostics(peer); // the first sample doesn't wait a full interval
    }

    private stopDiagnosticsPolling(peer: PeerState): void {
        clearInterval(peer.diagnosticsTimer);
        peer.diagnosticsTimer = undefined;
    }

    private async pollDiagnostics(peer: PeerState): Promise<void> {
        let diagnostics: MeshParticipant["diagnostics"];
        try {
            diagnostics = await peer.pc.collectDiagnostics();
        } catch {
            // Leaves whatever was last polled in place rather than blanking a momentary failure.
            return;
        }
        // The pair may have moved on (fallen back, left, or dropped again) while the stats were being read.
        if (this.peers.get(peer.uid) === peer && peer.diagnosticsTimer !== undefined) {
            peer.diagnostics = diagnostics;
            this.emit({ type: "participant-updated", participant: toParticipant(peer) });
        }
    }

    private setTransport(peer: PeerState, transport: MediaTransport): void {
        if (peer.transport !== transport) {
            peer.transport = transport;
            this.emit({ type: "participant-updated", participant: toParticipant(peer) });
        }
    }

    private clearTimers(peer: PeerState): void {
        clearTimeout(peer.connectTimer);
        clearTimeout(peer.disconnectTimer);
        peer.connectTimer = undefined;
        peer.disconnectTimer = undefined;
    }

    /** What a connect timeout or a `"disconnected"`/`"failed"` connection state means for `peer`: `fallBack()` to
     * the relay for `"auto"` mode (unchanged from before `TransportMode` existed), but `"failed"` outright for a
     * forced `"p2p"`/`"relay"` mode - see this module's doc comment on why those two never degrade further.
     * `"websocket"` mode never reaches here at all: `handleHello()`/`handleOffer()` call `fallBack()` immediately
     * on peer creation, well before a connect timeout could ever fire. */
    private giveUpOnWebRTC(peer: PeerState): void {
        if (this.currentTransportMode !== "p2p" && this.currentTransportMode !== "relay") {
            this.fallBack(peer);
            return;
        }
        /* v8 ignore if -- unreachable via real usage: unlike `fallBack()` (also callable directly from
           `handleRelayFallback()`, which is how its own identical-looking guard is actually exercised),
           `giveUpOnWebRTC()`'s only callers are `createPeer()`'s connect timer and `handleConnectionState()`'s
           disconnect timer/`"failed"` case - and every transition that could make either side of this true
           (`fallBack()` moving a peer to `"websocket"`, `restartPeer()` replacing the map entry) clears this
           peer's pending timers first, so a stale timer referencing this exact peer object never fires. Kept for
           the same reason `fallBack()`'s guard is - a future caller that doesn't pre-clear timers should fail
           safe, not corrupt an already-superseded peer. */
        if (peer.transport === "websocket" || this.peers.get(peer.uid) !== peer) {
            return;
        }
        this.clearTimers(peer);
        this.stopDiagnosticsPolling(peer);
        this.setTransport(peer, "failed");
    }

    /**
     * Gives up on WebRTC for `peer` and moves the pair to the WebSocket relay (the third path - see this module's doc
     * comment), or marks it `"failed"` when there is no relay to move to. `notify` tells the other side, which may not
     * have noticed yet; a pair told by the other side does not tell it back.
     */
    private fallBack(peer: PeerState, notify = true): void {
        if (peer.transport === "websocket" || this.peers.get(peer.uid) !== peer) {
            return;
        }
        this.clearTimers(peer);
        this.stopDiagnosticsPolling(peer);
        peer.diagnostics = undefined;
        const relay = this.options.relay;
        if (!relay?.supported) {
            this.setTransport(peer, "failed");
            return;
        }
        // Stop listening to the dead connection before closing it, so closing it cannot be mistaken for the peer leaving.
        peer.pc.onconnectionstatechange = null;
        peer.pc.onicecandidate = null;
        peer.pc.ontrack = null;
        peer.pc.close();
        peer.transport = "websocket";
        relay.receiveFrom(peer.uid, (stream) => {
            peer.remoteStream = stream;
            this.emit({ type: "remote-stream", uid: peer.uid, stream });
        });
        this.syncRelaySending();
        this.emit({ type: "participant-updated", participant: toParticipant(peer) });
        if (notify) {
            this.send({ kind: "relay-fallback", to: peer.uid });
        }
    }

    private handleRelayFallback(from: string): void {
        const peer = this.peers.get(from);
        if (peer) {
            this.fallBack(peer, false);
        }
    }

    /** The relay only encodes and uploads the local media while at least one pair is actually using it. */
    private syncRelaySending(): void {
        this.options.relay?.setSending([...this.peers.values()].some((peer) => peer.transport === "websocket"));
    }

    /** Rebuilds `uid`'s connection from scratch under the current `TransportMode` - see this module's doc comment
     * on `setTransportMode()`. A no-op if `uid` isn't a known peer (already left). Keeps the roster entry (name and
     * announced state) and emits `participant-updated`, not a `participant-left`/`participant-joined` pair - from
     * the UI's perspective this is the same `"connecting"` state any other reconnect already shows, not someone
     * leaving and rejoining. */
    private restartPeer(uid: string): void {
        const old = this.peers.get(uid);
        if (!old) {
            return;
        }
        this.clearTimers(old);
        this.stopDiagnosticsPolling(old);
        // Stop listening to the dying connection before closing it - same ordering `fallBack()` uses, and for the
        // same reason: closing it must never be mistaken for the peer leaving.
        old.pc.onconnectionstatechange = null;
        old.pc.onicecandidate = null;
        old.pc.ontrack = null;
        old.pc.close();
        if (old.transport === "websocket") {
            this.options.relay?.stopReceivingFrom(uid);
        }
        const offerer = isOfferer(this.selfId, uid);
        const fresh = this.createPeer(uid, old.name, { audioOn: old.audioOn, videoOn: old.videoOn, handRaised: old.handRaised }, offerer);
        if (this.currentTransportMode === "websocket") {
            this.fallBack(fresh, true);
            return;
        }
        // In case `old` was the relay's only remaining user - `fresh` starts on WebRTC, not the relay.
        this.syncRelaySending();
        this.emit({ type: "participant-updated", participant: toParticipant(fresh) });
        if (offerer) {
            void this.initiateOffer(fresh);
        }
    }

    private async initiateOffer(peer: PeerState): Promise<void> {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        this.send({ kind: "offer", to: peer.uid, sdp: offer });
    }

    private async handleOffer(message: SignalMessage): Promise<void> {
        if (!message.sdp) {
            return;
        }
        let peer = this.peers.get(message.from);
        const isNew = !peer;
        if (!peer) {
            peer = this.createPeer(message.from, message.from, undefined, false);
        }
        if (isNew) {
            this.emit({ type: "participant-joined", participant: toParticipant(peer) });
            this.sendHello();
        }
        if (this.currentTransportMode === "websocket") {
            // Forced relay-only: don't bother negotiating this offer at all - see this module's doc comment on
            // `setTransportMode()`. Also tells the offerer (`relay-fallback`), so they don't wait out their own
            // connect timeout for an answer that was never coming.
            this.fallBack(peer, true);
            return;
        }
        await peer.pc.setRemoteDescription(message.sdp);
        this.flushPendingCandidates(peer);
        if (!peer.senders.audio && !peer.senders.video) {
            // The answerer's half of the media setup - see this module's doc comment.
            peer.senders = peer.pc.claimTransceivers();
            for (const kind of ["audio", "video"] as const) {
                const track = this.localTracks[kind];
                if (track) {
                    await peer.senders[kind]?.replaceTrack(track);
                }
            }
        }
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.send({ kind: "answer", to: peer.uid, sdp: answer });
    }

    private async handleAnswer(message: SignalMessage): Promise<void> {
        const peer = this.peers.get(message.from);
        if (!peer || !message.sdp) {
            return;
        }
        await peer.pc.setRemoteDescription(message.sdp);
        this.flushPendingCandidates(peer);
    }

    private async handleIceCandidate(message: SignalMessage): Promise<void> {
        if (!message.candidate) {
            return;
        }
        const peer = this.peers.get(message.from);
        if (!peer) {
            // A candidate that raced ahead of its own offer (each message is a separate `POST`) - hold it for
            // the peer to claim when it is created. Bounded, see `MAX_ORPHAN_PEERS`.
            const held = this.orphanCandidates.get(message.from);
            if (held) {
                if (held.length < MAX_ORPHAN_CANDIDATES) {
                    held.push(message.candidate);
                }
            } else if (this.orphanCandidates.size < MAX_ORPHAN_PEERS) {
                this.orphanCandidates.set(message.from, [message.candidate]);
            }
            return;
        }
        if (!peer.remoteDescriptionSet) {
            peer.pendingCandidates.push(message.candidate);
            return;
        }
        await peer.pc.addIceCandidate(message.candidate);
    }

    private flushPendingCandidates(peer: PeerState): void {
        peer.remoteDescriptionSet = true;
        const pending = peer.pendingCandidates;
        peer.pendingCandidates = [];
        for (const candidate of pending) {
            void peer.pc.addIceCandidate(candidate);
        }
    }

    private handlePresenterClaim(from: string): void {
        if (this.currentPresenterUid === undefined) {
            this.currentPresenterUid = from;
            this.emit({ type: "presenter-changed", uid: from });
            return;
        }
        if (this.currentPresenterUid === from) {
            return;
        }
        // Collision: a claim from someone other than the presenter we already recorded. Resolve deterministically
        // - see this module's doc comment - so every participant converges on the same winner. When the
        // already-recorded presenter has the smaller uid, it wins and nothing changes here - including when that
        // presenter is this participant itself, whose own optimistic claim simply stays in place.
        if (from < this.currentPresenterUid) {
            const loser = this.currentPresenterUid;
            this.currentPresenterUid = from;
            this.emit({ type: "presenter-changed", uid: from });
            if (loser === this.selfId) {
                this.send({ kind: "presenter-release" });
            }
        }
    }

    private handlePresenterRelease(from: string): void {
        if (this.currentPresenterUid === from) {
            this.currentPresenterUid = undefined;
            this.emit({ type: "presenter-changed", uid: undefined });
        }
    }
}

function toParticipant(peer: PeerState): MeshParticipant {
    return {
        uid: peer.uid,
        name: peer.name,
        audioOn: peer.audioOn,
        videoOn: peer.videoOn,
        handRaised: peer.handRaised,
        transport: peer.transport,
        diagnostics: peer.diagnostics,
    };
}

function sameState(a: ParticipantState, b: ParticipantState): boolean {
    return a.audioOn === b.audioOn && a.videoOn === b.videoOn && a.handRaised === b.handRaised;
}

/** Copies only the three booleans out of a received state, coerced - a message off the wire is untrusted. */
function sanitizeState(state: ParticipantState): ParticipantState {
    return { audioOn: state.audioOn === true, videoOn: state.videoOn === true, handRaised: state.handRaised === true };
}

function isReactionEmoji(emoji: unknown): emoji is (typeof REACTION_EMOJIS)[number] {
    return (REACTION_EMOJIS as readonly unknown[]).includes(emoji);
}

/** `servers` with every entry that names so much as one `turn:`/`turns:` url dropped - what `"p2p"` mode gives ICE,
 * so it has no TURN relay candidate to ever produce. A `stun:`/`stuns:`-only entry (the normal shape this app's own
 * `buildIceServers()` produces - one STUN entry, one TURN entry) is kept as-is. */
function stunOnlyServers(servers: RTCIceServer[]): RTCIceServer[] {
    return servers.filter((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.every((url) => url.startsWith("stun:") || url.startsWith("stuns:"));
    });
}
