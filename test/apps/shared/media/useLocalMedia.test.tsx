// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    fakeDeviceInfo,
    fakeMediaDevices,
    fakeMediaStream,
    fakeTrack,
    installFakeMediaStream,
    installMediaDevices,
    removeMediaDevices,
} from "../../testUtils.js";

const { meters } = vi.hoisted(() => ({ meters: [] as { onLevel: (level: number) => void; stop: ReturnType<typeof vi.fn> }[] }));
vi.mock("../../../../apps/shared/media/levelMeter.js", () => ({
    startLevelMeter: (_stream: MediaStream, onLevel: (level: number) => void) => {
        const meter = { onLevel, stop: vi.fn() };
        meters.push(meter);
        return meter;
    },
}));

import { useLocalMedia } from "../../../../apps/shared/media/useLocalMedia.js";

const DEVICES = [
    fakeDeviceInfo("videoinput", "cam-1", "Front camera"),
    fakeDeviceInfo("videoinput", "cam-2", "Back camera"),
    fakeDeviceInfo("audioinput", "mic-1", "Built-in mic"),
];

function domError(name: string): Error {
    const err = new Error(name);
    err.name = name;
    return err;
}

/** A `getUserMedia()` that hands out fresh tracks for whichever kinds are asked for, recording each request. */
function streamsFor(requests: MediaStreamConstraints[], overrides: { fail?: (constraints: MediaStreamConstraints) => Error | undefined } = {}) {
    return (constraints: MediaStreamConstraints) => {
        requests.push(constraints);
        const error = overrides.fail?.(constraints);
        if (error) {
            throw error;
        }
        const tracks = [];
        if (constraints.audio) tracks.push(fakeTrack("audio"));
        if (constraints.video) tracks.push(fakeTrack("video"));
        return fakeMediaStream(tracks);
    };
}

beforeEach(() => {
    meters.length = 0;
    installFakeMediaStream();
});

afterEach(() => {
    removeMediaDevices();
    vi.unstubAllGlobals();
});

