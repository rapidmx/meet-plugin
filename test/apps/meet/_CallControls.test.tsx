// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CallControls, { LevelBars, type CallControlsProps } from "../../../apps/meet/_CallControls.js";
import { REACTION_EMOJIS } from "../../../apps/shared/webrtc/types.js";
import { fakeDeviceInfo, fakeLocalMedia } from "../testUtils.js";

function renderControls(overrides: Partial<CallControlsProps> = {}) {
    const props: CallControlsProps = {
        media: fakeLocalMedia(),
        isPresenting: false,
        onToggleShare: vi.fn(),
        handRaised: false,
        onToggleHand: vi.fn(),
        onReaction: vi.fn(),
        viewMode: "grid",
        onToggleViewMode: vi.fn(),
        onLeave: vi.fn(),
        ...overrides,
    };
    return { ...render(<CallControls {...props} />), props };
}

describe("LevelBars", () => {
    it("rises with the level, and is flat and dim in silence", () => {
        const { container, rerender } = render(<LevelBars level={0} />);
        const heights = () => Array.from(container.querySelectorAll<HTMLElement>("[data-testid=mic-level] > span")).map((bar) => bar.style.height);
        expect(heights()).toEqual(["4px", "4px", "4px"]);
        expect(container.querySelector(".bg-white\\/50")).not.toBeNull();

        rerender(<LevelBars level={5} />);
        expect(heights()).toEqual(["13px", "19px", "13px"]);
        expect(container.querySelector(".bg-white\\/50")).toBeNull();
        expect(screen.getByTestId("mic-level")).toHaveAttribute("data-level", "5");
    });
});

