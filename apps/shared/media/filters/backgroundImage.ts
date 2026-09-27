///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The picture behind a participant for the "custom image" background: read from a file they pick on their own
 * device, shrunk to what a video call can show anyway, and kept as a small JPEG data URL so it can be remembered
 * (`mediaPreferences.ts`) without filling the browser's storage. The file never leaves the browser.
 */
import type { BackgroundPicture } from "./VideoFilterProcessor.js";

/** A bigger file than this is refused before the browser tries to decode it. */
export const MAX_BACKGROUND_FILE_BYTES = 20 * 1024 * 1024;
/** The longest edge kept - a call's video is 1280 wide, so more would only cost storage. */
export const MAX_BACKGROUND_EDGE = 1280;
const JPEG_QUALITY = 0.85;

export type PreparedBackground = { ok: true; dataUrl: string; picture: BackgroundPicture } | { ok: false; message: string };

/** Decodes an image (a URL or data URL) into something that can be drawn. Rejects if it isn't a picture. */
export function loadPicture(src: string): Promise<BackgroundPicture> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("The image could not be read."));
        image.src = src;
    });
}

function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("The file could not be read."));
        reader.readAsDataURL(file);
    });
}

/** Reads a picked file into a background: validated, downscaled and ready both to draw and to store. */
export async function prepareBackgroundImage(file: File): Promise<PreparedBackground> {
    if (!file.type.startsWith("image/")) {
        return { ok: false, message: "Choose an image file (a JPEG, PNG or similar)." };
    }
    if (file.size > MAX_BACKGROUND_FILE_BYTES) {
        return { ok: false, message: "That image is too large. Choose one under 20 MB." };
    }
    try {
        const original = await loadPicture(await readAsDataUrl(file));
        const scale = Math.min(1, MAX_BACKGROUND_EDGE / Math.max(original.width, original.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(original.width * scale));
        canvas.height = Math.max(1, Math.round(original.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return { ok: false, message: "This browser can't prepare that image." };
        }
        // JPEG has no transparency: a transparent PNG would otherwise turn black.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(original.source, 0, 0, canvas.width, canvas.height);
        return {
            ok: true,
            dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
            picture: { source: canvas, width: canvas.width, height: canvas.height },
        };
    } catch {
        return { ok: false, message: "That file couldn't be opened as an image." };
    }
}
