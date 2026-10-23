// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChatMarkdown, {
    ChatImage,
    bareUrlLength,
    isEmojiOnly,
    isImageUrl,
    parseBlocks,
    renderInline,
    safeImageUrl,
    safeLinkUrl,
} from "../../../../apps/shared/collab/chatMarkdown.js";

/** Renders `text` and returns the message's root element. */
function md(text: string): HTMLElement {
    const { container } = render(<ChatMarkdown text={text} />);
    return container.firstElementChild as HTMLElement;
}

/** Renders inline-only nodes in a span, for `renderInline()`'s own tests. */
function inline(text: string): HTMLElement {
    const { container } = render(<span>{renderInline(text)}</span>);
    return container.firstElementChild as HTMLElement;
}

describe("safeLinkUrl", () => {
    it.each([
        ["http://example.com/a?b=c#d", "http://example.com/a?b=c#d"],
        ["https://example.com", "https://example.com/"],
        ["HTTPS://EXAMPLE.COM/Path", "https://example.com/Path"],
        ["mailto:someone@example.com", "mailto:someone@example.com"],
    ])("accepts %s", (url, expected) => {
        expect(safeLinkUrl(url)).toBe(expected);
    });

    it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd", "ftp://example.com", "not a url", "/relative", ""])(
        "refuses %s",
        (url) => {
            expect(safeLinkUrl(url)).toBeUndefined();
        },
    );
});

describe("safeImageUrl", () => {
    it("accepts http and https", () => {
        expect(safeImageUrl("http://x.com/a.png")).toBe("http://x.com/a.png");
        expect(safeImageUrl("https://x.com/a.png")).toBe("https://x.com/a.png");
    });

    it("refuses mailto, javascript and garbage", () => {
        expect(safeImageUrl("mailto:a@b.c")).toBeUndefined();
        expect(safeImageUrl("javascript:alert(1)")).toBeUndefined();
        expect(safeImageUrl("::::")).toBeUndefined();
    });
});

describe("isImageUrl", () => {
    it.each(["https://x.com/a.png", "http://x.com/a.JPG", "https://x.com/a.jpeg", "https://x.com/a.gif", "https://x.com/a.webp", "https://x.com/a.avif", "https://x.com/a.bmp", "https://x.com/a.svg"])(
        "recognizes %s",
        (url) => {
            expect(isImageUrl(url)).toBe(true);
        },
    );

    it("looks at the path only, not the query or fragment", () => {
        expect(isImageUrl("https://media.giphy.com/media/abc/giphy.gif?cid=x&rid=giphy.gif")).toBe(true);
        expect(isImageUrl("https://x.com/page?file=a.png")).toBe(false);
        expect(isImageUrl("https://x.com/page#a.png")).toBe(false);
    });

    it("refuses what isn't an http(s) image URL", () => {
        expect(isImageUrl("https://x.com/a.pngx")).toBe(false);
        expect(isImageUrl("https://x.com/")).toBe(false);
        expect(isImageUrl("ftp://x.com/a.png")).toBe(false);
        expect(isImageUrl("javascript:a.png")).toBe(false);
        expect(isImageUrl("a.png")).toBe(false);
    });
});

describe("isEmojiOnly", () => {
    it.each([
        ["one emoji", "😀"],
        ["three emoji", "😀🎉🔥"],
        ["emoji with spaces around", "  👍 👍  "],
        ["a ZWJ family", "👨‍👩‍👧‍👦"],
        ["three ZWJ sequences", "👨‍👩‍👧‍👦👩🏽‍💻🏳️‍🌈"],
        ["a skin tone", "👍🏽"],
        ["three skin-toned emoji", "👍🏻👋🏿🙏🏽"],
        ["a flag", "🇫🇷"],
        ["three flags", "🇫🇷🇩🇪🇯🇵"],
        ["a keycap", "1️⃣"],
        ["three keycaps", "#️⃣*️⃣9️⃣"],
        ["an emoji with a variation selector", "❤️"],
        ["a lone regional indicator", "🇫"],
    ])("is true for %s", (_label, text) => {
        expect(isEmojiOnly(text)).toBe(true);
    });

    it.each([
        ["four emoji", "😀😀😀😀"],
        ["four flags", "🇫🇷🇩🇪🇯🇵🇺🇸"],
        ["four keycaps", "1️⃣2️⃣3️⃣4️⃣"],
        ["four ZWJ families", "👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦"],
        ["emoji and text", "👍 ok"],
        ["text", "hello"],
        ["digits", "123"],
        ["empty", ""],
        ["blank", "   "],
        ["a lone variation selector", "️"],
        ["a lone skin tone modifier", "🏽"],
        ["a lone keycap mark", "⃣"],
        ["a ZWJ alone", "‍"],
    ])("is false for %s", (_label, text) => {
        expect(isEmojiOnly(text)).toBe(false);
    });
});

