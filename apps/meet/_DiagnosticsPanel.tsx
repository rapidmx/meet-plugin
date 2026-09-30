///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The diagnostics panel, opened from the navbar for troubleshooting a call in progress - this browser's own
 * capabilities, then each participant's connection: how their media reaches this one (the same badge
 * `_ParticipantTile.tsx` shows, reused via `TRANSPORT_BADGES` rather than described in different words), and,
 * once available, round-trip time and each kind's packet loss/jitter/bytes transferred
 * (`MeshParticipant.diagnostics`, refreshed every few seconds by `MeshConnectionManager`'s own poller - see its doc
 * comment). Purely informational and entirely local: nothing here is sent anywhere.
 *
 * `diagnostics` is `undefined` until the first poll completes (shortly after a connection comes up) and always
 * absent for a `"websocket"`-relayed participant (there is no `RTCPeerConnection` to poll there) - both cases show
 * "Not available" rather than a blank space, so it never looks like the panel forgot to load.
 */
import React from "react";
import type { MeshParticipant } from "../shared/webrtc/types.js";
import { TRANSPORT_BADGES } from "./_ParticipantTile.js";

export interface DiagnosticsPanelProps {
    selfName: string;
    /** Whether the local microphone/camera are actually sending - `LocalMedia.micOn`/`cameraOn`. */
    micOn: boolean;
    cameraOn: boolean;
    participants: MeshParticipant[];
}

/** This browser's support for what a call needs - checked once, since it cannot change mid-session. */
function browserCapabilities(): { label: string; supported: boolean }[] {
    const has = (name: string): boolean => typeof window !== "undefined" && name in window;
    return [
        { label: "WebRTC", supported: has("RTCPeerConnection") },
        { label: "Screen sharing", supported: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia },
        { label: "WebCodecs (server relay fallback)", supported: has("VideoEncoder") && has("AudioEncoder") },
    ];
}

function formatMs(seconds: number | undefined): string {
    return seconds === undefined ? "—" : `${Math.round(seconds * 1000)} ms`;
}

function formatBytes(bytes: number): string {
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ROW = "flex justify-between gap-3 py-0.5";
const LABEL = "text-white/60";

function StreamRow({ kind, packetsLost, jitter, bytesSent, bytesReceived }: { kind: string; packetsLost?: number; jitter?: number; bytesSent?: number; bytesReceived?: number }) {
    if (packetsLost === undefined && jitter === undefined && bytesSent === undefined && bytesReceived === undefined) {
        return null;
    }
    return (
        <div className={ROW}>
            <span className={LABEL}>{kind}</span>
            <span>
                {packetsLost !== undefined && `${packetsLost} lost`}
                {jitter !== undefined && ` · ${formatMs(jitter)} jitter`}
                {(bytesSent !== undefined || bytesReceived !== undefined) &&
                    ` · ${[bytesSent !== undefined && `↑${formatBytes(bytesSent)}`, bytesReceived !== undefined && `↓${formatBytes(bytesReceived)}`].filter(Boolean).join(" ")}`}
            </span>
        </div>
    );
}

export default function DiagnosticsPanel({ selfName, micOn, cameraOn, participants }: DiagnosticsPanelProps) {
    return (
        <div className="text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/60 mb-1.5">This browser</p>
            {browserCapabilities().map(({ label, supported }) => (
                <div key={label} className={ROW}>
                    <span className={LABEL}>{label}</span>
                    <span className={supported ? "text-[#8ab4f8]" : "text-[#f2b8b5]"}>{supported ? "Supported" : "Not supported"}</span>
                </div>
            ))}

            <p className="text-xs font-semibold uppercase tracking-wide text-white/60 mt-3 mb-1.5">
                {selfName} <span className="text-white/60">(you)</span>
            </p>
            <div className={ROW}>
                <span className={LABEL}>Sending</span>
                <span>{[micOn && "audio", cameraOn && "video"].filter(Boolean).join(" + ") || "Nothing"}</span>
            </div>

            {participants.length === 0 && <p className="text-white/60 mt-3">Nobody else is in the call yet.</p>}
            {participants.map((p) => {
                const badge = p.transport !== "connecting" && p.transport !== "p2p" ? TRANSPORT_BADGES[p.transport] : undefined;
                return (
                    <div key={p.uid}>
                        <p className="text-xs font-semibold uppercase tracking-wide text-white/60 mt-3 mb-1.5">{p.name}</p>
                        <div className={ROW}>
                            <span className={LABEL}>Connection</span>
                            <span title={badge?.title}>{badge?.label ?? (p.transport === "connecting" ? "Connecting…" : "Direct")}</span>
                        </div>
                        {p.transport === "websocket" || !p.diagnostics ? (
                            <p className={`${LABEL} py-0.5`}>Not available{p.transport !== "websocket" && " yet"}.</p>
                        ) : (
                            <>
                                <div className={ROW}>
                                    <span className={LABEL}>Round-trip time</span>
                                    <span>{formatMs(p.diagnostics.roundTripTimeSeconds)}</span>
                                </div>
                                <StreamRow kind="Audio" {...p.diagnostics.audio} />
                                <StreamRow kind="Video" {...p.diagnostics.video} />
                            </>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
