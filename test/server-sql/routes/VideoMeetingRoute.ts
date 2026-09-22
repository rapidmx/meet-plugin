import { RouteDecorators } from "@rapidrest/service-core";
import { VideoMeetingRouteSQL } from "../../../src/routes/sql/VideoMeetingRouteSQL.js";
const { Route } = RouteDecorators;

@Route("/sql/video-meetings")
export class VideoMeetingRoute extends VideoMeetingRouteSQL {}
