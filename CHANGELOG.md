# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.13.1] - 2026-10-02

### Changed
- Mark the TURN credential and shared secret as secret settings, so the server never shows them

## [0.13.0] - 2026-10-02

### Changed
- Update @rapidmx/web-client to 0.31.0

## [0.12.1] - 2026-10-01

### Changed
- Use a baton icon for the talking-stick toggle
- Replaces the "Talking stick"/"End talking stick" text label with a
- new icon-only button, matching every other control's icon-only shape.
- The accessible name is unchanged (now an aria-label instead of visible
- text), so nothing else needed to change.

## [0.12.0] - 2026-10-01

### Changed
- Dock the participants drawer and move diagnostics to an overlay
- The participants drawer no longer overlays the call behind a dimming
- backdrop - it's now an ordinary sidebar that shrinks the call's own
- content column to make room, so it can stay open and visible while
- the call continues. Dropped "click the backdrop to close" as a direct
- consequence; Escape and the drawer's own controls still close it.
- The call diagnostics panel moves from a dropdown anchored to its
- control-bar button to a fixed overlay in the top-left corner, read
- more naturally as a HUD while watching the call. Same panel, same
- open/close button and outside-click/Escape handling - only its
- position changed.

## [0.11.0] - 2026-10-01

### Added
- Added a host-managed talking stick mode

### Changed
- A host-only navbar toggle that, once on, lets only one participant's
- microphone be unmuted at a time: activating it makes the host the
- initial holder (everyone else muted), and the host hands it off to
- whoever should speak next from the participants drawer - the new
- holder is unmuted automatically, everyone else (including the host)
- is muted and their mic button disabled for as long as it applies.
- Pure in-call runtime state, no backend route or persisted field: a new
- broadcast SignalMessage kind ("talking-stick") and MeshConnectionManager
- method/event, the same shape as the existing mute-request/kicked
- signals and subject to the same cooperative trust model. Unlike those,
- though, this is enforced with a disabled control rather than a one-time
- nudge, since the whole point is that silence actually holds.

## [0.10.0] - 2026-10-01

### Added
- Added a presenter screen rotate/flip control
- Added a built-in call diagnostics panel
- Added a participants drawer
- Added host identity, mute-request/kicked signals, and enforced kick()
- Added host mute/kick buttons to the participants drawer
- Added a force-mute-on-join host setting
- Added a host-settable password to join
- Added a host-managed waiting room
- Added a new model). Guests see a name/password request form, then a

