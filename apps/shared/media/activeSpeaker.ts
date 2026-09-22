///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Pure active-speaker selection logic, decoupled from `levelMeter.ts`'s `AnalyserNode` wiring so it can be unit
 * tested with plain numbers - no `AudioContext`/DOM at all. A simple volume-threshold heuristic, as this plugin's
 * Phase 2 `.claude/NOTES.md` entry calls for ("this doesn't need to be sophisticated"): the loudest participant
 * currently above `threshold` becomes the pick; below threshold, the previous pick is kept rather than falling
 * back to nobody, so the focused tile doesn't flicker to a blank state during a brief pause in speech.
 */

/** 0-100 (`levelMeter.ts`'s own output range). Chosen empirically as "clearly speaking" vs. room noise/silence -
 * not derived from any spec, and the easiest constant to retune later. */
export const DEFAULT_ACTIVE_SPEAKER_THRESHOLD = 12;

/**
 * Picks who should be auto-focused, given every remote participant's current audio level (local participant
 * excluded by the caller - see `_CallView.tsx`, which never lets "yourself" be the auto-detected speaker).
 *
 * @param levels uid -> level (0-100), one entry per participant currently being measured.
 * @param current The currently auto-focused uid, if any - kept when no one is clearly above `threshold`, and used
 * to break an exact tie (staying on the current speaker rather than jittering to another equally-loud one).
 * @param threshold See `DEFAULT_ACTIVE_SPEAKER_THRESHOLD`.
 */
export function pickActiveSpeaker(
    levels: Readonly<Record<string, number>>,
    current: string | undefined,
    threshold: number = DEFAULT_ACTIVE_SPEAKER_THRESHOLD,
): string | undefined {
    let best: string | undefined;
    let bestLevel = threshold;
    for (const [uid, level] of Object.entries(levels)) {
        if (level > bestLevel || (level === bestLevel && uid === current)) {
            best = uid;
            bestLevel = level;
        }
    }
    if (best) {
        return best;
    }
    // Nobody is clearly above threshold: keep the current pick only if they're still a measured participant
    // (they may have left), otherwise there's no reasonable pick at all.
    return current && current in levels ? current : undefined;
}