describe("useLocalMedia - requesting access", () => {
    it("asks for the camera and microphone in one request, and reports both live", async () => {
        const requests: MediaStreamConstraints[] = [];
        installMediaDevices(fakeMediaDevices({ devices: DEVICES, userMediaStream: streamsFor(requests) }));
        const { result } = renderHook(() => useLocalMedia());
        expect(result.current.status).toEqual({ audio: "pending", video: "pending" });

        await act(() => result.current.requestAccess());

        expect(requests).toHaveLength(1);
        expect(requests[0].audio).toBeTruthy();
        expect(requests[0].video).toBeTruthy();
        expect(result.current.audioTrack?.kind).toBe("audio");
        expect(result.current.videoTrack?.kind).toBe("video");
        expect(result.current.status).toEqual({ audio: "live", video: "live" });
        expect(result.current.micOn).toBe(true);
        expect(result.current.cameraOn).toBe(true);
        expect(result.current.videoStream?.getVideoTracks()).toEqual([result.current.videoTrack]);
        expect(result.current.devices.cameras.map((d) => d.deviceId)).toEqual(["cam-1", "cam-2"]);
        expect(result.current.devices.microphones.map((d) => d.deviceId)).toEqual(["mic-1"]);
        expect(result.current.selectedDeviceIds.audio).toMatch(/-device$/);
        expect(result.current.requesting).toBe(false);
        expect(result.current.error).toBeNull();
    });

    it("says so when the browser has no getUserMedia at all", async () => {
        installMediaDevices(undefined);
        const { result } = renderHook(() => useLocalMedia());
        await act(() => result.current.requestAccess());
        expect(result.current.supported).toBe(false);
        expect(result.current.requesting).toBe(false);
    });

    it("reports a denial for both, and recovers when asked again", async () => {
        const requests: MediaStreamConstraints[] = [];
        let deny = true;
        installMediaDevices(
            fakeMediaDevices({ userMediaStream: streamsFor(requests, { fail: () => (deny ? domError("NotAllowedError") : undefined) }) }),
        );
        const { result } = renderHook(() => useLocalMedia());

        await act(() => result.current.requestAccess());
        expect(result.current.status).toEqual({ audio: "denied", video: "denied" });
        expect(result.current.error?.kind).toBe("permission-denied");
        // A denial is not retried per device - one prompt, one refusal.
        expect(requests).toHaveLength(1);

        deny = false;
        await act(() => result.current.requestAccess());
        expect(result.current.status).toEqual({ audio: "live", video: "live" });
        expect(result.current.error).toBeNull();
    });

    it("falls back to asking for each on its own, so a missing camera doesn't cost the microphone", async () => {
        const requests: MediaStreamConstraints[] = [];
        installMediaDevices(
            fakeMediaDevices({
                userMediaStream: streamsFor(requests, { fail: (c) => (c.video ? domError("NotFoundError") : undefined) }),
            }),
        );
        const { result } = renderHook(() => useLocalMedia());

        await act(() => result.current.requestAccess());

        expect(requests).toHaveLength(3);
        expect(result.current.status).toEqual({ audio: "live", video: "unavailable" });
        expect(result.current.micOn).toBe(true);
        expect(result.current.cameraOn).toBe(false);
        expect(result.current.error?.kind).toBe("not-found");
    });

    it("maps any other failure to an error status", async () => {
        installMediaDevices(fakeMediaDevices({ userMediaError: domError("AbortError") }));
        const { result } = renderHook(() => useLocalMedia());
        await act(() => result.current.requestAccess());
        expect(result.current.status).toEqual({ audio: "error", video: "error" });
        expect(result.current.error?.kind).toBe("unknown");
    });

    it("reports a refusal of just one device as denied for that device alone", async () => {
        installMediaDevices(fakeMediaDevices({ userMediaError: domError("NotAllowedError") }));
        const { result } = renderHook(() => useLocalMedia());
        await act(() => result.current.requestAccess("video"));
        expect(result.current.status).toEqual({ audio: "pending", video: "denied" });
        expect(result.current.error?.kind).toBe("permission-denied");
    });

    it("asks for just one kind when told to", async () => {
        const requests: MediaStreamConstraints[] = [];
        installMediaDevices(fakeMediaDevices({ userMediaStream: streamsFor(requests) }));
        const { result } = renderHook(() => useLocalMedia());
        await act(() => result.current.requestAccess("video"));
        expect(requests).toHaveLength(1);
        expect(requests[0].audio).toBeUndefined();
        expect(result.current.status).toEqual({ audio: "pending", video: "live" });
    });
});

