// Re-exports the `@rapidmx/restapi` model classes the video meeting routes read (`Mailbox`, for the host display
// name), so the test Server's ClassLoader (rooted at `test/server-mongo`) can discover their `@DataStore` metadata
// alongside the test routes that use them. Deliberately a named (not wildcard) re-export: `@rapidmx/restapi/mongo`
// bundles routes and jobs alongside its models, and a wildcard re-export would make the ClassLoader discover and
// start every one of them too.
export { CalendarEventAttendeeLinkMongo, MailboxMongo } from "@rapidmx/restapi/mongo";
// This plugin's own models.
export { VideoMeetingMongo } from "../../../src/models/mongo/VideoMeetingMongo.js";
export { VideoMeetingInviteeMongo } from "../../../src/models/mongo/VideoMeetingInviteeMongo.js";
