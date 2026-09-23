# NOTES

Repo-local engineering notes for `@rapidmx/meet-plugin`, in the same running-journal convention as this
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

## 2026-09-22: Phase 2 (join/lobby + in-call UI) implemented

Frontend-only, entirely inside `apps/meet/` plus reusable non-page modules under a new `apps/shared/` (mirroring
`booking-plugin`'s own `apps/shared/` convention). `yarn lint`/`tsc --noEmit` (root and `-p tsconfig.apps.json`)/
`yarn build`/`yarn test:prod` all clean; 321 tests, 100% statement/function/line coverage, 97.24% branch (floor 95%).

- **`apps/shared/` vs `src/`**: reusable non-UI logic (device media helpers, the mesh connection manager, the
  guest signaling client, active-speaker picking, the level meter) was originally written under this plugin's
  backend `src/` (the task brief allowed a `src/` util for logic "reused by both the lobby and the call view").
  That does not actually build: `tsconfig.apps.json` sets `rootDir: "apps"`, and `tsc -p tsconfig.apps.json` fails
  (`TS6059`) the moment an `apps/` file imports anything under `../../src/` - **and, worse, silently emits the
  offending files' compiled output back into the real `src/` tree** (a rootDir-violation relative-path escape,
  not a `noEmitOnError` situation - discovered the hard way as stray `.js`/`.d.ts` files alongside the real `.ts`
  sources; deleted before finishing). Moved everything to `apps/shared/{media,webrtc,push}/` instead, which is
  under `tsconfig.apps.json`'s own `rootDir` and matches `booking-plugin`'s exact precedent (`apps/shared/
  bookingApi.ts`, `apps/shared/imageResize.ts`) for reusable, non-page frontend code. `src/` itself is untouched
  by Phase 2 - the plugin's backend npm surface (`src/index.ts`'s exports) is unchanged.
