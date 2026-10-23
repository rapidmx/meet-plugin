// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../../../apps/shared/collab/CollabSession.js";
import { MAX_CHAT_LENGTH } from "../../../apps/shared/collab/protocol.js";

// The web client's own pickers, faked down to what the chat uses of them: picking something, and closing.
vi.mock("@rapidmx/web-client/shared/components/mail/compose/EmojiPicker.js", () => ({
    default: ({ onSelect, onClose }: { onSelect: (native: string) => void; onClose: () => void }) => (
        <div role="dialog" aria-label="Emoji picker">
            <button type="button" onClick={() => onSelect("😀")}>
                Pick grin
            </button>
            <button type="button" onClick={onClose}>
                Close emoji picker
            </button>
        </div>
    ),
}));
vi.mock("@rapidmx/web-client/shared/components/mail/compose/GifPicker.js", () => ({
    default: ({ onSelect, onClose }: { onSelect: (url: string) => void; onClose: () => void }) => (
        <div role="dialog" aria-label="GIF picker">
            <button type="button" onClick={() => onSelect("https://media.giphy.com/media/abc/giphy.gif")}>
                Pick cat
            </button>
            <button type="button" onClick={onClose}>
                Close GIF picker
            </button>
        </div>
    ),
}));

import ChatPanel, { type ChatPanelProps } from "../../../apps/meet/_ChatPanel.js";

const T0 = Date.UTC(2026, 9, 22, 15, 0, 0);

function entry(overrides: Partial<ChatEntry> & { id: string }): ChatEntry {
    const peer = overrides.peer ?? "zed~1";
    return { key: `${peer}:${overrides.id}`, peer, name: "Zed", text: `message ${overrides.id}`, sentAt: T0, self: false, ...overrides };
}

function renderPanel(overrides: Partial<ChatPanelProps> = {}) {
    const props: ChatPanelProps = { entries: [], onSend: vi.fn(() => true), onClose: vi.fn(), ...overrides };
    const result = render(<ChatPanel {...props} />);
    return { ...result, props };
}

const input = () => screen.getByRole("textbox", { name: "Message" });
const sendButton = () => screen.getByRole("button", { name: "Send message" });
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Animation frames requested and not yet run - `flushFrames()` runs them, as the browser would after React's commit. */
let frames: FrameRequestCallback[] = [];
function flushFrames() {
    const pending = frames;
    frames = [];
    act(() => pending.forEach((callback) => callback(0)));
}

beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ChatPanel - the messages", () => {
    it("says messages are visible to everyone and temporary while there are none", () => {
        renderPanel();
        expect(screen.getByRole("dialog", { name: "Chat" })).toBeInTheDocument();
        expect(screen.getByText(/Messages are visible to everyone in the call and disappear when it ends/)).toBeInTheDocument();
        expect(screen.queryAllByTestId("chat-message")).toHaveLength(0);
    });

    it("shows each message under its sender's name and time, 'You' for this participant's own, rendered as Markdown", () => {
        renderPanel({
            entries: [
                entry({ id: "1", text: "**hello** there" }),
                entry({ id: "2", peer: "me~1", name: "Alice", self: true, text: "hi", sentAt: T0 + 5 * 60_000 }),
            ],
        });
        expect(screen.queryByText(/Messages are visible/)).toBeNull();
        const [first, second] = screen.getAllByTestId("chat-message");
        expect(within(first).getByText("Zed")).toBeInTheDocument();
        expect(within(first).getByText(time(T0))).toBeInTheDocument();
        expect(within(first).getByText("hello").tagName).toBe("STRONG");
        expect(within(second).getByText("You")).toBeInTheDocument();
        expect(within(second).queryByText("Alice")).toBeNull();
        expect(within(second).getByText(time(T0 + 5 * 60_000))).toBeInTheDocument();
    });

    it("groups a sender's messages within two minutes under one heading - but not across a gap, another sender, or a clock going backwards", () => {
        renderPanel({
            entries: [
                entry({ id: "1", sentAt: T0 }),
                // Same sender a minute later: grouped.
                entry({ id: "2", sentAt: T0 + 60_000 }),
                // Same sender, exactly two minutes after the previous one: a new heading.
                entry({ id: "3", sentAt: T0 + 3 * 60_000 }),
                // Someone else, at once: a new heading.
                entry({ id: "4", peer: "yan~1", name: "Yan", sentAt: T0 + 3 * 60_000 }),
                // Yan again, but timestamped before their previous message: a new heading.
                entry({ id: "5", peer: "yan~1", name: "Yan", sentAt: T0 + 2 * 60_000 }),
            ],
        });
        const messages = screen.getAllByTestId("chat-message");
        const headed = messages.map((message) => message.querySelector("p.text-xs") !== null);
        expect(headed).toEqual([true, false, true, true, true]);
        expect(messages.map((message) => message.className)).toEqual(["mt-3", "mt-1", "mt-3", "mt-3", "mt-3"]);
        expect(within(messages[3]).getByText("Yan")).toBeInTheDocument();
    });
});

