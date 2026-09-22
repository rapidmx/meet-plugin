import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import { resolve } from "path";

export default defineConfig({
    resolve: {
        alias: {
            "@rapidrest/service-core/dist/lib/test/request.js": resolve(
                "node_modules/@rapidrest/service-core/dist/lib/test/request.js",
            ),
            "@rapidrest/service-core/dist/lib/test/requestws.js": resolve(
                "node_modules/@rapidrest/service-core/dist/lib/test/requestws.js",
            ),
        },
        // `@rapidmx/restapi`, `@rapidmx/react-shared` and `@rapidmx/web-client` are portal-linked during development (see
        // package.json `resolutions`), and each keeps its own node_modules. Without deduping, their imports would resolve
        // their own copies: a second React breaks every hook with "Invalid hook call", and a second service-core or core
        // breaks the `instanceof`-based dependency injection and datastore lookups the test servers rely on.
        dedupe: ["react", "react-dom", "@rapidrest/core", "@rapidrest/service-core", "typeorm", "mongodb", "reflect-metadata"],
    },
    ssr: {
        noExternal: [
            "@rapidrest/service-core",
            "@rapidrest/core",
            "@rapidmx/restapi",
            "@rapidmx/react-shared",
            "@rapidmx/web-client",
        ],
    },
    plugins: [
        swc.vite({
            jsc: {
                parser: {
                    syntax: "typescript",
                    tsx: true,
                    decorators: true,
                },
                transform: {
                    react: {
                        runtime: "automatic",
                    },
                    decoratorMetadata: true,
                    legacyDecorator: true,
                },
                target: "es2020",
            },
        }),
    ],
    test: {
        globals: true,
        // The backend suites run under plain `node`, matching the server runtime. Page and component tests that need a DOM
        // opt into `jsdom` with a `// @vitest-environment jsdom` docblock at the top of the file.
        environment: "node",
        setupFiles: ["./test/apps/setup.ts"],
        include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
        // Pins the local timezone to UTC, so UTC ISO fixtures and the pages' local-time formatting agree wherever the
        // suite runs.
        env: { TZ: "UTC" },
        fileParallelism: false,
        pool: "forks",
        poolOptions: {
            forks: {
                execArgv: ["--no-experimental-strip-types"],
            },
        },
        clearMocks: true,
        coverage: {
            enabled: true,
            provider: "v8",
            include: ["src/**/*.ts", "apps/**/*.ts", "apps/**/*.tsx"],
            exclude: ["**/node_modules/**", "**/test/**"],
            reporter: ["text", "json", "html", "lcov"],
            thresholds: {
                // The v8/istanbul branch instrumentation counts one extra, structurally-unreachable branch per
                // `@Inject`/`@Config` decorated class field - TypeScript's `emitDecoratorMetadata` emits
                // `typeof X === "undefined" ? Object : X` for each one's `design:type`, and the `Object` arm
                // can only be taken if `X` were undefined at decoration time (e.g. a circular-import TDZ),
                // which isn't a legitimate test scenario. Matches `@rapidmx/activesync-plugin`'s identical carve-out.
                branches: 95,
                functions: 100,
                lines: 100,
                statements: 100,
            },
            reportsDirectory: "coverage",
        },
        reporters: ["default", "junit"],
        outputFile: {
            junit: "junit.xml",
        },
    },
});
