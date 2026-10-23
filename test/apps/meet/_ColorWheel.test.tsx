// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ColorWheel from "../../../apps/meet/_ColorWheel.js";
import { hsvToHex } from "../../../apps/shared/collab/color.js";

/** A 2D context with just what the wheel draws with, keeping each image it puts. */
function fakeContext() {
    return {
        createImageData: vi.fn((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })),
        putImageData: vi.fn(),
    };
}

let ctx: ReturnType<typeof fakeContext>;
let getContext: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    ctx = fakeContext();
    getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
    getContext.mockRestore();
});

const wheel = () => screen.getByRole("slider", { name: "Hue and saturation" });
const brightness = () => screen.getByRole("slider", { name: "Brightness" });

/** Places the wheel's canvas on the page at `rect`. */
function placeWheel(rect: { left: number; top: number; width: number; height: number }) {
    vi.spyOn(wheel(), "getBoundingClientRect").mockReturnValue({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect });
}

describe("ColorWheel - drawing", () => {
    it("paints the hue/saturation disc at the current brightness, leaving the corners outside it clear", () => {
        render(<ColorWheel color="#ff0000" onChange={vi.fn()} size={20} />);
        expect(ctx.createImageData).toHaveBeenCalledWith(20, 20);
        expect(ctx.putImageData).toHaveBeenCalledTimes(1);
        const [image, x, y] = ctx.putImageData.mock.calls[0];
        expect([x, y]).toEqual([0, 0]);
        const pixel = (px: number, py: number) => Array.from(image.data.slice((py * 20 + px) * 4, (py * 20 + px) * 4 + 4));
        // A corner is outside the disc.
        expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
        // The center has no saturation: white at full brightness.
        expect(pixel(10, 10)).toEqual([255, 255, 255, 255]);
        // The right edge, middle row: red.
        expect(pixel(19, 10)).toEqual([255, expect.any(Number), expect.any(Number), 255]);
        expect(pixel(19, 10)[1]).toBeLessThan(40);
    });

    it("repaints darker when the brightness changes", () => {
        const onChange = vi.fn();
        render(<ColorWheel color="#ff0000" onChange={onChange} size={20} />);
        fireEvent.change(brightness(), { target: { value: "50" } });
        expect(onChange).toHaveBeenCalledWith(hsvToHex({ h: 0, s: 1, v: 0.5 }));
        expect(ctx.putImageData).toHaveBeenCalledTimes(2);
        const image = ctx.putImageData.mock.calls[1][0];
        expect(Array.from(image.data.slice((10 * 20 + 10) * 4, (10 * 20 + 10) * 4 + 4))).toEqual([128, 128, 128, 255]);
        expect(brightness().value).toBe("50");
    });

    it("draws nothing, without failing, where the browser gives no 2D context", () => {
        getContext.mockReturnValue(null);
        const onChange = vi.fn();
        render(<ColorWheel color="#1a73e8" onChange={onChange} />);
        expect(wheel()).toHaveAttribute("width", "168");
        fireEvent.keyDown(wheel(), { key: "ArrowRight" });
        expect(onChange).toHaveBeenCalledTimes(1);
    });
});

