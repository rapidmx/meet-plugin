///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * This plugin's `./mongo` entry point: exactly the classes a server host loads for a Mongo deployment - the video
 * meeting models and the route mounted at `/api/mail/video-meetings`. Anything else exported here would be
 * registered by the host too, so the abstract route and utilities stay in the package root.
 */
export { VideoMeetingMongo } from "./models/mongo/VideoMeetingMongo.js";
export { VideoMeetingInviteeMongo } from "./models/mongo/VideoMeetingInviteeMongo.js";
export { VideoMeetingRouteMongo } from "./routes/mongo/VideoMeetingRouteMongo.js";
