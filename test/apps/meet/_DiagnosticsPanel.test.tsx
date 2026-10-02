// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DiagnosticsPanel, { type DiagnosticsPanelProps } from "../../../apps/meet/_DiagnosticsPanel.js";
import type { RelayDiagnostics, RelaySendDiagnostics } from "../../../apps/shared/webrtc/types.js";
import { fakeMeshParticipant } from "../testUtils.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

function renderPanel(overrides: Partial<DiagnosticsPanelProps> = {}) {
    const props: DiagnosticsPanelProps = {
        selfName: "Me",
        micOn: true,
        cameraOn: true,
        participants: [],
        ...overrides,
    };
    return render(<DiagnosticsPanel {...props} />);
}

describe("DiagnosticsPanel - this browser and self", () => {
    it("says everything is unsupported in plain jsdom, which has none of these", () => {
        renderPanel();
        expect(screen.getByText("WebRTC")).toBeInTheDocument();
        expect(screen.getAllByText("Not supported")).toHaveLength(3);
        expect(screen.queryByText("Supported")).toBeNull();
    });

    it("reports WebRTC as supported once RTCPeerConnection exists", () => {
        vi.stubGlobal("RTCPeerConnection", class {});
        renderPanel();
        expect(within(screen.getByText("WebRTC").closest("div")!).getByText("Supported")).toBeInTheDocument();
    });

    it("reports screen sharing as supported once getDisplayMedia exists", () => {
        vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn() } });
        renderPanel();
        expect(within(screen.getByText("Screen sharing").closest("div")!).getByText("Supported")).toBeInTheDocument();
    });

    it("reports WebCodecs as supported once both encoders exist", () => {
        vi.stubGlobal("VideoEncoder", class {});
        vi.stubGlobal("AudioEncoder", class {});
        renderPanel();
        expect(within(screen.getByText("WebCodecs (server relay fallback)").closest("div")!).getByText("Supported")).toBeInTheDocument();
    });

    it("does not report WebCodecs as supported when only one encoder exists", () => {
        vi.stubGlobal("VideoEncoder", class {});
        renderPanel();
        expect(within(screen.getByText("WebCodecs (server relay fallback)").closest("div")!).getByText("Not supported")).toBeInTheDocument();
    });

    it("shows what the local participant is sending", () => {
        renderPanel({ micOn: true, cameraOn: false });
        expect(screen.getByText("audio")).toBeInTheDocument();

        renderPanel({ micOn: false, cameraOn: false });
        expect(screen.getByText("Nothing")).toBeInTheDocument();
    });

    it("says nobody else is in the call yet", () => {
        renderPanel({ participants: [] });
        expect(screen.getByText("Nobody else is in the call yet.")).toBeInTheDocument();
    });
});

