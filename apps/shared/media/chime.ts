///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** The short two-note chime played when another participant raises their hand - synthesized with Web Audio, so there
 * is no sound file to ship. Never throws and does nothing where there is no `AudioContext` (SSR, an old browser):
 * the raised hand is also shown on screen, the chime is an extra. */

/** The subset of `AudioContext` this module uses - what a test's fake implements. */
export interface ChimeAudioContext {
    readonly currentTime: number;
    readonly state: string;
    readonly destination: unknown;
    createGain(): {
        gain: { setValueAtTime(value: number, time: number): void; exponentialRampToValueAtTime(value: number, time: number): void };
        connect(destination: unknown): void;
    };
    createOscillator(): {
        type: string;
        frequency: { setValueAtTime(value: number, time: number): void };
        connect(destination: unknown): void;
        start(time: number): void;
        stop(time: number): void;
    };
    resume(): Promise<void> | void;
    close(): Promise<void> | void;
}

export type ChimeContextFactory = () => ChimeAudioContext | undefined;

/** The real `AudioContext`/`webkitAudioContext`, or `undefined` where there is none. */
export function defaultChimeContext(): ChimeAudioContext | undefined {
    if (typeof window === "undefined") {
        return undefined;
    }
    const Ctor: (new () => ChimeAudioContext) | undefined =
        (window as unknown as { AudioContext?: new () => ChimeAudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: new () => ChimeAudioContext }).webkitAudioContext;
    return Ctor ? new Ctor() : undefined;
}

/** The two notes (Hz) and how long each lasts (seconds). */
const NOTES = [880, 1320] as const;
const NOTE_SECONDS = 0.18;

export function playRaisedHandChime(createContext: ChimeContextFactory = defaultChimeContext): void {
    try {
        const context = createContext();
        if (!context) {
            return;
        }
        if (context.state === "suspended") {
            void context.resume();
        }
        const start = context.currentTime;
        const end = start + NOTE_SECONDS * NOTES.length + 0.25;
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.25, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        gain.connect(context.destination);
        NOTES.forEach((frequency, index) => {
            const oscillator = context.createOscillator();
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(frequency, start);
            oscillator.connect(gain);
            oscillator.start(start + index * NOTE_SECONDS);
            oscillator.stop(start + (index + 1) * NOTE_SECONDS + 0.1);
        });
        setTimeout(() => void context.close(), (end - start) * 1000 + 200);
    } catch {
        // Audio is best-effort here - the hand is shown on screen regardless.
    }
}
