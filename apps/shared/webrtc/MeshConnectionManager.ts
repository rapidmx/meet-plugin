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
 * ## Presenter (single-writer screen share)
 *
 * `presenter-claim` is only ever sent locally when `presenterUid` is unset (`claimPresenter()` refuses otherwise).
 * A claim is applied optimistically and locally at once; every recipient (including the claimant) applies the
 * *first* claim it sees. If two claims genuinely race (both sent before either claimant heard the other's), every
 * participant converges on the same winner by resolving the collision deterministically: the lexicographically
 * smaller uid wins, and the losing claimant self-revokes (stops its own share locally and sends
 * `presenter-release`) once it observes the winning claim. See `handlePresenterClaim()`.
 *
 * ## Presentation mode's screen share
 *
 * Sharing a screen never adds a second video track or renegotiates a connection - `replaceLocalVideoTrack()`
 * simply swaps each peer connection's existing outgoing video `RTCRtpSender`'s track (`sender.replaceTrack()`),
 * the same track object already flowing to everyone from the moment they joined. Stopping a share replaces it
 * back to the camera track the same way.
 */
import type { MeshEvent, MeshParticipant, RTCPeerConnectionFactory, RTCPeerConnectionLike, SignalMessage, SignalingChannel } from "./types.js";

/** The lexicographically smaller uid is always the offerer for that pair - see this module's doc comment. */
export function isOfferer(selfUid: string, peerUid: string): boolean {
    return selfUid < peerUid;
}

interface PeerState {
    uid: string;
    name: string;
    pc: RTCPeerConnectionLike;
    remoteDescriptionSet: boolean;
    pendingCandidates: RTCIceCandidateInit[];
}

export interface MeshConnectionManagerOptions {
    selfUid: string;
    selfName: string;
    iceServers: RTCIceServer[];
    channel: SignalingChannel;
    createPeerConnection: RTCPeerConnectionFactory;
    /** The local camera/microphone stream, attached to every new peer connection as it's created. */
    localStream: MediaStream;
}

export class MeshConnectionManager {
    private readonly peers = new Map<string, PeerState>();
    private readonly listeners = new Set<(event: MeshEvent) => void>();
    private unsubscribe: (() => void) | undefined;
    private started = false;
    private stopped = false;
    private currentPresenterUid: string | undefined;

    constructor(private readonly options: MeshConnectionManagerOptions) {}

    get participants(): MeshParticipant[] {
        return [...this.peers.values()].map((peer) => ({ uid: peer.uid, name: peer.name }));
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
     * or not `start()` ever ran. Never removes the camera/microphone indicator itself - stopping `localStream`'s
     * own tracks is the caller's job (see `deviceMedia.ts`'s `stopStream()`), since this manager never owns that
     * stream's lifecycle, only attaches it. */
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
            peer.pc.close();
        }
        this.peers.clear();
        this.listeners.clear();
    }

    /** Swaps every peer connection's outgoing video track (presentation mode) - see this module's doc comment.
     * `track` is `null` to stop sending video at all (never used by this plugin's UI today, which always has a
     * camera-or-screen track to fall back to, but kept correct since `RTCRtpSender.replaceTrack()` itself allows
     * it). */
    replaceLocalVideoTrack(track: MediaStreamTrack | null): void {
        for (const peer of this.peers.values()) {
            const sender = peer.pc.getSenders().find((s) => s.track?.kind === "video");
            void sender?.replaceTrack(track);
        }
    }

    /** Claims presenter status for the local participant. Refuses (returns `false`, sends nothing) when someone
     * else already presents - the caller (`_CallView.tsx`) uses this to disable its own "share screen" control
     * rather than let a claim silently do nothing. */
    claimPresenter(): boolean {
        if (this.currentPresenterUid !== undefined && this.currentPresenterUid !== this.options.selfUid) {
            return false;
        }
        this.currentPresenterUid = this.options.selfUid;
        this.send({ kind: "presenter-claim" });
        this.emit({ type: "presenter-changed", uid: this.currentPresenterUid });
        return true;
    }

    /** Releases presenter status - a no-op unless the local participant currently holds it. */
    releasePresenter(): void {
        if (this.currentPresenterUid !== this.options.selfUid) {
            return;
        }
        this.currentPresenterUid = undefined;
        this.send({ kind: "presenter-release" });
        this.emit({ type: "presenter-changed", uid: undefined });
    }

    private sendHello(): void {
        this.send({ kind: "hello", name: this.options.selfName });
    }

    private send(partial: Omit<SignalMessage, "type" | "from">): void {
        this.options.channel.send({ type: "video-meeting-signal", from: this.options.selfUid, ...partial });
    }

    private emit(event: MeshEvent): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }

    private handleMessage(message: SignalMessage): void {
        if (message.type !== "video-meeting-signal" || message.from === this.options.selfUid) {
            return;
        }
        if (message.to !== undefined && message.to !== this.options.selfUid) {
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
        }
    }

    private handleHello(message: SignalMessage): void {
        if (this.peers.has(message.from)) {
            return;
        }
        const name = message.name ?? message.from;
        const peer = this.createPeer(message.from, name);
        this.emit({ type: "participant-joined", participant: { uid: peer.uid, name: peer.name } });
        // Let a newcomer who couldn't have seen our own original `hello` learn about us too - see this module's
        // doc comment on roster discovery.
        this.sendHello();
        if (isOfferer(this.options.selfUid, message.from)) {
            void this.initiateOffer(peer);
        }
    }

    private handleBye(uid: string): void {
        const peer = this.peers.get(uid);
        if (!peer) {
            return;
        }
        peer.pc.close();
        this.peers.delete(uid);
        this.emit({ type: "participant-left", uid });
        if (this.currentPresenterUid === uid) {
            this.currentPresenterUid = undefined;
            this.emit({ type: "presenter-changed", uid: undefined });
        }
    }

    private createPeer(uid: string, name: string): PeerState {
        const pc = this.options.createPeerConnection({ iceServers: this.options.iceServers });
        const peer: PeerState = { uid, name, pc, remoteDescriptionSet: false, pendingCandidates: [] };
        this.peers.set(uid, peer);
        for (const track of this.options.localStream.getTracks()) {
            pc.addTrack(track, this.options.localStream);
        }
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.send({ kind: "ice-candidate", to: uid, candidate: event.candidate });
            }
        };
        pc.ontrack = (event) => {
            const stream = event.streams[0];
            if (stream) {
                this.emit({ type: "remote-stream", uid, stream });
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" || pc.connectionState === "closed") {
                this.handleBye(uid);
            }
        };
        return peer;
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
            peer = this.createPeer(message.from, message.from);
        }
        await peer.pc.setRemoteDescription(message.sdp);
        this.flushPendingCandidates(peer);
        if (isNew) {
            this.emit({ type: "participant-joined", participant: { uid: peer.uid, name: peer.name } });
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
            // No connection tracked for this peer yet (a candidate that raced ahead of its own offer/answer) -
            // nothing to buffer it against, and one lost trickle-ICE candidate does not by itself break a
            // connection (there are normally several). See this module's known-limitations note in the Phase 2
            // report.
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
        // presenter is `this.options.selfUid` itself, whose own optimistic claim simply stays in place.
        if (from < this.currentPresenterUid) {
            const loser = this.currentPresenterUid;
            this.currentPresenterUid = from;
            this.emit({ type: "presenter-changed", uid: from });
            if (loser === this.options.selfUid) {
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
