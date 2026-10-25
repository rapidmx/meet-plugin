# Meeting privacy: per-meeting keys

Status: design agreed 2026-10-24. This spec is normative for meet-plugin, booking-plugin, restapi and web-client.

## 1. Goal

What is said and shared in a meeting stays private from the server, whether its participants are RapidMX users or people outside it. That covers:

- Its title and the names of the people in it.
- Its chat, whiteboard, reactions and presence.
- The call setup (signaling).
- Relayed media.
- For a booking, everything the booker wrote.

The server routes and stores ciphertext only. The protection is temporary: once the meeting is over, the key is discarded and what the
server held for the participants is gone.

Zero-access encryption already seals the organizer's own calendar event (restapi `specs/search.md` §3). This spec covers what the plugins
hold and what crosses the wire during the meeting.

## 2. When it applies

A video meeting or booking is **protected** when its organizer (the host, for a booking) has a zero-access key. Every participant of a
protected meeting — RapidMX user or not — receives the meeting key in their link (§4.1). Zero-access keys are unlocked per browser tab,
so a key wrapped to a participant's own zero-access key couldn't be opened in the tab their link opens; the link key works anywhere.

| Situation | Behaviour |
| --- | --- |
| The organizer has a zero-access key | A meeting keypair is created (§3). Every invitee's link carries it; the organizer keeps a wrap of it (§4.2). |
| The organizer has no zero-access key | No protection: everything is stored and relayed as before. The editor says so (§9). |

## 3. Key material

- **Meeting keypair.**
  - A P-256 keypair, created in the browser of whoever creates the meeting: the organizer's client, or the booker's browser for a booking.
  - It comes with a self-signed X.509 certificate (`CN=meeting`, validity from creation until expiry), so the existing CMS code seals to
    it and opens with it unchanged.
  - The server stores only the certificate.
- **Live key.** Derived as `HKDF-SHA256(ikm = the private scalar d, 32 bytes; salt = UTF-8 of the meeting uid; info =
  "rapidmx-meeting-live-v1")`, giving 32 bytes used as an AES-256-GCM key.
