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

const { FakeSignalingClient, createdPcs, levelMeterRegistrations, displayMediaMock, chimeMock, relayMock } = vi.hoisted(() => {
    class FakeSignalingClient {
        static instances: FakeSignalingClient[] = [];
        /** What the next client's `connect()` settles with - a test sets it to hold signaling open or make it fail. */
        static nextConnectResult: Promise<void> | undefined;
        sent: SignalMessage[] = [];
        handlers = new Set<(message: SignalMessage) => void>();
        connectResult: Promise<void> = FakeSignalingClient.nextConnectResult ?? Promise.resolve();
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
    // The WebSocket media relay: `supported` is what the fake reports, `created` every one the view made.
    const relayMock = {
        supported: true,
        created: [] as {
            supported: boolean;
            receiveFrom: ReturnType<typeof vi.fn>;
            stopReceivingFrom: ReturnType<typeof vi.fn>;
            setSending: ReturnType<typeof vi.fn>;
            setLocalTrack: ReturnType<typeof vi.fn>;
            close: ReturnType<typeof vi.fn>;
        }[],
        create: vi.fn(),
    };
    return { FakeSignalingClient, createdPcs, levelMeterRegistrations, displayMediaMock: vi.fn(), chimeMock: vi.fn(), relayMock };
});

vi.mock("../../../apps/shared/relay/RelayTransport.js", () => ({
    createRelayTransport: (options: unknown) => {
        relayMock.create(options);
        const relay = {
            supported: relayMock.supported,
            receiveFrom: vi.fn(),
            stopReceivingFrom: vi.fn(),
            setSending: vi.fn(),
            setLocalTrack: vi.fn(),
            close: vi.fn(),
        };
        relayMock.created.push(relay);
        return relay;
    },
}));

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

const {
    kickParticipantMock,
    setForceMuteOnJoinMock,
    setMeetingPasswordMock,
    setWaitingRoomEnabledMock,
    listWaitingParticipantsMock,
    admitParticipantMock,
    denyParticipantMock,
} = vi.hoisted(() => ({
    kickParticipantMock: vi.fn().mockResolvedValue(undefined),
    setForceMuteOnJoinMock: vi.fn().mockResolvedValue(undefined),
    setMeetingPasswordMock: vi.fn().mockResolvedValue(undefined),
    setWaitingRoomEnabledMock: vi.fn().mockResolvedValue(undefined),
    listWaitingParticipantsMock: vi.fn().mockResolvedValue([]),
    admitParticipantMock: vi.fn().mockResolvedValue(undefined),
    denyParticipantMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../apps/meet/_meetApi.js", () => ({
    kickParticipant: kickParticipantMock,
    setForceMuteOnJoin: setForceMuteOnJoinMock,
    setMeetingPassword: setMeetingPasswordMock,
    setWaitingRoomEnabled: setWaitingRoomEnabledMock,
    listWaitingParticipants: listWaitingParticipantsMock,
    admitParticipant: admitParticipantMock,
    denyParticipant: denyParticipantMock,
}));

import CallView, { accountUidOf, computeMainUid, newPeerId } from "../../../apps/meet/_CallView.js";

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
    FakeSignalingClient.nextConnectResult = undefined;
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
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "hello", from: "local-me", peer: SELF, name: "Alice", state: STATE });
        expect(screen.getByRole("heading", { name: "Standup" })).toBeInTheDocument();
        expect(screen.getByLabelText("1 participants")).toBeInTheDocument();
    });

    it("publishes as the authenticated uid - the server refuses any other 'from' - and names its tab in 'peer'", async () => {
        const { client } = await connected({ selfUid: "user-1" });
        for (const message of client.sent) {
            expect(message.from).toBe("user-1");
            expect(message.peer).toBe("user-1~fixed");
        }
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
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "bye", from: "local-me", peer: SELF });

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
        const { client } = await withParticipant({}, "aaa", "Amy");
        client.emit(hello("zzz", "Zed"));
        await screen.findAllByText("Zed");
        fireEvent.click(screen.getByRole("button", { name: "Switch to focused view" }));
        expect(screen.getByTestId("main-tile")).toHaveTextContent("Amy");
        expect(screen.getByTestId("thumbnails")).toHaveTextContent("Zed");
        fireEvent.click(screen.getByRole("button", { name: "Switch to grid view" }));
        expect(screen.queryByTestId("main-tile")).toBeNull();
    });

    it("disables the grid/focus toggle with only one other participant - there is nothing to visibly toggle", async () => {
        await withParticipant();
        expect(screen.getByRole("button", { name: "Switch to focused view" })).toBeDisabled();
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

        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "state", from: "local-me", peer: SELF, state: { ...STATE, handRaised: true } });
        expect(screen.getByTestId("raised-hands")).toHaveTextContent("You");
        expect(screen.getByRole("button", { name: "Lower hand" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: "Hand raised" })).toBeInTheDocument();
        // Your own hand is no cause for a chime.
        expect(chimeMock).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Lower hand" }));
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "state", from: "local-me", peer: SELF, state: STATE });
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

        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "reaction", from: "local-me", peer: SELF, emoji: REACTION_EMOJIS[3] });
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