### Changed
- Tell a TCP-relayed TURN connection apart from a UDP one
- A phone and a remote PC both over the coturn relay reported "gaps that
- feel like latency, not packet loss." For a TURN-relayed connection this
- plugin's code has no role in audio encode/decode/jitter at all - that's
- entirely the browser's native WebRTC engine - so there's no equivalent
- What the symptom matches precisely is TCP-relayed TURN (?transport=tcp,
- or turns: - TLS is TCP-based too): UDP drops a lost packet (a click);
- TCP retransmits it and, being ordered, blocks everything queued behind
- it until that arrives (a stall). withTcpFallback() already offers both
- transports so a UDP-blocking network can still reach the TURN server at
- all, but that means a participant on such a network gets this degraded
- experience silently - no way to tell it apart from an ordinary relayed
- connection.
- selectedConnectionType() now reads the selected local candidate's own
- relayProtocol (standard RTCIceCandidateStats, already available via
- getStats()) and reports a new "turn-tcp" MediaTransport distinct from
- plain "turn" when it's tcp/tls. The tile badge now says "Relayed (TCP)"
- with a title explaining why, instead of reading identically to a
- UDP-relayed connection.
- Not a fix for the latency itself - there isn't one available at this
- layer - but it turns "can you fix it?" into something actionable: this
- badge is what tells you whether the next step is checking the coturn
- deployment's UDP reachability (infrastructure, not this repo).
- the earlier "screen sharing a window displays upside down" report -
- confirmed at the time to be the browser's own window-capture bug (already
- upside down in the presenter's own raw local preview before this app's
- code ever touched it), so there was nothing to patch, only a manual
- correction to offer.
- New ScreenTransformProcessor (apps/shared/media/filters/ScreenTransform.ts)
- mirrors VideoFilterProcessor's shape (hidden <video>, canvas redrawn on a
- timer, captureStream() exposing the result) much simplified - just a
- rotate/flip applied per draw. It transforms the actual track that's sent,
- not a local CSS effect, so everyone benefits, not just the presenter's own
- view. _CallView.tsx owns it the same way useLocalMedia owns the camera's
- filter processor: built when screen sharing starts, torn down (and reset
- to identity) when it stops.
- Two new buttons in _CallControls.tsx, next to Share Screen, visible only
- while presenting.
- for the full batch). A navbar button opens a panel showing this browser's
- own WebRTC/screen-share/WebCodecs support, what the local participant is
- sending, and per-participant connection info: the same transport badge
- _ParticipantTile.tsx already shows, plus round-trip time and per-kind
- packet loss/jitter/bytes once MeshConnectionManager's new periodic
- getStats() polling reports them. Entirely local and read-only - nothing
- here is sent anywhere.
- Third of seven requested call-experience features, and the last of the
- Clicking the header's participant-count chip opens a right-side drawer
- listing everyone in the call - "you" first - with the same mic-muted,
- hand-raised and connection-transport-badge information the tile grid
- already shows, as plain rows. Display-only for now; host mute/kick
- controls are added to these same rows once host identity exists.
- seven-item batch and plan). join() now resolves hostUid from the
- meeting's mailbox owner, letting clients identify the host purely for
- UI purposes. Two new point-to-point signals (mute-request, kicked) let
- a host's tab ask a participant to mute or tell them they were removed;
- a kicked participant sees a distinct "removed by the host" screen. The
- cooperative kicked signal is backed by a real new POST /:id/kick/:uid
- route that revokes the target's push channel grant, so removal is
- enforced server-side even if their client ignores the signal.
- The mute/kick buttons themselves (host-only, in the participants
- drawer) are a follow-up change.
- Wires up Phase B1's host-identity plumbing: a host now sees a Mute and
- a Remove button on every other participant's row in the participants
- drawer. Remove confirms first and both sends the cooperative kicked
- signal and calls the enforced kick() endpoint, using a new
- accountUidOf() helper to recover the participant's real account uid
- from their tab-scoped peer id (kick's ACL check is keyed by the
- former, not the latter).
- Documented a real limitation rather than overselling it: kick()
- revokes a participant's current grant, not their standing to get a
- new one, so a removed guest who reloads the join link is granted
- right back in. An actual ban is a larger, separate feature.
- VideoMeeting.forceMuteOnJoin, settable at creation or via update(),
- returned by join() so a joining participant's microphone starts muted
- for that call only - their own remembered mic preference for future
- calls is left untouched. A host-only checkbox in the participants
- drawer's header toggles it, applied optimistically and reverted if the
- save fails.
- now set a password in the participants drawer, hashed server-side
- with scrypt (this codebase's first stored credential, no existing
- hashing utility to reuse). join() now withholds the actual grant -
- ICE servers, guest minting, channel access - behind a new
- requiresPassword response until POST /join/:token/verify confirms the
- password, rather than just adding a confirmation screen in front of
- an already-granted join. The meeting owner's own organizerSlug still
- bypasses it entirely, since holding that already proves stronger
- authority than any password could add.
- Meetings can now require host admission before a guest's join completes.
- When waitingRoomEnabled is set, join() withholds the grant and files a
- pending admission (tracked in-memory per route instance, mirroring the
- existing RelayHub trade-off of dropping state on restart rather than
- waiting screen that polls for the host's decision; hosts get a waiting
- list in the participants drawer with Admit/Deny actions. Waiting room
- takes priority over a password gate when a meeting has both, since the
- admission form already collects both in one step.
- minted a fresh guest uid for unauthenticated callers, which would have
- discarded a waiting guest's already-registered identity on admission.
- Extracted grantJoin() as the shared "grant an already-known identity"
- step so pollAdmission() can hand back the uid it already has.

### Fixed
- Fixed available here the way there was for the WebSocket relay tier.
- Fixed a latent identity bug while wiring this up: completeJoin() always

## [0.9.3] - 2026-09-30

### Changed
- Name which device is missing, and fade in audio after a discontinuity
- "No camera or microphone was found" showed even when only one was
- actually missing. classifyMediaError() now takes the failed call's own
- constraints and names just the microphone, just the camera, or both
- (notFoundError(), exported from deviceMedia.ts).
- acquire("audio") then acquire("video") when the combined request fails,
- and each independently called setError() - so the camera's later success
- could silently clear a real microphone error, and if both were missing,
- only whichever ran last (the camera) was ever shown. acquire() now
- returns the classified error (or null) instead of a boolean, and
- acquireBoth() combines both outcomes into one message that's actually
- true, rather than letting either call's own setError() decide alone.
- Also gave AudioPlayer.play() a short (4ms) linear fade-in through a
- GainNode for a block that doesn't pick up exactly where the last one left
- off - the first block, or the one after a gap - to mask the click a
- decoder-state mismatch at that seam can produce (the shared Opus decoder
- is reused across packets so its predictive state carries over between
- them, and is never told when one was dropped). An ordinary contiguous
- block gets no fade. Based on analyzing a recording of reported audio
- "blipping"; see NOTES for what the analysis did and didn't show.

### Fixed
- Fixed a real bug on the way: useLocalMedia's acquireBoth() falls back to

## [0.9.2] - 2026-09-30

### Changed
- A HAR capture from a still-failing device (0.9.1, with the earlier keepalive
- {"code":"api-105","status":403,"level":"debug",
- "message":"This request is missing a valid CSRF token."}
- Not an ACL permission failure - a CSRF double-submit check
- (@rapidrest/service-core's verifyCsrfRequest()), enforced only for a
- cookie-authenticated request (req.auth.source === "cookie"). The captured
- request was the authenticated path (real jwt/refresh cookies, no
- Authorization header) - GuestSignalingClient.send() builds its own fetch()
- instead of going through @rapidmx/web-client's apiFetch() (it needs to
- choose bearer vs. cookie auth conditionally), and never echoed the csrf
- cookie back as the required x-csrf-token header the way apiFetch() already
- does via withCsrfHeader(). Every signaling message sent while relying on
- the cookie 403'd and, since send() is fire-and-forget, silently vanished -
- matching "stuck connecting, then no audio or video" exactly.
- cookie - harmless on the bearer (guest) branch, since the server only
- enforces the check for the cookie case.
- This also means the earlier "keepalive" fix was not the actual cause,
- though it remains a correct, low-risk improvement on its own terms - see

### Fixed
- Fixed the real cause: send() never attached the CSRF header the server requires
- Fixed already deployed) finally showed the 403's actual response body:
- Fixed by calling web-client's withCsrfHeader() on every send(), bearer or

## [0.9.1] - 2026-09-30

### Changed
- Stop marking every signaling POST keepalive - only a bye needs to survive unload
- GuestSignalingClient.send() sets `keepalive: true` on every POST to
- /push/:id (hello, offer, answer, ICE candidates, bye), not only the bye
- sent from pagehide - the one message that actually needs to survive the
- page unloading, which is what the existing comment already said.
- A guest behind a restrictive/corporate firewall could never actually
- connect: every signaling POST 403'd, and since send() is fire-and-forget,
- each one just silently vanished - matching "stuck on Awaiting connection,
- then no audio/video" exactly. A guest on an unrestricted network (tested
- two phones on cellular data) always connected fine. `keepalive: true`
- signals to the browser (and to any inspecting proxy watching the
- connection) that a request may outlive the page - the same signal
- sendBeacon()/an unload handler's own fetch give off - and is a plausible
- thing for a restrictive network's proxy to single out for extra scrutiny
- or drop, well under the browser's own keepalive quota. Scoping it to only
- the bye removes that signal from the messages that actually need to get
- through to connect at all.
- Not a confirmed root cause - the most plausible, lowest-risk explanation
- what to check next if it recurs.

