// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MeetJoinPage from "../../../apps/meet/[token].js";

vi.mock("../../../apps/meet/_CallView.js", () => ({
    default: (props: { onLeave: () => void; selfName: string; token?: string; selfUid: string }) => (
        <div>
            <p>In call as {props.selfName}</p>
            <p>Signaling token: {props.token ?? "(none - authenticated)"}</p>
            <p>Self uid: {props.selfUid}</p>
            <button type="button" onClick={props.onLeave}>
                Leave (test)
            </button>
        </div>
    ),
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

afterEach(() => {
    vi.unstubAllGlobals();
});

// jsdom has no `MediaStream` constructor at all - `_MeetLobby.tsx`'s "join with no device access" fallback needs
// one, exercised for real by the first test below (no `navigator.mediaDevices` is stubbed in this file - that
// path is covered in depth by `_MeetLobby.test.tsx` itself).
class FakeMediaStream {
    getTracks() {
        return [];
    }
}

describe("MeetJoinPage", () => {
    it("loads, shows the lobby, joins and then leaves back to the ended state", async () => {
        vi.stubGlobal("MediaStream", FakeMediaStream);
        mockFetch((url) => {
            if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
            if (url === "/api/mail/video-meetings/join/tok1") return jsonResponse(200, joinResponse);
            throw new Error(`unexpected ${url}`);
        });

        render(<MeetJoinPage params={{ token: "tok1" }} />);
        expect(screen.getByText(/Loading/)).toBeInTheDocument();
        expect(await screen.findByText("Standup")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Guest" } });
        // No `navigator.mediaDevices` in this test's plain jsdom setup - the lobby's own tests cover that path in
        // depth; here it only matters that joining hands off cleanly into the (mocked) call view.
        fireEvent.click(screen.getByText("Join meeting"));

        expect(await screen.findByText("In call as Guest")).toBeInTheDocument();
        expect(screen.getByText("Signaling token: guest-token")).toBeInTheDocument();
        expect(screen.getByText("Self uid: guest:1")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Leave (test)"));
        expect(await screen.findByText("You left the meeting")).toBeInTheDocument();
    });

    it("passes no signaling token through to CallView when join() reports the caller as already authenticated", async () => {
        vi.stubGlobal("MediaStream", FakeMediaStream);
        mockFetch((url) => {
            if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
            if (url === "/api/mail/video-meetings/join/tok1") return jsonResponse(200, authenticatedJoinResponse);
            throw new Error(`unexpected ${url}`);
        });

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