describe("bareUrlLength", () => {
    it("is 0 when the text doesn't start with an http(s) URL", () => {
        expect(bareUrlLength("hello http://x.com")).toBe(0);
        expect(bareUrlLength("ftp://x.com")).toBe(0);
        expect(bareUrlLength("http://")).toBe(0);
    });

    it("stops at whitespace and characters that can't be in a bare URL", () => {
        expect(bareUrlLength("https://x.com/a b")).toBe("https://x.com/a".length);
        expect(bareUrlLength('https://x.com/a"b')).toBe("https://x.com/a".length);
        expect(bareUrlLength("https://x.com/a<b>")).toBe("https://x.com/a".length);
    });

    it.each([".", ",", ";", ":", "!", "?", "'", '"', "*", "_", "~", "...", "!?", ")."])("leaves trailing %s out", (tail) => {
        expect(bareUrlLength(`https://x.com/a${tail}`)).toBe("https://x.com/a".length);
    });

    it("keeps a closing parenthesis the address opened, and drops one it didn't", () => {
        expect(bareUrlLength("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)".length);
        expect(bareUrlLength("https://x.com/a)")).toBe("https://x.com/a".length);
        expect(bareUrlLength("https://x.com/(a))")).toBe("https://x.com/(a)".length);
        expect(bareUrlLength("https://x.com/(a)).")).toBe("https://x.com/(a)".length);
    });

    it("keeps punctuation inside the address", () => {
        expect(bareUrlLength("https://x.com/a.b?c=d,e!f")).toBe("https://x.com/a.b?c=d,e!f".length);
    });
});

describe("parseBlocks", () => {
    it("splits paragraphs at blank lines, keeping single line breaks inside one", () => {
        expect(parseBlocks("one\ntwo\n\n\nthree")).toEqual([
            { type: "paragraph", lines: ["one", "two"] },
            { type: "paragraph", lines: ["three"] },
        ]);
    });

    it("normalizes CRLF and CR line endings", () => {
        expect(parseBlocks("a\r\nb\rc")).toEqual([{ type: "paragraph", lines: ["a", "b", "c"] }]);
    });

    it("returns nothing for blank text", () => {
        expect(parseBlocks("")).toEqual([]);
        expect(parseBlocks(" \n\t\n")).toEqual([]);
    });

    it("reads headings of levels 1 to 3 only", () => {
        expect(parseBlocks("# One\n## Two\n### Three\n#### Four\n#NoSpace")).toEqual([
            { type: "heading", level: 1, text: "One" },
            { type: "heading", level: 2, text: "Two" },
            { type: "heading", level: 3, text: "Three" },
            { type: "paragraph", lines: ["#### Four", "#NoSpace"] },
        ]);
    });

    it("ends a paragraph at a heading, list, quote or fence", () => {
        expect(parseBlocks("p\n# h\np\n- b\np\n1. n\np\n> q\np\n```\nc\n```").map((b) => b.type)).toEqual([
            "paragraph",
            "heading",
            "paragraph",
            "list",
            "paragraph",
            "list",
            "paragraph",
            "quote",
            "paragraph",
            "code",
        ]);
    });

    it("reads fenced code verbatim, closed or not", () => {
        expect(parseBlocks("```js\n# not a heading\n  - not a list\n\n**x**\n```\nafter")).toEqual([
            { type: "code", text: "# not a heading\n  - not a list\n\n**x**" },
            { type: "paragraph", lines: ["after"] },
        ]);
        expect(parseBlocks("```\nnever closed\nstill code")).toEqual([{ type: "code", text: "never closed\nstill code" }]);
        expect(parseBlocks("```")).toEqual([{ type: "code", text: "" }]);
    });

    it("reads bulleted lists with any marker, one list per run of the same kind", () => {
        expect(parseBlocks("- a\n* b\n+ c\n1. d")).toEqual([
            { type: "list", ordered: false, start: 1, items: ["a", "b", "c"] },
            { type: "list", ordered: true, start: 1, items: ["d"] },
        ]);
    });

    it("reads numbered lists from their first number, with . or )", () => {
        expect(parseBlocks("3. c\n4) d\n9. e")).toEqual([{ type: "list", ordered: true, start: 3, items: ["c", "d", "e"] }]);
        expect(parseBlocks("1234567890. too long")).toEqual([{ type: "paragraph", lines: ["1234567890. too long"] }]);
        expect(parseBlocks("-no space")).toEqual([{ type: "paragraph", lines: ["-no space"] }]);
    });

    it("reads quotes, nested, with their own blocks", () => {
        expect(parseBlocks("> a\n> > b\n>\n> - c\nafter")).toEqual([
            {
                type: "quote",
                blocks: [
                    { type: "paragraph", lines: ["a"] },
                    { type: "quote", blocks: [{ type: "paragraph", lines: ["b"] }] },
                    { type: "list", ordered: false, start: 1, items: ["c"] },
                ],
            },
            { type: "paragraph", lines: ["after"] },
        ]);
    });

    it("nests quotes at most four deep, keeping deeper markers as text", () => {
        let blocks = parseBlocks("> > > > > > deep");
        for (let depth = 0; depth < 4; depth++) {
            expect(blocks).toHaveLength(1);
            expect(blocks[0].type).toBe("quote");
            blocks = (blocks[0] as Extract<(typeof blocks)[number], { type: "quote" }>).blocks;
        }
        expect(blocks).toEqual([{ type: "paragraph", lines: ["> > deep"] }]);
    });

    it("keeps quote lines past the depth limit in one paragraph with what follows", () => {
        expect(parseBlocks("> x\n> y\nz", 4)).toEqual([{ type: "paragraph", lines: ["> x", "> y", "z"] }]);
    });
});

describe("renderInline", () => {
    it("returns plain text as one string", () => {
        expect(renderInline("just text")).toEqual(["just text"]);
        expect(renderInline("")).toEqual([]);
    });

    it("renders bold, italic, strikethrough and code", () => {
        const span = inline("**b** __B__ *i* _I_ ~~s~~ `c`");
        expect([...span.querySelectorAll("strong")].map((e) => e.textContent)).toEqual(["b", "B"]);
        expect([...span.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["i", "I"]);
        expect(span.querySelector("del")!.textContent).toBe("s");
        expect(span.querySelector("code")!.textContent).toBe("c");
        expect(span.textContent).toBe("b B i I s c");
    });

    it("nests emphasis, and italic around bold", () => {
        const span = inline("**bold *and italic* too**");
        expect(span.querySelector("strong > em")!.textContent).toBe("and italic");
        expect(span.querySelector("strong")!.textContent).toBe("bold and italic too");
        const other = inline("*a **b** c*");
        expect(other.querySelector("em > strong")!.textContent).toBe("b");
        expect(other.querySelector("em")!.textContent).toBe("a b c");
        expect(inline("~~**_x_**~~").querySelector("del > strong > em")!.textContent).toBe("x");
    });

    it("stops nesting emphasis four deep, keeping deeper markers as text", () => {
        const span = inline("**__~~*_x_*~~__**");
        expect(span.querySelector("strong > strong > del > em")!.textContent).toBe("_x_");
        expect(span.querySelector("em em")).toBeNull();
    });

    it("leaves code spans unformatted, and an empty or unclosed one literal", () => {
        const span = inline("`**not bold** [x](http://a.com)`");
        expect(span.querySelector("code")!.textContent).toBe("**not bold** [x](http://a.com)");
        expect(span.querySelector("strong")).toBeNull();
        expect(span.querySelector("a")).toBeNull();
        for (const text of ["``", "`unclosed", "a ` b"]) {
            expect(inline(text).querySelector("code")).toBeNull();
            expect(inline(text).textContent).toBe(text);
        }
    });

    it("doesn't italicize snake_case, or underscores that open or close inside a word", () => {
        for (const text of ["snake_case_name", "_foo_bar", "foo_bar_", "__init__py"]) {
            const span = inline(text);
            expect(span.querySelector("em, strong")).toBeNull();
            expect(span.textContent).toBe(text);
        }
    });

    it("keeps unmatched or space-padded markers literal", () => {
        for (const text of ["*a", "**a", "a*", "~~a", "* a *", "** a**", "_a", "2 * 3 * 4", "~a~", "*", "**"]) {
            const span = inline(text);
            expect(span.querySelector("em, strong, del")).toBeNull();
            expect(span.textContent).toBe(text);
        }
    });

    it("keeps backslash-escaped characters literal, and other backslashes as they are", () => {
        const span = inline("\\*not\\* \\_em\\_ \\`code\\` \\[x\\](y) \\~~s~~ \\# \\\\ \\d \\");
        expect(span.querySelector("em, code, a, del")).toBeNull();
        expect(span.textContent).toBe("*not* _em_ `code` [x](y) ~~s~~ # \\ \\d \\");
    });

    it("links [text](url) for http, https and mailto, opening in a new tab without a referrer", () => {
        const span = inline("[site](https://example.com/a) and [mail](mailto:a@b.co) and [*fancy*](http://x.com)");
        const links = [...span.querySelectorAll("a")];
        expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
            ["site", "https://example.com/a"],
            ["mail", "mailto:a@b.co"],
            ["fancy", "http://x.com/"],
        ]);
        for (const a of links) {
            expect(a.getAttribute("target")).toBe("_blank");
            expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
        }
        expect(links[2].querySelector("em")).not.toBeNull();
    });

    it("keeps an unsafe or malformed link as text", () => {
        for (const text of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](not a url)", "[x]()", "[x]( )", "[x](y", "[x", "[x]", "[x]y"]) {
            const span = inline(text);
            expect(span.querySelector("a")).toBeNull();
            expect(span.textContent).toBe(text);
        }
        // Not a [text](url) link - only its address, as a bare URL, is linked.
        for (const text of ["[x] (http://a.com)", "[x](http://a.com"]) {
            const span = inline(text);
            expect([...span.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["http://a.com"]);
            expect(span.textContent).toBe(text);
        }
    });

    it("reads a label with brackets and escapes in it", () => {
        const span = inline("[a [b] \\] c](http://a.com)");
        expect(span.querySelectorAll("a")).toHaveLength(1);
        expect(span.querySelector("a")!.textContent).toBe("a [b] ] c");
    });

    it("never puts a link inside a link", () => {
        const span = inline("[see [inner](http://in.com) and http://bare.com](http://out.com)");
        const links = span.querySelectorAll("a");
        expect(links).toHaveLength(1);
        expect(links[0].getAttribute("href")).toBe("http://out.com/");
        expect(links[0].textContent).toBe("see [inner](http://in.com) and http://bare.com");
    });

    it("shows a link's label as plain text when it is already nested four deep", () => {
        const span = inline("**__~~*[_x_](http://a.com)*~~__**");
        const a = span.querySelector("strong > strong > del > em > a")!;
        expect(a.textContent).toBe("_x_");
        expect(a.querySelector("em")).toBeNull();
    });

    it("renders ![alt](url) as an image linking to itself, without a referrer", () => {
        const span = inline("look: ![a cat](https://x.com/cat.png)");
        const img = span.querySelector("img")!;
        expect(img.getAttribute("src")).toBe("https://x.com/cat.png");
        expect(img.getAttribute("alt")).toBe("a cat");
        expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(img.getAttribute("loading")).toBe("lazy");
        expect(img.closest("a")!.getAttribute("href")).toBe("https://x.com/cat.png");
        expect(img.closest("a")!.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    });

    it("doesn't load an image from an unsafe URL", () => {
        const span = inline("![x](javascript:alert(1))");
        expect(span.querySelector("img, a")).toBeNull();
        expect(span.textContent).toBe("![x](javascript:alert(1))");
        // A mailto: can't be an image, but the rest is still a valid link.
        const mail = inline("![x](mailto:a@b.co)");
        expect(mail.querySelector("img")).toBeNull();
        expect(mail.querySelector("a")!.getAttribute("href")).toBe("mailto:a@b.co");
        expect(mail.textContent).toBe("!x");
    });

    it("doesn't render an image inside a link label", () => {
        const span = inline("[![x](https://x.com/a.png)](https://y.com)");
        expect(span.querySelector("img")).toBeNull();
        expect(span.querySelector("a")!.textContent).toBe("![x](https://x.com/a.png)");
    });

    it("links a bare URL, leaving out sentence punctuation and keeping balanced parentheses", () => {
        const span = inline("See https://example.com/path?q=1. Or (http://en.wikipedia.org/wiki/Foo_(bar)), ok? HTTP://UP.COM!");
        const links = [...span.querySelectorAll("a")];
        expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
            ["https://example.com/path?q=1", "https://example.com/path?q=1"],
            ["http://en.wikipedia.org/wiki/Foo_(bar)", "http://en.wikipedia.org/wiki/Foo_(bar)"],
            ["HTTP://UP.COM", "http://up.com/"],
        ]);
        expect(span.textContent).toBe("See https://example.com/path?q=1. Or (http://en.wikipedia.org/wiki/Foo_(bar)), ok? HTTP://UP.COM!");
    });

    it("doesn't link a URL glued to a word or path, or one that doesn't parse", () => {
        for (const text of ["xhttp://a.com", "/http://a.com", "http://.", "hello", "h"]) {
            const span = inline(text);
            expect(span.querySelector("a")).toBeNull();
            expect(span.textContent).toBe(text);
        }
    });

    it("keeps bare URL characters out of emphasis", () => {
        const span = inline("https://x.com/a_b_c and http://y.com/*z*");
        expect(span.querySelector("em")).toBeNull();
        expect([...span.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["https://x.com/a_b_c", "http://y.com/*z"]);
    });

    it("shows a bare image URL, such as a GIF from the picker, as the image itself", () => {
        const url = "https://media.giphy.com/media/abc/giphy.gif?cid=x";
        const span = inline(`haha ${url}`);
        const img = span.querySelector("img")!;
        expect(img.getAttribute("src")).toBe(url);
        expect(img.getAttribute("alt")).toBe("");
        expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(img.closest("a")!.getAttribute("href")).toBe(url);
    });

    it("prefixes its keys as asked", () => {
        const nodes = renderInline("**a** b", "pfx");
        expect((nodes[0] as React.ReactElement).key).toBe("pfx-0");
        expect(nodes[1]).toBe(" b");
    });
});

describe("ChatImage", () => {
    it("falls back to a link labelled with the bare URL when the image fails to load", () => {
        const url = "https://media.giphy.com/media/abc/giphy.gif?cid=x";
        const { container } = render(<span>{renderInline(url)}</span>);
        fireEvent.error(container.querySelector("img")!);
        expect(container.querySelector("img")).toBeNull();
        const a = container.querySelector("a")!;
        expect(a.textContent).toBe(url);
        expect(a.getAttribute("href")).toBe(url);
        expect(a.getAttribute("target")).toBe("_blank");
        expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    });

    it("falls back to the alt text as a link for ![alt](url)", () => {
        const { container } = render(<span>{renderInline("![a cat](https://x.com/cat.png)")}</span>);
        fireEvent.error(container.querySelector("img")!);
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("a")!.textContent).toBe("a cat");
        expect(container.querySelector("a")!.getAttribute("href")).toBe("https://x.com/cat.png");
    });

    it("falls back to the address when there is no alt text either", () => {
        const { container } = render(<ChatImage src="https://x.com/cat.png" alt="" />);
        fireEvent.error(container.querySelector("img")!);
        expect(screen.getByRole("link").textContent).toBe("https://x.com/cat.png");
    });
});

describe("ChatMarkdown", () => {
    it("renders paragraphs, with a single line break kept as <br>", () => {
        const root = md("one\ntwo\n\nthree");
        const paragraphs = root.querySelectorAll("p");
        expect(paragraphs).toHaveLength(2);
        expect(paragraphs[0].querySelectorAll("br")).toHaveLength(1);
        expect(paragraphs[0].textContent).toBe("onetwo");
        expect(paragraphs[1].textContent).toBe("three");
        expect(paragraphs[1].querySelector("br")).toBeNull();
    });

    it("renders headings 1 to 3 with their level, formatting inside", () => {
        md("# Big **news**\n## Medium\n### Small");
        const headings = screen.getAllByRole("heading");
        expect(headings.map((h) => [h.getAttribute("aria-level"), h.textContent])).toEqual([
            ["1", "Big news"],
            ["2", "Medium"],
            ["3", "Small"],
        ]);
        expect(headings[0].querySelector("strong")!.textContent).toBe("news");
        expect(headings[0].className).toContain("text-lg");
        expect(headings[1].className).toContain("text-base");
        expect(headings[2].className).toContain("text-sm");
    });

    it("renders quotes, nested up to the depth limit", () => {
        const root = md("> outer\n> > inner");
        expect(root.querySelector("blockquote > p")!.textContent).toBe("outer");
        expect(root.querySelector("blockquote > blockquote > p")!.textContent).toBe("inner");

        const deep = md("> > > > > too deep");
        expect(deep.querySelectorAll("blockquote")).toHaveLength(4);
        expect(deep.querySelector("blockquote blockquote blockquote blockquote > p")!.textContent).toBe("> too deep");
    });

    it("renders bulleted and numbered lists, a numbered one from its first number", () => {
        const root = md("- a\n- **b**\n\n7. seven\n8. eight");
        const ul = root.querySelector("ul")!;
        expect([...ul.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["a", "b"]);
        expect(ul.querySelector("li strong")!.textContent).toBe("b");
        const ol = root.querySelector("ol")!;
        expect(ol.getAttribute("start")).toBe("7");
        expect([...ol.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["seven", "eight"]);
    });

    it("renders fenced code verbatim, closed or not", () => {
        const root = md("```\n**not bold**\n<b>x</b>\n```");
        expect(root.querySelector("pre > code")!.textContent).toBe("**not bold**\n<b>x</b>");
        expect(root.querySelector("strong, b")).toBeNull();
        expect(md("```\nopen").querySelector("pre > code")!.textContent).toBe("open");
    });

    it("renders HTML as the characters typed, never as elements", () => {
        const text = '<script>alert(1)</script><img src=x onerror="alert(2)"><b>bold?</b>';
        const root = md(text);
        expect(root.querySelector("script, img, b")).toBeNull();
        expect(root.textContent).toBe(text);
    });

    it("renders one to three emoji alone large", () => {
        for (const text of ["😀", "  🎉🔥 ", "👨‍👩‍👧‍👦", "🇫🇷🇩🇪", "👍🏽", "1️⃣"]) {
            const root = md(text);
            expect(root.tagName).toBe("P");
            expect(root.className).toContain("text-4xl");
            expect(root.textContent).toBe(text.trim());
        }
    });

    it("renders four emoji, or emoji with text, as an ordinary message", () => {
        for (const text of ["😀😀😀😀", "nice 👍"]) {
            const root = md(text);
            expect(root.tagName).toBe("DIV");
            expect(root.className).not.toContain("text-4xl");
            expect(root.querySelector("p")!.textContent).toBe(text);
        }
    });

    it("renders an empty message as an empty container", () => {
        const root = md("");
        expect(root.tagName).toBe("DIV");
        expect(root.childElementCount).toBe(0);
    });
});