## [0.9.0] - 2026-09-30

### Added
- Added GET /mail/video-meetings/personal-room, answering the link to the signed-in user's personal meeting room, or 404 when they have none
- Added a Meet button to the app rail, shown only to a user who has a personal meeting room and linking to it

### Changed
- Updated rapidmx deps

## [0.8.1] - 2026-09-29

### Added
- Added the missing "Enable corepack" step to the validate job - every other job already has it, and without it yarn runs the container's stock Yarn 1.22.22 instead of the packageManager-pinned version, which refuses to run at all against a packageManager field, so validate's yarn npm audit never actually ran regardless of real findings. Confirmed on rapidmx/server's identical job via a real CI log; this repo's validate job is the same template and shares the same latent gap even where it happened not to manifest yet

### Changed
- Rewrite every @rapidmx/react-shared import to @rapidmx/web-client's new lib/ path, and drop the now-unused dependency from peerDependencies, devDependencies and resolutions
- Replace plugin.test.ts's react-shared version-floor assertion with a structural check and a todo, since there is no released web-client version yet to compare against
- Drop react-shared from vitest's ssr.noExternal list and update the README's dev-setup mentions
- Document the change in NOTES
- The local self-view is mirrored with CSS (scaleX(-1)) for a natural, real-mirror
- feel - always local-only, so it never affected what anyone else saw. But that
- mirror flips the whole composited frame, including a chosen background picture,
- which reads backwards to no one but the participant who picked it. _ParticipantTile
- now takes a mirrored prop (default true, unchanged everywhere else); _CallView and
- _MeetLobby turn it off for the local view specifically when the background is a
- custom image.
- VideoFilterProcessor asked the segmentation and face models every rendered frame
- (up to 30/sec), each a synchronous, main-thread call that can take tens of
- milliseconds - long enough to make the WebSocket relay's ScriptProcessorNode-based
- audio miss its buffer deadline and glitch. It now asks on only one rendered frame
- in three (ML_HOLD_TICKS), reusing the last mask/landmarks otherwise; neither
- changes enough between three frames to be visible.
- Reported choppy audio also happens with no filters on, so this alone isn't the
- by-design drop points in the relay's audio pipeline, none related to filters) and
- what to check next.
- Document the standing wait-for-green-CI-before-releasing rule in NOTES, per JP
- Bump the @rapidmx/restapi and @rapidmx/web-client development dependencies (and their resolutions pins) to ^0.25.1/^0.22.0, now that both are published

