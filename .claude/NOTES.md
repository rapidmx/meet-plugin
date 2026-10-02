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

## 2026-09-23: Round-3 adversarial review - signaling-message spoofing found here, fixed in `restapi` instead; `react-shared` bumped to 0.14.0

A round-3 cross-repo adversarial review flagged two things for this repo. Only the second was actually this
repo's to fix; the first is documented here for cross-reference only.

- **[HIGH, found here, fixed elsewhere] Signaling messages were self-attested - no binding between the
  authenticated push-channel publisher and the `from`/`to` fields a client claims inside the message body.**
  `apps/shared/webrtc/MeshConnectionManager.ts`'s `handleMessage()` (and everything downstream of it -
  `handleBye()`, `handlePresenterClaim()`, `handleOffer()`/`handleAnswer()`) trusts `message.from` completely,
  checking only "not my own uid" and "addressed to me or broadcast." The transport underneath it - the server's
  shared `/push/:id` endpoint (`@rapidrest/service-core`'s `BasePushRoute.send()`, subclassed by `@rapidmx/
  restapi`'s `MailPushRoute`) - only checks whether the authenticated caller holds `CREATE` on the channel (i.e.
  "may publish *something*"), then republishes the message body verbatim with zero inspection of its contents.
  Since every participant in a mesh call - owner, delegate, or an anonymous guest who joined via the public link
  - holds `CREATE` on the meeting's channel for as long as their guest JWT remains valid (up to the full
  `GUEST_JWT_TTL_SECONDS`, 4 hours, per this file's Phase 1 entry above - the ACL grant itself is never revoked
  on leaving), any participant who has ever been in the call can forge a `bye`/`presenter-claim`/`offer`/
  `answer` claiming another real participant's `from` uid, up to 4 hours after leaving. Investigated first
  whether this plugin owns any interception point to fix it in: it does not - `apps/shared/push/
  GuestSignalingClient.ts` posts directly to the server's generic, shared `/push/:id` route, which this plugin
  never subclasses or wraps (confirmed by grep: nothing under `src/` references `BasePushRoute` at all). Fixing
  it here would mean either forking the shared push route (wrong layer, and this plugin has no route of its own
  at that path to begin with) or trusting a client-supplied signature scheme invented just for this plugin, both
  worse than fixing the actual gap. **Correctly scoped as a `restapi`-owned fix instead**: `MailPushRoute.send()`
  is the one general chokepoint every consumer of the push system (this plugin's signaling included) already
  flows through, so the fix belongs there - a published `msg.from`, when the message body carries one at all,
  must be stamped or verified against the authenticated caller's own uid before publishing, generically, not as
  a meet-plugin-specific carve-out. Not fixed in this repo; no code here changed for this finding. See
  `restapi`'s own `.claude/NOTES.md` for the actual fix once landed there.
  - Also flagged, same review, not actioned (medium severity, informational): the TURN REST credential TTL
    (`DEFAULT_TURN_CREDENTIAL_TTL_SECONDS`, 1 hour, `util/IceServerUtils.ts`) is shorter than the guest JWT's own
    4-hour signaling-session TTL, and neither `MeshConnectionManager` nor `GuestSignalingClient` re-fetches ICE
    servers or restarts ICE mid-call - a call relying on the TURN relay (symmetric NAT/restrictive firewall) past
    the 1-hour mark could silently lose media. No mechanism exists today to refresh ICE servers or restart ICE for
    a long-running call; flagged as a known limitation for a future phase, not fixed in this pass.
- **`@rapidmx/react-shared` bumped to `0.14.0`** (`devDependencies`/`resolutions` `^0.13.0` → `^0.14.0`,
  `peerDependencies` floor `>=0.13.0 <1` → `>=0.14.0 <1`) - `0.14.0` shipped two real security fixes (session
  signing/encryption keys now imported non-extractable; `sanitizeMessageBodyHtml()` now forbids `svg`/`math`
  tags). The prior peer range (`>=0.13.0 <1`) already technically permitted `0.14.0`, but `devDependencies`/
  `resolutions` still hard-pinned `^0.13.0`, so `yarn install` alone would never have picked it up. Raised the
  peer floor too, not just the pins: this repo's own convention (established landing the prior hardening pass,
  see `test/plugin.test.ts`'s "pins every 'resolutions' entry to exactly its own 'peerDependencies' floor"
  regression test above) requires `resolutions` to exactly equal `^<peer floor>`, and for a security-motivated
  bump, forcing the floor up so installs can't silently stay on the vulnerable `0.13.0` line is the more
  defensible reading of "bump react-shared" than reusing the old floor and pinning `resolutions` ahead of it
  (which would have both broken that regression test and let a fresh install still land on `0.13.0`). Confirmed
  low-risk before and after: grep for the changed modules (`crypto/keySession.ts`, `mail/
  messageBodySanitizer.ts`, `mail/mailDetailHooks.js`, `components/overlays/PopoverPortal.js`) across `apps/`/
  `src/`/`test/` finds none imported here. `yarn install` (resolved to `0.14.0`), `yarn build`, and
  `vitest run --coverage` all re-run clean after the bump: 410 tests (unchanged), 100% statement/function/line
  coverage, 97.52% branch (floor 95%, unchanged).

## 2026-09-24: Fix - a private meeting's invitees never received their join link in the calendar invite

**Bug**: an invite for a private video meeting (`Invitation: Video Test`) went out with the placeholder LOCATION
"Video call - link in this invitation" and no link in the body. Verified on a real server: the
`calendar_event_attendee_link_mongo` collection had 0 rows. restapi's `MeetingSchedulingJob.sendPersonalizedInvites()`
gives each attendee their own LOCATION/body link from `CalendarEventAttendeeLink` rows (`mailboxUid`,
`calendarEventUid`, `attendeeAddress` normalized, `url`, optional `label`), and the model's doc comment says the
*plugin* writes them through its own `RepoUtils`. `BaseVideoMeetingRoute` never did.

**Fix** (`BaseVideoMeetingRoute`, `VideoMeetingRouteMongo`/`SQL`):
- New abstract `attendeeLinkClass` (`CalendarEventAttendeeLinkMongo`/`SQL` from `@rapidmx/restapi/mongo`/`sql`) and an
  `attendeeLinkRepo` built in `init()` like `mailboxRepo`.
- `persistMeeting()` (already `@Transactional()`) writes one link per invitee, `ignoreACL: true`, label
  "Join video call", url = that invitee's own `joinUrl(joinToken)`, address = the already-lowercased invitee email -
  only for a private meeting with a `calendarEventUid`, and skipping any invitee whose join URL is undefined (no
  `mail:videoconf:public_url`). Atomic with the meeting and invitees. Never the organizer (not an invitee).
- `delete()` and `update()` with `status: cancelled` remove the meeting's links (`deleteAttendeeLinks()`): rows for
  the meeting's mailbox + `calendarEventUid` (`ModelUtils.literal`) whose `url` ends in one of *this meeting's*
  invitees' join tokens. Matching on the token, not just the event uid, so a second meeting sharing the same event is
  untouched, and a changed `public_url` can't orphan rows. The cancel cleanup runs after the meeting update (not in
  one transaction - `update()` isn't transactional); a failure there leaves the rows, which is harmless since a
  cancelled meeting's join links already answer 404.
- `createSingleInviteeVideoMeeting()` (booking-plugin integration) left alone: it takes no `calendarEventUid` and mints
  a meeting for a booking, not a calendar event invite, so there is nothing for `MeetingSchedulingJob` to look up.
- Meetings created before this fix have no link rows; not backfilled (re-create the meeting).

**Dependencies**: the model exists since restapi 0.19.0, so the peer floor is now `>=0.19.0 <1`. The repo's regression
test requires `resolutions` to equal exactly `^<peer floor>`, so `resolutions` is `^0.19.0` (not `^0.20.1`); that
resolution overrides `devDependencies`' `^0.20.1`, so this repo now installs and tests against restapi 0.19.0.
`yarn install` resolved 0.17.0 -> 0.19.0 (yarn.lock updated). Added a `plugin.test.ts` check that the peer floor
covers the `CalendarEventAttendeeLink` import.

**Tests** (Mongo and SQL route tests, same cases in each): one link per invitee with the exact join URL, normalized
address, label and event uid; none for a public meeting, none without a `calendarEventUid`, none without a public
URL; delete removes only that meeting's links (another event's and another meeting's on the same event survive);
cancel removes them, a title-only update keeps them. The test servers' model indexes export the link model so it
registers. `tsc --noEmit`, `yarn lint` clean; 423 tests pass, 100% statement/function/line coverage, 97.56% branch.

## 2026-09-24: Fix - the video call didn't work (no self video, no remote media, off-screen layout) and gained mic/camera menus, reactions and raise hand

JP tried a real meeting on Edge (PC) and a phone: permission was never asked on some devices, the local video vanished on joining, nobody saw or heard anyone else, the call ran off the bottom of the screen. Asked for (Google Meet-style): a bottom-fixed control bar, the local video small in the bottom-right, mic/camera buttons with a device menu and a live level, an emoji button and a raise-hand button. `yarn lint`, `tsc --noEmit` (root and `-p tsconfig.apps.json`) clean; 510 tests, 100% statement/function/line, 97.73% branch.

**Root causes** (all in `apps/`, none backend):
- **Self video gone**: `MeetLobby` owned the preview stream and stopped it in an effect cleanup when it unmounted - which is when `CallView` starts sending it. Every joiner sent ended tracks. This alone explains much of "no video or audio when someone joins". `useLocalMedia()` (`apps/shared/media/`) now lives in `[token].tsx` and is handed to both; tracks are stopped once, on leave/unmount.
- **Media only if you had tracks at connection time**: `createPeer()` `addTrack()`ed the local tracks once; a participant with none (denied, no device, camera on later) negotiated no m-lines either way. Now a send-and-receive audio and video transceiver exist on every connection and `setLocalTrack()` `replaceTrack()`s - no renegotiation. Remote tracks are collected into one `MediaStream` per peer from `ontrack`'s `event.track` (a transceiver whose sender has no track announces no stream, so `event.streams[0]` is empty).
- **The answerer sent nothing** (found with the real-browser harness below, *not* by unit tests - the fakes couldn't show it): a browser only matches an offer's m-lines to transceivers created by `addTrack()`, never to ones the answerer added with `addTransceiver()` up front. Those sit unused and the answerer's media is silently lost, while everything the offerer sends arrives - so a call looks half-working. Only the offerer (`isOfferer()`, smaller uid) adds transceivers; the answerer calls `claimTransceivers()` after `setRemoteDescription(offer)` (sets them sendrecv and returns their senders) and `replaceTrack()`s its tracks on. `RTCPeerConnectionLike` gained `addTransceiver`/`claimTransceivers`, lost `addTrack`/`getSenders`.
- **Out-of-order signaling** (each message is its own `POST /push`): an ICE candidate that beat its offer was dropped (now held per uid, capped at 64 candidates x 32 uids, cleared on bye); an offer that beat its hello left the peer named by its uid forever (`handleHello` now updates a known peer, emitting `participant-updated`).
- **Same account, two devices** (`selfUid` is the account's uid when `join()` reports `authenticated`): both used it as `from` and filtered each other's messages as their own. `CallView` now uses `newPeerId()` = uid + `~` + random suffix on the channel. The backend's `selfUid` is unchanged.
- **Audio through the tile**: a remote tile only rendered a `<video>` when it had a stream and a camera, and the focus layout hid non-main tiles, so audio depended on layout. Tiles are always muted now; each remote stream has a hidden `<audio>` (`RemoteAudio`), with a click-to-enable banner if `play()` is refused.
- **Layout**: `CallView` was inside `MeetPageShell` with `min-h-screen`. It is now `fixed inset-0` (header / tiles / control bar rows) and rendered outside the shell; the lobby, loading, not-found and ended states keep the shell. The self view is a corner tile when anyone else is present (`xl:` bottom-right in the bar's row, above the bar down to `sm`, top-right on a phone where the bar wraps to two rows), large when alone. The control bar's menus are anchored to the whole bar below `sm` and to their own button above it.
- **Permission "never asked"**: not reproducible from here, and not a server header - no `Permissions-Policy`/CSP is set anywhere in `server`, `web-client` or the chart. What changed is defensive: ask once on lobby open *and* from an "Allow camera and microphone"/"Try again" button (a click is a user gesture, which some browsers require), ask for both in one prompt then per-device if that fails for any reason but a denial, and show why (blocked / no camera / unsupported browser - an in-app browser or plain HTTP has no `navigator.mediaDevices`). If a specific phone/browser still never prompts, the lobby now shows which of those it is - start there.

**Design notes**:
- `useLocalMedia()`: mute = disable the audio track (instant); camera off = **stop** the track (light goes out) and camera on = `getUserMedia` again, so turning the camera on works even after a denial or with no device at join. `audioLevel` (0-5, quantized so it re-renders only on change) drives the bars on the mic button; the camera button shows a green dot while a track is live. A video device switch stops the old track first (phones can't open two cameras).
- State travels in-band: `hello` carries `{audioOn, videoOn, handRaised}` and every change is a `state` message, because a remote track gives no dependable signal that its sender stopped. New `reaction` messages carry one of `REACTION_EMOJIS`; anything else received is ignored (never render an arbitrary string from another participant). `hand-raised` events chime (`apps/shared/media/chime.ts`, Web Audio, no asset) and fill an `aria-live` region.
- `GuestSignalingClient.send()` uses `fetch(..., { keepalive: true })` and `CallView` calls `manager.stop()` on `pagehide`, so closing a tab says goodbye.
- Screen share is just `setLocalTrack("video", screen)` / back to the camera, driven by an effect on `(media.videoTrack, screenStream)`. Unchanged: the single-presenter claim rules.

**How this was verified beyond the unit tests** (worth repeating for any change to the mesh): a throwaway harness (not committed) bundled the real `MeshConnectionManager` + `createBrowserPeerConnection` with esbuild and ran it in headless Edge (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, driven over CDP with Node's built-in `WebSocket`) against an in-page signaling bus with 0-40 ms random per-message delay. Three participants, the third with no media, joining 300 ms apart: all rosters and names correct, A and B received each other's audio and video, C received both, C then attached a camera and microphone late and both received them with no new connection, hand and reaction events arrived, all six connections `connected`. A second harness rendered the real `CallView`/`MeetLobby` with Tailwind (vite + `@tailwindcss/vite`) and screenshotted 1720x1300, 1200x800, 820x1100 and 390x780: no page scroll, the self view never overlaps the bar, menus stay on screen. Both used a fake `GuestSignalingClient`, so the real `/push` path (guest cookie, ACL grant) was not exercised there - that is covered by the existing backend push tests.

**Not done / known**:
- Not tested on a real phone or on Safari/Firefox (only Edge, headless, fake devices). The path uses only standard `RTCPeerConnection` APIs, but `addTransceiver` + `replaceTrack(null -> track)` is the part to look at first if a specific browser misbehaves.
- Full mesh, so N participants each upload N-1 copies of their video (`getUserMedia` asks for an ideal 1280x720). Fine for the 4-6 this design targets; lowering the ideal size or capping the sender bitrate is the lever if uplinks are a problem.
- The "participant with zero tracks negotiates no media" limitation in the Phase 2 entry above is fixed by this change.
- Speaker (output device) selection isn't offered - only the microphone and camera pickers were asked for.
- Session-based name prefill is still not implemented (see Phase 2).

## 2026-09-24: Fix - nobody could join once deployed: the server refuses a `from` that isn't the authenticated uid

Right after the entry above was deployed to mail.powerlevel.gg, two devices on one meeting URL each sat alone. Reproduced from Node against the live server (two guests via `GET .../join/:token`, `wss://<host>/push` with the guest JWT as the `jwt` cookie, `POST /push/:meetingUid` with a bearer token): every message from the page came back **400 `api-003`, "A published message's own 'from' field must match the authenticated ..."** - the restapi fix the round-3 review note above called for (`MailPushRoute.send()` binds `from` to the caller's uid) is now live. I had made `from` `<uid>~<random>` (see "Same account, two devices" above), so every hello/offer/candidate was dropped and nobody ever saw anyone. Unit tests could not catch it: `GuestSignalingClient` is faked there, and the backend push tests don't publish signaling messages from `apps/`.

**Fix**: `from` is again exactly the authenticated uid. The per-tab identity moved to a separate `peer` field (`<uid>~<random>`, `CallView`'s `newPeerId()`, passed to the manager as `peerId`). `MeshConnectionManager.handleMessage()` normalizes at the boundary - the sender is `peer ?? from` and everything downstream (roster, `isOfferer`, `to`, presenter) is keyed by peer id - and drops a message whose `peer` is neither `from` nor `from~...`, so the server's anti-impersonation binding still holds (a participant can only name their own tabs). Verified against the live server afterwards: `from` = exact uid with `peer` and `state` fields is accepted (204) and delivered to every subscriber intact.

**Lesson**: anything that changes what `apps/` publishes to `/push` must be checked against the real server's `POST /push/:id` validation, not just the fakes. The Node recipe above (about 40 lines, no browser needed) is the quick way; run it after any change to the signaling wire format.

## 2026-09-24: TURN URL setting takes several addresses (for the server chart's TURN over TLS)

The server's Helm chart now bundles coturn (see the `server` repo's NOTES.md, 2026-09-24) and can turn on TURN over TLS, which means handing the plugin a `turn:` address (UDP/TCP 3478) and a `turns:` address (TLS 5349) for one server with one credential. `mail:videoconf:turn:url` took a single string, so:

- `parseTurnUrls()` (`util/IceServerUtils.ts`, exported from the package root - `test/plugin.test.ts` pins that list) splits the setting on commas and whitespace; `buildIceServers()` makes one `RTCIceServer` with `urls: string[]` when there are several and keeps `urls: string` for one, so existing single-address deployments see no change. `IceServerConfig.urls` (and the front end's mirror in `apps/meet/_meetApi.ts`) became `string | string[]`, which is what `RTCIceServer` accepts. The credential is shared by all the URLs (the shared-secret credential is minted once per join, as before). The manifest's help text for the setting says so.
- **Compatibility, the reason this is a separate opt-in in the chart:** an older plugin given `turn:a:3478,turns:a:5349` passes it to the browser as one URL; `new RTCPeerConnection({ iceServers: [{ urls: "turn:a:3478,turns:a:5349" }] })` throws a `SyntaxError`, so *no* call would connect. The chart's `coturn.tls.enabled` is therefore off by default and documents plugin >= 0.4.0 (the first release that carries this).
- Tests: `test/util/IceServerUtils.test.ts` (several URLs with a shared secret and with a static credential, and `parseTurnUrls` on commas, whitespace, blanks). `yarn lint`, `tsc --noEmit` (root and `-p tsconfig.apps.json`) clean; 516 tests, 100% statement/function/line, 97.75% branch. Not tested against a real TURN server.

### 2026-09-25 - release bump levels follow upstream

When releasing packages that depend on each other (rapidmx: restapi / react-shared -> web-client -> meet-plugin, booking-plugin, autodiscover, mapi, activesync, server; rapidrest: core / service-core -> auth / auth-server / react / cli and the projects built on them), the bump level of a downstream release matches the level of the upstream release it picks up: an upstream **minor** is a downstream **minor**, an upstream patch a downstream patch, major to major. Where a downstream bump crosses several upstream releases, use the highest level among them, and never choose "patch" just because the downstream's own diff is only a `package.json` bump. Betas keep their prerelease line but follow the same idea - say which level was chosen.

Why: meet-plugin 0.4.2 and booking-plugin 0.5.2 were cut as patches after web-client 0.15.x -> 0.16.0 and react-shared 0.17.0 -> 0.18.0 (both minors), and autodiscover 1.1.1 after restapi 0.20.1 -> 0.21.0; the downstream versions then hid additive behaviour. JP accepted those releases as they were (2026-09-25) and asked for the rule going forward. Releases only happen when JP asks for them.

## 2026-09-26: Three media paths - direct, TURN, then the server relay over a WebSocket (and why TURN did not help firewalled clients)

JP's TURN server (coturn, installed by the `server` chart) was up and configured in the plugin, yet participants behind a firewall still could not connect. Investigated on the live host (`ssh mail.powerlevel.gg`, read-only apart from one test allocation), then added the tiered fallback JP asked for. `yarn lint`, `tsc --noEmit` (root and `-p tsconfig.apps.json`) clean; 840 tests pass, 100% statement/function/line, 98.52% branch (the ~21 uncovered branches are all in `GuestSignalingClient.ts`, untouched here). `test/plugin.test.ts` "declares a valid plugin manifest" fails on JP's own uncommitted `displayName: "Meet"` edit in `package.json` (the test pins "Video Conferencing") - left for JP, not touched.

**Why coturn did not work for those clients (nothing was wrong with coturn itself):**
- coturn 4.18 runs as a `hostNetwork` pod (`--external-ip`, relay ports 49152-49252, `--static-auth-secret`, `--no-tls`, `--no-tcp-relay`), ufw opens 3478 tcp+udp, 5349 and the relay range. A real allocation with `turnutils_uclient` (REST credential minted from the same secret) succeeded over UDP and over TCP, 0% loss, and the pod's own log shows real clients allocating today (auth is fine; the "peer IP denied" errors are just private-range ICE candidates hitting `--denied-peer-ip`, harmless).
- The plugin handed browsers `turn:mail.powerlevel.gg:3478`. A browser given a `turn:` URL with no `?transport=` speaks **UDP only**, which is exactly what a restrictive firewall drops while still letting TCP out. **TLS is off** (`--no-tls`, no cert), so nothing listens on 5349 even though ufw opens it, and those networks generally only pass 443, which the host's nginx `stream` block owns (SNI-forwards to the cluster ingress at 10.43.100.250).
- On top of that the mesh **silently dropped** a participant whose connection went `failed` (`handleBye()`), so it just looked like they never joined.
- Not done (infrastructure, JP's call): TURNS on 443 would need the nginx stream block to route by SNI/ALPN to coturn, plus enabling `coturn.tls` in the chart.

**Changes:**
- `withTcpFallback()` (`util/IceServerUtils.ts`, exported): every plain `turn:` URL also gets its `?transport=tcp` twin. `turns:` and any URL with an explicit `transport=` are left as given. A single `turn:` URL is therefore now `urls: string[]` (the browser accepts both). Manifest help text updated.
- **`MeshConnectionManager` tiers each pair**: `p2p` -> `turn` -> `websocket`, reported as `MeshParticipant.transport` (`connecting | p2p | turn | websocket | failed`). ICE already ranks a direct pair over a relayed one, so tiers 1-2 are one `RTCPeerConnection`; `connectionType()` (new on `RTCPeerConnectionLike`, `selectedConnectionType()` in `realPeerConnection.ts`) reads the selected candidate pair to say which won. A pair falls back to the WebSocket relay on `failed`, `disconnected` for `DEFAULT_DISCONNECTED_GRACE_MS` (8 s), or still `connecting` after `DEFAULT_CONNECT_TIMEOUT_MS` (15 s - ICE can take ~30 s to report `failed` when TURN is unreachable). It sends a new `relay-fallback` signal so both sides switch even if only one noticed; nothing is renegotiated and a pair never moves back up. Without a relay (disabled by the operator, or a browser without WebCodecs) the pair is marked `failed` and **stays in the roster** with a "Can't connect" badge instead of vanishing. `ParticipantTile` shows a badge for `turn`/`websocket`/`failed`. `RelayTransportLike` (in `types.ts`) is the seam the mesh depends on.
- **Server relay** (`src/util/RelayHub.ts`, `BaseVideoMeetingRoute.relay()`): `@Auth(["jwt"]) @WebSocket("/relay/:id")` -> `/api/mail/video-meetings/relay/<meetingUid>`. Needs READ **and** CREATE on the meeting (the grant `join()` already gives), with trusted roles stripped (plain `hasPermission()` would let any admin in; `MailPushRoute` strips them too), on a meeting that is not cancelled/ended. Protocol: text `hello {v:1, peer}` (peer must be the uid or `<uid>~...`), server `ready`, text `want {peers}` chooses whose media to receive, binary frames are fanned out to sockets that want the sender as `[1 byte N][N bytes server-stamped sender peer][payload]`. Limits (exported constants): 16 sockets/room, 4/uid/room, 16 KiB/message, 512 KiB/s with 1 MiB burst (closed after 10 s continuously over budget), hello within 10 s. Config `mail:videoconf:relay:enabled` (default true; manifest boolean setting); `join()` returns `relayEnabled`. **Gotchas found**: (1) the framework's uWS router does not fill `@Param` for WebSocket routes (only Bun's does) - `relay()` also reads the last path segment; (2) `app.ws(path, mw, undefined, ...)` gives no way to raise uWS's default **16 KiB max message** or 64 KiB backpressure, so the client fragments to <= 12 KB and tolerates drops; (3) the test helper `requestws` is text-only, so the route tests use Node's global `WebSocket` with `?auth_token=`.
- **Client relay** (`apps/shared/relay/`, facade `createRelayTransport()`): WebCodecs Opus 48 kHz mono (~24 kbps) and VP8 (<= 480x360, ~15 fps, ~350 kbps, key frame every 30 frames); frames carry a 10-byte fragment header (kind, key flag, seq, fragment index/count, u32 timestamp). Capture: `AudioContext` + `ScriptProcessorNode`, hidden `<video>` drawn to a canvas. Playback: decoded audio scheduled into a `MediaStreamDestination` with ~80 ms jitter buffer; decoded video drawn on a canvas whose `captureStream(15)` is the peer's stream, so `_CallView` needs no change beyond passing `relayEnabled`. Receivers drop delta frames until a key frame and after any gap or decode error. Reconnects with backoff.

**Verified in a real browser** (throwaway harness, not committed, same approach as the 2026-09-24 entry): the real `RelayTransport` bundled with esbuild into headless Edge (`--use-fake-device-for-media-stream`), two transports in one page talking through a Node `ws` server running the **real `RelayHub`**: the receiver got a 480x360 stream, 120 decoded frames in 8 s, 763 distinct colours (not blank), and non-silent decoded audio. So Opus/VP8 WebCodecs encode+decode, fragmentation and the wire protocol work end to end in Chromium.

**Not done / known:**
- Not tested on Firefox/Safari/phones, nor through the real server (uWS + nginx stream + ingress) - only the hub via `ws`, and the route via the test server. Concerns: Firefox refuses a `MediaStreamAudioSourceNode` when the mic's sample rate differs from the (forced 48 kHz) context, so a 44.1 kHz mic would relay no audio; `supported` only checks that the WebCodecs globals exist, not `isConfigSupported()`, so a browser lacking Opus/VP8 (Safari) reports supported but that kind stays silent; a detached `<video>` may not decode on iOS; a background tab throttles the 15 fps timer.
- The relay is **in-process**: with more than one server replica, participants on different replicas cannot relay to each other (`RelayBus` is the seam for a Redis-backed one). A meeting cancelled after a socket is attached does not evict it. The ICE credential/1 h TTL limitation noted 2026-09-23 still stands.
- The relay is a last resort by design: a participant on it uploads their encoded stream once, and the server fans it out per receiver that wants it.

### 2026-09-26 - the relay crosses server replicas over Redis (`RedisRelayBus`)

`RelayHub`'s `RelayBus` seam now has a Redis implementation, `src/util/RedisRelayBus.ts` (exported). `BaseVideoMeetingRoute.initRelayBus()` (`@Init`) builds it when `datastores:events` is configured (the Redis the push system uses) and swaps a hub on it in; without it, or if the bus cannot be created, the route keeps the in-process hub and logs a one-time warning (`destroyRelayBus()`, `@Destroy`, closes it). Design and why:
- The `redis` client comes from `importRedis()` and `attachRedisErrorHandler()`, both public exports of `@rapidrest/service-core` (a peer dependency already; `redis` is service-core's own optional peer), exactly as `BasePushRoute` obtains its clients. The plugin never imports `redis` itself, so nothing new is listed in `package.json` and a deployment without redis still loads it. (`@rapidmx/restapi`'s `BasePluginRoute` imports `redis` statically; we deliberately do not.) The vitest config inlines service-core, so `vi.mock("redis")` reaches `importRedis()`.
- Two clients per process (a publisher created with `disableOfflineQueue`, one shared subscriber), a channel per room (`videoconf:relay:<roomId>`), SUBSCRIBE on a room's first local listener and UNSUBSCRIBE on its last, buffer mode. Message: `[16 bytes origin bus id][1 byte N][N bytes sender peer][frame]`. Local delivery is synchronous and never goes through Redis; a bus ignores its own origin id.
- Redis failures never reach the hub: publishing is skipped while the publisher is not ready (no memory piling up in an outage), failed commands are counted and logged at warn at most every 30 s. node-redis re-subscribes by itself on reconnect (`resubscribe()` in `#initiateSocket`); verified against a real Redis 7.0.15 restart. Bandwidth: every frame is published once and read by every replica holding sockets of that room, wanted or not. The hub's socket caps stay per replica (room capacity is up to `replicas x cap`).
- Tests use `test/util/fakeRedis.ts` (shared by two buses = two replicas). `connect()` returns without waiting for Redis; `close()` uses `destroy()` (v6's `disconnect()` is deprecated; `close()` would wait on pending commands while Redis is down).
- Gotcha: run vitest from PowerShell, not Git Bash - under the Bash tool every jsdom test file fails with "Vitest failed to find the current suite" / "Invalid Chai property toBeInTheDocument" (environment, not code), and the `sql` route suite fails too.
- Still stale, not mine to edit: the manifest help text of `mail:videoconf:relay:enabled` in `package.json` and a line of `RELEASE_NOTES.md` still say relay only works between participants on the same replica.

## 2026-09-26 (later): TLS for coturn by default, "connecting" status, a bigger relay message limit, and the relay across replicas

Four follow-ups to the entry above. `yarn lint`, `tsc --noEmit` (root and `-p tsconfig.apps.json`) clean; 924 tests pass (one skipped only because the run excluded the `displayName` test - see above), 100% statement/function/line, 98.52% branch. Run vitest from PowerShell: under the Bash tool jsdom test files can fail to load.

- **coturn TLS is now the chart's default** - done in the `server` repo (see its NOTES). The chart already supported `turns:`; `coturn.tls.enabled` just defaulted to false. TLS is on when the chart can issue or is given a certificate for `coturn.hostname` (the live host has `mail.powerlevel.gg-tls-cert`, valid to 2026-12-24) and degrades to plain TURN otherwise, so the plugin URL never advertises a `turns:` address that is not served. Needs a chart release and a `helm upgrade` on the host (not done - nothing on the host was changed). Honest limit: 5349 helps networks that allow outbound 5349, not ones that only allow 443 (host nginx owns it); the WebSocket relay is what covers those.
- **"Connecting..." / "Awaiting connection..."**: `ParticipantTile` takes a `status` (spinner + text, a polite live region - not `role="status"`, which the call view's announcement region already is). A remote tile shows "Awaiting connection…" while its pair's `transport` is `connecting`. The local tile shows "Connecting…" while signaling is still opening (`signalingReady`), or while someone else is in the call and every connection to them is still `connecting` - i.e. the local participant has no working link yet - and never once any one is up, so a participant already in the call is not told they are connecting each time a newcomer arrives. Not shown once signaling failed (the error banner says why).
- **The framework's 16 KiB WebSocket limit is fixed in `@rapidrest/service-core`** (its repo, uncommitted, planned 2.4.0): `@WebSocket(path?, options?)` takes `{ maxPayloadLength, maxBackpressure, idleTimeout }` (bounds and behaviour in that repo's NOTES; uWS `idleTimeout` may only be 0 or 8-960 - anything else terminates the process at registration; an oversized message drops the connection with no close frame under uWS, 1006 to a client, 1009 only under Bun). The same work fixed `@Param` being `undefined` on uWS WebSocket routes, so `relay()`'s path fallback is now belt and braces. The relay route asks for 64 KiB messages and a 1 MiB send buffer (`RELAY_LARGE_PAYLOAD_BYTES`, `RELAY_WS_MAX_BACKPRESSURE_BYTES`) **only when the installed service-core exports `MAX_WEBSOCKET_PAYLOAD_LENGTH`** (`WS_ROUTE_OPTIONS_SUPPORTED`), otherwise it keeps 16 KiB - so an older service-core never has the hub advertise a limit the framework does not enforce. The server's `ready` reply now carries `maxMessageBytes`; the client (`RelayClient.maxMessageBytes`, `fragmentPayloadSize()`) sizes fragments from it (12000 by default and on an older server, up to 60000), so a key frame is usually one message. The 1 MiB send buffer stops a briefly slow receiver dropping frames (the old 64 KiB was less than a key frame's headroom).
  - **Release order matters**: publish service-core 2.4.0 first, then raise this package's `peerDependencies["@rapidrest/service-core"]` to `>=2.4.0 <3` and its `devDependencies` to `^2.4.0` (types come from the new version: with 2.3.0's types `WebSocket(path, options)` does not compile). Until then this working tree was tested against a local build of service-core overlaid into `node_modules/@rapidrest/service-core/dist` (original dist backed up in this session's scratch directory; `yarn install` restores it). Nothing in `package.json`/`yarn.lock` was changed for it.
- **The relay now crosses replicas** (`RedisRelayBus`, see the entry just above this one for its design; verified against a real Redis 7.0.15 in WSL, including a Redis restart). That entry's closing line "still stale ... manifest help text ..." is fixed: the manifest help text and release notes now describe the Redis behaviour.
- Verified again in headless Edge with the real `RelayHub` at the 64 KiB limit and the new client: 480x360 video, 121 decoded frames in 8 s, non-silent audio; and through a real uWS server with the new options in the route suites (a 60 KiB message is relayed on both backends). Not verified: a real deployment (uWS behind nginx stream + ingress), Firefox/Safari/phones, the real coturn over TLS.

## 2026-09-27: video filters, and remembered devices/settings

Asked for: background blur, a custom background (a file from the user's machine), black and white, some fun ones (sunglasses, a cat on your head), and remembering devices/settings - filters included - between calls. Decisions taken with JP: ML assets load from a CDN at runtime (with an admin override for self-hosting), and a starter set of fun filters ships now.

- **Model**: `VideoFilters = { background: none|blur|image, effect: none|bw|sepia|night-vision|pixelate, accessory: none|sunglasses|cat-ears|party-hat|crown|mustache }` (`apps/shared/media/filters/filterTypes.ts`). Three independent layers, so they combine; adding one is an id + label there and an implementation in `VideoFilterProcessor.ts` (effect) or `accessories.ts` (accessory).
- **Pipeline** (`VideoFilterProcessor.ts`): camera track -> hidden `<video>` -> canvas (background, then colour effect over everything, then accessory) -> `canvas.captureStream()`. `useLocalMedia()` owns one while any filter is on and returns *its* track as `videoTrack`/`videoStream`, so the lobby preview, `MeshConnectionManager.setLocalTrack()` (replaceTrack) and the WebSocket relay's `VideoSender` need no changes. `cameraOn`/`selectedDeviceIds` still come from the raw camera track.
- **Fails closed**: with a background filter on, until the segmentation mask exists the frame is the background alone (blurred whole frame, or the picture), never the raw room; if the model can't load it stays that way and `filterStatus.error` says so. If the processor can't be built at all (no canvas 2D / `captureStream`) `videoTrack` is `null` while filters are on. Accessories just don't appear without the face model.
- **ML** (`mlModels.ts`, `@mediapipe/tasks-vision`, dynamic `import()`): ImageSegmenter with `selfie_segmenter.tflite` (its one label is "selfie"; the mask is person confidence - verified: a person-less frame gives an all-zero mask) and FaceLandmarker (`face_landmarker.task`, 1 face; landmarks 33/263 outer eyes, 10 forehead, 1 nose tip, 0 upper lip). GPU delegate with CPU fallback. Loaded once and shared; a failed load is forgotten so a later filter click retries (`update()` retries). Default URLs: wasm from `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@<MEDIAPIPE_VERSION>/wasm`, models from `storage.googleapis.com/mediapipe-models/...`. `MEDIAPIPE_VERSION` must equal the installed package version (a test checks). Admin override: `mail:videoconf:effects:assets_url` -> `join()` returns `effectsAssetsUrl` (validated by `parseEffectsAssetsUrl()`: absolute http(s) or a root-relative path) -> `useLocalMedia({ effectsAssetsUrl })`; layout under it: `wasm/`, `selfie_segmenter.tflite`, `face_landmarker.task`.
- **Drawing**: colour effects are per-pixel loops (`pixelEffects.ts`), not `ctx.filter` (Safari lacks it); blur is a 1/12 downscale drawn back up; accessories are vector paths in the face's own frame (origin on a landmark, x along the eye line, 1 unit = outer-eye distance), so no image assets ship. The frame loop is a `setTimeout`, not `requestAnimationFrame` (which stops in a hidden tab and would freeze the call for everyone else).
- **Custom background** (`backgroundImage.ts`): a picked file is read with `FileReader`, downscaled to <= 1280 px on the long edge and re-encoded as a JPEG data URL (transparency flattened onto white); never uploaded. Files over 20 MB or non-images are refused with a message.
- **Remembered settings** (`mediaPreferences.ts`, `localStorage` key `rapidmx.meet.preferences`, the background image under `rapidmx.meet.background` so a quota failure there doesn't lose the rest): camera/microphone id (saved only when explicitly picked - otherwise the default keeps following the OS), mic/camera on-off, filters. Read lazily (`ensurePrefs()` in `useLocalMedia`, the first time anything acquires media - never during render, for SSR/hydration). A saved device is requested as `{ deviceId: { ideal } }`, so an unplugged one falls back to the default instead of failing; an explicit pick is still `exact`. A saved "camera off" makes `requestAccess()` ask for audio only and start with the camera off. All storage access is guarded; validation drops anything unrecognised. `test/apps/setup.ts` now clears `localStorage` after each test, since jsdom keeps it for the whole file.
- **UI**: `apps/meet/_EffectsPanel.tsx` (shared, `tone` light for the lobby / dark for the call), an "Effects" toggle in the lobby, a sparkle button + dialog in `CallControls` (highlighted while a filter is on).

**Verified in a real browser** (throwaway Vite harness driven over the DevTools protocol in headless Edge with `--use-fake-device-for-media-stream`, not committed): the real `VideoFilterProcessor` on a live camera with the real MediaPipe WASM and both models served through the `assetsUrl` mechanism - every effect and combination renders, both models load on the GPU delegate, no errors; the accessories drawn onto synthetic faces at 0 and 17 degrees of tilt look right.

**Not done / known:**
- **Not tried on a real face**: the fake camera has no person, so the person mask and the accessories' placement on a real face (they anchor on landmark 10, the forehead top, so the hat/ears/crown may sit a little high or low on some faces) were only checked with synthetic data. Not tried on Firefox/Safari/phones. Filtering costs CPU (two models at 30 fps on the main thread); a hidden tab's timers are throttled by the browser, so a filtered picture can drop to a low frame rate there (a Worker-driven timer would fix it).
- The self view is mirrored with CSS, so a custom background *picture* looks flipped to the person themselves (everyone else sees it correctly).
- No speaker (output device) picker exists in the plugin, so there is no speaker choice to remember.

## 2026-09-27: `@rapidmx/react-shared` merged away - every import moved to `@rapidmx/web-client/lib/*`

`@rapidmx/react-shared` is being folded into `@rapidmx/web-client` (a parallel effort in those two repos, not this
one): react-shared's entire `src/` tree (same internal layout - `admin/`, `appearance/`, `auth/`, `branding/`,
`calendar/`, `components/`, `contacts/`, `crypto/`, `mail/`, `search/`, `tasks/`, `util/`, `videoconf/`) moves
unchanged into a new `lib/` directory inside web-client, exported at `./lib/*.js`. This plugin depended on both
packages and imported directly from `@rapidmx/react-shared/...` in several `apps/` pages, so it needed the same
mechanical update every other react-shared consumer in this project needs.

- **Every `@rapidmx/react-shared/<subpath>.js` import became `@rapidmx/web-client/lib/<subpath>.js`**, one-for-one,
  across `apps/meet/{index,_layout,_MeetChrome,_MeetLobby,[token]}.tsx`, `apps/meet/_meetApi.ts`,
  `apps/settings-video-conferencing/{index,_layout,_PersonalRoomCard}.tsx`, `apps/shared/push/GuestSignalingClient.ts`,
  `apps/shared/relay/RelayTransport.ts`, the doc comment in `apps/shared/webrtc/MeshConnectionManager.ts`, the three
  test files that imported types/mocked that module (`test/apps/settings-video-conferencing/{index,_PersonalRoomCard}.test.tsx`,
  `test/apps/shared/relay/RelayTransport.test.ts`), `vitest.config.ts`'s dedupe/`ssr.noExternal` lists, and `README.md`'s
  dev-setup paragraph. `@rapidmx/web-client`'s own pre-existing export paths (e.g.
  `@rapidmx/web-client/shared/components/settings/layout/SettingsShell.js`, already used in
  `apps/settings-video-conferencing/index.tsx`) are untouched - only the react-shared-derived subpaths move under `lib/`.
- **`package.json`**: removed `@rapidmx/react-shared` from `peerDependencies`, `devDependencies` and `resolutions`.
  Left every `@rapidmx/web-client` version constraint exactly as declared (`peerDependencies: ">=0.17.0 <1"`,
  `devDependencies: "^0.21.0"`, `resolutions: "^0.17.0"`) - not bumped, per this repo's convention that JP sets
  version numbers/ranges himself. Ran `yarn install` to refresh `yarn.lock`; `@rapidmx/react-shared` still appears
  there as a transitive dependency of the currently-published `@rapidmx/web-client@0.17.0`/`0.21.0` (that published
  version still depends on it) - expected until web-client itself publishes a release that no longer needs it.
- **`test/plugin.test.ts`**: the "declares a react-shared peer floor high enough for every
  `@rapidmx/react-shared/videoconf/*` import" regression test (added because a peer floor below the react-shared
  version that first shipped `videoMeetingsApi.js` would silently ship a broken install) no longer has a package of
  its own to check a floor against. Split it in two: a still-passing structural check that
  `@rapidmx/web-client/lib/videoconf/` is still imported somewhere under `apps/`, and an `it.todo(...)` placeholder
  for the numeric floor assertion, since the web-client release that will first actually carry the merged
  `lib/videoconf/videoMeetingsApi.js` module isn't known yet (the web-client-side half of this merge was still in
  progress when this was written) - a guessed semver floor here would just be wrong later. Also dropped
  `"@rapidmx/react-shared"` from the `pins every 'resolutions' entry to exactly its own 'peerDependencies' floor` test's
  package list.
- **Verification**: `yarn lint` - clean except two pre-existing-shape `no-unnecessary-type-assertion` errors in
  `_PersonalRoomCard.tsx`/`index.tsx` on `room.publicJoinUrl!`/`meeting.publicJoinUrl!`, caused by `VideoMeetingDetail`
  resolving to `any` (see next point) rather than by anything wrong with the assertions themselves.
  `tsc -p tsconfig.json --noEmit` (the backend, `src/`) is clean - nothing under `src/` ever imported react-shared.
  `tsc -p tsconfig.apps.json --noEmit` and `yarn test` **fail**, and are expected to until the web-client side of this
  merge ships: the installed `@rapidmx/web-client` (0.21.0, from npm - `D:\github\rapidmx\web-client\lib\` does not
  exist locally either, confirming the other repo's migration hadn't landed yet) has no `lib/` export at all, so every
  new `@rapidmx/web-client/lib/*` import fails to resolve (`TS2307` under `tsc`, `Failed to resolve import`/`Cannot
  find package` under Vitest's Vite transform). 9 of 54 test files fail this way; the other 45 files (1155 tests, plus
  the new `it.todo`) pass. This is not a bug introduced here - it is exactly the expected race the task anticipated;
  once web-client publishes (or this repo's local checkout gets) a version with `lib/videoconf/videoMeetingsApi.js`
  etc., re-run `yarn install` / `tsc -p tsconfig.apps.json --noEmit` / `yarn test` to confirm green, and then decide
  whether `peerDependencies`/`devDependencies`/`resolutions`' `@rapidmx/web-client` floor needs raising to that release
  (see the `it.todo` above - fill in its real floor at the same time).
- Not touched: `CHANGELOG.md`/`RELEASE_NOTES.md` (generated by `yarn release` from commit messages, not hand-edited -
  see this repo's other NOTES entries and the top-level convention), and no `version` field was bumped.

## 2026-09-28: fixed the mirrored custom background; found (but didn't touch) a likely cause of choppy relay audio

Two things JP reported from a real call.

- **Custom background image showing backwards to the participant who chose it.** The local self-view (lobby preview,
  in-call self tile) is mirrored with a CSS `scaleX(-1)` - always local-only, so remote participants were never
  affected. But that mirror flips the *whole* composited frame, background included, and a picture someone chose
  (unlike a live, roughly-symmetric camera feed) visibly reads backwards to no one but themselves. Fix: `mirrored`
  is now a prop of `_ParticipantTile.tsx` (default `true`, unchanged everywhere else), and `_CallView.tsx`/
  `_MeetLobby.tsx` pass `mirrored={filters.background !== "image"}` for the local view. Verified in headless Edge
  (a real `MeetLobby`/`useLocalMedia`, a canvas with legible text as the chosen background) and with new tests in
  all three touched files' suites.
- **`VideoFilterProcessor` was asking both ML models every rendered frame** (up to 30/sec), each a synchronous,
  main-thread call that can run tens of milliseconds - long enough to make the WebSocket relay's audio
  (`AudioSender`/`AudioPlayer`, `ScriptProcessorNode`, main-thread by spec, which is exactly why it's deprecated)
  miss its buffer deadline and glitch. Now only 1 rendered frame in 3 (`ML_HOLD_TICKS`) actually calls a model; the
  rest reuse the last mask/landmarks - imperceptible, since neither changes much frame to frame. Frame-counted, not
  wall-clock, so it doesn't depend on `now()` (the existing test harness's fake clock is static by default) or on
  the configured frame rate. Updated the existing 70 `VideoFilterProcessor` tests for the new pacing (exact tick
  counts around `FACE_HOLD_FRAMES`/mask-resize moved out to the next real attempt) - all still 100%/100%/100%/100%.
- **This alone doesn't explain the report**: JP confirmed the choppy audio also happens with no filters on at all.
  Reading `AudioSender.ts`/`AudioPlayer.ts`/`frames.ts` (all pre-existing, from the original relay work, `8e6379e`)
  turned up three more places the relay already drops audio by design under backpressure - none related to video
  filters at all: the encoder falling behind (`AUDIO_MAX_ENCODE_QUEUE`), the decoder falling behind
  (`AUDIO_MAX_DECODE_QUEUE`), and playback already too far ahead of the clock (`MAX_AHEAD_SECONDS`) - plus
  `frames.ts`'s own doc comment says the relay *server* drops messages under its own backpressure too. Any of these
  tripping under ordinary jitter (not just main-thread contention) would sound exactly like "choppy, like packet
  loss." Did not change any of these: they read as deliberate, already-considered trade-offs (each has a comment
  explaining why), and guessing at new thresholds with no way to reproduce or measure the actual failure risks
  making a carefully tuned system worse. Asked JP which tier (the tile's badge - "Server relay", "Relayed", or
  none) the affected participants show; not yet known. **Next step, when it recurs**: check that badge first - if
  it's a direct or TURN connection, the relay code above isn't even in the path and the cause is native
  WebRTC/ICE/network, not this plugin's code at all.

### 2026-09-28 - Always wait for CI to go green before releasing

Standing process rule, applies to every rapidmx/rapidrest repo: push pending commits, wait for the GitHub Actions **Build** workflow on that push to report `success` (`https://api.github.com/repos/<org>/<repo>/actions/runs`, or ask JP for the downloaded log archive if API log access needs auth - it 403s without a token), and only then run `npx @rapidrest/cli release ...`. Do not tag/release first and diagnose CI failures afterward. During a 2026-09-28 multi-repo release wave, restapi was released immediately after pushing pending commits without waiting for CI; CI then failed on a real coverage-threshold regression the pending changes introduced (a missing test for `BasePluginRoute.newestSearchResult()`'s catch branch) - not a flake, as an incomplete local-only reproduction first suggested. Because the release commit/tag were already pushed, the fix had to land as a follow-up commit on top of an already-tagged release instead of before it.

## 2026-09-30: guests behind a restrictive firewall could never actually connect

JP's report: a guest saw a 403 in devtools on `POST /push/<meeting-uid>` and never connected; a second device (not a
guest) sat on "Awaiting connection..." then showed no audio/video. Narrowed down with JP: single server instance (no
multi-replica ACL cache race possible), and reliably reproducible - every guest behind a restrictive/corporate
firewall fails, while guests on an unrestricted network (two phones on cellular data, tested against each other)
always connect fine.

Traced `POST /push/:id`'s 403 to `BasePushRoute.send()` (`@rapidrest/service-core`): `ACLAction.CREATE` failing
`hasPermission()`. This plugin's own grant (`ensureChannelGrant()`, `mintGuestToken()`) looks correct by inspection
and is the same mechanism a passing integration test already covers - not an obvious code bug, and not something a
network conditional could plausibly change server-side (the same grant is minted the same way regardless of the
guest's own network). `GuestSignalingClient.send()` is what POSTs there (`hello`/offer/answer/ICE/`bye`), and it's
fire-and-forget - a dropped POST is a signaling message that silently never arrives, which is exactly "connecting
forever, no media" from the other side.

What's different about a restrictive network: `send()` set `keepalive: true` unconditionally on every POST, not only
the `bye` sent from `pagehide` (the one case that actually needs to survive the page unloading - the comment already
said so, the code just didn't match it). A `keepalive` fetch tells the browser this request may outlive the page -
the same signal `navigator.sendBeacon()`/an `unload` handler's own fetch give off - and a restrictive network's
inspecting proxy singling that out (extra scrutiny, or dropping it outright) well short of the browser's own 64
KiB/several-MB keepalive quota is a known, plausible failure mode; an unrestricted network (cellular, no corporate
proxy) would never trip it. Fixed: `keepalive` is now `message.kind === "bye"` - every other send (the ones that
matter for actually connecting) no longer carries that signal at all.

Not proven with certainty (no access to a reproduction behind such a firewall, and the deployed server's exact code
wasn't directly inspectable from here) - it's the most plausible, lowest-risk, zero-downside explanation that fits
every symptom and the code's own stated intent, not a confirmed root cause. If it recurs after this ships, the next
most useful thing to grab is the 403 response's actual body/headers (ours vs. a middlebox's own block page would
look very different) - that would either confirm this fix or redirect the investigation toward the server's own ACL
check instead.

## 2026-09-30 (later): the real cause - send() never attached the CSRF header

The `keepalive` theory above was wrong. JP shipped it as 0.9.1, captured a HAR from a still-failing device, and the
403's actual response body (never captured before - this is the piece that was missing) was:

    {"code":"api-105","status":403,"level":"debug","message":"This request is missing a valid CSRF token."}

Not `AUTH_PERMISSION_FAILURE` (an ACL check) at all - `AUTH_CSRF_FAILURE`, thrown by `@rapidrest/service-core`'s
`RouteUtils.checkCsrf()`/`verifyCsrfRequest()` (`src/http/csrf/csrf.ts`) before the route handler, let alone its own
ACL check, ever runs. And the captured request wasn't a guest at all: real `jwt`/`refresh` cookies for a genuine
PowerLevel account, no `Authorization` header - the *authenticated* path (`VideoMeetingJoinResult.authenticated:
true`), confirming `req.auth?.source === "cookie"`, which is exactly the one case `verifyCsrfRequest()` enforces (a
bearer-authenticated request - the guest path - is exempt entirely, per its own doc comment).

The mechanism: this server's `jwt`-cookie auth ships a double-submit `csrf` cookie (readable, non-`HttpOnly` by
design) that a mutating request must echo back as `x-csrf-token`. `@rapidmx/web-client`'s `apiFetch()` already does
this for every other endpoint via `withCsrfHeader()` - `GuestSignalingClient.send()` builds its own `fetch()` instead
(needs to conditionally choose bearer vs. cookie auth, which `apiFetch()` doesn't support) and never called it. Every
`hello`/offer/answer/ICE candidate/`bye` sent while relying on the cookie 403'd, silently (`send()` is
fire-and-forget) - exactly "stuck connecting, then no audio or video" from everyone else's side.

Why this reads as "guests behind a firewall fail, guests on open networks don't" is still a guess, but a much better
one now: it was never about the network at all. A phone that has never opened mail.powerlevel.gg holds no `jwt`
cookie, so `join()` mints it a real guest token (bearer, CSRF-exempt) - always works. A corporate/managed device
already signed into the org's webmail in that browser gets `authenticated: true` instead (no guest token at all,
see `join()`'s doc comment) - cookie path, needs the CSRF header, 403's on every send without this fix. "Behind a
firewall" and "already has a company mail session in that browser" correlate for an obvious reason (the same
managed devices) without either one being what actually matters.

Fixed: `send()` now calls `withCsrfHeader()` (`@rapidmx/web-client/lib/util/api.js`, same package
`GuestSignalingClient.ts` already imports `apiOrigin()`/`pushUrl()` from) on every send, bearer or cookie - harmless
on the bearer branch since the server only enforces the check for `req.auth.source === "cookie"`.

The `keepalive` fix (immediately above) stays: it's still correct on its own terms (matches the code's stated
intent, zero downside) and no longer claims to be the reason anything connects - this entry supersedes that claim,
not the change itself.

## 2026-10-01: name which device is missing, and fade in after an audio discontinuity

Two more things JP reported once connections were working.

- **"No camera or microphone was found" showed even when only one was actually missing.** `classifyMediaError()`
  (`deviceMedia.ts`) always used that one combined message for `NotFoundError`/`OverconstrainedError`, regardless
  of what was actually being asked for. It now takes the failed call's own constraints and picks one of "No
  microphone was found", "No camera was found", or the combined phrasing, via a new exported `notFoundError()`
  helper. Fixed a real (if invisible until now, since every message read the same) bug on the way: `useLocalMedia`'s
  `acquireBoth()` falls back to `acquire("audio")` then `acquire("video")` when the combined request fails, and each
  independently called `setError()` - so if only the microphone was missing, the camera's later *success* silently
  cleared that error, and if both were missing, whichever ran second (the camera) was the only one ever shown.
  `acquire()` now returns the classified error (or `null`) instead of a bare boolean, and `acquireBoth()` combines
  both outcomes into the one message that's actually true (`combineErrors()`) rather than letting either call's own
  `setError()` decide alone.
- **Occasional audio "blipping" from other participants**, recorded and sent over. Extracted and analyzed the
  recording (no numpy/matplotlib in this environment - pure-Python `wave`/`array`: a 5ms high-passed envelope,
  autocorrelation of it out to 2s, and a strict single-sample-discontinuity scan). No periodic component at any
  lag (rules out anything clock-driven, e.g. the ML throttling or a fixed frame rate), no clean silence gaps, and no
  large single-sample splices - so if this is the same artifact, it's subtle, not a hard dropout or a clock-periodic
  bug in this plugin's own code. It fits the relay's own already-known lossy points (`AudioSender`/`AudioPlayer`
  dropping blocks under backpressure - see the CSRF entry above) in a way I hadn't considered: the decoder is one
  long-lived instance reused across packets *specifically so Opus's own predictive state carries over between them*
  (its own doc comment already said so) - so a packet it was never told was lost leaves that state out of sync with
  what it decodes next, which can click right at that seam, not just leave silence where the loss was. Rather than
  touch the drop thresholds themselves (still no way to measure whether retuning them would actually help, and they
  read as deliberate - see the CSRF entry), gave `AudioPlayer.play()` a short (4 ms) linear fade-in through a
  `GainNode`, applied only to a block that doesn't pick up exactly where the last one left off - the first block, or
  the one after a gap - which is exactly where a decoder-state mismatch (or, for the very first block, nothing
  having played yet at all) would be audible. An ordinary contiguous block gets no fade at all, since fading every
  single packet boundary would itself be audible (a faint tremolo at the packet rate). `GainLike.gain` in
  `relayEnv.ts` gained `setValueAtTime()`/`linearRampToValueAtTime()` (a real `GainNode`'s `AudioParam` already has
  them - this is a type-level change only, `AudioSender`'s own static `gain.gain.value = 0` mute is unaffected).

  This is a standard, well-established technique for exactly this class of artifact (any concatenative,
  block-based audio playback), and directly targets the reported symptom regardless of what's actually causing the
  seam mismatch - but it's not a confirmed fix for this specific complaint, since I can't fully verify "blipping"
  from a static analysis of one recording without being able to listen to it. If it recurs, the next useful thing
  is confirming whether it still happens on a **direct** (non-relay) connection - if so, this fade (relay-only)
  isn't it, and the search moves to the native WebRTC audio path instead, which this plugin's own code has no
  influence over.

## 2026-10-01 (later): tell a TCP-relayed TURN connection apart from a UDP one

JP reported a phone and a remote PC, both over the coturn relay, both hearing "significant gaps... didn't seem
like packet loss, more like high latency." For a TURN-relayed connection this plugin's own code has no role at
all in audio encode/decode/jitter - that's entirely the browser's native WebRTC engine (unlike the WebSocket
relay tier, where `AudioSender`/`AudioPlayer` are this plugin's own code and were the earlier fixes' target) - so
there is no equivalent JS-level fix available here.

What the symptom does match precisely: TCP-relayed TURN (`?transport=tcp`, or `turns:` - TLS is TCP-based too).
UDP just drops a lost packet (a click); TCP retransmits it and, being ordered, blocks everything queued behind it
until that arrives - a stall, not a glitch. `withTcpFallback()` (`IceServerUtils.ts`) already offers both
transports so a network that blocks UDP outright can still reach the TURN server at all - necessary (the
alternative is not connecting), but it means a participant on such a network gets exactly this degraded
experience, silently.

Added the one thing that IS this plugin's own code: telling the two apart and surfacing it, so a "Relayed (TCP)"
badge (vs. the existing plain "Relayed") distinguishes this specific case going forward, rather than both reading
identically. `selectedConnectionType()` (`realPeerConnection.ts`) now reads the selected local candidate's own
`relayProtocol` (`RTCIceCandidateStats`, standard and already available via `getStats()`) when it's a relay
candidate - `"tcp"`/`"tls"` reports the new `turn-tcp` `MediaTransport`, `"udp"` (or unreported) stays plain
`turn`. Only the *local* candidate's protocol is visible this way - a relay on the remote end alone (no
visibility into how *they* reached their own TURN allocation) still reads as plain `turn`, same as before.

Not a fix for the latency itself - there isn't one available at this layer - but real, scoped, tested, and it
turns "can you fix it?" into something actionable: if the badge shows `turn-tcp` for a participant, the actual
next step is checking the coturn deployment's UDP reachability (firewall/security group rules, whether its UDP
listener is actually up) - infrastructure, not this repo.

## 2026-10-01 (Phase A1 of the 7-item batch): presenter screen rotate/flip

First of seven requested features (see the approved plan for the full batch and its two-phase split - additive UI
first, host-authority features after). This one doubles as the fix for the earlier "screen sharing a window
displays upside down, locally and for everyone" report, confirmed back then to be the browser's own window-capture
bug (upside down in the presenter's own raw local preview, before any of this app's code ever touched it) - there
was nothing to patch in this app at the time, only a manual correction to offer.

New `apps/shared/media/filters/ScreenTransform.ts`: `ScreenTransformProcessor`, the exact shape
`VideoFilterProcessor.ts` already established for the camera pipeline (a hidden `<video>` playing the source
track, a canvas redrawn on a timer, `captureStream()` exposing the result) but far simpler - no models, no
per-frame throttling, just `ctx.translate`/`rotate`/`scale` applied once per draw, chosen so the *corrected* track
is what's actually sent (not a local CSS transform), matching "upside down for everyone" needing a fix everyone
sees the benefit of. A 90/270 rotation swaps the canvas's own width/height to fit; 180 and a flip don't. Entirely
independent of the camera/filter pipeline - `_CallView.tsx` owns it the same way `useLocalMedia` owns the camera's
filter processor: constructed when `screenStream` is set (wrapping the raw `getDisplayMedia()` track), torn down
when sharing stops (transform resets to identity for the next share - it's a correction for *this* capture, not a
sticky preference). If this browser can't give it a canvas context, falls back to sharing the raw capture
untransformed rather than not sharing at all.

`_CallControls.tsx`: two new buttons (rotate, flip) next to Share Screen, visible only while presenting - direct
click actions, no dropdown, since there's nothing to browse (only two controls, both toggles/cycles).

Verified with `npx vitest run` (100%/98.72%/100%/100%, this repo's enforced floor is 95% branches / 100% the
rest) - the fake-canvas-and-video harness pattern from `VideoFilterProcessor.test.ts`, simplified for this much
smaller class. One genuinely hard-to-reach branch (a `stop()`-then-still-ticks defensive guard, protecting against
a real but fake-timer-unreproducible race - the engine can already have queued a timer callback before
`clearTimeout()` reaches it) is exercised by calling the private `tick()` directly rather than contorted through
the public API, since unlike `VideoFilterProcessor`'s equivalent guard (reachable via its `onStatus` callback) this
simpler class has no re-entrant callback of its own.

## 2026-09-30 (Phase A2 of the 7-item batch): built-in diagnostics panel

Second of seven. Everything a participant needs to self-diagnose a bad call, entirely local - nothing here is
sent anywhere, it only reads what the browser and the existing mesh already know.

Backend/manager plumbing (done first, landed clean on its own before this UI layer): `collectDiagnostics()`
(`realPeerConnection.ts`) walks the same `getStats()` report set `selectedConnectionType()` already parses,
extracting the selected candidate-pair's `currentRoundTripTime` plus each media kind's `inbound-rtp`/`outbound-rtp`
`packetsLost`/`jitter`/`bytesSent`/`bytesReceived`. `MeshConnectionManager` polls this every few seconds
(`DEFAULT_DIAGNOSTICS_POLL_MS`, 3s) per connected peer once its transport is known, attaching the result to
`MeshParticipant.diagnostics` and re-emitting `participant-updated` - stops polling on bye/fallback/manager
shutdown, same lifecycle as the existing per-peer timers. Deliberately never polled for a `"websocket"`-relayed
participant (there is no `RTCPeerConnection` to ask), and `diagnostics` stays `undefined` until the first poll
completes - the UI shows "Not available" rather than a blank space for either case, so it never looks like the
panel forgot to load.

New `_DiagnosticsPanel.tsx`: this browser's own capability flags (WebRTC/screen-sharing/WebCodecs - the last
gating whether the WebSocket relay fallback tier is even possible on this browser), what the local participant is
currently sending, then each other participant's connection - the identical transport badge label/title
`_ParticipantTile.tsx` already shows (now exported as `TRANSPORT_BADGES`, so the two surfaces never describe the
same path in different words), plus RTT/loss/jitter/bytes once polled. Opened from a new button in
`_CallControls.tsx`'s row (`DiagnosticsIcon`, extends the `OpenMenu` union, same dialog/outside-click pattern the
effects panel already uses) - `participants`/`selfName` are threaded down from `CallView`'s own state, which
already had both.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.62%/100%/100% (1351 tests, this repo's enforced floor is 95% branches / 100% the rest).

## 2026-09-30 (Phase A3 of the 7-item batch): participants drawer

Third and last of Phase A (the additive, no-new-authority half of the batch - see .claude/NOTES.md's Phase A2
entry for the full seven-item context). Display-only, as the plan called for: mute/kick controls arrive later
once Phase B gives the client a "host" identity to gate them on, added to these same rows rather than a new list.

The header's participant-count chip (`_CallView.tsx`) is now a button toggling `drawerOpen`; new
`_ParticipantsDrawer.tsx` renders a right-side sliding panel over a click-through backdrop, listing "you" first
(from `media.micOn`/`handRaised`, both already in `CallView`'s own state) then everyone else
(`participants: MeshParticipant[]`, likewise already there) - one row each, reusing the exact
mic-muted/hand-raised/transport-badge treatment `_ParticipantTile.tsx` already established (the same
`TRANSPORT_BADGES` export Phase A2's diagnostics panel also reuses, so a connection's badge reads identically in
all three places: tile, diagnostics, drawer). Closes on Escape, a click on the backdrop, or its own close button -
never on a click inside the drawer, the same outside-click convention `_CallControls.tsx`'s own menus use.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.63%/100%/100% (1356 tests). This closes Phase A - screen rotate/flip, diagnostics, and the
participants drawer are all in; Phase B (host identity, mute/kick, force-mute-on-join, password, waiting room)
is next, per the approved plan's sequencing.

## 2026-09-30 (Phase B1 of the 7-item batch): host identity, mute-request/kicked signals, kick() enforcement

First of Phase B (the host-authority half of the batch - see the Phase A2 entry above for the full seven-item
context and the plan's own reasoning for why this client protocol had no "host" identity at all going in). Shared
plumbing only - the mute/kick buttons that actually call this are Phase B2.

**`hostUid`**: the simplest correct source of "who is the host" turned out to be `Mailbox.ownerUserUid` - the
mailbox's own owning account, a plain field, not an ACL computation (an ACL can list several people with full
rights; a mailbox has exactly one `ownerUserUid`). `BaseVideoMeetingRoute.join()` now resolves it alongside
`hostDisplayName` (one `mailboxRepo.findOne()` for both, via the new combined `hostInfo()` - was two separate
lookups' worth of plumbing for one record read) and returns it on `PublicVideoMeeting.hostUid`, omitted when the
mailbox no longer exists. `_CallView.tsx` compares it against `selfUid` for `isHost`, and against the
`<accountUid>~` prefix of a participant's own tab-scoped `uid` for `isParticipantHost` - purely client-side, same
trust level `presenter-claim` already has (flagged in the plan as a known limit, not silently promised away). The
participants drawer now tags the host's row "Host" - informational only in this phase, same as everyone else's row
shape; the buttons that read `isHost` to decide who *sees* them arrive in B2.

**`mute-request`/`kicked`**: two new point-to-point `SignalMessage` kinds, `MeshConnectionManager.sendMuteRequest()`/
`sendKick()` to send them and `mute-requested`/`kicked` `MeshEvent`s on receipt - the exact same point-to-point
`to: <peer id>` shape `offer`/`answer`/`relay-fallback` already use, so `handleMessage()`'s existing `to` filter
covers them with no new logic there. `_CallView.tsx` reacts: a `mute-requested` mutes (never unmutes - if already
muted, nothing happens) via a `mediaRef` added for this purpose (the mesh-event effect runs once at mount, so
without it `media.toggleMic`/`micOn` would be frozen at mount-time's values); a `kicked` calls the now-widened
`onLeave(reason?: string)` with a fixed message, which `[token].tsx` shows on a distinct "Removed from the
meeting" screen instead of the ordinary "You left the meeting" one - and hides "Rejoin meeting" there, since a
kicked participant's server-side grant was just revoked and a rejoin attempt (which reuses the already-fetched
`joinResult` rather than calling `join()` again) would only fail anyway.

**Found and fixed in passing**: `_CallControls.tsx`'s leave button was `onClick={onLeave}`, so a click's own
`SyntheticEvent` was passed as `onLeave`'s first argument - harmless while `onLeave` took no parameters, but now
that it takes an optional `reason: string`, the event object itself was about to render as `{endedReason}`'s text
("Objects are not valid as a React child" - caught immediately by the existing `[token].test.tsx` leave tests).
Fixed to `onClick={() => onLeave()}`; the test suite's own mock `CallView`'s "Leave (test)" button had the exact
same bug, fixed the same way.

**Enforcement**: `kicked` alone is cooperative, like every signal here - nothing stops a client from ignoring it.
New `BaseVideoMeetingRoute.revokeChannelGrant()` is the real teeth: the mirror image of `ensureChannelGrant()`
(same optimistic-lock retry, filters the uid's record out instead of adding one), wired to a new host-only
`POST /:id/kick/:uid` (`requireOwnedMeeting(id, user, ACLAction.UPDATE)`, matching `update()`'s own authorization) -
a kicked uid can no longer subscribe to or publish on the meeting's `/push` channel at all, regardless of whether
their client cooperates. Verified end-to-end against the real ACL store (the existing `connectPush()` harness in
both route test files' "push channel access" suite - a joined guest's channel grant works, then is gone after
`kick()`), plus the usual owner/stranger/admin-403 authorization-boundary tests and `revokeChannelGrant()`'s own
retry/give-up/non-conflict-rethrow races (mirroring `ensureChannelGrant()`'s existing race tests, mongo-only, same
as that method's own tests - the retry logic is backend-agnostic).

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.6%/100%/100% (1389 tests). Next: B2 (the mute/kick buttons in the participants drawer, now that
`isHost`/`sendMuteRequest`/`sendKick` all exist to wire up), then B3-B5 (force-mute-on-join, password, waiting room).

## 2026-09-30 (Phase B2 of the 7-item batch): host mute/kick buttons in the participants drawer

Second half of host moderation, wiring up everything B1 built. `_ParticipantsDrawer.tsx`'s rows now get a "Mute"
button (hidden once that participant is already muted - there's no "unmute someone else" action to offer) and a
"Remove" button, both only on another participant's row and only while `isSelfHost` - never on the host's own row,
never shown to anyone else. "Remove" confirms first (a plain `window.confirm()` - this plugin has no reusable
confirm-dialog component yet, and one call site didn't justify building one) since it can't be undone by the
participant the way a mute request can.

Needed one piece `_CallView.tsx` didn't have: the participant's *real* account uid. `MeshParticipant.uid` is the
tab-scoped peer id (`<account uid>~<random>`, see `newPeerId()`), but `kick()`'s route and the ACL it revokes are
keyed by the plain account uid - sending the peer id to `kick()` would silently no-op (`revokeChannelGrant()`
treats "no matching record" as success, not an error, so this would have failed silently rather than loudly). New
`accountUidOf()` strips the suffix, relying on the same invariant `handleMessage()`'s own `raw.peer.startsWith(
`${raw.from}~`)` check already assumes: neither a real account uid nor a minted guest uid can itself contain "~".
`handleKickParticipant()` fires the cooperative `sendKick()` signal immediately (so a cooperating client leaves
without waiting on the network) and `kickParticipant()` (new `_meetApi.ts` call, `POST .../kick/:uid`) alongside
it - its failure is swallowed, not surfaced, since the host already asked the participant to leave and there's no
useful recovery action to offer from here.

**Found and documented, not fixed - a real gap, not a nitpick**: `kick()` only revokes the *grant* a participant
currently holds, not their standing to get another one. A removed guest who simply reloads the same join link is
minted a fresh guest uid and re-granted by `join()` exactly like any first-time joiner; a removed real caller who
still holds mailbox READ is re-granted their own uid back the same way. So "Remove" ends a participant's *current*
connection, but is not a ban - the UI's confirm text was written to not imply otherwise, and `kick()`'s own doc
comment on the backend spells out why (an actual ban needs new state tracking who was removed, consulted by
`join()`/`ensureChannelGrant()` - a larger feature, out of scope here). `_CallView.test.tsx`'s own "Rejoin meeting"
screen for a kicked participant is hidden for the same reason it's honest to hide it (the same tab's one-click
retry is pointless), not because reloading the link itself is blocked.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.61%/100%/100% (1398 tests). This closes Phase B's mute/kick pair; B3 (force-mute-on-join) is next,
then B4 (password to join) and B5 (waiting room), per the approved plan's sequencing.

## 2026-09-30 (Phase B3 of the 7-item batch): force-mute-on-join

`VideoMeeting.forceMuteOnJoin?: boolean` - the standard 5-file field pattern this codebase already has a dozen
precedents for (`types.ts`, both `VideoMeetingMongo`/`VideoMeetingSQL` + their constructor's `"x" in other` copy
line), settable both at `create()` time and via `update()` (new to this route: every prior field `update()` could
change was already settable at creation, but a brand-new meeting has no participants to retroactively affect, so
there was no reason this one couldn't be create()-time too). `join()` returns it on `PublicVideoMeeting`, omitted
(not sent as a literal `false`) when unset - the same "absent reads as off" convention `relayEnabled` already
established, so an older client/server pairing degrades safely either direction.

**Client-side, this is deliberately a one-time starting condition, not a standing restriction**: `useLocalMedia()`
gained a `forceMuteOnJoin` option, consulted only inside `ensurePrefs()` (the lazy, once-per-mount read of the
remembered mic/camera/filters preferences) - when set, it forces `micEnabled` to `false` for *this* call alongside
whatever was remembered, but critically never calls `remember()` with it, so a participant's own cross-meeting
preference is untouched; nothing stops them unmuting the instant they join, same as every other mute in this app.
`[token].tsx` threads `joinResult.meeting.forceMuteOnJoin` into both `useLocalMedia()` (so the lobby preview and
the call both start muted together) and `CallView`'s new `initialForceMuteOnJoin` prop (the host toggle's starting
value - see below).

**Host toggle**: a checkbox in the participants drawer's header, host-only (reuses `isSelfHost` from B1/B2),
labeled "Mute new participants on join" to be explicit that it's forward-looking - muting someone already in the
call is what each row's own B2 "Mute" button is for, a semantically different action this toggle deliberately
doesn't also perform. Applied optimistically (`handleToggleForceMuteOnJoin()`) and reverted if the
`PUT /video-meetings/:id` save fails, so the drawer never keeps showing a setting that didn't actually persist -
unlike kick's "fire and forget, nothing useful to recover" posture, a setting toggle has an obvious, cheap
correctness fix available (flip it back), so this one takes it.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.62%/100%/100% (1419 tests). B4 (password to join) is next, then B5 (waiting room).

## 2026-09-30 (Phase B4 of the 7-item batch): password to join

**Hashing**: nothing in this codebase's own dependency tree (`@rapidrest/*`/`@rapidmx/*`) hashes a credential for
later verification anywhere - checked before building anything, rather than guessing. New `util/PasswordUtils.ts`
uses Node's built-in `crypto.scrypt` directly (the same "built-in `crypto`, no new dependency" choice
`TokenUtils.ts` already made for this plugin's other secrets, rather than adding bcrypt/argon2 for one call site),
storing `<salt>:<derived key>` both base64url in the one `VideoMeeting.passwordHash` column.

**The real design question was the shape of the gate, not the hash.** `GET /join/:token` already does several
different things depending on how a token resolved (organizer slug vs. invitee token vs. public slug); adding
"and also maybe a password" needed its own branch, not a bolt-on check. Settled on: `join()` now returns a
discriminated union (`VideoMeetingJoinResponse` = `VideoMeetingJoinResult | VideoMeetingPasswordRequiredResult`) -
a protected meeting resolved via anything but `organizerSlug` gets back only `{ meeting, requiresPassword: true }`,
with `publicMeeting` computed (so the prompt can still show the title/host) but *no* ICE servers, no minted guest,
no ACL grant at all - the password gate withholds the actual join, not just a confirmation screen in front of one
already granted. A new `POST /join/:token/verify` (rate-limited like `join()` itself, the one endpoint a brute-force
guesser would actually hit) checks the password and then runs the exact same grant logic. Extracted that shared
logic out of the old monolithic `join()` into `buildPublicMeeting()` (the projection), `requireOrganizerAuth()`
(the organizer-slug-only authority check, now shared since either endpoint could be hit first for that link), and
`completeJoin()` (the actual grant) - `join()` and `verifyPassword()` are now both thin callers of the same three
pieces, rather than near-duplicates.

**The organizer's own slug bypasses the password entirely, on purpose**: holding it already proves stronger,
account-ownership-based authority than any password could add (see `VideoMeeting.organizerSlug`'s own doc comment
from Phase 1) - a host should never be able to lock themselves out of their own meeting by setting a password on
it. `requireOrganizerAuth()` passing is sufficient on its own; the password check is skipped, not merely satisfied.

**Never leak the hash, anywhere, to anyone - not even the owner.** `create()`/`update()`/`find()`/`findById()` all
return the raw persisted entity today; added `withoutPasswordHash()` and applied it to all four, plus the new
`hasPassword: boolean` (never the hash) added to `PublicVideoMeeting` as the one thing a client - including the
host's own UI - is ever told about it.

**Frontend**: `[token].tsx` gains a `"password"` phase between `loading` and `lobby`, shown whenever `joinMeeting()`
reports `requiresPassword` - a bare title/host + password form, calling the new `verifyMeetingPassword()`; a 403
shows "Incorrect password," anything else a generic retry message, same posture as every other error screen this
page already has. The host's side lives in the participants drawer: a new `PasswordSection` (local input/error/busy
state, so `_CallView.tsx` only needs to track whether a password currently exists) with Set/Change and, once one
exists, Remove - calling the new `setMeetingPassword()`. Unlike the force-mute toggle (B3), this is NOT applied
optimistically: a half-typed password sitting in a toggled-on checkbox has no equivalent, and clearing the input
only on confirmed success is itself the right feedback.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.67%/100%/100% (1472 tests). B5 (waiting room) is the last of the seven.

## 2026-09-30 (Phase B5 of the 7-item batch): waiting room

**State lives in memory, per route instance, not a new model.** A `VideoMeetingAdmission` table would mean another
migration-equivalent round trip for data nobody needs once the meeting ends - this plugin already has exactly this
trade-off for `RelayHub`'s in-process relay state (a restart drops it, accepted). `BaseVideoMeetingRoute` gained
`private pendingAdmissions: Map<meetingUid, Map<uid, { name, requestedAt, status: "pending"|"admitted"|"denied" }>>`,
written by `registerPendingAdmission()`, read by the new `GET /join/:token/status` poll and the host's
`GET /:id/waiting` list.

**Waiting room and password share one gate, but waiting room wins when a meeting has both.** `join()` (the GET)
checks `waitingRoomEnabled` before `passwordHash` - a protected-and-gated meeting goes straight to
`requiresAdmission: true` rather than a password step first, because the admission-request form (`verifyPassword()`,
despite the name, now does double duty) collects the name *and* the password together in one POST, then files the
pending admission only after the password check passes. Two separate sequential prompts for the same meeting would
mean a guest fills in a password just to land on a second screen - collapsing it to one form is both less friction
and one fewer place a guess-the-password brute force could probe.

**Bug caught by the refactor, not before it**: the first pass had `pollAdmission()`'s admitted branch call the
existing `completeJoin()`, same as the organizer/direct-join paths. That's wrong for a guest - `completeJoin()`
decides real-vs-guest by checking `authenticated`, and for a non-authenticated caller it *mints a new guest uid*
unconditionally. A guest who filed a pending admission already has a uid (from `requestAdmission()`'s own mint,
returned as the token the client polls with); routing them back through `completeJoin()` on admission would hand
them a second, different uid with no pending record of its own, failing the ACL grant silently. Fixed by splitting
`completeJoin()` into `grantJoin(meeting, publicMeeting, selfUid, authenticated)` - the actual grant for an already-
settled identity - and having `completeJoin()` be the only caller that ever mints a guest, deciding real-vs-guest
once and then calling `grantJoin()`. `pollAdmission()` calls `grantJoin()` directly with the uid already on file.

**Host side**: the participants drawer gained a "waiting room" section (host-only, same `isSelfHost` gate as every
other B-phase control) listing pending names with Admit/Deny buttons, backed by `GET /:id/waiting` and new
`POST /:id/admit/:uid` / `POST /:id/deny/:uid` routes (both `requireOwnedMeeting(id, user, ACLAction.UPDATE)`, same
authority as every other host mutation this phase added). `_CallView.tsx` polls `listWaitingParticipants()` every
3s, but only while `isHost && drawerOpen` - no reason to poll a list nobody's looking at, same reasoning as every
other polling loop in this app being gated on visibility.

**Guest side**: `[token].tsx` gained `"admission-request"` (name + password, if the meeting also has one) and
`"waiting"` phases between `password` and `lobby`, polling `GET /join/:token/status` every 3s with the guest's own
JWT once minted (`Authorization: jwt <token>`, sent only when present - the organizer/authenticated path never
needs it). A `403` from the poll means denied: shown as its own `"denied"` phase with the server's message, not a
silent fallback to `not-found`, since "the host said no" and "this link doesn't exist" are different situations
worth telling a guest apart.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.54%/100%/100% (1553 tests). This closes all seven items from the approved plan
(A1-A3 additive UI, B1-B5 host identity and moderation) - no further phases remain unless new work is raised.

## 2026-09-30 (new request, outside the seven-item plan): talking-stick mode

JP asked for a "talking stick" - the host activates it from the navbar, holds it themselves at first (everyone
else muted), raises-hand signals who wants it, and the host hands it to one participant at a time (that
participant unmuted, everyone else - host included - muted).

**No backend route, no `VideoMeeting` field, at all.** Checked the precedent before building anything: this is
much closer in shape to `mute-request`/`kicked`/presenter-claim (an ephemeral, in-call runtime state that resets
every time the call ends, nothing downstream needs to know before or outside the call) than to
`forceMuteOnJoin`/`waitingRoomEnabled`/password (meeting-level settings that persist and gate joining). Built it
as a pure peer-to-peer signal: a new `SignalMessage` kind `"talking-stick"` (broadcast, `active`/`holder`),
`MeshConnectionManager.setTalkingStick()`/`"talking-stick-changed"`, all in `apps/shared/webrtc/`. No new test
files needed in `test/routes/` or `test/models/` as a result - the whole feature lives in the frontend.

**No collision to resolve, unlike presenter.** `presenter-claim` needs `MeshConnectionManager` to remember the
current presenter and resolve a race deterministically, because *any* participant may claim it. Talking stick is
host-exclusive by convention (same trust level as `mute-request`/`kicked` - nothing on the wire checks the sender
actually is the host), so there is only ever one legitimate sender at a time; the manager carries no state of its
own at all and just relays the latest message as `talking-stick-changed`, applying it to the sender's own tab
immediately via a local emit (same "optimistic, no round trip" shape `claimPresenter()` uses).

**Enforcement is a real disabled control, not just a nudge - a first for this codebase.** Every prior "mute
someone" mechanism here (`mute-request`, `forceMuteOnJoin`) is explicitly one-shot and non-binding: call
`toggleMic()` once, and nothing stops the participant calling it right back. Talking stick needed to actually hold
(“everyone else must be silent”), so `_CallView.tsx` now derives `micLocked` (`talkingStickActive &&
!selfHasTalkingStick`) and passes it to `CallControls`, which disables the microphone button itself (with a title
explaining why) for as long as it applies - paired with an effect that force-toggles the mic to match whenever a
tab's own holder status changes (unmuting a newly chosen speaker automatically, muting everyone else, including
the host). Still cooperative at the signaling layer, same as everything else in `MeshConnectionManager`'s doc
comment on host moderation - a non-standard client could ignore the lock entirely - but the first-party UI no
longer merely suggests silence, it withholds the control.

**A holder who leaves gets no special handling, on purpose.** Unlike presenter (which clears `presenterUid` and
emits an event when the presenter's `bye` arrives, because a dangling screen-share tile would be visibly wrong),
"the stick's holder is no longer in the call" doesn't need the manager to say anything: every other participant's
existing `participant-left` handling already drops the departed uid from the roster, and nobody's own identity
comparison (`holder === myPeerId`) needs to know whether `holder` is still around to correctly stay silent. The
header's status chip reads this the same way ("Waiting for the host to choose a speaker" once the name lookup
finds nobody) - no extra code, no auto-reassignment, the host just has to notice and pick someone (possibly
themselves) again. Flagged as a known limitation rather than solved: if the *host's own* tab is the one that
leaves while the mode is on, nobody has standing to fix it, the same shape as this plugin's other host-only
controls having no fallback for the host disappearing.

**UI**: a host-only navbar toggle button next to the participant-count chip ("Talking stick" / "End talking
stick"), a status chip visible to everyone naming the current holder, and a "Give stick" button on every row of
the participants drawer (including the host's own, so the host can reclaim it) - host-only, hidden on whichever
row already holds it, with a 🎙️ badge on that row visible to every viewer, not just the host.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.57%/100%/100% (1570 tests).

## 2026-09-30 (follow-up polish, same day): participants drawer as a docked sidebar, diagnostics as a top-left overlay

Two small UX requests after trying the call in a real browser.

**Participants drawer no longer dims/covers the call.** It was an absolutely-positioned overlay with a `bg-black/40`
backdrop (click-outside-to-close, like `_CallControls.tsx`'s menus) - JP wanted it stay visible alongside the call
instead, not cover it. Restructured `_CallView.tsx`'s own top-level layout: the call's header/tiles/controls (plus
the self-view tile, reactions and the sr-only announcement region, all previously positioned `absolute` against the
whole call) now live in their own `flex-1 min-w-0` column, with the outer container switched from `flex-col` to a
plain `flex` row. The drawer is that row's second child, an ordinary `shrink-0 w-72` sidebar - no backdrop, no
`absolute` positioning of its own - so opening it now shrinks the call column instead of covering any of it. Lost
"click the backdrop to close" as a direct consequence (there is no backdrop); Escape and the chip/close button
still close it. The self-view tile and reactions still render correctly confined to the shrunk call column, since
their own `absolute` positioning is relative to that column's new `relative` wrapper, not the page.

**Diagnostics panel moved to a `fixed` top-left overlay.** It was a dropdown anchored above its own button in the
bottom control bar (`_CallControls.tsx`, `absolute bottom-full right-0`) - moved to `fixed top-3 left-3`, reading
more like a HUD overlaid on the call than a menu tucked into the bottom bar. Deliberately kept as the exact same
panel and the same open/close button rather than redesigning its content (JP confirmed this over a condensed
always-on alternative) - round-trip time (ping/latency), jitter and packet loss per participant were already there,
just inside a panel shaped like a dropdown rather than an overlay. The outside-click/Escape handling still works
unchanged: it keys off DOM containment within the control bar (`barRef`), which `position: fixed` doesn't affect -
only the panel's own visual position moved, not where it sits in the tree.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.57%/100%/100% (1570 tests).

## 2026-09-30 (small follow-up, same day): talking-stick button gets a baton icon

The host's navbar toggle read "Talking stick"/"End talking stick" as plain text - swapped for a new `BatonIcon`
(`_icons.tsx`: a diagonal rounded bar with a grip-knob circle, hand-drawn rather than a Material path, since there
isn't one for this), matching every other control button's icon-only shape. Kept the exact same accessible name
(`aria-label`, not visible text now) so it's still announced the same way and every existing test that queries the
button by that name needed no changes; added a `title` for a hover tooltip, since there's no label text to glance
at anymore.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.57%/100%/100% (1570 tests).

## 2026-10-02 (reported bug): the WebSocket relay tier's "ton of lag" was two oversized backpressure budgets

JP reported the server relay (the third, last-resort media tier - see `MeshConnectionManager`'s doc comment) was
laggy enough to be "nearly unusable." Rather than guess, had a subagent read the whole pipeline end to end before
touching anything - the architecture itself is sound (raw binary frames, no JSON/base64 bloat, no server-side
batching, Redis correctly off the same-instance hot path, the video encoder already at `latencyMode: "realtime"`,
every encode/decode queue already bounded and drop-not-queue) - but two numbers were each sized almost 10x too
loose, and together they explain exactly "lag that keeps growing," not just brief jank:

- `RelayHub.RELAY_WS_MAX_BACKPRESSURE_BYTES` (the framework's own `maxBackpressure` for the relay route - how much a
  slow receiver's socket may buffer before the framework starts silently dropping sends) was `1024 * 1024` (1 MiB).
  Its own comment claimed "roughly two seconds of a 350 kbps video stream plus audio" - at the combined ~46.75 KB/s
  of `VideoSender.VIDEO_BITRATE` + `AudioSender.AUDIO_BITRATE`, 1 MiB is actually **≈22 seconds**, not two - a
  bits-vs-bytes mix-up in the original math. A receiver whose downlink briefly dipped below the stream's rate could
  fall minutes behind "now" before anything was ever dropped to catch back up, rather than the "briefly slow" case
  this budget is supposed to cover.
- `RelayClient.MAX_BUFFERED_BYTES` (the client's own send-side threshold, same idea in the other direction) was
  `256 * 1024` - **≈5.6 seconds** at the same combined rate, defeating its own doc comment's stated intent
  ("queueing would only add latency to the frames that are still fresh") on exactly the constrained uplink that
  routes a call to this fallback tier in the first place.

Both corrected to numbers actually sized against the real combined bitrate: server `128 * 1024` (≈2.7s - the
comment's original intent, done right, with margin above one key frame), client `64 * 1024` (≈1.4s, deliberately
tighter than the server's budget so the sender starts dropping its own stale frames before the server's larger
budget would have to). Neither constant can import the other's bitrate constants to stay in sync automatically
(`apps/` and `src/` are separate TS programs - see `_CallView.tsx`'s doc comment on why), so both now carry the
actual arithmetic in their doc comments as a cross-reference instead, so a future bitrate change has something
concrete to recompute against rather than a comment that can silently drift wrong again.

**Deliberately not changed, flagged rather than fixed**: `VideoSender.VIDEO_KEY_FRAME_INTERVAL` (a keyframe every
2 seconds) means a receiver who just subscribed, or who lost a fragment, can wait up to ~2s for a fresh keyframe -
there's no signal today for "a new receiver just started wanting you, send a keyframe now" (`canSend()` in
`senderCommon.ts` is purely "is the socket connected," not "does anyone want this stream"). Tempting as a quick
fix, shortening the interval directly trades bandwidth for recovery speed - more frequent (large) keyframes raises
the *average* bitrate, which would make the exact backpressure problem just fixed worse on exactly the constrained
networks this tier exists for. The correct fix is a small protocol addition (server notices a `want` naming a peer
that wasn't already wanted and tells that peer's own socket to force one), not a blind interval change - left as
follow-up work rather than risking a regression under this session's time budget.

Verified with the full suite: `npx eslint`, both `tsc --noEmit` runs, and `npx vitest run --coverage.reporter=text`
clean at 100%/98.57%/100%/100% (1570 tests, same count - only two constants and one test assertion changed).
