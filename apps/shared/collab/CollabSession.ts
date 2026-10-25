///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The call's text chat and shared whiteboard, over the same signaling channel the mesh uses (`../webrtc/types.ts`'s
 * `chat`, `whiteboard`, `collab-sync-request` and `collab-sync` messages). Like everything else in a call they live
 * only as long as the call does - there is no server-side copy; each participant's tab holds them.
 *
 * ## Chat
 *
 * `sendChat()` broadcasts one `chat` message and shows it locally at once (the server never echoes a sender's own
 * messages). A received one is shown under the name its sender announced in their `hello`. At most
 * `MAX_CHAT_HISTORY` messages are kept.
 *
 * ## Whiteboard
 *
 * Every drawing action becomes a `WhiteboardOp`, applied to this tab's own `WhiteboardModel` at once and broadcast. A
 * stroke being drawn sends its points in batches every `POINT_FLUSH_MS` rather than one message per pointer move, so
 * the others watch it being drawn without a message per pixel. `undo()` erases this participant's own most recent
 * element still on the board.
 *
 * ## Pointers
 *
 * While a participant's pointer is over the board, `moveCursor()` tells everyone where it is and as which tool and
 * color, at most every `CURSOR_INTERVAL_MS`; `hideCursor()` says it left. While they are drawing a stroke, no pointer
 * messages are sent at all - everyone else moves their pointer along the stroke's own points instead. Pointers are
 * never stored or caught up on; one not heard from for `CURSOR_IDLE_MS` is dropped, as is a participant's on `bye`.
 *
 * ## Who may draw
 *
 * `setDrawPolicy()` limits who may change the board (talking-stick mode: only whoever holds the stick). This
 * participant's own drawing calls then do nothing unless it is allowed, and a received change from a participant who
 * isn't is ignored - as cooperative as every other moderation signal in the call (see `../webrtc/types.ts`): each
 * participant's own tab decides. A change in flight when the stick moves may land on some boards and not others.
 * Pointers still show for everyone - pointing at something isn't drawing it.
 *
 * ## Catching up
 *
 * Someone joining a call already under way asks one participant for what they missed: on the first `hello` it hears
 * within `SYNC_WINDOW_MS` of starting (an existing participant answering its own `hello`), it sends that participant a
 * `collab-sync-request`; the answer is the chat history and the board as ops, split into `collab-sync` parts that
 * each fit the server's message limit and paced `SYNC_PACE_MS` apart to stay inside its rate limit. When nothing has
 * arrived from that participant for `SYNC_TIMEOUT_MS` (first part or next), the next one is asked - as it is when the
 * whole answer was empty, which is what another newcomer who arrived moments earlier would send. Only the participant
 * asked is listened to, and a participant answers the same requester at most once per `SYNC_ANSWER_COOLDOWN_MS`. A catch-up is that one participant's account of the call, which this tab cannot check - the chat history it
 * carries names who said what, and the server stamps only the catch-up's own sender - so it is merged under the same
 * validation as live messages, and live messages win wherever the two overlap.
 */
import {
    BOARD_HEIGHT,
    BOARD_WIDTH,
    MAX_CHAT_HISTORY,
    MAX_CHAT_LENGTH,
    MAX_POINTS_PER_OP,
    MAX_STROKE_POINTS,
    clampCoordinate,
    parseChat,
    parseCursor,
    parseSync,
    parseWhiteboardOp,
    type BoardElement,
    type ChatHistoryEntry,
    type CursorTool,
    type PenType,
    type Stamp,
    type StencilShape,
    type WhiteboardOp,
} from "./protocol.js";
import { WhiteboardModel } from "./WhiteboardModel.js";
import type { SignalMessage, SignalingChannel } from "../webrtc/types.js";

/** How often the points of a stroke being drawn are sent. */
export const POINT_FLUSH_MS = 60;
/** How long after starting a `hello` still counts as an existing participant answering ours - see this module's doc. */
export const SYNC_WINDOW_MS = 15_000;
/** How long to wait for a catch-up to start arriving before asking someone else. */
export const SYNC_TIMEOUT_MS = 5_000;
/** The gap between two parts of a catch-up this participant sends. */
export const SYNC_PACE_MS = 250;
/** Room left in each catch-up part for the message's own envelope. */
export const SYNC_ENVELOPE_BYTES = 1024;
/** The most stroke points one catch-up op carries, so one op always fits the server's smallest message limit. */
export const SYNC_POINTS_PER_OP = 600;
/** The least time between two pointer messages this participant sends. */
export const CURSOR_INTERVAL_MS = 80;
/** How long a participant's pointer stays on the board without news of it. */
export const CURSOR_IDLE_MS = 30_000;
/** How long a participant waits before answering the same requester's catch-up request again. */
export const SYNC_ANSWER_COOLDOWN_MS = 10_000;
/** What a message is sized against when the channel doesn't say. */
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;

