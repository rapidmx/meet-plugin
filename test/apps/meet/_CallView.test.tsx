// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeRTCPeerConnection, fakeLocalMedia, fakeMediaStream, fakeTrack, installFakeMediaStream } from "../testUtils.js";
import { REACTION_EMOJIS, type SignalMessage } from "../../../apps/shared/webrtc/types.js";

const { FakeSignalingClient, createdPcs, levelMeterRegistrations, displayMediaMock, chimeMock } = vi.hoisted(() => {
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
            act(() => {
                for (const handler of [...this.handlers]) handler(message);
            });
        }
    }
    const createdPcs: unknown[] = [];
    const levelMeterRegistrations: { onLevel: (level: number) => void }[] = [];
    return { FakeSignalingClient, createdPcs, levelMeterRegistrations, displayMediaMock: vi.fn(), chimeMock: vi.fn() };
});

vi.mock("../../../apps/shared/push/GuestSignalingClient.js", () => ({ GuestSignalingClient: FakeSignalingClient }));
vi.mock("../../../apps/shared/webrtc/realPeerConnection.js", async () => {
    const utils = await import("../testUtils.js");
    return {
        createBrowserPeerConnection: () => {
            const pc = utils.fakeRTCPeerConnection();
            createdPcs.push(pc);
            return pc;
        },
    };
});
vi.mock("../../../apps/shared/media/levelMeter.js", () => ({
    // Mirrors the real module's own contract: no audio track, no meter (see `levelMeter.ts`'s own tests for that
    // behavior in depth) - `_CallView.tsx`'s `startTrackingLevel()` must tolerate `undefined` either way.
    startLevelMeter: (stream: MediaStream, onLevel: (level: number) => void) => {
        if (stream.getAudioTracks().length === 0) {
            return undefined;
        }
        levelMeterRegistrations.push({ onLevel });
        return { stop: vi.fn() };
    },
}));
vi.mock("../../../apps/shared/media/deviceMedia.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/media/deviceMedia.js")>();
    return { ...actual, requestDisplayMedia: displayMediaMock };
});
vi.mock("../../../apps/shared/media/chime.js", () => ({ playRaisedHandChime: chimeMock }));

import CallView, { computeMainUid, newPeerId } from "../../../apps/meet/_CallView.js";

/** This tab's own id on the channel - `CallView` appends a random suffix to the uid it is given (stubbed below). */
const SELF = "local-me~fixed";
const STATE = { audioOn: true, videoOn: true, handRaised: false };

function pcs(): FakeRTCPeerConnection[] {
    return createdPcs as FakeRTCPeerConnection[];
}

function renderCallView(overrides: Partial<React.ComponentProps<typeof CallView>> = {}) {
    const onLeave = vi.fn();
    const props: React.ComponentProps<typeof CallView> = {
        channel: "meeting-1",
        token: "guest-token",
        selfUid: "local-me",
        selfName: "Alice",
        meetingTitle: "Standup",
        iceServers: [],
        media: fakeLocalMedia(),
        onLeave,
        ...overrides,
    };
    const result = render(<CallView {...props} />);
    return { ...result, onLeave, props };
}

/** Renders, waits for the signaling client to connect and the mesh to announce itself, and returns the client. */
async function connected(overrides: Partial<React.ComponentProps<typeof CallView>> = {}) {
    const view = renderCallView(overrides);
    await waitFor(() => expect(FakeSignalingClient.instances).toHaveLength(1));
    const client = FakeSignalingClient.instances[0];
    await waitFor(() => expect(client.sent.length).toBeGreaterThan(0));
    return { ...view, client };
}

/** A participant saying hello - "zzz" sorts after `SELF`, so this participant is the one who offers to them. */
const hello = (from: string, name: string, state = STATE): SignalMessage => ({ type: "video-meeting-signal", kind: "hello", from, name, state });

async function withParticipant(overrides: Partial<React.ComponentProps<typeof CallView>> = {}, from = "zzz", name = "Zed", state = STATE) {
    const view = await connected(overrides);
    view.client.emit(hello(from, name, state));
    await screen.findAllByText(name);
    return view;
}

let playMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    FakeSignalingClient.instances.length = 0;
    createdPcs.length = 0;
    levelMeterRegistrations.length = 0;
    displayMediaMock.mockReset();
    chimeMock.mockReset();
    vi.stubGlobal("crypto", { randomUUID: () => "fixed" });
    installFakeMediaStream();
    playMock = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    playMock.mockRestore();
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

describe("newPeerId", () => {
    it("is the uid plus a random suffix, so one account on two devices is two participants", () => {
        expect(newPeerId("user-1")).toBe("user-1~fixed");
    });

    it("still makes one where the browser has no randomUUID", () => {
        vi.stubGlobal("crypto", {});
        const id = newPeerId("user-1");
        expect(id).toMatch(/^user-1~.+/);
        expect(id).not.toBe(newPeerId("user-1"));
    });
});

describe("CallView - connecting", () => {
    it("connects, starts the mesh under its own peer id, and announces its name and what it sends", async () => {
        const { client } = await connected();
        expect(client.opts).toEqual({ channel: "meeting-1", token: "guest-token" });
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "hello", from: SELF, name: "Alice", state: STATE });
        expect(screen.getByRole("heading", { name: "Standup" })).toBeInTheDocument();
        expect(screen.getByLabelText("1 participants")).toBeInTheDocument();
    });

    it("announces a muted microphone and a camera that is off as they are", async () => {
        const { client } = await connected({ media: fakeLocalMedia({ micOn: false, cameraOn: false }) });
        expect(client.sent[0].state).toEqual({ audioOn: false, videoOn: false, handRaised: false });
    });

    it("connects with no signaling token at all for an already-authenticated real caller (join()'s 'authenticated: true' case)", async () => {
        const { client } = await connected({ token: undefined });
        expect(client.opts.token).toBeUndefined();
        expect(client.opts.channel).toBe("meeting-1");
    });

    it("shows a connection error when the signaling channel fails to connect", async () => {
        FakeSignalingClient.prototype.connect = function () {
            return Promise.reject(new Error("channel refused"));
        };
        renderCallView();
        expect(await screen.findByRole("alert")).toHaveTextContent("channel refused");
        FakeSignalingClient.prototype.connect = function (this: InstanceType<typeof FakeSignalingClient>) {
            return this.connectResult;
        };
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
        expect(FakeSignalingClient.instances[0].sent).toEqual([]);

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

    it("says goodbye when the page is closed, and closes the client and stops its own captures on unmount - but never the camera or microphone", async () => {
        const media = fakeLocalMedia();
        const { client, unmount } = await connected({ media });
        act(() => {
            window.dispatchEvent(new Event("pagehide"));
        });
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "bye", from: SELF });

        const screenTrack = fakeTrack("video", "screen");
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([screenTrack]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });
        unmount();
        expect(client.closed).toBe(true);
        expect(screenTrack.stop).toHaveBeenCalled();
        // Those belong to the page, which releases them when the participant leaves.
        expect(media.audioTrack!.stop).not.toHaveBeenCalled();
        expect(media.videoTrack!.stop).not.toHaveBeenCalled();
    });

    it("leaves the call: notifies onLeave", async () => {
        const { onLeave } = await connected();
        fireEvent.click(screen.getByRole("button", { name: "Leave call" }));
        expect(onLeave).toHaveBeenCalledTimes(1);
    });
});

