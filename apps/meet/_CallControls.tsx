///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** The in-call bottom control bar: mute/unmute, camera on/off, share screen, grid/focus toggle, leave. Deliberately
 * minimal per this plugin's Phase 2 spec ("no chat, no recording, no reactions"). */
import React from "react";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

export type CallViewMode = "grid" | "focus";

export interface CallControlsProps {
    micOn: boolean;
    onToggleMic: () => void;
    cameraOn: boolean;
    onToggleCamera: () => void;
    isPresenting: boolean;
    /** Someone else is presenting - the share button is disabled and explains why. */
    presentingElsewhereName?: string;
    onToggleShare: () => void;
    viewMode: CallViewMode;
    onToggleViewMode: () => void;
    onLeave: () => void;
}

export default function CallControls({
    micOn,
    onToggleMic,
    cameraOn,
    onToggleCamera,
    isPresenting,
    presentingElsewhereName,
    onToggleShare,
    viewMode,
    onToggleViewMode,
    onLeave,
}: CallControlsProps) {
    const shareDisabled = !isPresenting && !!presentingElsewhereName;
    return (
        <div className="flex flex-wrap items-center justify-center gap-2 py-3 px-4 bg-surface border-t border-border">
            <Button type="button" variant="secondary" className="!w-auto" onClick={onToggleMic}>
                {micOn ? "Mute" : "Unmute"}
            </Button>
            <Button type="button" variant="secondary" className="!w-auto" onClick={onToggleCamera}>
                {cameraOn ? "Turn camera off" : "Turn camera on"}
            </Button>
            <Button
                type="button"
                variant="secondary"
                className="!w-auto"
                disabled={shareDisabled}
                title={shareDisabled ? `${presentingElsewhereName} is presenting - stop their share to present yourself.` : undefined}
                onClick={onToggleShare}
            >
                {isPresenting ? "Stop sharing" : "Share screen"}
            </Button>
            <Button type="button" variant="secondary" className="!w-auto" onClick={onToggleViewMode}>
                {viewMode === "grid" ? "Focused view" : "Grid view"}
            </Button>
            <Button
                type="button"
                className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                onClick={onLeave}
            >
                Leave
            </Button>
        </div>
    );
}
