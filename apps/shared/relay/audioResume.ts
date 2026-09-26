///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { AudioContextLike, EventTargetLike } from "./relayEnv.js";

/** The user gestures a browser accepts as permission to start audio. */
const GESTURE_EVENTS = ["pointerdown", "click", "keydown"] as const;

/**
 * Gets a suspended `AudioContext` running. A context created without a user gesture (the relay creates its
 * playback context when the mesh falls back, which nothing the user just did caused) starts suspended under the
 * browsers' autoplay policies, and stays silent until `resume()` is called from a gesture. So this tries
 * `resume()` immediately - which succeeds when the page already has user activation, the usual case in a call the
 * user clicked "Join" for - and otherwise retries on the next `pointerdown`/`click`/`keydown`, removing the
 * listeners as soon as the context is running (or after that one retry, so an unhelpful browser doesn't keep a
 * listener on `document` forever). Returns a function that removes the listeners early. A no-op when the context
 * is not suspended.
 */
export function resumeAudioContext(ctx: AudioContextLike, target: EventTargetLike): () => void {
    if (ctx.state !== "suspended") {
        return () => undefined;
    }
    let disposed = false;
    const dispose = (): void => {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const type of GESTURE_EVENTS) {
            target.removeEventListener(type, onGesture, true);
        }
    };
    const tryResume = (): void => {
        // `resume()` returns a promise that stays pending until the browser allows it (and can reject); neither is
        // something the caller can act on, and the next gesture is the retry.
        ctx.resume().then(
            () => {
                if (ctx.state === "running") {
                    dispose();
                }
            },
            () => undefined,
        );
    };
    function onGesture(): void {
        tryResume();
        dispose();
    }
    for (const type of GESTURE_EVENTS) {
        target.addEventListener(type, onGesture, true);
    }
    tryResume();
    return dispose;
}