- **Push client**: investigated reusing `@rapidmx/react-shared`'s `PushClient`/`getPushClient()` first, as
  required. It doesn't fit: its `connect()` opens a bare `WebSocket` and relies entirely on the browser
  automatically attaching this deployment's `jwt` `HttpOnly` cookie - it has no parameter anywhere to supply an
  arbitrary/guest bearer token, and its shared-singleton-per-tab design is also the wrong shape for a guest
  identity that must never share a socket with whatever webmail session, if any, is already open in the same
  browser. Built a standalone `apps/shared/push/GuestSignalingClient.ts` instead, matching `BasePushRoute`'s real
  wire protocol exactly (not `PushClient`'s more generic one): `SUBSCRIBE`/`SUBSCRIBED` over the WebSocket for
  receiving, but publishing (`send()`) is a plain authenticated `POST /push/:id` with `Authorization: Bearer
  <token>` - no browser limitation applies there. The one real limitation: a browser's native `WebSocket` cannot
  attach a custom header to its upgrade request at all, so the *subscribe* side has no way to present the guest
  bearer token except by writing it into a non-`HttpOnly` `jwt` cookie via `document.cookie` immediately before
  connecting (`applyAuthCookie()`). This works for the common case (a guest with no prior session on this origin)
  but is silently blocked by the browser if a *real* `HttpOnly` `jwt` session cookie already exists for this exact
  origin - the WebSocket then authenticates as that real session instead, and (since the meeting's ACL only names
  the guest uid) the `SUBSCRIBE` is just refused, a safe and visible failure, never a cross-identity leak. The
  clean fix is backend/cross-repo (`@rapidrest/service-core`'s `JWTStrategy`/`BasePushRoute` - e.g. a
  `Sec-WebSocket-Protocol`-carried bearer token, which a browser *can* set on a `WebSocket`) and is out of this
  frontend-only phase's scope - flagged for a later phase/repo rather than fixed here.
- **Mesh who-calls-whom**: the lexicographically smaller uid is always the offerer for a pair
  (`isOfferer()` in `MeshConnectionManager.ts`) - deterministic, no coordination round trip. Roster discovery
  handles arbitrary join order despite the push channel having no replay: whoever learns of a genuinely new peer
  (via `hello` or an incoming `offer`) echoes its own `hello` once, so within one extra round trip everyone
  converges on the same roster regardless of who joined first.
- **Single-presenter rule**: `presenter-claim` is applied optimistically and locally; a genuine claim-collision
  (two claims in flight before either side heard the other's) is resolved deterministically by every participant
  the same way - the lexicographically smaller uid wins, and the losing claimant self-revokes (stops its own
  capture, sends `presenter-release`) once it observes the winning claim. Screen sharing itself never renegotiates
  a connection: `replaceLocalVideoTrack()` swaps each peer connection's existing outgoing video `RTCRtpSender`'s
  track in place.
- **Session-based name prefill - not implemented**: the spec asks the lobby to prefill the name field from
  `Profile.givenName` when the browser already holds a RapidMX session. Investigated `react-shared`'s
  `profileApi.ts`/`session.ts` as directed: `getMyProfile()` needs an `authServerUrl`, and `session.ts` confirms
  `userUid`/`authServerUrl` are only ever supplied via server-side `fetchProps` on the `www`/admin console hosts
  (`@rapidmx/server`'s `wwwRoute`/`AdminConsoleRoute`) - never on the `public` host `/meet` is mounted on.
  `PublicPageRoute` (also `@rapidmx/server`) returns only branding props; no public-host plugin page anywhere in
  this codebase does session detection today, so there was no convention to extend. Left the name field always
  empty and editable instead (correct for the common no-account case); a real fix needs a cross-repo
  (`@rapidmx/server`/`react-shared`) change - either have `PublicPageRoute.fetchProps()` check the incoming `jwt`
  cookie the way `wwwRoute` does, or add a same-origin authenticated "who am I" endpoint - flagged, not built here.
- **Known media limitation**: a participant who joins with zero camera/mic tracks (declined permission, or no
  devices at all) still joins signaling-wise, but this design's renegotiation-free mesh (tracks are attached once,
  at peer-connection-creation time, screen share only ever *replaces* an existing sender) means their peer
  connections carry no media m-lines in either direction - not fixable without adding renegotiation, out of scope
  for this phase.
- **Testing**: this is the first browser-API surface (`getUserMedia`/`MediaStream`/`RTCPeerConnection`/
  `enumerateDevices`/`AudioContext`) anywhere in this codebase, so there was no existing mocking convention -
  `test/apps/testUtils.ts` adds fakes for all of them (`fakeMediaDevices`, `fakeRTCPeerConnection`,
  `fakePushSocket`, `fakeMediaStream`/`fakeTrack`), reused across the plugin's own component and signaling tests.
  `MeshConnectionManager`'s tests include a two-real-instance convergence test (an in-memory pub/sub bus wiring two
  managers together) alongside single-manager, message-injection tests for each race/edge case.

## 2026-09-22: Fix - a logged-in user could not actually join a call (browser-session-collision, folded into Phase 2)

Found during review of Phase 2, before it was committed - not a separate phase, folded into the same working-tree
change `yarn lint`/`tsc --noEmit` (root and `-p tsconfig.apps.json`)/`yarn build`/`yarn test:prod` all still clean;
338 tests, 100% statement/function/line coverage, 97.28% branch (floor 95%).

- **The bug**: `GuestSignalingClient.applyAuthCookie()` authenticates `/push`'s WebSocket upgrade by writing a
  plain (non-`HttpOnly`) `jwt` `document.cookie` to the guest token `join()` minted, immediately before connecting
  - this is the *only* way a browser `WebSocket` can present a bearer credential at all (see that module's own doc
  comment). If the visiting browser already held a **real, `HttpOnly` `jwt` session cookie** for this exact origin
  (an internal invitee with webmail open, or a mailbox owner testing their own link - exactly the "logged in user"
  scenario the original spec calls out), that `document.cookie` write was silently blocked by the browser's own
  "script cannot override an `HttpOnly` cookie of the same name" protection: the intended guest cookie never
  actually got written, the WebSocket authenticated as the *real* session instead, and since the meeting's
  `AccessControlList` grant from `join()` only ever named the synthetic guest uid, the real session's `SUBSCRIBE`
  was simply, safely refused (never a cross-identity leak - just broken). **Net effect: a logged-in RapidMX user
  could not join a call at all.** This is a connection-level failure, independent of (and more fundamental than)
  Phase 2's separately-flagged, purely cosmetic "name isn't prefilled for a session" limitation above - even a
  user who typed their own name by hand still couldn't get signaling access.
- **The fix, backend** (`BaseVideoMeetingRoute.join()`): now accepts an optional `@AuthUser user?: JWTUser` - the
  same "whatever the framework's existing auth middleware already populated from the caller's cookie/header"
  pattern `create()` on this same class, and `BaseScopedChildRoute.resolveEffectiveUser()` elsewhere in this
  codebase's family, already use. A **real, already-authenticated** caller (`user` present, uid not starting with
  the new `GUEST_UID_PREFIX = "guest:"` - the cleanest signal available, since a guest uid can never be a real
  mailbox-owning identity, and it correctly still treats a *returning guest* presenting a prior `join()`'s own
  guest JWT as anonymous, not authenticated) is granted `READ`/`CREATE` on the meeting's channel **under their own
  real uid** via the renamed/generalized `ensureChannelGrant()` (was `ensureGuestChannelGrant()` - same method,
  now also called for a real uid), and `join()` mints no guest JWT at all for them. A true anonymous caller
  (`user` absent - the common case, no existing session to collide with in the first place) is unchanged from
  Phase 1.
