///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The video filters a participant can put on their camera. They come in three independent layers, so they combine
 * (blurred background *and* black and white *and* sunglasses):
 *
 * - **Background**: what is behind the participant - untouched, blurred, or a picture they chose. Needs person
 * segmentation (`mlModels.ts`).
 * - **Effect**: a look applied to the whole picture - black and white, sepia, night vision, pixelated.
 * - **Accessory**: something drawn on the participant's face - sunglasses, cat ears, a party hat. Needs face landmarks
 * (`mlModels.ts`).
 *
 * Adding a filter is: add its id here (with a label), then implement it in `VideoFilterProcessor.ts` (an effect), or
 * in `accessories.ts` (an accessory).
 */

export type BackgroundFilter = "none" | "blur" | "image";
export type ColorEffect = "none" | "bw" | "sepia" | "night-vision" | "pixelate";
export type Accessory = "none" | "sunglasses" | "cat-ears" | "party-hat" | "crown" | "mustache";

export interface VideoFilters {
    background: BackgroundFilter;
    effect: ColorEffect;
    accessory: Accessory;
}

export const NO_FILTERS: VideoFilters = { background: "none", effect: "none", accessory: "none" };

export interface FilterOption<T extends string> {
    id: T;
    label: string;
    /** A glyph shown beside the label, purely decorative. */
    emoji: string;
}

export const BACKGROUND_OPTIONS: FilterOption<BackgroundFilter>[] = [
    { id: "none", label: "None", emoji: "🚫" },
    { id: "blur", label: "Blur", emoji: "🌫️" },
    { id: "image", label: "Custom image", emoji: "🖼️" },
];

export const EFFECT_OPTIONS: FilterOption<ColorEffect>[] = [
    { id: "none", label: "None", emoji: "🚫" },
    { id: "bw", label: "Black & white", emoji: "🎞️" },
    { id: "sepia", label: "Sepia", emoji: "📜" },
    { id: "night-vision", label: "Night vision", emoji: "🥽" },
    { id: "pixelate", label: "Pixelate", emoji: "👾" },
];

export const ACCESSORY_OPTIONS: FilterOption<Accessory>[] = [
    { id: "none", label: "None", emoji: "🚫" },
    { id: "sunglasses", label: "Sunglasses", emoji: "😎" },
    { id: "cat-ears", label: "Cat", emoji: "🐱" },
    { id: "party-hat", label: "Party hat", emoji: "🥳" },
    { id: "crown", label: "Crown", emoji: "👑" },
    { id: "mustache", label: "Mustache", emoji: "🥸" },
];

/** Whether any filter is on - when none is, the camera's own track is sent untouched and nothing is processed. */
export function filtersActive(filters: VideoFilters): boolean {
    return filters.background !== "none" || filters.effect !== "none" || filters.accessory !== "none";
}

/** Whether the filters need the person-segmentation model. */
export function needsSegmentation(filters: VideoFilters): boolean {
    return filters.background !== "none";
}

/** Whether the filters need the face-landmark model. */
export function needsFace(filters: VideoFilters): boolean {
    return filters.accessory !== "none";
}

function pick<T extends string>(options: FilterOption<T>[], value: unknown, fallback: T): T {
    return options.some((option) => option.id === value) ? (value as T) : fallback;
}

/** Turns whatever was read back from storage into valid filters - anything unrecognised (a filter since removed, a
 * hand-edited value, another version's shape) falls back to "none" rather than breaking the call. */
export function sanitizeFilters(value: unknown): VideoFilters {
    const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    return {
        background: pick(BACKGROUND_OPTIONS, raw.background, "none"),
        effect: pick(EFFECT_OPTIONS, raw.effect, "none"),
        accessory: pick(ACCESSORY_OPTIONS, raw.accessory, "none"),
    };
}
