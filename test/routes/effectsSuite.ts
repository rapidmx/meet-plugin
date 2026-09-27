///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The `effectsAssetsUrl` field of `BaseVideoMeetingRoute.join()`'s response (the `mail:videoconf:effects:assets_url`
// setting) - identical on both backends. Run from the VideoMeetingRoute test files, which supply a started server and
// fixtures. Like `relaySuite`, it reaches into the mounted route instance to set the private setting field and puts the
// original back afterwards.
import { request } from "@rapidrest/service-core/test";
import type { VideoMeetingSecuritySuiteContext } from "./videoMeetingSecuritySuite.js";

export interface EffectsSuiteContext extends VideoMeetingSecuritySuiteContext {
    /** The route instance the server mounted - its `effectsAssetsUrlSetting` is what the tests set. */
    route: () => any;
}

export function effectsSuite(ctx: EffectsSuiteContext): void {
    const withEffectsSetting = async (value: unknown, body: () => Promise<void>): Promise<void> => {
        const route: any = ctx.route();
        const original = route.effectsAssetsUrlSetting;
        route.effectsAssetsUrlSetting = value;
        try {
            await body();
        } finally {
            route.effectsAssetsUrlSetting = original;
        }
    };

    /** Joins a fresh public meeting as a guest (no credentials). */
    const joinAsGuest = async (): Promise<any> => {
        const { publicSlug } = await ctx.createPublicMeeting();
        const joined = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`);
        expect(joined.status).toBe(200);
        expect(joined.body.authenticated).toBe(false);
        return joined.body;
    };

    /** Joins a fresh public meeting as a signed-in user. */
    const joinAsUser = async (): Promise<any> => {
        const { publicSlug } = await ctx.createPublicMeeting();
        const joined = await request(ctx.app()).get(`${ctx.baseUrl}/join/${publicSlug}`).set("Authorization", "jwt " + ctx.strangerToken());
        expect(joined.status).toBe(200);
        expect(joined.body.authenticated).toBe(true);
        return joined.body;
    };

    describe("GET /join/:token effectsAssetsUrl", () => {
        it("Omits effectsAssetsUrl for a guest and for a signed-in user when the setting is unset.", async () => {
            expect(await joinAsGuest()).not.toHaveProperty("effectsAssetsUrl");
            expect(await joinAsUser()).not.toHaveProperty("effectsAssetsUrl");
        });

        it("Omits effectsAssetsUrl when the setting is the empty string.", async () => {
            await withEffectsSetting("", async () => {
                expect(await joinAsGuest()).not.toHaveProperty("effectsAssetsUrl");
                expect(await joinAsUser()).not.toHaveProperty("effectsAssetsUrl");
            });
        });

        it("Returns effectsAssetsUrl to a guest, with the trailing slash stripped.", async () => {
            await withEffectsSetting("https://files.example.com/meet-effects/", async () => {
                expect((await joinAsGuest()).effectsAssetsUrl).toBe("https://files.example.com/meet-effects");
            });
        });

        it("Returns effectsAssetsUrl to a signed-in user, with the trailing slash stripped.", async () => {
            await withEffectsSetting("https://files.example.com/meet-effects/", async () => {
                expect((await joinAsUser()).effectsAssetsUrl).toBe("https://files.example.com/meet-effects");
            });
        });

        it("Returns a root-relative path as configured.", async () => {
            await withEffectsSetting("/meet-effects", async () => {
                expect((await joinAsGuest()).effectsAssetsUrl).toBe("/meet-effects");
                expect((await joinAsUser()).effectsAssetsUrl).toBe("/meet-effects");
            });
        });

        it.each(["javascript:alert(1)", "//evil.example.com/effects", "not a url", "https://files.example.com/my effects", "   ", 42, null])(
            "Omits effectsAssetsUrl for the invalid setting %j.",
            async (value) => {
                await withEffectsSetting(value, async () => {
                    expect(await joinAsGuest()).not.toHaveProperty("effectsAssetsUrl");
                    expect(await joinAsUser()).not.toHaveProperty("effectsAssetsUrl");
                });
            },
        );

        it("Restores the original setting once a test is done with it.", async () => {
            await withEffectsSetting("https://files.example.com/meet-effects", async () => undefined);
            expect(await joinAsGuest()).not.toHaveProperty("effectsAssetsUrl");
        });
    });
}
