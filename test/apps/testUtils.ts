///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Shared test fakes for `apps/meet/**`, mirroring `booking-plugin`'s own `test/apps/testUtils.ts` conventions
 * (`jsonResponse`/`mockFetch`), extended with fakes for the browser APIs this plugin is the first in this codebase
 * to use at all - `navigator.mediaDevices`, `RTCPeerConnection` and the push `WebSocket` (see this plugin's Phase 2
 * `.claude/NOTES.md` entry: there was no existing mocking convention for any of these to follow). */
import { vi, type Mock } from "vitest";

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
        stop: vi.fn(),
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
    userMediaStream?: MediaStream | (() => MediaStream);
    displayMediaStream?: MediaStream | (() => MediaStream);
    userMediaError?: Error;
    displayMediaError?: Error;
    enumerateError?: Error;
    omitEnumerate?: boolean;
    omitGetUserMedia?: boolean;
    omitGetDisplayMedia?: boolean;
}

export function fakeMediaDevices(options: FakeMediaDevicesOptions = {}) {
    return {
        enumerateDevices: options.omitEnumerate
            ? undefined
            : vi.fn(async () => {
                  if (options.enumerateError) throw options.enumerateError;
                  return options.devices ?? [];
              }),
        getUserMedia: options.omitGetUserMedia
            ? undefined
            : vi.fn(async () => {
                  if (options.userMediaError) throw options.userMediaError;
                  const stream = options.userMediaStream ?? fakeMediaStream([fakeTrack("audio"), fakeTrack("video")]);
                  return typeof stream === "function" ? stream() : stream;
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

/** A fake `MediaDeviceInfo` entry. */
export function fakeDeviceInfo(kind: MediaDeviceKind, deviceId: string, label = ""): MediaDeviceInfo {
    return { kind, deviceId, label, groupId: "", toJSON: () => ({}) };
}

/** A minimal fake `RTCRtpSender`. */
function fakeSender(track: MediaStreamTrack): { track: MediaStreamTrack | null; replaceTrack: Mock } {
    const sender = {
        track: track as MediaStreamTrack | null,
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
    addTrack: Mock;
    getSenders: Mock;
    createOffer: Mock;
    createAnswer: Mock;
    setLocalDescription: Mock;
    setRemoteDescription: Mock;
    addIceCandidate: Mock;
    close: Mock;
    onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null;
    ontrack: ((event: { streams: readonly MediaStream[] }) => void) | null;
    onconnectionstatechange: (() => void) | null;
    connectionState: string;
}

/** A fake `RTCPeerConnectionLike` (`apps/shared/webrtc/types.ts`) with scriptable offer/answer SDP and no real ICE
 * negotiation at all - `MeshConnectionManager`'s tests drive its `on*` handlers directly to simulate the network. */
export function fakeRTCPeerConnection(): FakeRTCPeerConnection {
    const senders: ReturnType<typeof fakeSender>[] = [];
    return {
        addTrack: vi.fn((track: MediaStreamTrack) => {
            const sender = fakeSender(track);
            senders.push(sender);
            return sender;
        }),
        getSenders: vi.fn(() => senders),
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