describe("CallView - mirroring the local tile", () => {
    it("mirrors the self tile normally, but not with a custom background image", async () => {
        const { container, rerender, props } = await connected({ media: fakeLocalMedia() });
        expect(container.querySelector("video")!.className).toContain("scaleX(-1)");

        const withImage = fakeLocalMedia({ filters: { background: "image", effect: "none", accessory: "none" } });
        rerender(<CallView {...props} media={withImage} />);
        // The picture the participant chose is a fixed reference, not a live reflection - mirroring it would show
        // it backwards to no one but themselves (see `_ParticipantTile.tsx`'s doc comment).
        expect(container.querySelector("video")!.className).not.toContain("scaleX(-1)");
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
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "state", from: "local-me", peer: SELF, state: { audioOn: false, videoOn: false, handRaised: false } });
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
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-claim", from: "local-me", peer: SELF });
        // The presenter is main tile, showing their screen fitted rather than cropped.
        expect(screen.getByTestId("main-tile").querySelector("video")!.className).toContain("object-contain");

        fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
        expect(screen.getByRole("button", { name: "Share screen" })).toBeInTheDocument();
        expect(pc.senders.video!.replaceTrack).toHaveBeenLastCalledWith(media.videoTrack);
        expect(client.sent).toContainEqual({ type: "video-meeting-signal", kind: "presenter-release", from: "local-me", peer: SELF });
        expect(screenTrack.stop).toHaveBeenCalled();
    });

    it("offers rotate/flip only while presenting, and resets them for the next share", async () => {
        await withParticipant({ media: fakeLocalMedia() });
        expect(screen.queryByRole("button", { name: "Rotate shared screen" })).toBeNull();

        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([fakeTrack("video", "screen")]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });

        const flip = screen.getByRole("button", { name: "Flip shared screen" });
        expect(flip).toHaveAttribute("aria-pressed", "false");
        // Neither throws, even though jsdom's canvas has no real 2D context to draw the correction with - the
        // processor falls back to sharing the raw capture, and these just become no-ops rather than errors.
        expect(() => fireEvent.click(screen.getByRole("button", { name: "Rotate shared screen" }))).not.toThrow();
        fireEvent.click(flip);
        expect(screen.getByRole("button", { name: "Unflip shared screen" })).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
        displayMediaMock.mockResolvedValueOnce({ ok: true, value: fakeMediaStream([fakeTrack("video", "screen")]) });
        fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
        await screen.findByRole("button", { name: "Stop sharing" });
        // The flip from the previous share doesn't carry over to this one.
        expect(screen.getByRole("button", { name: "Flip shared screen" })).toHaveAttribute("aria-pressed", "false");
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

describe("CallView - media paths", () => {
    it("does not create a relay unless the server offers one", async () => {
        await withParticipant();
        expect(relayMock.create).not.toHaveBeenCalled();
    });

    it("falls a participant WebRTC cannot connect to back to the server relay, and says so on their tile", async () => {
        relayMock.supported = true;
        relayMock.created.length = 0;
        await withParticipant({ relayEnabled: true });
        expect(relayMock.create).toHaveBeenCalledWith({ meetingUid: "meeting-1", peerId: SELF });
        const relay = relayMock.created[0];

        pcs()[0].connectionState = "failed";
        act(() => pcs()[0].onconnectionstatechange!());

        expect(await screen.findByTestId("transport-badge")).toHaveTextContent("Server relay");
        expect(relay.receiveFrom).toHaveBeenCalledWith("zzz", expect.any(Function));
        expect(relay.setSending).toHaveBeenLastCalledWith(true);
    });

    it("marks the participant as unreachable, rather than dropping them, in a browser that cannot run the relay", async () => {
        relayMock.supported = false;
        relayMock.created.length = 0;
        await withParticipant({ relayEnabled: true });

        pcs()[0].connectionState = "failed";
        act(() => pcs()[0].onconnectionstatechange!());

        expect(await screen.findByTestId("transport-badge")).toHaveTextContent("Can't connect");
        expect(screen.getAllByText("Zed").length).toBeGreaterThan(0);
        expect(relayMock.created[0].receiveFrom).not.toHaveBeenCalled();
        relayMock.supported = true;
    });
});

describe("CallView - connection status", () => {
    const connectPc = async (pc: FakeRTCPeerConnection) => {
        pc.connectionState = "connected";
        await act(async () => {
            pc.onconnectionstatechange!();
        });
    };

    it("says the local participant is connecting until the signaling channel opens", async () => {
        let open!: () => void;
        FakeSignalingClient.nextConnectResult = new Promise<void>((resolve) => (open = resolve));
        renderCallView();

        expect(screen.getByTestId("tile-status")).toHaveTextContent("Connecting…");

        await act(async () => open());
        await waitFor(() => expect(screen.queryByTestId("tile-status")).toBeNull());
    });

    it("stops saying it is connecting when signaling fails, and shows why instead", async () => {
        FakeSignalingClient.nextConnectResult = Promise.reject(new Error("Not permitted"));
        renderCallView();

        expect(await screen.findByRole("alert")).toHaveTextContent("Not permitted");
        expect(screen.queryByTestId("tile-status")).toBeNull();
    });

    it("shows an awaiting-connection line on a participant still connecting, and Connecting on its own tile until one is up", async () => {
        await withParticipant();

        const statuses = screen.getAllByTestId("tile-status").map((el) => el.textContent);
        expect(statuses).toContain("Awaiting connection…");
        expect(statuses).toContain("Connecting…");

        await connectPc(pcs()[0]);
        await waitFor(() => expect(screen.queryByTestId("tile-status")).toBeNull());
    });

    it("does not tell a participant who is already connected to someone that they are connecting", async () => {
        const { client } = await withParticipant();
        client.emit(hello("yyy", "Yan"));
        await screen.findAllByText("Yan");
        expect(screen.getAllByTestId("tile-status").filter((el) => el.textContent === "Awaiting connection…")).toHaveLength(2);

        await connectPc(pcs()[0]);

        await waitFor(() => expect(screen.getAllByTestId("tile-status")).toHaveLength(1));
        expect(screen.getByTestId("tile-status")).toHaveTextContent("Awaiting connection…");
        expect(screen.queryByText("Connecting…")).toBeNull();
    });
});

describe("CallView - participants drawer", () => {
    it("opens the drawer from the participant chip, listing self and everyone else, and closes from its own button", async () => {
        await withParticipant();
        const chip = screen.getByRole("button", { name: "2 participants" });
        expect(chip).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("dialog", { name: "Participants" })).toBeNull();

        fireEvent.click(chip);
        expect(chip).toHaveAttribute("aria-expanded", "true");
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        expect(within(drawer).getByText("Alice (you)")).toBeInTheDocument();
        expect(within(drawer).getByText("Zed")).toBeInTheDocument();

        fireEvent.click(within(drawer).getByRole("button", { name: "Close participants" }));
        expect(screen.queryByRole("dialog", { name: "Participants" })).toBeNull();
    });

    it("closes the drawer again from the same chip, and on Escape - it is a docked sidebar, so there is no backdrop to click", async () => {
        await connected();
        const chip = screen.getByRole("button", { name: "1 participants" });

        fireEvent.click(chip);
        fireEvent.click(chip);
        expect(screen.queryByRole("dialog")).toBeNull();

        fireEvent.click(chip);
        fireEvent.keyDown(document, { key: "Enter" });
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows a muted microphone and a raised hand for self and for others in the drawer", async () => {
        await withParticipant({ media: fakeLocalMedia({ micOn: false }) }, "zzz", "Zed", { ...STATE, audioOn: false, handRaised: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        expect(within(drawer).getAllByLabelText("Muted")).toHaveLength(2);
        expect(within(drawer).getByLabelText("Hand raised")).toBeInTheDocument();
    });

    it("shows a participant's transport badge in the drawer", async () => {
        await withParticipant();
        pcs()[0].type = "turn";
        pcs()[0].connectionState = "connected";
        await act(async () => pcs()[0].onconnectionstatechange!());

        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(within(screen.getByRole("dialog", { name: "Participants" })).getByText("Relayed")).toBeInTheDocument();
    });

    it("marks a failed connection's badge distinctly from a merely relayed one", async () => {
        await withParticipant();
        pcs()[0].connectionState = "failed";
        await act(async () => pcs()[0].onconnectionstatechange!());

        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(within(screen.getByRole("dialog", { name: "Participants" })).getByText("Can't connect")).toHaveClass("bg-[#601410]");
    });

    it("tags the local participant's own row as host when their uid matches hostUid", async () => {
        await withParticipant({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const selfRow = within(screen.getByRole("dialog", { name: "Participants" })).getByText("Alice (you)").closest("li");
        expect(within(selfRow!).getByText("Host")).toBeInTheDocument();
    });

    it("tags a remote participant's row as host when their peer id names hostUid's account, and nobody else's", async () => {
        const { client } = await connected({ hostUid: "zzz" });
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", peer: "zzz~tab", name: "Zed", state: STATE });
        await screen.findAllByText("Zed");
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        expect(within(within(drawer).getByText("Zed").closest("li")!).getByText("Host")).toBeInTheDocument();
        expect(within(within(drawer).getByText("Alice (you)").closest("li")!).queryByText("Host")).toBeNull();
    });

    it("shows no host tag anywhere when hostUid could not be resolved", async () => {
        await withParticipant();
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(within(screen.getByRole("dialog", { name: "Participants" })).queryByText("Host")).toBeNull();
    });
});

describe("CallView - host moderation signals", () => {
    it("mutes the microphone on a received mute request", async () => {
        const media = fakeLocalMedia({ micOn: true });
        const { client } = await connected({ media });
        client.emit({ type: "video-meeting-signal", kind: "mute-request", from: "zzz", to: SELF });
        expect(media.toggleMic).toHaveBeenCalledTimes(1);
    });

    it("never unmutes via a mute request - it is already muted", async () => {
        const media = fakeLocalMedia({ micOn: false });
        const { client } = await connected({ media });
        client.emit({ type: "video-meeting-signal", kind: "mute-request", from: "zzz", to: SELF });
        expect(media.toggleMic).not.toHaveBeenCalled();
    });

    it("ignores a mute request addressed to a different tab", async () => {
        const media = fakeLocalMedia({ micOn: true });
        const { client } = await connected({ media });
        client.emit({ type: "video-meeting-signal", kind: "mute-request", from: "zzz", to: "someone-else" });
        expect(media.toggleMic).not.toHaveBeenCalled();
    });

    it("leaves with a distinct reason when kicked", async () => {
        const { client, onLeave } = await connected();
        client.emit({ type: "video-meeting-signal", kind: "kicked", from: "zzz", to: SELF });
        expect(onLeave).toHaveBeenCalledWith("The host removed you from this call.");
    });

    it("ignores a kick addressed to a different tab", async () => {
        const { client, onLeave } = await connected();
        client.emit({ type: "video-meeting-signal", kind: "kicked", from: "zzz", to: "someone-else" });
        expect(onLeave).not.toHaveBeenCalled();
    });
});

describe("accountUidOf", () => {
    it("strips the tab-scoped suffix off a peer id", () => {
        expect(accountUidOf("user-1~abc-123")).toBe("user-1");
        expect(accountUidOf("guest:xyz~abc-123")).toBe("guest:xyz");
    });

    it("returns the uid unchanged when it carries no suffix at all", () => {
        expect(accountUidOf("user-1")).toBe("user-1");
    });
});

describe("CallView - host mute/kick controls", () => {
    async function withHostAndParticipant() {
        const view = await connected({ selfUid: "local-me", hostUid: "local-me" });
        view.client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", peer: "zzz~tab", name: "Zed", state: STATE });
        await screen.findAllByText("Zed");
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        return view;
    }

    it("sends a mute request to the participant's own tab, and hides the button once they're already muted", async () => {
        const { client } = await withHostAndParticipant();
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        const row = within(drawer).getByText("Zed").closest("li")!;
        fireEvent.click(within(row).getByRole("button", { name: "Mute Zed" }));
        expect(client.sent).toContainEqual(expect.objectContaining({ kind: "mute-request", to: "zzz~tab" }));

        client.emit({ type: "video-meeting-signal", kind: "state", from: "zzz", peer: "zzz~tab", state: { ...STATE, audioOn: false } });
        expect(within(row).queryByRole("button", { name: "Mute Zed" })).toBeNull();
    });

    it("removes a participant after confirming, sending the kicked signal and calling the kick endpoint with their real account uid", async () => {
        const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
        const { client } = await withHostAndParticipant();
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        const row = within(drawer).getByText("Zed").closest("li")!;

        fireEvent.click(within(row).getByRole("button", { name: "Remove Zed" }));

        expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Zed"));
        expect(client.sent).toContainEqual(expect.objectContaining({ kind: "kicked", to: "zzz~tab" }));
        expect(kickParticipantMock).toHaveBeenCalledWith("meeting-1", "zzz");
        confirmSpy.mockRestore();
    });

    it("swallows a failed kick-endpoint call rather than surfacing it - the cooperative signal was already sent", async () => {
        const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
        kickParticipantMock.mockRejectedValueOnce(new Error("network error"));
        await withHostAndParticipant();
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        const row = within(drawer).getByText("Zed").closest("li")!;

        fireEvent.click(within(row).getByRole("button", { name: "Remove Zed" }));
        await waitFor(() => expect(kickParticipantMock).toHaveBeenCalled());

        expect(screen.getByRole("dialog", { name: "Participants" })).toBeInTheDocument();
        confirmSpy.mockRestore();
    });

    it("does nothing when the removal confirmation is declined", async () => {
        const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
        const { client } = await withHostAndParticipant();
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        const row = within(drawer).getByText("Zed").closest("li")!;

        fireEvent.click(within(row).getByRole("button", { name: "Remove Zed" }));

        expect(client.sent).not.toContainEqual(expect.objectContaining({ kind: "kicked" }));
        expect(kickParticipantMock).not.toHaveBeenCalled();
        confirmSpy.mockRestore();
    });

    it("shows no moderation buttons to a non-host, and none on the host's own row", async () => {
        await withParticipant();
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        expect(within(drawer).queryByRole("button", { name: /^Mute / })).toBeNull();
        expect(within(drawer).queryByRole("button", { name: /^Remove / })).toBeNull();
    });
});

describe("CallView - talking stick mode", () => {
    async function withHostAndParticipant(overrides: Partial<React.ComponentProps<typeof CallView>> = {}) {
        const view = await connected({ selfUid: "local-me", hostUid: "local-me", ...overrides });
        view.client.emit({ type: "video-meeting-signal", kind: "hello", from: "zzz", peer: "zzz~tab", name: "Zed", state: STATE });
        await screen.findAllByText("Zed");
        return view;
    }

    it("shows the toggle only to the host", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        expect(screen.getByRole("button", { name: "Talking stick" })).toBeInTheDocument();
    });

    it("hides the toggle from a non-host", async () => {
        await connected({ selfUid: "local-me", hostUid: "someone-else" });
        expect(screen.queryByRole("button", { name: "Talking stick" })).toBeNull();
    });

    it("starts the mode, making the host the initial holder and unmuting if currently muted", async () => {
        const media = fakeLocalMedia({ micOn: false });
        const { client } = await connected({ selfUid: "local-me", hostUid: "local-me", media });
        fireEvent.click(screen.getByRole("button", { name: "Talking stick" }));

        expect(client.sent).toContainEqual(expect.objectContaining({ kind: "talking-stick", active: true, holder: SELF }));
        expect(media.toggleMic).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "End talking stick" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByTestId("talking-stick-status")).toHaveTextContent("You have the floor");
    });

    it("ends the mode without touching anyone's mic state", async () => {
        const media = fakeLocalMedia({ micOn: true });
        const { client } = await connected({ selfUid: "local-me", hostUid: "local-me", media });
        fireEvent.click(screen.getByRole("button", { name: "Talking stick" }));
        fireEvent.click(screen.getByRole("button", { name: "End talking stick" }));

        expect(client.sent).toContainEqual(expect.objectContaining({ kind: "talking-stick", active: false, holder: undefined }));
        expect(screen.getByRole("button", { name: "Talking stick" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.queryByTestId("talking-stick-status")).toBeNull();
        expect(media.toggleMic).not.toHaveBeenCalled();
    });

    it("force-mutes and locks a non-holder's microphone, and names the holder in the status chip", async () => {
        const media = fakeLocalMedia({ micOn: true });
        const { client } = await connected({ selfUid: "local-me", hostUid: "other-host", media });
        client.emit({ type: "video-meeting-signal", kind: "hello", from: "other-host", peer: "other-host~tab", name: "Hank", state: STATE });
        await screen.findAllByText("Hank");

        client.emit({ type: "video-meeting-signal", kind: "talking-stick", from: "other-host", peer: "other-host~tab", active: true, holder: "other-host~tab" });

        expect(media.toggleMic).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "Mute microphone" })).toBeDisabled();
        expect(screen.getByTestId("talking-stick-status")).toHaveTextContent("Hank has the floor");
    });

    it("says nobody has the floor yet when the mode is on with no holder assigned", async () => {
        const { client } = await connected({ selfUid: "local-me", hostUid: "other-host" });
        client.emit({ type: "video-meeting-signal", kind: "talking-stick", from: "other-host", active: true });
        expect(screen.getByTestId("talking-stick-status")).toHaveTextContent("Waiting for the host to choose a speaker");
    });

    it("re-enables and unlocks the microphone once the mode is turned off", async () => {
        const media = fakeLocalMedia({ micOn: true });
        const { client } = await connected({ selfUid: "local-me", hostUid: "other-host", media });
        client.emit({ type: "video-meeting-signal", kind: "talking-stick", from: "other-host", active: true, holder: "other-host~tab" });
        expect(screen.getByRole("button", { name: "Mute microphone" })).toBeDisabled();

        client.emit({ type: "video-meeting-signal", kind: "talking-stick", from: "other-host", active: false });
        expect(screen.getByRole("button", { name: "Mute microphone" })).toBeEnabled();
    });

    it("gives the stick to a participant from the drawer, showing their badge and the host's own button to reclaim it", async () => {
        const view = await withHostAndParticipant();
        fireEvent.click(screen.getByRole("button", { name: "Talking stick" }));
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        const zedRow = within(drawer).getByText("Zed").closest("li")!;

        fireEvent.click(within(zedRow).getByRole("button", { name: "Give the talking stick to Zed" }));
        expect(view.client.sent).toContainEqual(expect.objectContaining({ kind: "talking-stick", active: true, holder: "zzz~tab" }));

        // Giving it away makes the host a non-holder: their own mic gets force-muted and locked.
        expect(view.props.media.toggleMic).toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Mute microphone" })).toBeDisabled();

        // Zed's row now shows the badge and no longer offers to give it to themselves; the host's own row does, so
        // the host can take it back.
        expect(within(zedRow).getByLabelText("Holding the talking stick")).toBeInTheDocument();
        expect(within(zedRow).queryByRole("button", { name: "Give the talking stick to Zed" })).toBeNull();
        const selfRow = within(drawer).getByText("Alice (you)").closest("li")!;
        expect(within(selfRow).getByRole("button", { name: "Give the talking stick to Alice" })).toBeInTheDocument();
    });

    it("lets the host take the stick back via their own row", async () => {
        const view = await withHostAndParticipant();
        fireEvent.click(screen.getByRole("button", { name: "Talking stick" }));
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        fireEvent.click(within(within(drawer).getByText("Zed").closest("li")!).getByRole("button", { name: "Give the talking stick to Zed" }));

        const selfRow = within(drawer).getByText("Alice (you)").closest("li")!;
        fireEvent.click(within(selfRow).getByRole("button", { name: "Give the talking stick to Alice" }));

        expect(view.client.sent).toContainEqual(expect.objectContaining({ kind: "talking-stick", active: true, holder: SELF }));
        expect(within(selfRow).getByLabelText("Holding the talking stick")).toBeInTheDocument();
    });

    it("hides the Give stick buttons from a non-host, even while the mode is on", async () => {
        const { client } = await withParticipant({ selfUid: "local-me", hostUid: "other-host" });
        client.emit({ type: "video-meeting-signal", kind: "talking-stick", from: "other-host", active: true, holder: "other-host~tab" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const drawer = screen.getByRole("dialog", { name: "Participants" });
        expect(within(drawer).queryByRole("button", { name: /^Give the talking stick/ })).toBeNull();
    });
});

describe("CallView - force-mute-on-join toggle", () => {
    it("shows the checkbox only to the host, reflecting the initial setting", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me", initialForceMuteOnJoin: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.getByRole("checkbox", { name: "Mute new participants on join" })).toBeChecked();
    });

    it("hides the checkbox from a non-host", async () => {
        await connected();
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.queryByRole("checkbox", { name: "Mute new participants on join" })).toBeNull();
    });

    it("toggles optimistically and persists the new value", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const checkbox = screen.getByRole("checkbox", { name: "Mute new participants on join" });
        expect(checkbox).not.toBeChecked();

        fireEvent.click(checkbox);
        expect(checkbox).toBeChecked();
        expect(setForceMuteOnJoinMock).toHaveBeenCalledWith("meeting-1", true);

        fireEvent.click(checkbox);
        expect(checkbox).not.toBeChecked();
        expect(setForceMuteOnJoinMock).toHaveBeenCalledWith("meeting-1", false);
    });

    it("reverts the checkbox when persisting the change fails", async () => {
        setForceMuteOnJoinMock.mockRejectedValueOnce(new Error("network error"));
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const checkbox = screen.getByRole("checkbox", { name: "Mute new participants on join" });

        fireEvent.click(checkbox);
        expect(checkbox).toBeChecked();
        await waitFor(() => expect(checkbox).not.toBeChecked());
    });
});

