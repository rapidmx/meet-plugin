///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { MailboxMongo } from "@rapidmx/restapi/mongo";
import { VideoMeetingMongo } from "../../models/mongo/VideoMeetingMongo.js";
import { VideoMeetingInviteeMongo } from "../../models/mongo/VideoMeetingInviteeMongo.js";
import { BaseVideoMeetingRoute } from "../BaseVideoMeetingRoute.js";
const { ApiRoute, Model } = RouteDecorators;

/** The owner's video meeting management endpoints and the anonymous join endpoint (`/api/mail/video-meetings`). */
@ApiRoute("mail/video-meetings")
@Model(VideoMeetingMongo)
export class VideoMeetingRouteMongo extends BaseVideoMeetingRoute<VideoMeetingMongo, VideoMeetingInviteeMongo, MailboxMongo> {
    protected meetingClass: any = VideoMeetingMongo;
    protected inviteeClass: any = VideoMeetingInviteeMongo;
    protected mailboxClass: any = MailboxMongo;
}
