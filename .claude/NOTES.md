# NOTES

Repo-local engineering notes for `@rapidmx/videoconf-plugin`, in the same running-journal convention as this
project's other repos (`booking-plugin`, `restapi`, `server`, `react-shared`, `web-client`, `mapi`, `autodiscover`):
one dated section per unit of work, newest at the bottom, never rewritten - see those repos' own `.claude/NOTES.md`
for the exact style to match.

## Design (agreed before Phase 1 started)

- **Scale**: full-mesh peer-to-peer WebRTC (every participant connects directly to every other). Good for small
  calls (roughly up to 4-6 participants); deliberately not an SFU/media-server architecture, which would be a much
  larger, separate project.
- **NAT traversal**: public STUN servers (e.g. Google's) are hardcoded defaults, free and reliable for discovery.
  TURN (actual media relay, needed when a direct connection fails) has no reliable free public option, so it's an
  admin-configured setting (`mail:videoconf:turn:*` in this plugin's manifest), empty by default - calls still
  mostly work without one, but a participant behind a restrictive NAT/firewall may not connect. A shared secret
  enables per-join expiring TURN credentials (coturn's time-limited REST mechanism) instead of one static password
  handed to every participant.
  - Follows the same admin-console-setting pattern `mail:booking:public_url`/`mail:autodiscover:public_url` already
    use - no Helm/chart wiring, an administrator sets it after install.
- **Calendar hook**: explicit opt-in. An "Add video conferencing" control in web-client's *existing* calendar event
  compose UI (not a separate flow) mints the meeting (and, for a private meeting, one join token per invitee)
  before the invite send, and the compose flow inserts the resulting link(s) into the event's `location`/`body`.
  This is the one piece that touches core repos (restapi's calendar event route, web-client's compose UI), not just
  this plugin - by design, since point 2 of the spec ("sent in the location field and body of their meeting
  invite") means the *existing* invite-sending pipeline, not a new one.
- **Signaling**: reuses `@rapidrest/service-core`'s existing `/push` WebSocket (the same one mail/folder/notification
  events already flow over) - no new realtime infrastructure. A meeting's uid is its push channel; SDP
  offers/answers and ICE candidates are ordinary `NotificationUtils.sendMessage()` payloads published to it.
  - An anonymous guest (holding a valid join token, no RapidMX account) can't authenticate to `/push` the normal way
    (it needs a `JWTUser`), so joining mints a short-lived, scope-limited guest JWT (a synthetic uid, no trusted
    roles) with an ACL grant on just that one meeting's channel - the same "possession of a link is the
    credential" pattern `booking-plugin`'s `manage/:token` already uses for its own anonymous access, extended one
    step further because signaling needs a channel subscription, not just a stateless REST call.
- **Data model**: `VideoMeeting` (owner mailbox, optional link back to the `CalendarEvent` that created it,
  `visibility: "private" | "public"`, a `publicSlug` for the public case - one shareable link per meeting, unique
  within the owning mailbox, mirroring `booking-plugin`'s own slug uniqueness scope) and `VideoMeetingInvitee`
  (private meetings only: one row per invitee, each with its own 32-byte random join token, mirroring
  `Booking.manageToken`'s exact shape/entropy).
- Delivered in phases (agreed with JP): (1) repo scaffold + data model + backend routes + signaling, (2) join/lobby
  + in-call UI (mesh WebRTC, gallery/speaker/presentation), (3) the calendar compose hook, (4) admin/settings pages,
  (5) integration pass + full test suites across every touched repo. Each phase is committed before the next starts.

## 2026-09-22: Phase 1 (data model, routes, signaling) implemented

Backend-only, entirely inside this repo (no `apps/` UI beyond the two placeholder pages `tsc -p tsconfig.apps.json`
needs to have something to compile - `apps/meet/index.tsx`, `apps/settings-video-conferencing/index.tsx`, one line
each, replaced by their real phases). `yarn lint`/`tsc --noEmit`/`yarn build`/`yarn test:prod` all clean; 167 tests,
100% statement/function/line and 100% branch coverage (floor is 95%).

- **Models** (`src/models/types.ts`, `mongo/`, `sql/`): `VideoMeeting` (`mailboxUid`, optional `calendarEventUid`/
  `startTime`/`endTime`, `visibility: "private" | "public"`, `publicSlug?`, `status: "scheduled" | "active" | "ended"
  | "cancelled"`) and `VideoMeetingInvitee` (`meetingUid`, a denormalized `mailboxUid` - added beyond the original
  spec, mirroring `Booking.mailboxUid`'s exact reasoning: `@MailboxScopedData()`/`ErasureExecutionJob` need it -
  `email`, `displayName?`, `joinToken`). Both mailbox-scoped, deny-all class `@Protect`. `VideoMeeting` alone sets
  `recordACL: true`: its `uid` doubles as its `/push` signaling channel, which needs a real per-record
  `AccessControlList` document to grant anyone (owner or guest) anything on - `Booking`'s `recordACL: false` has no
  such need. `persistMeeting()` claims that ACL with `parentUid` set to the mailbox (mirroring `BaseFolderRoute`'s
  identical `acl: { uid, parentUid: mailboxUid, records: [] }` pattern), so an owner/delegate reaches it through the
  ordinary ACL parent chain for free; `RepoUtils.create()`'s own creator-grant (`claimRecordACL`) covers the literal
  creator's push access automatically.
- **`joinToken`/`publicSlug` disambiguation**: different lengths, not different lookup order. `joinToken` is 32
  random bytes base64url (43 chars, exactly `Booking.manageToken`'s shape); `publicSlug` is 8 random bytes base64url
  (11 chars, random rather than name-derived - nothing about a meeting link is memorable enough to want to choose by
  hand). `join()` picks exactly one lookup by the candidate's length, never tries both - see `util/TokenUtils.ts`.
  `publicSlug` is only DB-unique within its mailbox (mirroring `BookingType.slug`'s scope, for consistency), but
  `join()`'s lookup is global (no mailbox segment in the URL) - a cross-mailbox collision isn't actually prevented,
  only made astronomically unlikely by the slug's own entropy. Documented as a deliberate tradeoff, not a bug.
- **Route** (`BaseVideoMeetingRoute` + Mongo/SQL subclasses, mounted `/api/mail/video-meetings`): a standalone class
  like `BaseBookingRoute` (not a `CRUDRoute` subclass) - `create()`'s response needs to carry invitee join URLs/the
  public join URL alongside the meeting, which the generic `T | T[]` CRUD return type can't express, and `join()` is
  anonymous/token-resolved the same way `BaseBookingRoute.manage()` is. Owner routes (`POST`/`GET`/`GET :id`/
  `PUT :id`/`DELETE :id`) hand-check `ACLUtils.hasPermission()` against the meeting's `mailboxUid`, always with the
  caller's trusted roles stripped first (`util/RouteAccessUtils.ts` - a repo-local copy of restapi's own internal
  `stripTrustedRoles()`, since that helper isn't exported from `@rapidmx/restapi`'s public surface for a plugin to
  reuse) - matching today's `/api/acls` precedent that mailbox-scoped data is never trusted-role-readable by
  default. `PUT` is deliberately minimal: `title` and `status: "cancelled"` only.
- **Guest JWT + push ACL grant** (`join()`): mints `guest:<16 random bytes base64url>`, a JWT signed with the
  deployment's real `auth` secret but a shallow-copied config with `options.expiresIn` removed (that setting can't
  coexist with an explicit `exp` claim in the payload - `jsonwebtoken` throws otherwise; found this the hard way via
  a failing integration test, documented on `mintGuestToken()`), 4-hour expiry. `ensureGuestChannelGrant()` adds an
  `ACLRecord` for that guest uid directly onto the meeting's own ACL (`READ` for subscribe, `CREATE` for publish -
  see `MailPushRoute`'s own doc comment on what publishing needs), with a bounded retry loop on the ACL's optimistic
  lock (concurrent guests joining the same public link race to write the same document). Verified against a real
  push integration test using the exact fake-socket-plus-fake-Redis harness `@rapidmx/restapi`'s own
  `test/push/MailPushAccess.test.ts` uses (`new MailPushRoute()` wired to the real `ACLUtils`, no actual server
  route mount needed) - owner and guest both subscribe/publish; a stranger and a trusted-but-ungranted admin get
  nothing. Known, documented limitation: each join mints a fresh guest uid (so simultaneous guests are
  distinguishable in signaling), so the meeting's ACL record list only grows, never shrinks - no GC job in Phase 1,
  matching `Booking.manageToken`'s identical precedent; harmless in practice since the JWTs themselves expire.
- **ICE servers** (`util/IceServerUtils.ts`, pure functions, fully unit-tested): two hardcoded public STUN servers
  always included; a TURN entry added when `mail:videoconf:turn:url` is set, with a coturn-style time-limited REST
  credential (`username = "<unix-expiry>:<userPart>"`, `credential = base64(HMAC-SHA1(sharedSecret, username))`)
  when `turn:shared_secret` is also set. Verified against a real HMAC-SHA1 test vector computed independently via
  `openssl dgst -sha1 -hmac` (not just self-consistency with the implementation) - see the test file's own comment
  for the exact command and expected value.
- **Deferred beyond Phase 1** (noted, not forgotten): no `GET .../:id/invitees` re-fetch endpoint (invitee join
  links are only ever returned once, at creation); no bulk create; no GC job for accumulated guest ACL records or
  never-expiring invitee tokens (matches `Booking`'s own precedent).