describe("CallView - host password section", () => {
    it("shows the password section only to the host, reflecting whether one is already set", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me", initialHasPassword: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.getByText("Password protection is on.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Remove password" })).toBeInTheDocument();
    });

    it("hides the password section from a non-host", async () => {
        await connected();
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.queryByText(/password/i)).toBeNull();
    });

    it("says no password is required when none is set, with no remove button", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.getByText("No password required to join.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Remove password" })).toBeNull();
    });

    it("sets a password, clears the input, and updates the status once saved", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const input = screen.getByLabelText("Set a password");
        fireEvent.change(input, { target: { value: "s3cret" } });
        fireEvent.click(screen.getByRole("button", { name: "Set" }));

        await waitFor(() => expect(setMeetingPasswordMock).toHaveBeenCalledWith("meeting-1", "s3cret"));
        expect(await screen.findByText("Password protection is on.")).toBeInTheDocument();
        expect(screen.getByLabelText("New password")).toHaveValue("");
    });

    it("removes the password and reverts the status once saved", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me", initialHasPassword: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));

        fireEvent.click(screen.getByRole("button", { name: "Remove password" }));

        await waitFor(() => expect(setMeetingPasswordMock).toHaveBeenCalledWith("meeting-1", null));
        expect(await screen.findByText("No password required to join.")).toBeInTheDocument();
    });

    it("does nothing if the form is submitted with an empty password", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        fireEvent.submit(screen.getByLabelText("Set a password").closest("form")!);
        expect(setMeetingPasswordMock).not.toHaveBeenCalled();
    });

    it("shows an inline error and keeps the previous status when saving fails", async () => {
        setMeetingPasswordMock.mockRejectedValueOnce(new Error("network error"));
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        fireEvent.change(screen.getByLabelText("Set a password"), { target: { value: "s3cret" } });
        fireEvent.click(screen.getByRole("button", { name: "Set" }));

        expect(await screen.findByText("Could not save - try again.")).toBeInTheDocument();
        expect(screen.getByText("No password required to join.")).toBeInTheDocument();
    });
});

