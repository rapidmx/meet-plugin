///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The whiteboard's custom color picker: a hue/saturation wheel (hue around it, saturation out from its center) and a
 * brightness slider below it, for any color the swatches don't offer. Dragging on the wheel, or using the arrow keys
 * on it (left/right turn the hue, up/down change the saturation), picks a color; `onChange` gets every pick as
 * `#rrggbb`.
 */
import React, { useEffect, useRef, useState } from "react";
import { hexToHsv, hsvToHex, hsvToRgb, wheelPoint, type Hsv } from "../shared/collab/color.js";

export interface ColorWheelProps {
    color: string;
    onChange: (color: string) => void;
    /** The wheel's diameter, in CSS pixels. */
    size?: number;
}

/** How far one arrow-key press turns the hue (degrees) or moves the saturation. */
const HUE_STEP = 5;
const SATURATION_STEP = 0.05;

export default function ColorWheel({ color, onChange, size = 168 }: ColorWheelProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(color));
    const radius = size / 2;

    // Follows a color chosen elsewhere (a swatch) - unless it is the one this wheel just produced, which would
    // otherwise snap the hue of a gray (where hue is meaningless) back to red.
    useEffect(() => {
        setHsv((prev) => (hsvToHex(prev) === color ? prev : hexToHsv(color)));
    }, [color]);

    useEffect(() => {
        const ctx = canvasRef.current?.getContext("2d");
        if (!ctx) {
            return;
        }
        const image = ctx.createImageData(size, size);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const offset = (y * size + x) * 4;
                if (Math.hypot(x - radius, y - radius) > radius) {
                    continue;
                }
                const { h, s } = wheelPoint(x, y, radius);
                const [r, g, b] = hsvToRgb({ h, s, v: hsv.v });
                image.data[offset] = r;
                image.data[offset + 1] = g;
                image.data[offset + 2] = b;
                image.data[offset + 3] = 255;
            }
        }
        ctx.putImageData(image, 0, 0);
    }, [hsv.v, size, radius]);

    function pick(next: Hsv) {
        setHsv(next);
        onChange(hsvToHex(next));
    }

    function pickAt(event: React.PointerEvent<HTMLCanvasElement>) {
        const rect = event.currentTarget.getBoundingClientRect();
        const scale = rect.width > 0 ? size / rect.width : 1;
        const { h, s } = wheelPoint((event.clientX - rect.left) * scale, (event.clientY - rect.top) * scale, radius);
        pick({ ...hsv, h, s });
    }

    function handleKeyDown(event: React.KeyboardEvent) {
        const moves: Record<string, Partial<Hsv>> = {
            ArrowLeft: { h: (hsv.h - HUE_STEP + 360) % 360 },
            ArrowRight: { h: (hsv.h + HUE_STEP) % 360 },
            ArrowUp: { s: Math.min(1, hsv.s + SATURATION_STEP) },
            ArrowDown: { s: Math.max(0, hsv.s - SATURATION_STEP) },
        };
        const move = moves[event.key];
        if (move) {
            event.preventDefault();
            pick({ ...hsv, ...move });
        }
    }

    const angle = (hsv.h * Math.PI) / 180;
    const markerX = radius + Math.cos(angle) * hsv.s * radius;
    const markerY = radius + Math.sin(angle) * hsv.s * radius;

    return (
        <div className="flex flex-col items-center gap-3" data-testid="color-wheel">
            <div className="relative" style={{ width: size, height: size }}>
                <canvas
                    ref={canvasRef}
                    width={size}
                    height={size}
                    tabIndex={0}
                    role="slider"
                    aria-label="Hue and saturation"
                    aria-valuemin={0}
                    aria-valuemax={359}
                    aria-valuenow={Math.round(hsv.h)}
                    aria-valuetext={`Hue ${Math.round(hsv.h)} degrees, saturation ${Math.round(hsv.s * 100)}%`}
                    className="rounded-full cursor-crosshair touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture?.(event.pointerId);
                        pickAt(event);
                    }}
                    onPointerMove={(event) => {
                        if (event.buttons & 1) {
                            pickAt(event);
                        }
                    }}
                    onKeyDown={handleKeyDown}
                />
                <span
                    className="pointer-events-none absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
                    style={{ left: markerX, top: markerY, backgroundColor: hsvToHex(hsv) }}
                    aria-hidden="true"
                />
            </div>
            <label className="w-full flex items-center gap-2 text-xs text-white/70">
                <span className="shrink-0">Brightness</span>
                <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(hsv.v * 100)}
                    aria-label="Brightness"
                    className="flex-1"
                    style={{ accentColor: hsvToHex({ ...hsv, v: Math.max(hsv.v, 0.3) }) }}
                    onChange={(event) => pick({ ...hsv, v: Number(event.target.value) / 100 })}
                />
            </label>
        </div>
    );
}