describe("ChatPanel - the composer", () => {
    it("focuses the message box on opening", () => {
        renderPanel();
        expect(input()).toHaveFocus();
        expect(input()).toHaveAttribute("maxLength", String(MAX_CHAT_LENGTH));
    });

    it("sends on Enter and clears the draft", () => {
        const { props } = renderPanel();
        type("hello");
        fireEvent.keyDown(input(), { key: "Enter" });
        expect(props.onSend).toHaveBeenCalledWith("hello");
        expect(input().value).toBe("");
    });

    it("does not send on Shift+Enter, or while an input method is composing", () => {
        const { props } = renderPanel();
        type("hello");
        fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
        fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
        fireEvent.keyDown(input(), { key: "a" });
        expect(props.onSend).not.toHaveBeenCalled();
        expect(input().value).toBe("hello");
    });

    it("keeps the draft when the message could not be sent", () => {
        const onSend = vi.fn(() => false);
        renderPanel({ onSend });
        type("too long, say");
        fireEvent.keyDown(input(), { key: "Enter" });
        expect(onSend).toHaveBeenCalledWith("too long, say");
        expect(input().value).toBe("too long, say");
    });

    it("disables the send button for a blank draft, and sends from it otherwise", () => {
        const { props } = renderPanel();
        expect(sendButton()).toBeDisabled();
        type("   \n ");
        expect(sendButton()).toBeDisabled();
        type("hi");
        expect(sendButton()).toBeEnabled();
        fireEvent.click(sendButton());
        expect(props.onSend).toHaveBeenCalledWith("hi");
        expect(input().value).toBe("");
    });

    it("shows how many characters are left only near the limit", () => {
        renderPanel();
        type("x".repeat(MAX_CHAT_LENGTH - 201));
        expect(screen.queryByText(/ left$/)).toBeNull();
        type("x".repeat(MAX_CHAT_LENGTH - 200));
        expect(screen.getByText("200 left")).toBeInTheDocument();
        type("x".repeat(MAX_CHAT_LENGTH));
        expect(screen.getByText("0 left")).toBeInTheDocument();
    });
});