/** One chat message as shown. */
export interface ChatEntry {
    /** Unique within the call: the sender's peer id and their own message id. */
    key: string;
    id: string;
    peer: string;
    name: string;
    text: string;
    sentAt: number;
    self: boolean;
}

/** Another participant's pointer on the board. */
export interface RemoteCursor {
    peer: string;
    name: string;
    x: number;
    y: number;
    tool: CursorTool;
    color: string;
    stamp?: Stamp;
    /** When it last moved, by this tab's clock. */
    at: number;
}

/** A `chat` event with `history` set is a message from a catch-up - said before this participant arrived; one with
 * `renamed` set is a message already shown, now under its sender's name. Neither is news. */
export type CollabEvent = { type: "chat"; entry: ChatEntry; history?: boolean; renamed?: boolean } | { type: "board" } | { type: "cursors" };

/** What `CollabSession` needs from the signaling channel - `SignalingClient` is one. */
export interface CollabChannel extends SignalingChannel {
    /** The server's per-message limit, in bytes - `SignalingClient.maxMessageBytes`. */
    readonly maxMessageBytes?: number;
    /** The most a message's own JSON may take once sealed, in a protected meeting - `SignalingClient.maxPlainMessageBytes`. A catch-up
     * part sized to `maxMessageBytes` alone would grow past the limit when sealed, and the server would drop it. */
    readonly maxPlainMessageBytes?: number;
}

export interface CollabSessionOptions {
    channel: CollabChannel;
    /** The authenticated uid every message is sent `from`. */
    selfUid: string;
    /** This tab's peer id - the author of its chat messages and the prefix of its board elements' ids. */
    peerId: string;
    selfName: string;
    now?: () => number;
}

export class CollabSession {
    readonly board = new WhiteboardModel();
    private chatEntries: ChatEntry[] = [];
    /** How many of `chatEntries`, from the front, came from a catch-up - the next part's history goes after them. */
    private historyCount = 0;
    private readonly chatKeys = new Set<string>();
    private readonly names = new Map<string, string>();
    private readonly listeners = new Set<(event: CollabEvent) => void>();
    private readonly ownIds: string[] = [];
    private readonly outgoingPoints = new Map<string, { start: number; points: number[] }>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private flushTimer: ReturnType<typeof setTimeout> | undefined;
    private syncTimer: ReturnType<typeof setTimeout> | undefined;
    private syncTarget: string | undefined;
    private readonly syncTried = new Set<string>();
    private readonly knownPeers: string[] = [];
    private unsubscribe: (() => void) | undefined;
    private startedAt = 0;
    private seq = 0;
    private stopped = false;
    private readonly remoteCursors = new Map<string, RemoteCursor>();
    private cursorPending: { x: number; y: number; tool: CursorTool; color: string; stamp?: Stamp } | undefined;
    private cursorTimer: ReturnType<typeof setTimeout> | undefined;
    private cursorShown = false;
    private lastCursorSent = -Infinity;
    private pruneTimer: ReturnType<typeof setInterval> | undefined;
    /** The stroke this participant is drawing, between `beginStroke()` and `endStroke()`. */
    private activeStroke: string | undefined;
    private drawPolicy: ((peer: string) => boolean) | undefined;
    private readonly syncAnswered = new Map<string, number>();
    private syncReceivedAnything = false;

    constructor(private readonly options: CollabSessionOptions) {}

    /** Every chat message, oldest first. */
    get chat(): readonly ChatEntry[] {
        return this.chatEntries;
    }

    /** Everyone else's pointers currently on the board. */
    get cursors(): RemoteCursor[] {
        return [...this.remoteCursors.values()];
    }

    /** Whether this participant may change the board now - see this module's doc comment on who may draw. */
    get canDraw(): boolean {
        return this.mayDraw(this.options.peerId);
    }

