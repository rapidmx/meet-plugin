///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2020-2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Used by Mongo-backed test suites (`test/routes/mongo/*`) - `acl` and the primary entity datastore are both
// MongoDB. SQL-backed test suites use `config.sql.ts` instead.
import nconf from "nconf";
import { buildTestConfigDefaults, sqlDatastoreConfig } from "./config-defaults.js";

const conf = nconf.argv().env({
    separator: "__",
    lowerCase: true,
    parseValues: true,
});

conf.use("memory");

conf.defaults(
    buildTestConfigDefaults({
        acl: {
            type: "mongodb",
            url: "mongodb://localhost:9998/acls",
            synchronize: true,
        },
        mongo: {
            type: "mongodb",
            host: "localhost",
            port: 9998,
            database: "rrst-test",
            synchronize: true,
        },
        sql: sqlDatastoreConfig("rrst-test"),
    }),
);

export default conf;