describe("useLocalMedia - microphone and camera", () => {
    async function live() {
        const requests: MediaStreamConstraints[] = [];
        installMediaDevices(fakeMediaDevices({ devices: DEVICES, userMediaStream: streamsFor(requests) }));
        const hook = renderHook(() => useLocalMedia());
        await act(() => hook.result.current.requestAccess());
        return { ...hook, requests };
    }

    it("mutes and unmutes by disabling the track it keeps", async () => {
        const { result } = await live();
        const track = result.current.audioTrack!;

        await act(() => result.current.toggleMic());
        expect(track.enabled).toBe(false);
        expect(result.current.micOn).toBe(false);
        expect(result.current.micEnabled).toBe(false);
        expect(result.current.audioTrack).toBe(track);

        await act(() => result.current.toggleMic());
        expect(track.enabled).toBe(true);
        expect(result.current.micOn).toBe(true);
    });

    it("asks for a microphone when unmuting with none", async () => {
        const requests: MediaStreamConstraints[] = [];
        installMediaDevices(fakeMediaDevices({ userMediaStream: streamsFor(requests) }));
        const { result } = renderHook(() => useLocalMedia());

        await act(() => result.current.toggleMic());
        expect(requests).toHaveLength(1);
        expect(result.current.audioTrack).not.toBeNull();
        expect(result.current.micOn).toBe(true);
    });

    it("turns the camera off by stopping its track, and on by asking for a new one", async () => {
        const { result } = await live();
        const first = result.current.videoTrack!;

        await act(() => result.current.toggleCamera());
        expect(first.stop).toHaveBeenCalled();
        expect(result.current.videoTrack).toBeNull();
        expect(result.current.videoStream).toBeNull();
        expect(result.current.cameraOn).toBe(false);
        expect(result.current.status.video).toBe("off");

        await act(() => result.current.toggleCamera());
        expect(result.current.videoTrack).not.toBe(first);
        expect(result.current.cameraOn).toBe(true);
        expect(result.current.status.video).toBe("live");
    });

    it("switches camera by stopping the old one first, then asking for the chosen device", async () => {
        const { result, requests } = await live();
        const old = result.current.videoTrack!;
        requests.length = 0;

        await act(() => result.current.selectDevice("video", "cam-2"));

        expect(old.stop).toHaveBeenCalled();
        expect(requests).toHaveLength(1);
        expect((requests[0].video as MediaTrackConstraints).deviceId).toEqual({ exact: "cam-2" });
        expect(result.current.videoTrack).not.toBe(old);
        expect(result.current.cameraOn).toBe(true);
    });

    it("switches camera when there was none running", async () => {
        const requests: MediaStreamConstraints[] = [];
        installMediaDevices(fakeMediaDevices({ userMediaStream: streamsFor(requests) }));
        const { result } = renderHook(() => useLocalMedia());
        await act(() => result.current.selectDevice("video", "cam-1"));
        expect(result.current.cameraOn).toBe(true);
    });

    it("switches microphone, keeping the mute the participant chose", async () => {
        const { result, requests } = await live();
        await act(() => result.current.toggleMic());
        const old = result.current.audioTrack!;
        requests.length = 0;

        await act(() => result.current.selectDevice("audio", "mic-2"));

        expect(old.stop).toHaveBeenCalled();
        expect((requests[0].audio as MediaTrackConstraints).deviceId).toEqual({ exact: "mic-2" });
        expect(result.current.audioTrack).not.toBe(old);
        expect(result.current.audioTrack!.enabled).toBe(false);
        expect(result.current.micOn).toBe(false);
    });

    it("drops a track whose device goes away, and ignores the end of one it has already replaced", async () => {
        const { result } = await live();
        const camera = result.current.videoTrack!;
        act(() => {
            camera.onended!(new Event("ended"));
        });
        expect(result.current.videoTrack).toBeNull();
        expect(result.current.status.video).toBe("unavailable");

        const mic = result.current.audioTrack!;
        const onended = mic.onended!;
        await act(() => result.current.selectDevice("audio", "mic-1"));
        expect(result.current.audioTrack).not.toBe(mic);
        // The replaced track's own late `ended` must not clear its replacement.
        act(() => {
            onended.call(mic, new Event("ended"));
        });
        expect(result.current.audioTrack).not.toBeNull();
        expect(result.current.status.audio).toBe("live");
    });

    it("stops everything on release() and starts over", async () => {
        const { result } = await live();
        const [audio, video] = [result.current.audioTrack!, result.current.videoTrack!];
        act(() => result.current.release());
        expect(audio.stop).toHaveBeenCalled();
        expect(video.stop).toHaveBeenCalled();
        expect(result.current.audioTrack).toBeNull();
        expect(result.current.videoTrack).toBeNull();
        expect(result.current.status).toEqual({ audio: "pending", video: "pending" });
        // Nothing left to stop the second time.
        expect(() => act(() => result.current.release())).not.toThrow();
    });

    it("stops everything when its owner unmounts", async () => {
        const { result, unmount } = await live();
        const [audio, video] = [result.current.audioTrack!, result.current.videoTrack!];
        unmount();
        expect(audio.stop).toHaveBeenCalled();
        expect(video.stop).toHaveBeenCalled();
    });
});

