// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CallControls from "../../../apps/meet/_CallControls.js";

const noop = () => undefined;

describe("CallControls", () => {
    it("shows Mute/Turn camera off/Share screen/Focused view when everything is on and nobody else presents", () => {
        render(
            <CallControls
                micOn
                onToggleMic={noop}
                cameraOn
                onToggleCamera={noop}
                isPresenting={false}
                onToggleShare={noop}
                viewMode="grid"
                onToggleViewMode={noop}
                onLeave={noop}
            />,
        );
        expect(screen.getByText("Mute")).toBeInTheDocument();
        expect(screen.getByText("Turn camera off")).toBeInTheDocument();
        expect(screen.getByText("Share screen")).not.toBeDisabled();
        expect(screen.getByText("Focused view")).toBeInTheDocument();
        expect(screen.getByText("Leave")).toBeInTheDocument();
    });

    it("shows Unmute/Turn camera on/Grid view when off/off/focus", () => {
        render(
            <CallControls
                micOn={false}
                onToggleMic={noop}
                cameraOn={false}
                onToggleCamera={noop}
                isPresenting={false}
                onToggleShare={noop}
                viewMode="focus"
                onToggleViewMode={noop}
                onLeave={noop}
            />,
        );
        expect(screen.getByText("Unmute")).toBeInTheDocument();
        expect(screen.getByText("Turn camera on")).toBeInTheDocument();
        expect(screen.getByText("Grid view")).toBeInTheDocument();
    });

    it("shows Stop sharing while presenting, always enabled", () => {
        render(
            <CallControls
                micOn
                onToggleMic={noop}
                cameraOn
                onToggleCamera={noop}
                isPresenting
                onToggleShare={noop}
                viewMode="grid"
                onToggleViewMode={noop}
                onLeave={noop}
            />,
        );
        expect(screen.getByText("Stop sharing")).not.toBeDisabled();
    });

    it("disables Share screen and explains why when someone else is presenting", () => {
        render(
            <CallControls
                micOn
                onToggleMic={noop}
                cameraOn
                onToggleCamera={noop}
                isPresenting={false}
                presentingElsewhereName="Zed"
                onToggleShare={noop}
                viewMode="grid"
                onToggleViewMode={noop}
                onLeave={noop}
            />,
        );
        const button = screen.getByText("Share screen");
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("title", expect.stringContaining("Zed is presenting"));
    });

    it("invokes each callback", () => {
        const onToggleMic = vi.fn();
        const onToggleCamera = vi.fn();
        const onToggleShare = vi.fn();
        const onToggleViewMode = vi.fn();
        const onLeave = vi.fn();
        render(
            <CallControls
                micOn
                onToggleMic={onToggleMic}
                cameraOn
                onToggleCamera={onToggleCamera}
                isPresenting={false}
                onToggleShare={onToggleShare}
                viewMode="grid"
                onToggleViewMode={onToggleViewMode}
                onLeave={onLeave}
            />,
        );
        fireEvent.click(screen.getByText("Mute"));
        fireEvent.click(screen.getByText("Turn camera off"));
        fireEvent.click(screen.getByText("Share screen"));
        fireEvent.click(screen.getByText("Focused view"));
        fireEvent.click(screen.getByText("Leave"));
        expect(onToggleMic).toHaveBeenCalledTimes(1);
        expect(onToggleCamera).toHaveBeenCalledTimes(1);
        expect(onToggleShare).toHaveBeenCalledTimes(1);
        expect(onToggleViewMode).toHaveBeenCalledTimes(1);
        expect(onLeave).toHaveBeenCalledTimes(1);
    });
});