describe("CallView - layout", () => {
    it("fills the window, with the controls below the tiles rather than over them", async () => {
        const { container } = await connected();
        const root = container.firstElementChild!;
        expect(root.className).toContain("fixed inset-0");
        const [header, main, footer] = [root.querySelector("header")!, root.querySelector("main")!, root.querySelector("footer")!];
        expect(header.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(within(footer).getByRole("toolbar", { name: "Call controls" })).toBeInTheDocument();
    });

    it("shows the local participant large while alone, and in a corner tile once anyone else joins", async () => {
        const { client } = await connected();
        expect(screen.queryByTestId("self-view")).toBeNull();
        expect(within(screen.getByRole("main")).getByText(/Alice \(you\)/)).toBeInTheDocument();

        client.emit(hello("zzz", "Zed"));
        await screen.findByText("Zed");
        expect(within(screen.getByTestId("self-view")).getByText(/Alice \(you\)/)).toBeInTheDocument();
        // Only the other participant is in the main tile area.
        expect(within(screen.getByRole("main")).queryByText(/\(you\)/)).toBeNull();
        expect(within(screen.getByRole("main")).getByText("Zed")).toBeInTheDocument();
        expect(screen.getByLabelText("2 participants")).toBeInTheDocument();

        client.emit({ type: "video-meeting-signal", kind: "bye", from: "zzz" });
        await waitFor(() => expect(screen.queryByText("Zed")).toBeNull());
        expect(screen.queryByTestId("self-view")).toBeNull();
        expect(screen.getByLabelText("1 participants")).toBeInTheDocument();
    });

    it("shows a shared screen large while alone", async () => {
        await connected();
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([fakeTrack("video", "screen")]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });
        expect(screen.getByRole("main").querySelector("video")!.className).toContain("object-contain");
    });

    it("toggles between grid and focus view", async () => {
        await withParticipant();
        fireEvent.click(screen.getByRole("button", { name: "Switch to focused view" }));
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Zed");
        // Nobody else to put in the strip.
        expect(screen.queryByTestId("thumbnails")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Switch to grid view" }));
        expect(screen.queryByTestId("main-tile")).toBeNull();
    });

    it("lets a participant pin another as the focused tile, and unpin them", async () => {
        const { client } = await withParticipant({}, "aaa", "Amy");
        client.emit(hello("zzz", "Zed"));
        await screen.findAllByText("Zed");
        fireEvent.click(screen.getByRole("button", { name: "Switch to focused view" }));
        // "aaa" is who the fallback rule focuses first (see `computeMainUid()`); "zzz" waits in the strip.
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Amy");
        expect(screen.getByTestId("thumbnails")).toHaveTextContent("Zed");

        fireEvent.click(within(screen.getByTestId("thumbnails")).getByRole("button", { name: "Zed" }));
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Zed");
        expect(screen.getByTestId("thumbnails")).toHaveTextContent("Amy");

        fireEvent.click(within(screen.getByTestId("main-tile")).getByRole("button", { name: "Zed" }));
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Amy");
    });

    it("clears a pinned participant's pin once they leave, without ever showing the wrong tile", async () => {
        const { client } = await withParticipant({}, "aaa", "Amy");
        client.emit(hello("zzz", "Zed"));
        await screen.findAllByText("Zed");
        fireEvent.click(screen.getByRole("button", { name: "Switch to focused view" }));
        fireEvent.click(within(screen.getByTestId("thumbnails")).getByRole("button", { name: "Zed" }));

        client.emit({ type: "video-meeting-signal", kind: "bye", from: "zzz" });
        await waitFor(() => expect(screen.queryByText("Zed")).toBeNull());
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Amy");
        expect(screen.getByTestId("main-tile")).not.toHaveTextContent("(you)");
    });

    it("auto-focuses the loudest remote participant in focus view, but not while someone presents", async () => {
        const { client } = await withParticipant({}, "aaa", "Amy");
        client.emit(hello("zzz", "Zed"));
        await screen.findAllByText("Zed");
        // Both send audio - the meter starts for each stream that has an audio track.
        for (const pc of pcs()) act(() => pc.ontrack!({ track: fakeTrack("audio") }));
        expect(levelMeterRegistrations).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: "Switch to focused view" }));
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Amy");

        act(() => levelMeterRegistrations[1].onLevel(80));
        await waitFor(() => expect(screen.getByTestId("main-tile")).toHaveTextContent("Zed"));

        // Amy presents: the presenter wins the main tile, whoever is loudest.
        client.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "aaa" });
        await waitFor(() => expect(screen.getByTestId("main-tile")).toHaveTextContent("Amy"));
        act(() => levelMeterRegistrations[1].onLevel(90));
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Amy");
    });

    it("does not track a level for a remote stream with no audio track", async () => {
        await withParticipant();
        act(() => pcs()[0].ontrack!({ track: fakeTrack("video") }));
        expect(levelMeterRegistrations).toHaveLength(0);
    });

    it("drops a departed participant's level meter", async () => {
        const { client } = await withParticipant();
        act(() => pcs()[0].ontrack!({ track: fakeTrack("audio") }));
        client.emit({ type: "video-meeting-signal", kind: "bye", from: "zzz" });
        await waitFor(() => expect(screen.queryByText("Zed")).toBeNull());
        expect(screen.queryByTestId("remote-audio")).toBeNull();
    });
});

