// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
    fakeDeviceInfo,
    fakeMediaDevices,
    fakeMediaStream,
    fakeTrack,
    installFakeMediaStream,
    installMediaDevices,
    removeMediaDevices,
} from "../../testUtils.js";
import type { FilterStatus } from "../../../../apps/shared/media/filters/VideoFilterProcessor.js";
import type { VideoFilters } from "../../../../apps/shared/media/filters/filterTypes.js";
import { BACKGROUND_KEY, PREFERENCES_KEY } from "../../../../apps/shared/media/mediaPreferences.js";

const { meters } = vi.hoisted(() => ({ meters: [] as { onLevel: (level: number) => void; stop: ReturnType<typeof vi.fn> }[] }));
vi.mock("../../../../apps/shared/media/levelMeter.js", () => ({
    startLevelMeter: (_stream: MediaStream, onLevel: (level: number) => void) => {
        const meter = { onLevel, stop: vi.fn() };
        meters.push(meter);
        return meter;
    },
}));

/** What the fake `VideoFilterProcessor` records: the options it was built with, and the calls made on it. */
interface FakeProcessor {
    options: {
        source: MediaStreamTrack;
        filters: VideoFilters;
        backgroundImage: unknown;
        assetsUrl?: string;
        onStatus: (status: FilterStatus) => void;
    };
    track: MediaStreamTrack;
    update: Mock;
    stop: Mock;
}

const { fake, bg } = vi.hoisted(() => ({
    fake: {
        instances: [] as FakeProcessor[],
        throwOnCreate: false,
        makeTrack: (() => undefined) as unknown as () => MediaStreamTrack,
    },
    bg: { loadPicture: vi.fn(), prepareBackgroundImage: vi.fn() },
}));

vi.mock("../../../../apps/shared/media/filters/VideoFilterProcessor.js", () => ({
    VideoFilterProcessor: class {
        options: FakeProcessor["options"];
        track: MediaStreamTrack;
        update = vi.fn();
        stop = vi.fn();
        constructor(options: FakeProcessor["options"]) {
            if (fake.throwOnCreate) {
                throw new Error("no canvas");
            }
            this.options = options;
            this.track = fake.makeTrack();
            fake.instances.push(this);
        }
    },
}));

vi.mock("../../../../apps/shared/media/filters/backgroundImage.js", () => ({
    loadPicture: bg.loadPicture,
    prepareBackgroundImage: bg.prepareBackgroundImage,
}));

import { useLocalMedia } from "../../../../apps/shared/media/useLocalMedia.js";

fake.makeTrack = () => fakeTrack("video", `filtered-${fake.instances.length}`);

const PICTURE = { source: {} as CanvasImageSource, width: 10, height: 10 };
const BACKGROUND_URL = "data:image/jpeg;base64,AAAA";
const BLUR: VideoFilters = { background: "blur", effect: "none", accessory: "none" };

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
    fake.instances.length = 0;
    fake.throwOnCreate = false;
    bg.loadPicture.mockReset().mockResolvedValue(PICTURE);
    bg.prepareBackgroundImage.mockReset();
    installFakeMediaStream();
});

afterEach(() => {
    removeMediaDevices();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Puts what a previous visit would have left in this browser's storage. */
function seed(prefs: Record<string, unknown>, backgroundImage?: string) {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(prefs));
    if (backgroundImage) {
        localStorage.setItem(BACKGROUND_KEY, backgroundImage);
    }
}

/** What is saved right now. */
function saved(): Record<string, unknown> {
    return JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "{}");
}

/** The hook with working fake devices, before any access is requested. */
function setup(options?: { effectsAssetsUrl?: string; forceMuteOnJoin?: boolean }) {
    const requests: MediaStreamConstraints[] = [];
    installMediaDevices(fakeMediaDevices({ devices: DEVICES, userMediaStream: streamsFor(requests) }));
    const hook = renderHook(() => useLocalMedia(options));
    return { ...hook, requests };
}

async function setupLive(options?: { effectsAssetsUrl?: string; forceMuteOnJoin?: boolean }) {
    const hook = setup(options);
    await act(() => hook.result.current.requestAccess());
    return hook;
}

