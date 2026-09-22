// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse, mockFetch } from "../testUtils.js";
import PersonalRoomCard, { PERSONAL_ROOM_TITLE } from "../../../apps/settings-video-conferencing/_PersonalRoomCard.js";
import type { VideoMeetingDetail } from "@rapidmx/react-shared/videoconf/videoMeetingsApi.js";

function room(overrides: Partial<VideoMeetingDetail> = {}): VideoMeetingDetail {
    return {
        uid: "vm1",
        mailboxUid: "mb1",
        title: "Personal Meeting Room",
        visibility: "public",
        status: "scheduled",
        dateCreated: "2026-01-01T00:00:00.000Z",
        publicJoinUrl: "https://meet.example.com/abc12345678",
        ...overrides,
    };
}

/** Replaces the clipboard (which `userEvent.setup()` stubs itself, so this must come after it). */
function stubClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("PersonalRoomCard", () => {
    it("Offers to create a room when there is none yet.", () => {
        render(<PersonalRoomCard mailboxUid="mb1" room={undefined} onCreated={vi.fn()} onRenamed={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Create my personal room" })).toBeInTheDocument();
        expect(screen.queryByText(/personal room name/i)).not.toBeInTheDocument();
    });

    it("Creates a room and reports it to the parent.", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, {
                meeting: { uid: "vm9", mailboxUid: "mb1", title: PERSONAL_ROOM_TITLE, visibility: "public", status: "scheduled", dateCreated: "2026-02-01T00:00:00.000Z" },
                publicJoinUrl: "https://meet.example.com/newslug1234",
            }),
        );
        const onCreated = vi.fn();
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={undefined} onCreated={onCreated} onRenamed={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Create my personal room" }));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/video-meetings",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ mailboxUid: "mb1", title: PERSONAL_ROOM_TITLE, visibility: "public" }),
            }),
        );
        expect(onCreated).toHaveBeenCalledWith({
            uid: "vm9",
            mailboxUid: "mb1",
            title: PERSONAL_ROOM_TITLE,
            visibility: "public",
            status: "scheduled",
            dateCreated: "2026-02-01T00:00:00.000Z",
            publicJoinUrl: "https://meet.example.com/newslug1234",
        });
    });

    it("Shows an error message when creation fails.", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={undefined} onCreated={vi.fn()} onRenamed={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Create my personal room" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("Shows a generic error message when creation fails with a non-API error.", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={undefined} onCreated={vi.fn()} onRenamed={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Create my personal room" }));

        expect(await screen.findByText("Could not create your personal room.")).toBeInTheDocument();
    });

    it("Shows the room's title and link.", () => {
        render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={vi.fn()} />);
        expect(screen.getByDisplayValue("Personal Meeting Room")).toBeInTheDocument();
        expect(screen.getByText("https://meet.example.com/abc12345678")).toBeInTheDocument();
    });

    it("Shows a note instead of a link when no public URL is configured for the deployment.", () => {
        render(<PersonalRoomCard mailboxUid="mb1" room={room({ publicJoinUrl: undefined })} onCreated={vi.fn()} onRenamed={vi.fn()} />);
        expect(screen.getByText(/No public join page URL is configured/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    });

    it("Disables Save until the name actually changes.", async () => {
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={vi.fn()} />);
        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();

        await user.type(screen.getByDisplayValue("Personal Meeting Room"), "!");
        expect(save).toBeEnabled();

        await user.clear(screen.getByRole("textbox"));
        expect(save).toBeDisabled();
    });

    it("Renames the room and reports the new title to the parent.", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, { uid: "vm1", mailboxUid: "mb1", title: "Team Hangout", visibility: "public", status: "scheduled", dateCreated: "2026-01-01T00:00:00.000Z" }),
        );
        const onRenamed = vi.fn();
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={onRenamed} />);

        const input = screen.getByDisplayValue("Personal Meeting Room");
        await user.clear(input);
        await user.type(input, "Team Hangout");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/video-meetings/vm1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ title: "Team Hangout" }) }),
        );
        expect(onRenamed).toHaveBeenCalledWith("vm1", "Team Hangout");
    });

    it("Shows an error message when the rename fails.", async () => {
        mockFetch(() => jsonResponse(403, { message: "Forbidden.", code: "api-103" }));
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={vi.fn()} />);

        const input = screen.getByDisplayValue("Personal Meeting Room");
        await user.type(input, "!");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Forbidden.")).toBeInTheDocument();
    });

    it("Shows a generic error message when the rename fails with a non-API error.", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={vi.fn()} />);

        const input = screen.getByDisplayValue("Personal Meeting Room");
        await user.type(input, "!");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not rename your personal room.")).toBeInTheDocument();
    });

    it("Does nothing when the form is submitted with only whitespace typed in.", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={vi.fn()} />);

        const input = screen.getByDisplayValue("Personal Meeting Room");
        await user.clear(input);
        await user.type(input, "   ");
        // The Save button is disabled for a blank name, but the form can still be submitted directly (e.g. a
        // browser's own implicit "Enter submits the form" behavior) - `handleRename` itself must also refuse a
        // blank/unchanged name, not just the disabled button.
        fireEvent.submit(input.closest("form")!);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("Copies the room's link and says so, then reverts after two seconds.", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={vi.fn()} />);
        const button = screen.getByRole("button", { name: "Copy" });
        const writeText = vi.fn().mockResolvedValue(undefined);
        stubClipboard(writeText);

        await user.click(button);

        expect(writeText).toHaveBeenCalledWith("https://meet.example.com/abc12345678");
        expect(button).toHaveTextContent("Copied");

        await act(() => vi.advanceTimersByTimeAsync(1900));
        expect(button).toHaveTextContent("Copied");
        await act(() => vi.advanceTimersByTimeAsync(200));
        expect(button).toHaveTextContent("Copy");
    });

    it("Shows an error message when the browser refuses the clipboard.", async () => {
        const user = userEvent.setup();
        render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={vi.fn()} />);
        const button = screen.getByRole("button", { name: "Copy" });
        stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));

        await user.click(button);

        expect(await screen.findByText("Could not copy the link. Copy it by hand instead.")).toBeInTheDocument();
    });

    it("Resets the name draft when a different room is passed in.", () => {
        const { rerender } = render(<PersonalRoomCard mailboxUid="mb1" room={room()} onCreated={vi.fn()} onRenamed={vi.fn()} />);
        expect(screen.getByDisplayValue("Personal Meeting Room")).toBeInTheDocument();

        rerender(<PersonalRoomCard mailboxUid="mb1" room={room({ uid: "vm2", title: "Fresh Room" })} onCreated={vi.fn()} onRenamed={vi.fn()} />);
        expect(screen.getByDisplayValue("Fresh Room")).toBeInTheDocument();
    });
});