describe("CallView - what other participants show", () => {
    it("shows an avatar for a camera that is off and a muted microphone, as announced", async () => {
        const { client } = await withParticipant({}, "zzz", "Zed", { audioOn: false, videoOn: false, handRaised: false });
        const tile = screen.getByRole("button", { name: "Zed" });
        expect(within(tile).getByRole("img", { name: "Muted" })).toBeInTheDocument();
        expect(tile.querySelector("video")).toBeNull();

        client.emit({ type: "video-meeting-signal", kind: "state", from: "zzz", state: STATE });
        await waitFor(() => expect(within(screen.getByRole("button", { name: "Zed" })).queryByRole("img", { name: "Muted" })).toBeNull());
    });

    it("shows a peer under their real name once their hello arrives after their offer", async () => {
        const { client } = await connected();
        client.emit({ type: "video-meeting-signal", kind: "offer", from: "zzz", to: SELF, sdp: { type: "offer", sdp: "o" } });
        await screen.findAllByText("zzz");
        client.emit(hello("zzz", "Zed"));
        await screen.findByText("Zed");
        expect(screen.queryByText("zzz")).toBeNull();
    });

    it("plays each remote participant's stream through its own hidden audio element, whether or not their camera is on", async () => {
        await withParticipant({}, "zzz", "Zed", { audioOn: true, videoOn: false, handRaised: false });
        expect(screen.queryByTestId("remote-audio")).toBeNull();

        const audio = fakeTrack("audio");
        act(() => pcs()[0].ontrack!({ track: audio }));
        const element = await screen.findByTestId<HTMLAudioElement>("remote-audio");
        expect(element.srcObject).toBeTruthy();
        expect((element.srcObject as MediaStream).getTracks()).toEqual([audio]);
        await waitFor(() => expect(playMock).toHaveBeenCalled());
        expect(screen.queryByRole("button", { name: /turn on sound/ })).toBeNull();
    });

    it("asks for a click when the browser won't start the audio, and tries again on it", async () => {
        await withParticipant();
        playMock.mockRejectedValueOnce(new Error("NotAllowedError"));
        act(() => pcs()[0].ontrack!({ track: fakeTrack("audio") }));
        const banner = await screen.findByRole("button", { name: "Click here to turn on sound" });
        const before = playMock.mock.calls.length;

        fireEvent.click(banner);
        await waitFor(() => expect(playMock.mock.calls.length).toBeGreaterThan(before));
        expect(screen.queryByRole("button", { name: "Click here to turn on sound" })).toBeNull();
    });
});

describe("CallView - raising a hand", () => {
    it("tells everyone, shows the hand, and lowers it again", async () => {
        const { client } = await connected();
        fireEvent.click(screen.getByRole("button", { name: "Raise hand" }));

        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "state", from: SELF, state: { ...STATE, handRaised: true } });
        expect(screen.getByTestId("raised-hands")).toHaveTextContent("You");
        expect(screen.getByRole("button", { name: "Lower hand" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Hand raised" })).toBeInTheDocument();
        // Your own hand is no cause for a chime.
        expect(chimeMock).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Lower hand" }));
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "state", from: SELF, state: STATE });
        expect(screen.queryByTestId("raised-hands")).toBeNull();
    });

    it("shows another participant's raised hand, chimes, and announces it", async () => {
        const { client } = await withParticipant();
        client.emit({ type: "video-meeting-signal", kind: "state", from: "zzz", state: { ...STATE, handRaised: true } });

        await waitFor(() => expect(screen.getByTestId("raised-hands")).toHaveTextContent("Zed"));
        expect(chimeMock).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("status")).toHaveTextContent("Zed raised a hand");
        expect(within(screen.getByRole("button", { name: "Zed" })).getByRole("img", { name: "Hand raised" })).toBeInTheDocument();

        client.emit({ type: "video-meeting-signal", kind: "state", from: "zzz", state: STATE });
        await waitFor(() => expect(screen.queryByTestId("raised-hands")).toBeNull());
        expect(chimeMock).toHaveBeenCalledTimes(1);
    });

    it("lists everyone whose hand is up, you first", async () => {
        const { client } = await withParticipant({}, "zzz", "Zed", { ...STATE, handRaised: true });
        expect(screen.getByTestId("raised-hands")).toHaveTextContent("Zed");
        fireEvent.click(screen.getByRole("button", { name: "Raise hand" }));
        expect(screen.getByTestId("raised-hands")).toHaveTextContent("You, Zed");
        expect(client.sent.filter((m) => m.kind === "state")).toHaveLength(1);
    });
});

