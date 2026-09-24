///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The plugin contract: a server host registers every export of `./mongo`/`./sql` and mounts, connects or starts it,
// so each entry point must export only ready routes and models, and package.json must carry a valid manifest whose
// UI apps point at directories this package actually ships.
import "reflect-metadata";
import fs from "fs";
import { fileURLToPath } from "url";
import { PersistenceDecorators } from "@rapidrest/service-core";
import { isMailboxScopedData, parsePluginManifest } from "@rapidmx/restapi";
import * as RootEntry from "../src/index.js";
import * as MongoEntry from "../src/mongo.js";
import * as SqlEntry from "../src/sql.js";

function describeExport(clazz: any): string {
    if (Reflect.getMetadata("rrst:routePaths", clazz.prototype)) {
        return `route ${Reflect.getMetadata("rrst:routePaths", clazz.prototype).join(",")}`;
    }
    if (Reflect.getMetadata("rrst:datasource", clazz)) {
        return `model ${Reflect.getMetadata("rrst:datasource", clazz)}${isMailboxScopedData(clazz) ? " mailbox-scoped" : ""}`;
    }
    return "other";
}

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("plugin entry points", () => {
    it.each([
        ["mongo", MongoEntry, "Mongo", "mongo"],
        ["sql", SqlEntry, "SQL", "sql"],
    ])("./%s exports only the mounted route and the mailbox-scoped models", (_name, entry, suffix, datastore) => {
        expect(Object.fromEntries(Object.entries(entry).map(([name, clazz]) => [name, describeExport(clazz)]))).toEqual({
            [`VideoMeetingRoute${suffix}`]: "route /api/mail/video-meetings",
            [`VideoMeeting${suffix}`]: `model ${datastore} mailbox-scoped`,
            [`VideoMeetingInvitee${suffix}`]: `model ${datastore} mailbox-scoped`,
        });
    });

    it("keeps the collection names, index names and ACL uids of the models core used to define", () => {
        const meetingIndexes: string[] = ["videomeeting_mailbox", "videomeeting_public_slug", "videomeeting_organizer_slug"];
        const inviteeIndexes: string[] = ["videomeetinginvitee_join_token", "videomeetinginvitee_meeting", "videomeetinginvitee_mailbox"];
        for (const [clazz, acl, recordACL, indexes] of [
            [MongoEntry.VideoMeetingMongo, "VideoMeeting", true, meetingIndexes],
            [MongoEntry.VideoMeetingInviteeMongo, "VideoMeetingInvitee", false, inviteeIndexes],
            [SqlEntry.VideoMeetingSQL, "VideoMeeting", true, meetingIndexes],
            [SqlEntry.VideoMeetingInviteeSQL, "VideoMeetingInvitee", false, inviteeIndexes],
        ] as const) {
            expect(Reflect.getMetadata("rrst:classACL", clazz).uid).toBe(acl);
            expect(Reflect.getMetadata("rrst:recordACL", clazz)).toBe(recordACL);
            const indexNames: string[] = PersistenceDecorators.getIndexMetadata(clazz).map((index: any) => index.name);
            expect(indexNames).toEqual(expect.arrayContaining(indexes));
        }
    });

    it("exports the backend-agnostic surface from the package root", () => {
        expect(Object.keys(RootEntry).sort()).toEqual(
            [
                "BaseVideoMeetingRoute",
                "buildBaseUrl",
                "buildIceServers",
                "createSingleInviteeVideoMeeting",
                "DEFAULT_STUN_SERVERS",
                "DEFAULT_TURN_CREDENTIAL_TTL_SECONDS",
                "turnRestCredential",
                "GUEST_JWT_TTL_SECONDS",
                "GUEST_UID_PREFIX",
                "JOIN_TOKEN_PATTERN",
                "PUBLIC_SLUG_PATTERN",
                "mintJoinToken",
                "mintPublicSlug",
                "stripTrustedRoles",
                "VideoMeetingVisibility",
                "VideoMeetingStatus",
            ].sort(),
        );
    });
});

describe("plugin manifest", () => {
    it("declares a valid plugin manifest", () => {
        const manifest = parsePluginManifest(pkg);
        expect(typeof manifest).toBe("object");
        expect(manifest).toEqual(expect.objectContaining({ displayName: "Video Conferencing", mailboxScopedData: true }));
    });

    it("declares the videoconf settings, each empty by default but the join page URL, which offers this server's address", () => {
        const manifest: any = parsePluginManifest(pkg);
        expect(manifest.settings.map((s: any) => s.key)).toEqual([
            "mail:videoconf:public_url",
            "mail:videoconf:turn:url",
            "mail:videoconf:turn:username",
            "mail:videoconf:turn:credential",
            "mail:videoconf:turn:shared_secret",
        ]);
        for (const setting of manifest.settings) {
            expect(setting.default).toBe(setting.key === "mail:videoconf:public_url" ? "https://<host>/meet" : "");
        }
    });

    it("declares the meet and settings-video-conferencing apps, and the Video Conferencing settings screen", () => {
        const manifest: any = parsePluginManifest(pkg);
        expect(manifest.ui.apps).toEqual([
            { id: "meet", host: "public", mount: "/meet", dir: "apps/meet" },
            { id: "video-conferencing", host: "www", mount: "/settings/video-conferencing", dir: "apps/settings-video-conferencing" },
        ]);
        expect(manifest.ui.settingsSections).toEqual([
            { id: "video-conferencing", label: "Video Conferencing", href: "/settings/video-conferencing", icon: "HiOutlineVideoCamera" },
        ]);
    });

    it("ships every UI app's sources (placeholder pages for now - see .claude/NOTES.md) in the package", () => {
        expect(pkg.files).toEqual(expect.arrayContaining(["apps", "dist"]));
        for (const app of pkg.rapidmx.plugin.ui.apps) {
            expect(fs.existsSync(new URL(`../${app.dir}/index.tsx`, import.meta.url))).toBe(true);
        }
    });
});

