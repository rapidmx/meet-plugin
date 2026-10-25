///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type CollabChannel,
    type CollabEvent,
    CollabSession,
    CURSOR_IDLE_MS,
    CURSOR_INTERVAL_MS,
    POINT_FLUSH_MS,
    SYNC_ANSWER_COOLDOWN_MS,
    SYNC_ENVELOPE_BYTES,
    SYNC_PACE_MS,
    SYNC_POINTS_PER_OP,
    SYNC_TIMEOUT_MS,
    SYNC_WINDOW_MS,
} from "../../../../apps/shared/collab/CollabSession.js";
import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    MAX_BOARD_ELEMENTS,
    MAX_CHAT_HISTORY,
    MAX_CHAT_LENGTH,
    MAX_POINTS_PER_OP,
    MAX_STROKE_POINTS,
    type BoardElement,
    type SyncPayload,
    type WhiteboardOp,
} from "../../../../apps/shared/collab/protocol.js";
import type { SignalMessage } from "../../../../apps/shared/webrtc/types.js";

const START = 1_700_000_000_000;

/** One message as it went over the fake wire. */
interface Wired {
    message: SignalMessage;
    /** The (fake) clock when it was sent. */
    at: number;
    /** Its JSON size, as the server would measure it. */
    bytes: number;
}

/**
 * An in-memory signaling server behaving like the real one: it stamps `from`/`peer` from the sending socket (whatever
 * the sender put there), never delivers a message back to its sender, delivers one with `to` only to that peer, and
 * hands each recipient its own copy, as JSON over a socket would. `wire` records every message sent.
 */
function network(maxMessageBytes?: number, maxPlainMessageBytes?: number) {
    const sockets = new Map<string, Set<(message: SignalMessage) => void>>();
    const wire: Wired[] = [];
    const deliver = (peer: string, message: SignalMessage) => {
        for (const handler of [...(sockets.get(peer) ?? [])]) {
            handler(JSON.parse(JSON.stringify(message)) as SignalMessage);
        }
    };
    return {
        wire,
        /** A socket authenticated as `uid`, announced as `peer`. */
        channel(uid: string, peer: string): CollabChannel {
            const handlers = new Set<(message: SignalMessage) => void>();
            sockets.set(peer, handlers);
            return {
                maxMessageBytes,
                maxPlainMessageBytes,
                send(message) {
                    const stamped: SignalMessage = { ...message, from: uid, peer };
                    const json = JSON.stringify(stamped);
                    wire.push({ message: JSON.parse(json) as SignalMessage, at: Date.now(), bytes: new TextEncoder().encode(json).length });
                    for (const target of sockets.keys()) {
                        if (target !== peer && (stamped.to === undefined || stamped.to === target)) {
                            deliver(target, stamped);
                        }
                    }
                },
                onMessage(handler) {
                    handlers.add(handler);
                    return () => handlers.delete(handler);
                },
            };
        },
        /** Hands `message` to `peer`'s socket as is, bypassing the server's stamping and filtering. */
        inject: deliver,
        listenerCount: (peer: string) => sockets.get(peer)?.size ?? 0,
        /** Everything `peer` sent, optionally only of `kind`. */
        sentBy: (peer: string, kind?: SignalMessage["kind"]) => wire.filter((w) => w.message.peer === peer && (!kind || w.message.kind === kind)).map((w) => w.message),
    };
}

type Network = ReturnType<typeof network>;

/** A participant: a started session on its own socket, recording every event it emits. */
function join(net: Network, name: string, options: { peer?: string; now?: () => number; start?: boolean } = {}) {
    const uid = name.toLowerCase();
    const peer = options.peer ?? `${uid}~1`;
    const channel = net.channel(uid, peer);
    const session = new CollabSession({ channel, selfUid: uid, peerId: peer, selfName: name, now: options.now });
    const events: CollabEvent[] = [];
    session.onEvent((event) => events.push(event));
    if (options.start !== false) {
        session.start();
    }
    return {
        session,
        channel,
        peer,
        events,
        /** What the mesh broadcasts on joining (and in answer to someone else's): this participant's `hello`. */
        hello: (announced: string | null = name) => channel.send({ type: "video-meeting-signal", kind: "hello", from: uid, ...(announced === null ? {} : { name: announced }) }),
        boardEvents: () => events.filter((e) => e.type === "board").length,
        chatEvents: () => events.filter((e): e is Extract<CollabEvent, { type: "chat" }> => e.type === "chat").map((e) => e.entry),
    };
}

type Participant = ReturnType<typeof join>;

/** Participants already in a call: started, past the catch-up window, and having heard each other's `hello`. */
function room(net: Network, ...names: string[]): Participant[] {
    const people = names.map((name) => join(net, name));
    vi.advanceTimersByTime(SYNC_WINDOW_MS);
    for (const person of people) {
        person.hello();
    }
    for (const person of people) {
        person.events.length = 0;
    }
    return people;
}

/** The last item of `items`. */
const last = <T,>(items: readonly T[]): T => items[items.length - 1];
const signal = (kind: SignalMessage["kind"], from: string, rest: Partial<SignalMessage> = {}): SignalMessage => ({ type: "video-meeting-signal", kind, from, peer: from, ...rest });
const ops = (net: Network, peer: string) => net.sentBy(peer, "whiteboard").map((m) => m.whiteboard as WhiteboardOp);
const syncParts = (net: Network, to: string) =>
    net.wire.filter((w) => w.message.kind === "collab-sync" && w.message.to === to).map((w) => ({ ...w, sync: w.message.sync as SyncPayload }));

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("CollabSession - chat", () => {
    it("broadcasts a message, shows it at once as its own, and shows it to the others under the name from its sender's hello", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        expect(alice.session.sendChat("hi **there**")).toBe(true);
        const sent = net.sentBy(alice.peer, "chat");
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ from: "alice", peer: alice.peer, chat: { text: "hi **there**", sentAt: Date.now() } });
        expect(sent[0].to).toBeUndefined();
        const id = (sent[0].chat as { id: string }).id;

        expect(alice.session.chat).toEqual([{ key: `${alice.peer}:${id}`, id, peer: alice.peer, name: "Alice", text: "hi **there**", sentAt: Date.now(), self: true }]);
        expect(alice.chatEvents()).toEqual(alice.session.chat);
        expect(bob.session.chat).toEqual([{ key: `${alice.peer}:${id}`, id, peer: alice.peer, name: "Alice", text: "hi **there**", sentAt: Date.now(), self: false }]);
        expect(bob.chatEvents()).toEqual(bob.session.chat);
    });

    it("gives every message its own id, from the clock and a sequence number", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        alice.session.sendChat("one");
        alice.session.sendChat("two");
        const [a, b] = alice.session.chat;
        expect(a.id).not.toBe(b.id);
        expect(a.id).toBe(`${Date.now().toString(36)}-1`);
        expect(b.id).toBe(`${Date.now().toString(36)}-2`);
    });

    it("uses the injected clock when given one", () => {
        const net = network();
        const alice = join(net, "Alice", { now: () => 42 });
        alice.session.sendChat("hello");
        expect(alice.session.chat[0]).toMatchObject({ id: `${(42).toString(36)}-1`, sentAt: 42 });
    });

    it("names a sender who never said hello, or announced no name, 'Guest'", () => {
        const net = network();
        const [alice, bob, carol] = room(net, "Alice", "Bob", "Carol");
        const dave = join(net, "Dave");
        dave.session.sendChat("no hello at all");
        dave.hello(null);
        dave.session.sendChat("hello without a name");
        dave.hello("");
        dave.session.sendChat("hello with an empty name");
        for (const person of [alice, bob, carol]) {
            expect(person.session.chat.map((e) => e.name)).toEqual(["Guest", "Guest", "Guest"]);
        }
    });

    it("uses the latest name a sender announced, from then on", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        bob.session.sendChat("before");
        bob.hello("Robert");
        bob.session.sendChat("after");
        expect(alice.session.chat.map((e) => e.name)).toEqual(["Bob", "Robert"]);
    });

    it("identifies a sender by 'from' when the message names no peer", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        net.inject(alice.peer, { type: "video-meeting-signal", kind: "hello", from: "zed", name: "Zed" });
        net.inject(alice.peer, { type: "video-meeting-signal", kind: "chat", from: "zed", chat: { id: "m1", text: "yo", sentAt: 5 } });
        expect(alice.session.chat).toEqual([{ key: "zed:m1", id: "m1", peer: "zed", name: "Zed", text: "yo", sentAt: 5, self: false }]);
    });

    it.each([
        ["empty", ""],
        ["blank", "  \n\t "],
        ["overlong", "x".repeat(MAX_CHAT_LENGTH + 1)],
    ])("refuses %s text, sending and showing nothing", (_label, text) => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        expect(alice.session.sendChat(text)).toBe(false);
        expect(net.sentBy(alice.peer)).toHaveLength(1); // only its hello
        expect(alice.session.chat).toEqual([]);
        expect(alice.events).toEqual([]);
        expect(bob.session.chat).toEqual([]);
    });

    it("accepts text exactly MAX_CHAT_LENGTH long", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        expect(alice.session.sendChat("y".repeat(MAX_CHAT_LENGTH))).toBe(true);
        expect(bob.session.chat[0].text).toHaveLength(MAX_CHAT_LENGTH);
    });

    it.each([
        ["no payload", undefined],
        ["a non-object payload", "hello"],
        ["an empty id", { id: "", text: "x", sentAt: 1 }],
        ["a non-string text", { id: "m", text: 5, sentAt: 1 }],
        ["blank text", { id: "m", text: "   ", sentAt: 1 }],
        ["overlong text", { id: "m", text: "x".repeat(MAX_CHAT_LENGTH + 1), sentAt: 1 }],
        ["a non-finite sentAt", { id: "m", text: "x", sentAt: Infinity }],
    ])("drops a received chat message with %s", (_label, chat) => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        bob.channel.send(signal("chat", "bob", { chat }));
        expect(alice.session.chat).toEqual([]);
        expect(alice.events).toEqual([]);
    });

    it("shows a message received twice once", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const chat = { id: "same", text: "again?", sentAt: 1 };
        bob.channel.send(signal("chat", "bob", { chat }));
        bob.channel.send(signal("chat", "bob", { chat }));
        expect(alice.session.chat).toHaveLength(1);
        expect(alice.chatEvents()).toHaveLength(1);
    });

    it("keeps only the latest MAX_CHAT_HISTORY messages, on both ends", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        for (let i = 0; i < MAX_CHAT_HISTORY + 5; i++) {
            alice.session.sendChat(`message ${i}`);
        }
        for (const person of [alice, bob]) {
            expect(person.session.chat).toHaveLength(MAX_CHAT_HISTORY);
            expect(person.session.chat[0].text).toBe("message 5");
            expect(person.session.chat[MAX_CHAT_HISTORY - 1].text).toBe(`message ${MAX_CHAT_HISTORY + 4}`);
        }
    });
});

