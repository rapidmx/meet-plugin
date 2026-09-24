# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-24

### Added
- Added a regression test that walks apps/ for @rapidmx/react-shared/videoconf/* imports and asserts the peer floor covers them, and that every resolutions entry matches its own peer floor

### Changed
- Raise the @rapidmx/react-shared peer floor from >=0.6.0 to >=0.13.0, the version that actually added the videoconf/videoMeetingsApi.js module apps/settings-video-conferencing imports
- Update the react-shared resolutions pin from ^0.11.0 to ^0.13.0 to match the corrected peer floor, per booking-plugin's pin-to-floor convention
- Document in NOTES.md a round-3 review finding that signaling messages (from/to fields) are self-attested with no server-side binding to the authenticated push-channel publisher, and that the fix belongs in restapi's MailPushRoute.send() rather than this plugin, which owns no push route of its own
- Document in NOTES.md the same review's lower-priority finding that a call's TURN credential can outlive its 1-hour TTL mid-call with no ICE refresh mechanism, as a known limitation for a future phase
- Upgraded rapidrest and rapidmx deps

[Unreleased]: https://github.com/RapidMX/meet-plugin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/RapidMX/meet-plugin/compare/v0.1.0...v0.2.0
