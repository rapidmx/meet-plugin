// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MeetLobby, { type JoinPreferences } from "../../../apps/meet/_MeetLobby.js";
import { fakeDeviceInfo, fakeMediaDevices, fakeMediaStream, fakeTrack } from "../testUtils.js";
import type { PublicVideoMeeting } from "../../../apps/meet/_meetApi.js";

const meeting: PublicVideoMeeting = { uid: "m1", title: "Standup", visibility: "public", status: "scheduled", hostDisplayName: "Jane" };

/** jsdom implements neither `navigator.mediaDevices` nor a `MediaStream` constructor at all - both are stubbed
 * per test, matching this plugin's Phase 2 report note that there was no existing mocking convention to build on. */
function installMediaDevices(devices: ReturnType<typeof fakeMediaDevices>) {
    Object.defineProperty(window.navigator, "mediaDevices", { value: devices, configurable: true });
}

function installFakeMediaStreamConstructor() {
    vi.stubGlobal(
        "MediaStream",
        class {
            getTracks() {
                return [];
            }
            getAudioTracks() {
                return [];
            }
            getVideoTracks() {
                return [];
            }
        },
    );
}

afterEach(() => {
    Object.defineProperty(window.navigator, "mediaDevices", { value: undefined, configurable: true });
    vi.unstubAllGlobals();
});