describe("CollabSession - drawing", () => {
    it("starts a stroke: an id under its own peer, added locally at once and broadcast with its first, rounded point", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("marker", "#ff0000", 8, 10.4, 20.6)!;
        expect(id.startsWith(`${alice.peer}:`)).toBe(true);
        const element: BoardElement = { kind: "stroke", id, epoch: 0, pen: "marker", color: "#ff0000", size: 8, points: [10, 21] };
        expect(alice.session.board.elements).toEqual([element]);
        expect(ops(net, alice.peer)).toEqual([{ op: "add", element }]);
        expect(alice.boardEvents()).toBe(1);
        expect(bob.session.board.elements).toEqual([element]);
        expect(bob.boardEvents()).toBe(1);
    });

    it("sends a stroke's points in batches every POINT_FLUSH_MS, showing them locally at once", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("ballpoint", "#000000", 2, 0, 0)!;
        alice.session.extendStroke(id, 1.2, 1.7);
        alice.session.extendStroke(id, 2, 2);
        alice.session.extendStroke(id, 3, 3);
        expect(alice.session.board.get(id)).toMatchObject({ points: [0, 0, 1, 2, 2, 2, 3, 3] });
        expect(alice.boardEvents()).toBe(4);
        expect(ops(net, alice.peer)).toHaveLength(1);
        expect(bob.session.board.get(id)).toMatchObject({ points: [0, 0] });

        vi.advanceTimersByTime(POINT_FLUSH_MS - 1);
        expect(ops(net, alice.peer)).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(ops(net, alice.peer)).toEqual([expect.objectContaining({ op: "add" }), { op: "points", id, start: 1, points: [1, 2, 2, 2, 3, 3] }]);
        expect(bob.session.board.get(id)).toMatchObject({ points: [0, 0, 1, 2, 2, 2, 3, 3] });

        // The next batch starts where this one ended.
        alice.session.extendStroke(id, 4, 4);
        vi.advanceTimersByTime(POINT_FLUSH_MS);
        expect(ops(net, alice.peer)[2]).toEqual({ op: "points", id, start: 4, points: [4, 4] });
        expect(bob.session.board.get(id)).toEqual(alice.session.board.get(id));
    });

    it("batches two strokes being drawn at once separately", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const one = alice.session.beginStroke("pencil", "#000000", 2, 0, 0)!;
        // Starting a second element ends the first, but its id can still be extended.
        const two = alice.session.beginStroke("pencil", "#000000", 2, 100, 100)!;
        alice.session.extendStroke(one, 1, 1);
        alice.session.extendStroke(two, 101, 101);
        vi.advanceTimersByTime(POINT_FLUSH_MS);
        expect(ops(net, alice.peer).slice(2)).toEqual([
            { op: "points", id: one, start: 1, points: [1, 1] },
            { op: "points", id: two, start: 1, points: [101, 101] },
        ]);
        expect(bob.session.board.elements).toEqual(alice.session.board.elements);
    });

    it("sends whatever points are still waiting when the stroke ends, and nothing more when the timer would have fired", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("crayon", "#00ff00", 14, 5, 5)!;
        alice.session.extendStroke(id, 6, 6);
        alice.session.endStroke();
        expect(ops(net, alice.peer)[1]).toEqual({ op: "points", id, start: 1, points: [6, 6] });
        vi.advanceTimersByTime(POINT_FLUSH_MS * 3);
        expect(ops(net, alice.peer)).toHaveLength(2);
        expect(bob.session.board.get(id)).toEqual(alice.session.board.get(id));
        // Ending again with nothing waiting sends nothing.
        alice.session.endStroke();
        expect(ops(net, alice.peer)).toHaveLength(2);
    });

    it("sends the waiting points of a stroke before the next element it starts", () => {
        const net = network();
        const [alice] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("sharpie", "#0000ff", 4, 0, 0)!;
        alice.session.extendStroke(id, 9, 9);
        alice.session.addStamp("⭐", 32, 50, 50);
        expect(ops(net, alice.peer).map((op) => op.op)).toEqual(["add", "points", "add"]);
    });

    it("ignores extending an unknown element, a shape, a full stroke, or someone else's stroke", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const shape = alice.session.addShape("rect", "#123456", 4, 0, 0, 10, 10)!;
        alice.session.extendStroke("alice~1:nope", 1, 1);
        alice.session.extendStroke(shape, 1, 1);

        const theirs = bob.session.beginStroke("marker", "#ff00ff", 8, 0, 0)!;
        alice.session.extendStroke(theirs, 1, 1);
        expect(alice.session.board.get(theirs)).toMatchObject({ points: [0, 0] });

        const full = alice.session.beginStroke("marker", "#ff00ff", 8, 0, 0)!;
        for (let i = 1; i < MAX_STROKE_POINTS; i++) {
            alice.session.extendStroke(full, i % 1600, i % 900);
            if (i % 100 === 0) {
                vi.advanceTimersByTime(POINT_FLUSH_MS);
            }
        }
        alice.session.endStroke();
        const sentBefore = ops(net, alice.peer).length;
        const eventsBefore = alice.boardEvents();
        alice.session.extendStroke(full, 1, 1);
        vi.advanceTimersByTime(POINT_FLUSH_MS);
        expect((alice.session.board.get(full) as Extract<BoardElement, { kind: "stroke" }>).points).toHaveLength(MAX_STROKE_POINTS * 2);
        expect(ops(net, alice.peer)).toHaveLength(sentBefore);
        expect(alice.boardEvents()).toBe(eventsBefore);
        // None of the refused extensions reached anyone.
        expect(ops(net, alice.peer).filter((op) => op.op === "points" && op.id !== full)).toEqual([]);
        expect(bob.session.board.get(full)).toEqual(alice.session.board.get(full));
    });

    it("adds shapes and stamps with rounded coordinates", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const shape = alice.session.addShape("arrow", "#abcdef", 14, 1.4, 2.5, 3.6, 4.49)!;
        const stamp = alice.session.addStamp("🎉", 96, 7.7, 8.2)!;
        expect(alice.session.board.elements).toEqual([
            { kind: "shape", id: shape, epoch: 0, shape: "arrow", color: "#abcdef", size: 14, x1: 1, y1: 3, x2: 4, y2: 4 },
            { kind: "stamp", id: stamp, epoch: 0, stamp: "🎉", size: 96, x: 8, y: 8 },
        ]);
        expect(bob.session.board.elements).toEqual(alice.session.board.elements);
        expect(bob.boardEvents()).toBe(2);
    });

    it("erases anyone's elements, naming only those present", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const mine = alice.session.addStamp("👍", 32, 1, 1)!;
        const theirs = bob.session.addStamp("👎", 32, 2, 2)!;
        const kept = bob.session.addStamp("❓", 32, 3, 3)!;
        alice.session.erase([mine, "ghost:1", theirs]);
        expect(last(ops(net, alice.peer))).toEqual({ op: "remove", ids: [mine, theirs] });
        expect(alice.session.board.elements.map((e) => e.id)).toEqual([kept]);
        expect(bob.session.board.elements.map((e) => e.id)).toEqual([kept]);
    });

    it("sends nothing when erasing only elements that aren't there", () => {
        const net = network();
        const [alice] = room(net, "Alice", "Bob");
        alice.session.erase(["ghost:1", "ghost:2"]);
        alice.session.erase([]);
        expect(ops(net, alice.peer)).toEqual([]);
        expect(alice.events).toEqual([]);
    });

    it("undoes its own most recent element still on the board, skipping ones already erased and leaving others' alone", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const first = alice.session.addStamp("⭐", 32, 1, 1)!;
        const second = alice.session.addStamp("🔥", 32, 2, 2)!;
        const theirs = bob.session.addStamp("💡", 32, 3, 3)!;
        bob.session.erase([second]);

        expect(alice.session.undo()).toBe(true);
        expect(last(ops(net, alice.peer))).toEqual({ op: "remove", ids: [first] });
        expect(alice.session.board.elements.map((e) => e.id)).toEqual([theirs]);
        expect(bob.session.board.elements.map((e) => e.id)).toEqual([theirs]);

        const sent = net.sentBy(alice.peer).length;
        expect(alice.session.undo()).toBe(false);
        expect(net.sentBy(alice.peer)).toHaveLength(sent);
    });

    it("has nothing to undo before drawing anything", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        expect(alice.session.undo()).toBe(false);
        expect(ops(net, alice.peer)).toEqual([]);
    });

    it("sends a stroke's waiting points before undoing it, so the others' copy is whole when removed", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("marker", "#000000", 8, 0, 0)!;
        alice.session.extendStroke(id, 1, 1);
        expect(alice.session.undo()).toBe(true);
        expect(ops(net, alice.peer).map((op) => op.op)).toEqual(["add", "points", "remove"]);
        expect(bob.session.board.size).toBe(0);
        // The flush timer was cancelled with it.
        vi.advanceTimersByTime(POINT_FLUSH_MS);
        expect(ops(net, alice.peer)).toHaveLength(3);
    });

    it("clears the board for everyone, raising its epoch, after sending any waiting points", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("marker", "#000000", 8, 0, 0)!;
        alice.session.extendStroke(id, 1, 1);
        bob.session.addStamp("❗", 56, 5, 5);
        alice.session.clear();
        expect(ops(net, alice.peer).map((op) => op.op)).toEqual(["add", "points", "clear"]);
        expect(last(ops(net, alice.peer))).toEqual({ op: "clear", epoch: 1 });
        for (const person of [alice, bob]) {
            expect(person.session.board.size).toBe(0);
            expect(person.session.board.epoch).toBe(1);
        }
        // What is drawn next belongs to the new epoch.
        const next = bob.session.addStamp("✅", 32, 1, 1)!;
        expect(alice.session.board.get(next)).toMatchObject({ epoch: 1 });
    });

    it("refuses to draw on a full board, sending nothing, until something is erased", () => {
        const net = network();
        const [alice] = room(net, "Alice", "Bob");
        const ids: string[] = [];
        for (let i = 0; i < MAX_BOARD_ELEMENTS; i++) {
            const id = `${alice.peer}:filler-${i}`;
            ids.push(id);
            alice.session.board.apply({ op: "add", element: { kind: "stamp", id, epoch: 0, stamp: "⭐", size: 32, x: 0, y: 0 } }, alice.peer);
        }
        expect(alice.session.beginStroke("marker", "#000000", 8, 0, 0)).toBeUndefined();
        expect(alice.session.addShape("line", "#000000", 2, 0, 0, 1, 1)).toBeUndefined();
        expect(alice.session.addStamp("⭐", 32, 0, 0)).toBeUndefined();
        expect(ops(net, alice.peer)).toEqual([]);
        expect(alice.session.undo()).toBe(false);

        alice.session.erase([ids[0]]);
        expect(alice.session.addStamp("⭐", 32, 0, 0)).toBeDefined();
    });
});