describe("CallView - reactions", () => {
    it("sends a reaction and shows it floating up with the name 'You'", async () => {
        const { client } = await connected();
        fireEvent.click(screen.getByRole("button", { name: "Send a reaction" }));
        fireEvent.click(screen.getByRole("menuitem", { name: `Send ${REACTION_EMOJIS[3]}` }));

        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "reaction", from: SELF, emoji: REACTION_EMOJIS[3] });
        const reaction = screen.getByTestId("reaction");
        expect(reaction).toHaveTextContent(REACTION_EMOJIS[3]);
        expect(reaction).toHaveTextContent("You");
    });

    it("shows another participant's reaction with their name", async () => {
        const { client } = await withParticipant();
        client.emit({ type: "video-meeting-signal", kind: "reaction", from: "zzz", emoji: REACTION_EMOJIS[0] });
        const reaction = await screen.findByTestId("reaction");
        expect(reaction).toHaveTextContent(REACTION_EMOJIS[0]);
        expect(reaction).toHaveTextContent("Zed");
    });

    it("takes reactions down after a few seconds, and keeps only the latest dozen", async () => {
        const { client } = await withParticipant();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        for (let i = 0; i < 14; i++) {
            client.emit({ type: "video-meeting-signal", kind: "reaction", from: "zzz", emoji: REACTION_EMOJIS[i % REACTION_EMOJIS.length] });
        }
        expect(screen.getAllByTestId("reaction")).toHaveLength(12);

        act(() => {
            vi.advanceTimersByTime(4_000);
        });
        expect(screen.queryAllByTestId("reaction")).toHaveLength(0);
    });

    it("cancels pending reaction timers on unmount", async () => {
        const { client, unmount } = await withParticipant();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        client.emit({ type: "video-meeting-signal", kind: "reaction", from: "zzz", emoji: REACTION_EMOJIS[0] });
        expect(vi.getTimerCount()).toBe(1);
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("CallView - what is sent follows the local media", () => {
    it("swaps a new microphone or camera onto every connection, and announces a change of mute or camera", async () => {
        const media = fakeLocalMedia();
        const { client, rerender, props } = await withParticipant({ media });
        const pc = pcs()[0];

        const newAudio = fakeTrack("audio", "new-audio");
        const newVideo = fakeTrack("video", "new-video");
        rerender(<CallView {...props} media={{ ...media, audioTrack: newAudio, videoTrack: newVideo, micOn: false, cameraOn: false }} />);

        expect(pc.senders.audio!.replaceTrack).toHaveBeenLastCalledWith(newAudio);
        expect(pc.senders.video!.replaceTrack).toHaveBeenLastCalledWith(newVideo);
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "state", from: SELF, state: { audioOn: false, videoOn: false, handRaised: false } });
    });

    it("sends the shared screen in place of the camera while presenting, and the camera again after", async () => {
        const media = fakeLocalMedia();
        const { client } = await withParticipant({ media });
        const pc = pcs()[0];

        const screenTrack = fakeTrack("video", "screen");
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([screenTrack]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });
        expect(pc.senders.video!.replaceTrack).toHaveBeenLastCalledWith(screenTrack);
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-claim", from: SELF });
        // The presenter is main tile, showing their screen fitted rather than cropped.
        expect(screen.getByTestId("main-tile").querySelector("video")!.className).toContain("object-contain");

        fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
        expect(screen.getByRole("button", { name: "Share screen" })).toBeInTheDocument();
        expect(pc.senders.video!.replaceTrack).toHaveBeenLastCalledWith(media.videoTrack);
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-release", from: SELF });
        expect(screenTrack.stop).toHaveBeenCalled();
    });

    it("counts a shared screen as sending video even with the camera off", async () => {
        const { client } = await connected({ media: fakeLocalMedia({ cameraOn: false, videoTrack: null, videoStream: null }) });
        expect(client.sent[0].state!.videoOn).toBe(false);
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([fakeTrack("video", "screen")]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });
        expect(client.sent.filter((m) => m.kind === "state").pop()!.state!.videoOn).toBe(true);
    });
});