### Fixed
- Fixed a custom background image showing backwards to its own participant, and cut the video filters' main-thread cost
- Fixed a self-inconsistency the previous commit introduced: revert the @rapidmx/restapi resolutions pin back to ^0.23.0 (its unchanged peerDependencies floor), and raise the @rapidmx/web-client peerDependencies floor to >=0.22.0, matching what this repo's own apps/ sources have actually required since importing @rapidmx/web-client/lib/*.js directly (confirmed via a real CI failure this revealed: the previous commit's floor-matching resolutions revert forced an old web-client without lib/, breaking every page under apps/meet and apps/settings-video-conferencing) - the resolutions pin now correctly matches the real floor either way

## [0.8.0] - 2026-09-27

### Added
- Added video filters and remember devices and settings between calls

### Changed
- Filters: a blurred or custom background (an image picked from the participant's
- own device), black and white, sepia, night vision and pixelate looks, and face
- accessories (sunglasses, cat ears, party hat, crown, mustache). The three kinds
- combine, and the filtered track replaces the camera track, so every media path
- sends it unchanged. A background filter fails closed: until the segmentation
- model is ready the real room is never shown.
- The models run in the browser with MediaPipe, loaded only when a filter needs
- them, from public CDNs by default or from the administrator's server with the
- new mail:videoconf:effects:assets_url setting (returned as effectsAssetsUrl by
- join()).
- The camera and microphone a participant picked, whether each was on, and their
- filters are saved in the browser's localStorage and applied on the next join. A
- saved device is requested as a preference so an unplugged one falls back to the
- default.
- The manifest's displayName became "Meet" in 8e6379e, but the test still
- expected "Video Conferencing", so CI failed.
- Upgraded rapidmx deps

### Fixed
- Fixed crlf issue
- Fixed the manifest test's stale displayName


