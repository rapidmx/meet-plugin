// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    admitParticipant,
    denyParticipant,
    joinMeeting,
    kickParticipant,
    listWaitingParticipants,
    pollAdmission,
    requestAdmission,
    setForceMuteOnJoin,
    setMeetingPassword,
    setWaitingRoomEnabled,
    verifyMeetingPassword,
} from "../../../apps/meet/_meetApi.js";

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

    it("passes through a password-required response with no grant at all", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled", hasPassword: true },
                requiresPassword: true,
            }),
        );

        const result = await joinMeeting("tok1");

        expect("requiresPassword" in result && result.requiresPassword).toBe(true);
        expect(result.meeting.hasPassword).toBe(true);
    });

    it("passes through an admission-required response with no grant at all", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled", waitingRoomEnabled: true },
                requiresAdmission: true,
            }),
        );

        const result = await joinMeeting("tok1");

        expect("requiresAdmission" in result).toBe(true);
        expect(result.meeting.waitingRoomEnabled).toBe(true);
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

describe("verifyMeetingPassword", () => {
    it("POSTs the verify endpoint with the token URL-encoded and the password in the body", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/join/abc%2Fdef/verify");
            expect(init?.method).toBe("POST");
            expect(JSON.parse(init?.body as string)).toEqual({ password: "s3cret" });
            return jsonResponse(200, {
                meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled" },
                iceServers: [{ urls: "stun:stun.example.com:19302" }],
                authenticated: false,
                selfUid: "guest:1",
                token: "guest-jwt",
                expiresAt: "2026-01-01T00:00:00.000Z",
            });
        });

        const result = await verifyMeetingPassword("abc/def", "s3cret");

        expect(result.selfUid).toBe("guest:1");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (wrong password)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Incorrect password." }));
        await expect(verifyMeetingPassword("tok1", "wrong")).rejects.toMatchObject({ status: 403 });
    });
});

describe("setMeetingPassword", () => {
    it("PUTs the meeting's own endpoint with the new password", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/m1");
            expect(init?.method).toBe("PUT");
            expect(JSON.parse(init?.body as string)).toEqual({ password: "s3cret" });
            return jsonResponse(200, { uid: "m1" });
        });

        await setMeetingPassword("m1", "s3cret");

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends null to remove the password", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(JSON.parse(init?.body as string)).toEqual({ password: null });
            return jsonResponse(200, { uid: "m1" });
        });

        await setMeetingPassword("m1", null);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (not the host)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Permission denied." }));
        await expect(setMeetingPassword("m1", "s3cret")).rejects.toMatchObject({ status: 403 });
    });
});

describe("requestAdmission", () => {
    it("POSTs the verify endpoint with the token URL-encoded and the body as given", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/join/abc%2Fdef/verify");
            expect(init?.method).toBe("POST");
            expect(JSON.parse(init?.body as string)).toEqual({ name: "Grace", password: "s3cret" });
            return jsonResponse(200, {
                meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled" },
                requiresAdmission: true,
                authenticated: false,
                selfUid: "guest:1",
                token: "guest-jwt",
                expiresAt: "2026-01-01T00:00:00.000Z",
            });
        });

        const result = await requestAdmission("abc/def", { name: "Grace", password: "s3cret" });

        expect(result.requiresAdmission).toBe(true);
        expect(result.selfUid).toBe("guest:1");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (wrong password)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Incorrect password." }));
        await expect(requestAdmission("tok1", { name: "Grace", password: "wrong" })).rejects.toMatchObject({ status: 403 });
    });

    it("rejects with an ApiRequestError on a 400 (no name)", async () => {
        mockFetch(() => jsonResponse(400, { message: "'name' is required to request admission." }));
        await expect(requestAdmission("tok1", { name: "" })).rejects.toMatchObject({ status: 400 });
    });
});

describe("pollAdmission", () => {
    it("GETs the status endpoint, with no Authorization header for an already-authenticated real caller", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/join/abc%2Fdef/status");
            expect(new Headers(init?.headers).has("Authorization")).toBe(false);
            return jsonResponse(200, {
                meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled" },
                requiresAdmission: true,
                authenticated: true,
                selfUid: "real-user-1",
            });
        });

        const result = await pollAdmission("abc/def");

        expect("requiresAdmission" in result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends a guest token as the Authorization header when given one", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(new Headers(init?.headers).get("Authorization")).toBe("jwt guest-jwt");
            return jsonResponse(200, {
                meeting: { uid: "m1", title: "Standup", visibility: "public", status: "scheduled" },
                iceServers: [{ urls: "stun:stun.example.com:19302" }],
                authenticated: false,
                selfUid: "guest:1",
            });
        });

        const result = await pollAdmission("tok1", "guest-jwt");

        expect("requiresAdmission" in result).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (denied)", async () => {
        mockFetch(() => jsonResponse(403, { message: "The host denied your request to join." }));
        await expect(pollAdmission("tok1", "guest-jwt")).rejects.toMatchObject({ status: 403 });
    });

    it("rejects with an ApiRequestError on a 404 (never requested)", async () => {
        mockFetch(() => jsonResponse(404, { message: "Not Found." }));
        await expect(pollAdmission("tok1")).rejects.toMatchObject({ status: 404 });
    });
});

describe("listWaitingParticipants", () => {
    it("GETs the meeting's own waiting endpoint", async () => {
        const fetchMock = mockFetch((url) => {
            expect(url).toBe("/api/mail/video-meetings/m1/waiting");
            return jsonResponse(200, [{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        });

        const result = await listWaitingParticipants("m1");

        expect(result).toEqual([{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (not the host)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Permission denied." }));
        await expect(listWaitingParticipants("m1")).rejects.toMatchObject({ status: 403 });
    });
});

describe("admitParticipant", () => {
    it("POSTs the meeting's own admit endpoint with the uid URL-encoded", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/m1/admit/guest%3Aabc");
            expect(init?.method).toBe("POST");
            return jsonResponse(204, undefined);
        });

        await admitParticipant("m1", "guest:abc");

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (not the host)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Permission denied." }));
        await expect(admitParticipant("m1", "guest:abc")).rejects.toMatchObject({ status: 403 });
    });
});

describe("denyParticipant", () => {
    it("POSTs the meeting's own deny endpoint with the uid URL-encoded", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/m1/deny/guest%3Aabc");
            expect(init?.method).toBe("POST");
            return jsonResponse(204, undefined);
        });

        await denyParticipant("m1", "guest:abc");

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (not the host)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Permission denied." }));
        await expect(denyParticipant("m1", "guest:abc")).rejects.toMatchObject({ status: 403 });
    });
});

describe("setWaitingRoomEnabled", () => {
    it("PUTs the meeting's own endpoint with the new setting", async () => {
        const fetchMock = mockFetch((url, init) => {
            expect(url).toBe("/api/mail/video-meetings/m1");
            expect(init?.method).toBe("PUT");
            expect(JSON.parse(init?.body as string)).toEqual({ waitingRoomEnabled: true });
            return jsonResponse(200, { uid: "m1", waitingRoomEnabled: true });
        });

        await setWaitingRoomEnabled("m1", true);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with an ApiRequestError on a 403 (not the host)", async () => {
        mockFetch(() => jsonResponse(403, { message: "Permission denied." }));
        await expect(setWaitingRoomEnabled("m1", false)).rejects.toMatchObject({ status: 403 });
    });
});
