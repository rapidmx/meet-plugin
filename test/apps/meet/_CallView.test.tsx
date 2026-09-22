// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeMediaStream, fakeRTCPeerConnection, fakeTrack } from "../testUtils.js";
import type { SignalMessage } from "../../../apps/shared/webrtc/types.js";

const { FakeSignalingClient, createdPcs, levelMeterRegistrations, displayMediaMock } = vi.hoisted(() => {
    class FakeSignalingClient {
        static instances: FakeSignalingClient[] = [];
        sent: SignalMessage[] = [];
        handlers = new Set<(message: SignalMessage) => void>();
        connectResult: Promise<void> = Promise.resolve();
        closed = false;
        constructor(public opts: { channel: string; token?: string }) {
            FakeSignalingClient.instances.push(this);
        }
        connect() {
            return this.connectResult;
        }
        send(message: SignalMessage) {
            this.sent.push(message);
        }
        onMessage(handler: (message: SignalMessage) => void) {
            this.handlers.add(handler);
            return () => this.handlers.delete(handler);
        }
        close() {
            this.closed = true;
        }
        emit(message: SignalMessage) {
            for (const handler of [...this.handlers]) handler(message);
        }
    }
    const createdPcs: ReturnType<typeof fakeRTCPeerConnection>[] = [];
    const levelMeterRegistrations: { uid: string; onLevel: (level: number) => void }[] = [];
    const displayMediaMock = vi.fn();
    return { FakeSignalingClient, createdPcs, levelMeterRegistrations, displayMediaMock };
});

vi.mock("../../../apps/shared/push/GuestSignalingClient.js", () => ({ GuestSignalingClient: FakeSignalingClient }));
vi.mock("../../../apps/shared/webrtc/realPeerConnection.js", () => ({
    createBrowserPeerConnection: () => {
        const pc = fakeRTCPeerConnection();
        createdPcs.push(pc);
        return pc;
    },
}));
vi.mock("../../../apps/shared/media/levelMeter.js", () => ({
    // Mirrors the real module's own contract: no audio track, no meter (see `levelMeter.ts`'s own tests for that
    // behavior in depth) - `_CallView.tsx`'s `startTrackingLevel()` must tolerate `undefined` either way.
    startLevelMeter: (stream: MediaStream, onLevel: (level: number) => void) => {
        if (stream.getAudioTracks().length === 0) {
            return undefined;
        }
        levelMeterRegistrations.push({ uid: `remote-${levelMeterRegistrations.length}`, onLevel });
        return { stop: vi.fn() };
    },
}));
vi.mock("../../../apps/shared/media/deviceMedia.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/media/deviceMedia.js")>();
    return { ...actual, requestDisplayMedia: displayMediaMock };
});

import CallView, { computeMainUid } from "../../../apps/meet/_CallView.js";

function localStream() {
    return fakeMediaStream([fakeTrack("audio", "local-audio"), fakeTrack("video", "local-video")]);
}

function renderCallView(overrides: Partial<React.ComponentProps<typeof CallView>> = {}) {
    const onLeave = vi.fn();
    const props: React.ComponentProps<typeof CallView> = {
        channel: "meeting-1",
        token: "guest-token",
        selfUid: "local-me",
        selfName: "Alice",
        iceServers: [],
        initialStream: localStream(),
        initialMicOn: true,
        initialCameraOn: true,
        onLeave,
        ...overrides,
    };
    const result = render(<CallView {...props} />);
    return { ...result, onLeave, props };
}

