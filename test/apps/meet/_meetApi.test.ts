// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { joinMeeting, kickParticipant, setForceMuteOnJoin } from "../../../apps/meet/_meetApi.js";

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

describe("kickParticipant", () => {
    it("POSTs the kick endpoint with the meeting uid and participant uid URL-encoded", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/m1/kick/guest%3Aabc");
            expect(init?.method).toBe("POST");
            return jsonResponse(204, undefined);
        });

        await kickParticipant("m1", "guest:abc");

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (not the host)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Permission denied." }));
        await expect(kickParticipant("m1", "guest:abc")).rejects.toMatchObject({ status: 403 });
    });
});

describe("setForceMuteOnJoin", () => {
    it("PUTs the meeting's own endpoint with the new setting", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/m1");
            expect(init?.method).toBe("PUT");
            expect(JSON.parse(init?.body as string)).toEqual({ forceMuteOnJoin: true });
            return jsonResponse(200, { uid: "m1", forceMuteOnJoin: true });
        });

        await setForceMuteOnJoin("m1", true);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (not the host)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Permission denied." }));
        await expect(setForceMuteOnJoin("m1", false)).rejects.toMatchObject({ status: 403 });
    });
});