describe("useLocalMedia - devices", () => {
    it("refreshes the device lists when devices are plugged in or out, and stops listening on unmount", async () => {
        const devices = fakeMediaDevices({ devices: [fakeDeviceInfo("audioinput", "mic-1", "Mic")] });
        installMediaDevices(devices);
        const { result, unmount } = renderHook(() => useLocalMedia());
        expect(devices.addEventListener).toHaveBeenCalledWith("devicechange", expect.any(Function));

        devices.enumerateDevices!.mockResolvedValueOnce([fakeDeviceInfo("audioinput", "mic-1", "Mic"), fakeDeviceInfo("audioinput", "mic-2", "USB")]);
        act(() => devices.emit("devicechange"));
        await waitFor(() => expect(result.current.devices.microphones).toHaveLength(2));

        unmount();
        expect(devices.removeEventListener).toHaveBeenCalledWith("devicechange", expect.any(Function));
    });

    it("copes with a browser that can't announce device changes", () => {
        installMediaDevices({ getUserMedia: vi.fn() } as never);
        expect(() => renderHook(() => useLocalMedia())).not.toThrow();
    });

    it("keeps the previous lists when listing fails", async () => {
        installMediaDevices(fakeMediaDevices({ enumerateError: new Error("nope") }));
        const { result } = renderHook(() => useLocalMedia());
        await act(() => result.current.requestAccess());
        expect(result.current.devices).toEqual({ cameras: [], microphones: [] });
    });
});

describe("useLocalMedia - audio level", () => {
    it("follows the microphone while it is unmuted, in whole steps, and goes quiet when muted", async () => {
        installMediaDevices(fakeMediaDevices({ userMediaStream: streamsFor([]) }));
        const { result } = renderHook(() => useLocalMedia());
        expect(result.current.audioLevel).toBe(0);
        await act(() => result.current.requestAccess());
        expect(meters).toHaveLength(1);

        act(() => meters[0].onLevel(10));
        expect(result.current.audioLevel).toBe(3);
        act(() => meters[0].onLevel(10));
        expect(result.current.audioLevel).toBe(3);
        act(() => meters[0].onLevel(100));
        expect(result.current.audioLevel).toBe(5);

        await act(() => result.current.toggleMic());
        expect(meters[0].stop).toHaveBeenCalled();
        expect(result.current.audioLevel).toBe(0);
    });

    it("has nothing to measure without a microphone, or when no level meter can start", async () => {
        installMediaDevices(fakeMediaDevices({ userMediaStream: streamsFor([]) }));
        const { result } = renderHook(() => useLocalMedia());
        expect(meters).toHaveLength(0);
        await act(() => result.current.requestAccess("video"));
        expect(meters).toHaveLength(0);
        expect(result.current.audioLevel).toBe(0);
    });
});

describe("useLocalMedia - a request that outlives its owner", () => {
    it("stops the tracks it was too late to hand over, and doesn't touch state", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const tracks = [fakeTrack("audio"), fakeTrack("video")];
        const devices = fakeMediaDevices();
        devices.getUserMedia = vi.fn(async () => {
            await gate;
            return fakeMediaStream(tracks);
        });
        installMediaDevices(devices);
        const { result, unmount } = renderHook(() => useLocalMedia());

        let pending!: Promise<void>;
        act(() => {
            pending = result.current.requestAccess();
        });
        unmount();
        release();
        await act(() => pending);

        for (const track of tracks) {
            expect(track.stop).toHaveBeenCalled();
        }
    });

    it("stays quiet when a refusal, or a failed single request, arrives after unmount", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const denied = fakeMediaDevices();
        denied.getUserMedia = vi.fn(async () => {
            await gate;
            throw domError("NotAllowedError");
        });
        installMediaDevices(denied);
        const first = renderHook(() => useLocalMedia());
        let pending!: Promise<void>;
        act(() => {
            pending = first.result.current.requestAccess();
        });
        first.unmount();
        release();
        await act(() => pending);

        let releaseSingle!: () => void;
        const singleGate = new Promise<void>((resolve) => (releaseSingle = resolve));
        const failing = fakeMediaDevices();
        failing.getUserMedia = vi.fn(async () => {
            await singleGate;
            throw domError("NotFoundError");
        });
        installMediaDevices(failing);
        const second = renderHook(() => useLocalMedia());
        act(() => {
            pending = second.result.current.requestAccess("audio");
        });
        second.unmount();
        releaseSingle();
        await act(() => pending);
        expect(failing.getUserMedia).toHaveBeenCalledTimes(1);
    });
});