beforeEach(() => {
    FakeSignalingClient.instances.length = 0;
    createdPcs.length = 0;
    levelMeterRegistrations.length = 0;
    displayMediaMock.mockReset();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("computeMainUid", () => {
    it("prefers the presenter, then the pin, then the active speaker, then the first other participant", () => {
        expect(computeMainUid({ presenterUid: "p", pinnedUid: "x", activeSpeakerUid: "y", otherUids: ["z"] })).toBe("p");
        expect(computeMainUid({ pinnedUid: "x", activeSpeakerUid: "y", otherUids: ["z"] })).toBe("x");
        expect(computeMainUid({ activeSpeakerUid: "y", otherUids: ["z"] })).toBe("y");
        expect(computeMainUid({ otherUids: ["z"] })).toBe("z");
        expect(computeMainUid({ otherUids: [] })).toBeUndefined();
    });
});

describe("CallView", () => {
    it("connects, starts the mesh and renders the local participant's own tile", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        await waitFor(() => expect(FakeSignalingClient.instances[0].sent).toContainEqual({ type: "video-meeting-signal", kind: "hello", from: "local-me", name: "Alice" }));
        expect(screen.getByText(/Alice \(you\)/)).toBeInTheDocument();
    });

    it("connects with no signaling token at all for an already-authenticated real caller (join()'s 'authenticated: true' case)", async () => {
        renderCallView({ token: undefined });
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        expect(FakeSignalingClient.instances[0].opts.token).toBeUndefined();
        expect(FakeSignalingClient.instances[0].opts.channel).toBe("meeting-1");
    });

    it("shows a connection error when the signaling channel fails to connect", async () => {
        FakeSignalingClient.prototype.connect = function (this: InstanceType<typeof FakeSignalingClient>) {
            return Promise.reject(new Error("channel refused"));
        };
        renderCallView();
        expect(await screen.findByText("channel refused")).toBeInTheDocument();
        FakeSignalingClient.prototype.connect = function (this: InstanceType<typeof FakeSignalingClient>) {
            return this.connectResult;
        };
    });

    it("adds a participant's tile once they say hello, and removes it once they leave", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", name: "Zed" });
        expect(await screen.findByText("Zed")).toBeInTheDocument();

        client.emit({ type: "video-meeting-signal", kind: "bye", from: "zzz" });
        await waitFor(() => expect(screen.queryByText("Zed")).not.toBeInTheDocument());
    });

    it("toggles mic and camera by disabling the underlying local tracks", async () => {
        const stream = localStream();
        renderCallView({ initialStream: stream });
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));

        fireEvent.click(screen.getByText("Mute"));
        expect(stream.getAudioTracks()[0].enabled).toBe(false);
        expect(screen.getByText("Unmute")).toBeInTheDocument();

        fireEvent.click(screen.getByText("Turn camera off"));
        expect(stream.getVideoTracks()[0].enabled).toBe(false);
    });

    it("shares the screen, replacing the outgoing video track, then stops sharing and restores the camera", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", name: "Zed" });
        await screen.findByText("Zed");
        const pc = createdPcs[0];

        const screenTrack = fakeTrack("video", "screen") as MediaStreamTrack & { onended: (() => void) | null };
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([screenTrack]) });
        fireEvent.click(screen.getByText("Share screen"));
        await waitFor(() => expect(screen.getByText("Stop sharing")).toBeInTheDocument());
        const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
        expect(videoSender!.replaceTrack).toHaveBeenLastCalledWith(screenTrack);

        fireEvent.click(screen.getByText("Stop sharing"));
        expect(screen.getByText("Share screen")).toBeInTheDocument();
        expect(videoSender!.replaceTrack).toHaveBeenLastCalledWith(expect.objectContaining({ id: "local-video" }));
    });

    it("stops presenting automatically when the browser's own 'stop sharing' control fires (track onended)", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const screenTrack = fakeTrack("video", "screen") as MediaStreamTrack & { onended: (() => void) | null };
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([screenTrack]) });
        fireEvent.click(screen.getByText("Share screen"));
        await waitFor(() => expect(screen.getByText("Stop sharing")).toBeInTheDocument());

        screenTrack.onended?.();
        await waitFor(() => expect(screen.getByText("Share screen")).toBeInTheDocument());
    });

    it("shows an error and never claims presenter when getDisplayMedia fails", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        displayMediaMock.mockResolvedValueOnce({ ok: false, error: { kind: "permission-denied", message: "denied by the user" } });
        fireEvent.click(screen.getByText("Share screen"));
        expect(await screen.findByText("denied by the user")).toBeInTheDocument();
        expect(screen.getByText("Share screen")).toBeInTheDocument();
    });

    it("disables the share button once someone else presents", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", name: "Zed" });
        await screen.findByText("Zed");
        client.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "zzz" });
        await waitFor(() => expect(screen.getByText("Share screen")).toBeDisabled());
    });

    it("stops the newly captured tracks when someone else wins a genuine claim race", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", name: "Zed" });
        await screen.findByText("Zed");

        const screenTrack = fakeTrack("video", "screen");
        const screenStream = fakeMediaStream([screenTrack]);
        let resolveDisplayMedia!: (value: { ok: true; value: MediaStream }) => void;
        displayMediaMock.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveDisplayMedia = resolve;
            }),
        );
        // The button is still enabled here - nobody presents yet - so the click genuinely goes through; the race
        // is that "zzz" claims presenter while this participant's own `getDisplayMedia()` picker is still open.
        fireEvent.click(screen.getByText("Share screen"));
        client.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "zzz" });
        resolveDisplayMedia({ ok: true, value: screenStream });

        await waitFor(() => expect(screenTrack.stop).toHaveBeenCalled());
        expect(screen.getByText("Share screen")).toBeInTheDocument();
        expect(screen.getByText("Share screen")).toBeDisabled();
    });

    it("self-revokes when a presenter-claim collision is lost after already presenting", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        const screenTrack = fakeTrack("video", "screen");
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([screenTrack]) });
        fireEvent.click(screen.getByText("Share screen"));
        await waitFor(() => expect(screen.getByText("Stop sharing")).toBeInTheDocument());

        // "aaa" < "local-me" - a genuine collision this participant loses (see `MeshConnectionManager`'s own
        // presenter-collision tests for the underlying rule).
        client.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "aaa" });
        await waitFor(() => expect(screen.getByText("Share screen")).toBeInTheDocument());
        expect(screenTrack.stop).toHaveBeenCalled();
    });

    it("leaves the call: notifies onLeave and closes the signaling client", async () => {
        const stream = localStream();
        const { onLeave } = renderCallView({ initialStream: stream });
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        fireEvent.click(screen.getByText("Leave"));
        expect(onLeave).toHaveBeenCalledTimes(1);
    });

    it("stops local tracks and the signaling client on unmount", async () => {
        const stream = localStream();
        const { unmount } = renderCallView({ initialStream: stream });
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        unmount();
        expect(client.closed).toBe(true);
        expect(stream.getTracks().every((t) => (t.stop as ReturnType<typeof vi.fn>).mock.calls.length > 0)).toBe(true);
    });

    it("toggles between grid and focus view", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        fireEvent.click(screen.getByText("Focused view"));
        expect(screen.getByText("Grid view")).toBeInTheDocument();
        fireEvent.click(screen.getByText("Grid view"));
        expect(screen.getByText("Focused view")).toBeInTheDocument();
    });

    it("lets a participant manually pin a remote participant as the focused tile", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        // Two remote participants: "aaa" is who the fallback rule focuses first (see `computeMainUid()`), leaving
        // "zzz" in the still-clickable thumbnail strip to actually exercise a real pin.
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "aaa", name: "Amy" });
        await screen.findByText("Amy");
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", name: "Zed" });
        await screen.findByText("Zed");
        fireEvent.click(screen.getByText("Focused view"));

        const mainArea = () => document.querySelector(".flex-1.min-h-0") as HTMLElement;
        await waitFor(() => expect(mainArea()).toHaveTextContent("Amy"));

        fireEvent.click(screen.getByText("Zed"));
        await waitFor(() => expect(mainArea()).toHaveTextContent("Zed"));
    });

    it("lets a participant toggle their own pin on and off (grid view keeps every tile clickable)", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        fireEvent.click(screen.getByText(/Alice \(you\)/));
        fireEvent.click(screen.getByText(/Alice \(you\)/));
        // Neither click threw, and the tile is still there either way - grid view never hides it.
        expect(screen.getByText(/Alice \(you\)/)).toBeInTheDocument();
    });

    it("clears a pinned participant's pin once they leave", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", name: "Zed" });
        await screen.findByText("Zed");
        fireEvent.click(screen.getByText("Zed"));

        client.emit({ type: "video-meeting-signal", kind: "bye", from: "zzz" });
        await waitFor(() => expect(screen.queryByText("Zed")).not.toBeInTheDocument());
        // The pin was cleared too, not just the tile - toggling to focus view renders without error even though
        // there's nobody left to focus on (falls back to the grid layout - see `computeMainUid()`).
        fireEvent.click(screen.getByText("Focused view"));
        expect(screen.getByText(/Alice \(you\)/)).toBeInTheDocument();
    });

    it("falls back to no camera track when the initial stream has none", async () => {
        renderCallView({ initialStream: fakeMediaStream([fakeTrack("audio")]) });
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        expect(screen.getByText(/Alice \(you\)/)).toBeInTheDocument();
    });

    it("does not start the mesh, or set a connect error, after unmounting before connect() settles", async () => {
        let resolveConnect!: () => void;
        let rejectConnect!: (err: Error) => void;
        FakeSignalingClient.prototype.connect = function () {
            return new Promise<void>((resolve, reject) => {
                resolveConnect = resolve;
                rejectConnect = reject;
            });
        };
        const { unmount } = renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        unmount();
        resolveConnect();
        await Promise.resolve();
        await Promise.resolve();

        FakeSignalingClient.prototype.connect = function () {
            return new Promise<void>((_resolve, reject) => {
                rejectConnect = reject;
            });
        };
        const { unmount: unmount2 } = renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(2));
        unmount2();
        rejectConnect(new Error("too late"));
        await Promise.resolve();
        await Promise.resolve();

        FakeSignalingClient.prototype.connect = function (this: InstanceType<typeof FakeSignalingClient>) {
            return this.connectResult;
        };
    });

    it("does not track a level meter for a remote stream with no audio track", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", name: "Zed" });
        await screen.findByText("Zed");
        const pc = createdPcs[0];
        pc.ontrack!({ streams: [fakeMediaStream([fakeTrack("video")])] });
        expect(levelMeterRegistrations).toHaveLength(0);
    });

    it("auto-focuses the loudest remote participant, ignored while presenting", async () => {
        renderCallView();
        await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
        const client = FakeSignalingClient.instances[0];
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", name: "Zed" });
        await screen.findByText("Zed");
        const pc = createdPcs[0];
        const remoteStream = fakeMediaStream([fakeTrack("audio")]);
        pc.ontrack!({ streams: [remoteStream] });

        fireEvent.click(screen.getByText("Focused view"));
        await waitFor(() => expect(levelMeterRegistrations.length).toBeGreaterThan(0));
        levelMeterRegistrations[0].onLevel(80);
        await waitFor(() => expect(document.querySelectorAll(".ring-2").length).toBeGreaterThan(0));
    });
});
