///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { HostConfig, HostConfigUninstall, INTEGRATION_CONFIG_KEYS } from "@rapidmx/restapi";
import {
    buildIceServers,
    DEFAULT_STUN_SERVERS,
    DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
    parseStunUrls,
    parseTurnUrls,
    STUN_URLS_CONFIG_KEY,
    stunServers,
    turnRestCredential,
    withTcpFallback,
} from "../../src/util/IceServerUtils.js";

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

        expect(result).toEqual([
            ...DEFAULT_STUN_SERVERS,
            { urls: ["turn:turn.example.com:3478", "turn:turn.example.com:3478?transport=tcp"], username: "static-user", credential: "static-pass" },
        ]);
    });

    it("Adds the TURN url with no credentials when neither a shared secret nor a static credential pair is set.", () => {
        const result = buildIceServers({ ...EMPTY_TURN, url: "turn:open.example.com:3478" });

        expect(result).toEqual([...DEFAULT_STUN_SERVERS, { urls: ["turn:open.example.com:3478", "turn:open.example.com:3478?transport=tcp"] }]);
    });

    it("Adds the TURN url with no credentials when only a username (no credential) is set and there's no shared secret.", () => {
        const result = buildIceServers({ ...EMPTY_TURN, url: "turn:open.example.com:3478", username: "someone" });

        expect(result).toEqual([...DEFAULT_STUN_SERVERS, { urls: ["turn:open.example.com:3478", "turn:open.example.com:3478?transport=tcp"] }]);
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

        expect(result[2]).toEqual({
            urls: ["turn:turn.example.com:3478", "turn:turn.example.com:3478?transport=tcp"],
            username: "static-user",
            credential: "static-pass",
        });
    });

    it("Gives a TURN server listening on several addresses one entry with all its URLs, sharing one credential.", () => {
        const now = new Date("2023-11-14T22:13:20.000Z");
        const result = buildIceServers(
            { url: "turn:turn.example.com:3478,turns:turn.example.com:5349", username: "", credential: "", sharedSecret: "sharedsecret123" },
            { now, ttlSeconds: 0, randomUserPart: () => "generated" },
        );

        expect(result).toHaveLength(DEFAULT_STUN_SERVERS.length + 1);
        expect(result[2]).toEqual({
            urls: ["turn:turn.example.com:3478", "turn:turn.example.com:3478?transport=tcp", "turns:turn.example.com:5349"],
            username: "1700000000:generated",
            credential: turnRestCredential("sharedsecret123", "generated", 0, now).credential,
        });
    });

    it("Uses the same static credential for every one of several URLs.", () => {
        const result = buildIceServers({ url: "turn:a.example.com:3478 turns:a.example.com:5349", username: "u", credential: "p", sharedSecret: "" });

        expect(result[2]).toEqual({
            urls: ["turn:a.example.com:3478", "turn:a.example.com:3478?transport=tcp", "turns:a.example.com:5349"],
            username: "u",
            credential: "p",
        });
    });

    it("Keeps a single turns: URL a plain string, since it needs no TCP twin.", () => {
        const result = buildIceServers({ ...EMPTY_TURN, url: "turns:turn.example.com:5349" });

        expect(result[2]).toEqual({ urls: "turns:turn.example.com:5349" });
    });
});

describe("parseTurnUrls", () => {
    it("Splits on commas and any whitespace, dropping blanks.", () => {
        expect(parseTurnUrls("turn:a:3478")).toEqual(["turn:a:3478"]);
        expect(parseTurnUrls(" turn:a:3478 ,, turns:a:5349\n turn:b:3478?transport=tcp ")).toEqual(["turn:a:3478", "turns:a:5349", "turn:b:3478?transport=tcp"]);
        expect(parseTurnUrls("")).toEqual([]);
        expect(parseTurnUrls(" , ")).toEqual([]);
    });
});