- **Sealed fields.**
  - Stored data about the meeting is sealed field by field (`sealedFields[name]`: base64 CMS `EnvelopedData` of the field's JSON value),
    in the same format zero-access uses.
  - Each field is sealed to two recipients at once: the meeting certificate and the organizer's or host's zero-access certificate.
  - The readable column holds a placeholder: `"Meeting"` for a title, `null` for anything else.

## 4. Distribution

### 4.1 Participants: the link fragment

- **The link.** Each invitee's join link, and a booker's manage link, ends in `#k=<base64url of the PKCS#8 DER of the meeting private
  key>`.
  - Browsers never send the fragment in requests.
  - The page reads it once, keeps it in memory only, and removes it from the address bar (`history.replaceState`).
- **Mail.** The server composes and sends the invitation and confirmation mail, so it sees the fragment while sending. Under the rule zero-access
  follows everywhere, the server **may see it inside a request and MUST NOT store or log it**.
  - The organizer's client supplies it on each save that sends an invitation (§6.1). It is never part of a stored
    `CalendarEventAttendeeLink` URL, a `Booking` row or any log line.
  - `MeetingSchedulingJob` never sends an invitation for a keyed meeting, because only a save carries the fragments.
  - A keyed link goes to no copy this server would store readable: an address on another server, or a mailbox here whose mail is
    zero-access. A mailbox here without zero-access, or any other address on a domain this server serves (a list, an unknown
    address), is skipped with a warning, like a guest with no key (restapi `MeetingInviteSender`, `host.mayCarryMeetingKey`).

### 4.2 The organizer's wrap

- `VideoMeeting.keyWraps` holds the meeting private key sealed to the organizer's zero-access certificate: `{ mailboxUid,
  recipientFingerprint, kind: "meeting-key", cms }`, at most one per zero-access key the organizer holds.
- It lets any of the organizer's devices reopen the meeting: to invite again with the fragment, to join, or to read its sealed fields.
- The server returns it only to whoever may read the organizer's mailbox.

## 5. Live traffic

### 5.1 Signaling envelope (protocol version 2)

The hub only ever reads `to`, and stamps `from` and `peer`. A protected meeting's `signal` data is:

```
{ "to": "<peerId>"?, "e": "<base64url(iv[12] || ciphertext || tag[16])>" }
```

- **The plaintext** is the JSON `{ "from": uid, "peer": peerId, "n": counter, "t": <sender's clock, epoch ms>, "data": <the version 1 data> }`.
- **The AAD** is `"rapidmx-signal-v2|" + meetingUid`.
- **Receiving.** A receiver drops a message when it fails to decrypt, or when its inner `from`/`peer` differ from the stamped ones. It
  also drops one whose `n` is not above the last `n` it accepted from that peer. `n` starts at 1 per socket and resets with a new peer id.
- **Freshness.** A receiver also drops a message whose `t` is more than 5 minutes from its own clock. A receiver that has never heard
  from a peer id accepts any `n`, so without this the server could replay what it kept from an earlier session or occurrence of the
  series, under the same key, to someone who joins later. The window allows for a message held while the socket reconnects and for the
  difference between participants' clocks.
- **Moderation.** `mute-request`, `kicked` and `talking-stick` count only when their stamped `from` is the meeting's host account.
- **What it covers.** Offers, answers, ICE candidates, presence, display names, moderation requests, chat, whiteboard, cursors and
  reactions all travel inside `e`.
- **Why it matters.** Because the SDP is authenticated, the server can no longer swap DTLS fingerprints. Direct peer-to-peer media is
  therefore end to end.
- **No plaintext.** A protected meeting's client sends nothing in the clear and ignores any unencrypted `signal`.

### 5.2 Relay frames

- **Encryption** (frame version 2). Each encoded audio packet or video picture is encrypted before it is fragmented
  (`apps/shared/relay/frames.ts`):
  - `frame' = nonce[12] || AES-256-GCM(live key, nonce, frame, aad)`.
  - `aad = "rapidmx-frame-v2|" || kind u8 || keyFrame u8 (0/1) || seq u16 || timestampMs u32 || UTF-8 sender peer id`, big-endian, each
    field reduced to its wire width (seq modulo 2^16, timestamp modulo 2^32) so both ends bind what the receiver reads off the fragment
    header.
  - `nonce = senderSalt[4] || counter[8]`. `senderSalt` is random per sender session and `counter` increments per frame.
- **Header binding.** The receiver opens a reassembled frame under the kind, key-frame flag, seq and timestamp its fragments carried, and
  the sender peer the server stamped. A relay or peer that rewrites any of them makes the frame fail to open, and it is dropped. The
  fragment numbering (`fragIndex`, `fragCount`) is not bound: it only splits the sealed bytes, so reordering or re-splitting them changes
  the ciphertext and fails the tag. `FLAG_ENCRYPTED` is implied by the frame being opened at all.
- **Replay.** A receiver pins each sender peer's salt to the first frame that opens, and accepts a counter above the highest it has
  accepted from that peer, or one of the 128 below it once. Anything else is a replay and is dropped.
- **The flag.** Flag bit 1 (`FLAG_ENCRYPTED`) marks an encrypted frame. A protected meeting drops frames without it.
- **Requirement.** Encryption is required: a browser that can't run WebCrypto AES-GCM over the frames can't join a protected meeting.

## 6. Data

### 6.1 meet-plugin

| Field | Stored | Notes |
| --- | --- | --- |
| `VideoMeeting.title` | Placeholder `"Meeting"` | Real value in `sealedFields.title` |
| `VideoMeeting.meetingKey` | `{ certificate, fingerprint, expiresAt }` | No private key, ever |
| `VideoMeeting.keyWraps` | CMS to the organizer | §4.2 |
| `VideoMeetingInvitee.displayName` | `null` | Real value in the invitee's `sealedFields.displayName` |
| `VideoMeetingInvitee.email` | Readable | The server mails the invitation to it |
| Times, visibility, status, password hash, waiting room | Readable | The server enforces them |

- **Creating or updating** a protected meeting takes the certificate, the sealed fields and the wraps from the client. The server
  rejects a protected write that carries a readable title or name.
- **Moving the expiry.** `PUT /:id` takes `keyExpiresAt` for a protected meeting whose key is still held (in the future, at most five
  years ahead; 400 otherwise, 400 for an unprotected meeting, 410 once the key has expired or been discarded), so a moved event or a
  changed series keeps its meeting. A booking's minted meeting is moved the same way through `extendSingleInviteeMeetingKey()` when the
  booking is rescheduled.
- **The guest projection** (`GET /join/:token`) returns the sealed fields and `protected: true`.
- **Fragments at send time.** Every invitee link of a protected meeting is `keyed`. An invitation-sending calendar save carries the
  fragment per attendee in `invitationContent.meetingLinkSecrets: { [attendeeAddress]: "<fragment>" }`, and `MeetingInviteSender` appends
  each to that attendee's URL while composing. The fragments are never stored.

### 6.2 booking-plugin

A booking is protected while zero-access encryption covers the host's **calendar**: the calendar event is then sealed too, so nothing the
booker wrote is stored readable anywhere. The public booking type carries the host's zero-access certificate (`hostCertificate`), and the
server refuses an unprotected booking of such a host ("This booking page is out of date").

- **The booking page** makes the booking key (expiring an hour after the slot) and seals the booker's name, notes, phone and location
  instructions twice: to the host's certificate (`sealedFields`, kept) and to the booking key (`guestSealedFields`, the booker's copy). It
  wraps the key to the host (`keyWraps`) and, for a video booking, seals the meeting's title to both.
