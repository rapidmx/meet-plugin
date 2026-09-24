///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Shared test fakes for `apps/meet/**`, mirroring `booking-plugin`'s own `test/apps/testUtils.ts` conventions
 * (`jsonResponse`/`mockFetch`), extended with fakes for the browser APIs this plugin is the first in this codebase
 * to use at all - `navigator.mediaDevices`, `RTCPeerConnection` and the push `WebSocket` (see this plugin's Phase 2
 * `.claude/NOTES.md` entry: there was no existing mocking convention for any of these to follow). */
import { vi, type Mock } from "vitest";
import type { LocalMedia } from "../../apps/shared/media/useLocalMedia.js";

/** Builds a real `Response` with a JSON body and `content-type: application/json`. */
export function jsonResponse(status: number, body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        statusText: init.statusText ?? "",
        headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
    });
}

/** Stubs `global.fetch` with the given implementation and returns the underlying mock so call args can be
 * asserted on - identical convention to `booking-plugin`'s own `mockFetch()`. */
export function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): Mock {
    const fn = vi.fn(impl);
    vi.stubGlobal("fetch", fn);
    return fn;
}

/** A fake `MediaStreamTrack` - just enough for `deviceMedia.ts`/`MeshConnectionManager`/the UI to use. */
export function fakeTrack(kind: "audio" | "video", id = `${kind}-${Math.random()}`): MediaStreamTrack {
    const track = {
        kind,
        id,
        enabled: true,
        readyState: "live",
        stop: vi.fn(),
        getSettings: () => ({ deviceId: `${id}-device` }),
        onended: null as (() => void) | null,
    };
    return track as unknown as MediaStreamTrack;
}

/** A fake `MediaStream` backed by a plain track array - real enough for every call site in this plugin
 * (`getTracks()`/`getAudioTracks()`/`getVideoTracks()`/`addTrack()`/`removeTrack()`). */
export function fakeMediaStream(tracks: MediaStreamTrack[] = [], id = `stream-${Math.random()}`): MediaStream {
    const list = [...tracks];
    const stream = {
        id,
        getTracks: () => [...list],
        getAudioTracks: () => list.filter((t) => t.kind === "audio"),
        getVideoTracks: () => list.filter((t) => t.kind === "video"),
        addTrack: (track: MediaStreamTrack) => list.push(track),
        removeTrack: (track: MediaStreamTrack) => {
            const idx = list.indexOf(track);
            if (idx !== -1) list.splice(idx, 1);
        },
    };
    return stream as unknown as MediaStream;
}

/** A fake `navigator.mediaDevices` - `enumerateDevices`/`getUserMedia`/`getDisplayMedia` are each independently
 * overridable (or omittable, to simulate an unsupported browser). */
export interface FakeMediaDevicesOptions {
    devices?: MediaDeviceInfo[];
    /** A stream, or a function of the requested constraints (which may throw, to fail some requests and not others). */
    userMediaStream?: MediaStream | ((constraints: MediaStreamConstraints) => MediaStream);
    displayMediaStream?: MediaStream | (() => MediaStream);
    userMediaError?: Error;
    displayMediaError?: Error;
    enumerateError?: Error;
    omitEnumerate?: boolean;
    omitGetUserMedia?: boolean;
    omitGetDisplayMedia?: boolean;
}

export function fakeMediaDevices(options: FakeMediaDevicesOptions = {}) {
    const listeners = new Map<string, Set<() => void>>();
    return {
        addEventListener: vi.fn((type: string, listener: () => void) => {
            listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
        }),
        removeEventListener: vi.fn((type: string, listener: () => void) => {
            listeners.get(type)?.delete(listener);
        }),
        /** Fires `type` (e.g. "devicechange") at whoever is listening. */
        emit: (type: string) => {
            for (const listener of [...(listeners.get(type) ?? [])]) listener();
        },
        enumerateDevices: options.omitEnumerate
            ? undefined
            : vi.fn(async () => {
                  if (options.enumerateError) throw options.enumerateError;
                  return options.devices ?? [];
              }),
        getUserMedia: options.omitGetUserMedia
            ? undefined
            : vi.fn(async (constraints: MediaStreamConstraints) => {
                  if (options.userMediaError) throw options.userMediaError;
                  const stream = options.userMediaStream ?? fakeMediaStream([fakeTrack("audio"), fakeTrack("video")]);
                  return typeof stream === "function" ? stream(constraints) : stream;
              }),
        getDisplayMedia: options.omitGetDisplayMedia
            ? undefined
            : vi.fn(async () => {
                  if (options.displayMediaError) throw options.displayMediaError;
                  const stream = options.displayMediaStream ?? fakeMediaStream([fakeTrack("video")]);
                  return typeof stream === "function" ? stream() : stream;
              }),
    };
}

/** jsdom has neither `navigator.mediaDevices` nor a `MediaStream` constructor - these install fakes (undo with
 * `removeMediaDevices()` and `vi.unstubAllGlobals()`). */
export function installMediaDevices(devices: ReturnType<typeof fakeMediaDevices> | undefined): void {
    Object.defineProperty(window.navigator, "mediaDevices", { value: devices, configurable: true });
}

export function removeMediaDevices(): void {
    Object.defineProperty(window.navigator, "mediaDevices", { value: undefined, configurable: true });
}

/** A `MediaStream` constructor building a `fakeMediaStream()` from the tracks it is given. */
export function installFakeMediaStream(): void {
    vi.stubGlobal(
        "MediaStream",
        class {
            constructor(tracks: MediaStreamTrack[] = []) {
                return fakeMediaStream(tracks);
            }
        },
    );
}

