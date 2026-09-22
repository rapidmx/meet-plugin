# Release Notes

## Unreleased

### Phase 1: data model, routes and signaling

- **`VideoMeeting`/`VideoMeetingInvitee` models** (`@rapidmx/videoconf-plugin`/`./mongo`/`./sql`): a mailbox-owned
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

Not in this phase: the calendar compose hook (Phase 3, now also carrying an integration with `@rapidmx/booking-plugin`
so a video location option can mint its own link automatically) and the admin/settings page (Phase 4).
