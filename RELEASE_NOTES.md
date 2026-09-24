# Release Notes

## Unreleased

### Added

- **The TURN server URL setting can hold several addresses**, separated by commas or whitespace - `turn:turn.example.com:3478,turns:turn.example.com:5349`, say, for a TURN server that listens on both UDP and TLS. They are given to the browser as one ICE server, sharing one credential (which, with a shared secret set, is minted per join as before); a single address is handed over exactly as it was. The RapidMX Helm chart's bundled coturn uses this for TURN over TLS. **A server that sets two addresses needs this version**: an older plugin passes the whole string as one address, which the browser rejects, and no call connects.

## v0.3.1

## v0.3.0

### Added

- **The in-call controls are rebuilt.** The microphone and the camera are each a button that mutes / turns off, beside a menu that picks the device; while the microphone is unmuted its button shows a live level, so a participant can see their audio is being sent, and the camera button shows a green dot while a camera is sending. A new reactions button sends one of eight emoji, which float up the screen with the sender's name ("You" for your own). A new raise-hand button shows a raised hand on the participant's tile and in the header, and plays a short chime (and is announced to screen readers) for everyone else. Whether each participant's microphone is muted, their camera is off and their hand is up travels with the call, so a tile shows an avatar for a camera that is off and a muted-microphone badge.
- **Turning a camera or microphone on partway through a call works**, including for a participant who joined with none, or whose browser refused permission. The camera and microphone menus offer to ask for access again.
- **The lobby has an "Allow camera and microphone" / "Try again" button**, and says what is wrong (blocked, no camera, unsupported browser) instead of showing an empty preview. A machine with no camera still gets its microphone. Joining without a camera or microphone is allowed and now works both ways: that participant still sees and hears everyone.
- **A participant who left can rejoin** from the "You left the meeting" page.

### Changed

- **The call fills the window.** It used to be drawn inside the branded page (header, footer and padding around it) and ran off the bottom of the screen. It is now a full-window view with a slim header, the tiles, and the control bar pinned to the bottom. The local participant is a small tile in the bottom-right corner while anyone else is in the call (above the bar on a narrow window, at the top on a phone) and fills the window while they are alone.
- Turning the camera off now stops the camera (the camera light goes out) instead of sending black frames.
- **The "Public join page URL" setting defaults to `https://<host>/meet`**, which the server saves with its own host when the plugin is installed, so join links in calendar invites work with no further steps. Needs `@rapidmx/restapi` with `<host>` defaults; an older server saves nothing for it, as before, and the admin console's form offers the address to save.

### Fixed

- **A participant's own video disappeared when they joined the call.** The lobby owned the camera and microphone and stopped them when it closed - which is exactly when the call starts using them - so everyone who joined sent dead tracks. The page now owns them for the whole visit and stops them once, when the participant leaves.
- **Nobody could see or hear anyone else.** Three separate causes: a participant's connections carried media only if they had a camera or microphone at the moment the connection was made (none negotiated no media in either direction for the whole call); the side that answers a connection never attached its own tracks to the connection the offer created, so it sent nothing; and remote audio was played only by a video element that a hidden tile or a camera-off participant never had. Every connection now carries an audio and a video transceiver from the start (the answerer takes the ones the offer created), tracks are swapped in with `replaceTrack` without renegotiating, each remote stream is gathered per participant, and audio is played by its own hidden element. If the browser's autoplay policy refuses to start it, a banner asks for a click.
- **Signaling messages that arrive out of order no longer break a call.** Each message is its own `POST`, so an ICE candidate can beat its offer (it was dropped) and an offer can beat its sender's hello (the participant kept the name of their internal id for the whole call). Early candidates are now held until the connection exists, and a later hello fills in the real name.
- **One account joining from two devices, or two tabs, now works.** Both used the account's uid as their identity on the call, so each ignored the other's messages as its own. Each tab now adds a random suffix.
- **A participant who closed the tab stayed in everyone else's call.** The goodbye is now sent when the page is closed.
- **Access to the camera and microphone is asked for in a way more browsers honor**: once when the lobby opens and again from a button (a click is a user gesture, which some browsers require before they will prompt), with each device asked for on its own if the pair can't be satisfied together.
- **The lobby's camera preview went blank after turning the camera off and on again.**
- **A private meeting's invitees now receive their own join link in the calendar invite.** `create()` wrote the meeting and its invitees but never the `CalendarEventAttendeeLink` rows `MeetingSchedulingJob` reads to personalize each attendee's invite, so every invitee got only the event's placeholder location and no link in the body. For a private meeting with a `calendarEventUid`, one link per invitee (their exact join URL, address normalized) is now written in the same transaction as the meeting, and removed again when the meeting is cancelled or deleted. Nothing is written for a public meeting, a meeting with no event, or when `mail:videoconf:public_url` isn't set. Needs `@rapidmx/restapi` 0.19.0 or later, which added the model; the peer floor is raised to match. A meeting created before this fix has no links and needs to be re-created.

