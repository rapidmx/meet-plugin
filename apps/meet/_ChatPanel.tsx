///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The in-call chat drawer, beside the call like the participants drawer (`_ParticipantsDrawer.tsx`) - `_CallView.tsx`
 * shows one or the other. The messages come from `CollabSession` (`apps/shared/collab/CollabSession.ts`) and are
 * rendered as Markdown by `ChatMarkdown` (bare links become links, image links become images).
 *
 * The composer is a textarea: Enter sends, Shift+Enter starts a new line. Its emoji button opens the web client's own
 * emoji picker and inserts at the cursor; its GIF button opens the web client's own Giphy picker, and picking a GIF
 * sends it at once as a message holding just its address - which every participant's chat then shows as the GIF
 * itself. Both pickers are the very components the mail composer uses (`@rapidmx/web-client`'s `EmojiPicker` and
 * `GifPicker`); GIF search goes through the server's own Giphy proxy, which a guest's token authenticates like a
 * signed-in user's session.
 *
 * The list follows new messages only while it is already scrolled to the bottom, so reading back through the history
 * isn't interrupted by someone else's message.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import EmojiPicker from "@rapidmx/web-client/shared/components/mail/compose/EmojiPicker.js";
import GifPicker from "@rapidmx/web-client/shared/components/mail/compose/GifPicker.js";
import ChatMarkdown from "../shared/collab/chatMarkdown.js";
import type { ChatEntry } from "../shared/collab/CollabSession.js";
import { MAX_CHAT_LENGTH } from "../shared/collab/protocol.js";
import { EmojiIcon, GifIcon, SendIcon } from "./_icons.js";

export interface ChatPanelProps {
    entries: readonly ChatEntry[];
    /** Sends a message; `false` when it could not be sent (blank or too long). */
    onSend: (text: string) => boolean;
    onClose: () => void;
}

/** How close to the bottom (px) still counts as "at the bottom" for following new messages. */
const STICK_THRESHOLD_PX = 48;
/** Within this many characters of `MAX_CHAT_LENGTH`, the composer shows how many are left. */
const COUNTER_THRESHOLD = 200;
/** Two messages from the same person this close together (ms) share one name heading. */
const GROUP_WINDOW_MS = 2 * 60_000;

const ICON_BUTTON =
    "w-9 h-9 shrink-0 flex items-center justify-center rounded-full hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:opacity-40 disabled:cursor-not-allowed";

