// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { joinMeeting } from "../../../apps/meet/_meetApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("joinMeeting", () => {
    it("GETs the join endpoint with the token URL-encoded", async () => {
        const fetchMock = mockFetch((url) => {
            expect(url).toBe("/api/mail/video-meetings/join/abc%2Fdef");
            return jsonResponse(200, {
                meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled" },
                iceServers: [{ urls: "stun:stun.example.com:19302" }],
                authenticated: false,
                selfUid: "guest:1",
                token: "guest-jwt",
                expiresAt: "2026-01-01T00:00:00.000Z",
            });
        });

        const result = await joinMeeting("abc/def");

        expect(result.meeting.uid).toBe("m1");
        expect(result.token).toBe("guest-jwt");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("passes through an already-authenticated real caller's response with no guest token", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled" },
                iceServers: [{ urls: "stun:stun.example.com:19302" }],
                authenticated: true,
                selfUid: "real-user-1",
            }),
        );

        const result = await joinMeeting("tok1");

        expect(result.authenticated).toBe(true);
        expect(result.selfUid).toBe("real-user-1");
        expect(result.token).toBeUndefined();
    });

    it("rejects with an ApiRequestError on a 404", async () => {
        mockFetch(() => jsonResponse(404, { message: "Not Found." }));
        await expect(joinMeeting("stale-token")).rejects.toMatchObject({ status: 404 });
    });
});