    /** Limits who may change the board to the peers `policy` accepts; `undefined` lets everyone. */
    setDrawPolicy(policy: ((peer: string) => boolean) | undefined): void {
        this.drawPolicy = policy;
        if (!this.canDraw) {
            this.endStroke();
        }
    }

    onEvent(listener: (event: CollabEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    start(): void {
        if (this.unsubscribe || this.stopped) {
            return;
        }
        this.startedAt = this.now();
        this.unsubscribe = this.options.channel.onMessage((message) => this.handleMessage(message));
        this.pruneTimer = setInterval(() => this.pruneCursors(), CURSOR_IDLE_MS / 6);
    }

    stop(): void {
        if (this.stopped) {
            return;
        }
        // Before `stopped` is set, which makes `send()` drop everything.
        this.flushPoints();
        this.stopped = true;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        clearTimeout(this.flushTimer);
        clearTimeout(this.syncTimer);
        clearTimeout(this.cursorTimer);
        clearInterval(this.pruneTimer);
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.listeners.clear();
    }

    /** Sends `text` as a chat message. Returns `false`, sending nothing, for blank or overlong text. */
    sendChat(text: string): boolean {
        if (!text.trim() || text.length > MAX_CHAT_LENGTH || this.stopped) {
            return false;
        }
        const payload = { id: this.nextId(), text, sentAt: this.now() };
        this.send({ kind: "chat", chat: payload });
        this.addChat({ ...payload, peer: this.options.peerId, name: this.options.selfName }, true);
        return true;
    }

    /** Starts a stroke at (`x`, `y`); returns its id, or `undefined` when the board is full. */
    beginStroke(pen: PenType, color: string, size: number, x: number, y: number): string | undefined {
        const id = this.addElement({ kind: "stroke", id: this.nextElementId(), epoch: this.board.epoch, pen, color, size, points: [clampX(x), clampY(y)] });
        this.activeStroke = id;
        return id;
    }

    /** Adds a point to this participant's own stroke `id` - sent with the next batch. */
    extendStroke(id: string, x: number, y: number): void {
        const stroke = this.board.get(id);
        if (!stroke || stroke.kind !== "stroke" || stroke.points.length >= MAX_STROKE_POINTS * 2 || !this.canDraw) {
            return;
        }
        const point = [clampX(x), clampY(y)];
        const start = stroke.points.length / 2;
        if (!this.board.apply({ op: "points", id, start, points: point }, this.options.peerId)) {
            return;
        }
        const batch = this.outgoingPoints.get(id);
        if (batch) {
            batch.points.push(...point);
        } else {
            this.outgoingPoints.set(id, { start, points: point });
        }
        // A batch never outgrows what one op may carry, even if the timer below runs late.
        if ((batch?.points.length ?? 0) >= MAX_POINTS_PER_OP * 2) {
            this.flushPoints();
        }
        this.flushTimer ??= setTimeout(() => {
            this.flushTimer = undefined;
            this.flushPoints();
        }, POINT_FLUSH_MS);
        this.emit({ type: "board" });
    }

    /** Finishes a stroke: whatever points are still waiting go out now. */
    endStroke(): void {
        this.activeStroke = undefined;
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        this.flushPoints();
    }

    addShape(shape: StencilShape, color: string, size: number, x1: number, y1: number, x2: number, y2: number): string | undefined {
        const [a, b, c, d] = [clampX(x1), clampY(y1), clampX(x2), clampY(y2)];
        return this.addElement({ kind: "shape", id: this.nextElementId(), epoch: this.board.epoch, shape, color, size, x1: a, y1: b, x2: c, y2: d });
    }

    addStamp(stamp: Stamp, size: number, x: number, y: number): string | undefined {
        return this.addElement({ kind: "stamp", id: this.nextElementId(), epoch: this.board.epoch, stamp, size, x: clampX(x), y: clampY(y) });
    }

    /** Erases `ids` - anyone's elements, see `protocol.ts`. */
    erase(ids: string[]): void {
        const present = ids.filter((id) => this.board.get(id));
        if (present.length > 0 && this.canDraw) {
            this.applyAndSend({ op: "remove", ids: present });
        }
    }

    /** Erases this participant's own most recent element still on the board; `false` when there is none. */
    undo(): boolean {
        while (this.ownIds.length > 0 && this.canDraw) {
            const id = this.ownIds.pop()!;
            if (this.board.get(id)) {
                this.endStroke();
                this.applyAndSend({ op: "remove", ids: [id] });
                return true;
            }
        }
        return false;
    }

    /** Clears the board for everyone. */
    clear(): void {
        if (!this.canDraw || this.stopped) {
            return;
        }
        this.endStroke();
        this.applyAndSend({ op: "clear", epoch: this.board.epoch + 1 });
    }

    /** Says this participant's pointer is at (`x`, `y`) on the board, as `tool` in `color` (with `stamp` for the stamp
     * tool) - sent now, or with the latest position once `CURSOR_INTERVAL_MS` has passed since the last one. */
    moveCursor(x: number, y: number, tool: CursorTool, color: string, stamp?: Stamp): void {
        if (this.stopped) {
            return;
        }
        this.cursorPending = { x: clampX(x), y: clampY(y), tool, color, ...(stamp ? { stamp } : {}) };
        if (this.cursorTimer === undefined) {
            const wait = Math.max(0, this.lastCursorSent + CURSOR_INTERVAL_MS - this.now());
            this.cursorTimer = setTimeout(() => {
                this.cursorTimer = undefined;
                this.flushCursor();
            }, wait);
        }
    }

    /** Says this participant's pointer has left the board. */
    hideCursor(): void {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = undefined;
        this.cursorPending = undefined;
        if (this.cursorShown) {
            this.cursorShown = false;
            this.send({ kind: "whiteboard-cursor", cursor: { hidden: true } });
        }
    }

    private flushCursor(): void {
        const cursor = this.cursorPending;
        this.cursorPending = undefined;
        // Mid-stroke, the stroke's own points show where the pointer is - see this module's doc comment.
        if (!cursor || this.activeStroke !== undefined) {
            return;
        }
        this.lastCursorSent = this.now();
        this.cursorShown = true;
        this.send({ kind: "whiteboard-cursor", cursor });
    }

    private handleCursor(sender: string, raw: unknown): void {
        const cursor = parseCursor(raw);
        if (!cursor) {
            return;
        }
        if ("hidden" in cursor) {
            if (this.remoteCursors.delete(sender)) {
                this.emit({ type: "cursors" });
            }
            return;
        }
        this.remoteCursors.set(sender, { peer: sender, name: this.names.get(sender) ?? "Guest", ...cursor, at: this.now() });
        this.emit({ type: "cursors" });
    }

    /** Moves `sender`'s pointer to where their stroke just got to - see this module's doc comment on pointers. */
    private followStroke(sender: string, op: WhiteboardOp): void {
        const id = op.op === "add" ? op.element.id : op.op === "points" ? op.id : undefined;
        const stroke = id === undefined ? undefined : this.board.get(id);
        if (!stroke || stroke.kind !== "stroke") {
            return;
        }
        const previous = this.remoteCursors.get(sender);
        this.remoteCursors.set(sender, {
            peer: sender,
            name: this.names.get(sender) ?? "Guest",
            tool: stroke.pen,
            color: stroke.color,
            x: stroke.points[stroke.points.length - 2],
            y: stroke.points[stroke.points.length - 1],
            ...(previous?.tool === stroke.pen && previous.stamp ? { stamp: previous.stamp } : {}),
            at: this.now(),
        });
        this.emit({ type: "cursors" });
    }

    private pruneCursors(): void {
        const cutoff = this.now() - CURSOR_IDLE_MS;
        let changed = false;
        for (const [peer, cursor] of this.remoteCursors) {
            if (cursor.at < cutoff) {
                this.remoteCursors.delete(peer);
                changed = true;
            }
        }
        if (changed) {
            this.emit({ type: "cursors" });
        }
    }

    private mayDraw(peer: string): boolean {
        return !this.drawPolicy || this.drawPolicy(peer);
    }

    private addElement(element: BoardElement): string | undefined {
        if (!this.board.hasRoom || this.stopped || !this.canDraw) {
            return undefined;
        }
        this.endStroke();
        this.applyAndSend({ op: "add", element: element.kind === "stroke" ? { ...element, points: [...element.points] } : element });
        this.ownIds.push(element.id);
        return element.id;
    }

    private applyAndSend(op: WhiteboardOp): void {
        if (this.board.apply(op, this.options.peerId)) {
            this.emit({ type: "board" });
        }
        this.send({ kind: "whiteboard", whiteboard: op });
    }

    private flushPoints(): void {
        for (const [id, batch] of this.outgoingPoints) {
            this.send({ kind: "whiteboard", whiteboard: { op: "points", id, start: batch.start, points: batch.points } });
        }
        this.outgoingPoints.clear();
    }

    private handleMessage(message: SignalMessage): void {
        if (message.type !== "video-meeting-signal") {
            return;
        }
        const sender = message.peer ?? message.from;
        if (sender === this.options.peerId || (message.to !== undefined && message.to !== this.options.peerId)) {
            return;
        }
        switch (message.kind) {
            case "hello":
                this.handleHello(sender, message.name);
                return;
            case "bye":
                if (this.remoteCursors.delete(sender)) {
                    this.emit({ type: "cursors" });
                }
                return;
            case "whiteboard-cursor":
                this.handleCursor(sender, message.cursor);
                return;
            case "chat": {
                const chat = parseChat(message.chat);
                if (chat) {
                    this.addChat({ ...chat, peer: sender, name: this.names.get(sender) ?? "Guest" }, false);
                }
                return;
            }
            case "whiteboard": {
                const op = parseWhiteboardOp(message.whiteboard);
                if (op && this.mayDraw(sender) && this.board.apply(op, sender)) {
                    this.emit({ type: "board" });
                    this.followStroke(sender, op);
                }
                return;
            }
            case "collab-sync-request":
                this.sendSync(sender);
                return;
            case "collab-sync":
                this.receiveSync(sender, message.sync);
                return;
        }
    }

    private handleHello(sender: string, name: string | undefined): void {
        if (typeof name === "string" && name) {
            const known = this.names.has(sender);
            this.names.set(sender, name);
            // Chat that beat this participant's `hello` was shown as "Guest" - give it their name now.
            if (!known && this.chatEntries.some((entry) => entry.peer === sender && entry.name === "Guest")) {
                this.chatEntries = this.chatEntries.map((entry) => (entry.peer === sender && entry.name === "Guest" ? { ...entry, name } : entry));
                const own = this.chatEntries.filter((entry) => entry.peer === sender);
                const renamed = own[own.length - 1];
                this.emit({ type: "chat", entry: renamed, renamed: true });
            }
        }
        if (!this.knownPeers.includes(sender)) {
            this.knownPeers.push(sender);
        }
        if (this.syncTarget === undefined && this.syncTried.size === 0 && this.now() - this.startedAt < SYNC_WINDOW_MS) {
            this.requestSync(sender);
        }
    }

    private requestSync(peer: string): void {
        this.syncTarget = peer;
        this.syncTried.add(peer);
        this.syncReceivedAnything = false;
        this.send({ kind: "collab-sync-request", to: peer });
        this.armSyncTimeout();
    }

    /** Asks the next participant not yet asked, if any - after a silence or an empty answer. */
    private askNext(): void {
        this.syncTarget = undefined;
        const next = this.knownPeers.find((candidate) => !this.syncTried.has(candidate));
        if (next) {
            this.requestSync(next);
        }
    }

    private armSyncTimeout(): void {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            this.syncTimer = undefined;
            this.askNext();
        }, SYNC_TIMEOUT_MS);
    }