describe("CollabSession - remote ops", () => {
    it("applies another participant's ops and says the board changed - but only when it did", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const element: BoardElement = { kind: "stamp", id: `${bob.peer}:1`, epoch: 0, stamp: "⭐", size: 32, x: 1, y: 1 };
        bob.channel.send(signal("whiteboard", "bob", { whiteboard: { op: "add", element } }));
        expect(alice.session.board.elements).toEqual([element]);
        expect(alice.boardEvents()).toBe(1);
        // The same add again changes nothing.
        bob.channel.send(signal("whiteboard", "bob", { whiteboard: { op: "add", element } }));
        expect(alice.boardEvents()).toBe(1);
    });

    it("drops an invalid op", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        bob.channel.send(signal("whiteboard", "bob", { whiteboard: { op: "add", element: { kind: "stamp", id: `${bob.peer}:1`, epoch: 0, stamp: "<script>", size: 32, x: 1, y: 1 } } }));
        bob.channel.send(signal("whiteboard", "bob", { whiteboard: "clear" }));
        bob.channel.send(signal("whiteboard", "bob"));
        expect(alice.session.board.size).toBe(0);
        expect(alice.session.board.epoch).toBe(0);
        expect(alice.events).toEqual([]);
    });

    it("won't let a participant add to, or add under, someone else's element", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("marker", "#000000", 8, 0, 0)!;
        alice.session.endStroke();
        alice.events.length = 0;
        bob.channel.send(signal("whiteboard", "bob", { whiteboard: { op: "points", id, start: 1, points: [500, 500] } }));
        bob.channel.send(
            signal("whiteboard", "bob", { whiteboard: { op: "add", element: { kind: "stamp", id: `${alice.peer}:forged`, epoch: 0, stamp: "👎", size: 32, x: 1, y: 1 } } }),
        );
        // Forging the envelope doesn't help: the server stamps the real sender.
        bob.channel.send({ ...signal("whiteboard", "alice"), peer: alice.peer, whiteboard: { op: "points", id, start: 1, points: [600, 600] } });
        expect(alice.session.board.elements).toEqual([expect.objectContaining({ id, points: [0, 0] })]);
        expect(alice.events).toEqual([]);
    });
});