/** A fake `MediaDeviceInfo` entry. */
export function fakeDeviceInfo(kind: MediaDeviceKind, deviceId: string, label = ""): MediaDeviceInfo {
    return { kind, deviceId, label, groupId: "", toJSON: () => ({}) };
}

/** A minimal fake `RTCRtpSender`. */
export type FakeSender = { track: MediaStreamTrack | null; replaceTrack: Mock };
function fakeSender(track: MediaStreamTrack | null): FakeSender {
    const sender = {
        track,
        replaceTrack: vi.fn(async (next: MediaStreamTrack | null) => {
            sender.track = next;
        }),
    };
    return sender;
}

/** `fakeRTCPeerConnection()`'s return shape. Every method is loosely typed as the bare `Mock` (rather than left
 * inferred, or given `vi.fn()`'s own precise generic instantiation) - `vi.fn()`'s inferred type here can't be
 * named portably (TS2883) once callback bodies get this involved, and a test only ever needs
 * `expect(...).toHaveBeenCalledWith(...)`/`.mock.calls`, never a precise call signature. */
export interface FakeRTCPeerConnection {
    addTransceiver: Mock;
    claimTransceivers: Mock;
    /** The senders handed out so far, by kind (whichever of `addTransceiver()`/`claimTransceivers()` created them). */
    senders: Partial<Record<"audio" | "video", FakeSender>>;
    createOffer: Mock;
    createAnswer: Mock;
    setLocalDescription: Mock;
    setRemoteDescription: Mock;
    addIceCandidate: Mock;
    close: Mock;
    onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null;
    ontrack: ((event: { track: MediaStreamTrack }) => void) | null;
    onconnectionstatechange: (() => void) | null;
    connectionState: string;
}

/** A fake `RTCPeerConnectionLike` (`apps/shared/webrtc/types.ts`) with scriptable offer/answer SDP and no real ICE
 * negotiation at all - `MeshConnectionManager`'s tests drive its `on*` handlers directly to simulate the network.
 * `claimKinds` is which m-lines the (fake) remote offer had, i.e. what `claimTransceivers()` finds. */
export function fakeRTCPeerConnection(claimKinds: ("audio" | "video")[] = ["audio", "video"]): FakeRTCPeerConnection {
    const senders: Partial<Record<"audio" | "video", FakeSender>> = {};
    return {
        senders,
        addTransceiver: vi.fn((kind: "audio" | "video", track: MediaStreamTrack | null) => {
            senders[kind] = fakeSender(track);
            return { sender: senders[kind] };
        }),
        claimTransceivers: vi.fn(() => {
            for (const kind of claimKinds) {
                senders[kind] = fakeSender(null);
            }
            return { ...senders };
        }),
        createOffer: vi.fn(async () => ({ type: "offer", sdp: "fake-offer-sdp" })),
        createAnswer: vi.fn(async () => ({ type: "answer", sdp: "fake-answer-sdp" })),
        setLocalDescription: vi.fn(async () => undefined),
        setRemoteDescription: vi.fn(async () => undefined),
        addIceCandidate: vi.fn(async () => undefined),
        close: vi.fn(),
        onicecandidate: null,
        ontrack: null,
        onconnectionstatechange: null,
        connectionState: "new",
    };
}

/** `fakePushSocket()`'s return shape - see `FakeRTCPeerConnection`'s doc comment on why `send`/`close` are typed
 * as plain `Mock` rather than inferred. */
export interface FakePushSocket {
    readyState: number;
    send: Mock;
    close: Mock;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    sent: string[];
    open(): void;
    message(data: unknown): void;
    triggerClose(): void;
}

/** A fake `PushSocket` (`apps/shared/push/GuestSignalingClient.ts`'s own seam, mirroring `PushClient`'s identical one) -
 * `open()`/`message()`/`triggerClose()` drive it as the server would. */
export function fakePushSocket(): FakePushSocket {
    const sent: string[] = [];
    const socket: FakePushSocket = {
        readyState: 0,
        send: vi.fn((data: string) => sent.push(data)),
        close: vi.fn(),
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        sent,
        open() {
            socket.readyState = 1;
            socket.onopen?.({});
        },
        message(data: unknown) {
            socket.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
        },
        triggerClose() {
            socket.readyState = 3;
            socket.onclose?.({});
        },
    };
    return socket;
}

/** A `LocalMedia` (`apps/shared/media/useLocalMedia.ts`) with a live camera and microphone and every action a mock -
 * override whatever a test cares about. */
export function fakeLocalMedia(overrides: Partial<LocalMedia> = {}): LocalMedia {
    const audioTrack = fakeTrack("audio", "local-audio");
    const videoTrack = fakeTrack("video", "local-video");
    return {
        supported: true,
        requesting: false,
        error: null,
        audioTrack,
        videoTrack,
        videoStream: fakeMediaStream([videoTrack]),
        micEnabled: true,
        micOn: true,
        cameraOn: true,
        status: { audio: "live", video: "live" },
        devices: { cameras: [], microphones: [] },
        selectedDeviceIds: {},
        audioLevel: 0,
        requestAccess: vi.fn(async () => undefined),
        toggleMic: vi.fn(async () => undefined),
        toggleCamera: vi.fn(async () => undefined),
        selectDevice: vi.fn(async () => undefined),
        release: vi.fn(),
        ...overrides,
    };
}