describe("DiagnosticsPanel - participants", () => {
    it("shows a direct connection with no badge", () => {
        renderPanel({ participants: [fakeMeshParticipant({ name: "Zed", transport: "p2p" })] });
        expect(screen.getByText("Zed")).toBeInTheDocument();
        expect(screen.getByText("Direct")).toBeInTheDocument();
    });

    it("shows a connecting participant", () => {
        renderPanel({ participants: [fakeMeshParticipant({ name: "Zed", transport: "connecting" })] });
        expect(screen.getByText("Connecting…")).toBeInTheDocument();
        expect(screen.getByText("Not available yet.")).toBeInTheDocument();
    });

    it("shows the relayed badge and says diagnostics are not available yet before the first poll", () => {
        renderPanel({ participants: [fakeMeshParticipant({ name: "Zed", transport: "turn" })] });
        expect(screen.getByText("Relayed")).toBeInTheDocument();
        expect(screen.getByText("Not available yet.")).toBeInTheDocument();
    });

    it("shows the TCP-relay badge", () => {
        renderPanel({ participants: [fakeMeshParticipant({ name: "Zed", transport: "turn-tcp" })] });
        expect(screen.getByText("Relayed (TCP)")).toBeInTheDocument();
    });

    it("says diagnostics are not available yet for a server-relayed participant before the first poll", () => {
        renderPanel({ participants: [fakeMeshParticipant({ name: "Zed", transport: "websocket" })] });
        expect(screen.getByText("Server relay")).toBeInTheDocument();
        expect(screen.getByText("Not available yet.")).toBeInTheDocument();
    });

    it("says a participant could not be reached", () => {
        renderPanel({ participants: [fakeMeshParticipant({ name: "Zed", transport: "failed" })] });
        expect(screen.getByText("Can't connect")).toBeInTheDocument();
    });

    it("shows round-trip time and per-kind stats once diagnostics have been polled", () => {
        renderPanel({
            participants: [
                fakeMeshParticipant({
                    name: "Zed",
                    transport: "turn",
                    diagnostics: {
                        roundTripTimeSeconds: 0.123,
                        audio: { packetsLost: 2, jitter: 0.01, bytesSent: 2048, bytesReceived: 4096 },
                        video: {},
                    },
                }),
            ],
        });
        expect(screen.getByText("123 ms")).toBeInTheDocument();
        const audioRow = screen.getByText("Audio").closest("div");
        expect(within(audioRow!).getByText(/2 lost/)).toBeInTheDocument();
        expect(within(audioRow!).getByText(/10 ms jitter/)).toBeInTheDocument();
        expect(within(audioRow!).getByText(/↑2\.0 KB/)).toBeInTheDocument();
        expect(within(audioRow!).getByText(/↓4\.0 KB/)).toBeInTheDocument();
        // Video has no stats at all, so its row is omitted entirely rather than shown empty.
        expect(screen.queryByText("Video")).toBeNull();
    });

    it("shows a placeholder for round-trip time when it hasn't been reported yet", () => {
        renderPanel({
            participants: [fakeMeshParticipant({ name: "Zed", transport: "turn", diagnostics: { audio: {}, video: {} } })],
        });
        expect(screen.getByText("—")).toBeInTheDocument();
    });

    it("formats byte counts in megabytes once they are large enough", () => {
        renderPanel({
            participants: [
                fakeMeshParticipant({
                    name: "Zed",
                    transport: "turn",
                    diagnostics: { roundTripTimeSeconds: 0.05, audio: {}, video: { bytesSent: 5 * 1024 * 1024 } },
                }),
            ],
        });
        expect(screen.getByText(/↑5\.0 MB/)).toBeInTheDocument();
    });

    describe("a server-relayed participant", () => {
        function relayed(relay: Partial<RelayDiagnostics> = {}, send: Partial<RelaySendDiagnostics> = {}) {
            const diagnostics: RelayDiagnostics = {
                send: {
                    audioCapturedMs: 9_800,
                    audioCaptureWallMs: 10_000,
                    audioSilentMs: 3_920,
                    audioEncoderSkippedMs: 0,
                    audio: { framesSent: 490, framesDropped: 0, bytesSent: 2048 },
                    video: { framesSent: 150, framesDropped: 0, bytesSent: 0 },
                    ...send,
                },
                receive: {
                    audio: { framesReceived: 500, framesLost: 4, bytesReceived: 4096, playedMs: 10_000, silentMs: 3_500, gaps: 1, gapMs: 120, droppedLate: 0, bufferedMs: 80 },
                    video: { framesReceived: 0, framesLost: 0, bytesReceived: 0 },
                },
                ...relay,
            };
            renderPanel({
                participants: [
                    fakeMeshParticipant({
                        name: "Zed",
                        transport: "websocket",
                        diagnostics: {
                            roundTripTimeSeconds: 0.038,
                            audio: { packetsLost: 4, bytesSent: 2048, bytesReceived: 4096 },
                            video: {},
                            relay: diagnostics,
                        },
                    }),
                ],
            });
        }

        const row = (label: string) => screen.getByText(label).closest("div")!;

        it("shows the round trip to the relay server, and the relay's counters", () => {
            relayed();
            expect(screen.queryByText("Round-trip time")).toBeNull();
            expect(within(row("Round-trip to server")).getByText("38 ms")).toBeInTheDocument();
            expect(screen.getByText("Round-trip to server")).toHaveAttribute("title", "From this browser to the relay server and back");
            expect(within(row("Audio")).getByText(/4 lost/)).toBeInTheDocument();
            expect(within(row("Your mic capture")).getByText("98% of real time · 40% silent")).toBeInTheDocument();
            expect(within(row("Playback")).getByText("35% silent · 1 gap (120 ms) · 80 ms buffered")).toBeInTheDocument();
            // Nothing was dropped on either side, so those rows stay out of the way.
            expect(screen.queryByText("Not sent")).toBeNull();
            expect(screen.queryByText("Dropped late")).toBeNull();
        });

        it("shows frames that could not be sent, audio the encoder skipped and packets dropped on arrival", () => {
            relayed(
                {
                    receive: {
                        audio: { framesReceived: 0, framesLost: 0, bytesReceived: 0, playedMs: 0, silentMs: 0, gaps: 3, gapMs: 300, droppedLate: 7, bufferedMs: 0 },
                        video: { framesReceived: 0, framesLost: 0, bytesReceived: 0 },
                    },
                },
                { audioEncoderSkippedMs: 85.3, audio: { framesSent: 1, framesDropped: 2, bytesSent: 0 }, video: { framesSent: 1, framesDropped: 5, bytesSent: 0 } },
            );
            expect(within(row("Your mic capture")).getByText(/· 85 ms skipped/)).toBeInTheDocument();
            expect(within(row("Not sent")).getByText("2 audio · 5 video frames")).toBeInTheDocument();
            // No audio played yet, so its share of silence has nothing to be a share of.
            expect(within(row("Playback")).getByText("— silent · 3 gaps (300 ms) · 0 ms buffered")).toBeInTheDocument();
            expect(within(row("Dropped late")).getByText("7 packets")).toBeInTheDocument();
        });

        it("says one packet, not one packets", () => {
            relayed({
                receive: {
                    audio: { framesReceived: 1, framesLost: 0, bytesReceived: 0, playedMs: 20, silentMs: 0, gaps: 0, gapMs: 0, droppedLate: 1, bufferedMs: 0 },
                    video: { framesReceived: 0, framesLost: 0, bytesReceived: 0 },
                },
            });
            expect(within(row("Dropped late")).getByText("1 packet")).toBeInTheDocument();
        });

        it("leaves out capture before any has happened, and playback before anything was received", () => {
            relayed({ receive: undefined }, { audioCapturedMs: 0, audioCaptureWallMs: 0, audioSilentMs: 0 });
            expect(screen.queryByText("Your mic capture")).toBeNull();
            expect(screen.queryByText("Playback")).toBeNull();
        });
    });

    it("lists more than one participant", () => {
        renderPanel({
            participants: [fakeMeshParticipant({ uid: "a", name: "Alice" }), fakeMeshParticipant({ uid: "b", name: "Bob", transport: "turn" })],
        });
        expect(screen.getByText("Alice")).toBeInTheDocument();
        expect(screen.getByText("Bob")).toBeInTheDocument();
    });
});