describe("CollabSession - catching up", () => {
    /** Alice and Bob in a call with something said and drawn; returns them and the newcomer Carol, started. */
    function callUnderWay(maxMessageBytes?: number) {
        const net = network(maxMessageBytes);
        const [alice, bob] = room(net, "Alice", "Bob");
        alice.session.sendChat("first");
        bob.session.sendChat("second");
        const stroke = alice.session.beginStroke("marker", "#ff0000", 8, 0, 0)!;
        alice.session.extendStroke(stroke, 1, 1);
        alice.session.endStroke();
        bob.session.addShape("star", "#00ff00", 4, 10, 10, 50, 50);
        const carol = join(net, "Carol");
        return { net, alice, bob, carol };
    }

    it("asks the first participant who says hello within the window, and only them, and merges what they send", () => {
        const { net, alice, bob, carol } = callUnderWay();
        const requestedAt = Date.now();
        alice.hello();
        bob.hello();
        expect(net.sentBy(carol.peer, "collab-sync-request")).toEqual([expect.objectContaining({ to: alice.peer })]);
        // Bob never sees the request.
        expect(net.sentBy(bob.peer, "collab-sync")).toEqual([]);

        vi.advanceTimersByTime(0);
        const parts = syncParts(net, carol.peer);
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({ at: requestedAt, message: { peer: alice.peer }, sync: { part: 0, of: 1, epoch: 0 } });

        expect(carol.session.board.elements).toEqual(alice.session.board.elements);
        expect(carol.session.chat.map(({ peer, name, text, self }) => ({ peer, name, text, self }))).toEqual([
            { peer: alice.peer, name: "Alice", text: "first", self: false },
            { peer: bob.peer, name: "Bob", text: "second", self: false },
        ]);
        expect(carol.chatEvents().map((e) => e.text)).toEqual(["first", "second"]);
        expect(carol.boardEvents()).toBe(1);

        // Done: nobody else is asked, even after the timeout.
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS * 3);
        expect(net.sentBy(carol.peer, "collab-sync-request")).toHaveLength(1);
        // And Alice is no longer listened to.
        alice.channel.send(signal("collab-sync", "alice", { to: carol.peer, sync: { part: 0, of: 1, epoch: 0, chat: [{ id: "late", peer: "x", name: "X", text: "late", sentAt: 1 }], ops: [] } }));
        expect(carol.session.chat.map((e) => e.text)).not.toContain("late");
    });

    it("a hello at the very end of the window still counts; one after it triggers nothing", () => {
        const first = callUnderWay();
        vi.advanceTimersByTime(SYNC_WINDOW_MS - 1);
        first.alice.hello();
        expect(first.net.sentBy(first.carol.peer, "collab-sync-request")).toHaveLength(1);

        const second = callUnderWay();
        vi.advanceTimersByTime(SYNC_WINDOW_MS);
        second.alice.hello();
        second.bob.hello();
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS * 2);
        expect(second.net.sentBy(second.carol.peer, "collab-sync-request")).toEqual([]);
        expect(second.carol.session.board.size).toBe(0);
    });

    it("sizes a protected meeting's catch-up parts to what fits once sealed, not to the server's limit itself", () => {
        const maxPlainMessageBytes = 6 * 1024;
        const net = network(64 * 1024, maxPlainMessageBytes);
        const [alice] = room(net, "Alice");
        for (let i = 0; i < 60; i++) {
            alice.session.sendChat(`message ${i}: ${"lorem ipsum ".repeat(15)}`);
        }
        const carol = join(net, "Carol");
        alice.hello();
        vi.advanceTimersByTime(SYNC_PACE_MS * 100);

        const parts = syncParts(net, carol.peer);
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) {
            expect(part.bytes).toBeLessThanOrEqual(maxPlainMessageBytes);
        }
        expect(carol.session.chat).toHaveLength(60);
    });

    it("splits a big catch-up into parts under the server's message limit, paced SYNC_PACE_MS apart, and rebuilds it exactly", () => {
        const maxMessageBytes = 8 * 1024;
        const net = network(maxMessageBytes);
        const [alice] = room(net, "Alice");
        for (let i = 0; i < 30; i++) {
            alice.session.sendChat(`message ${i}: ${"lorem ipsum ".repeat(15)}`);
        }
        for (let i = 0; i < 150; i++) {
            alice.session.addShape("ellipse", "#336699", 8, i, i * 2, i + 100, i * 3);
        }
        const longStroke = alice.session.beginStroke("pencil", "#000000", 2, 0, 0)!;
        const pointCount = 1500;
        for (let i = 1; i < pointCount; i++) {
            alice.session.extendStroke(longStroke, 1000 + (i % 600), 100 + (i % 800));
            if (i % 50 === 0) {
                vi.advanceTimersByTime(POINT_FLUSH_MS);
            }
        }
        alice.session.endStroke();
        alice.session.addStamp("➡️", 160, 800, 450);

        const carol = join(net, "Carol");
        const requestedAt = Date.now();
        alice.hello();
        vi.advanceTimersByTime(SYNC_PACE_MS * 100);

        const parts = syncParts(net, carol.peer);
        expect(parts.length).toBeGreaterThan(3);
        parts.forEach((part, index) => {
            expect(part.bytes).toBeLessThanOrEqual(maxMessageBytes);
            expect(part.at).toBe(requestedAt + index * SYNC_PACE_MS);
            expect(part.sync).toMatchObject({ part: index, of: parts.length, epoch: 0 });
        });
        // Nothing left out: some part filled almost to the budget.
        expect(Math.max(...parts.map((p) => p.bytes))).toBeGreaterThan(maxMessageBytes - SYNC_ENVELOPE_BYTES - 1024);

        // The long stroke travelled as an add and points ops of at most SYNC_POINTS_PER_OP points.
        const strokeOps = parts.flatMap((p) => p.sync.ops).filter((op) => (op.op === "add" ? op.element.id : op.op === "points" ? op.id : undefined) === longStroke);
        expect(strokeOps.map((op) => op.op)).toEqual(["add", "points", "points"]);
        expect(strokeOps[1]).toMatchObject({ start: SYNC_POINTS_PER_OP });
        expect(strokeOps[2]).toMatchObject({ start: SYNC_POINTS_PER_OP * 2 });

        expect(carol.session.board.elements).toEqual(alice.session.board.elements);
        expect((carol.session.board.get(longStroke) as Extract<BoardElement, { kind: "stroke" }>).points).toHaveLength(pointCount * 2);
        expect(carol.session.chat.map(({ key, id, peer, name, text, sentAt }) => ({ key, id, peer, name, text, sentAt }))).toEqual(
            alice.session.chat.map(({ key, id, peer, name, text, sentAt }) => ({ key, id, peer, name, text, sentAt })),
        );
        expect(carol.session.chat.every((e) => !e.self)).toBe(true);
    });

    it("sizes parts against 16 KiB when the channel doesn't give a limit", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        for (let i = 0; i < 200; i++) {
            alice.session.addShape("triangle", "#336699", 8, i, i, i + 100, i + 100);
        }
        const carol = join(net, "Carol");
        alice.hello();
        vi.advanceTimersByTime(SYNC_PACE_MS * 10);
        const parts = syncParts(net, carol.peer);
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) {
            expect(part.bytes).toBeLessThanOrEqual(16 * 1024);
        }
        expect(carol.session.board.elements).toEqual(alice.session.board.elements);
    });

    it("gives an item bigger than a part's budget a part of its own", () => {
        const net = network(SYNC_ENVELOPE_BYTES + 50);
        const [alice] = room(net, "Alice");
        alice.session.sendChat("a message long enough not to fit the tiny budget on its own");
        alice.session.sendChat("and another one, just as long, to make a second part");
        const carol = join(net, "Carol");
        alice.hello();
        vi.advanceTimersByTime(SYNC_PACE_MS * 2);
        expect(syncParts(net, carol.peer).map((p) => p.sync.chat.length)).toEqual([1, 1]);
        expect(carol.session.chat.map((e) => e.text)).toEqual(alice.session.chat.map((e) => e.text));
    });

    it("sends a single empty part when there is nothing to catch up on", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const carol = join(net, "Carol");
        alice.hello();
        vi.advanceTimersByTime(0);
        expect(syncParts(net, carol.peer).map((p) => p.sync)).toEqual([{ part: 0, of: 1, epoch: 0, chat: [], ops: [] }]);
        expect(carol.events).toEqual([]);
    });

    it("asks the next participant when nothing arrives within SYNC_TIMEOUT_MS, and gives up when nobody is left", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        alice.session.sendChat("worth catching up on");
        net.channel("ghost", "ghost~1"); // a participant whose tab never answers
        net.channel("phantom", "phantom~1");
        const ghostHello = () => net.channel("ghost", "ghost~1").send(signal("hello", "ghost", { name: "Ghost" }));
        const phantomHello = () => net.channel("phantom", "phantom~1").send(signal("hello", "phantom", { name: "Phantom" }));

        const carol = join(net, "Carol");
        ghostHello();
        ghostHello(); // a repeated hello isn't a second candidate
        phantomHello();
        const requests = () => net.sentBy(carol.peer, "collab-sync-request").map((m) => m.to);
        expect(requests()).toEqual(["ghost~1"]);
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS - 1);
        expect(requests()).toEqual(["ghost~1"]);
        vi.advanceTimersByTime(1);
        expect(requests()).toEqual(["ghost~1", "phantom~1"]);
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS);
        expect(requests()).toEqual(["ghost~1", "phantom~1"]);
        // Out of candidates. A hello now - even within the window - asks nobody, and the timeout doesn't revive it.
        alice.hello();
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS * 3);
        expect(requests()).toEqual(["ghost~1", "phantom~1"]);
        expect(carol.session.chat).toEqual([]);
    });

    it("moves on from a participant who doesn't answer to one who does, ignoring the first if it answers late", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        alice.session.addStamp("⭐", 32, 1, 1);
        const ghost = net.channel("ghost", "ghost~1");
        const carol = join(net, "Carol");
        ghost.send(signal("hello", "ghost"));
        alice.hello();
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS);
        expect(net.sentBy(carol.peer, "collab-sync-request").map((m) => m.to)).toEqual(["ghost~1", alice.peer]);
        // The ghost answering now is ignored: Alice is the one asked.
        ghost.send(signal("collab-sync", "ghost", { to: carol.peer, sync: { part: 0, of: 2, epoch: 5, chat: [], ops: [] } }));
        expect(carol.session.board.epoch).toBe(0);
        // (Alice's answer was scheduled from inside a timer, which the fake clock runs a millisecond later.)
        vi.advanceTimersByTime(SYNC_PACE_MS);
        expect(carol.session.board.elements).toEqual(alice.session.board.elements);
    });

    it("ignores a catch-up from a participant it didn't ask, before or while asking someone else", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const carol = join(net, "Carol");
        const unsolicited = { part: 0, of: 1, epoch: 3, chat: [{ id: "x", peer: bob.peer, name: "Bob", text: "trust me", sentAt: 1 }], ops: [] };
        bob.channel.send(signal("collab-sync", "bob", { to: carol.peer, sync: unsolicited }));
        alice.hello();
        bob.channel.send(signal("collab-sync", "bob", { to: carol.peer, sync: unsolicited }));
        expect(carol.session.chat).toEqual([]);
        expect(carol.session.board.epoch).toBe(0);
        expect(carol.events).toEqual([]);
    });

    it("ignores a malformed part from the participant asked, still waiting for a good one", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const ghost = net.channel("ghost", "ghost~1");
        const carol = join(net, "Carol");
        ghost.send(signal("hello", "ghost"));
        alice.hello();
        ghost.send(signal("collab-sync", "ghost", { to: carol.peer, sync: { part: 1, of: 1, epoch: 0, chat: [], ops: [] } }));
        // The malformed part didn't count as an answer: the timeout still moves on to Alice.
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS);
        expect(net.sentBy(carol.peer, "collab-sync-request").map((m) => m.to)).toEqual(["ghost~1", alice.peer]);
    });

    it("keeps listening to the participant asked between parts, and asks the next one when the rest never comes", () => {
        const net = network(SYNC_ENVELOPE_BYTES + 50);
        const [alice, bob] = room(net, "Alice", "Bob");
        alice.session.sendChat("part one of the history, long enough for its own part");
        alice.session.sendChat("part two of the history, long enough for its own part");
        const carol = join(net, "Carol");
        alice.hello();
        bob.hello();
        vi.advanceTimersByTime(0);
        expect(carol.session.chat).toHaveLength(1);
        // A last part within the timeout of the one before it is still Alice's to send: nobody else is asked yet.
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS - 1);
        expect(net.sentBy(carol.peer, "collab-sync-request")).toHaveLength(1);
        expect(carol.session.chat).toHaveLength(2);
        // Alice goes quiet mid-way through another catch-up: Bob is asked once the timeout passes after her last part.
        const dave = join(net, "Dave");
        alice.hello();
        bob.hello();
        alice.session.stop();
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS);
        expect(net.sentBy(dave.peer, "collab-sync-request")).toHaveLength(2);
        vi.advanceTimersByTime(SYNC_PACE_MS * 4);
        expect(dave.session.chat.map((e) => e.text)).toContain("part two of the history, long enough for its own part");
    });

    it("puts history before what arrived live while it travelled, and shows nothing twice", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        alice.session.sendChat("old one");
        alice.session.sendChat("old two");
        const carol = join(net, "Carol");
        bob.session.sendChat("live, before the request"); // reaches Carol live, and is in Alice's catch-up too
        alice.hello();
        bob.session.sendChat("live, while the catch-up travels"); // not in it
        vi.advanceTimersByTime(0);
        expect(carol.session.chat.map((e) => e.text)).toEqual(["old one", "old two", "live, before the request", "live, while the catch-up travels"]);
        expect(carol.chatEvents().map((e) => e.text)).toEqual(["live, before the request", "live, while the catch-up travels", "old one", "old two"]);
        expect(new Set(carol.session.chat.map((e) => e.key)).size).toBe(4);
    });

    it("keeps a multi-part catch-up's history in order, ahead of live messages arriving between its parts", () => {
        const net = network(SYNC_ENVELOPE_BYTES + 50);
        const [alice, bob] = room(net, "Alice", "Bob");
        for (const n of ["one", "two", "three"]) {
            alice.session.sendChat(`history ${n}, long enough to fill a part of the catch-up on its own`);
        }
        const carol = join(net, "Carol");
        alice.hello();
        vi.advanceTimersByTime(0);
        bob.session.sendChat("live A");
        vi.advanceTimersByTime(SYNC_PACE_MS);
        bob.session.sendChat("live B");
        vi.advanceTimersByTime(SYNC_PACE_MS);
        expect(syncParts(net, carol.peer)).toHaveLength(3);
        expect(carol.session.chat.map((e) => e.text.split(",")[0])).toEqual(["history one", "history two", "history three", "live A", "live B"]);
        // Later live messages still go at the end.
        bob.session.sendChat("live C");
        expect(last(carol.session.chat).text).toBe("live C");
    });

    it("drops a history entry that fails validation and shows its own message from history as its own", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const carol = join(net, "Carol");
        alice.hello();
        vi.clearAllTimers(); // Alice's own answer is replaced by the one below
        alice.channel.send(
            signal("collab-sync", "alice", {
                to: carol.peer,
                sync: {
                    part: 0,
                    of: 1,
                    epoch: 0,
                    chat: [
                        { id: "mine", peer: carol.peer, name: "Carol", text: "from my last visit", sentAt: 1 },
                        { id: "bad", peer: alice.peer, name: "Alice", text: "", sentAt: 1 },
                        { id: "bad2", peer: alice.peer, name: "A".repeat(201), text: "long name", sentAt: 1 },
                    ],
                    ops: [{ op: "bogus" }],
                },
            }),
        );
        expect(carol.session.chat).toEqual([{ key: `${carol.peer}:mine`, id: "mine", peer: carol.peer, name: "Carol", text: "from my last visit", sentAt: 1, self: true }]);
        // Nothing on the board changed, so no board event.
        expect(carol.boardEvents()).toBe(0);
    });

    it("keeps only the latest MAX_CHAT_HISTORY messages when history is merged", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const carol = join(net, "Carol");
        carol.session.sendChat("carol's live message");
        alice.hello();
        vi.clearAllTimers();
        const chat = Array.from({ length: MAX_CHAT_HISTORY }, (_, i) => ({ id: `h${i}`, peer: alice.peer, name: "Alice", text: `history ${i}`, sentAt: i }));
        alice.channel.send(signal("collab-sync", "alice", { to: carol.peer, sync: { part: 0, of: 1, epoch: 0, chat, ops: [] } }));
        expect(carol.session.chat).toHaveLength(MAX_CHAT_HISTORY);
        expect(carol.session.chat[0].text).toBe("history 1");
        expect(last(carol.session.chat).text).toBe("carol's live message");
    });

    it("can't bring back what was cleared while the catch-up travelled, from someone who missed the clear", () => {
        const { net, alice, bob, carol } = callUnderWay();
        alice.hello(); // Alice's catch-up is put together now, with the board as it is
        bob.session.clear(); // and the board is cleared before it arrives
        expect(carol.session.board.epoch).toBe(1);
        const after = bob.session.addStamp("🎉", 32, 1, 1)!;
        vi.advanceTimersByTime(0);
        expect(syncParts(net, carol.peer)[0].sync.ops.length).toBeGreaterThan(0);
        expect(carol.session.board.elements.map((e) => e.id)).toEqual([after]);
        expect(carol.session.board.epoch).toBe(1);
    });

    it("clears what this tab drew under an older epoch when the catch-up says the board was cleared since", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        alice.session.clear();
        alice.session.clear();
        const kept = alice.session.addStamp("⭐", 32, 1, 1)!;
        const carol = join(net, "Carol", { peer: "carol~1" });
        // Carol, not hearing about the clears, drew something under epoch 0.
        carol.session.board.apply({ op: "add", element: { kind: "stamp", id: "carol~1:old", epoch: 0, stamp: "❌", size: 32, x: 0, y: 0 } }, "carol~1");
        alice.hello();
        vi.advanceTimersByTime(0);
        expect(carol.session.board.epoch).toBe(2);
        expect(carol.session.board.elements.map((e) => e.id)).toEqual([kept]);
        expect(carol.boardEvents()).toBe(1);
    });

    it("answers anyone's request, addressed to them alone", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        alice.session.sendChat("hi");
        bob.channel.send(signal("collab-sync-request", "bob", { to: alice.peer }));
        vi.advanceTimersByTime(0);
        expect(net.sentBy(alice.peer, "collab-sync")).toEqual([expect.objectContaining({ to: bob.peer })]);
        // Bob already had everything: nothing new is shown.
        expect(bob.session.chat).toHaveLength(1);
    });
});

