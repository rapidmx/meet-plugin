// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse, mockFetch } from "../testUtils.js";
import SettingsVideoConferencingPage, { findPersonalRoom } from "../../../apps/settings-video-conferencing/index.js";
import type { VideoMeetingDetail } from "@rapidmx/react-shared/videoconf/videoMeetingsApi.js";

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "America/New_York",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

function meeting(n: number, overrides: Partial<VideoMeetingDetail> = {}): VideoMeetingDetail {
    return {
        uid: `vm${n}`,
        mailboxUid: "mb1",
        title: `Meeting ${n}`,
        visibility: "private",
        status: "scheduled",
        dateCreated: `2026-01-0${n}T00:00:00.000Z`,
        ...overrides,
    };
}

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

/** Answers the list request with `meetings`. */
const listing = (meetings: unknown[]) => (url: string) => (url.startsWith("/api/mail/video-meetings?") ? jsonResponse(200, meetings) : undefined);

/** Replaces the clipboard (which `userEvent.setup()` stubs itself, so this must come after it). */
function stubClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

beforeEach(() => {
    window.history.pushState(null, "", "/settings/video-conferencing?mailboxUid=mb1");
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.pushState(null, "", "/");
});

describe("findPersonalRoom", () => {
    it("Picks the oldest non-cancelled public meeting.", () => {
        const older = meeting(1, { visibility: "public", dateCreated: "2026-01-01T00:00:00.000Z" });
        const newer = meeting(2, { visibility: "public", dateCreated: "2026-02-01T00:00:00.000Z" });
        expect(findPersonalRoom([newer, older])).toBe(older);
    });

    it("Skips a cancelled public meeting, and ignores private ones entirely.", () => {
        const cancelled = meeting(1, { visibility: "public", status: "cancelled", dateCreated: "2026-01-01T00:00:00.000Z" });
        const active = meeting(2, { visibility: "public", dateCreated: "2026-02-01T00:00:00.000Z" });
        const priv = meeting(3, { visibility: "private", dateCreated: "2025-01-01T00:00:00.000Z" });
        expect(findPersonalRoom([cancelled, active, priv])).toBe(active);
    });

    it("Returns undefined when there is no active public meeting.", () => {
        expect(findPersonalRoom([])).toBeUndefined();
        expect(findPersonalRoom([meeting(1, { visibility: "private" })])).toBeUndefined();
    });
});