function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function ChatPanel({ entries, onSend, onClose }: ChatPanelProps) {
    const [draft, setDraft] = useState("");
    const [picker, setPicker] = useState<"emoji" | "gif" | null>(null);
    const panelRef = useRef<HTMLElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const emojiButtonRef = useRef<HTMLButtonElement>(null);
    const gifButtonRef = useRef<HTMLButtonElement>(null);
    const stickRef = useRef(true);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        // Only an Escape meant for the chat - with focus in it - closes it, not one closing a menu elsewhere.
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !picker && panelRef.current?.contains(document.activeElement)) {
                onClose();
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose, picker]);

    useLayoutEffect(() => {
        const list = listRef.current;
        if (list && stickRef.current) {
            list.scrollTop = list.scrollHeight;
        }
    }, [entries]);

    function handleScroll() {
        const list = listRef.current!;
        stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= STICK_THRESHOLD_PX;
    }

    function send(text: string) {
        if (onSend(text)) {
            stickRef.current = true;
            return true;
        }
        return false;
    }

    function handleSubmit(event?: React.FormEvent) {
        event?.preventDefault();
        if (send(draft)) {
            setDraft("");
        }
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            handleSubmit();
        }
    }

    function insertEmoji(native: string) {
        const input = inputRef.current!;
        const start = input.selectionStart ?? draft.length;
        const end = input.selectionEnd ?? draft.length;
        setPicker(null);
        const next = draft.slice(0, start) + native + draft.slice(end);
        // Past the limit the emoji is left out whole, never cut in half.
        if (next.length > MAX_CHAT_LENGTH) {
            input.focus();
            return;
        }
        setDraft(next);
        requestAnimationFrame(() => {
            input.focus();
            input.setSelectionRange(start + native.length, start + native.length);
        });
    }

    function sendGif(url: string) {
        setPicker(null);
        send(url);
        inputRef.current?.focus();
    }

    const remaining = MAX_CHAT_LENGTH - draft.length;

    return (
        <aside ref={panelRef} role="dialog" aria-label="Chat" className="relative z-10 shrink-0 w-80 max-w-[85vw] h-full flex flex-col bg-[#2b2d30] text-white shadow-xl border-l border-white/10">
            <div className="flex items-center justify-between gap-2 px-3 py-3 border-b border-white/10">
                <h2 className="text-sm font-medium">Chat</h2>
                <button type="button" className={ICON_BUTTON} aria-label="Close chat" onClick={onClose}>
                    ✕
                </button>
            </div>
            <div ref={listRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto px-3 py-2" role="log" aria-label="Messages" aria-live="polite">
                {entries.length === 0 && <p className="mt-6 text-center text-sm text-white/60">Messages are visible to everyone in the call and disappear when it ends.</p>}
                {entries.map((entry, index) => {
                    const previous = entries[index - 1];
                    const grouped = !!previous && previous.peer === entry.peer && entry.sentAt - previous.sentAt < GROUP_WINDOW_MS && entry.sentAt >= previous.sentAt;
                    return (
                        <div key={entry.key} className={grouped ? "mt-1" : "mt-3"} data-testid="chat-message">
                            {!grouped && (
                                <p className="flex items-baseline gap-2 text-xs">
                                    <span className="font-semibold text-white">{entry.self ? "You" : entry.name}</span>
                                    <span className="text-white/50">{formatTime(entry.sentAt)}</span>
                                </p>
                            )}
                            <div className="mt-0.5 text-white/90">
                                <ChatMarkdown text={entry.text} />
                            </div>
                        </div>
                    );
                })}
            </div>
            <form onSubmit={handleSubmit} className="shrink-0 border-t border-white/10 p-2">
                <div className="flex items-end gap-1 rounded-2xl bg-[#3c4043] px-1 py-1">
                    <button ref={emojiButtonRef} type="button" className={ICON_BUTTON} aria-label="Insert emoji" aria-expanded={picker === "emoji"} onClick={() => setPicker((prev) => (prev === "emoji" ? null : "emoji"))}>
                        <EmojiIcon />
                    </button>
                    <button ref={gifButtonRef} type="button" className={ICON_BUTTON} aria-label="Send a GIF" aria-expanded={picker === "gif"} onClick={() => setPicker((prev) => (prev === "gif" ? null : "gif"))}>
                        <GifIcon />
                    </button>
                    <textarea
                        ref={inputRef}
                        rows={1}
                        value={draft}
                        maxLength={MAX_CHAT_LENGTH}
                        aria-label="Message"
                        placeholder="Send a message"
                        className="flex-1 min-w-0 max-h-32 resize-none bg-transparent py-2 px-1 text-sm placeholder:text-white/50 focus:outline-none [field-sizing:content]"
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={handleKeyDown}
                    />
                    <button type="submit" className={ICON_BUTTON} aria-label="Send message" disabled={!draft.trim()}>
                        <SendIcon />
                    </button>
                </div>
                <p className="mt-1 px-2 flex justify-between gap-2 text-[11px] text-white/50">
                    <span>**bold** *italic* `code` - Shift+Enter for a new line</span>
                    {remaining <= COUNTER_THRESHOLD && <span aria-live="polite">{remaining} left</span>}
                </p>
            </form>
            {picker === "emoji" && <EmojiPicker anchorRef={emojiButtonRef} onSelect={insertEmoji} onClose={() => setPicker(null)} />}
            {picker === "gif" && <GifPicker anchorRef={gifButtonRef} onSelect={sendGif} onClose={() => setPicker(null)} />}
        </aside>
    );
}
