///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Adapts the real browser `RTCPeerConnection` to `RTCPeerConnectionLike` (`types.ts`) - `MeshConnectionManager`'s
 * own tests never use this (they inject a fake `RTCPeerConnectionLike` directly); `apps/meet/_CallView.tsx` is
 * this factory's only real caller. `createBrowserPeerConnection` is a plain function value, never invoked at
 * module scope, so importing this file is safe during this plugin's page SSR, where `RTCPeerConnection` does not
 * exist at all - it would only throw if actually *called* outside a browser. */
import type { ConnectionDiagnostics, RTCPeerConnectionFactory, RTCPeerConnectionLike, RtpStreamDiagnostics } from "./types.js";

/**
 * Whether the pair ICE settled on goes through a TURN relay, and - when it's our own end that's relayed - whether
 * that relay is TCP (`turn-tcp`, meaning `turns:` too, TLS being TCP-based as well) rather than UDP. The selected
 * pair is found the standard way (the `transport` report's `selectedCandidatePairId`) and, for a browser that does
 * not fill that in, as the succeeded and nominated `candidate-pair`. A relay on *either* end means the media
 * passes through a TURN server, so it counts as at least `"turn"`; `"unknown"` when no pair is reported at all.
 *
 * The TCP/UDP distinction matters because they fail very differently under loss: UDP just drops the lost packet
 * (a click), while TCP retransmits it and blocks everything queued behind it until that arrives (a stall) - exactly
 * the "gaps that feel like latency, not packet loss" a participant on a TCP-relayed connection reports. `relayProtocol`
 * (`"udp"`/`"tcp"`/`"tls"`) is only ever reported on a *local* relay candidate - there's no equivalent visibility into
 * how the *remote* peer reaches its own TURN allocation, so a relay on the remote end alone is reported as plain
 * `"turn"` rather than guessed at.
 */
export async function selectedConnectionType(pc: Pick<RTCPeerConnection, "getStats">): Promise<"p2p" | "turn" | "turn-tcp" | "unknown"> {
    const reports = new Map<string, Record<string, unknown>>();
    (await pc.getStats()).forEach((report: Record<string, unknown>) => reports.set(String(report.id), report));
    const transport = [...reports.values()].find((report) => report.type === "transport" && report.selectedCandidatePairId);
    const pair =
        (transport ? reports.get(String(transport.selectedCandidatePairId)) : undefined) ??
        [...reports.values()].find((report) => report.type === "candidate-pair" && (report.selected || (report.nominated && report.state === "succeeded")));
    if (!pair) {
        return "unknown";
    }
    const local = reports.get(String(pair.localCandidateId));
    const remote = reports.get(String(pair.remoteCandidateId));
    if (local?.candidateType !== "relay" && remote?.candidateType !== "relay") {
        return "p2p";
    }
    const relayProtocol = local?.candidateType === "relay" ? String(local.relayProtocol ?? "") : "";
    return relayProtocol === "tcp" || relayProtocol === "tls" ? "turn-tcp" : "turn";
}

function streamDiagnostics(reports: Map<string, Record<string, unknown>>, kind: "audio" | "video"): RtpStreamDiagnostics {
    const inbound = [...reports.values()].find((report) => report.type === "inbound-rtp" && report.kind === kind);
    const outbound = [...reports.values()].find((report) => report.type === "outbound-rtp" && report.kind === kind);
    const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
    return {
        packetsLost: num(inbound?.packetsLost),
        jitter: num(inbound?.jitter),
        bytesSent: num(outbound?.bytesSent),
        bytesReceived: num(inbound?.bytesReceived),
    };
}

/** One point-in-time sample of this connection's own quality stats, for the diagnostics panel - a single
 * `getStats()` walk, independent of (and in addition to) `selectedConnectionType()`'s own call, since this is
 * polled periodically at a much lower priority than the one-time transport check and there's no value in coupling
 * the two together. */
export async function collectDiagnostics(pc: Pick<RTCPeerConnection, "getStats">): Promise<ConnectionDiagnostics> {
    const reports = new Map<string, Record<string, unknown>>();
    (await pc.getStats()).forEach((report: Record<string, unknown>) => reports.set(String(report.id), report));
    const transport = [...reports.values()].find((report) => report.type === "transport" && report.selectedCandidatePairId);
    const pair =
        (transport ? reports.get(String(transport.selectedCandidatePairId)) : undefined) ??
        [...reports.values()].find((report) => report.type === "candidate-pair" && (report.selected || (report.nominated && report.state === "succeeded")));
    const roundTripTimeSeconds = typeof pair?.currentRoundTripTime === "number" ? pair.currentRoundTripTime : undefined;
    return { roundTripTimeSeconds, audio: streamDiagnostics(reports, "audio"), video: streamDiagnostics(reports, "video") };
}

export const createBrowserPeerConnection: RTCPeerConnectionFactory = (config) => {
    const pc = new RTCPeerConnection(config);
    const like: RTCPeerConnectionLike = {
        addTransceiver: (kind, track) => {
            const { sender } = pc.addTransceiver(track ?? kind, { direction: "sendrecv" });
            return { sender };
        },
        claimTransceivers: () => {
            const senders: Partial<Record<"audio" | "video", RTCRtpSender>> = {};
            for (const transceiver of pc.getTransceivers()) {
                const kind = transceiver.receiver.track.kind as "audio" | "video";
                if (!senders[kind]) {
                    transceiver.direction = "sendrecv";
                    senders[kind] = transceiver.sender;
                }
            }
            return senders;
        },
        createOffer: () => pc.createOffer(),
        createAnswer: () => pc.createAnswer(),
        setLocalDescription: (description) => pc.setLocalDescription(description),
        setRemoteDescription: (description) => pc.setRemoteDescription(description),
        addIceCandidate: (candidate) => pc.addIceCandidate(candidate),
        close: () => pc.close(),
        connectionType: () => selectedConnectionType(pc),
        collectDiagnostics: () => collectDiagnostics(pc),
        onicecandidate: null,
        ontrack: null,
        onconnectionstatechange: null,
        get connectionState() {
            return pc.connectionState;
        },
    };
    // Forwards the real browser events to whatever handler `MeshConnectionManager` has currently assigned on
    // `like` - a level of indirection needed because `like`'s own handler properties are reassigned *after* this
    // adapter object is constructed and returned (see `MeshConnectionManager.createPeer()`).
    pc.onicecandidate = (event) => like.onicecandidate?.({ candidate: event.candidate ? event.candidate.toJSON() : null });
    pc.ontrack = (event) => like.ontrack?.({ track: event.track });
    pc.onconnectionstatechange = () => like.onconnectionstatechange?.();
    return like;
};
