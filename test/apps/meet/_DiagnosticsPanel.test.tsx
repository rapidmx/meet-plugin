// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DiagnosticsPanel, { type DiagnosticsPanelProps } from "../../../apps/meet/_DiagnosticsPanel.js";
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

    it("says diagnostics are not available at all for a server-relayed participant", () => {
        renderPanel({ participants: [fakeMeshParticipant({ name: "Zed", transport: "websocket" })] });
        expect(screen.getByText("Server relay")).toBeInTheDocument();
        expect(screen.getByText("Not available.")).toBeInTheDocument();
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

    it("lists more than one participant", () => {
        renderPanel({
            participants: [fakeMeshParticipant({ uid: "a", name: "Alice" }), fakeMeshParticipant({ uid: "b", name: "Bob", transport: "turn" })],
        });
        expect(screen.getByText("Alice")).toBeInTheDocument();
        expect(screen.getByText("Bob")).toBeInTheDocument();
    });
});