## v0.2.0

### Phase 1: data model, routes and signaling

- **`VideoMeeting`/`VideoMeetingInvitee` models** (`@rapidmx/meet-plugin`/`./mongo`/`./sql`): a mailbox-owned
  video meeting, `private` (one `VideoMeetingInvitee` per invited email, each with its own unguessable `joinToken`)
  or `public` (a single, randomly generated `publicSlug` link). `calendarEventUid`, `startTime`/`endTime` are
  optional in this phase - a meeting can exist standalone; a later phase wires the calendar compose "Add video
  conferencing" hook that sets them. `VideoMeeting` is the one entity in this plugin with its own per-record
  `AccessControlList` (`recordACL: true`) - its `uid` doubles as a `/push` signaling channel.
- **`POST/GET/GET :id/PUT :id/DELETE :id /api/mail/video-meetings`**: the owner's management of their own meetings,
  authorized against the owning mailbox's ACL exactly like every other mailbox-scoped entity in this codebase's
  family (trusted roles are stripped before every check - `util/RouteAccessUtils.ts` - so an administrator with no
  explicit grant never gets implicit access). `POST` mints the invitee join links or the public join link and
  returns them alongside the created meeting, everything a calendar-compose hook will need in a later phase.
  `PUT` is deliberately minimal for Phase 1: only `title` and cancellation (`status: "cancelled"`).
- **`GET /api/mail/video-meetings/join/:token`**: the anonymous join endpoint. Resolves either a private invitee's
  join token or a public meeting's slug (the two are drawn from disjoint character lengths, so exactly one lookup
  ever runs), returns the meeting's public info and an ICE server list, and mints a short-lived (4 hour) guest JWT
  already granted `READ`/`CREATE` on the meeting's own push channel - ready to use against the server's existing
  `/push` route to exchange WebRTC signaling (SDP/ICE) with no RapidMX account. A stale/unknown token answers a
  plain `404`.
- **ICE servers** (`util/IceServerUtils.ts`): two free public STUN servers, always included; a TURN entry when
  `mail:videoconf:turn:url` is configured, with a coturn-style time-limited REST credential
  (`base64(HMAC-SHA1(sharedSecret, "<expiry>:<username>"))`) when `mail:videoconf:turn:shared_secret` is also set,
  otherwise the configured static `mail:videoconf:turn:username`/`credential` used as-is.
- **New settings**: `mail:videoconf:public_url` (the public join pages' base URL, used to build every invite link),
  `mail:videoconf:turn:url`/`turn:username`/`turn:credential`/`turn:shared_secret` - all empty by default.

Not in this phase: the join/lobby/in-call UI (`apps/meet` - Phase 2), the calendar compose hook that actually mints
a meeting from an event (Phase 3), and the admin/settings page (`apps/settings-video-conferencing` - Phase 4). Both
`apps/` directories currently ship only a one-line placeholder page (required for `tsc -p tsconfig.apps.json` to
have something to compile).

### Phase 2: the public join/lobby page and in-call UI

- **`apps/meet/:token`**: the public join page. Resolves the link's token via `join()`, offers a name field (always
  editable; pre-filling it from a signed-in user's own profile needs a cross-repo change this phase couldn't make -
  see `.claude/NOTES.md` - so it starts blank for now), a camera/microphone picker with a live local preview, and a
  Join button that carries the chosen name and devices into the call.
- **In-call UI**: full-mesh WebRTC - every participant connects directly to every other over `RTCPeerConnection`,
  signaled through the meeting's own `/push` channel. Grid/gallery view, a focused-speaker view (automatic, by a
  simple audio-level heuristic, or manually pinned), and single-presenter screen share (`getDisplayMedia()`, a
  presenter claim the other participants see and defer to). Mute, camera toggle, leave/cleanup.
- **Fix: joining while already signed in.** The lobby originally always authenticated its `/push` connection with a
  freshly minted, short-lived guest identity, written into a plain `document.cookie`. If the browser already held a
  real signed-in session's `HttpOnly` cookie for this deployment - the common case for a colleague who has webmail
  open - the guest cookie write was silently blocked (browsers never let script set an `HttpOnly` cookie), the
  connection authenticated as that real session instead, and it had no grant on the meeting's channel: **a
  signed-in user could not join a call at all.** Fixed at the source: `join()` now recognizes a real, signed-in
  caller (their session cookie already reaches this endpoint like any other authenticated request) and grants
  *their own* uid the same channel access a guest would get, minting no guest token at all - their own existing
  session already authenticates `/push` automatically, so the lobby has nothing to write and nothing to collide
  with. `VideoMeetingJoinResult` gained `authenticated`/`selfUid`; `token`/`expiresAt` are now only present for the
  true-anonymous case.

