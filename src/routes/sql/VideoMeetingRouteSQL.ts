///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { CalendarEventAttendeeLinkSQL, MailboxSQL } from "@rapidmx/restapi/sql";
import { VideoMeetingSQL } from "../../models/sql/VideoMeetingSQL.js";
import { VideoMeetingInviteeSQL } from "../../models/sql/VideoMeetingInviteeSQL.js";
import { BaseVideoMeetingRoute } from "../BaseVideoMeetingRoute.js";
const { ApiRoute, Model } = RouteDecorators;

/** The owner's video meeting management endpoints and the anonymous join endpoint (`/api/mail/video-meetings`). */
@ApiRoute("mail/video-meetings")
@Model(VideoMeetingSQL)
export class VideoMeetingRouteSQL extends BaseVideoMeetingRoute<VideoMeetingSQL, VideoMeetingInviteeSQL, MailboxSQL> {
    protected meetingClass: any = VideoMeetingSQL;
    protected inviteeClass: any = VideoMeetingInviteeSQL;
    protected mailboxClass: any = MailboxSQL;
    protected attendeeLinkClass: any = CalendarEventAttendeeLinkSQL;
}
