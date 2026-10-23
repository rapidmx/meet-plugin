///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Renders a chat message's Markdown as React elements - never as HTML. A message is another participant's text, so it
 * is parsed here into a small set of known elements and everything else stays literal text that React escapes; there
 * is no `dangerouslySetInnerHTML` anywhere, and a raw `<script>` in a message is shown as those characters.
 *
 * What it understands - the everyday subset of Markdown people type into chat:
 *
 * - Blocks: paragraphs (a single line break is kept as a break), `#`/`##`/`###` headings, `>` quotes, `-`/`*`/`+`
 * bulleted and `1.` numbered lists, and ``` fenced code blocks.
 * - Inline: `**bold**`/`__bold__`, `*italic*`/`_italic_`, `~~strikethrough~~`, `` `code` ``, `[text](url)` links,
 * `![alt](url)` images, and a backslash to keep any of those characters literal.
 * - A bare `http(s)://` address becomes a link - and when it points at an image (by its file extension, as a GIF
 * from the GIF picker does), the image itself is shown instead, falling back to the link if it doesn't load.
 * - A message of nothing but one to three emoji is shown large.
 *
 * Only `http:`, `https:` and `mailto:` links are made clickable (anything else, `javascript:` included, stays text);
 * links open in a new tab without a referrer, and images load without one either.
 */
import React, { useState } from "react";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;
const ONLY_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9]️?⃣|\s)+$/u;
/** The deepest a quote may nest, or inline formatting may nest inside itself. */
const MAX_DEPTH = 4;

/** `url` when it is safe to link to (`http:`, `https:`, `mailto:`), else `undefined`. */
export function safeLinkUrl(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined;
    } catch {
        return undefined;
    }
}

/** `url` when it is safe to load as an image (`http:`, `https:`), else `undefined`. */
export function safeImageUrl(url: string): string | undefined {
    const safe = safeLinkUrl(url);
    return safe && !safe.startsWith("mailto:") ? safe : undefined;
}

/** Whether `url` names an image by its path's file extension (query and fragment aside). */
export function isImageUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && IMAGE_EXTENSIONS.test(parsed.pathname);
    } catch {
        return false;
    }
}

/** Whether `text` is just one to three emoji (and whitespace) - shown large. */
export function isEmojiOnly(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || !ONLY_EMOJI.test(trimmed) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣/u.test(trimmed)) {
        return false;
    }
    // Count what a reader sees as one emoji each: a ZWJ sequence, skin tone or variation selector belongs to the emoji
    // before it, and a flag is a pair of regional indicators.
    const base = trimmed.replace(/\s+/g, "").replace(/‍\p{Extended_Pictographic}/gu, "").replace(/[\p{Emoji_Modifier}️⃣]/gu, "");
    const flags = (base.match(/\p{Regional_Indicator}/gu)?.length ?? 0) / 2;
    const others = base.replace(/\p{Regional_Indicator}/gu, "").match(/\p{Extended_Pictographic}|[#*0-9]/gu)?.length ?? 0;
    return Math.ceil(flags) + others <= 3;
}

/** The end of a bare URL starting at the beginning of `text`: trailing punctuation that more likely ends the sentence
 * than the address is left out, and a closing parenthesis only stays when the address opened one. */
export function bareUrlLength(text: string): number {
    const match = BARE_URL.exec(text);
    if (!match) {
        return 0;
    }
    let url = match[0];
    for (;;) {
        const last = url[url.length - 1];
        if (".,;:!?'\"*_~".includes(last)) {
            url = url.slice(0, -1);
        } else if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
            url = url.slice(0, -1);
        } else {
            break;
        }
    }
    return url.length;
}

type Block =
    | { type: "paragraph"; lines: string[] }
    | { type: "heading"; level: 1 | 2 | 3; text: string }
    | { type: "code"; text: string }
    | { type: "quote"; blocks: Block[] }
    | { type: "list"; ordered: boolean; start: number; items: string[] };