describe("MeetLobby", () => {
    it("shows a plain message and still allows joining when mediaDevices isn't supported", async () => {
        installFakeMediaStreamConstructor();
        const onJoin = vi.fn();
        render(<MeetLobby meeting={meeting} onJoin={onJoin} />);

        expect(await screen.findByText(/doesn't support camera\/microphone/i)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Guest" } });
        fireEvent.click(screen.getByText("Join meeting"));
        expect(onJoin).toHaveBeenCalledWith<[JoinPreferences]>({ name: "Guest", micOn: true, cameraOn: true, stream: expect.anything() });
    });

    it("shows the host's name, requests media on mount, and renders a live preview", async () => {
        const stream = fakeMediaStream([fakeTrack("audio"), fakeTrack("video")]);
        installMediaDevices(fakeMediaDevices({ userMediaStream: stream }));
        render(<MeetLobby meeting={meeting} onJoin={vi.fn()} />);

        expect(screen.getByText("Standup")).toBeInTheDocument();
        expect(screen.getByText("Hosted by Jane")).toBeInTheDocument();
        await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
    });

    it("toggles mic/camera by disabling the underlying tracks, not re-requesting media", async () => {
        const audio = fakeTrack("audio");
        const video = fakeTrack("video");
        const stream = fakeMediaStream([audio, video]);
        const devices = fakeMediaDevices({ userMediaStream: stream });
        installMediaDevices(devices);
        render(<MeetLobby meeting={meeting} onJoin={vi.fn()} />);
        await waitFor(() => expect(document.querySelector("video")).not.toBeNull());

        fireEvent.click(screen.getByText("Mute mic"));
        expect(audio.enabled).toBe(false);
        expect(screen.getByText("Unmute mic")).toBeInTheDocument();
        expect(devices.getUserMedia).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByText("Turn camera off"));
        expect(video.enabled).toBe(false);
        expect(screen.getByText("Camera is off")).toBeInTheDocument();
    });

    it("shows a friendly message and still allows joining when getUserMedia is denied", async () => {
        const err = new Error("denied");
        err.name = "NotAllowedError";
        installMediaDevices(fakeMediaDevices({ userMediaError: err }));
        installFakeMediaStreamConstructor();
        const onJoin = vi.fn();
        render(<MeetLobby meeting={meeting} onJoin={onJoin} />);

        expect(await screen.findByText(/access was denied/i)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Guest" } });
        fireEvent.click(screen.getByText("Join meeting"));
        expect(onJoin).toHaveBeenCalledTimes(1);
    });

    it("prefills but keeps the name editable, and disables Join until it's non-empty", async () => {
        installFakeMediaStreamConstructor();
        installMediaDevices(fakeMediaDevices({ omitEnumerate: true, omitGetUserMedia: true, omitGetDisplayMedia: true }));
        const onJoin = vi.fn();
        render(<MeetLobby meeting={meeting} initialName="Jane Prefill" onJoin={onJoin} />);
        const input = screen.getByLabelText<HTMLInputElement>("Your name");
        expect(input.value).toBe("Jane Prefill");
        expect(screen.getByText("Join meeting")).not.toBeDisabled();

        fireEvent.change(input, { target: { value: "" } });
        expect(screen.getByText("Join meeting")).toBeDisabled();

        fireEvent.change(input, { target: { value: "  Renamed  " } });
        fireEvent.click(screen.getByText("Join meeting"));
        expect(onJoin.mock.calls[0][0].name).toBe("Renamed");
    });

    it("lists cameras/microphones once there is more than one, and switches devices", async () => {
        const initialVideo = fakeTrack("video");
        const initialStream = fakeMediaStream([fakeTrack("audio"), initialVideo]);
        const newVideo = fakeTrack("video");
        const newVideoStream = fakeMediaStream([newVideo]);
        let call = 0;
        const devices = fakeMediaDevices({
            devices: [fakeDeviceInfo("videoinput", "cam1", "Camera 1"), fakeDeviceInfo("videoinput", "cam2", "")],
            userMediaStream: () => (call++ === 0 ? initialStream : newVideoStream),
        });
        installMediaDevices(devices);
        render(<MeetLobby meeting={meeting} onJoin={vi.fn()} />);

        const select = await screen.findByLabelText("Camera");
        const options = screen.getAllByRole("option");
        expect(options).toHaveLength(2);
        // The unlabeled device falls back to a plain "Camera" option label - same text as the field's own label.
        expect(options[1]).toHaveTextContent("Camera");
        fireEvent.change(select, { target: { value: "cam2" } });
        await waitFor(() => expect(devices.getUserMedia).toHaveBeenCalledTimes(2));
        expect(devices.getUserMedia).toHaveBeenLastCalledWith({ video: { deviceId: { exact: "cam2" } }, audio: false });
    });

    it("switches microphones, applying the current mute preference to the new track", async () => {
        const initialAudio = fakeTrack("audio");
        const initialStream = fakeMediaStream([initialAudio, fakeTrack("video")]);
        const newAudio = fakeTrack("audio");
        const newAudioStream = fakeMediaStream([newAudio]);
        let call = 0;
        const devices = fakeMediaDevices({
            devices: [fakeDeviceInfo("audioinput", "mic1", "Mic 1"), fakeDeviceInfo("audioinput", "mic2", "")],
            userMediaStream: () => (call++ === 0 ? initialStream : newAudioStream),
        });
        installMediaDevices(devices);
        render(<MeetLobby meeting={meeting} onJoin={vi.fn()} />);
        const select = await screen.findByLabelText("Microphone");
        expect(screen.getAllByRole("option")[1]).toHaveTextContent("Microphone");

        fireEvent.click(screen.getByText("Mute mic"));
        expect(initialAudio.enabled).toBe(false);

        fireEvent.change(select, { target: { value: "mic2" } });
        await waitFor(() => expect(devices.getUserMedia).toHaveBeenCalledTimes(2));
        // The new track picks up the already-muted preference rather than defaulting back to enabled.
        expect(newAudio.enabled).toBe(false);
        expect(initialAudio.stop).toHaveBeenCalledTimes(1);
    });

    it("shows an error and does not swap when switching devices fails", async () => {
        const stream = fakeMediaStream([fakeTrack("audio"), fakeTrack("video")]);
        const err = new Error("nope");
        err.name = "NotFoundError";
        const devices = fakeMediaDevices({
            devices: [fakeDeviceInfo("audioinput", "mic1", "Mic 1"), fakeDeviceInfo("audioinput", "mic2", "Mic 2")],
            userMediaStream: stream,
        });
        installMediaDevices(devices);
        render(<MeetLobby meeting={meeting} onJoin={vi.fn()} />);
        const select = await screen.findByLabelText("Microphone");
        devices.getUserMedia!.mockImplementationOnce(async () => Promise.reject(err));
        fireEvent.change(select, { target: { value: "mic2" } });
        expect(await screen.findByText(/no camera or microphone was found/i)).toBeInTheDocument();
    });

    it("stops the preview stream's tracks on unmount", async () => {
        const audio = fakeTrack("audio");
        const video = fakeTrack("video");
        installMediaDevices(fakeMediaDevices({ userMediaStream: fakeMediaStream([audio, video]) }));
        const { unmount } = render(<MeetLobby meeting={meeting} onJoin={vi.fn()} />);
        await waitFor(() => expect(document.querySelector("video")).not.toBeNull());
        unmount();
        expect(audio.stop).toHaveBeenCalledTimes(1);
        expect(video.stop).toHaveBeenCalledTimes(1);
    });

    it("does not update state after unmounting while the initial request is still pending", async () => {
        let resolve!: (value: { ok: true; value: MediaStream }) => void;
        const devices = fakeMediaDevices({});
        devices.getUserMedia!.mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r as never;
                }),
        );
        installMediaDevices(devices);
        const { unmount } = render(<MeetLobby meeting={meeting} onJoin={vi.fn()} />);
        unmount();
        resolve({ ok: true, value: fakeMediaStream([]) } as never);
        await Promise.resolve();
        // No React "update on an unmounted component" warning/crash - nothing further to assert.
    });

    it("ignores a device switch whose new stream has no matching track, without crashing", async () => {
        const stream = fakeMediaStream([fakeTrack("audio")]);
        const devices = fakeMediaDevices({
            devices: [fakeDeviceInfo("audioinput", "mic1", "Mic 1"), fakeDeviceInfo("audioinput", "mic2", "Mic 2")],
            userMediaStream: stream,
        });
        installMediaDevices(devices);
        // The "switch" call resolves a stream with no audio track at all (defensive: e.g. a device that vanished).
        devices.getUserMedia!.mockImplementationOnce(async () => stream).mockImplementationOnce(async () => fakeMediaStream([]));
        render(<MeetLobby meeting={meeting} onJoin={vi.fn()} />);
        const select = await screen.findByLabelText("Microphone");
        fireEvent.change(select, { target: { value: "mic2" } });
        await waitFor(() => expect(devices.getUserMedia).toHaveBeenCalledTimes(2));
    });
});