### Phase 3: an organizer join link and a `@rapidmx/booking-plugin` integration

The calendar compose hook itself (an "Add video conferencing" toggle, and personalizing each attendee's invite with
their own link) lives in `@rapidmx/web-client`/`@rapidmx/react-shared`/`@rapidmx/restapi` - see their own release
notes. What changed in this package to support it:

- **`VideoMeeting.organizerSlug`**: a private meeting's organizer is deliberately excluded from its `invitees` (they
  manage the meeting through ownership, not as a guest), which meant they had no token or slug of their own
  `join()` could ever resolve - a real gap found while wiring the calendar compose hook. `create()`/`findById()`
  now also return `organizerJoinUrl`, resolvable only by the real, already-authenticated mailbox owner or a
  delegate with `READ` - never anonymously, never by a guest, and refused with the same bare `404` an unknown
  token gets rather than a `403` that would confirm a guessed slug names a real meeting.
- **Fix: two private meetings in one mailbox could never both exist.** `publicSlug`'s original index
  (`["mailboxUid", "publicSlug"]`, unique, sparse) had the same pitfall `organizerSlug`'s own index was almost
  built with and was caught first: a compound sparse index still indexes a document carrying at least one of its
  keys, and every meeting has `mailboxUid`, so two private meetings (both missing `publicSlug`) collided on
  `(mailboxUid, null)` and the second could never be created. Both fields now use a single-field sparse unique
  index instead, which skips a document missing the field entirely and matches `join()`'s real (global) lookup
  scope more accurately than the original per-mailbox intent did.
- **`createSingleInviteeVideoMeeting()`**: a small, backend-agnostic integration function exported from this
  package's root, for another plugin already running in the same server process to mint a private meeting with
  one invitee without an HTTP round trip. `@rapidmx/booking-plugin` calls it (only when this plugin is installed
  and active, never as a hard dependency) so a booking's video location option can get a real, working link
  automatically when the host hasn't set one.

### Phase 4: the personal settings page

- **`/settings/video-conferencing`**: a signed-in user's own video conferencing settings. A **personal room** - a
  standing, shareable public link, by convention the mailbox's oldest still-active public meeting rather than a
  new tracked concept - can be created, renamed and copied from a card at the top; a table below lists the
  mailbox's other meetings (title, visibility, status, created date) with a cancel action and a copy-link action
  for a public one. No admin-level settings page was added - TURN/STUN configuration is already covered by the
  admin console's generic per-plugin settings dialog, which this plugin's manifest already declares fields for.
- **Fix: a public meeting's link was only ever returned once, at creation.** `find()`/`findById()` now run every
  meeting through the same `organizerJoinUrl`/`publicJoinUrl` computation `create()` always did, so reopening
  Settings (or listing meetings any other way) shows a working link again instead of one only the original
  creation response ever carried.

### Hardening pass: dependency-manifest fixes

- **Fix: the `@rapidmx/react-shared` peer floor (`>=0.6.0 <1`) was below the version this plugin actually requires.**
  `apps/settings-video-conferencing/*.tsx` import `@rapidmx/react-shared/videoconf/videoMeetingsApi.js`, added to
  react-shared only in `0.13.0` - installing this plugin against anything below that in its own claimed-supported
  range would hit a hard module-resolution failure. Raised to `>=0.13.0 <1`, and the matching `resolutions` pin
  (previously `^0.11.0`, now `^0.13.0`) to match, per this project's convention of pinning `resolutions` to exactly
  a package's own peer floor.
- **Fix: stale `@rapidmx/videoconf-plugin` prose left over from the rename to `@rapidmx/meet-plugin`** in
  `README.md`'s npm-version and CI/coverage badges and this file's own Phase 1 entry above.

### react-shared 0.14.0: dependency bump for two security fixes

- **Raised the `@rapidmx/react-shared` peer floor to `>=0.14.0 <1`** (from `>=0.13.0 <1`) and the matching
  `devDependencies`/`resolutions` pins to `^0.14.0` (from `^0.13.0`), so `yarn install` actually picks up
  `0.14.0` - the prior floor's range technically already permitted it, but nothing forced the upgrade. `0.14.0`
  carries two real security fixes (session signing/encryption keys are now imported non-extractable;
  `sanitizeMessageBodyHtml()` now forbids `svg`/`math` tags, closing a sanitizer gap `sanitizeQuotedHtml()` had
  already closed) in modules this plugin doesn't import (confirmed by grep for the changed files - `crypto/
  keySession.ts`, `mail/messageBodySanitizer.ts`, `mail/mailDetailHooks.js`, `components/overlays/
  PopoverPortal.js` - across `apps/`/`src/`/`test/`), so the bump is low-risk and purely defensive. `yarn install`/
  `yarn build`/the full test suite were re-run clean after the bump (410 tests, 100%/97.52% coverage, unchanged).