describe("ChatPanel - emoji and GIFs", () => {
    it("opens and closes each picker from its button, one at a time, and from the picker's own close", () => {
        renderPanel();
        const emoji = screen.getByRole("button", { name: "Insert emoji" });
        const gif = screen.getByRole("button", { name: "Send a GIF" });
        expect(emoji).toHaveAttribute("aria-expanded", "false");

        fireEvent.click(emoji);
        expect(emoji).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByRole("dialog", { name: "Emoji picker" })).toBeInTheDocument();
        fireEvent.click(emoji);
        expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();

        fireEvent.click(emoji);
        fireEvent.click(gif);
        expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
        expect(screen.getByRole("dialog", { name: "GIF picker" })).toBeInTheDocument();
        expect(gif).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(gif);
        expect(screen.queryByRole("dialog", { name: "GIF picker" })).toBeNull();

        fireEvent.click(gif);
        fireEvent.click(screen.getByRole("button", { name: "Close GIF picker" }));
        expect(screen.queryByRole("dialog", { name: "GIF picker" })).toBeNull();
        fireEvent.click(emoji);
        fireEvent.click(screen.getByRole("button", { name: "Close emoji picker" }));
        expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
    });

    it("inserts an emoji in place of the selection, closes the picker, and puts the caret after it", () => {
        renderPanel();
        type("Hello world!");
        input().setSelectionRange(5, 11);
        fireEvent.click(screen.getByRole("button", { name: "Insert emoji" }));
        fireEvent.click(screen.getByRole("button", { name: "Pick grin" }));
        expect(input().value).toBe("Hello😀!");
        expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
        flushFrames();
        expect(input()).toHaveFocus();
        expect(input().selectionStart).toBe(5 + "😀".length);
        expect(input().selectionEnd).toBe(5 + "😀".length);
    });

    it("inserts at the caret", () => {
        renderPanel();
        type("ab");
        input().setSelectionRange(1, 1);
        fireEvent.click(screen.getByRole("button", { name: "Insert emoji" }));
        fireEvent.click(screen.getByRole("button", { name: "Pick grin" }));
        expect(input().value).toBe("a😀b");
    });

    it("appends an emoji when the box reports no selection, and never past the length limit", () => {
        renderPanel();
        type("hi");
        Object.defineProperty(input(), "selectionStart", { configurable: true, get: () => null });
        Object.defineProperty(input(), "selectionEnd", { configurable: true, get: () => null });
        const setSelectionRange = vi.spyOn(input(), "setSelectionRange");
        fireEvent.click(screen.getByRole("button", { name: "Insert emoji" }));
        fireEvent.click(screen.getByRole("button", { name: "Pick grin" }));
        expect(input().value).toBe("hi😀");
        flushFrames();
        expect(setSelectionRange).toHaveBeenCalledWith(2 + "😀".length, 2 + "😀".length);
    });

    it("leaves out whole an emoji that doesn't fit within the limit, closing the picker and refocusing the box", () => {
        renderPanel();
        // One character of room, and the emoji is two UTF-16 units long: it doesn't fit, and isn't cut in half.
        const draft = "x".repeat(MAX_CHAT_LENGTH - 1);
        type(draft);
        expect("😀".length).toBe(2);
        fireEvent.click(screen.getByRole("button", { name: "Insert emoji" }));
        input().blur();
        const setSelectionRange = vi.spyOn(input() as HTMLTextAreaElement, "setSelectionRange");
        fireEvent.click(screen.getByRole("button", { name: "Pick grin" }));
        expect(input().value).toBe(draft);
        expect(screen.queryByRole("dialog", { name: "Emoji picker" })).toBeNull();
        expect(input()).toHaveFocus();
        // Nothing was scheduled to move the caret.
        expect(frames).toHaveLength(0);
        expect(setSelectionRange).not.toHaveBeenCalled();
    });

    it("inserts an emoji that exactly fills the limit", () => {
        renderPanel();
        type("x".repeat(MAX_CHAT_LENGTH - 2));
        fireEvent.click(screen.getByRole("button", { name: "Insert emoji" }));
        fireEvent.click(screen.getByRole("button", { name: "Pick grin" }));
        expect(input().value).toBe(`${"x".repeat(MAX_CHAT_LENGTH - 2)}😀`);
    });

    it("sends a picked GIF's address as a message at once, leaving the draft alone", () => {
        const { props } = renderPanel();
        type("draft");
        fireEvent.click(screen.getByRole("button", { name: "Send a GIF" }));
        fireEvent.click(screen.getByRole("button", { name: "Pick cat" }));
        expect(props.onSend).toHaveBeenCalledWith("https://media.giphy.com/media/abc/giphy.gif");
        expect(screen.queryByRole("dialog", { name: "GIF picker" })).toBeNull();
        expect(input().value).toBe("draft");
        expect(input()).toHaveFocus();
    });
});

