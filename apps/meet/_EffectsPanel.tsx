///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The picker for the video filters (`apps/shared/media/filters/`): a background, a colour effect and a face accessory,
 * each one of a short list, chosen independently so they combine. Shared by the lobby (on the page's light theme) and
 * the in-call control bar (on its dark one) - `tone` picks the colours, nothing else differs.
 *
 * The background can also be a picture from the participant's own device: choosing "Custom image" with none picked yet
 * opens the file picker, and once one is picked "Change image" is offered beside the options. The picture is read and
 * kept in the browser (`filters/backgroundImage.ts`) - it is never uploaded.
 */
import React, { useRef, useState } from "react";
import type { LocalMedia } from "../shared/media/useLocalMedia.js";
import {
    ACCESSORY_OPTIONS,
    BACKGROUND_OPTIONS,
    EFFECT_OPTIONS,
    type FilterOption,
    type VideoFilters,
} from "../shared/media/filters/filterTypes.js";

export type EffectsTone = "light" | "dark";

const CHIP = "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors focus:outline-none focus-visible:ring-2";
const TONES: Record<EffectsTone, { idle: string; selected: string; muted: string; ring: string; link: string }> = {
    light: {
        idle: "border border-border bg-surface text-text hover:bg-surface-alt",
        selected: "border border-primary bg-surface-alt text-text font-semibold",
        muted: "text-text-muted",
        ring: "focus-visible:ring-primary",
        link: "text-primary",
    },
    dark: {
        idle: "bg-[#3c4043] text-white hover:bg-[#4b4f53]",
        selected: "bg-[#a8c7fa] text-[#062e6f] hover:bg-[#8ab4f8]",
        muted: "text-white/70",
        ring: "focus-visible:ring-white/80",
        link: "text-[#8ab4f8]",
    },
};

export interface EffectsPanelProps {
    media: LocalMedia;
    tone: EffectsTone;
}

export default function EffectsPanel({ media, tone }: EffectsPanelProps) {
    const colors = TONES[tone];
    const fileInput = useRef<HTMLInputElement>(null);
    const [fileError, setFileError] = useState<string | null>(null);
    const { filters, filterStatus } = media;

    function group<K extends keyof VideoFilters>(
        key: K,
        label: string,
        options: FilterOption<VideoFilters[K]>[],
        onChoose: (id: VideoFilters[K]) => void,
    ) {
        return (
            <div role="group" aria-label={label} className="mt-3 first:mt-0">
                <p className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${colors.muted}`}>{label}</p>
                <div className="flex flex-wrap gap-1.5">
                    {options.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`${CHIP} ${colors.ring} ${filters[key] === option.id ? colors.selected : colors.idle}`}
                            aria-pressed={filters[key] === option.id}
                            onClick={() => onChoose(option.id)}
                        >
                            <span aria-hidden="true">{option.emoji}</span>
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
        const input = event.target;
        const file = input.files?.[0];
        // Cleared so picking the same file again still counts as a change.
        input.value = "";
        if (file) {
            setFileError(await media.chooseBackgroundImage(file));
        }
    }

    function chooseBackground(id: VideoFilters["background"]) {
        setFileError(null);
        if (id === "image" && !media.hasBackgroundImage) {
            fileInput.current?.click();
            return;
        }
        media.setFilters({ background: id });
    }

    return (
        <div>
            {group("background", "Background", BACKGROUND_OPTIONS, chooseBackground)}
            {media.hasBackgroundImage && (
                <button
                    type="button"
                    className={`mt-1.5 text-sm underline ${colors.link} focus:outline-none focus-visible:ring-2 ${colors.ring}`}
                    onClick={() => fileInput.current?.click()}
                >
                    Change image
                </button>
            )}
            <input ref={fileInput} type="file" accept="image/*" className="hidden" aria-label="Background image" onChange={handleFile} />
            {fileError && (
                <p role="alert" className="mt-1.5 text-sm text-[#d93025]">
                    {fileError}
                </p>
            )}
            {group("effect", "Look", EFFECT_OPTIONS, (id) => media.setFilters({ effect: id }))}
            {group("accessory", "Fun", ACCESSORY_OPTIONS, (id) => media.setFilters({ accessory: id }))}
            {filterStatus.loading && (
                <p role="status" className={`mt-3 text-sm ${colors.muted}`}>
                    Loading effects…
                </p>
            )}
            {filterStatus.error && (
                <p role="alert" className="mt-3 text-sm text-[#d93025]">
                    {filterStatus.error}
                </p>
            )}
            {!media.cameraOn && <p className={`mt-3 text-sm ${colors.muted}`}>Turn on your camera to see effects.</p>}
        </div>
    );
}