- **Stored readable:** the booker's email and time zone, the times and status. The booking's `bookerName` holds the booker's address, and
  the calendar event's attendee entry has no name.
- **Mail:** the book request carries the plaintext for the confirmation and the host's notification. Later requests carry it as
  `content` plus the `linkKey`: a reschedule or cancellation from the manage page (opened with the link's key), and a video-link change
  from the host's list (opened with the host's zero-access key, with the link key unwrapped from `keyWraps`).
- **Links:** the confirmation's manage link carries the key after `#`, and so does the video link of a meeting minted for the booking,
  which is protected with the same key.
- **The host's notification** in their Inbox carries what the booker wrote only when it is filed sealed (zero-access covering the host's
  mail). Otherwise it names the booker by address and says to open the booking in RapidMX.
- **Expiry:** `BookingKeyExpiryJob` removes the booker's copy, the certificate and the wrap at `keyExpiresAt`, and keeps the host's copy.

## 7. restapi

- **Fragments:** `MeetingInviteSender` accepts `meetingLinkSecrets` (§6.1), and `MeetingSchedulingJob` skips a REQUEST for an event
  whose linked meeting is protected.
- **Cancellations:** these carry no fragment, so the job still sends them.
- Zero-access certificates are still never given to anyone but their owner: the organizer wraps only to their own.

## 8. Expiry

- **When.**
  - `meetingKey.expiresAt` is the scheduled end plus `mail:videoconf:key_grace_minutes` (default 60).
  - A recurring series uses the end of its last occurrence. A series without an end keeps its key until the series is cancelled or
    given an end.
  - A meeting with no end time expires when its last participant leaves, or 24 hours after creation, whichever comes first.
  - A booking uses its slot's end plus the grace.
- **What goes.** At `expiresAt`, `MeetingKeyExpiryJob` deletes the certificate, the organizer's wrap, the sealed title and names, and
  the keyed attendee links of the meeting's own invitees (another meeting on the same event keeps its links), replaces the invitees' join
  tokens, removes the participants' `READ`/`CREATE` grants from the meeting's own ACL (the creator's record and other meetings' grants
  stay), and marks the meeting `keyDiscardedAt`. Cancelling a protected meeting does the same at once. For a booking, the job removes the
  sealed fields addressed to the meeting key and keeps the host's zero-access copy.
- **After expiry.**
  - Joining answers `410` ("This meeting has ended."), and the meeting's signaling and relay sockets are refused.
  - The guest page tells guests beforehand that access ends with the meeting.
  - A copy a guest saved while the meeting ran is outside the server's reach.

## 9. What stays readable, and why

- **Visible to the server:** who is invited (addresses), when, whether a password or waiting room applies, who is connected (uids and
  peer ids), and message and frame sizes and timing.
- **Why:** the server needs them to deliver invitations, admit people and route traffic.
- **Unprotected meetings:** a meeting whose organizer has no zero-access key is not protected. The editor says: "This meeting isn't
  end-to-end protected because zero-access encryption is off for your mailbox."