describe("CollabSession - lifecycle and filtering", () => {
    it("start() subscribes once; stop() unsubscribes, and is idempotent", () => {
        const net = network();
        const alice = join(net, "Alice");
        alice.session.start();
        expect(net.listenerCount(alice.peer)).toBe(1);
        alice.session.stop();
        expect(net.listenerCount(alice.peer)).toBe(0);
        alice.session.stop();
        expect(net.listenerCount(alice.peer)).toBe(0);
    });

    it("start() after stop() is a no-op", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        alice.session.stop();
        alice.session.start();
        expect(net.listenerCount(alice.peer)).toBe(0);
        bob.session.sendChat("anyone there?");
        expect(alice.session.chat).toEqual([]);
    });

    it("hears nothing before start()", () => {
        const net = network();
        const [bob] = room(net, "Bob");
        const alice = join(net, "Alice", { start: false });
        bob.session.sendChat("early");
        expect(alice.session.chat).toEqual([]);
    });

    it("sends a stroke's waiting points when stopped", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("marker", "#000000", 8, 0, 0)!;
        alice.session.extendStroke(id, 1, 1);
        alice.session.stop();
        expect(last(ops(net, alice.peer))).toEqual({ op: "points", id, start: 1, points: [1, 1] });
        expect(bob.session.board.get(id)).toEqual(alice.session.board.get(id));
        vi.advanceTimersByTime(POINT_FLUSH_MS);
        expect(ops(net, alice.peer)).toHaveLength(2);
    });

    it("sends and emits nothing after stop(), including catch-up parts and requests still scheduled", () => {
        const net = network(SYNC_ENVELOPE_BYTES + 50);
        const [alice, bob] = room(net, "Alice", "Bob");
        alice.session.sendChat("one message long enough to need its own part of the catch-up");
        alice.session.sendChat("two messages long enough to need their own part of the catch-up");
        const ghost = net.channel("ghost", "ghost~1");
        const carol = join(net, "Carol");
        ghost.send(signal("hello", "ghost"));
        alice.hello();
        // Carol is waiting on the ghost; Alice has a catch-up for... nobody yet. Have Bob ask Alice for one.
        bob.channel.send(signal("collab-sync-request", "bob", { to: alice.peer }));
        vi.advanceTimersByTime(0);
        expect(net.sentBy(alice.peer, "collab-sync")).toHaveLength(1);
        alice.session.stop();
        carol.session.stop();
        const sent = net.wire.length;
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS * 2);
        expect(net.wire).toHaveLength(sent);

        const events = alice.events.length;
        expect(alice.session.sendChat("too late")).toBe(false);
        expect(alice.session.beginStroke("marker", "#000000", 8, 0, 0)).toBeUndefined();
        expect(alice.session.addStamp("⭐", 32, 0, 0)).toBeUndefined();
        alice.session.clear();
        alice.session.endStroke();
        expect(net.wire).toHaveLength(sent);
        expect(alice.events).toHaveLength(events);
    });

    it("stops notifying a listener that unsubscribed", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const listener = vi.fn();
        const unsubscribe = alice.session.onEvent(listener);
        alice.session.sendChat("one");
        unsubscribe();
        alice.session.sendChat("two");
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("ignores its own messages, messages addressed to another peer, and other message types", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const chat = (id: string) => ({ id, text: `text ${id}`, sentAt: 1 });
        // Its own peer, echoed back.
        net.inject(alice.peer, signal("chat", "alice", { peer: alice.peer, chat: chat("own") }));
        // Addressed to someone else.
        net.inject(alice.peer, signal("chat", "bob~1", { to: "carol~1", chat: chat("elsewhere") }));
        net.inject(alice.peer, signal("collab-sync-request", "bob~1", { to: "carol~1" }));
        // Not a signal at all.
        net.inject(alice.peer, { ...signal("chat", "bob~1", { chat: chat("other-type") }), type: "something-else" } as unknown as SignalMessage);
        // A signal kind the session doesn't handle.
        net.inject(alice.peer, signal("offer", "bob~1", { to: alice.peer }));
        vi.advanceTimersByTime(SYNC_PACE_MS);
        expect(alice.session.chat).toEqual([]);
        expect(net.sentBy(alice.peer)).toHaveLength(1); // only its hello

        // Addressed to this peer is fine.
        net.inject(alice.peer, signal("chat", "bob~1", { to: alice.peer, chat: chat("direct") }));
        expect(alice.session.chat.map((e) => e.id)).toEqual(["direct"]);
    });
});

/** Every pointer message `peer` sent. */
const pointers = (net: Network, peer: string) => net.sentBy(peer, "whiteboard-cursor").map((m) => m.cursor);
const cursorEvents = (person: Participant) => person.events.filter((e) => e.type === "cursors").length;

