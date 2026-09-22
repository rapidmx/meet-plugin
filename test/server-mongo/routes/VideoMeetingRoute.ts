import { RouteDecorators } from "@rapidrest/service-core";
import { VideoMeetingRouteMongo } from "../../../src/routes/mongo/VideoMeetingRouteMongo.js";
const { Route } = RouteDecorators;

@Route("/mongo/video-meetings")
export class VideoMeetingRoute extends VideoMeetingRouteMongo {}
