///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The plugin contract: a server host registers every export of `./mongo`/`./sql` and mounts, connects or starts it,
// so each entry point must export only ready routes and models, and package.json must carry a valid manifest whose
// UI apps point at directories this package actually ships.
import "reflect-metadata";
import fs from "fs";
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

    it("declares the videoconf settings, each empty by default", () => {
        const manifest: any = parsePluginManifest(pkg);
        expect(manifest.settings.map((s: any) => s.key)).toEqual([
            "mail:videoconf:public_url",
            "mail:videoconf:turn:url",
            "mail:videoconf:turn:username",
            "mail:videoconf:turn:credential",
            "mail:videoconf:turn:shared_secret",
        ]);
        for (const setting of manifest.settings) {
            expect(setting.default).toBe("");
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