describe("ColorWheel - picking", () => {
    it("picks the hue and saturation under the pointer, scaled to the wheel's displayed size, and captures the pointer", () => {
        const onChange = vi.fn();
        render(<ColorWheel color="#808080" onChange={onChange} size={100} />);
        placeWheel({ left: 10, top: 20, width: 50, height: 50 });
        const setPointerCapture = vi.fn();
        wheel().setPointerCapture = setPointerCapture;

        // The right edge, middle: red at the gray's brightness.
        fireEvent.pointerDown(wheel(), { clientX: 60, clientY: 45, pointerId: 7 });
        expect(setPointerCapture).toHaveBeenCalledWith(7);
        expect(onChange).toHaveBeenLastCalledWith("#800000");
        expect(wheel()).toHaveAttribute("aria-valuenow", "0");
        expect(wheel()).toHaveAttribute("aria-valuetext", "Hue 0 degrees, saturation 100%");

        // Dragging to the top: 270 degrees.
        fireEvent.pointerMove(wheel(), { clientX: 35, clientY: 20, buttons: 1 });
        expect(onChange).toHaveBeenLastCalledWith(hsvToHex({ h: 270, s: 1, v: 128 / 255 }));
        expect(wheel()).toHaveAttribute("aria-valuenow", "270");

        // Moving without a button held picks nothing.
        fireEvent.pointerMove(wheel(), { clientX: 60, clientY: 45, buttons: 0 });
        fireEvent.pointerMove(wheel(), { clientX: 60, clientY: 45, buttons: 2 });
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    it("moves its marker to the color picked", () => {
        render(<ColorWheel color="#808080" onChange={vi.fn()} size={100} />);
        placeWheel({ left: 0, top: 0, width: 100, height: 100 });
        const marker = screen.getByTestId("color-wheel").querySelector("span[aria-hidden]") as HTMLElement;
        // A gray sits at the center.
        expect(marker.style.left).toBe("50px");
        expect(marker.style.top).toBe("50px");
        // Halfway out to the bottom.
        fireEvent.pointerDown(wheel(), { clientX: 50, clientY: 75 });
        expect(parseFloat(marker.style.left)).toBeCloseTo(50);
        expect(parseFloat(marker.style.top)).toBeCloseTo(75);
    });

    it("treats a wheel with no displayed size as unscaled, and works where the browser has no pointer capture", () => {
        const onChange = vi.fn();
        render(<ColorWheel color="#ffffff" onChange={onChange} size={100} />);
        placeWheel({ left: 0, top: 0, width: 0, height: 0 });
        expect(wheel().setPointerCapture).toBeUndefined();
        // (50, 100) is the bottom of a 100px wheel: 90 degrees.
        fireEvent.pointerDown(wheel(), { clientX: 50, clientY: 100 });
        expect(onChange).toHaveBeenCalledWith(hsvToHex({ h: 90, s: 1, v: 1 }));
    });
});

describe("ColorWheel - keyboard", () => {
    it("turns the hue with left/right, wrapping around, and changes the saturation with up/down, within its range", () => {
        const onChange = vi.fn();
        render(<ColorWheel color="#ff0000" onChange={onChange} />);
        const press = (key: string) => fireEvent.keyDown(wheel(), { key });

        press("ArrowLeft");
        expect(onChange).toHaveBeenLastCalledWith(hsvToHex({ h: 355, s: 1, v: 1 }));
        expect(wheel()).toHaveAttribute("aria-valuenow", "355");
        press("ArrowRight");
        expect(wheel()).toHaveAttribute("aria-valuenow", "0");
        expect(onChange).toHaveBeenLastCalledWith("#ff0000");
        press("ArrowRight");
        expect(wheel()).toHaveAttribute("aria-valuenow", "5");

        // Already fully saturated: up stays there.
        press("ArrowUp");
        expect(wheel()).toHaveAttribute("aria-valuetext", "Hue 5 degrees, saturation 100%");
        press("ArrowDown");
        expect(wheel()).toHaveAttribute("aria-valuetext", "Hue 5 degrees, saturation 95%");
        press("ArrowUp");
        expect(wheel()).toHaveAttribute("aria-valuetext", "Hue 5 degrees, saturation 100%");
        for (let i = 0; i < 25; i++) {
            press("ArrowDown");
        }
        expect(wheel()).toHaveAttribute("aria-valuetext", "Hue 5 degrees, saturation 0%");
        expect(onChange).toHaveBeenLastCalledWith("#ffffff");
    });

    it("prevents the page scrolling on an arrow key, and ignores any other key", () => {
        const onChange = vi.fn();
        render(<ColorWheel color="#ff0000" onChange={onChange} />);
        expect(fireEvent.keyDown(wheel(), { key: "ArrowUp" })).toBe(false);
        expect(fireEvent.keyDown(wheel(), { key: "Enter" })).toBe(true);
        expect(fireEvent.keyDown(wheel(), { key: "a" })).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);
    });
});

describe("ColorWheel - following the color it is given", () => {
    it("moves to a color chosen elsewhere", () => {
        const { rerender } = render(<ColorWheel color="#ff0000" onChange={vi.fn()} />);
        expect(wheel()).toHaveAttribute("aria-valuenow", "0");
        expect(brightness().value).toBe("100");
        rerender(<ColorWheel color="#0000ff" onChange={vi.fn()} />);
        expect(wheel()).toHaveAttribute("aria-valuenow", "240");
        rerender(<ColorWheel color="#000000" onChange={vi.fn()} />);
        expect(brightness().value).toBe("0");
    });

    it("keeps its own hue when given back the color it just produced - a hue on a black or gray would otherwise snap to red", () => {
        const onChange = vi.fn();
        const { rerender } = render(<ColorWheel color="#00ff00" onChange={onChange} />);
        expect(wheel()).toHaveAttribute("aria-valuenow", "120");

        fireEvent.change(brightness(), { target: { value: "0" } });
        expect(onChange).toHaveBeenLastCalledWith("#000000");
        // The parent hands the pick back down as its new color.
        rerender(<ColorWheel color="#000000" onChange={onChange} />);
        expect(wheel()).toHaveAttribute("aria-valuenow", "120");

        // Brightening again brings back the very hue it had.
        fireEvent.change(brightness(), { target: { value: "100" } });
        expect(onChange).toHaveBeenLastCalledWith("#00ff00");
    });

    it("starts from black for something that isn't a color", () => {
        render(<ColorWheel color="not a color" onChange={vi.fn()} />);
        expect(wheel()).toHaveAttribute("aria-valuenow", "0");
        expect(brightness().value).toBe("0");
    });
});
