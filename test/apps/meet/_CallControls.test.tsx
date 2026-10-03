// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CallControls, { LevelBars, type CallControlsProps } from "../../../apps/meet/_CallControls.js";
import { NO_FILTERS } from "../../../apps/shared/media/filters/filterTypes.js";
import { NO_SCREEN_TRANSFORM } from "../../../apps/shared/media/filters/ScreenTransform.js";
import { REACTION_EMOJIS } from "../../../apps/shared/webrtc/types.js";
import { fakeDeviceInfo, fakeLocalMedia, fakeMeshParticipant } from "../testUtils.js";

function renderControls(overrides: Partial<CallControlsProps> = {}) {
    const props: CallControlsProps = {
        media: fakeLocalMedia(),
        participants: [],
        isPresenting: false,
        onToggleShare: vi.fn(),
        screenTransform: NO_SCREEN_TRANSFORM,
        onRotateScreen: vi.fn(),
        onFlipScreen: vi.fn(),
        handRaised: false,
        onToggleHand: vi.fn(),
        onReaction: vi.fn(),
        viewMode: "grid",
        onToggleViewMode: vi.fn(),
        isHost: false,
        transportMode: "auto",
        onSetTransportMode: vi.fn(),
        onOpenDiagnostics: vi.fn(),
        onOpenSettings: vi.fn(),
        selfHidden: false,
        onToggleSelfHidden: vi.fn(),
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

    it("disables the microphone toggle while micLocked, with an explanatory title, but not the device-picker chevron", () => {
        const media = fakeLocalMedia();
        renderControls({ media, micLocked: true });
        const muteButton = screen.getByRole("button", { name: "Mute microphone" });
        expect(muteButton).toBeDisabled();
        expect(muteButton).toHaveAttribute("title", "Only the current talking-stick holder can unmute.");
        fireEvent.click(muteButton);
        expect(media.toggleMic).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Choose microphone" })).toBeEnabled();
    });

    it("leaves the microphone toggle enabled, with no title, when not locked", () => {
        renderControls({ micLocked: false });
        const muteButton = screen.getByRole("button", { name: "Mute microphone" });
        expect(muteButton).toBeEnabled();
        expect(muteButton).not.toHaveAttribute("title");
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

describe("CallControls - video effects", () => {
    it("opens the effects panel from its button, and closes it from the same button", () => {
        renderControls();
        const button = screen.getByRole("button", { name: "Video effects" });
        expect(button).toHaveAttribute("aria-haspopup", "dialog");
        expect(button).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("dialog")).toBeNull();

        fireEvent.click(button);
        expect(button).toHaveAttribute("aria-expanded", "true");
        const dialog = screen.getByRole("dialog", { name: "Video effects" });
        expect(within(dialog).getByRole("group", { name: "Background" })).toBeInTheDocument();
        expect(within(dialog).getByRole("group", { name: "Look" })).toBeInTheDocument();
        expect(within(dialog).getByRole("group", { name: "Fun" })).toBeInTheDocument();

        fireEvent.click(button);
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(button).toHaveAttribute("aria-expanded", "false");
    });

    it("lights the button while a filter is on", () => {
        const idle = renderControls({ media: fakeLocalMedia({ filters: NO_FILTERS }) });
        const idleClass = screen.getByRole("button", { name: "Video effects" }).className;
        idle.unmount();

        for (const filters of [
            { ...NO_FILTERS, background: "blur" as const },
            { ...NO_FILTERS, effect: "sepia" as const },
            { ...NO_FILTERS, accessory: "crown" as const },
        ]) {
            const active = renderControls({ media: fakeLocalMedia({ filters }) });
            const activeClass = screen.getByRole("button", { name: "Video effects" }).className;
            expect(activeClass).toContain("bg-[#a8c7fa]");
            expect(idleClass).not.toContain("bg-[#a8c7fa]");
            active.unmount();
        }
    });

    it("closes on Escape and on a press outside the bar, but not on a press inside the panel", () => {
        renderControls();
        const button = screen.getByRole("button", { name: "Video effects" });

        fireEvent.click(button);
        fireEvent.pointerDown(within(screen.getByRole("dialog")).getByRole("button", { name: /Blur/ }));
        fireEvent.pointerDown(screen.getByRole("dialog"));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("dialog")).toBeNull();

        fireEvent.click(button);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("stays open while a filter is chosen, and applies it", () => {
        const media = fakeLocalMedia();
        renderControls({ media });
        fireEvent.click(screen.getByRole("button", { name: "Video effects" }));

        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Blur/ }));

        expect(media.setFilters).toHaveBeenCalledWith({ background: "blur" });
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("opens one menu at a time, alongside the device menus", () => {
        renderControls();
        fireEvent.click(screen.getByRole("button", { name: "Choose camera" }));
        fireEvent.click(screen.getByRole("button", { name: "Video effects" }));
        expect(screen.queryByRole("menu")).toBeNull();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
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

    it("offers the rotate/flip buttons only while presenting", () => {
        renderControls({ isPresenting: false });
        expect(screen.queryByRole("button", { name: "Rotate shared screen" })).toBeNull();
        expect(screen.queryByRole("button", { name: /flip shared screen/i })).toBeNull();

        renderControls({ isPresenting: true });
        expect(screen.getByRole("button", { name: "Rotate shared screen" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Flip shared screen" })).toBeInTheDocument();
    });

    it("rotates and flips the shared screen, the flip button lighting up while it's on", () => {
        const { props, rerender } = renderControls({ isPresenting: true });
        fireEvent.click(screen.getByRole("button", { name: "Rotate shared screen" }));
        expect(props.onRotateScreen).toHaveBeenCalledTimes(1);

        const flip = screen.getByRole("button", { name: "Flip shared screen" });
        expect(flip).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(flip);
        expect(props.onFlipScreen).toHaveBeenCalledTimes(1);

        rerender(<CallControls {...props} isPresenting screenTransform={{ rotation: 90, flipped: true }} />);
        expect(screen.getByRole("button", { name: "Unflip shared screen" })).toHaveAttribute("aria-pressed", "true");
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
        const { props, rerender } = renderControls({ participants: [fakeMeshParticipant({ uid: "z" }), fakeMeshParticipant({ uid: "y" })] });
        fireEvent.click(screen.getByRole("button", { name: "Switch to focused view" }));
        expect(props.onToggleViewMode).toHaveBeenCalledTimes(1);
        rerender(<CallControls {...props} viewMode="focus" />);
        expect(screen.getByRole("button", { name: "Switch to grid view" })).toBeInTheDocument();
    });

    it("disables the grid/focus toggle with an explanatory title only while alone - there is nothing to toggle yet", () => {
        const { props, rerender } = renderControls({ participants: [] });
        const button = screen.getByRole("button", { name: "Switch to focused view" });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", "Grid and focused view look the same while you're alone.");
        fireEvent.click(button);
        expect(props.onToggleViewMode).not.toHaveBeenCalled();

        rerender(<CallControls {...props} participants={[fakeMeshParticipant({ uid: "z" })]} />);
        const enabled = screen.getByRole("button", { name: "Switch to focused view" });
        expect(enabled).toBeEnabled();
        expect(enabled).not.toHaveAttribute("title");
    });

    it("leaves", () => {
        const { props } = renderControls();
        fireEvent.click(screen.getByRole("button", { name: "Leave call" }));
        expect(props.onLeave).toHaveBeenCalledTimes(1);
    });
});

describe("CallControls - the \"…\" menu", () => {
    it("sits between the grid/focus toggle and Leave", () => {
        renderControls();
        const toolbar = screen.getByRole("toolbar", { name: "Call controls" });
        const names = Array.from(toolbar.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
        const viewIndex = names.indexOf("Switch to focused view");
        const moreIndex = names.indexOf("More options");
        const leaveIndex = names.indexOf("Leave call");
        expect(viewIndex).toBeGreaterThanOrEqual(0);
        expect(moreIndex).toBe(viewIndex + 1);
        expect(leaveIndex).toBe(moreIndex + 1);
    });

    it("opens and closes from its own button, on Escape, and on a press outside the bar", () => {
        renderControls();
        const button = screen.getByRole("button", { name: "More options" });
        expect(button).toHaveAttribute("aria-expanded", "false");

        fireEvent.click(button);
        expect(button).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("menu", { name: "More options" })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("menu")).toBeNull();

        fireEvent.click(button);
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens one menu at a time, alongside the other dialogs", () => {
        renderControls();
        fireEvent.click(screen.getByRole("button", { name: "Video effects" }));
        fireEvent.click(screen.getByRole("button", { name: "More options" }));
        expect(screen.queryAllByRole("dialog")).toHaveLength(0);
        expect(screen.getByRole("menu", { name: "More options" })).toBeInTheDocument();
    });

    it("opens diagnostics and closes the menu", () => {
        const { props } = renderControls();
        fireEvent.click(screen.getByRole("button", { name: "More options" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Diagnostics" }));
        expect(props.onOpenDiagnostics).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("toggles hiding the local tile, labeled by its current state, and closes the menu on pick", () => {
        const { props, rerender } = renderControls({ selfHidden: false });
        fireEvent.click(screen.getByRole("button", { name: "More options" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Hide self" }));
        expect(props.onToggleSelfHidden).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).toBeNull();

        rerender(<CallControls {...{ ...props, selfHidden: true }} />);
        fireEvent.click(screen.getByRole("button", { name: "More options" }));
        expect(screen.getByRole("menuitem", { name: "Show self" })).toBeInTheDocument();
    });

    it("lists the four connection-method options, reflecting the current one, and closes the menu on pick", () => {
        const { props } = renderControls({ transportMode: "relay" });
        fireEvent.click(screen.getByRole("button", { name: "More options" }));
        expect(screen.getByRole("menuitemradio", { name: "Auto" })).toHaveAttribute("aria-checked", "false");
        expect(screen.getByRole("menuitemradio", { name: "P2P" })).toHaveAttribute("aria-checked", "false");
        expect(screen.getByRole("menuitemradio", { name: "Relay" })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("menuitemradio", { name: "WebSocket Relay" })).toHaveAttribute("aria-checked", "false");

        fireEvent.click(screen.getByRole("menuitemradio", { name: "WebSocket Relay" }));
        expect(props.onSetTransportMode).toHaveBeenCalledWith("websocket");
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("offers Settings only to the host, and closes the menu on pick", () => {
        const { props, rerender } = renderControls({ isHost: false });
        fireEvent.click(screen.getByRole("button", { name: "More options" }));
        expect(screen.queryByRole("menuitem", { name: "Settings" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "More options" }));

        rerender(<CallControls {...{ ...props, isHost: true }} />);
        fireEvent.click(screen.getByRole("button", { name: "More options" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
        expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("menu")).toBeNull();
    });
});