describe("CollabSession - sharing this participant's pointer", () => {
    it("sends the first position at once, then at most every CURSOR_INTERVAL_MS with only the latest position", () => {
        const net = network();
        const [alice] = room(net, "Alice", "Bob");
        alice.session.moveCursor(10, 20, "marker", "#ff0000");
        vi.advanceTimersByTime(0);
        expect(pointers(net, alice.peer)).toEqual([{ x: 10, y: 20, tool: "marker", color: "#ff0000" }]);
        const firstAt = Date.now();

        alice.session.moveCursor(11, 21, "marker", "#ff0000");
        alice.session.moveCursor(12.6, 22.2, "eraser", "#00ff00");
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS - 1);
        expect(pointers(net, alice.peer)).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(pointers(net, alice.peer)).toEqual([
            { x: 10, y: 20, tool: "marker", color: "#ff0000" },
            { x: 13, y: 22, tool: "eraser", color: "#00ff00" },
        ]);
        expect(last(net.wire).at).toBe(firstAt + CURSOR_INTERVAL_MS);
        expect(last(net.wire).message.to).toBeUndefined();

        // Long after the last one, the next goes out at once again.
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS * 5);
        alice.session.moveCursor(1, 2, "stamp", "#000000", "🔥");
        vi.advanceTimersByTime(0);
        expect(last(pointers(net, alice.peer))).toEqual({ x: 1, y: 2, tool: "stamp", color: "#000000", stamp: "🔥" });
    });

    it("keeps the position it sends within the board", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        alice.session.moveCursor(-50, 99_999, "pencil", "#123456");
        vi.advanceTimersByTime(0);
        expect(pointers(net, alice.peer)).toEqual([{ x: 0, y: BOARD_HEIGHT, tool: "pencil", color: "#123456" }]);
        expect(bob.session.cursors).toEqual([expect.objectContaining({ x: 0, y: BOARD_HEIGHT })]);
    });

    it("sends no pointer while a stroke is being drawn, dropping the one waiting, and sends again once it ends", () => {
        const net = network();
        const [alice] = room(net, "Alice", "Bob");
        alice.session.moveCursor(1, 1, "marker", "#000000");
        vi.advanceTimersByTime(0);
        // One waiting for its turn when the stroke starts...
        alice.session.moveCursor(2, 2, "marker", "#000000");
        const id = alice.session.beginStroke("marker", "#000000", 8, 2, 2)!;
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS);
        // ...and one while drawing: neither goes out.
        alice.session.moveCursor(3, 3, "marker", "#000000");
        alice.session.extendStroke(id, 3, 3);
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS * 3);
        expect(pointers(net, alice.peer)).toHaveLength(1);

        alice.session.endStroke();
        // Ending the stroke doesn't bring back the one dropped.
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS * 3);
        expect(pointers(net, alice.peer)).toHaveLength(1);
        alice.session.moveCursor(4, 4, "marker", "#000000");
        vi.advanceTimersByTime(0);
        expect(last(pointers(net, alice.peer))).toEqual({ x: 4, y: 4, tool: "marker", color: "#000000" });
    });

    it("says the pointer left only if one was shown, once, cancelling one still waiting", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        // Nothing shown yet: nothing to hide - and the one scheduled never goes out.
        alice.session.hideCursor();
        alice.session.moveCursor(5, 5, "ballpoint", "#000000");
        alice.session.hideCursor();
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS * 2);
        expect(pointers(net, alice.peer)).toEqual([]);

        alice.session.moveCursor(6, 6, "ballpoint", "#000000");
        vi.advanceTimersByTime(0);
        alice.session.moveCursor(7, 7, "ballpoint", "#000000");
        alice.session.hideCursor();
        alice.session.hideCursor();
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS * 2);
        expect(pointers(net, alice.peer)).toEqual([{ x: 6, y: 6, tool: "ballpoint", color: "#000000" }, { hidden: true }]);
        expect(bob.session.cursors).toEqual([]);
    });

    it("does nothing once stopped, and stop() clears every timer it holds", () => {
        const net = network();
        const alice = join(net, "Alice");
        alice.session.moveCursor(1, 1, "marker", "#000000");
        vi.advanceTimersByTime(0);
        alice.session.moveCursor(2, 2, "marker", "#000000");
        const id = alice.session.beginStroke("marker", "#000000", 8, 0, 0)!;
        alice.session.extendStroke(id, 5, 5);
        expect(vi.getTimerCount()).toBe(3); // the idle-pointer check, the waiting pointer and the point batch
        alice.session.stop();
        expect(vi.getTimerCount()).toBe(0);

        const sent = net.wire.length;
        alice.session.moveCursor(3, 3, "marker", "#000000");
        alice.session.hideCursor();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS * 2);
        expect(net.wire).toHaveLength(sent);
    });
});

describe("CollabSession - everyone else's pointers", () => {
    it("shows a participant's pointer under the name from their hello, with its stamp, and 'Guest' for one who never said hello", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        bob.session.moveCursor(100, 200, "stamp", "#abcdef", "💡");
        vi.advanceTimersByTime(0);
        expect(alice.session.cursors).toEqual([{ peer: bob.peer, name: "Bob", x: 100, y: 200, tool: "stamp", color: "#abcdef", stamp: "💡", at: Date.now() }]);
        expect(cursorEvents(alice)).toBe(1);

        const zed = net.channel("zed", "zed~1");
        zed.send(signal("whiteboard-cursor", "zed", { cursor: { x: 1, y: 2, tool: "eraser", color: "#FFFFFF" } }));
        expect(alice.session.cursors).toEqual([
            expect.objectContaining({ peer: bob.peer }),
            { peer: "zed~1", name: "Guest", x: 1, y: 2, tool: "eraser", color: "#ffffff", at: Date.now() },
        ]);
        expect(cursorEvents(alice)).toBe(2);
        // A participant never sees their own pointer.
        expect(bob.session.cursors).toEqual([expect.objectContaining({ peer: "zed~1" })]);
    });

    it("ignores an invalid pointer", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const invalid = [
            undefined,
            "here",
            { x: 1.5, y: 2, tool: "marker", color: "#000000" },
            { x: 1, y: 2, tool: "laser", color: "#000000" },
            { x: 1, y: 2, tool: "stamp", color: "#000000", stamp: "<b>" },
        ];
        for (const cursor of invalid) {
            bob.channel.send(signal("whiteboard-cursor", "bob", { cursor }));
        }
        expect(alice.session.cursors).toEqual([]);
        expect(alice.events).toEqual([]);
    });

    it("drops a pointer when it leaves the board, or its participant leaves the call - saying so only when there was one", () => {
        const net = network();
        const [alice, bob, carol] = room(net, "Alice", "Bob", "Carol");
        bob.session.moveCursor(1, 1, "marker", "#000000");
        carol.session.moveCursor(2, 2, "marker", "#000000");
        vi.advanceTimersByTime(0);
        expect(alice.session.cursors.map((c) => c.peer)).toEqual([bob.peer, carol.peer]);
        alice.events.length = 0;

        bob.session.hideCursor();
        expect(alice.session.cursors.map((c) => c.peer)).toEqual([carol.peer]);
        expect(cursorEvents(alice)).toBe(1);
        // Hidden again (forged - the session itself wouldn't): nothing to drop, no event.
        bob.channel.send(signal("whiteboard-cursor", "bob", { cursor: { hidden: true } }));
        expect(cursorEvents(alice)).toBe(1);

        carol.channel.send(signal("bye", "carol"));
        expect(alice.session.cursors).toEqual([]);
        expect(cursorEvents(alice)).toBe(2);
        bob.channel.send(signal("bye", "bob"));
        expect(cursorEvents(alice)).toBe(2);
    });

    it("drops a pointer not heard from for CURSOR_IDLE_MS, saying so only when one was dropped", () => {
        const net = network();
        const [alice, bob, carol] = room(net, "Alice", "Bob", "Carol");
        // The idle check runs every CURSOR_IDLE_MS / 6 from start(); room() left the clock on one of its runs.
        const check = CURSOR_IDLE_MS / 6;
        expect(SYNC_WINDOW_MS % check).toBe(0);
        bob.session.moveCursor(1, 1, "marker", "#000000");
        vi.advanceTimersByTime(0);
        vi.advanceTimersByTime(CURSOR_IDLE_MS - check);
        carol.session.moveCursor(2, 2, "marker", "#000000");
        vi.advanceTimersByTime(0);
        alice.events.length = 0;

        // Exactly CURSOR_IDLE_MS since Bob's last move: not yet past it.
        vi.advanceTimersByTime(check);
        expect(alice.session.cursors.map((c) => c.peer)).toEqual([bob.peer, carol.peer]);
        expect(cursorEvents(alice)).toBe(0);
        vi.advanceTimersByTime(check);
        expect(alice.session.cursors.map((c) => c.peer)).toEqual([carol.peer]);
        expect(cursorEvents(alice)).toBe(1);

        // Checks that find nothing to drop say nothing, until Carol's goes too.
        vi.advanceTimersByTime(CURSOR_IDLE_MS - check * 2);
        expect(alice.session.cursors.map((c) => c.peer)).toEqual([carol.peer]);
        expect(cursorEvents(alice)).toBe(1);
        vi.advanceTimersByTime(check);
        expect(alice.session.cursors).toEqual([]);
        expect(cursorEvents(alice)).toBe(2);
        vi.advanceTimersByTime(CURSOR_IDLE_MS);
        expect(cursorEvents(alice)).toBe(2);
    });

    it("moves a participant's pointer along the stroke they draw, as its pen in its color", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = bob.session.beginStroke("crayon", "#00ff00", 8, 10, 20)!;
        expect(alice.session.cursors).toEqual([{ peer: bob.peer, name: "Bob", x: 10, y: 20, tool: "crayon", color: "#00ff00", at: Date.now() }]);
        bob.session.extendStroke(id, 30, 40);
        bob.session.extendStroke(id, 50, 60);
        vi.advanceTimersByTime(POINT_FLUSH_MS);
        expect(alice.session.cursors).toEqual([{ peer: bob.peer, name: "Bob", x: 50, y: 60, tool: "crayon", color: "#00ff00", at: Date.now() }]);
        expect(cursorEvents(alice)).toBe(2);
        // ...without a single pointer message.
        expect(pointers(net, bob.peer)).toEqual([]);
    });

    it("keeps a pointer's stamp along a stroke only when its tool was already that pen", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        bob.session.moveCursor(1, 1, "marker", "#000000", "⭐");
        vi.advanceTimersByTime(0);
        expect(alice.session.cursors[0]).toMatchObject({ tool: "marker", stamp: "⭐" });
        bob.session.beginStroke("marker", "#ff0000", 8, 10, 10);
        expect(alice.session.cursors[0]).toMatchObject({ tool: "marker", color: "#ff0000", x: 10, y: 10, stamp: "⭐" });
        bob.session.endStroke();

        bob.session.moveCursor(1, 1, "stamp", "#000000", "🎉");
        vi.advanceTimersByTime(CURSOR_INTERVAL_MS);
        expect(alice.session.cursors[0]).toMatchObject({ tool: "stamp", stamp: "🎉" });
        bob.session.beginStroke("pencil", "#0000ff", 2, 20, 20);
        expect(alice.session.cursors[0]).toMatchObject({ tool: "pencil", x: 20, y: 20 });
        expect(alice.session.cursors[0]).not.toHaveProperty("stamp");
    });

    it("names the pointer of a stroke's author who never said hello 'Guest'", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const zed = net.channel("zed", "zed~1");
        zed.send(signal("whiteboard", "zed", { whiteboard: { op: "add", element: { kind: "stroke", id: "zed~1:1", epoch: 0, pen: "sharpie", color: "#111111", size: 4, points: [3, 4] } } }));
        expect(alice.session.cursors).toEqual([expect.objectContaining({ peer: "zed~1", name: "Guest", tool: "sharpie", x: 3, y: 4 })]);
    });

    it("leaves pointers alone for anything but a stroke, and for an op that changed nothing", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const stamp = bob.session.addStamp("⭐", 32, 5, 5)!;
        bob.session.addShape("rect", "#000000", 2, 0, 0, 10, 10);
        bob.session.erase([stamp]);
        bob.session.clear();
        expect(alice.session.cursors).toEqual([]);
        expect(cursorEvents(alice)).toBe(0);

        const id = bob.session.beginStroke("marker", "#000000", 8, 1, 1)!;
        bob.session.endStroke();
        alice.events.length = 0;
        // The same point again changes nothing on Alice's board, so it moves no pointer.
        bob.channel.send(signal("whiteboard", "bob", { whiteboard: { op: "points", id, start: 0, points: [1, 1] } }));
        // Points for a stroke Alice never got are held, not applied: no pointer either.
        bob.channel.send(signal("whiteboard", "bob", { whiteboard: { op: "points", id: `${bob.peer}:missing`, start: 0, points: [9, 9] } }));
        expect(alice.events).toEqual([]);
    });
});

