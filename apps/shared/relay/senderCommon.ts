///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { FrameKind } from "./frames.js";
import type { RelayEnv } from "./relayEnv.js";

/** Hands one encoded frame to the transport. `timestampMs` is on the `env.now()` clock. Returns whether every
 * fragment of it was accepted by the socket - `false` means it was dropped (not ready, or backed up), which for
 * video means the receiver will need a fresh key frame. */
export type PublishFrame = (kind: FrameKind, keyFrame: boolean, data: Uint8Array, timestampMs: number) => boolean;

/** What `AudioSender` and `VideoSender` are given. */
export interface SenderDeps {
    env: RelayEnv;
    publish: PublishFrame;
    /** Whether a frame encoded now could actually be sent. Encoding while the socket is down or still handshaking
     * would burn CPU on frames that are then dropped, so the senders idle instead. */
    canSend: () => boolean;
}

/** Closes an encoder/decoder, ignoring the `InvalidStateError` a browser throws for one that is already closed
 * (which is what a coder that reported an error is). */
export function safeClose(coder: { close(): void } | undefined): void {
    try {
        coder?.close();
    } catch {
        // Already closed.
    }
}
