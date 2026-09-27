// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EffectsPanel, { type EffectsTone } from "../../../apps/meet/_EffectsPanel.js";
import { ACCESSORY_OPTIONS, BACKGROUND_OPTIONS, EFFECT_OPTIONS, NO_FILTERS } from "../../../apps/shared/media/filters/filterTypes.js";
import type { LocalMedia } from "../../../apps/shared/media/useLocalMedia.js";
import { fakeLocalMedia } from "../testUtils.js";

function renderPanel(overrides: Partial<LocalMedia> = {}, tone: EffectsTone = "light") {
    const media = fakeLocalMedia(overrides);
    return { ...render(<EffectsPanel media={media} tone={tone} />), media };
}

const group = (name: string) => screen.getByRole("group", { name });
const pressed = (name: string) =>
    within(group(name))
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.textContent);
const fileInput = () => screen.getByLabelText("Background image");
const file = () => new File(["x"], "room.png", { type: "image/png" });

describe("EffectsPanel - options", () => {
    it("lists every background, look and accessory", () => {
        renderPanel();
        for (const [name, options] of [
            ["Background", BACKGROUND_OPTIONS],
            ["Look", EFFECT_OPTIONS],
            ["Fun", ACCESSORY_OPTIONS],
        ] as const) {
            const buttons = within(group(name)).getAllByRole("button");
            expect(buttons.map((b) => b.textContent)).toEqual(options.map((o) => `${o.emoji}${o.label}`));
        }
    });

    it("marks the option in use in each group", () => {
        renderPanel({ filters: { background: "blur", effect: "sepia", accessory: "crown" } });
        expect(pressed("Background")).toEqual(["🌫️Blur"]);
        expect(pressed("Look")).toEqual(["📜Sepia"]);
        expect(pressed("Fun")).toEqual(["👑Crown"]);
    });

    it("marks None everywhere when no filter is on", () => {
        renderPanel({ filters: NO_FILTERS });
        expect(pressed("Background")).toEqual(["🚫None"]);
        expect(pressed("Look")).toEqual(["🚫None"]);
        expect(pressed("Fun")).toEqual(["🚫None"]);
    });

    it("changes just the one layer that was clicked", () => {
        const { media } = renderPanel();
        fireEvent.click(within(group("Background")).getByRole("button", { name: /Blur/ }));
        expect(media.setFilters).toHaveBeenLastCalledWith({ background: "blur" });
        fireEvent.click(within(group("Look")).getByRole("button", { name: /Night vision/ }));
        expect(media.setFilters).toHaveBeenLastCalledWith({ effect: "night-vision" });
        fireEvent.click(within(group("Fun")).getByRole("button", { name: /Sunglasses/ }));
        expect(media.setFilters).toHaveBeenLastCalledWith({ accessory: "sunglasses" });
        fireEvent.click(within(group("Background")).getByRole("button", { name: /None/ }));
        expect(media.setFilters).toHaveBeenLastCalledWith({ background: "none" });
        expect(media.setFilters).toHaveBeenCalledTimes(4);
    });

    it("renders in both tones", () => {
        const light = renderPanel({ filters: { ...NO_FILTERS, effect: "bw" } }, "light");
        const lightSelected = within(group("Look")).getByRole("button", { name: /Black/ }).className;
        const lightIdle = within(group("Look")).getByRole("button", { name: /Sepia/ }).className;
        light.unmount();

        renderPanel({ filters: { ...NO_FILTERS, effect: "bw" } }, "dark");
        const darkSelected = within(group("Look")).getByRole("button", { name: /Black/ }).className;
        const darkIdle = within(group("Look")).getByRole("button", { name: /Sepia/ }).className;
        expect(darkSelected).not.toBe(lightSelected);
        expect(darkIdle).not.toBe(lightIdle);
        expect(darkSelected).not.toBe(darkIdle);
    });
});

describe("EffectsPanel - custom background image", () => {
    it("opens the file picker rather than switching, while there is no image yet", () => {
        const { media } = renderPanel({ hasBackgroundImage: false });
        const click = vi.spyOn(fileInput(), "click");

        fireEvent.click(within(group("Background")).getByRole("button", { name: /Custom image/ }));

        expect(click).toHaveBeenCalledTimes(1);
        expect(media.setFilters).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Change image" })).toBeNull();
    });

    it("switches to the image at once when there is one, and offers to change it", () => {
        const { media } = renderPanel({ hasBackgroundImage: true });
        const click = vi.spyOn(fileInput(), "click");

        fireEvent.click(within(group("Background")).getByRole("button", { name: /Custom image/ }));
        expect(media.setFilters).toHaveBeenCalledWith({ background: "image" });
        expect(click).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Change image" }));
        expect(click).toHaveBeenCalledTimes(1);
    });

    it("takes the chosen file as the background, and lets the same file be picked again", async () => {
        const { media } = renderPanel();
        const input = fileInput();
        const picked = file();

        fireEvent.change(input, { target: { files: [picked] } });

        await waitFor(() => expect(media.chooseBackgroundImage).toHaveBeenCalledWith(picked));
        expect(input.value).toBe("");
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows why a file was refused, until the next background is chosen", async () => {
        const chooseBackgroundImage = vi.fn(async () => "That image is too large.");
        renderPanel({ chooseBackgroundImage, hasBackgroundImage: true });

        fireEvent.change(fileInput(), { target: { files: [file()] } });
        expect(await screen.findByRole("alert")).toHaveTextContent("That image is too large.");

        fireEvent.click(within(group("Background")).getByRole("button", { name: /Blur/ }));
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("clears the message when a new file is chosen and accepted", async () => {
        const chooseBackgroundImage = vi.fn().mockResolvedValueOnce("Nope.").mockResolvedValueOnce(null);
        renderPanel({ chooseBackgroundImage });

        fireEvent.change(fileInput(), { target: { files: [file()] } });
        expect(await screen.findByRole("alert")).toHaveTextContent("Nope.");
        fireEvent.change(fileInput(), { target: { files: [file()] } });
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });

    it("does nothing when the picker is dismissed without a file", () => {
        const { media } = renderPanel();
        fireEvent.change(fileInput(), { target: { files: [] } });
        expect(media.chooseBackgroundImage).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).toBeNull();
    });
});

describe("EffectsPanel - status", () => {
    it("says the effects are loading", () => {
        renderPanel({ filterStatus: { loading: true, error: null } });
        expect(screen.getByRole("status")).toHaveTextContent("Loading effects");
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says why an effect isn't working", () => {
        renderPanel({ filterStatus: { loading: false, error: "The face effect couldn't be loaded." } });
        expect(screen.getByRole("alert")).toHaveTextContent("The face effect couldn't be loaded.");
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("says nothing while all is well", () => {
        renderPanel();
        expect(screen.queryByRole("status")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("reminds the participant to turn their camera on only while it is off", () => {
        const on = renderPanel({ cameraOn: true });
        expect(screen.queryByText("Turn on your camera to see effects.")).toBeNull();
        on.unmount();

        renderPanel({ cameraOn: false }, "dark");
        expect(screen.getByText("Turn on your camera to see effects.")).toBeInTheDocument();
    });
});