describe("withTcpFallback", () => {
    it("Follows a plain turn: URL with its TCP twin, in place.", () => {
        expect(withTcpFallback(["turn:a:3478", "turns:a:5349"])).toEqual(["turn:a:3478", "turn:a:3478?transport=tcp", "turns:a:5349"]);
    });

    it("Leaves a URL that already names a transport, and a turns: URL, exactly as given.", () => {
        expect(withTcpFallback(["turn:a:3478?transport=udp", "turn:b:3478?transport=tcp", "turns:b:5349"])).toEqual([
            "turn:a:3478?transport=udp",
            "turn:b:3478?transport=tcp",
            "turns:b:5349",
        ]);
    });

    it("Appends to an existing query string, matches the scheme case-insensitively and drops duplicates.", () => {
        expect(withTcpFallback(["TURN:a:3478?x=1", "TURN:a:3478?x=1&transport=tcp"])).toEqual(["TURN:a:3478?x=1", "TURN:a:3478?x=1&transport=tcp"]);
    });

    it("Returns nothing for nothing.", () => {
        expect(withTcpFallback([])).toEqual([]);
    });
});

// `HostConfig` is frozen (its `get` can't be spied on), so these install a fake source the way the server installs its config, and remove it with the
// handle that installation returned.
describe("STUN servers from the host's integrations config", () => {
    let uninstall: HostConfigUninstall | undefined;
    const keysRead: string[] = [];
    let configured: unknown;

    beforeEach(() => {
        keysRead.length = 0;
        configured = undefined;
        uninstall = HostConfig.install({
            get: (key: string) => {
                keysRead.push(key);
                return key === "integrations:stun:urls" ? configured : undefined;
            },
        });
    });

    afterEach(() => {
        uninstall?.();
        uninstall = undefined;
    });

    it("Reads integrations:stun:urls, the key the server's integrations layer sets.", () => {
        expect(STUN_URLS_CONFIG_KEY).toBe(INTEGRATION_CONFIG_KEYS.stun.urls);
        configured = ["stun:stun.example.com:3478"];

        stunServers();

        expect(keysRead).toEqual(["integrations:stun:urls"]);
    });

    it("Hands out the administrator's STUN servers, one entry each in their order, in place of the built-in ones.", () => {
        configured = ["stun:stun.example.com:3478", "stuns:stun.example.net"];

        expect(buildIceServers(EMPTY_TURN)).toEqual([{ urls: "stun:stun.example.com:3478" }, { urls: "stuns:stun.example.net" }]);
    });

    it("Keeps the TURN entry after the administrator's STUN servers.", () => {
        configured = ["stun:stun.example.com:3478"];

        expect(buildIceServers({ ...EMPTY_TURN, url: "turns:turn.example.com:5349" })).toEqual([
            { urls: "stun:stun.example.com:3478" },
            { urls: "turns:turn.example.com:5349" },
        ]);
    });

    it("Reads the setting again for every list, so a change applies to the next join without a restart.", () => {
        configured = ["stun:first.example.com"];
        expect(buildIceServers(EMPTY_TURN)).toEqual([{ urls: "stun:first.example.com" }]);

        configured = ["stun:second.example.com:3478"];
        expect(buildIceServers(EMPTY_TURN)).toEqual([{ urls: "stun:second.example.com:3478" }]);

        configured = undefined;
        expect(buildIceServers(EMPTY_TURN)).toEqual(DEFAULT_STUN_SERVERS);
    });

    it("Falls back to the built-in list when the setting is unset, empty or holds no usable STUN URI.", () => {
        for (const value of [undefined, null, [], "", "  ", " , ", ["turn:turn.example.com:3478", "stun:", 42], { urls: ["stun:stun.example.com"] }]) {
            configured = value;
            expect(stunServers()).toEqual(DEFAULT_STUN_SERVERS);
        }
    });

    // Each test below uses values of its own: the warning is given once per distinct value for the life of the module.
    it("Warns once per value when entries are ignored, saying when the built-in list is used instead, and never repeats the value.", () => {
        const logger = { warn: vi.fn() };
        configured = "stun:stun.internal.example:3478?transport=udp";

        expect(stunServers(logger)).toEqual(DEFAULT_STUN_SERVERS);
        expect(stunServers(logger)).toEqual(DEFAULT_STUN_SERVERS);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toMatch(/integrations:stun:urls: 1 of 1 entries .*ignored.*built-in STUN servers/);
        expect(logger.warn.mock.calls[0][0]).not.toContain("internal.example");

        configured = ["stun:kept.example.com", "stun:dropped.example.com:0", "turn:dropped.example.com"];
        expect(stunServers(logger)).toEqual([{ urls: "stun:kept.example.com" }]);
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.warn.mock.calls[1][0]).toMatch(/integrations:stun:urls: 2 of 3 entries .*ignored/);
        expect(logger.warn.mock.calls[1][0]).not.toMatch(/built-in|example/);
    });

    it("Warns again when a value that was fixed goes bad again.", () => {
        const logger = { warn: vi.fn() };
        configured = ["stun:again.example.com:99999"];
        stunServers(logger);
        configured = ["stun:again.example.com"];
        stunServers(logger);
        configured = ["stun:again.example.com:99999"];
        stunServers(logger);

        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("Warns when the value can't be read as a list at all, and stays quiet for unset, empty, blank-separated and repeated entries.", () => {
        const logger = { warn: vi.fn() };
        for (const value of [undefined, null, [], "", "  ", " , ", "stun:quiet.example.com,,", ["stun:quiet.example.com", "stun:QUIET.example.com", ""]]) {
            configured = value;
            stunServers(logger);
        }
        expect(logger.warn).not.toHaveBeenCalled();

        configured = '["stun:unreadable.example.com"';
        stunServers(logger);
        configured = { urls: ["stun:unreadable.example.com"] };
        stunServers(logger);

        expect(logger.warn).toHaveBeenCalledTimes(2);
        for (const [message] of logger.warn.mock.calls) {
            expect(message).toMatch(/integrations:stun:urls isn't a list of STUN URIs .*built-in STUN servers/);
            expect(message).not.toContain("unreadable");
        }
    });

    it("Warns through the logger buildIceServers is given.", () => {
        const logger = { warn: vi.fn() };
        configured = ["turn:through-build.example.com"];

        expect(buildIceServers(EMPTY_TURN, { logger })).toEqual(DEFAULT_STUN_SERVERS);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("Ignores entries silently when no logger is given, and still warns the next caller that has one.", () => {
        const logger = { warn: vi.fn() };
        configured = ["turn:no-logger.example.com"];

        expect(stunServers()).toEqual(DEFAULT_STUN_SERVERS);
        stunServers(logger);

        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});

describe("STUN servers without a host config", () => {
    it("Uses the built-in list when no host has installed its configuration (a plugin run outside the server).", () => {
        expect(HostConfig.isInstalled()).toBe(false);
        expect(stunServers()).toEqual(DEFAULT_STUN_SERVERS);
    });
});

describe("parseStunUrls", () => {
    it("Reads a list, JSON text of a list, or names separated by commas, as the server reads the deployment's value.", () => {
        expect(parseStunUrls(["stun:a.example.com", "stuns:b.example.com:5349"])).toEqual(["stun:a.example.com", "stuns:b.example.com:5349"]);
        expect(parseStunUrls(' ["stun:a.example.com", "stun:b.example.com:3478"] ')).toEqual(["stun:a.example.com", "stun:b.example.com:3478"]);
        expect(parseStunUrls("stun:a.example.com, stun:b.example.com:3478,,")).toEqual(["stun:a.example.com", "stun:b.example.com:3478"]);
    });

    it("Lowercases each URI and keeps each once.", () => {
        expect(parseStunUrls(["STUN:A.Example.com:3478", "stun:a.example.com:3478", "stun:[2001:DB8::1]"])).toEqual([
            "stun:a.example.com:3478",
            "stun:[2001:db8::1]",
        ]);
    });

    it("Drops what a browser would refuse, so one bad entry never breaks every call: other schemes, no host, a bad port, extra parts and non-text.", () => {
        expect(
            parseStunUrls([
                "turn:turn.example.com:3478",
                "https://stun.example.com",
                "stun:",
                "stun:stun.example.com:0",
                "stun:stun.example.com:65536",
                "stun:stun.example.com:3478?transport=udp",
                "stun:user@stun.example.com",
                "stun:bad host.example.com",
                "stun:[not-an-address]",
                42,
                null,
                { urls: "stun:stun.example.com" },
                "stun:ok.example.com",
            ]),
        ).toEqual(["stun:ok.example.com"]);
    });

    it("Reads nothing from anything else: unset, malformed JSON, a lone number or an object.", () => {
        expect(parseStunUrls(undefined)).toEqual([]);
        expect(parseStunUrls(null)).toEqual([]);
        expect(parseStunUrls('["stun:a.example.com"')).toEqual([]);
        expect(parseStunUrls(3478)).toEqual([]);
        expect(parseStunUrls({ urls: ["stun:a.example.com"] })).toEqual([]);
    });
});
