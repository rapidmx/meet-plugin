// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeMediaDevices, fakeMediaStream, fakeTrack, installFakeMediaStream, installMediaDevices, jsonResponse, mockFetch, removeMediaDevices } from "../testUtils.js";
import type { CallViewProps } from "../../../apps/meet/_CallView.js";
import MeetJoinPage from "../../../apps/meet/[token].js";

const { calls } = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("../../../apps/meet/_CallView.js", () => ({
    default: (props: CallViewProps) => {
        calls.push(props);
        return (
            <div>
                <p>In call as {props.selfName}</p>
                <p>Meeting: {props.meetingTitle}</p>
                <p>Signaling token: {props.token ?? "(none - authenticated)"}</p>
                <p>Self uid: {props.selfUid}</p>
                <button type="button" onClick={props.onLeave}>
                    Leave (test)
                </button>
            </div>
        );
    },
}));

const joinResponse = {
    meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled", hostDisplayName: "Jane" },
    iceServers: [{ urls: "stun:stun.example.com:19302" }],
    authenticated: false,
    selfUid: "guest:1",
    token: "guest-token",
    expiresAt: "2026-01-01T00:00:00.000Z",
};

const authenticatedJoinResponse = {
    meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled", hostDisplayName: "Jane" },
    iceServers: [{ urls: "stun:stun.example.com:19302" }],
    authenticated: true,
    selfUid: "real-user-1",
};

function mockJoin(response: unknown) {
    mockFetch((url) => {
        if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
        if (url === "/api/mail/video-meetings/join/tok1") return jsonResponse(200, response);
        throw new Error(`unexpected ${url}`);
    });
}

beforeEach(() => {
    calls.length = 0;
    installFakeMediaStream();
});

afterEach(() => {
    removeMediaDevices();
    vi.unstubAllGlobals();
});

describe("MeetJoinPage", () => {
    it("carries the lobby's camera and microphone into the call, and releases them when the participant leaves", async () => {
        const audio = fakeTrack("audio");
        const video = fakeTrack("video");
        const devices = fakeMediaDevices({ userMediaStream: fakeMediaStream([audio, video]) });
        installMediaDevices(devices);
        mockJoin(joinResponse);

        render(<MeetJoinPage params={{ token: "tok1" }} />);
        expect(screen.getByText(/Loading/)).toBeInTheDocument();
        expect(await screen.findByText("Standup")).toBeInTheDocument();
        // The lobby is drawn inside the branded page shell.
        expect(screen.getByRole("main")).toBeInTheDocument();
        await waitFor(() => expect(devices.getUserMedia).toHaveBeenCalledTimes(1));

        fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Guest" } });
        await waitFor(() => expect(screen.getByText("Join meeting")).toBeEnabled());
        fireEvent.click(screen.getByText("Join meeting"));

        expect(await screen.findByText("In call as Guest")).toBeInTheDocument();
        expect(screen.getByText("Meeting: Standup")).toBeInTheDocument();
        expect(screen.getByText("Signaling token: guest-token")).toBeInTheDocument();
        expect(screen.getByText("Self uid: guest:1")).toBeInTheDocument();
        // The call fills the window rather than sitting inside the page shell...
        expect(screen.queryByRole("main")).toBeNull();
        // ...and is handed the very tracks the lobby previewed - still running, not stopped by the lobby unmounting.
        const props = calls[calls.length - 1] as CallViewProps;
        expect(props.media.audioTrack).toBe(audio);
        expect(props.media.videoTrack).toBe(video);
        expect(props.iceServers).toEqual(joinResponse.iceServers);
        expect(audio.stop).not.toHaveBeenCalled();
        expect(video.stop).not.toHaveBeenCalled();

        fireEvent.click(screen.getByText("Leave (test)"));
        expect(await screen.findByText("You left the meeting")).toBeInTheDocument();
        expect(audio.stop).toHaveBeenCalled();
        expect(video.stop).toHaveBeenCalled();
    });

    it("lets a participant who left rejoin, asking for the camera and microphone again", async () => {
        const devices = fakeMediaDevices({ userMediaStream: () => fakeMediaStream([fakeTrack("audio"), fakeTrack("video")]) });
        installMediaDevices(devices);
        mockJoin(joinResponse);

        render(<MeetJoinPage params={{ token: "tok1" }} />);
        expect(await screen.findByText("Standup")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Guest" } });
        fireEvent.click(screen.getByText("Join meeting"));
        fireEvent.click(await screen.findByText("Leave (test)"));

        fireEvent.click(await screen.findByText("Rejoin meeting"));
        expect(await screen.findByText("Standup")).toBeInTheDocument();
        // The name is kept, and the devices are asked for again.
        expect(screen.getByLabelText("Your name")).toHaveValue("Guest");
        await waitFor(() => expect(devices.getUserMedia).toHaveBeenCalledTimes(2));
    });

    it("passes no signaling token through to CallView when join() reports the caller as already authenticated", async () => {
        mockJoin(authenticatedJoinResponse);

        render(<MeetJoinPage params={{ token: "tok1" }} />);
        expect(await screen.findByText("Standup")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
        fireEvent.click(screen.getByText("Join meeting"));

        expect(await screen.findByText("In call as Ada")).toBeInTheDocument();
        expect(screen.getByText("Signaling token: (none - authenticated)")).toBeInTheDocument();
        expect(screen.getByText("Self uid: real-user-1")).toBeInTheDocument();
    });

    it("shows a friendly not-found state for a stale token", async () => {
        mockFetch((url) => {
            if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
            if (url === "/api/mail/video-meetings/join/stale") return jsonResponse(404, { message: "Not Found." });
            throw new Error(`unexpected ${url}`);
        });
        render(<MeetJoinPage params={{ token: "stale" }} />);
        expect(await screen.findByText("This meeting link isn't valid.")).toBeInTheDocument();
    });

    it("shows the error message for a non-404 failure", async () => {
        mockFetch((url) => {
            if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
            if (url === "/api/mail/video-meetings/join/tok1") return jsonResponse(500, { message: "Server exploded." });
            throw new Error(`unexpected ${url}`);
        });
        render(<MeetJoinPage params={{ token: "tok1" }} />);
        expect(await screen.findByText("Server exploded.")).toBeInTheDocument();
    });

    it("does not update state after unmounting while the join request is still pending (success)", async () => {
        let resolveJoin!: (response: Response) => void;
        mockFetch((url) => {
            if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
            if (url === "/api/mail/video-meetings/join/tok1") {
                return new Promise<Response>((resolve) => {
                    resolveJoin = resolve;
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        const { unmount } = render(<MeetJoinPage params={{ token: "tok1" }} />);
        unmount();
        resolveJoin(jsonResponse(200, joinResponse));
        await Promise.resolve();
    });

    it("does not update state after unmounting while the join request is still pending (failure)", async () => {
        let rejectJoin!: () => void;
        mockFetch((url) => {
            if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
            if (url === "/api/mail/video-meetings/join/tok1") {
                return new Promise<Response>((_resolve, reject) => {
                    rejectJoin = () => reject(new Error("network down"));
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        const { unmount } = render(<MeetJoinPage params={{ token: "tok1" }} />);
        unmount();
        rejectJoin();
        await Promise.resolve();
        await Promise.resolve();
    });
});