describe("SettingsVideoConferencingPage", () => {
    it("Offers to create a personal room and shows no other meetings when the mailbox has none at all.", async () => {
        mockShell(listing([]));
        render(<SettingsVideoConferencingPage userUid="u1" />);

        expect(await screen.findByRole("button", { name: "Create my personal room" })).toBeInTheDocument();
        expect(screen.getByText("No other meetings yet.")).toBeInTheDocument();
    });

    it("Shows the load error message when the list fails.", async () => {
        mockShell((url) => (url.startsWith("/api/mail/video-meetings?") ? jsonResponse(500, { message: "boom" }) : undefined));
        render(<SettingsVideoConferencingPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("Shows a generic load error message on a non-API failure.", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/video-meetings?")) throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsVideoConferencingPage userUid="u1" />);
        expect(await screen.findByText("Could not load your video meetings.")).toBeInTheDocument();
    });

    it("Identifies the personal room from an existing list (the oldest active public meeting) and excludes it from the meetings table.", async () => {
        const room = meeting(1, { visibility: "public", title: "Personal Meeting Room", dateCreated: "2026-01-01T00:00:00.000Z", publicJoinUrl: "https://meet.example.com/room" });
        const otherPublic = meeting(2, { visibility: "public", title: "Town Hall", dateCreated: "2026-01-05T00:00:00.000Z", publicJoinUrl: "https://meet.example.com/townhall" });
        mockShell(listing([room, otherPublic]));
        render(<SettingsVideoConferencingPage userUid="u1" />);

        expect(await screen.findByDisplayValue("Personal Meeting Room")).toBeInTheDocument();
        expect(screen.getByText("https://meet.example.com/room")).toBeInTheDocument();
        // The room's own uid never appears as a plain row in the table below.
        const table = await screen.findByRole("table");
        expect(within(table).getByText("Town Hall")).toBeInTheDocument();
        expect(within(table).queryByText("Personal Meeting Room")).not.toBeInTheDocument();
    });

    it("Lists a private meeting only when it has a linked calendar event.", async () => {
        const linked = meeting(1, { visibility: "private", title: "Invited Sync", calendarEventUid: "evt-1" });
        const standalone = meeting(2, { visibility: "private", title: "Ad-hoc Test Meeting" });
        mockShell(listing([linked, standalone]));
        render(<SettingsVideoConferencingPage userUid="u1" />);

        expect(await screen.findByText("Invited Sync")).toBeInTheDocument();
        expect(screen.queryByText("Ad-hoc Test Meeting")).not.toBeInTheDocument();
    });

    it("Sorts the meetings table newest-created first.", async () => {
        // Private-with-a-linked-calendar-event, not public, so neither is mistaken for the personal room -
        // `findPersonalRoom()`'s own tests above already cover that logic in isolation.
        const older = meeting(1, { visibility: "private", calendarEventUid: "e1", title: "Older", dateCreated: "2026-01-01T00:00:00.000Z" });
        const newer = meeting(2, { visibility: "private", calendarEventUid: "e2", title: "Newer", dateCreated: "2026-01-10T00:00:00.000Z" });
        mockShell(listing([older, newer]));
        render(<SettingsVideoConferencingPage userUid="u1" />);

        const table = await screen.findByRole("table");
        const rows = within(table).getAllByRole("row").slice(1); // drop the header row
        expect(within(rows[0]).getByText("Newer")).toBeInTheDocument();
        expect(within(rows[1]).getByText("Older")).toBeInTheDocument();
    });

    it("Shows the created date and a human status label for a listed meeting.", async () => {
        const created = "2026-03-04T09:30:00.000Z";
        mockShell(listing([meeting(1, { visibility: "private", calendarEventUid: "e1", status: "ended", dateCreated: created })]));
        render(<SettingsVideoConferencingPage userUid="u1" />);

        expect(await screen.findByText(new Date(created).toLocaleString())).toBeInTheDocument();
        expect(screen.getByText("Ended")).toBeInTheDocument();
    });

    describe("Copy link (meetings table)", () => {
        // A decoy older public meeting occupies the "personal room" slot in every test here, so the meeting under
        // test - a second, newer public meeting - is guaranteed to land in the table instead of being identified
        // as the room (see `findPersonalRoom()`'s own dedicated tests above for that logic in isolation).
        const room = () => meeting(9, { visibility: "public", title: "Personal Meeting Room", dateCreated: "2020-01-01T00:00:00.000Z" });

        it("Copies a public meeting's link and reverts to 'Copy link' after two seconds.", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            mockShell(listing([room(), meeting(1, { visibility: "public", title: "Town Hall", publicJoinUrl: "https://meet.example.com/townhall" })]));
            const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
            render(<SettingsVideoConferencingPage userUid="u1" />);
            const button = await screen.findByRole("button", { name: "Copy link to Town Hall" });
            const writeText = vi.fn().mockResolvedValue(undefined);
            stubClipboard(writeText);

            await user.click(button);

            expect(writeText).toHaveBeenCalledWith("https://meet.example.com/townhall");
            expect(button).toHaveTextContent("Copied");
            await act(() => vi.advanceTimersByTimeAsync(1900));
            expect(button).toHaveTextContent("Copied");
            await act(() => vi.advanceTimersByTimeAsync(200));
            expect(button).toHaveTextContent("Copy link");
        });

        it("Shows an error message when the browser refuses the clipboard.", async () => {
            mockShell(listing([room(), meeting(1, { visibility: "public", title: "Town Hall", publicJoinUrl: "https://meet.example.com/townhall" })]));
            const user = userEvent.setup();
            render(<SettingsVideoConferencingPage userUid="u1" />);
            const button = await screen.findByRole("button", { name: "Copy link to Town Hall" });
            stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));

            await user.click(button);

            expect(await screen.findByText("Could not copy the link. Copy it by hand instead.")).toBeInTheDocument();
        });

        it("Keeps saying 'Copied' on a second link when the first one's timer runs out.", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            mockShell(
                listing([
                    room(),
                    meeting(1, { visibility: "public", title: "Town Hall", publicJoinUrl: "https://meet.example.com/townhall" }),
                    meeting(2, { visibility: "public", title: "Standup", publicJoinUrl: "https://meet.example.com/standup" }),
                ]),
            );
            const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
            render(<SettingsVideoConferencingPage userUid="u1" />);
            const first = await screen.findByRole("button", { name: "Copy link to Town Hall" });
            const second = screen.getByRole("button", { name: "Copy link to Standup" });
            stubClipboard(vi.fn().mockResolvedValue(undefined));

            await user.click(first);
            await act(() => vi.advanceTimersByTimeAsync(1000));
            await user.click(second);
            expect(first).toHaveTextContent("Copy link");
            expect(second).toHaveTextContent("Copied");

            // The first link's timer runs out here, and must not clear the second's confirmation.
            await act(() => vi.advanceTimersByTimeAsync(1100));
            expect(second).toHaveTextContent("Copied");
            await act(() => vi.advanceTimersByTimeAsync(1000));
            expect(second).toHaveTextContent("Copy link");
        });

        it("Offers no copy action for a private meeting, or a public one with no configured public URL.", async () => {
            mockShell(
                listing([
                    meeting(1, { visibility: "private", title: "Invited Sync", calendarEventUid: "evt-1" }),
                    meeting(2, { visibility: "public", title: "No URL Yet", publicJoinUrl: undefined }),
                ]),
            );
            render(<SettingsVideoConferencingPage userUid="u1" />);
            await screen.findByText("Invited Sync");
            expect(screen.queryByRole("button", { name: /Copy link/ })).not.toBeInTheDocument();
        });
    });

    describe("Cancel (meetings table)", () => {
        // Private-with-a-linked-calendar-event throughout, so the meeting under test is never mistaken for the
        // personal room (see the "Copy link" describe block above for the same reasoning where a public meeting
        // is actually needed).
        it("Cancels a scheduled meeting, after which the Cancel action disappears and its status updates - leaving an unrelated meeting's own status untouched.", async () => {
            const target = meeting(1, { visibility: "private", calendarEventUid: "e1", title: "Team Sync", status: "scheduled" });
            const other = meeting(2, { visibility: "private", calendarEventUid: "e2", title: "Other Sync", status: "scheduled" });
            const fetchMock = mockShell(listing([target, other]));
            fetchMock.mockImplementation((url: string, init?: RequestInit) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/video-meetings?")) return jsonResponse(200, [target, other]);
                if (url === "/api/mail/video-meetings/vm1" && init?.method === "PUT") {
                    return jsonResponse(200, {
                        uid: "vm1",
                        mailboxUid: "mb1",
                        title: "Team Sync",
                        visibility: "private",
                        status: "cancelled",
                        dateCreated: "2026-01-01T00:00:00.000Z",
                    });
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<SettingsVideoConferencingPage userUid="u1" />);

            const button = await screen.findByRole("button", { name: "Cancel Team Sync" });
            await user.click(button);

            expect(await screen.findByText("Cancelled")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel Team Sync" })).not.toBeInTheDocument();
            // The other meeting is still scheduled and still cancellable - the update was scoped to its own uid.
            expect(screen.getByRole("button", { name: "Cancel Other Sync" })).toBeInTheDocument();
        });

        it("Shows an error message when cancelling fails, and re-enables the button.", async () => {
            const fetchMock = mockShell(listing([meeting(1, { visibility: "private", calendarEventUid: "e1", title: "Team Sync" })]));
            fetchMock.mockImplementation((url: string, init?: RequestInit) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/video-meetings?")) return jsonResponse(200, [meeting(1, { visibility: "private", calendarEventUid: "e1", title: "Team Sync" })]);
                if (url === "/api/mail/video-meetings/vm1" && init?.method === "PUT") return jsonResponse(403, { message: "Forbidden.", code: "api-103" });
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<SettingsVideoConferencingPage userUid="u1" />);

            const button = await screen.findByRole("button", { name: "Cancel Team Sync" });
            await user.click(button);

            expect(await screen.findByText("Forbidden.")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Cancel Team Sync" })).toBeEnabled();
        });

        it("Shows a generic error message when cancelling fails with a non-API error.", async () => {
            const fetchMock = mockShell(listing([meeting(1, { visibility: "private", calendarEventUid: "e1", title: "Team Sync" })]));
            fetchMock.mockImplementation((url: string, init?: RequestInit) => {
                if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
                if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
                if (url.startsWith("/api/mail/video-meetings?")) return jsonResponse(200, [meeting(1, { visibility: "private", calendarEventUid: "e1", title: "Team Sync" })]);
                if (url === "/api/mail/video-meetings/vm1" && init?.method === "PUT") throw new TypeError("network down");
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
            const user = userEvent.setup();
            render(<SettingsVideoConferencingPage userUid="u1" />);

            const button = await screen.findByRole("button", { name: "Cancel Team Sync" });
            await user.click(button);

            expect(await screen.findByText("Could not cancel this meeting.")).toBeInTheDocument();
        });

        it("Offers no cancel action for a meeting that isn't scheduled.", async () => {
            mockShell(listing([meeting(1, { visibility: "private", calendarEventUid: "e1", title: "Old Team Sync", status: "ended" })]));
            render(<SettingsVideoConferencingPage userUid="u1" />);
            await screen.findByText("Old Team Sync");
            expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument();
        });
    });

    it("Renames the personal room from the page, leaving an unrelated meeting's title untouched.", async () => {
        const room = meeting(1, { visibility: "public", title: "Personal Meeting Room", dateCreated: "2026-01-01T00:00:00.000Z" });
        const other = meeting(2, { visibility: "private", calendarEventUid: "e1", title: "Team Sync", dateCreated: "2026-01-02T00:00:00.000Z" });
        const fetchMock = mockShell(listing([room, other]));
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/video-meetings?")) return jsonResponse(200, [room, other]);
            if (url === "/api/mail/video-meetings/vm1" && init?.method === "PUT") {
                return jsonResponse(200, { uid: "vm1", mailboxUid: "mb1", title: "Renamed Room", visibility: "public", status: "scheduled", dateCreated: room.dateCreated });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<SettingsVideoConferencingPage userUid="u1" />);

        const input = await screen.findByDisplayValue("Personal Meeting Room");
        await user.clear(input);
        await user.type(input, "Renamed Room");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByDisplayValue("Renamed Room")).toBeInTheDocument();
        // The other, unrelated meeting's own title is unaffected by the room's rename.
        expect(screen.getByText("Team Sync")).toBeInTheDocument();
    });

    it("Creates a personal room from the page and it stops appearing as an ordinary row.", async () => {
        const fetchMock = mockShell(listing([]));
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/video-meetings?")) return jsonResponse(200, []);
            if (url === "/api/mail/video-meetings" && init?.method === "POST") {
                return jsonResponse(200, {
                    meeting: { uid: "vm9", mailboxUid: "mb1", title: "Personal Meeting Room", visibility: "public", status: "scheduled", dateCreated: "2026-05-01T00:00:00.000Z" },
                    publicJoinUrl: "https://meet.example.com/newroom",
                });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<SettingsVideoConferencingPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "Create my personal room" }));

        expect(await screen.findByText("https://meet.example.com/newroom")).toBeInTheDocument();
        expect(screen.getByText("No other meetings yet.")).toBeInTheDocument();
    });
});