- **`VideoMeetingJoinResult` shape change**: added `authenticated: boolean` and a `selfUid: string` (always
  present - the identity to grant/identify as on the signaling channel, replacing the guest-only `guestUid` field
  now that this can be a real identity too); `token`/`expiresAt` are now optional, present only when
  `authenticated` is `false`. Chose this shape over the literal "just omit `token`/`guestUid`" suggestion because
  the frontend's mesh layer (`MeshConnectionManager`) always needs *some* self uid to identify with on the
  channel regardless of path, and the public/anonymous `/meet` page has no independent way to learn a real
  caller's own uid except from this response (see the Phase 2 "session-based name prefill" note above on why
  there's no session-detection convention on this host at all) - so `selfUid` had to be unconditional either way.
- **The fix, frontend** (`apps/shared/push/GuestSignalingClient.ts`, `apps/meet/_CallView.tsx`, `apps/meet/
  [token].tsx`, `apps/meet/_meetApi.ts`): `GuestSignalingClient`'s `token` option is now optional. When present
  (the common anonymous case), behavior is exactly Phase 2's original. When absent (`authenticated: true`), it
  writes no cookie at all (`applyAuthCookie()` no-ops) and sends no `Authorization` header on `send()`'s `POST
  /push/:id` either - relying entirely on the browser's own already-existing real `jwt` cookie, which `fetch()`'s
  default same-origin credentials mode already attaches with zero extra code, exactly like `JWTStrategy` would
  authenticate any other same-origin call. `[token].tsx` passes `joinResult.token` straight through (naturally
  `undefined` in the authenticated case) rather than branching explicitly.
- **Tests updated**: both Mongo/SQL `VideoMeetingRoute.test.ts` (new `GET /join/:token` cases: an
  already-authenticated real caller gets `authenticated: true`/`selfUid`/no token and a real ACL grant; a
  returning guest presenting its own prior guest JWT still gets a fresh guest identity, never the authenticated
  path; `ensureGuestChannelGrant` renamed to `ensureChannelGrant` throughout; a new push-channel-access test proves
  the real caller's own uid, not a guest uid, gets `READ`/`CREATE`), `videoMeetingSecuritySuite.ts` (added
  `strangerUid` to the shared context; the same three scenarios, backend-agnostic), `GuestSignalingClient.test.ts`
  (no cookie written and no `Authorization` header sent when `token` is omitted), `_CallView.test.tsx` (forwards
  an absent `token` to the signaling client untouched), `[token].test.tsx`/`_meetApi.test.ts` (the
  `authenticated: true` response shape end-to-end). `test/plugin.test.ts`'s exported-surface list picked up the
  new `GUEST_UID_PREFIX` export.

## 2026-09-22: `VideoMeeting.organizerSlug` - the organizer of their own private meeting could not join it

Backend-only, additive, entirely inside `src/models/` + `src/routes/BaseVideoMeetingRoute.ts` (nothing under
`apps/` touched - the plugin's frontend is unchanged). `yarn lint`/`tsc --noEmit` (root and
`-p tsconfig.apps.json`)/`yarn build`/`yarn test:prod` all clean; 368 tests, 100% statement/function/line coverage,
97.26% branch (floor 95%); `src/routes` and `src/models` are at 100% on all four metrics.

- **The gap**: the parallel calendar integration (restapi's `MeetingSchedulingJob` + web-client's compose UI) mints
  one `visibility: "private"` `VideoMeeting` per calendar event, with `invitees` built from the event's attendees
  **excluding the organizer** - by deliberate design on that side: the organizer manages the meeting through
  ownership, not as a guest invitee. For such a meeting the organizer therefore held *nothing*
  `requireMeetingByToken()` could resolve: no invitee `joinToken` (never an invitee) and no `publicSlug`
  (`persistMeeting()` mints one only for a public meeting). Phase 2's "real, already-authenticated callers" fix
  would happily grant them their own uid on the channel - they just had no link that reached `join()` in the first
  place. Not fixable on the integration's side without either making the organizer a fake invitee (wrong, and would
  put an anonymous-credential token in the organizer's hands) or making the meeting public (much worse).
- **The addition**: `VideoMeeting.organizerSlug?`, minted by `persistMeeting()` for every `PRIVATE` meeting with the
  same `mintPublicSlug()` shape/entropy as `publicSlug` (a separate column, so no shared collision namespace beyond
  each field's own). `create()` returns it as `VideoMeetingCreateResult.organizerJoinUrl` *alongside* `invitees`
  (both present together for a private meeting now, not mutually exclusive), and `findById()` now returns
  `VM & { organizerJoinUrl?: string }` so a caller loading an existing event later still gets a working organizer
  link, not only the one `create()` handed back once. Confirmed by grep that nothing in this repo consumed
  `findById()`'s previously-bare `VM` shape - `apps/meet` only ever calls `join/:token`, and Phase 4's admin/settings
  pages don't exist yet - so widening it breaks no caller.
- **`requireMeetingByToken()` now returns `{ meeting, resolvedVia: "invitee" | "publicSlug" | "organizerSlug" }`**
  rather than a bare meeting. `join()` (its one call site) authorizes the three differently, and returning the
  resolution directly beats re-deriving it by string-comparing the token against the meeting's fields afterwards.
  A slug-shaped token still hits `publicSlug` first with exactly Phase 1's outcome whenever it matches a row at all;
  only a token matching no `publicSlug` row is then looked up against `organizerSlug` (the two columns are disjoint
  by construction), so the change is provably additive - every pre-existing `publicSlug`/invitee-token test passes
  unmodified.
- **Why this does not weaken the `"private"` invariant.** An invitee `joinToken` and a `publicSlug` *are*
  credentials - possession of the link is the whole authorization, by design. An `organizerSlug` deliberately is
  not. For `resolvedVia === "organizerSlug"`, `join()` demands, **before computing or returning anything about the
  meeting**, both (a) a real already-authenticated caller (the same `user && !user.uid.startsWith(GUEST_UID_PREFIX)`
  check Phase 2's fix introduced, so a *returning guest* presenting a prior `join()`'s own guest JWT never
  qualifies) and (b) that this identity holds `READ` on the meeting's own `mailboxUid` via the very same
  `aclUtils.hasPermission(stripTrustedRoles(user, this.trustedRoles), ...)` call `requireMailboxAccess()` makes for
  every owner-side route - so a trusted+elevated administrator with no explicit grant is refused here exactly as
  they are there. Failing either answers the bare `404` `requireMeetingByToken()` already throws for a token that
  matched nothing whatsoever - deliberately **not** `requireMailboxAccess()`'s `403`, which is why the check is
  inlined rather than delegated to that helper: a `403` would tell an anonymous prober that the slug they guessed
  names a real meeting, and this class's stated posture is that a probe must never learn whether a token
  almost-matched. A caller who passes both falls through to the existing authenticated branch untouched
  (`ensureChannelGrant()` under their own real uid, `authenticated: true`, `selfUid`) - no new response field.
- **Index shape - the one place this does NOT mirror `publicSlug`.** `publicSlug` is unique within its mailbox
  (`@Index([...], { unique: true, sparse: true })` on `["mailboxUid", "publicSlug"]`). Mirroring that literally for
  `organizerSlug` **breaks creating a second public meeting in one mailbox**, caught immediately by the existing
  "Lists only the given mailbox's meetings" test: a compound sparse index still indexes a document that carries at
  least one of its keys, so every public meeting (no `organizerSlug`) lands in the index under `(mailboxUid, null)`
  and the second one collides. Landed on a single-field `["organizerSlug"]` unique+sparse index instead - a
  single-field sparse index skips a document missing the field outright, and its scope happens to match the lookup
  `join()` actually performs (global; a join URL carries no mailbox segment), which is more than `publicSlug`'s own
  index can say. **Noted for a future phase, not fixed here** (out of this change's scope, and fixing it would alter
  existing `publicSlug` behavior): the exact same pitfall means today's `["mailboxUid", "publicSlug"]` index would
  reject a *second private* meeting in one mailbox. No existing test creates two private meetings in one mailbox, so
  it has never fired - but a real mailbox owner creating two private meetings would hit it.
- **Tests**: the shared `videoMeetingSecuritySuite.ts` gained `ownerUid` in its context, `organizerSlug` on
  `createPrivateMeeting()`'s return, and two backend-agnostic describes - `join() via the organizer's own slug`
  (owner succeeds as their own real identity; anonymous, returning-guest, real-but-unrelated stranger, trusted
  administrator and cancelled-meeting cases all `404`) and `the organizer join link (create/findById)` (a private
  meeting's `organizerJoinUrl` is present, correctly shaped and actually resolves; a public meeting has neither
  `organizerSlug` nor `organizerJoinUrl`; `findById()` returns the same link on a re-read and omits it for a public
  meeting). Both `VideoMeetingRoute.test.ts` files additionally prove the real ACL channel grant the same way the
  Phase 2 tests prove theirs, using the *delegate* (READ/LIST on the mailbox, and - unlike the creator - no
  pre-existing record of their own on the meeting's ACL) so the grant asserted is unambiguously the one `join()`
  just made. Model and `plugin.test.ts` index/field expectations updated alongside.

### 2026-09-22 (later still) - Fixed the same sparse-index pitfall on `publicSlug` itself

The agent adding `organizerSlug` above found and fixed a real bug in its own new index, then flagged (without fixing,
since it was out of that task's scope) that `publicSlug`'s *original* Phase 1 index had the identical flaw: a
compound sparse index (`["mailboxUid", "publicSlug"]`) still indexes a document carrying at least one of its keys,
and every row has `mailboxUid`, so two *private* meetings in one mailbox (both missing `publicSlug`) collided on
`(mailboxUid, null)` - the second could never be created. This was a real, live bug (a host trying to schedule a
second video-conferenced meeting would have failed outright), not just the documented "cross-mailbox collision isn't
prevented, only made unlikely" entropy tradeoff Phase 1's own NOTES already called out.

Fixed the same way `organizerSlug` was: a single-field sparse unique index (`videomeeting_public_slug`, on
`publicSlug` alone), which skips a document missing the field entirely and happens to match `join()`'s real (global,
no mailbox segment) lookup scope exactly - arguably more correct than the original per-mailbox intent, not just a
workaround. Doc comments on `VideoMeeting.publicSlug`/`organizerSlug` in `models/types.ts` rewritten to describe the
actual (global, single-field) index both fields now share, rather than the abandoned per-mailbox design. New
regression test in `videoMeetingSecuritySuite.ts`: an owner creating two private meetings in the same mailbox back
to back, both succeeding with distinct uids - this reproduced the bug before the fix and is now green on both
backends.

Files: `src/models/mongo/VideoMeetingMongo.ts`, `src/models/sql/VideoMeetingSQL.ts`, `src/models/types.ts`,
`test/routes/videoMeetingSecuritySuite.ts`.

## 2026-09-22: Phase 4 (personal settings page) implemented

Frontend-only inside this repo, entirely under `apps/settings-video-conferencing/` (the Phase 1 placeholder page
this manifest already declared, per `.claude/NOTES.md`'s Phase 1 entry) - `apps/meet/`, `src/routes/`,
`src/models/` untouched except the one small, additive backend change documented below. `yarn lint`/`tsc --noEmit`
(root and `-p tsconfig.apps.json`)/`yarn build`/`yarn test:prod` all clean; 408 tests, 100% statement/function/line
coverage, 97.52% branch (floor 95%).

- **The "personal room" convention - no new field or route.** The spec asks for "a single URL shared across all
  attendees, unique per mailbox" (Phase 1's own design note on why `visibility: "public"` exists at all) surfaced
  as "my personal meeting room." Checked `BaseVideoMeetingRoute`'s existing routes first, per the task brief: a
  mailbox is not restricted to one public meeting (nothing stops `create()` from being called twice with
  `visibility: "public"`), and there is no field distinguishing "the" personal room from any other public meeting
  a mailbox happens to have. Rather than add one, this page treats a mailbox's **oldest still-active
  (non-cancelled) `PUBLIC` `VideoMeeting`** as its personal room by convention (`findPersonalRoom()` in
  `index.tsx`) - oldest-first keeps the identification stable across reloads regardless of when a later public
  meeting (created some other way, e.g. directly through the API) lands in the list; skipping a cancelled one
  means cancelling today's room and creating a new one always finds the fresh one on the next load. If none
  exists, the page offers to create one (`PersonalRoomCard`'s "Create my personal room" button, an ordinary
  `createVideoMeeting({ visibility: "public" })` call with no new parameters). This is exactly the "smallest
  sensible convention" the task brief anticipated as the fallback, and it was sufficient - no new
  field/route/flag was needed to make "get and manage my one public link" work.
- **The one small, additive backend change: `find()`/`findById()` now also return `publicJoinUrl`.**
  `create()`'s response already computed `organizerJoinUrl`/`publicJoinUrl` inline from a slug it had just minted,
  but that response is only ever sent once, at creation - `findById()` (`GET /:id`) only ever recomputed
  `organizerJoinUrl` (mirroring the exact gap `organizerSlug` itself was invented to close, see the entry above),
  and `find()` (`GET /`, the list endpoint) recomputed neither. This settings page needs a public meeting's
  shareable link on every later page load, not only the one response `create()` ever sent - without this, a user
  reopening Settings after creating their room would see the room but have no way to get its link back (the
  `publicSlug` value itself was never exposed to the client anywhere `find()`/`findById()` return it, since these
  routes return the raw persisted entity). Genuinely tried to make this work without touching `src/` first (per
  the task brief's instruction), and could not: the join URL requires `mail:videoconf:public_url` (a
  server-only config value never exposed to the client) plus `buildBaseUrl()`'s own safety validation, both of
  which only exist inside `BaseVideoMeetingRoute`. The fix, `BaseVideoMeetingRoute.withJoinUrls()`: a new private
  helper factoring out exactly what `create()` and the old `findById()` ternary already computed, now applied
  uniformly to every meeting `find()`/`findById()` return (`organizerJoinUrl` when `organizerSlug` is set,
  `publicJoinUrl` when `publicSlug` is set - a meeting only ever carries one of the two, never both). Purely
  additive: every existing `VM`/`VM[]` field is still present, unchanged; only the two new optional fields are
  added. Tests: `videoMeetingSecuritySuite.ts`'s "the organizer join link (create/findById)" describe block
  (renamed "the organizer/public join link (create/find/findById)") gained a `publicJoinUrl` assertion on its
  existing re-read test and a new list-endpoint test, backend-agnostic on both Mongo and SQL.
- **`react-shared` addition (a different repo, its own gates verified separately - see below): `listVideoMeetings()`.**
  Checked `@rapidmx/react-shared`'s `videoconf/videoMeetingsApi.ts` (Phase 3's addition) first, per the task
  brief: it covered create/update/get, but had no list call at all (`BaseVideoMeetingRoute.find()` already
  supported exactly the query this page needs - `mailboxUid` only, no `calendarEventUid` filter - it just had no
  typed wrapper). Added `listVideoMeetings(mailboxUid, params?)` (`GET /mail/video-meetings?...`, matching
  `bookingApi.ts`'s own `listBookingTypes()` shape/paging convention exactly), a `dateCreated: string` field on
  `VideoMeeting` (every `BaseEntity` already carries one; this page both displays it and uses it for the personal
  room's oldest-first ordering, so it earned being typed - see that interface's own "only the fields a client
  actually reads" convention), and `publicJoinUrl?: string` alongside the already-existing `organizerJoinUrl?` on
  `VideoMeetingDetail` (now shared by `getVideoMeeting()`'s and `listVideoMeetings()`'s response shape, matching
  `withJoinUrls()`'s own uniform computation above). No other Phase 3 shape changed. Verified separately in that
  repo: `tsc --noEmit`, `yarn lint`, `yarn build` clean; full suite 96 files / 1264 tests, 100%
  statement/function/line coverage, 99.48% branch (gates unchanged). Consumed here via the same
  build-and-copy-`dist` overlay this project's sibling repos use for an unpublished cross-repo change (see e.g.
  `react-shared`'s own NOTES on `web-client`'s node_modules overlay) - `videoconf-plugin/node_modules/@rapidmx/
  react-shared/dist` was refreshed from a `yarn build` there; nothing in either repo's `package.json`/`yarn.lock`
  was touched, and no version was bumped.
- **Page structure** (`_layout.tsx`, `index.tsx`, `_PersonalRoomCard.tsx`): matches `booking-plugin`'s
  `apps/settings-booking-types/` conventions exactly, per the task brief's structural reference - `_layout.tsx` is
  a byte-for-byte copy of that file's own copy of `web-client`'s `apps/www/_layout.tsx` (every plugin app
  directory needs its own); `index.tsx` uses `SettingsShell`/`useSettingsShell()` the same non-null-`mailboxUid`
  way every other settings page does, with `active="video-conferencing"` (the `id` this plugin's manifest already
  declares under `ui.settingsSections` - manifest untouched, as instructed); the meetings table reuses
  `BookingTypesContent`'s exact table/copy-link shape (`INPUT_CLASS`, the same header row, the same
  copy-then-revert-after-2s button pattern). `PersonalRoomCard` is a small local (not `apps/shared/`) component,
  since - unlike `booking-plugin`'s `BookingProfileEditor` - nothing else in this plugin needs it.
- **What the meetings table shows**: every public meeting other than the identified personal room, plus any
  private meeting with a linked `calendarEventUid` (the calendar compose hook's own meetings, Phase 3) - a
  private, calendar-less meeting is left out as an artifact of this plugin's own API used directly (e.g. testing),
  per `BaseVideoMeetingRoute`'s own Phase 1 doc comment on why that's possible at all. Actions are exactly the
  task brief's two: "Copy link" for a public entry with a `publicJoinUrl` (omitted when the deployment has no
  `mail:videoconf:public_url` configured), and "Cancel" for a `"scheduled"` entry (`updateVideoMeeting(uid, {
  status: "cancelled" })` - this route's own `PUT` was already this minimal in Phase 1, nothing new needed here
  either). The personal room card additionally allows renaming (`updateVideoMeeting(uid, { title })`) - a small,
  natural extension of "manage" the task brief's own wording invited, using the exact same existing endpoint.
- **Nothing else touched**: no admin/TURN UI (already fully covered by the generic plugin-settings dialog, per
  the task brief - not built here), no `web-client`/`restapi`/`server` changes, no version bump, no commit.

## 2026-09-22: Hardening pass - cross-repo dependency-review fixes, plus a fresh adversarial review

A lighter-touch pass (this repo's own activity is lighter than the ecosystem's core repos) combining three
already-confirmed fixes from a prior cross-repo dependency review with a fresh, read-first adversarial review of
this repo alone. `yarn lint`/`yarn build`/`vitest run --coverage` all clean after every change; 410 tests
(2 new), 100% statement/function/line coverage, 97.52% branch (floor 95%) - unchanged from before this pass except
for the 2 new regression tests.

- **Fixed: `peerDependencies["@rapidmx/react-shared"]` floor was `>=0.6.0`, below the version this plugin actually
  requires.** `apps/settings-video-conferencing/*.tsx` import `@rapidmx/react-shared/videoconf/videoMeetingsApi.js`,
  which that package's own `CHANGELOG.md` shows was added in `0.13.0` (react-shared's current latest at the time of
  this pass). Installing this plugin against anything in its own claimed-supported range below `0.13.0` would hit a
  hard module-resolution failure at import time, not a compile-time type error (a plugin's `apps/` always compiles
  against this repo's own `devDependencies` pin, never the peer range's floor - so `tsc`/`yarn build` passing proves
  nothing about the floor's own correctness). Raised the floor to `>=0.13.0 <1`. Verified this is a real
  compatibility check, not just a manifest edit: after the bump, `yarn install` (react-shared correctly resolved to
  `0.13.0`), `yarn build`, and the full `vitest run --coverage` suite were all re-run clean - nothing else in this
  plugin assumed an older react-shared API shape.
- **Fixed: `resolutions["@rapidmx/react-shared"]` was pinned to `^0.11.0`, inconsistent with `booking-plugin`'s own
  convention of pinning a `resolutions` entry to exactly match its `peerDependencies` floor.** Updated to `^0.13.0`
  to match the corrected floor above. Checked `restapi`/`web-client`'s own `resolutions` entries against their peer
  floors while here (per the review brief) - both already matched (`^0.17.0`/`^0.11.0` against `>=0.17.0`/`>=0.11.0`
  floors respectively), so `booking-plugin`'s convention was already being followed correctly for those two; only
  `react-shared` had drifted.
- **Fixed: stale `@rapidmx/videoconf-plugin` prose left over from the rename to `@rapidmx/meet-plugin`.** Swept
  `README.md` (the npm-version badge/link, plus the CI/Coverage badges - both still pointed at the pre-rename
  `RapidMX/videoconf` repo, the same class of staleness even though not explicitly named in the review brief;
  `package.json`'s own `repository` field already confirms the current name), this file's opening line, and
  `RELEASE_NOTES.md`'s Phase 1 entry, and `src/util/BookingIntegrationUtils.ts`'s doc comment. Deliberately left
  alone: the historical `videoconf-plugin/node_modules/...` path mentioned inside this file's own dated Phase 4
  entry above (this file's own convention is a running journal, never rewritten), and every `mail:videoconf:*`
  config setting key and `VIDEOCONF_PLUGIN_NAME`/`PluginRegistry` functional-rename reference (already correct
  everywhere, per the review brief - the rename was already done correctly at the code level, only prose lagged).
- **Fresh adversarial review findings: nothing new at CONFIRMED/PLAUSIBLE severity worth a code change.** Read
  through `BaseVideoMeetingRoute.ts` (owner-route authz, `join()`'s token/slug disambiguation and the
  organizer-slug/guest/authenticated-caller branches, the ACL channel-grant retry loop), `util/PublicUrlUtils.ts`
  (the one function that actually produces `organizerJoinUrl`/`publicJoinUrl`/invitee `joinUrl` - validates
  scheme/loopback/credentials/query/fragment before ever embedding a token in a link, so this repo does constrain
  what it hands other consumers, as the review brief asked to double check), `util/TokenUtils.ts`/`IceServerUtils.ts`
  (verified against an independent HMAC-SHA1 test vector, not just self-consistency),
  `apps/shared/webrtc/MeshConnectionManager.ts` and `apps/shared/push/GuestSignalingClient.ts` (signaling message
  handling, reconnect/backoff, the `HttpOnly`-cookie-collision fix already documented above), and every `apps/`
  page for injection surfaces (no `dangerouslySetInnerHTML`/`innerHTML`/`eval` anywhere in `apps/` - a participant's
  freeform display name is only ever rendered through ordinary JSX text interpolation, which React escapes). All of
  this was already unusually thorough for the repo's own stated "lighter-touch" activity level - the known,
  already-fixed browser-session-collision bug and the `publicSlug`/`organizerSlug` sparse-index pitfalls (both
  documented in this file's earlier entries) were the kind of thing a fresh pass would otherwise have flagged, but
  they were already found and fixed by the agents that did that work. No new correctness, security or performance
  issue was found worth changing code for.
- **New regression test** (`test/plugin.test.ts`, new "package.json dependency consistency" describe block): (1)
  walks every `apps/**/*.tsx` file for a `@rapidmx/react-shared/videoconf/...` import and asserts the declared
  `peerDependencies` floor is at least `0.13.0` - written to walk the actual imports rather than hardcode today's
  one call site, so a future addition to that surface can't silently regress the floor again; (2) asserts every
  `resolutions` entry equals `^<its own peerDependencies floor>` for `react-shared`/`restapi`/`web-client`, so a
  future drift like the `react-shared` one just fixed fails CI immediately instead of waiting for another cross-repo
  review to catch it.
