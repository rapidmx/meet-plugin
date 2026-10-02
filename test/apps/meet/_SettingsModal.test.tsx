// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SettingsModal, { type SettingsModalProps } from "../../../apps/meet/_SettingsModal.js";

function renderModal(overrides: Partial<SettingsModalProps> = {}) {
    const props: SettingsModalProps = {
        forceMuteOnJoin: false,
        onToggleForceMuteOnJoin: vi.fn(),
        hasPassword: false,
        onSetPassword: vi.fn().mockResolvedValue(undefined),
        waitingRoomEnabled: false,
        onToggleWaitingRoomEnabled: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
    return { ...render(<SettingsModal {...props} />), props };
}

describe("SettingsModal", () => {
    it("reflects the current forceMuteOnJoin and waitingRoomEnabled settings", () => {
        renderModal({ forceMuteOnJoin: true, waitingRoomEnabled: true });
        expect(screen.getByRole("checkbox", { name: "Mute new participants on join" })).toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Require the host to admit participants" })).toBeChecked();
    });

    it("toggles mute-on-join and the waiting room via their own callbacks", () => {
        const { props } = renderModal();
        fireEvent.click(screen.getByRole("checkbox", { name: "Mute new participants on join" }));
        expect(props.onToggleForceMuteOnJoin).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("checkbox", { name: "Require the host to admit participants" }));
        expect(props.onToggleWaitingRoomEnabled).toHaveBeenCalledTimes(1);
    });

    it("says no password is required when none is set, with no remove button", () => {
        renderModal();
        expect(screen.getByText("No password required to join.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Remove password" })).toBeNull();
    });

    it("sets a password and clears the input once saved - hasPassword is the caller's own state to update", async () => {
        const { props } = renderModal();
        const input = screen.getByLabelText("Set a password");
        fireEvent.change(input, { target: { value: "s3cret" } });
        fireEvent.click(screen.getByRole("button", { name: "Set" }));

        await waitFor(() => expect(props.onSetPassword).toHaveBeenCalledWith("s3cret"));
        expect(await screen.findByLabelText("Set a password")).toHaveValue("");
    });

    it("removes the password via onSetPassword(null)", async () => {
        const { props } = renderModal({ hasPassword: true });
        fireEvent.click(screen.getByRole("button", { name: "Remove password" }));
        await waitFor(() => expect(props.onSetPassword).toHaveBeenCalledWith(null));
    });

    it("does nothing if the form is submitted with an empty password", () => {
        const { props } = renderModal();
        fireEvent.submit(screen.getByLabelText("Set a password").closest("form")!);
        expect(props.onSetPassword).not.toHaveBeenCalled();
    });

    it("shows an inline error and keeps the previous status when saving fails", async () => {
        const onSetPassword = vi.fn().mockRejectedValue(new Error("network error"));
        renderModal({ onSetPassword });
        fireEvent.change(screen.getByLabelText("Set a password"), { target: { value: "s3cret" } });
        fireEvent.click(screen.getByRole("button", { name: "Set" }));

        expect(await screen.findByText("Could not save - try again.")).toBeInTheDocument();
        expect(screen.getByText("No password required to join.")).toBeInTheDocument();
    });

    it("closes on its own close button, on Escape, and on a click on the backdrop - but not on a click inside", () => {
        const { props, rerender } = renderModal();
        fireEvent.click(screen.getByRole("button", { name: "Close meeting settings" }));
        expect(props.onClose).toHaveBeenCalledTimes(1);

        rerender(<SettingsModal {...props} />);
        fireEvent.click(screen.getByRole("dialog", { name: "Meeting settings" }));
        expect(props.onClose).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(document, { key: "Escape" });
        expect(props.onClose).toHaveBeenCalledTimes(2);

        fireEvent.click(screen.getByRole("dialog", { name: "Meeting settings" }).previousSibling as Element);
        expect(props.onClose).toHaveBeenCalledTimes(3);
    });
});