describe("CallControls - microphone and camera", () => {
    it("shows a live microphone with its level, and a sending camera", () => {
        renderControls({ media: fakeLocalMedia({ audioLevel: 3 }) });
        expect(screen.getByRole("button", { name: "Mute microphone" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByTestId("mic-level")).toHaveAttribute("data-level", "3");
        expect(screen.getByRole("button", { name: "Turn off camera" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByTestId("camera-live")).toBeInTheDocument();
    });

    it("shows a muted microphone and a camera that is off, without the indicators", () => {
        renderControls({ media: fakeLocalMedia({ micOn: false, cameraOn: false }) });
        expect(screen.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.queryByTestId("mic-level")).toBeNull();
        expect(screen.getByRole("button", { name: "Turn on camera" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.queryByTestId("camera-live")).toBeNull();
    });

    it("toggles the microphone and the camera", () => {
        const media = fakeLocalMedia();
        renderControls({ media });
        fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
        fireEvent.click(screen.getByRole("button", { name: "Turn off camera" }));
        expect(media.toggleMic).toHaveBeenCalledTimes(1);
        expect(media.toggleCamera).toHaveBeenCalledTimes(1);
    });

    it("lists the microphones with the one in use ticked, and switches to the one picked", () => {
        const media = fakeLocalMedia({
            devices: { cameras: [], microphones: [fakeDeviceInfo("audioinput", "mic-1", "Built-in"), fakeDeviceInfo("audioinput", "mic-2", "")] },
            selectedDeviceIds: { audio: "mic-1" },
        });
        renderControls({ media });
        expect(screen.queryByRole("menu")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Choose microphone" }));
        const menu = screen.getByRole("menu", { name: "Microphones" });
        const items = within(menu).getAllByRole("menuitemradio");
        expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
        expect(items[0]).toHaveTextContent("Built-in");
        // An unlabeled device (labels appear only once permission is granted) still gets a name.
        expect(items[1]).toHaveTextContent("Microphone 2");
        expect(within(menu).queryByRole("menuitem")).toBeNull();

        fireEvent.click(items[1]);
        expect(media.selectDevice).toHaveBeenCalledWith("audio", "mic-2");
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("lists the cameras too", () => {
        const media = fakeLocalMedia({
            devices: { cameras: [fakeDeviceInfo("videoinput", "cam-1", "Front"), fakeDeviceInfo("videoinput", "cam-2", "Back")], microphones: [] },
            selectedDeviceIds: { video: "cam-2" },
        });
        renderControls({ media });
        fireEvent.click(screen.getByRole("button", { name: "Choose camera" }));
        const items = within(screen.getByRole("menu", { name: "Cameras" })).getAllByRole("menuitemradio");
        expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "true"]);
        fireEvent.click(items[0]);
        expect(media.selectDevice).toHaveBeenCalledWith("video", "cam-1");
    });

    it("says why there is nothing to pick, and offers to ask again", () => {
        const media = fakeLocalMedia({ status: { audio: "denied", video: "unavailable" } });
        renderControls({ media });

        fireEvent.click(screen.getByRole("button", { name: "Choose microphone" }));
        expect(screen.getByText("Access to your microphone was blocked.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("menuitem", { name: "Allow access to microphone" }));
        expect(media.requestAccess).toHaveBeenCalledWith("audio");
        expect(screen.queryByRole("menu")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Choose camera" }));
        expect(screen.getByText("No camera found.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("menuitem", { name: "Allow access to camera" }));
        expect(media.requestAccess).toHaveBeenCalledWith("video");
    });

    it("offers to ask again for a blocked device even while others are listed", () => {
        const media = fakeLocalMedia({
            status: { audio: "denied", video: "live" },
            devices: { cameras: [], microphones: [fakeDeviceInfo("audioinput", "mic-1", "Built-in")] },
        });
        renderControls({ media });
        fireEvent.click(screen.getByRole("button", { name: "Choose microphone" }));
        expect(screen.queryByText(/was blocked/)).toBeNull();
        expect(screen.getByRole("menuitem", { name: "Allow access to microphone" })).toBeInTheDocument();
    });

    it("closes a menu when it is opened again, on Escape, and on a press outside the bar - but not inside it", () => {
        renderControls({ media: fakeLocalMedia() });
        const chooser = screen.getByRole("button", { name: "Choose microphone" });

        fireEvent.click(chooser);
        expect(chooser).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(chooser);
        expect(screen.queryByRole("menu")).toBeNull();

        fireEvent.click(chooser);
        fireEvent.keyDown(document, { key: "Enter" });
        expect(screen.getByRole("menu")).toBeInTheDocument();
        fireEvent.pointerDown(chooser);
        expect(screen.getByRole("menu")).toBeInTheDocument();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("menu")).toBeNull();

        fireEvent.click(chooser);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens one menu at a time", () => {
        renderControls({ media: fakeLocalMedia() });
        fireEvent.click(screen.getByRole("button", { name: "Choose microphone" }));
        fireEvent.click(screen.getByRole("button", { name: "Choose camera" }));
        expect(screen.getAllByRole("menu")).toHaveLength(1);
        expect(screen.getByRole("menu", { name: "Cameras" })).toBeInTheDocument();
    });
});

describe("CallControls - the rest", () => {
    it("shares the screen, and stops sharing", () => {
        const { props, rerender } = renderControls();
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        expect(props.onToggleShare).toHaveBeenCalledTimes(1);

        rerender(<CallControls {...props} isPresenting />);
        expect(screen.getByRole("button", { name: "Stop sharing" })).toHaveAttribute("aria-pressed", "true");
    });

    it("disables sharing, and says why, while someone else presents", () => {
        renderControls({ presentingElsewhereName: "Bob" });
        const share = screen.getByRole("button", { name: "Share screen" });
        expect(share).toBeDisabled();
        expect(share).toHaveAttribute("title", expect.stringContaining("Bob is presenting"));
    });

    it("still lets the presenter stop their own share while someone else's name is set", () => {
        renderControls({ isPresenting: true, presentingElsewhereName: "Bob" });
        expect(screen.getByRole("button", { name: "Stop sharing" })).toBeEnabled();
    });

    it("sends a reaction from the emoji menu and closes it", () => {
        const { props } = renderControls();
        fireEvent.click(screen.getByRole("button", { name: "Send a reaction" }));
        const menu = screen.getByRole("menu", { name: "Reactions" });
        expect(within(menu).getAllByRole("menuitem")).toHaveLength(REACTION_EMOJIS.length);
        fireEvent.click(screen.getByRole("menuitem", { name: `Send ${REACTION_EMOJIS[4]}` }));
        expect(props.onReaction).toHaveBeenCalledWith(REACTION_EMOJIS[4]);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("raises and lowers a hand", () => {
        const { props, rerender } = renderControls();
        const raise = screen.getByRole("button", { name: "Raise hand" });
        expect(raise).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(raise);
        expect(props.onToggleHand).toHaveBeenCalledTimes(1);

        rerender(<CallControls {...props} handRaised />);
        expect(screen.getByRole("button", { name: "Lower hand" })).toHaveAttribute("aria-pressed", "true");
    });

    it("switches between grid and focused views", () => {
        const { props, rerender } = renderControls();
        fireEvent.click(screen.getByRole("button", { name: "Switch to focused view" }));
        expect(props.onToggleViewMode).toHaveBeenCalledTimes(1);
        rerender(<CallControls {...props} viewMode="focus" />);
        expect(screen.getByRole("button", { name: "Switch to grid view" })).toBeInTheDocument();
    });

    it("leaves", () => {
        const { props } = renderControls();
        fireEvent.click(screen.getByRole("button", { name: "Leave call" }));
        expect(props.onLeave).toHaveBeenCalledTimes(1);
    });
});