    private receiveSync(sender: string, raw: unknown): void {
        if (sender !== this.syncTarget) {
            return;
        }
        const sync = parseSync(raw);
        if (!sync) {
            return;
        }
        this.syncReceivedAnything ||= sync.chat.length > 0 || sync.ops.length > 0 || sync.epoch > 0;
        let boardChanged = this.board.apply({ op: "clear", epoch: sync.epoch }, null);
        for (const op of sync.ops) {
            boardChanged = this.board.apply(op, null) || boardChanged;
        }
        if (boardChanged) {
            this.emit({ type: "board" });
        }
        this.mergeHistory(sync.chat);
        if (sync.part < sync.of - 1) {
            this.armSyncTimeout();
            return;
        }
        clearTimeout(this.syncTimer);
        this.syncTimer = undefined;
        if (this.syncReceivedAnything) {
            this.syncTarget = undefined;
        } else {
            // Nothing at all - likely another newcomer who had nothing yet either. Someone else may have more.
            this.askNext();
        }
    }

    /** Sends `peer` everything said and drawn so far - see this module's doc comment. */
    private sendSync(peer: string): void {
        const answeredAt = this.syncAnswered.get(peer);
        if (answeredAt !== undefined && this.now() - answeredAt < SYNC_ANSWER_COOLDOWN_MS) {
            return;
        }
        this.syncAnswered.set(peer, this.now());
        const channel = this.options.channel;
        const budget = (channel.maxPlainMessageBytes ?? channel.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES) - SYNC_ENVELOPE_BYTES;
        const encoder = new TextEncoder();
        const parts: { chat: ChatHistoryEntry[]; ops: WhiteboardOp[] }[] = [];
        let current: { chat: ChatHistoryEntry[]; ops: WhiteboardOp[] } = { chat: [], ops: [] };
        let used = 0;
        const place = (item: { chat?: ChatHistoryEntry; op?: WhiteboardOp }) => {
            const size = encoder.encode(JSON.stringify(item.chat ?? item.op)).length + 1;
            if (used + size > budget && used > 0) {
                parts.push(current);
                current = { chat: [], ops: [] };
                used = 0;
            }
            if (item.chat) {
                current.chat.push(item.chat);
            } else {
                current.ops.push(item.op!);
            }
            used += size;
        };
        for (const entry of this.chatEntries) {
            place({ chat: { id: entry.id, peer: entry.peer, name: entry.name, text: entry.text, sentAt: entry.sentAt } });
        }
        for (const op of this.board.toOps(SYNC_POINTS_PER_OP)) {
            place({ op });
        }
        parts.push(current);
        const epoch = this.board.epoch;
        parts.forEach((part, index) => {
            const timer = setTimeout(() => {
                this.timers.delete(timer);
                this.send({ kind: "collab-sync", to: peer, sync: { part: index, of: parts.length, epoch, ...part } });
            }, index * SYNC_PACE_MS);
            this.timers.add(timer);
        });
    }

