///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Shared nconf defaults for the two test config variants (`config.ts` for Mongo-backed test suites, `config.sql.ts`
// for SQL-backed ones) - kept as a single factory so a config key added for one variant can't silently drift out
// of sync with the other. Copied from `booking-plugin`'s identical file, with this plugin's own `mail:videoconf:*`
// settings in place of `mail:booking:*`.

/**
 * Builds the full nconf defaults object for a test run, parameterized only by which `datastores` are configured -
 * everything else is identical between the Mongo and SQL test variants.
 *
 * @param datastores The `datastores` block to use - the two variants differ only in whether `acl`/the primary
 * entity datastore are MongoDB- or SQL-backed, and whether a `mongo` datastore is present at all.
 */
export function buildTestConfigDefaults(datastores: Record<string, any>) {
    return {
        service_name: "mail_test_service",
        version: "1.0",
        // Set explicitly (rather than relying on Server's default of 3000) so the test suite never silently
        // collides with an unrelated process already listening on the default port in a developer's environment.
        port: 3849,
        cookie_secret: "f0fLSKFJLKWJFe09f32joff098u2fOFIWJ32890fnfnlak",
        cors: {
            origins: ["http://localhost:3000"],
        },
        datastores,
        // Specifies the group names that are considered to be trusted with administrative privileges.
        trusted_roles: ["admin"],
        // Settings pertaining to the signing and verification of authentication tokens - also what
        // `BaseVideoMeetingRoute.mintGuestToken()` signs a guest's own token with.
        auth: {
            strategy: "auth.JWTStrategy",
            allowQueryParam: true,
            secret: "MyPasswordIsSecure",
            options: {
                expiresIn: "7 days",
                audience: "mydomain.com",
                issuer: "api.mydomain.com",
            },
        },
        rbac: {
            enabled: true,
        },
        session: {
            secret: "SessionsHaveSecrets",
        },
        cluster_url: "http://localhost",
        metrics: {
            authRequired: false,
        },
        // Read by `RateLimiter`, which backs the `@RateLimit()` decorator on `BaseVideoMeetingRoute.join()`. Raised
        // well above the framework's own defaults (5 attempts / 5 minutes, tuned for credential endpoints) so the
        // rest of this suite isn't tripped by it; one dedicated test lowers it back down to prove it's wired.
        rateLimit: {
            enabled: true,
            maxAttempts: 1000,
            windowSeconds: 300,
            ip: {
                enabled: true,
                maxAttempts: 5000,
                windowSeconds: 300,
            },
        },
        mail: {
            videoconf: {
                public_url: "https://videoconf.rapidmx-test.example.com/meet",
                turn: {
                    url: "",
                    username: "",
                    credential: "",
                    shared_secret: "",
                },
            },
        },
    };
}

/**
 * The `sql` datastore's TypeORM config shared by both variants (the SQL-backed ACL variant also uses this shape,
 * just under the `acl` key with a distinct `database` file).
 */
export function sqlDatastoreConfig(database: string) {
    return {
        type: "better-sqlite3",
        host: "localhost",
        database,
        synchronize: true,
        invalidWhereValuesBehavior: { null: "sql-null" },
    };
}
