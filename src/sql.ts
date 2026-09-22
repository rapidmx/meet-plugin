///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * This plugin's `./sql` entry point: exactly the classes a server host loads for a SQL deployment - the video
 * meeting models and the route mounted at `/api/mail/video-meetings`. Anything else exported here would be
 * registered by the host too, so the abstract route and utilities stay in the package root.
 */
export { VideoMeetingSQL } from "./models/sql/VideoMeetingSQL.js";
export { VideoMeetingInviteeSQL } from "./models/sql/VideoMeetingInviteeSQL.js";
export { VideoMeetingRouteSQL } from "./routes/sql/VideoMeetingRouteSQL.js";