const FENCE = /^\s*```/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

/** Splits `text` into blocks - see this module's doc comment for which. */
export function parseBlocks(text: string, depth = 0): Block[] {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const blocks: Block[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }
        if (FENCE.test(line)) {
            const body: string[] = [];
            i++;
            while (i < lines.length && !FENCE.test(lines[i])) {
                body.push(lines[i++]);
            }
            i++;
            blocks.push({ type: "code", text: body.join("\n") });
            continue;
        }
        if (QUOTE.test(line) && depth < MAX_DEPTH) {
            const body: string[] = [];
            while (i < lines.length && QUOTE.test(lines[i])) {
                body.push(QUOTE.exec(lines[i++])![1]);
            }
            blocks.push({ type: "quote", blocks: parseBlocks(body.join("\n"), depth + 1) });
            continue;
        }
        const heading = HEADING.exec(line);
        if (heading) {
            blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] });
            i++;
            continue;
        }
        if (BULLET.test(line) || NUMBERED.test(line)) {
            const ordered = !BULLET.test(line);
            const pattern = ordered ? NUMBERED : BULLET;
            const items: string[] = [];
            const start = ordered ? Number(NUMBERED.exec(line)![1]) : 1;
            while (i < lines.length && pattern.test(lines[i])) {
                const match = pattern.exec(lines[i++])!;
                items.push(ordered ? match[2] : match[1]);
            }
            blocks.push({ type: "list", ordered, start, items });
            continue;
        }
        const paragraph: string[] = [];
        // Past MAX_DEPTH a quote line is plain text - stopping at it here would leave `i` where it is, for ever.
        while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && (depth >= MAX_DEPTH || !QUOTE.test(lines[i])) &&!HEADING.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
            paragraph.push(lines[i++]);
        }
        blocks.push({ type: "paragraph", lines: paragraph });
    }
    return blocks;
}

const ESCAPABLE = "\\`*_~[]()!#>-+.";
const EMPHASIS: { marker: string; tag: "strong" | "em" | "del" }[] = [
    { marker: "**", tag: "strong" },
    { marker: "__", tag: "strong" },
    { marker: "~~", tag: "del" },
    { marker: "*", tag: "em" },
    { marker: "_", tag: "em" },
];

/** Where the `[text](url)` (or image) starting at `open` (the `[`) ends, with its parts - or `undefined`. */
function readLink(text: string, open: number): { label: string; url: string; end: number } | undefined {
    let depth = 0;
    let close = -1;
    for (let j = open; j < text.length; j++) {
        if (text[j] === "\\") {
            j++;
        } else if (text[j] === "[") {
            depth++;
        } else if (text[j] === "]" && --depth === 0) {
            close = j;
            break;
        }
    }
    if (close < 0 || text[close + 1] !== "(") {
        return undefined;
    }
    const end = text.indexOf(")", close + 2);
    if (end < 0) {
        return undefined;
    }
    const url = text.slice(close + 2, end).trim();
    return url && !/\s/.test(url) ? { label: text.slice(open + 1, close), url, end: end + 1 } : undefined;
}

/** Renders `text`'s inline formatting - see this module's doc comment. `inLink` stops a link nesting in a link. */
export function renderInline(text: string, keyPrefix = "i", depth = 0, inLink = false): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    let plain = "";
    const flush = () => {
        if (plain) {
            nodes.push(plain);
            plain = "";
        }
    };
    const key = () => `${keyPrefix}-${nodes.length}`;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === "\\" && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
            plain += text[i + 1];
            i += 2;
            continue;
        }
        if (ch === "`") {
            const close = text.indexOf("`", i + 1);
            if (close > i + 1) {
                flush();
                nodes.push(
                    <code key={key()} className="px-1 rounded bg-black/30 font-mono text-[0.9em]">
                        {text.slice(i + 1, close)}
                    </code>,
                );
                i = close + 1;
                continue;
            }
        }
        if (ch === "!" && text[i + 1] === "[" && !inLink) {
            const link = readLink(text, i + 1);
            const src = link && safeImageUrl(link.url);
            if (link && src) {
                flush();
                nodes.push(<ChatImage key={key()} src={src} alt={link.label} />);
                i = link.end;
                continue;
            }
        }
        if (ch === "[" && !inLink) {
            const link = readLink(text, i);
            const href = link && safeLinkUrl(link.url);
            if (link && href) {
                flush();
                nodes.push(
                    <ChatLink key={key()} href={href}>
                        {depth < MAX_DEPTH ? renderInline(link.label, key(), depth + 1, true) : link.label}
                    </ChatLink>,
                );
                i = link.end;
                continue;
            }
        }
        if ((ch === "h" || ch === "H") && !inLink && (i === 0 || !/[\w/]/.test(text[i - 1]))) {
            const length = bareUrlLength(text.slice(i));
            if (length > 0) {
                const url = text.slice(i, i + length);
                const href = safeLinkUrl(url);
                if (href) {
                    flush();
                    nodes.push(isImageUrl(href) ? <ChatImage key={key()} src={href} alt="" fallbackLabel={url} /> : <ChatLink key={key()} href={href}>{url}</ChatLink>);
                    i += length;
                    continue;
                }
            }
        }
        const emphasis = depth < MAX_DEPTH ? EMPHASIS.find(({ marker }) => text.startsWith(marker, i)) : undefined;
        if (emphasis) {
            const { marker, tag } = emphasis;
            const contentStart = i + marker.length;
            // An underscore inside a word (snake_case) is not emphasis.
            const intraword = marker[0] === "_" && i > 0 && /\w/.test(text[i - 1]);
            let close = text.indexOf(marker, contentStart);
            while (close > contentStart && marker === "*" && text[close + 1] === "*") {
                close = text.indexOf(marker, close + 2);
            }
            const inner = close > contentStart ? text.slice(contentStart, close) : "";
            const closesIntraword = marker[0] === "_" && /\w/.test(text[close + marker.length] ?? "");
            if (!intraword && inner && !/^\s/.test(inner) && !/\s$/.test(inner) && !closesIntraword) {
                flush();
                const Tag = tag;
                nodes.push(<Tag key={key()}>{renderInline(inner, key(), depth + 1, inLink)}</Tag>);
                i = close + marker.length;
                continue;
            }
        }
        plain += ch;
        i++;
    }
    flush();
    return nodes;
}