const constraint = (value: MediaStreamConstraints["audio"]) => value as MediaTrackConstraints;

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
        expect(result.current.error).toEqual({ kind: "not-found", message: "No camera was found on this device." });
    });

    it("names the microphone specifically when it's the camera that's found, not the other way around", async () => {
        // Regression: the microphone's own failure must not be silently cleared by the camera's later success -
        // the two fallback requests used to share one `error`, and whichever ran second (the camera) always won.
        installMediaDevices(
            fakeMediaDevices({ userMediaStream: streamsFor([], { fail: (c) => (c.audio ? domError("NotFoundError") : undefined) }) }),
        );
        const { result } = renderHook(() => useLocalMedia());
        await act(() => result.current.requestAccess());
        expect(result.current.status).toEqual({ audio: "unavailable", video: "live" });
        expect(result.current.error).toEqual({ kind: "not-found", message: "No microphone was found on this device." });
    });

    it("names both when neither the camera nor the microphone can be found", async () => {
        installMediaDevices(fakeMediaDevices({ userMediaError: domError("NotFoundError") }));
        const { result } = renderHook(() => useLocalMedia());
        await act(() => result.current.requestAccess());
        expect(result.current.status).toEqual({ audio: "unavailable", video: "unavailable" });
        expect(result.current.error).toEqual({ kind: "not-found", message: "No camera or microphone was found on this device." });
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

describe("useLocalMedia - remembered devices", () => {
    it("asks for the saved camera and microphone as a preference, in the one request", async () => {
        seed({ cameraId: "cam-9", microphoneId: "mic-9" });
        const { result, requests } = setup();
        await act(() => result.current.requestAccess());

        expect(requests).toHaveLength(1);
        expect(constraint(requests[0].audio)).toMatchObject({ echoCancellation: true, deviceId: { ideal: "mic-9" } });
        expect(constraint(requests[0].video)).toMatchObject({ facingMode: "user", deviceId: { ideal: "cam-9" } });
    });

    it("asks for only what was saved, leaving the other kind to the default", async () => {
        seed({ cameraId: "cam-9" });
        const { result, requests } = setup();
        await act(() => result.current.requestAccess());
        expect(constraint(requests[0].audio).deviceId).toBeUndefined();
        expect(constraint(requests[0].video).deviceId).toEqual({ ideal: "cam-9" });
    });

    it("uses the saved device for a request of one kind, and for each on its own after a fallback", async () => {
        seed({ cameraId: "cam-9", microphoneId: "mic-9" });
        const { result, requests } = setup();
        await act(() => result.current.requestAccess("video"));
        await act(() => result.current.requestAccess("audio"));
        expect(constraint(requests[0].video).deviceId).toEqual({ ideal: "cam-9" });
        expect(constraint(requests[1].audio).deviceId).toEqual({ ideal: "mic-9" });

        const failing: MediaStreamConstraints[] = [];
        installMediaDevices(
            fakeMediaDevices({
                userMediaStream: streamsFor(failing, { fail: (c) => (c.audio && c.video ? domError("OverconstrainedError") : undefined) }),
            }),
        );
        const fallback = renderHook(() => useLocalMedia());
        await act(() => fallback.result.current.requestAccess());
        expect(failing).toHaveLength(3);
        expect(constraint(failing[1].audio).deviceId).toEqual({ ideal: "mic-9" });
        expect(constraint(failing[2].video).deviceId).toEqual({ ideal: "cam-9" });
        expect(fallback.result.current.status).toEqual({ audio: "live", video: "live" });
    });

    it("still demands the device the participant picks, and remembers it once it works", async () => {
        seed({ cameraId: "cam-old", microphoneId: "mic-old" });
        const { result, requests } = await setupLive();
        requests.length = 0;

        await act(() => result.current.selectDevice("video", "cam-2"));
        await act(() => result.current.selectDevice("audio", "mic-2"));

        expect(constraint(requests[0].video).deviceId).toEqual({ exact: "cam-2" });
        expect(constraint(requests[1].audio).deviceId).toEqual({ exact: "mic-2" });
        expect(saved()).toMatchObject({ cameraId: "cam-2", microphoneId: "mic-2" });
    });

    it("remembers nothing about a device that could not be opened", async () => {
        const { result } = await setupLive();
        installMediaDevices(fakeMediaDevices({ userMediaError: domError("NotFoundError") }));

        await act(() => result.current.selectDevice("video", "cam-2"));
        await act(() => result.current.selectDevice("audio", "mic-2"));

        expect(saved().cameraId).toBeUndefined();
        expect(saved().microphoneId).toBeUndefined();
    });
});

describe("useLocalMedia - remembered on and off", () => {
    it("joins muted when the microphone was off last time", async () => {
        seed({ micEnabled: false });
        const { result } = await setupLive();
        expect(result.current.micEnabled).toBe(false);
        expect(result.current.micOn).toBe(false);
        expect(result.current.audioTrack!.enabled).toBe(false);
        expect(result.current.cameraOn).toBe(true);
    });

    it("starts with the microphone on when it was on last time", async () => {
        seed({ micEnabled: true });
        const { result } = await setupLive();
        expect(result.current.micOn).toBe(true);
        expect(result.current.audioTrack!.enabled).toBe(true);
    });

    it("joins with the camera off, asking for the microphone alone, when the camera was off last time", async () => {
        seed({ cameraEnabled: false, microphoneId: "mic-9" });
        const { result, requests } = setup();
        await act(() => result.current.requestAccess());

        expect(requests).toHaveLength(1);
        expect(requests[0].video).toBeUndefined();
        expect(constraint(requests[0].audio).deviceId).toEqual({ ideal: "mic-9" });
        expect(result.current.status).toEqual({ audio: "live", video: "off" });
        expect(result.current.videoTrack).toBeNull();
        expect(result.current.cameraOn).toBe(false);
        expect(result.current.requesting).toBe(false);
        expect(saved().cameraEnabled).toBe(false);

        await act(() => result.current.toggleCamera());
        expect(result.current.cameraOn).toBe(true);
        expect(result.current.status.video).toBe("live");
        expect(saved().cameraEnabled).toBe(true);
    });

    it("leaves the camera-off join alone when its owner is already gone", async () => {
        seed({ cameraEnabled: false });
        const { result, unmount, requests } = setup();
        unmount();
        await act(() => result.current.requestAccess());
        expect(requests).toHaveLength(1);
        expect(result.current.status.video).toBe("pending");
    });

    it("remembers each change of the microphone, including asking for one when unmuting with none", async () => {
        const { result } = await setupLive();
        await act(() => result.current.toggleMic());
        expect(saved().micEnabled).toBe(false);
        await act(() => result.current.toggleMic());
        expect(saved().micEnabled).toBe(true);

        const none = setup();
        await act(() => none.result.current.toggleMic());
        expect(saved().micEnabled).toBe(true);
    });

    it("remembers the camera being turned off, and on again", async () => {
        const { result } = await setupLive();
        expect(saved().cameraEnabled).toBe(true);
        await act(() => result.current.toggleCamera());
        expect(saved().cameraEnabled).toBe(false);
        await act(() => result.current.toggleCamera());
        expect(saved().cameraEnabled).toBe(true);
    });

    it("remembers the camera as on once a request for it alone succeeds", async () => {
        seed({ cameraEnabled: false });
        const { result } = setup();
        await act(() => result.current.requestAccess("video"));
        expect(result.current.cameraOn).toBe(true);
        expect(saved().cameraEnabled).toBe(true);
    });

    it("keeps what was saved when the tracks are released", async () => {
        const { result } = await setupLive();
        await act(() => result.current.toggleMic());
        act(() => result.current.release());
        expect(saved()).toMatchObject({ micEnabled: false, cameraEnabled: true });
    });

    it("joins muted when forceMuteOnJoin is set, even though the microphone was remembered as on", async () => {
        seed({ micEnabled: true });
        const { result } = await setupLive({ forceMuteOnJoin: true });
        expect(result.current.micOn).toBe(false);
        expect(result.current.audioTrack!.enabled).toBe(false);
    });

    it("does not overwrite the remembered 'on' preference just because forceMuteOnJoin forced this call muted", async () => {
        seed({ micEnabled: true });
        const { result } = await setupLive({ forceMuteOnJoin: true });
        expect(result.current.micOn).toBe(false);
        expect(saved().micEnabled).toBe(true);
    });

    it("changes nothing when forceMuteOnJoin is false", async () => {
        const { result } = await setupLive({ forceMuteOnJoin: false });
        expect(result.current.micOn).toBe(true);
    });
});

describe("useLocalMedia - remembered filters and background", () => {
    it("applies the saved filters on the first request for access, and starts filtering", async () => {
        seed({ filters: BLUR });
        const { result } = setup();
        expect(result.current.filters).toEqual({ background: "none", effect: "none", accessory: "none" });

        await act(() => result.current.requestAccess());

        expect(result.current.filters).toEqual(BLUR);
        expect(fake.instances).toHaveLength(1);
        expect(fake.instances[0].options.filters).toEqual(BLUR);
    });

    it("loads the saved background picture, and hands it to the filters", async () => {
        seed({ filters: { ...BLUR, background: "image" } }, BACKGROUND_URL);
        const { result } = setup();
        expect(result.current.hasBackgroundImage).toBe(false);

        await act(() => result.current.requestAccess());
        await waitFor(() => expect(result.current.hasBackgroundImage).toBe(true));

        expect(bg.loadPicture).toHaveBeenCalledWith(BACKGROUND_URL);
        expect(fake.instances[0].update).toHaveBeenLastCalledWith({ ...BLUR, background: "image" }, PICTURE);
    });

    it("ignores a saved background picture that can't be read", async () => {
        bg.loadPicture.mockRejectedValue(new Error("bad image"));
        seed({}, BACKGROUND_URL);
        const { result } = setup();
        await act(() => result.current.requestAccess());
        await act(async () => {
            await Promise.resolve();
        });
        expect(bg.loadPicture).toHaveBeenCalledTimes(1);
        expect(result.current.hasBackgroundImage).toBe(false);
    });

    it("ignores a saved background picture that finishes loading after its owner has gone", async () => {
        let finish!: (picture: typeof PICTURE) => void;
        bg.loadPicture.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        seed({ filters: { ...BLUR, background: "image" } }, BACKGROUND_URL);
        const { result, unmount } = setup();
        await act(() => result.current.requestAccess());
        const processor = fake.instances[0];
        const updates = processor.update.mock.calls.length;
        unmount();

        finish(PICTURE);
        await Promise.resolve();
        await Promise.resolve();

        expect(result.current.hasBackgroundImage).toBe(false);
        expect(processor.update).toHaveBeenCalledTimes(updates);
    });

    it("merges each change of filters into the rest, and remembers them", async () => {
        const { result } = await setupLive();
        act(() => result.current.setFilters({ effect: "sepia" }));
        act(() => result.current.setFilters({ accessory: "crown" }));
        expect(result.current.filters).toEqual({ background: "none", effect: "sepia", accessory: "crown" });
        expect(saved().filters).toEqual({ background: "none", effect: "sepia", accessory: "crown" });
    });
});

describe("useLocalMedia - when storage is not available", () => {
    async function exercise() {
        const { result, requests } = setup();
        await act(() => result.current.requestAccess());
        expect(result.current.status).toEqual({ audio: "live", video: "live" });
        await act(() => result.current.toggleMic());
        expect(result.current.micOn).toBe(false);
        act(() => result.current.setFilters({ effect: "bw" }));
        expect(result.current.filters.effect).toBe("bw");
        await act(() => result.current.selectDevice("video", "cam-2"));
        expect(constraint(requests[requests.length - 1].video).deviceId).toEqual({ exact: "cam-2" });
        expect(result.current.cameraOn).toBe(true);
    }

    it("carries on when there is no storage at all", async () => {
        vi.stubGlobal("localStorage", undefined);
        await exercise();
    });

    it("carries on when storage refuses every read and write", async () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("quota");
        });
        await exercise();
    });
});