describe("CallView - host waiting room", () => {
    it("shows the checkbox only to the host, reflecting the initial setting", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.getByRole("checkbox", { name: "Require the host to admit participants" })).toBeChecked();
    });

    it("hides the checkbox from a non-host", async () => {
        await connected();
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.queryByRole("checkbox", { name: "Require the host to admit participants" })).toBeNull();
    });

    it("toggles optimistically and persists the new value", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const checkbox = screen.getByRole("checkbox", { name: "Require the host to admit participants" });
        expect(checkbox).not.toBeChecked();

        fireEvent.click(checkbox);
        expect(checkbox).toBeChecked();
        expect(setWaitingRoomEnabledMock).toHaveBeenCalledWith("meeting-1", true);
    });

    it("reverts the checkbox when persisting the change fails", async () => {
        setWaitingRoomEnabledMock.mockRejectedValueOnce(new Error("network error"));
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        const checkbox = screen.getByRole("checkbox", { name: "Require the host to admit participants" });

        fireEvent.click(checkbox);
        expect(checkbox).toBeChecked();
        await waitFor(() => expect(checkbox).not.toBeChecked());
    });

    it("does not show the waiting list when the waiting room is off", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me" });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.queryByText("Waiting to join")).toBeNull();
    });

    it("hides the waiting list from a non-host even if somehow enabled", async () => {
        await connected({ initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.queryByText("Waiting to join")).toBeNull();
    });

    it("says nobody is waiting when the list is empty", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(await screen.findByText("Nobody is waiting right now.")).toBeInTheDocument();
    });

    it("lists pending requests and lets the host admit one", async () => {
        listWaitingParticipantsMock.mockResolvedValue([{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));

        expect(await screen.findByText("Grace")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Admit Grace" }));

        expect(admitParticipantMock).toHaveBeenCalledWith("meeting-1", "guest:abc");
        await waitFor(() => expect(screen.queryByText("Grace")).toBeNull());
    });

    it("lets the host deny a pending request", async () => {
        listWaitingParticipantsMock.mockResolvedValue([{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));

        expect(await screen.findByText("Grace")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Deny Grace" }));

        expect(denyParticipantMock).toHaveBeenCalledWith("meeting-1", "guest:abc");
        await waitFor(() => expect(screen.queryByText("Grace")).toBeNull());
    });

    it("re-fetches the waiting list from the server when admitting fails", async () => {
        listWaitingParticipantsMock.mockResolvedValue([{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        admitParticipantMock.mockRejectedValueOnce(new Error("network error"));
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));

        expect(await screen.findByText("Grace")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Admit Grace" }));

        // Removed optimistically, then put back once the re-fetch (listWaitingParticipants is still mocked to
        // return Grace) completes.
        await waitFor(() => expect(screen.getByText("Grace")).toBeInTheDocument());
    });

    it("tolerates a failed poll without crashing", async () => {
        listWaitingParticipantsMock.mockRejectedValueOnce(new Error("network error"));
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(await screen.findByText("Nobody is waiting right now.")).toBeInTheDocument();
    });

    it("re-fetches the waiting list from the server when denying fails", async () => {
        listWaitingParticipantsMock.mockResolvedValue([{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        denyParticipantMock.mockRejectedValueOnce(new Error("network error"));
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));

        expect(await screen.findByText("Grace")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Deny Grace" }));

        await waitFor(() => expect(screen.getByText("Grace")).toBeInTheDocument());
    });

    it("gives up quietly if the re-fetch after a failed admit also fails", async () => {
        listWaitingParticipantsMock.mockResolvedValueOnce([{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        admitParticipantMock.mockRejectedValueOnce(new Error("network error"));
        listWaitingParticipantsMock.mockRejectedValueOnce(new Error("network error"));
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));

        expect(await screen.findByText("Grace")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Admit Grace" }));

        // No crash is the whole point here - the optimistic removal simply stands uncorrected.
        await waitFor(() => expect(screen.queryByText("Grace")).toBeNull());
    });

    it("gives up quietly if the re-fetch after a failed deny also fails", async () => {
        listWaitingParticipantsMock.mockResolvedValueOnce([{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        denyParticipantMock.mockRejectedValueOnce(new Error("network error"));
        listWaitingParticipantsMock.mockRejectedValueOnce(new Error("network error"));
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));

        expect(await screen.findByText("Grace")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Deny Grace" }));

        await waitFor(() => expect(screen.queryByText("Grace")).toBeNull());
    });

    it("ignores a poll that resolves after the drawer was already closed", async () => {
        let resolveList!: (value: unknown) => void;
        listWaitingParticipantsMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveList = resolve;
                }),
        );
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));

        fireEvent.click(screen.getByRole("button", { name: "Close participants" }));
        resolveList([{ uid: "guest:abc", name: "Grace", requestedAt: "2026-01-01T00:00:00.000Z" }]);
        await act(() => Promise.resolve());

        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        expect(screen.queryByText("Grace")).toBeNull();
    });

    it("stops polling once the drawer is closed", async () => {
        await connected({ selfUid: "local-me", hostUid: "local-me", initialWaitingRoomEnabled: true });
        fireEvent.click(screen.getByRole("button", { name: /participants/ }));
        await waitFor(() => expect(listWaitingParticipantsMock).toHaveBeenCalled());
        const callsSoFar = listWaitingParticipantsMock.mock.calls.length;

        fireEvent.click(screen.getByRole("button", { name: "Close participants" }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(listWaitingParticipantsMock.mock.calls.length).toBe(callsSoFar);
    });
});
