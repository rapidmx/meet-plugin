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
 * `@rapidmx/react-shared`'s `pushClient.ts` doc comment for the identical guarantee on the mail push channel this
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
 * A pair never moves back up: once on the relay it stays there for the rest of the call.
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
    private readonly selfId: string;

    constructor(private readonly options: MeshConnectionManagerOptions) {
        this.selfId = options.peerId ?? options.selfUid;
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
        const pc = this.options.createPeerConnection({ iceServers: this.options.iceServers });
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
        peer.connectTimer = setTimeout(() => this.fallBack(peer), this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
        return peer;
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
                peer.disconnectTimer ??= setTimeout(() => this.fallBack(peer), this.options.disconnectedGraceMs ?? DEFAULT_DISCONNECTED_GRACE_MS);
                return;
            case "failed":
                this.fallBack(peer);
                return;
            case "closed":
                this.handleBye(peer.uid);
                return;
        }
    }

    /** Records whether a connected pair is direct or relayed through TURN, from the candidate pair ICE selected. */
    private async detectTransport(peer: PeerState): Promise<void> {
        let type: "p2p" | "turn" | "unknown";
        try {
            type = await peer.pc.connectionType();
        } catch {
            type = "unknown";
        }
        // The pair may have moved on (fallen back, left, or dropped again) while the stats were being read.
        if (peer.transport !== "websocket" && this.peers.get(peer.uid) === peer && peer.pc.connectionState === "connected") {
            this.setTransport(peer, type === "turn" ? "turn" : "p2p");
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
        if (isNew) {
            this.emit({ type: "participant-joined", participant: toParticipant(peer) });
            this.sendHello();
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
    return { uid: peer.uid, name: peer.name, audioOn: peer.audioOn, videoOn: peer.videoOn, handRaised: peer.handRaised, transport: peer.transport };
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
