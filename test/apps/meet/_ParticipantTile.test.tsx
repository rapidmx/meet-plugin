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
    it("shows a placeholder initial when there is no stream", () => {
        render(<ParticipantTile name="Zed" />);
        expect(screen.getByText("Z")).toBeInTheDocument();
        expect(screen.queryByRole("video")).not.toBeInTheDocument();
        expect(document.querySelector("video")).toBeNull();
    });

    it("renders a video element bound to the stream, muted for the local tile", () => {
        const stream = fakeMediaStream([fakeTrack("video")]);
        render(<ParticipantTile name="Alice" stream={stream} isLocal />);
        const video = document.querySelector("video") as HTMLVideoElement;
        expect(video).not.toBeNull();
        expect(video.muted).toBe(true);
        expect(video.srcObject).toBe(stream);
        expect(screen.getByText(/Alice \(you\)/)).toBeInTheDocument();
    });

    it("is not muted for a remote tile", () => {
        const stream = fakeMediaStream([fakeTrack("video")]);
        render(<ParticipantTile name="Bob" stream={stream} />);
        const video = document.querySelector("video") as HTMLVideoElement;
        expect(video.muted).toBe(false);
        expect(screen.getByText("Bob")).toBeInTheDocument();
    });

    it("shows the placeholder when the camera is off, even with a stream", () => {
        const stream = fakeMediaStream([fakeTrack("video")]);
        render(<ParticipantTile name="Cam Off" stream={stream} cameraOff />);
        expect(document.querySelector("video")).toBeNull();
        expect(screen.getByText("C")).toBeInTheDocument();
    });

    it("shows a muted indicator when micMuted", () => {
        render(<ParticipantTile name="Muted" micMuted />);
        expect(screen.getByTitle("Muted")).toBeInTheDocument();
    });

    it("highlights the focused tile", () => {
        const { container } = render(<ParticipantTile name="Focus" isFocused />);
        expect(container.firstElementChild).toHaveClass("ring-2");
    });

    it("is clickable when onClick is given, and not otherwise", () => {
        const onClick = vi.fn();
        const { container, rerender } = render(<ParticipantTile name="Pin" onClick={onClick} />);
        const div = container.firstElementChild as HTMLElement;
        expect(div.getAttribute("role")).toBe("button");
        fireEvent.click(div);
        expect(onClick).toHaveBeenCalledTimes(1);

        rerender(<ParticipantTile name="Pin" />);
        expect((container.firstElementChild as HTMLElement).getAttribute("role")).toBeNull();
    });

    it("clears the video's srcObject when the stream becomes null", () => {
        const stream = fakeMediaStream([fakeTrack("video")]);
        const { rerender } = render(<ParticipantTile name="Alice" stream={stream} />);
        rerender(<ParticipantTile name="Alice" stream={null} />);
        expect(document.querySelector("video")).toBeNull();
    });
});