describe("CollabSession - who may draw", () => {
    it("draws nothing, sends nothing and changes nothing while this participant isn't allowed to", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const mine = alice.session.addStamp("⭐", 32, 1, 1)!;
        const stroke = alice.session.beginStroke("marker", "#000000", 8, 0, 0)!;
        alice.session.endStroke();
        expect(alice.session.canDraw).toBe(true);

        alice.session.setDrawPolicy((peer) => peer === bob.peer);
        expect(alice.session.canDraw).toBe(false);
        expect(bob.session.canDraw).toBe(true);
        const sent = net.wire.length;
        alice.events.length = 0;
        const board = JSON.stringify(alice.session.board.elements);

        expect(alice.session.beginStroke("marker", "#000000", 8, 5, 5)).toBeUndefined();
        alice.session.extendStroke(stroke, 50, 50);
        expect(alice.session.addShape("rect", "#000000", 2, 0, 0, 10, 10)).toBeUndefined();
        expect(alice.session.addStamp("⭐", 32, 2, 2)).toBeUndefined();
        alice.session.erase([mine]);
        expect(alice.session.undo()).toBe(false);
        alice.session.clear();
        vi.advanceTimersByTime(POINT_FLUSH_MS);

        expect(net.wire).toHaveLength(sent);
        expect(alice.events).toEqual([]);
        expect(JSON.stringify(alice.session.board.elements)).toBe(board);
        expect(alice.session.board.epoch).toBe(0);

        // Everyone may draw again: undo takes back what it couldn't before.
        alice.session.setDrawPolicy(undefined);
        expect(alice.session.canDraw).toBe(true);
        expect(alice.session.undo()).toBe(true);
        expect(alice.session.board.get(stroke)).toBeUndefined();
        expect(alice.session.addStamp("⭐", 32, 2, 2)).toBeDefined();
    });

    it("ends a stroke in progress, sending its waiting points, when this participant may no longer draw", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("marker", "#000000", 8, 0, 0)!;
        alice.session.extendStroke(id, 10, 10);
        // A policy that still lets this participant draw leaves the stroke alone.
        alice.session.setDrawPolicy(() => true);
        expect(ops(net, alice.peer)).toHaveLength(1);

        alice.session.setDrawPolicy(() => false);
        expect(ops(net, alice.peer)).toEqual([expect.objectContaining({ op: "add" }), { op: "points", id, start: 1, points: [10, 10] }]);
        expect(bob.session.board.get(id)).toEqual(alice.session.board.get(id));
        vi.advanceTimersByTime(POINT_FLUSH_MS);
        expect(ops(net, alice.peer)).toHaveLength(2);
        // The stroke is over: the pointer is shared again.
        alice.session.moveCursor(10, 10, "marker", "#000000");
        vi.advanceTimersByTime(0);
        expect(pointers(net, alice.peer)).toHaveLength(1);
    });

    it("ignores board changes from a participant who isn't allowed to draw, and applies those from one who is", () => {
        const net = network();
        const [alice, bob, carol] = room(net, "Alice", "Bob", "Carol");
        alice.session.setDrawPolicy((peer) => peer === bob.peer);
        const fromBob = bob.session.addStamp("⭐", 32, 1, 1)!;
        const fromCarol = carol.session.addStamp("❌", 32, 2, 2)!;
        carol.session.erase([fromBob]);
        carol.session.clear();
        carol.session.beginStroke("marker", "#000000", 8, 3, 3);
        expect(alice.session.board.elements.map((e) => e.id)).toEqual([fromBob]);
        expect(alice.session.board.epoch).toBe(0);
        expect(alice.boardEvents()).toBe(1);
        // Not even the pointer follows a refused stroke.
        expect(alice.session.cursors).toEqual([]);

        alice.session.setDrawPolicy(undefined);
        carol.channel.send(signal("whiteboard", "carol", { whiteboard: { op: "add", element: { kind: "stamp", id: `${carol.peer}:again`, epoch: 0, stamp: "❌", size: 32, x: 2, y: 2 } } }));
        expect(alice.session.board.get(`${carol.peer}:again`)).toBeDefined();
        expect(alice.session.board.get(fromCarol)).toBeUndefined();
    });

    it("still applies a catch-up, whoever drew what it carries", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        alice.session.addStamp("⭐", 32, 1, 1);
        alice.session.sendChat("hi");
        const carol = join(net, "Carol");
        carol.session.setDrawPolicy(() => false);
        alice.hello();
        vi.advanceTimersByTime(0);
        expect(carol.session.board.elements).toEqual(alice.session.board.elements);
        expect(carol.session.board.size).toBe(1);
        expect(carol.session.chat).toHaveLength(1);
    });
});

describe("CollabSession - keeping coordinates on the board", () => {
    it("clamps what is drawn outside the board to its edge, locally and for everyone", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const stroke = alice.session.beginStroke("marker", "#000000", 8, -10, 5000)!;
        alice.session.extendStroke(stroke, 99_999, -3);
        alice.session.extendStroke(stroke, NaN, Infinity);
        alice.session.endStroke();
        const shape = alice.session.addShape("rect", "#000000", 2, -1, -1, 2000, 1000)!;
        const stamp = alice.session.addStamp("⭐", 32, 1e9, -1e9)!;
        expect(alice.session.board.get(stroke)).toMatchObject({ points: [0, BOARD_HEIGHT, BOARD_WIDTH, 0, 0, 0] });
        expect(alice.session.board.get(shape)).toMatchObject({ x1: 0, y1: 0, x2: BOARD_WIDTH, y2: BOARD_HEIGHT });
        expect(alice.session.board.get(stamp)).toMatchObject({ x: BOARD_WIDTH, y: 0 });
        // Every op went out clamped, so the receiver's validation accepted all of them.
        expect(bob.session.board.elements).toEqual(alice.session.board.elements);
    });
});

