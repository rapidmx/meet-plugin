# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-09-24

### Added
- Added several addresses in the TURN URL setting, separated by commas or whitespace, handed to the browser as one ICE server that shares a credential, so a TURN server listening on both UDP and TLS can be used

### Changed
- Change a single TURN address to be handed over exactly as before
- Test several addresses with a shared secret and with a static credential, and the parsing of commas, whitespace and blanks
- Document the change in the release notes and NOTES

## [0.3.1] - 2026-09-24

### Changed
- Test the wire format, two tabs of one account seeing each other, and a spoofed peer being ignored
- Document the change in NOTES

### Fixed
- Fixed every participant being alone once deployed by publishing signaling messages with the authenticated uid as from, which the server requires, and carrying each tab's identity in a separate peer field
- Fixed a message naming someone else's tab by ignoring a peer that does not start with the sender's own verified uid

## [0.3.0] - 2026-09-24

### Added
- Added microphone and camera buttons that mute or turn off beside a menu that picks the device, a live level on the microphone button and a sending indicator on the camera button
- Added a reactions button that sends one of eight emoji, shown floating up the screen with the sender's name
- Added a raise-hand button that shows a hand on the tile and in the header and plays a chime and a screen reader announcement for the other participants
- Added announcing each participant's muted microphone, camera and raised hand in hello and state messages, so a tile shows an avatar for a camera that is off and a muted badge
- Added turning a camera or microphone on partway through a call, including for a participant who joined with none or was refused permission
- Added an Allow camera and microphone button and a reason for a failed request to the lobby, asking for each device on its own when the pair cannot be satisfied together
- Added rejoining the meeting from the page shown after leaving

### Changed
- Default the public join page URL setting to https://<host>/meet so join links in calendar invites work as installed
- Test the manifest default
- Document the change in the release notes
- Test the lobby, call view, controls, tile, page, media hook, chime, mesh manager and peer connection adapter
- Document the change in the release notes and NOTES
- Write the links in the same transaction as the meeting and its invitees, and only for a private meeting with a calendar event and a configured public URL
- Delete a meeting's links when the meeting is deleted or cancelled, leaving the links of any other meeting on the same event
- Raise the @rapidmx/restapi peer floor to 0.19.0, the version that added CalendarEventAttendeeLink, and test that it stays there while the route uses it
- Test the links on both backends, including the cases that write none and the cleanup on delete and cancel
- Document the fix, and that meetings created before it have no links, in the release notes and NOTES

### Fixed
- Fixed the joined participant's own video disappearing by moving ownership of the camera and microphone from the lobby to the page, so the tracks the lobby previews are the ones the call sends and are stopped once when the participant leaves
- Fixed participants being unable to see or hear each other by giving every connection an audio and a video transceiver from the start, having the answering side claim the transceivers the offer created, swapping tracks in with replaceTrack, and playing each remote stream through its own hidden audio element with a click-to-enable banner when autoplay is refused
- Fixed signaling that arrives out of order by holding ICE candidates that beat their offer and filling in a participant's name when their hello arrives after their offer
- Fixed one account joining from two devices ignoring itself by identifying each tab on the call with the uid plus a random suffix
- Fixed a closed tab staying in everyone else's call by sending the goodbye on pagehide with a keepalive request
- Fixed the call running off the screen by drawing it as a full-window view outside the branded page shell, with the control bar pinned to the bottom and the local participant in a small corner tile while others are present
- Fixed the lobby camera preview going blank after turning the camera off and on again
- Fixed a private video meeting's invitees never receiving their join link in the calendar invite by writing one CalendarEventAttendeeLink per invitee, with that invitee's own join URL, when a meeting is created for a calendar event

## [0.2.0] - 2026-09-24

### Added
- Added a regression test that walks apps/ for @rapidmx/react-shared/videoconf/* imports and asserts the peer floor covers them, and that every resolutions entry matches its own peer floor

### Changed
- Raise the @rapidmx/react-shared peer floor from >=0.6.0 to >=0.13.0, the version that actually added the videoconf/videoMeetingsApi.js module apps/settings-video-conferencing imports
- Update the react-shared resolutions pin from ^0.11.0 to ^0.13.0 to match the corrected peer floor, per booking-plugin's pin-to-floor convention
- Document in NOTES.md a round-3 review finding that signaling messages (from/to fields) are self-attested with no server-side binding to the authenticated push-channel publisher, and that the fix belongs in restapi's MailPushRoute.send() rather than this plugin, which owns no push route of its own
- Document in NOTES.md the same review's lower-priority finding that a call's TURN credential can outlive its 1-hour TTL mid-call with no ICE refresh mechanism, as a known limitation for a future phase
- Upgraded rapidrest and rapidmx deps

[Unreleased]: https://github.com/RapidMX/meet-plugin/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/RapidMX/meet-plugin/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/RapidMX/meet-plugin/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/RapidMX/meet-plugin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RapidMX/meet-plugin/compare/v0.1.0...v0.2.0
