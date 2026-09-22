///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Private and public WebRTC video conferencing for a `@rapidmx/restapi`-based mail server: a mailbox owner creates
 * a `VideoMeeting` (private, with one join link per invitee, or public, with a single shareable link), and a
 * participant - the owner or an anonymous guest holding a valid link - joins it and exchanges WebRTC signaling
 * over the server's existing `/push` channel (see `BaseVideoMeetingRoute`'s class doc comment).
 *
 * This module exports only the backend-agnostic surface: the entity interfaces, the pure ICE-server/public-URL/
 * token utilities, and the abstract route. The concrete Mongo/SQL classes a server loads (models and the route
 * mounted at `/api/mail/video-meetings`) come from this package's `./mongo` and `./sql` entry points.
 */
export * from "./models/types.js";
export * from "./util/IceServerUtils.js";
export * from "./util/PublicUrlUtils.js";
export * from "./util/RouteAccessUtils.js";
export * from "./util/TokenUtils.js";
export * from "./routes/BaseVideoMeetingRoute.js";
