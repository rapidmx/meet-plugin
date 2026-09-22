///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { buildIceServers, DEFAULT_STUN_SERVERS, DEFAULT_TURN_CREDENTIAL_TTL_SECONDS, turnRestCredential } from "../../src/util/IceServerUtils.js";

const EMPTY_TURN = { url: "", username: "", credential: "", sharedSecret: "" };

describe("turnRestCredential", () => {
    // Independently computed and cross-checked OUTSIDE this codebase (via `openssl dgst -sha1 -hmac`, a wholly
    // separate implementation from Node's `crypto` module) for secret "sharedsecret123", username
    // "1700000000:alice": `printf '%s' "1700000000:alice" | openssl dgst -sha1 -hmac "sharedsecret123" -binary |
    // openssl base64` -> "+2UD2zmjKs7sOoaP9j1YJ1Tmg24=", which Node's own `crypto.createHmac` reproduces exactly.
    // This is coturn's documented `static-auth-secret` / `turnserver -a -X` REST credential algorithm: username is
    // `<unix-expiry>:<userPart>`, credential is `base64(HMAC-SHA1(secret, username))`.
    it("Matches a known-good HMAC-SHA1 test vector computed independently via openssl.", () => {
        const now = new Date(1700000000_000);
        const result = turnRestCredential("sharedsecret123", "alice", 0, now);

        expect(result.username).toBe("1700000000:alice");
        expect(result.credential).toBe("+2UD2zmjKs7sOoaP9j1YJ1Tmg24=");
    });

    it("Embeds now + ttlSeconds as the expiry, rounded down to the second.", () => {
        const now = new Date(1700000000_500);
        const result = turnRestCredential("secret", "bob", 3600, now);

        expect(result.username).toBe("1700003600:bob");
    });

    it("Defaults ttlSeconds to DEFAULT_TURN_CREDENTIAL_TTL_SECONDS and now to the real current time.", () => {
        const before = Math.floor(Date.now() / 1000);
        const result = turnRestCredential("secret", "carol");
        const after = Math.floor(Date.now() / 1000);

        const expiry = Number(result.username.split(":")[0]);
        expect(expiry).toBeGreaterThanOrEqual(before + DEFAULT_TURN_CREDENTIAL_TTL_SECONDS);
        expect(expiry).toBeLessThanOrEqual(after + DEFAULT_TURN_CREDENTIAL_TTL_SECONDS);
    });

    it("Never mints a negative TTL into the past, even if given one.", () => {
        const now = new Date(1700000000_000);
        const result = turnRestCredential("secret", "dave", -100, now);

        expect(result.username).toBe("1700000000:dave");
    });
});

describe("buildIceServers", () => {
    it("Returns only the default public STUN servers when no TURN url is configured.", () => {
        expect(buildIceServers(EMPTY_TURN)).toEqual(DEFAULT_STUN_SERVERS);
    });

    it("Ignores a blank (whitespace-only) TURN url the same as an empty one.", () => {
        expect(buildIceServers({ ...EMPTY_TURN, url: "   " })).toEqual(DEFAULT_STUN_SERVERS);
    });

    it("Adds a static-credential TURN entry when a url, username and credential are all configured.", () => {
        const result = buildIceServers({ url: "turn:turn.example.com:3478", username: "static-user", credential: "static-pass", sharedSecret: "" });

        expect(result).toEqual([...DEFAULT_STUN_SERVERS, { urls: "turn:turn.example.com:3478", username: "static-user", credential: "static-pass" }]);
    });

    it("Adds the TURN url with no credentials when neither a shared secret nor a static credential pair is set.", () => {
        const result = buildIceServers({ ...EMPTY_TURN, url: "turn:open.example.com:3478" });

        expect(result).toEqual([...DEFAULT_STUN_SERVERS, { urls: "turn:open.example.com:3478" }]);
    });

    it("Adds the TURN url with no credentials when only a username (no credential) is set and there's no shared secret.", () => {
        const result = buildIceServers({ ...EMPTY_TURN, url: "turn:open.example.com:3478", username: "someone" });

        expect(result).toEqual([...DEFAULT_STUN_SERVERS, { urls: "turn:open.example.com:3478" }]);
    });

    it("Mints a time-limited REST credential when a shared secret is configured, using the configured username.", () => {
        const now = new Date(1700000000_000);
        const result = buildIceServers(
            { url: "turns:turn.example.com:5349", username: "alice", credential: "ignored-when-shared-secret-set", sharedSecret: "sharedsecret123" },
            { now, ttlSeconds: 0 },
        );

        expect(result).toEqual([...DEFAULT_STUN_SERVERS, { urls: "turns:turn.example.com:5349", username: "1700000000:alice", credential: "+2UD2zmjKs7sOoaP9j1YJ1Tmg24=" }]);
    });

    it("Generates a random username part when a shared secret is set but no username is configured.", () => {
        const now = new Date(1700000000_000);
        const result = buildIceServers(
            { url: "turns:turn.example.com:5349", username: "", credential: "", sharedSecret: "sharedsecret123" },
            { now, ttlSeconds: 0, randomUserPart: () => "generated" },
        );

        expect(result[2]).toEqual({ urls: "turns:turn.example.com:5349", username: "1700000000:generated", credential: turnRestCredential("sharedsecret123", "generated", 0, now).credential });
    });

    it("Falls back to a real random hex string for the username part when no randomUserPart override is given.", () => {
        const result = buildIceServers({ url: "turns:turn.example.com:5349", username: "", credential: "", sharedSecret: "sharedsecret123" });

        expect(result[2].username).toMatch(/^\d+:[0-9a-f]{16}$/);
    });

    it("Trims whitespace around every TURN setting before using it.", () => {
        const result = buildIceServers({ url: "  turn:turn.example.com:3478  ", username: " static-user ", credential: " static-pass ", sharedSecret: "" });

        expect(result[2]).toEqual({ urls: "turn:turn.example.com:3478", username: "static-user", credential: "static-pass" });
    });
});