### Added
- Add video filters to the lobby and the in-call controls: a blurred or custom background (a picture picked from the participant's own device), black and white, sepia, night vision and pixelate looks, and face accessories (sunglasses, cat ears, party hat, crown, mustache). The three kinds combine, and the filtered picture is what every media path sends
- Remember, on the participant's device, the camera and microphone they picked, whether each was on, and their video filters (including the custom background), and apply them the next time they join
- Add the `mail:videoconf:effects:assets_url` setting, and `effectsAssetsUrl` in the join response, to host the filters' machine-learning runtime and models on the administrator's own server instead of fetching them from jsDelivr and Google's model bucket
- Depend on `@mediapipe/tasks-vision`, loaded only when a participant turns on a filter that needs it

### Changed
- A saved camera or microphone is asked for as a preference, so one that has been unplugged falls back to the default device instead of failing

## [0.7.0] - 2026-09-27

### Added
- Added a WebSocket media relay as the last of three media paths, offer TURN over TCP, and show connection progress

### Changed
- Each pair of participants now tries a direct peer-to-peer connection, then the TURN server, then media proxied by the server over a WebSocket. Add withTcpFallback(), which offers every plain turn: address over UDP and TCP, since a browser given no transport uses only UDP, which strict firewalls block. Add MeshConnectionManager per-pair transport tiers (connecting, p2p, turn, websocket, failed), read from the selected candidate pair, with a relay-fallback signal so both sides switch, and keep a participant whose connection failed in the call instead of dropping them. Add RelayHub and BaseVideoMeetingRoute.relay(), a @WebSocket route at /relay/:id that needs READ and CREATE on the meeting with trusted roles stripped, with room, per-user, size and rate limits, the mail:videoconf:relay:enabled setting and relayEnabled in the join response. Add RedisRelayBus so relayed media crosses server replicas through the events datastore, falling back to one process without it. Add apps/shared/relay, a WebCodecs Opus and VP8 sender and receiver with fragmenting, reassembly and reconnect. Ask the framework for 64 KiB messages and a 1 MiB send buffer when @rapidrest/service-core supports per-route WebSocket options, tell the client the limit in ready (maxMessageBytes), and keep 16 KiB otherwise. Show a Relayed, Server relay or Can't connect badge on a tile, "Awaiting connection..." on a participant still connecting and "Connecting..." on the local tile until the first connection is up. Rename the plugin's display name to Meet. Document the change in the README, release notes, changelog and NOTES, including why TURN did not reach firewalled clients.
- Needs @rapidrest/service-core 2.4.0 for the larger relay messages; raise the peer range to >=2.4.0 <3 once it is released.
- Updated rapidrest and rapidmx deps

### Added
- Fall back, per pair of participants, from a direct connection to TURN to media proxied over a WebSocket by the server (`/api/mail/video-meetings/relay/:id`, Opus and VP8 through WebCodecs), with the `mail:videoconf:relay:enabled` setting and `relayEnabled` in the join response
- Show on a participant's tile when their media is relayed through TURN or the server, or cannot connect
- Show "Awaiting connection…" on a participant still connecting and "Connecting…" on the local tile until the first connection is up
- Carry relayed media between server replicas through Redis (`RedisRelayBus`, the `events` datastore), falling back to one process without it
- Ask the framework for 64 KiB relay messages and a 1 MiB send buffer when `@rapidrest/service-core` supports per-route WebSocket options (2.4.0), and tell the client the limit in the relay's `ready` message (`maxMessageBytes`)
- Export `withTcpFallback()`, and the relay hub and its limits, from the package root

### Changed
- Offer every plain `turn:` address over TCP as well as UDP, for networks that block UDP
- Keep a participant whose connection failed in the call, marked as unreachable, instead of removing them

## [0.6.0] - 2026-09-26

### Changed
- Updated rapidmx deps

## [0.5.0] - 2026-09-26

### Changed
- Document that a downstream package's release bump level follows its upstream dependency's, minor for minor, patch for patch and major for major, in NOTES
- Use @rapidmx/restapi 0.23.0, @rapidmx/react-shared 0.19.0 and @rapidmx/web-client 0.17.0, with @rapidrest/react as a peer and development dependency
- Note the dependency bumps in the release notes

## [0.4.2] - 2026-09-25

### Changed
- Raise the @rapidmx/restapi, @rapidmx/react-shared and @rapidmx/web-client peer floors to 0.22.1, 0.18.0 and 0.16.0 and set the development dependencies and resolutions to the same versions, so the plugin is built and tested against the current packages
- Document the change in the release notes

### Fixed
- Fixed repository URL

## [0.4.1] - 2026-09-25

### Changed
- Raise the @rapidmx/restapi, @rapidmx/react-shared and @rapidmx/web-client peer floors to 0.21.1, 0.16.0 and 0.15.1 and set the development dependencies and resolutions to the same versions, so the plugin is built and tested against the current packages
- Document the change in the release notes

### Fixed
- Fixed the NOTES entry on several TURN addresses to name the release that carries them, 0.4.0

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

[Unreleased]: https://github.com/rapidmx/meet-plugin/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/rapidmx/meet-plugin/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/rapidmx/meet-plugin/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/rapidmx/meet-plugin/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/rapidmx/meet-plugin/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/rapidmx/meet-plugin/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/rapidmx/meet-plugin/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/rapidmx/meet-plugin/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/rapidmx/meet-plugin/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/rapidmx/meet-plugin/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/rapidmx/meet-plugin/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/rapidmx/meet-plugin/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/rapidmx/meet-plugin/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/rapidmx/meet-plugin/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rapidmx/meet-plugin/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rapidmx/meet-plugin/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/rapidmx/meet-plugin/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/RapidMX/meet-plugin/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/RapidMX/meet-plugin/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/RapidMX/meet-plugin/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/RapidMX/meet-plugin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RapidMX/meet-plugin/compare/v0.1.0...v0.2.0
