// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ParticipantTile from "../../../apps/meet/_ParticipantTile.js";
import { fakeMediaStream, fakeTrack } from "../testUtils.js";

describe("ParticipantTile", () => {
    it("shows the participant's initial instead of a video when there is no stream", () => {
        const { container } = render(<ParticipantTile name="alice" />);
        expect(screen.getByText("A")).toBeInTheDocument();
        expect(container.querySelector("video")).toBeNull();
        expect(screen.getByText("alice")).toBeInTheDocument();
    });

    it("falls back to a question mark for an empty name", () => {
        render(<ParticipantTile name="   " />);
        expect(screen.getByText("?")).toBeInTheDocument();
    });

    it("shows the initial, not the picture, while the camera is off", () => {
        const { container } = render(<ParticipantTile name="Bob" stream={fakeMediaStream([fakeTrack("video")])} cameraOff />);
        expect(screen.getByText("B")).toBeInTheDocument();
        expect(container.querySelector("video")).toBeNull();
    });

    it("plays the stream in a muted video - a tile never plays sound, the call's audio elements do", () => {
        const stream = fakeMediaStream([fakeTrack("video")]);
        const { container } = render(<ParticipantTile name="Bob" stream={stream} />);
        const video = container.querySelector("video")!;
        expect(video.muted).toBe(true);
        expect(video.srcObject).toBe(stream);
        expect(video.className).toContain("object-cover");
        expect(video.className).not.toContain("scaleX");
    });

    it("binds the stream again when the video comes back after the camera was off", () => {
        const stream = fakeMediaStream([fakeTrack("video")]);
        const { container, rerender } = render(<ParticipantTile name="Bob" stream={stream} cameraOff />);
        rerender(<ParticipantTile name="Bob" stream={stream} />);
        expect(container.querySelector("video")!.srcObject).toBe(stream);
    });

    it("labels the local participant, and mirrors their own picture", () => {
        const { container } = render(<ParticipantTile name="Me" isLocal stream={fakeMediaStream([fakeTrack("video")])} />);
        expect(screen.getByText(/Me \(you\)/)).toBeInTheDocument();
        expect(container.querySelector("video")!.className).toContain("scaleX(-1)");
    });

    it("does not mirror the local picture when mirrored is turned off (a custom background image)", () => {
        const { container } = render(<ParticipantTile name="Me" isLocal mirrored={false} stream={fakeMediaStream([fakeTrack("video")])} />);
        expect(container.querySelector("video")!.className).not.toContain("scaleX");
    });

    it("fits a shared screen inside the tile rather than cropping it, and never mirrors it", () => {
        const { container } = render(<ParticipantTile name="Me" isLocal contain stream={fakeMediaStream([fakeTrack("video")])} />);
        const video = container.querySelector("video")!;
        expect(video.className).toContain("object-contain");
        expect(video.className).not.toContain("scaleX");
    });

    it("shows a muted microphone and a raised hand", () => {
        render(<ParticipantTile name="Bob" micMuted handRaised />);
        expect(screen.getByRole("img", { name: "Muted" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Hand raised" })).toBeInTheDocument();
    });

    it("shows neither badge by default", () => {
        render(<ParticipantTile name="Bob" />);
        expect(screen.queryByRole("img", { name: "Muted" })).toBeNull();
        expect(screen.queryByRole("img", { name: "Hand raised" })).toBeNull();
    });

    it("is a button, with the participant's name, only when it can be clicked", () => {
        const onClick = vi.fn();
        const { rerender } = render(<ParticipantTile name="Bob" onClick={onClick} isFocused className="extra" />);
        const tile = screen.getByRole("button", { name: "Bob" });
        expect(tile.className).toContain("ring-2");
        expect(tile.className).toContain("extra");
        fireEvent.click(tile);
        expect(onClick).toHaveBeenCalledTimes(1);

        rerender(<ParticipantTile name="Bob" isLocal onClick={onClick} />);
        expect(screen.getByRole("button", { name: "Bob (you)" })).toBeInTheDocument();

        rerender(<ParticipantTile name="Bob" />);
        expect(screen.queryByRole("button")).toBeNull();
    });
});

describe("ParticipantTile transport badge", () => {
    it("says so when the participant's media comes through the TURN relay, the server relay, or not at all", () => {
        const { rerender } = render(<ParticipantTile name="Bob" transport="turn" />);
        expect(screen.getByTestId("transport-badge")).toHaveTextContent("Relayed");

        rerender(<ParticipantTile name="Bob" transport="websocket" />);
        expect(screen.getByTestId("transport-badge")).toHaveTextContent("Server relay");
        expect(screen.getByTestId("transport-badge").title).toMatch(/last resort/);

        rerender(<ParticipantTile name="Bob" transport="failed" />);
        expect(screen.getByTestId("transport-badge")).toHaveTextContent("Can't connect");
    });

    it("stays quiet for a direct connection, one still connecting, and a tile with no transport", () => {
        const { rerender } = render(<ParticipantTile name="Bob" transport="p2p" />);
        expect(screen.queryByTestId("transport-badge")).toBeNull();
        rerender(<ParticipantTile name="Bob" transport="connecting" />);
        expect(screen.queryByTestId("transport-badge")).toBeNull();
        rerender(<ParticipantTile name="Bob" />);
        expect(screen.queryByTestId("transport-badge")).toBeNull();
    });
});

describe("ParticipantTile status", () => {
    it("shows the status with a spinner under the initial while there is no video", () => {
        render(<ParticipantTile name="Bob" status="Awaiting connection…" />);
        expect(screen.getByTestId("tile-status")).toHaveTextContent("Awaiting connection…");
        expect(screen.getByTestId("tile-status").getAttribute("aria-live")).toBe("polite");
        expect(screen.getByText("B")).toBeInTheDocument();
    });

    it("shows the status over the picture when there is video", () => {
        const { container } = render(<ParticipantTile name="Me" isLocal status="Connecting…" stream={fakeMediaStream([fakeTrack("video")])} />);
        expect(container.querySelector("video")).not.toBeNull();
        expect(screen.getByTestId("tile-status")).toHaveTextContent("Connecting…");
    });

    it("shows nothing when there is no status", () => {
        const { rerender, container } = render(<ParticipantTile name="Bob" />);
        expect(screen.queryByTestId("tile-status")).toBeNull();
        rerender(<ParticipantTile name="Bob" stream={fakeMediaStream([fakeTrack("video")])} />);
        expect(container.querySelector("video")).not.toBeNull();
        expect(screen.queryByTestId("tile-status")).toBeNull();
    });
});
