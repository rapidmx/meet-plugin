///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { resumeAudioContext } from "../../../../apps/shared/relay/audioResume.js";
import { FakeAudioContext, FakeEventTarget } from "./relayFakes.js";

function suspended(): FakeAudioContext {
    const ctx = new FakeAudioContext(48_000);
    ctx.state = "suspended";
    return ctx;
}

/** Lets the promise returned by `resume()` settle. */
async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe("resumeAudioContext", () => {
    it("does nothing for a context that is not suspended", () => {
        const ctx = new FakeAudioContext(48_000);
        const target = new FakeEventTarget();
        const dispose = resumeAudioContext(ctx, target);
        expect(ctx.resume).not.toHaveBeenCalled();
        expect(target.count()).toBe(0);
        expect(() => dispose()).not.toThrow();
    });

    it("resumes immediately and drops its listeners once the context is running", async () => {
        const ctx = suspended();
        const target = new FakeEventTarget();
        resumeAudioContext(ctx, target);
        expect(ctx.resume).toHaveBeenCalledTimes(1);
        expect(target.count()).toBe(3);
        await settle();
        expect(ctx.state).toBe("running");
        expect(target.count()).toBe(0);
    });

    it("keeps the gesture listeners while the browser refuses, retries on the next gesture, then removes them", async () => {
        const ctx = suspended();
        ctx.resumeMakesRunning = false;
        const target = new FakeEventTarget();
        resumeAudioContext(ctx, target);
        await settle();
        // Resolved but still suspended: the gesture listeners stay.
        expect(target.count()).toBe(3);
        expect([...target.listeners.keys()].sort()).toEqual(["click", "keydown", "pointerdown"]);

        ctx.resumeMakesRunning = true;
        target.emit("pointerdown");
        expect(ctx.resume).toHaveBeenCalledTimes(2);
        expect(target.count()).toBe(0);
        await settle();
        expect(ctx.state).toBe("running");
        // Further gestures do nothing.
        target.emit("click");
        expect(ctx.resume).toHaveBeenCalledTimes(2);
    });

    it("survives resume() rejecting", async () => {
        const ctx = suspended();
        ctx.resumeRejects = true;
        const target = new FakeEventTarget();
        resumeAudioContext(ctx, target);
        await settle();
        expect(target.count()).toBe(3);
        target.emit("keydown");
        await settle();
        expect(target.count()).toBe(0);
    });

    it("can be disposed early, and disposing twice is harmless", () => {
        const ctx = suspended();
        ctx.resumeMakesRunning = false;
        const target = new FakeEventTarget();
        const dispose = resumeAudioContext(ctx, target);
        dispose();
        expect(target.count()).toBe(0);
        dispose();
        expect(target.count()).toBe(0);
    });
});
