// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MeetLobby, { type MeetLobbyProps } from "../../../apps/meet/_MeetLobby.js";
import type { LocalMedia } from "../../../apps/shared/media/useLocalMedia.js";
import { fakeDeviceInfo, fakeLocalMedia } from "../testUtils.js";
import type { PublicVideoMeeting } from "../../../apps/meet/_meetApi.js";

const meeting: PublicVideoMeeting = { uid: "m1", title: "Standup", visibility: "public", status: "scheduled", hostDisplayName: "Jane" };

function renderLobby(mediaOverrides: Partial<LocalMedia> = {}, props: Partial<MeetLobbyProps> = {}) {
    const media = fakeLocalMedia(mediaOverrides);
    const onJoin = vi.fn();
    const result = render(<MeetLobby meeting={meeting} media={media} onJoin={onJoin} {...props} />);
    return { ...result, media, onJoin };
}

const NO_PICTURE = { videoStream: null, videoTrack: null, cameraOn: false };

describe("MeetLobby - joining", () => {
    it("shows the meeting and its host, and asks for the camera and microphone once when it opens", () => {
        const { media, rerender } = renderLobby();
        expect(screen.getByText("Standup")).toBeInTheDocument();
        expect(screen.getByText("Hosted by Jane")).toBeInTheDocument();
        expect(media.requestAccess).toHaveBeenCalledTimes(1);

        rerender(<MeetLobby meeting={meeting} media={media} onJoin={vi.fn()} />);
        expect(media.requestAccess).toHaveBeenCalledTimes(1);
    });

    it("omits the host line when there is none", () => {
        renderLobby({}, { meeting: { ...meeting, hostDisplayName: undefined } });
        expect(screen.queryByText(/Hosted by/)).toBeNull();
    });

    it("needs a name before it lets the participant join, and joins with it trimmed", () => {
        const { onJoin } = renderLobby();
        const join = screen.getByText("Join meeting");
        expect(join).toBeDisabled();
        fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "   " } });
        expect(join).toBeDisabled();

        fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "  Guest  " } });
        expect(join).toBeEnabled();
        fireEvent.click(join);
        expect(onJoin).toHaveBeenCalledWith("Guest");
    });

    it("prefills a name it is given, still editable", () => {
        renderLobby({}, { initialName: "Ada" });
        expect(screen.getByLabelText("Your name")).toHaveValue("Ada");
    });
});

describe("MeetLobby - preview and buttons", () => {
    it("previews the camera in a muted video", () => {
        const { container, media } = renderLobby();
        const video = container.querySelector("video")!;
        expect(video.muted).toBe(true);
        expect(video.srcObject).toBe(media.videoStream);
    });

    it("says what is wrong instead of a picture", () => {
        const cases: [Partial<LocalMedia>, string][] = [
            [{ supported: false }, "This browser can't use a camera or microphone here."],
            [{ requesting: true }, "Waiting for camera and microphone access…"],
            [{ status: { audio: "live", video: "off" } }, "Camera is off"],
            [{ status: { audio: "denied", video: "denied" } }, "Camera access is blocked"],
            [{ status: { audio: "live", video: "unavailable" } }, "No camera found"],
            [{ status: { audio: "live", video: "error" } }, "Camera couldn't start"],
            [{ status: { audio: "live", video: "pending" } }, "No camera preview"],
        ];
        for (const [overrides, message] of cases) {
            const { container, unmount } = renderLobby({ ...NO_PICTURE, ...overrides });
            expect(screen.getByText(message)).toBeInTheDocument();
            expect(container.querySelector("video")).toBeNull();
            unmount();
        }
    });

    it("shows the microphone with its level while live, and turns it and the camera on and off", () => {
        const { media } = renderLobby({ audioLevel: 2 });
        expect(screen.getByTestId("mic-level")).toHaveAttribute("data-level", "2");
        fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
        fireEvent.click(screen.getByRole("button", { name: "Turn off camera" }));
        expect(media.toggleMic).toHaveBeenCalledTimes(1);
        expect(media.toggleCamera).toHaveBeenCalledTimes(1);
    });

    it("shows a muted microphone and a camera that is off", () => {
        renderLobby({ ...NO_PICTURE, micOn: false });
        expect(screen.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.queryByTestId("mic-level")).toBeNull();
        expect(screen.getByRole("button", { name: "Turn on camera" })).toHaveAttribute("aria-pressed", "true");
    });
});

