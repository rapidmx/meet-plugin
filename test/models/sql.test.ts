///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { isMailboxScopedData } from "@rapidmx/restapi";
import { VideoMeetingStatus, VideoMeetingVisibility } from "../../src/models/types.js";
import { VideoMeetingSQL } from "../../src/models/sql/VideoMeetingSQL.js";
import { VideoMeetingInviteeSQL } from "../../src/models/sql/VideoMeetingInviteeSQL.js";

describe("SQL model default construction", () => {
    it("VideoMeetingSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new VideoMeetingSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.calendarEventUid).toBeUndefined();
        expect(obj.title).toBe("");
        expect(obj.visibility).toBe(VideoMeetingVisibility.PRIVATE);
        expect(obj.publicSlug).toBeUndefined();
        expect(obj.status).toBe(VideoMeetingStatus.SCHEDULED);
        expect(obj.startTime).toBeUndefined();
        expect(obj.endTime).toBeUndefined();
    });

    it("VideoMeetingSQL applies provided overrides when constructed with data.", () => {
        const startTime = new Date("2026-06-01T13:00:00Z");
        const endTime = new Date("2026-06-01T14:00:00Z");
        const obj = new VideoMeetingSQL({
            mailboxUid: "mailbox-1",
            calendarEventUid: "event-1",
            title: "Weekly Sync",
            visibility: VideoMeetingVisibility.PUBLIC,
            publicSlug: "abc12345xyz",
            status: VideoMeetingStatus.ACTIVE,
            startTime,
            endTime,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.calendarEventUid).toBe("event-1");
        expect(obj.title).toBe("Weekly Sync");
        expect(obj.visibility).toBe(VideoMeetingVisibility.PUBLIC);
        expect(obj.publicSlug).toBe("abc12345xyz");
        expect(obj.status).toBe(VideoMeetingStatus.ACTIVE);
        expect(obj.startTime).toBe(startTime);
        expect(obj.endTime).toBe(endTime);
    });

    it("VideoMeetingSQL keeps class defaults for fields omitted from a partial constructor call.", () => {
        const obj = new VideoMeetingSQL({ mailboxUid: "mailbox-1", title: "Standup" });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.title).toBe("Standup");
        expect(obj.visibility).toBe(VideoMeetingVisibility.PRIVATE);
        expect(obj.calendarEventUid).toBeUndefined();
        expect(obj.publicSlug).toBeUndefined();
    });

    it("VideoMeetingSQL keeps every class default when constructed with an empty partial object.", () => {
        const obj = new VideoMeetingSQL({});

        expect(obj.mailboxUid).toBe("");
        expect(obj.title).toBe("");
        expect(obj.status).toBe(VideoMeetingStatus.SCHEDULED);
    });

    it("VideoMeetingSQL honors an explicit clear of a nullable field.", () => {
        const cleared = new VideoMeetingSQL({ calendarEventUid: null as any, publicSlug: undefined });
        expect(cleared.calendarEventUid).toBeNull();
        expect(cleared.publicSlug).toBeUndefined();
    });

    it("VideoMeetingInviteeSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new VideoMeetingInviteeSQL();

        expect(obj.meetingUid).toBe("");
        expect(obj.mailboxUid).toBe("");
        expect(obj.email).toBe("");
        expect(obj.displayName).toBeUndefined();
        expect(obj.joinToken).toBe("");
    });

    it("VideoMeetingInviteeSQL applies provided overrides when constructed with data.", () => {
        const obj = new VideoMeetingInviteeSQL({
            meetingUid: "meeting-1",
            mailboxUid: "mailbox-1",
            email: "grace@example.com",
            displayName: "Grace Hopper",
            joinToken: "token-1",
        });

        expect(obj.meetingUid).toBe("meeting-1");
        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.email).toBe("grace@example.com");
        expect(obj.displayName).toBe("Grace Hopper");
        expect(obj.joinToken).toBe("token-1");
    });

    it("VideoMeetingInviteeSQL keeps class defaults for fields omitted from a partial constructor call, and honors an explicit clear.", () => {
        const partial = new VideoMeetingInviteeSQL({ meetingUid: "meeting-1", email: "grace@example.com" });
        expect(partial.meetingUid).toBe("meeting-1");
        expect(partial.displayName).toBeUndefined();

        const empty = new VideoMeetingInviteeSQL({});
        expect(empty.meetingUid).toBe("");
        expect(empty.email).toBe("");

        const cleared = new VideoMeetingInviteeSQL({ displayName: undefined });
        expect(cleared.displayName).toBeUndefined();
    });

    it("marks both models as mailbox-scoped data, so a mailbox's erasure removes them.", () => {
        expect(isMailboxScopedData(VideoMeetingSQL)).toBe(true);
        expect(isMailboxScopedData(VideoMeetingInviteeSQL)).toBe(true);
    });

    it("declares VideoMeeting's per-record ACL (recordACL: true) and VideoMeetingInvitee's deny-all class-only ACL.", () => {
        expect(Reflect.getMetadata("rrst:recordACL", VideoMeetingSQL)).toBe(true);
        expect(Reflect.getMetadata("rrst:recordACL", VideoMeetingInviteeSQL)).toBe(false);
    });
});
