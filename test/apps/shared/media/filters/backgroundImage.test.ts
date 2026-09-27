///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MAX_BACKGROUND_EDGE,
    MAX_BACKGROUND_FILE_BYTES,
    loadPicture,
    prepareBackgroundImage,
} from "../../../../../apps/shared/media/filters/backgroundImage.js";

/** What the fake `Image` does with the next `src` it is given. */
const imageBehaviour = { fail: false, width: 640, height: 480 };
const loadedSources: string[] = [];

/** An `Image` whose `src` setter "decodes" on a microtask, firing `onload` (with a natural size) or `onerror`. */
class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    private current = "";

    get src(): string {
        return this.current;
    }
    set src(value: string) {
        this.current = value;
        loadedSources.push(value);
        queueMicrotask(() => {
            if (imageBehaviour.fail) {
                this.onerror?.();
            } else {
                this.naturalWidth = imageBehaviour.width;
                this.naturalHeight = imageBehaviour.height;
                this.onload?.();
            }
        });
    }
}

/** The 2D context the canvas hands out, recording what is drawn on it. */
function fakeContext() {
    const order: string[] = [];
    const ctx = {
        fillStyle: "",
        fillRect: vi.fn((...args: number[]) => order.push(`fillRect(${args.join(",")})@${ctx.fillStyle}`)),
        drawImage: vi.fn((...args: unknown[]) => order.push(`drawImage(${args.slice(1).join(",")})`)),
    };
    return { ctx, order };
}

