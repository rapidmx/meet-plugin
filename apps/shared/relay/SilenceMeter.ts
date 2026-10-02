///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** A sample this close to zero counts as silent: about -80 dBFS, well under the noise floor of any real microphone
 * (even through noise suppression), so only digital silence - a zero-filled block - falls below it. */
export const SILENCE_THRESHOLD = 1e-4;
/** A run of silent samples counts only once it lasts this long, so a waveform merely crossing zero never does. */
export const MIN_SILENT_RUN_SECONDS = 0.005;

/**
 * Measures how much of a PCM stream is digital silence, for the relay's diagnostics. A live microphone always carries
 * some noise, so stretches of exact (or near-exact) zero mean the audio was lost or zero-filled somewhere on its way,
 * not that the room went quiet. Runs are tracked across `feed()` calls, so a gap that straddles two blocks counts in
 * full.
 */
export class SilenceMeter {
    private totalSeconds = 0;
    private silentSeconds = 0;
    private run = 0;
    private runRate = 0;

    /** Adds one block of `sampleRate` Hz samples. */
    feed(samples: Float32Array, sampleRate: number): void {
        if (sampleRate !== this.runRate) {
            this.endRun();
            this.runRate = sampleRate;
        }
        for (const sample of samples) {
            if (Math.abs(sample) < SILENCE_THRESHOLD) {
                this.run += 1;
            } else if (this.run > 0) {
                this.endRun();
            }
        }
        this.totalSeconds += samples.length / sampleRate;
    }

    /** Milliseconds of audio fed so far. */
    get totalMs(): number {
        return this.totalSeconds * 1000;
    }

    /** Milliseconds of it that were silent - including a silent run still in progress once it is long enough. */
    get silentMs(): number {
        return (this.silentSeconds + this.runSeconds(this.run)) * 1000;
    }

    private runSeconds(run: number): number {
        const seconds = this.runRate > 0 ? run / this.runRate : 0;
        return seconds >= MIN_SILENT_RUN_SECONDS ? seconds : 0;
    }

    private endRun(): void {
        this.silentSeconds += this.runSeconds(this.run);
        this.run = 0;
    }
}