describe("package.json dependency consistency", () => {
    // Regression test for a real cross-repo bug: `apps/settings-video-conferencing/*.tsx` import
    // `@rapidmx/react-shared/videoconf/videoMeetingsApi.js`, a module react-shared's own CHANGELOG.md shows was
    // only added in 0.13.0. A `peerDependencies` floor below that version is a lie - anyone installing this plugin
    // against the bottom of its own claimed-supported range gets a hard module-resolution failure at import time,
    // not a type error caught at compile time (a plugin's `apps/` compile against this repo's own `devDependencies`
    // version, never the peer range's floor). Every source file under `apps/` that imports from
    // `@rapidmx/react-shared/videoconf/` is walked here, rather than hardcoding the one module currently known to
    // need it, so a future addition to that surface can't silently regress this floor again.
    it("declares a react-shared peer floor high enough for every '@rapidmx/react-shared/videoconf/*' import apps/ makes", () => {
        const REQUIRED_REACT_SHARED_FLOOR = "0.13.0";
        const appsDir = new URL("../apps/", import.meta.url);
        const importPattern = /@rapidmx\/react-shared\/videoconf\//;
        function walk(dirUrl: URL): string[] {
            const dir = fileURLToPath(dirUrl);
            let matches: string[] = [];
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
                if (entry.isDirectory()) {
                    matches = matches.concat(walk(entryUrl));
                } else if (/\.tsx?$/.test(entry.name)) {
                    if (importPattern.test(fs.readFileSync(fileURLToPath(entryUrl), "utf8"))) {
                        matches.push(fileURLToPath(entryUrl));
                    }
                }
            }
            return matches;
        }
        const filesNeedingTheFloor: string[] = walk(appsDir);
        // Sanity check on the test itself: if this ever finds nothing, the regex/walk broke silently rather than
        // the import having been removed - `videoMeetingsApi.js` is imported by Phase 4's settings page today.
        expect(filesNeedingTheFloor.length).toBeGreaterThan(0);

        const peerRange: string = pkg.peerDependencies["@rapidmx/react-shared"];
        const floorMatch: RegExpMatchArray | null = peerRange.match(/>=(\d+\.\d+\.\d+)/);
        expect(floorMatch).not.toBeNull();
        const declaredFloor: string = floorMatch![1];
        expect(semverGte(declaredFloor, REQUIRED_REACT_SHARED_FLOOR)).toBe(true);
    });

    // `BaseVideoMeetingRoute` writes `CalendarEventAttendeeLink` rows (the per-invitee calendar invite links
    // `MeetingSchedulingJob` reads), a model `@rapidmx/restapi` only added in 0.19.0 - a lower peer floor would let
    // an install resolve a restapi with no such model, failing at import time.
    it("declares a restapi peer floor high enough for the CalendarEventAttendeeLink model the routes write", () => {
        const REQUIRED_RESTAPI_FLOOR = "0.19.0";
        const routeSource: string = fs.readFileSync(fileURLToPath(new URL("../src/routes/BaseVideoMeetingRoute.ts", import.meta.url)), "utf8");
        // Sanity check on the test itself: the import it guards must still exist.
        expect(routeSource).toMatch(/CalendarEventAttendeeLink/);

        const floorMatch: RegExpMatchArray | null = pkg.peerDependencies["@rapidmx/restapi"].match(/>=(\d+\.\d+\.\d+)/);
        expect(floorMatch).not.toBeNull();
        expect(semverGte(floorMatch![1], REQUIRED_RESTAPI_FLOOR)).toBe(true);
    });

    it("pins every 'resolutions' entry to exactly its own 'peerDependencies' floor, matching booking-plugin's convention", () => {
        for (const name of ["@rapidmx/react-shared", "@rapidmx/restapi", "@rapidmx/web-client"]) {
            const peerFloor: string = pkg.peerDependencies[name].match(/>=(\d+\.\d+\.\d+)/)[1];
            expect(pkg.resolutions[name]).toBe(`^${peerFloor}`);
        }
    });
});

/** Bare `major.minor.patch` comparison - sufficient for the plain `x.y.z` peer floors this manifest declares. */
function semverGte(a: string, b: string): boolean {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) {
            return pa[i] > pb[i];
        }
    }
    return true;
}