describe("MeetLobby - permission", () => {
    it("explains an unsupported browser, and that the participant can still join", () => {
        renderLobby({ supported: false, audioTrack: null, ...NO_PICTURE, status: { audio: "pending", video: "pending" } });
        expect(screen.getByText(/doesn't support camera\/microphone access/)).toBeInTheDocument();
        expect(screen.getByText("You'll join without a camera or microphone.")).toBeInTheDocument();
        // Nothing to ask for in a browser that can't.
        expect(screen.queryByText("Allow camera and microphone")).toBeNull();
    });

    it("offers a button to ask for access when it hasn't been given", () => {
        const { media } = renderLobby({ status: { audio: "pending", video: "pending" } });
        fireEvent.click(screen.getByText("Allow camera and microphone"));
        // The mount request plus the click - and the click asks for both, not one kind.
        expect(media.requestAccess).toHaveBeenCalledTimes(2);
        expect(media.requestAccess).toHaveBeenLastCalledWith();
    });

    it("shows why a request failed, with a way to try again", () => {
        const { media } = renderLobby({
            audioTrack: null,
            ...NO_PICTURE,
            status: { audio: "denied", video: "denied" },
            error: { kind: "permission-denied", message: "Camera/microphone access was denied. Allow access in your browser and try again." },
        });
        expect(screen.getByText(/access was denied/)).toBeInTheDocument();
        expect(screen.queryByText("Allow camera and microphone")).toBeNull();
        fireEvent.click(screen.getByText("Try again"));
        expect(media.requestAccess).toHaveBeenCalledTimes(2);
        expect(screen.getByText("You'll join without a camera or microphone.")).toBeInTheDocument();
    });

    it("asks again when only the microphone is missing, but not for a camera the participant turned off", () => {
        const missing = renderLobby({ status: { audio: "denied", video: "live" } });
        expect(screen.getByText("Allow camera and microphone")).toBeInTheDocument();
        missing.unmount();

        renderLobby({ status: { audio: "live", video: "off" } });
        expect(screen.queryByText("Allow camera and microphone")).toBeNull();
    });

    it("doesn't offer to ask again while a request is in flight, or when everything is working", () => {
        const waiting = renderLobby({ requesting: true, status: { audio: "pending", video: "pending" } });
        expect(screen.queryByText("Allow camera and microphone")).toBeNull();
        waiting.unmount();

        renderLobby();
        expect(screen.queryByText("Allow camera and microphone")).toBeNull();
        expect(screen.queryByText(/You'll join without/)).toBeNull();
    });
});

describe("MeetLobby - devices", () => {
    const cameras = [fakeDeviceInfo("videoinput", "cam-1", "Front"), fakeDeviceInfo("videoinput", "cam-2", "")];
    const microphones = [fakeDeviceInfo("audioinput", "mic-1", "Built-in"), fakeDeviceInfo("audioinput", "mic-2", "USB")];

    it("offers a choice only when there is more than one device, and switches to the one picked", () => {
        const { media } = renderLobby({ devices: { cameras, microphones }, selectedDeviceIds: { video: "cam-1", audio: "mic-2" } });

        const camera = screen.getByLabelText<HTMLSelectElement>("Camera");
        const microphone = screen.getByLabelText<HTMLSelectElement>("Microphone");
        expect(camera.value).toBe("cam-1");
        expect(microphone.value).toBe("mic-2");
        // An unlabeled device still gets a name.
        expect(screen.getByRole("option", { name: "Camera 2" })).toBeInTheDocument();

        fireEvent.change(camera, { target: { value: "cam-2" } });
        expect(media.selectDevice).toHaveBeenCalledWith("video", "cam-2");
        fireEvent.change(microphone, { target: { value: "mic-1" } });
        expect(media.selectDevice).toHaveBeenCalledWith("audio", "mic-1");
    });

    it("prompts for a choice while none is in use", () => {
        renderLobby({ devices: { cameras, microphones }, selectedDeviceIds: {} });
        expect(screen.getByRole("option", { name: "Choose a camera" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Choose a microphone" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Built-in" })).toBeInTheDocument();
    });

    it("shows no picker for a single device", () => {
        renderLobby({ devices: { cameras: [cameras[0]], microphones: [microphones[0]] } });
        expect(screen.queryByLabelText("Camera")).toBeNull();
        expect(screen.queryByLabelText("Microphone")).toBeNull();
    });
});