describe("ChatPanel - closing", () => {
    it("closes from its own button", () => {
        const { props } = renderPanel();
        fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape - but not while a picker is open, nor on another key", () => {
        const { props, unmount } = renderPanel();
        fireEvent.click(screen.getByRole("button", { name: "Insert emoji" }));
        fireEvent.keyDown(document, { key: "Escape" });
        expect(props.onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Close emoji picker" }));
        fireEvent.keyDown(document, { key: "Enter" });
        expect(props.onClose).not.toHaveBeenCalled();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(props.onClose).toHaveBeenCalledTimes(1);

        unmount();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape only while focus is inside the panel", () => {
        const { props } = renderPanel();
        const outside = document.createElement("button");
        outside.textContent = "elsewhere";
        document.body.appendChild(outside);
        try {
            outside.focus();
            expect(outside).toHaveFocus();
            fireEvent.keyDown(outside, { key: "Escape" });
            fireEvent.keyDown(document, { key: "Escape" });
            expect(props.onClose).not.toHaveBeenCalled();

            // Focus on any control in the panel, not just the message box, counts.
            screen.getByRole("button", { name: "Close chat" }).focus();
            fireEvent.keyDown(document.activeElement!, { key: "Escape" });
            expect(props.onClose).toHaveBeenCalledTimes(1);
        } finally {
            outside.remove();
        }
    });
});

describe("ChatPanel - following new messages", () => {
    /** Gives the message list a fixed geometry, and a `scrollTop` that remembers what it was set to. */
    function stubGeometry(list: HTMLElement, scrollHeight: number, clientHeight: number) {
        let top = 0;
        Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => scrollHeight });
        Object.defineProperty(list, "clientHeight", { configurable: true, get: () => clientHeight });
        Object.defineProperty(list, "scrollTop", {
            configurable: true,
            get: () => top,
            set: (value: number) => {
                top = value;
            },
        });
        return {
            setHeight: (value: number) => {
                scrollHeight = value;
            },
        };
    }

    it("scrolls to a new message while at the bottom, stays put while reading back, and follows again after sending", () => {
        const entries = [entry({ id: "1" })];
        const { props, rerender } = renderPanel({ entries });
        const list = screen.getByRole("log", { name: "Messages" });
        const geometry = stubGeometry(list, 1000, 200);

        let next = [...entries, entry({ id: "2" })];
        rerender(<ChatPanel {...props} entries={next} />);
        expect(list.scrollTop).toBe(1000);

        // Near enough to the bottom still counts as at the bottom.
        list.scrollTop = 760;
        fireEvent.scroll(list);
        geometry.setHeight(1100);
        next = [...next, entry({ id: "3" })];
        rerender(<ChatPanel {...props} entries={next} />);
        expect(list.scrollTop).toBe(1100);

        // Reading back: a new message doesn't move the list.
        list.scrollTop = 100;
        fireEvent.scroll(list);
        geometry.setHeight(1200);
        next = [...next, entry({ id: "4" })];
        rerender(<ChatPanel {...props} entries={next} />);
        expect(list.scrollTop).toBe(100);

        // A refused send changes nothing...
        (props.onSend as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
        type("nope");
        fireEvent.keyDown(input(), { key: "Enter" });
        next = [...next, entry({ id: "5" })];
        rerender(<ChatPanel {...props} entries={next} />);
        expect(list.scrollTop).toBe(100);

        // ...but sending one's own message jumps back to the bottom.
        type("mine");
        fireEvent.keyDown(input(), { key: "Enter" });
        geometry.setHeight(1300);
        act(() => {
            rerender(<ChatPanel {...props} entries={[...next, entry({ id: "6", self: true })]} />);
        });
        expect(list.scrollTop).toBe(1300);
    });

    it("jumps back to the bottom after sending a GIF, too", () => {
        const entries = [entry({ id: "1" })];
        const { props, rerender } = renderPanel({ entries });
        const list = screen.getByRole("log", { name: "Messages" });
        stubGeometry(list, 1000, 200);
        list.scrollTop = 0;
        fireEvent.scroll(list);

        fireEvent.click(screen.getByRole("button", { name: "Send a GIF" }));
        fireEvent.click(screen.getByRole("button", { name: "Pick cat" }));
        rerender(<ChatPanel {...props} entries={[...entries, entry({ id: "2", self: true })]} />);
        expect(list.scrollTop).toBe(1000);
    });
});
