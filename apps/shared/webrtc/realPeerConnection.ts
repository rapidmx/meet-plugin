///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Adapts the real browser `RTCPeerConnection` to `RTCPeerConnectionLike` (`types.ts`) - `MeshConnectionManager`'s
 * own tests never use this (they inject a fake `RTCPeerConnectionLike` directly); `apps/meet/_CallView.tsx` is
 * this factory's only real caller. `createBrowserPeerConnection` is a plain function value, never invoked at
 * module scope, so importing this file is safe during this plugin's page SSR, where `RTCPeerConnection` does not
 * exist at all - it would only throw if actually *called* outside a browser. */
import type { RTCPeerConnectionFactory, RTCPeerConnectionLike } from "./types.js";

/**
 * Whether the pair ICE settled on goes through a TURN relay. The selected pair is found the standard way (the
 * `transport` report's `selectedCandidatePairId`) and, for a browser that does not fill that in, as the succeeded and
 * nominated `candidate-pair`. A relay on *either* end means the media passes through a TURN server, so it counts as
 * `"turn"`; `"unknown"` when no pair is reported at all.
 */
export async function selectedConnectionType(pc: Pick<RTCPeerConnection, "getStats">): Promise<"p2p" | "turn" | "unknown"> {
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
    return local?.candidateType === "relay" || remote?.candidateType === "relay" ? "turn" : "p2p";
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
