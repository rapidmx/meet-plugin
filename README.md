# RapidMX: Video Conferencing

[![CI](https://github.com/RapidMX/meet-plugin/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/RapidMX/meet-plugin/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/RapidMX/meet-plugin/badge.svg?branch=main)](https://coveralls.io/github/RapidMX/meet-plugin?branch=main)
[![npm version](https://img.shields.io/npm/v/@rapidmx/meet-plugin)](https://www.npmjs.com/package/@rapidmx/meet-plugin)

Private and public WebRTC video meetings for a [RapidMX server](https://github.com/RapidMX/server). A mailbox owner
turns on video conferencing for a calendar event; a private meeting mints one link per invitee (inserted into the
invite's location and body), a public meeting shares a single link. Joining needs no account: a guest picks a name
(auto-filled from their RapidMX profile when signed in), checks their camera and microphone, and enters. Calls are
peer-to-peer WebRTC (no media server), relayed through a configured TURN server only for a participant a direct
connection can't reach.

This plugin's `apps/` also ship the public join/lobby/in-call pages and the personal Settings screen - see
`package.json`'s `rapidmx.plugin.ui` for exactly what's mounted where.

## What it adds

_(Filled in as each phase lands - see `.claude/NOTES.md` for the running detail, and `RELEASE_NOTES.md` for the
full changelog.)_

**Phase 1 (backend data model, routes, signaling) - done.** A mailbox owner creates a `VideoMeeting` through
`/api/mail/video-meetings` - `private` (one join link minted per invitee) or `public` (one shared link) - and an
anonymous participant joins through `GET .../join/:token`, which hands back the meeting's public details, an ICE
server list (public STUN always, TURN when configured) and a short-lived guest token already authorized to
exchange WebRTC signaling on that one meeting's channel over the server's existing `/push` route. No new realtime
infrastructure and no UI yet - see `.claude/NOTES.md`'s dated entry for the full design.

## Development

Same layout and tooling as this project's other plugins (`@rapidmx/booking-plugin`, `@rapidmx/mapi-plugin`,
`@rapidmx/autodiscover-plugin`): `yarn install`, `yarn test:prod`, `yarn build`. `@rapidmx/restapi`,
`@rapidmx/react-shared` and `@rapidmx/web-client` are portal-linked in `package.json`'s `resolutions` during local
development against a matching working tree of those repos.

## License

MPL-2.0 - see `LICENSE`.