    private mergeHistory(history: ChatHistoryEntry[]): void {
        const fresh: ChatEntry[] = [];
        for (const entry of history) {
            const key = `${entry.peer}:${entry.id}`;
            if (!this.chatKeys.has(key)) {
                this.chatKeys.add(key);
                fresh.push({ ...entry, key, self: entry.peer === this.options.peerId });
            }
        }
        if (fresh.length === 0) {
            return;
        }
        // History comes before whatever arrived live while it travelled, and after the history of earlier parts.
        const merged = [...this.chatEntries.slice(0, this.historyCount), ...fresh, ...this.chatEntries.slice(this.historyCount)];
        this.historyCount += fresh.length;
        this.setChat(merged);
        for (const entry of fresh) {
            this.emit({ type: "chat", entry, history: true });
        }
    }

    private addChat(entry: Omit<ChatEntry, "key" | "self">, self: boolean): void {
        const key = `${entry.peer}:${entry.id}`;
        if (this.chatKeys.has(key)) {
            return;
        }
        this.chatKeys.add(key);
        const full: ChatEntry = { ...entry, key, self };
        this.setChat([...this.chatEntries, full]);
        this.emit({ type: "chat", entry: full });
    }

    /** Keeps the latest `MAX_CHAT_HISTORY` of `entries`. */
    private setChat(entries: ChatEntry[]): void {
        const dropped = Math.max(0, entries.length - MAX_CHAT_HISTORY);
        this.chatEntries = entries.slice(dropped);
        this.historyCount = Math.max(0, this.historyCount - dropped);
    }

    private send(partial: Omit<SignalMessage, "type" | "from">): void {
        if (this.stopped) {
            return;
        }
        this.options.channel.send({ type: "video-meeting-signal", from: this.options.selfUid, peer: this.options.peerId, ...partial });
    }

    private emit(event: CollabEvent): void {
        for (const listener of [...this.listeners]) {
            listener(event);
        }
    }

    private nextId(): string {
        this.seq += 1;
        return `${this.now().toString(36)}-${this.seq}`;
    }

    private nextElementId(): string {
        return `${this.options.peerId}:${this.nextId()}`;
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }
}

function clampX(x: number): number {
    return clampCoordinate(x, BOARD_WIDTH);
}

function clampY(y: number): number {
    return clampCoordinate(y, BOARD_HEIGHT);
}
