///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { CalendarEventAttendeeLinkMongo } from "@rapidmx/restapi/mongo";
import { VideoMeetingMongo } from "../../models/mongo/VideoMeetingMongo.js";
import { VideoMeetingInviteeMongo } from "../../models/mongo/VideoMeetingInviteeMongo.js";
import { MeetingKeyExpiryJob } from "../MeetingKeyExpiryJob.js";

export class MeetingKeyExpiryJobMongo extends MeetingKeyExpiryJob {
    protected meetingClass: any = VideoMeetingMongo;
    protected inviteeClass: any = VideoMeetingInviteeMongo;
    protected attendeeLinkClass: any = CalendarEventAttendeeLinkMongo;
}