describe("CallView - presenting", () => {
    it("stops presenting automatically when the browser's own 'stop sharing' control fires (track onended)", async () => {
        await connected();
        const screenTrack = fakeTrack("video", "screen");
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([screenTrack]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });

        act(() => {
            screenTrack.onended?.(new Event("ended"));
        });
        expect(await screen.findByRole("button", { name: "Share screen" })).toBeInTheDocument();
    });

    it("shows an error and never claims presenter when getDisplayMedia fails", async () => {
        const { client } = await connected();
        displayMediaMock.mockResolvedValueOnce({ ok: false, error: { kind: "permission-denied", message: "denied by the user" } });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("denied by the user");
        expect(client.sent.some((m) => m.kind === "presenter-claim")).toBe(false);
    });

    it("shows who is presenting, and disables the share button", async () => {
        const { client } = await withParticipant();
        client.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "zzz" });
        await waitFor(() => expect(screen.getByRole("button", { name: "Share screen" })).toBeDisabled());
        expect(screen.getByText("Zed is presenting")).toBeInTheDocument();
        // The presenter's screen is fitted, not cropped, and named "Someone" if we somehow don't know them.
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Zed");
    });

    it("names an unknown presenter 'Someone'", async () => {
        const { client } = await connected();
        client.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "ghost" });
        expect(await screen.findByText("Someone is presenting")).toBeInTheDocument();
    });

    it("stops the newly captured tracks when someone else wins a genuine claim race", async () => {
        const { client } = await withParticipant();
        const screenTrack = fakeTrack("video", "screen");
        let resolveDisplayMedia!: (value: { ok: true; value: MediaStream }) => void;
        displayMediaMock.mockReturnValueOnce(new Promise((resolve) => (resolveDisplayMedia = resolve)));
        // The button is still enabled here - nobody presents yet - so the click genuinely goes through; the race
        // is that "zzz" claims presenter while this participant's own `getDisplayMedia()` picker is still open.
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        client.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "zzz" });
        resolveDisplayMedia({ ok: true, value: fakeMediaStream([screenTrack]) });

        await waitFor(() => expect(screenTrack.stop).toHaveBeenCalled());
        expect(screen.getByRole("button", { name: "Share screen" })).toBeDisabled();
    });

    it("self-revokes when a presenter-claim collision is lost after already presenting", async () => {
        const { client } = await connected();
        const screenTrack = fakeTrack("video", "screen");
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([screenTrack]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });

        // "aaa" < SELF - a genuine collision this participant loses (see `MeshConnectionManager`'s own
        // presenter-collision tests for the underlying rule).
        client.emit({ type: "video-meeting-signal", kind: "presenter-claim", from: "aaa" });
        await waitFor(() => expect(screen.getByRole("button", { name: "Share screen" })).toBeInTheDocument());
        expect(screenTrack.stop).toHaveBeenCalled();
    });

    it("shows the local presenter's own screen large among other participants", async () => {
        await withParticipant();
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([fakeTrack("video", "screen")]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });
        const main = screen.getByTestId("main-tile");
        expect(main).toHaveTextContent("Alice (you)");
        // The other participant waits in the strip.
        expect(within(screen.getByTestId("thumbnails")).getByRole("button", { name: "Zed" })).toBeInTheDocument();
    });
});