function ChatLink({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-[#8ab4f8] underline break-all">
            {children}
        </a>
    );
}

/** An image in a message, linking to itself. One that fails to load becomes a plain link (`fallbackLabel`, its
 * address, for a bare URL) or, for `![alt](url)`, its alt text as a link. */
export function ChatImage({ src, alt, fallbackLabel }: { src: string; alt: string; fallbackLabel?: string }) {
    const [failed, setFailed] = useState(false);
    if (failed) {
        return <ChatLink href={src}>{fallbackLabel ?? (alt || src)}</ChatLink>;
    }
    return (
        <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="block my-1 w-fit">
            <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" className="max-h-60 max-w-full rounded-lg" onError={() => setFailed(true)} />
        </a>
    );
}

function renderBlocks(blocks: Block[], keyPrefix: string): React.ReactNode[] {
    return blocks.map((block, index) => {
        const key = `${keyPrefix}-${index}`;
        switch (block.type) {
            case "paragraph":
                return (
                    <p key={key} className="whitespace-pre-wrap break-words">
                        {block.lines.map((line, n) => (
                            <React.Fragment key={n}>
                                {n > 0 && <br />}
                                {renderInline(line, `${key}-${n}`)}
                            </React.Fragment>
                        ))}
                    </p>
                );
            case "heading": {
                const sizes = { 1: "text-lg", 2: "text-base", 3: "text-sm" };
                return (
                    <p key={key} role="heading" aria-level={block.level} className={`${sizes[block.level]} font-semibold break-words`}>
                        {renderInline(block.text, key)}
                    </p>
                );
            }
            case "code":
                return (
                    <pre key={key} className="my-1 p-2 rounded-lg bg-black/30 font-mono text-xs overflow-x-auto">
                        <code>{block.text}</code>
                    </pre>
                );
            case "quote":
                return (
                    <blockquote key={key} className="my-1 pl-2 border-l-2 border-white/30 text-white/80">
                        {renderBlocks(block.blocks, key)}
                    </blockquote>
                );
            case "list": {
                const items = block.items.map((item, n) => (
                    <li key={n} className="break-words">
                        {renderInline(item, `${key}-${n}`)}
                    </li>
                ));
                return block.ordered ? (
                    <ol key={key} start={block.start} className="list-decimal pl-5">
                        {items}
                    </ol>
                ) : (
                    <ul key={key} className="list-disc pl-5">
                        {items}
                    </ul>
                );
            }
        }
    });
}

/** One chat message's text, rendered - see this module's doc comment. */
export default function ChatMarkdown({ text }: { text: string }) {
    if (isEmojiOnly(text)) {
        return <p className="text-4xl leading-tight">{text.trim()}</p>;
    }
    return <div className="space-y-1 text-sm">{renderBlocks(parseBlocks(text), "b")}</div>;
}