describe("CollabSession - point batches", () => {
    it("sends a batch as soon as it holds MAX_POINTS_PER_OP points, without waiting for the timer", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const id = alice.session.beginStroke("pencil", "#000000", 2, 0, 0)!;
        for (let i = 1; i < MAX_POINTS_PER_OP; i++) {
            alice.session.extendStroke(id, i % BOARD_WIDTH, i % BOARD_HEIGHT);
        }
        expect(ops(net, alice.peer)).toHaveLength(1);
        alice.session.extendStroke(id, 7, 7);
        const sent = ops(net, alice.peer);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toMatchObject({ op: "points", id, start: 1 });
        expect((sent[1] as Extract<WhiteboardOp, { op: "points" }>).points).toHaveLength(MAX_POINTS_PER_OP * 2);
        expect(bob.session.board.get(id)).toEqual(alice.session.board.get(id));

        // The next batch starts afresh, and goes with the timer.
        alice.session.extendStroke(id, 8, 8);
        expect(ops(net, alice.peer)).toHaveLength(2);
        vi.advanceTimersByTime(POINT_FLUSH_MS);
        expect(last(ops(net, alice.peer))).toEqual({ op: "points", id, start: MAX_POINTS_PER_OP + 1, points: [8, 8] });
        expect(bob.session.board.get(id)).toEqual(alice.session.board.get(id));
    });
});

describe("CollabSession - catching up, more", () => {
    it("asks the next participant when the whole answer was empty, and stops when everyone's was", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const carol = join(net, "Carol");
        alice.hello();
        bob.hello();
        const requests = () => net.sentBy(carol.peer, "collab-sync-request").map((m) => m.to);
        expect(requests()).toEqual([alice.peer]);
        vi.advanceTimersByTime(0);
        expect(requests()).toEqual([alice.peer, bob.peer]);
        vi.advanceTimersByTime(SYNC_PACE_MS);
        expect(requests()).toEqual([alice.peer, bob.peer]);
        // Bob's empty answer ended it: nobody is asked after the timeout either, and Bob isn't listened to any more.
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS * 2);
        expect(requests()).toEqual([alice.peer, bob.peer]);
        bob.channel.send(signal("collab-sync", "bob", { to: carol.peer, sync: { part: 0, of: 1, epoch: 4, chat: [], ops: [] } }));
        expect(carol.session.board.epoch).toBe(0);
    });

    it.each([
        ["chat", (p: Participant) => void p.session.sendChat("hi")],
        ["drawing", (p: Participant) => void p.session.addStamp("⭐", 32, 1, 1)],
        ["only a cleared board", (p: Participant) => p.session.clear()],
    ])("is done after an answer with %s in it", (_label, setUp) => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        setUp(alice);
        const carol = join(net, "Carol");
        alice.hello();
        bob.hello();
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS * 2);
        expect(net.sentBy(carol.peer, "collab-sync-request").map((m) => m.to)).toEqual([alice.peer]);
    });

    it("counts an empty last part as an answer when an earlier part had something", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const ghost = net.channel("ghost", "ghost~1");
        const carol = join(net, "Carol");
        ghost.send(signal("hello", "ghost"));
        alice.hello();
        ghost.send(signal("collab-sync", "ghost", { to: carol.peer, sync: { part: 0, of: 2, epoch: 0, chat: [{ id: "m", peer: "ghost~1", name: "Ghost", text: "boo", sentAt: 1 }], ops: [] } }));
        ghost.send(signal("collab-sync", "ghost", { to: carol.peer, sync: { part: 1, of: 2, epoch: 0, chat: [], ops: [] } }));
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS * 2);
        expect(net.sentBy(carol.peer, "collab-sync-request").map((m) => m.to)).toEqual(["ghost~1"]);
    });

    it("waits SYNC_TIMEOUT_MS afresh after each part but the last", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const ghost = net.channel("ghost", "ghost~1");
        const carol = join(net, "Carol");
        ghost.send(signal("hello", "ghost"));
        alice.hello();
        const requests = () => net.sentBy(carol.peer, "collab-sync-request").map((m) => m.to);
        const part = (index: number) =>
            ghost.send(signal("collab-sync", "ghost", { to: carol.peer, sync: { part: index, of: 3, epoch: 0, chat: [{ id: `m${index}`, peer: "ghost~1", name: "Ghost", text: `part ${index}`, sentAt: 1 }], ops: [] } }));

        vi.advanceTimersByTime(SYNC_TIMEOUT_MS - 1_000);
        part(0);
        // Past the first deadline, but within SYNC_TIMEOUT_MS of the part.
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS - 1);
        expect(requests()).toEqual(["ghost~1"]);
        part(1);
        vi.advanceTimersByTime(SYNC_TIMEOUT_MS - 1);
        expect(requests()).toEqual(["ghost~1"]);
        // The last part never comes.
        vi.advanceTimersByTime(1);
        expect(requests()).toEqual(["ghost~1", alice.peer]);
        expect(carol.session.chat.map((e) => e.text)).toEqual(["part 0", "part 1"]);
    });

    it("answers the same requester at most once per SYNC_ANSWER_COOLDOWN_MS, and others meanwhile", () => {
        const net = network();
        const [alice, bob, carol] = room(net, "Alice", "Bob", "Carol");
        alice.session.sendChat("hi");
        const answersTo = (peer: string) => syncParts(net, peer).length;
        const ask = (person: Participant) => person.channel.send(signal("collab-sync-request", person.peer, { to: alice.peer }));

        ask(bob);
        vi.advanceTimersByTime(0);
        expect(answersTo(bob.peer)).toBe(1);
        ask(bob);
        vi.advanceTimersByTime(SYNC_ANSWER_COOLDOWN_MS - 1);
        ask(bob);
        ask(carol);
        vi.advanceTimersByTime(0);
        expect(answersTo(bob.peer)).toBe(1);
        expect(answersTo(carol.peer)).toBe(1);

        vi.advanceTimersByTime(1);
        ask(bob);
        vi.advanceTimersByTime(0);
        expect(answersTo(bob.peer)).toBe(2);
    });

    it("marks chat from a catch-up as history, and live chat not", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        alice.session.sendChat("before you came");
        const carol = join(net, "Carol");
        alice.hello();
        vi.advanceTimersByTime(0);
        bob.session.sendChat("now");
        const chats = carol.events.filter((e): e is Extract<CollabEvent, { type: "chat" }> => e.type === "chat");
        expect(chats.map((e) => [e.entry.text, e.history])).toEqual([
            ["before you came", true],
            ["now", undefined],
        ]);
        expect(chats[1]).not.toHaveProperty("history");
    });
});

describe("CollabSession - names arriving late", () => {
    it("shows chat from before its sender's hello as 'Guest', then renames it, saying so once, when the hello arrives", () => {
        const net = network();
        const [alice, bob] = room(net, "Alice", "Bob");
        const dave = join(net, "Dave");
        const zed = net.channel("zed", "zed~1");
        dave.session.sendChat("one");
        zed.send(signal("chat", "zed", { chat: { id: "z", text: "zed here", sentAt: 1 } }));
        dave.session.sendChat("two");
        bob.session.sendChat("bob's");
        expect(alice.session.chat.map((e) => e.name)).toEqual(["Guest", "Guest", "Guest", "Bob"]);
        const keys = alice.session.chat.map((e) => e.key);
        alice.events.length = 0;

        dave.hello();
        expect(alice.session.chat.map((e) => e.name)).toEqual(["Dave", "Guest", "Dave", "Bob"]);
        expect(alice.events).toEqual([{ type: "chat", entry: expect.objectContaining({ peer: dave.peer, text: "two", name: "Dave" }), renamed: true }]);
        // The entries keep their place and keys.
        expect(alice.session.chat.map((e) => e.text)).toEqual(["one", "zed here", "two", "bob's"]);
        expect(alice.session.chat.map((e) => e.key)).toEqual(keys);
    });

    it("renames nothing, and says nothing, for a hello with no name or from a sender with no chat", () => {
        const net = network();
        const [alice] = room(net, "Alice");
        const dave = join(net, "Dave");
        dave.session.sendChat("hi");
        alice.events.length = 0;
        dave.hello(null);
        dave.hello("");
        expect(alice.session.chat[0].name).toBe("Guest");
        const carol = join(net, "Carol");
        carol.hello();
        expect(alice.events.filter((e) => e.type === "chat")).toEqual([]);
    });

    it("doesn't rename a sender already named, but does one first heard of after their chat - even chat from a catch-up", () => {
        const net = network();
        const zed = net.channel("zed", "zed~1");
        const newcomer = join(net, "Newcomer");
        zed.send(signal("hello", "zed", { name: "Zed" }));
        // A catch-up can carry 'Guest' for a sender this tab already knows by name.
        zed.send(
            signal("collab-sync", "zed", {
                to: newcomer.peer,
                sync: {
                    part: 0,
                    of: 1,
                    epoch: 0,
                    chat: [
                        { id: "a", peer: "zed~1", name: "Guest", text: "said before naming", sentAt: 1 },
                        { id: "b", peer: "yan~1", name: "Guest", text: "yan said", sentAt: 2 },
                    ],
                    ops: [],
                },
            }),
        );
        expect(newcomer.session.chat.map((e) => e.name)).toEqual(["Guest", "Guest"]);
        newcomer.events.length = 0;
        zed.send(signal("hello", "zed", { name: "Zed" }));
        expect(newcomer.session.chat.map((e) => e.name)).toEqual(["Guest", "Guest"]);
        expect(newcomer.events).toEqual([]);

        net.channel("yan", "yan~1").send(signal("hello", "yan", { name: "Yan" }));
        expect(newcomer.session.chat.map((e) => e.name)).toEqual(["Guest", "Yan"]);
        expect(newcomer.events).toEqual([{ type: "chat", entry: expect.objectContaining({ peer: "yan~1", name: "Yan", text: "yan said" }), renamed: true }]);
    });
});
