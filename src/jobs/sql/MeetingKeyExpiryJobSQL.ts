///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { CalendarEventAttendeeLinkSQL } from "@rapidmx/restapi/sql";
import { VideoMeetingSQL } from "../../models/sql/VideoMeetingSQL.js";
import { VideoMeetingInviteeSQL } from "../../models/sql/VideoMeetingInviteeSQL.js";
import { MeetingKeyExpiryJob } from "../MeetingKeyExpiryJob.js";

export class MeetingKeyExpiryJobSQL extends MeetingKeyExpiryJob {
    protected meetingClass: any = VideoMeetingSQL;
    protected inviteeClass: any = VideoMeetingInviteeSQL;
    protected attendeeLinkClass: any = CalendarEventAttendeeLinkSQL;
}
