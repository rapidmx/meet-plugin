///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { buildIceServers, DEFAULT_STUN_SERVERS, stunServers } from "../../src/util/IceServerUtils.js";

// A server from before Integrations runs a restapi that exports neither `HostConfig` nor `normalizeStunUrls`. Under Node a named import of either
// would fail the whole plugin's load; the mock keeps the names present but unset, which is what reading them through the module namespace finds there.
vi.mock("@rapidmx/restapi", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    HostConfig: undefined,
    normalizeStunUrls: undefined,
}));

describe("STUN servers on a server from before Integrations", () => {
    it("Uses the built-in list, with TURN still appended, when restapi has no HostConfig.", () => {
        const logger = { warn: vi.fn() };

        expect(stunServers(logger)).toEqual(DEFAULT_STUN_SERVERS);
        expect(buildIceServers({ url: "turns:turn.example.com:5349", username: "", credential: "", sharedSecret: "" })).toEqual([
            ...DEFAULT_STUN_SERVERS,
            { urls: "turns:turn.example.com:5349" },
        ]);
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