function imageFile(type = "image/png", name = "photo.png"): File {
    return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

let context: ReturnType<typeof fakeContext>;
let getContext: ReturnType<typeof vi.spyOn>;
let toDataURL: ReturnType<typeof vi.spyOn>;
let createdCanvas: HTMLCanvasElement | undefined;

beforeEach(() => {
    imageBehaviour.fail = false;
    imageBehaviour.width = 640;
    imageBehaviour.height = 480;
    loadedSources.length = 0;
    createdCanvas = undefined;
    vi.stubGlobal("Image", FakeImage);
    context = fakeContext();
    getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
        createdCanvas = this;
        return context.ctx as never;
    });
    toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,SMALL");
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("constants", () => {
    it("caps files at 20 MB and pictures at a call's width", () => {
        expect(MAX_BACKGROUND_FILE_BYTES).toBe(20 * 1024 * 1024);
        expect(MAX_BACKGROUND_EDGE).toBe(1280);
    });
});

describe("loadPicture", () => {
    it("resolves with the decoded image and its natural size", async () => {
        imageBehaviour.width = 300;
        imageBehaviour.height = 200;
        const picture = await loadPicture("data:image/png;base64,AAAA");
        expect(loadedSources).toEqual(["data:image/png;base64,AAAA"]);
        expect(picture.width).toBe(300);
        expect(picture.height).toBe(200);
        expect(picture.source).toBeInstanceOf(FakeImage);
    });

    it("rejects when the image can't be decoded", async () => {
        imageBehaviour.fail = true;
        await expect(loadPicture("data:image/png;base64,broken")).rejects.toThrow("The image could not be read.");
    });
});

describe("prepareBackgroundImage", () => {
    it("refuses a file that is not an image, without decoding it", async () => {
        const result = await prepareBackgroundImage(imageFile("application/pdf", "doc.pdf"));
        expect(result).toEqual({ ok: false, message: "Choose an image file (a JPEG, PNG or similar)." });
        expect(loadedSources).toEqual([]);
    });

    it("refuses a file with no type at all", async () => {
        const result = await prepareBackgroundImage(imageFile("", "mystery"));
        expect(result.ok).toBe(false);
    });

    it("refuses a file over 20 MB, without decoding it", async () => {
        const file = imageFile();
        Object.defineProperty(file, "size", { value: MAX_BACKGROUND_FILE_BYTES + 1 });
        const result = await prepareBackgroundImage(file);
        expect(result).toEqual({ ok: false, message: "That image is too large. Choose one under 20 MB." });
        expect(loadedSources).toEqual([]);
    });

    it("accepts a file of exactly 20 MB", async () => {
        const file = imageFile();
        Object.defineProperty(file, "size", { value: MAX_BACKGROUND_FILE_BYTES });
        const result = await prepareBackgroundImage(file);
        expect(result.ok).toBe(true);
    });

    it("downscales a large image so its longest edge is 1280, keeping the aspect ratio", async () => {
        imageBehaviour.width = 4000;
        imageBehaviour.height = 3000;
        const result = await prepareBackgroundImage(imageFile());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.picture.width).toBe(1280);
        expect(result.picture.height).toBe(960);
        expect(createdCanvas!.width).toBe(1280);
        expect(createdCanvas!.height).toBe(960);
        expect(result.picture.source).toBe(createdCanvas);
        expect(result.dataUrl).toBe("data:image/jpeg;base64,SMALL");
        expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
    });

    it("downscales a portrait image by its height", async () => {
        imageBehaviour.width = 1500;
        imageBehaviour.height = 3000;
        const result = await prepareBackgroundImage(imageFile());
        if (!result.ok) throw new Error("expected success");
        expect(result.picture.width).toBe(640);
        expect(result.picture.height).toBe(1280);
    });

    it("does not upscale a small image", async () => {
        imageBehaviour.width = 320;
        imageBehaviour.height = 200;
        const result = await prepareBackgroundImage(imageFile());
        if (!result.ok) throw new Error("expected success");
        expect(result.picture.width).toBe(320);
        expect(result.picture.height).toBe(200);
    });

    it("keeps an image already exactly 1280 wide as it is", async () => {
        imageBehaviour.width = 1280;
        imageBehaviour.height = 720;
        const result = await prepareBackgroundImage(imageFile());
        if (!result.ok) throw new Error("expected success");
        expect([result.picture.width, result.picture.height]).toEqual([1280, 720]);
    });

    it("never makes a canvas thinner than one pixel", async () => {
        imageBehaviour.width = 10000;
        imageBehaviour.height = 2;
        const result = await prepareBackgroundImage(imageFile());
        if (!result.ok) throw new Error("expected success");
        expect(result.picture.width).toBe(1280);
        expect(result.picture.height).toBe(1);
    });

    it("fills the canvas white before drawing, so a transparent PNG doesn't turn black", async () => {
        imageBehaviour.width = 200;
        imageBehaviour.height = 100;
        const result = await prepareBackgroundImage(imageFile());
        if (!result.ok) throw new Error("expected success");
        expect(context.order).toEqual(["fillRect(0,0,200,100)@#ffffff", "drawImage(0,0,200,100)"]);
        expect(context.ctx.drawImage.mock.calls[0][0]).toBeInstanceOf(FakeImage);
    });

    it("decodes the data url the file was read into", async () => {
        await prepareBackgroundImage(imageFile("image/png"));
        expect(loadedSources).toHaveLength(1);
        expect(loadedSources[0]).toMatch(/^data:image\/png;base64,/);
    });

    it("reports a browser that can't make a 2D context", async () => {
        getContext.mockReturnValue(null);
        const result = await prepareBackgroundImage(imageFile());
        expect(result).toEqual({ ok: false, message: "This browser can't prepare that image." });
    });

    it("reports an image that can't be decoded", async () => {
        imageBehaviour.fail = true;
        const result = await prepareBackgroundImage(imageFile());
        expect(result).toEqual({ ok: false, message: "That file couldn't be opened as an image." });
    });

    it("reports a file that can't be read", async () => {
        vi.stubGlobal(
            "FileReader",
            class {
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                result: unknown = null;
                readAsDataURL() {
                    queueMicrotask(() => this.onerror?.());
                }
            },
        );
        const result = await prepareBackgroundImage(imageFile());
        expect(result).toEqual({ ok: false, message: "That file couldn't be opened as an image." });
        expect(loadedSources).toEqual([]);
    });

    it("reads the file with a reader whose result becomes the image source", async () => {
        vi.stubGlobal(
            "FileReader",
            class {
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                result: unknown = null;
                readAsDataURL() {
                    this.result = "data:image/png;base64,FROMREADER";
                    queueMicrotask(() => this.onload?.());
                }
            },
        );
        await prepareBackgroundImage(imageFile());
        expect(loadedSources).toEqual(["data:image/png;base64,FROMREADER"]);
    });

    it("reports a canvas that throws while drawing", async () => {
        context.ctx.drawImage.mockImplementation(() => {
            throw new Error("tainted");
        });
        const result = await prepareBackgroundImage(imageFile());
        expect(result.ok).toBe(false);
    });
});