describe("useLocalMedia - video filters", () => {
    it("sends the filtered picture in place of the camera's while a filter is on", async () => {
        const { result } = await setupLive({ effectsAssetsUrl: "https://cdn.example.com/models" });
        const camera = result.current.videoTrack!;
        expect(fake.instances).toHaveLength(0);

        act(() => result.current.setFilters({ background: "blur" }));

        expect(fake.instances).toHaveLength(1);
        const processor = fake.instances[0];
        expect(processor.options.source).toBe(camera);
        expect(processor.options.filters).toEqual(BLUR);
        expect(processor.options.backgroundImage).toBeNull();
        expect(processor.options.assetsUrl).toBe("https://cdn.example.com/models");
        expect(result.current.videoTrack).toBe(processor.track);
        expect(result.current.videoStream?.getVideoTracks()).toEqual([processor.track]);
        // The camera itself is unaffected: still running, still the one that is "on" and selected.
        expect(camera.stop).not.toHaveBeenCalled();
        expect(result.current.cameraOn).toBe(true);
        expect(result.current.selectedDeviceIds.video).toBe(camera.getSettings().deviceId);
        expect(result.current.status.video).toBe("live");
    });

    it("has no picture yet while filters are on but there is no camera to filter", async () => {
        const { result } = setup();
        act(() => result.current.setFilters({ effect: "bw" }));
        expect(fake.instances).toHaveLength(0);
        expect(result.current.videoTrack).toBeNull();
        expect(result.current.videoStream).toBeNull();

        await act(() => result.current.requestAccess());
        expect(fake.instances).toHaveLength(1);
        expect(result.current.videoTrack).toBe(fake.instances[0].track);
    });

    it("sends no video at all, rather than an unfiltered one, when the filtered picture can't be made", async () => {
        const { result } = await setupLive();
        const camera = result.current.videoTrack!;
        fake.throwOnCreate = true;

        act(() => result.current.setFilters({ background: "blur" }));

        expect(fake.instances).toHaveLength(0);
        expect(result.current.videoTrack).toBeNull();
        expect(result.current.videoStream).toBeNull();
        expect(result.current.filterStatus.error).toMatch(/aren't supported/);
        expect(result.current.filterStatus.loading).toBe(false);
        expect(result.current.cameraOn).toBe(true);
        expect(camera.stop).not.toHaveBeenCalled();

        act(() => result.current.setFilters({ background: "none" }));
        expect(result.current.videoTrack).toBe(camera);
        // The "not supported" message goes away with the filters that caused it.
        expect(result.current.filterStatus).toEqual({ loading: false, error: null });
    });

    it("goes back to the camera's own track, and stops the processor, when the filters are turned off", async () => {
        const { result } = await setupLive();
        const camera = result.current.videoTrack!;
        act(() => result.current.setFilters({ background: "blur", effect: "sepia" }));
        const processor = fake.instances[0];
        act(() => processor.options.onStatus({ loading: true, error: "half working" }));
        expect(result.current.filterStatus).toEqual({ loading: true, error: "half working" });

        act(() => result.current.setFilters({ background: "none" }));
        // Still filtered - sepia is left on.
        expect(processor.stop).not.toHaveBeenCalled();
        expect(result.current.videoTrack).toBe(processor.track);

        act(() => result.current.setFilters({ effect: "none" }));
        expect(processor.stop).toHaveBeenCalledTimes(1);
        expect(result.current.videoTrack).toBe(camera);
        expect(result.current.videoStream?.getVideoTracks()).toEqual([camera]);
        expect(result.current.filterStatus).toEqual({ loading: false, error: null });
        expect(camera.stop).not.toHaveBeenCalled();
    });

    it("passes a change of filters on to the running processor without making another", async () => {
        const { result } = await setupLive();
        act(() => result.current.setFilters({ background: "blur" }));
        const processor = fake.instances[0];

        act(() => result.current.setFilters({ effect: "bw" }));

        expect(fake.instances).toHaveLength(1);
        expect(processor.update).toHaveBeenLastCalledWith({ background: "blur", effect: "bw", accessory: "none" }, null);
    });

    it("reports the processor's status", async () => {
        const { result } = await setupLive();
        act(() => result.current.setFilters({ accessory: "crown" }));
        act(() => fake.instances[0].options.onStatus({ loading: true, error: null }));
        expect(result.current.filterStatus).toEqual({ loading: true, error: null });
    });

    it("filters the new camera, and lets go of the old one's processor, when the camera is switched", async () => {
        const { result } = await setupLive();
        act(() => result.current.setFilters({ effect: "sepia" }));
        const first = fake.instances[0];
        const oldCamera = first.options.source;

        await act(() => result.current.selectDevice("video", "cam-2"));

        expect(first.stop).toHaveBeenCalledTimes(1);
        expect(oldCamera.stop).toHaveBeenCalled();
        expect(fake.instances).toHaveLength(2);
        const second = fake.instances[1];
        expect(second.options.source).not.toBe(oldCamera);
        expect(second.options.source.kind).toBe("video");
        expect(result.current.videoTrack).toBe(second.track);
        expect(second.stop).not.toHaveBeenCalled();
    });

    it("stops the processor when the camera is turned off, and starts another when it is back on", async () => {
        const { result } = await setupLive();
        act(() => result.current.setFilters({ effect: "sepia" }));
        await act(() => result.current.toggleCamera());
        expect(fake.instances[0].stop).toHaveBeenCalled();
        expect(result.current.videoTrack).toBeNull();

        await act(() => result.current.toggleCamera());
        expect(fake.instances).toHaveLength(2);
        expect(result.current.videoTrack).toBe(fake.instances[1].track);
    });

    it("stops the processor on release()", async () => {
        const { result } = await setupLive();
        act(() => result.current.setFilters({ effect: "sepia" }));
        act(() => result.current.release());
        expect(fake.instances[0].stop).toHaveBeenCalled();
        expect(result.current.videoTrack).toBeNull();
    });

    it("stops the processor when its owner unmounts", async () => {
        const { result, unmount } = await setupLive();
        act(() => result.current.setFilters({ effect: "sepia" }));
        unmount();
        expect(fake.instances[0].stop).toHaveBeenCalled();
    });

    it("builds a processor with the saved background picture once it has loaded", async () => {
        seed({ filters: { ...BLUR, background: "image" } }, BACKGROUND_URL);
        const { result } = await setupLive();
        await waitFor(() => expect(result.current.hasBackgroundImage).toBe(true));

        await act(() => result.current.selectDevice("video", "cam-2"));
        expect(fake.instances[fake.instances.length - 1].options.backgroundImage).toBe(PICTURE);
    });
});

describe("useLocalMedia - choosing a background image", () => {
    const file = () => new File(["x"], "room.png", { type: "image/png" });

    it("uses the picture, remembers it, and switches to the image background", async () => {
        bg.prepareBackgroundImage.mockResolvedValue({ ok: true, dataUrl: BACKGROUND_URL, picture: PICTURE });
        const { result } = await setupLive();
        expect(result.current.hasBackgroundImage).toBe(false);

        let outcome: string | null = "unset";
        await act(async () => {
            outcome = await result.current.chooseBackgroundImage(file());
        });

        expect(outcome).toBeNull();
        expect(result.current.hasBackgroundImage).toBe(true);
        expect(result.current.filters.background).toBe("image");
        expect(localStorage.getItem(BACKGROUND_KEY)).toBe(BACKGROUND_URL);
        expect(saved().filters).toMatchObject({ background: "image" });
        // The filters start with the picture already in hand.
        expect(fake.instances).toHaveLength(1);
        expect(fake.instances[0].options.backgroundImage).toBe(PICTURE);
    });

    it("says why a file can't be used, and changes nothing", async () => {
        bg.prepareBackgroundImage.mockResolvedValue({ ok: false, message: "Not an image." });
        const { result } = await setupLive();

        let outcome: string | null = null;
        await act(async () => {
            outcome = await result.current.chooseBackgroundImage(file());
        });

        expect(outcome).toBe("Not an image.");
        expect(result.current.hasBackgroundImage).toBe(false);
        expect(result.current.filters.background).toBe("none");
        expect(localStorage.getItem(BACKGROUND_KEY)).toBeNull();
        expect(fake.instances).toHaveLength(0);
    });

    it("does nothing with a picture that is ready after its owner has gone", async () => {
        let finish!: (result: unknown) => void;
        bg.prepareBackgroundImage.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const { result, unmount } = await setupLive();

        let pending!: Promise<string | null>;
        act(() => {
            pending = result.current.chooseBackgroundImage(file());
        });
        unmount();
        finish({ ok: true, dataUrl: BACKGROUND_URL, picture: PICTURE });

        await expect(pending).resolves.toBeNull();
        expect(localStorage.getItem(BACKGROUND_KEY)).toBeNull();
        expect(fake.instances).toHaveLength(0);
    });
});
