///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Global setup for the frontend (apps/*) test suite. Vitest applies `setupFiles` across every test environment
// configured for this project, including the plain `node` environment the backend `test/**/*.test.ts` suite runs
// under - guard everything here on `document` actually existing so this file is a no-op for those tests rather
// than throwing on a DOM API that isn't present. Copied from `booking-plugin`'s identical file: Phase 1 (this
// change) has no `apps/` tests of its own yet (see this package's `.claude/NOTES.md` - the join/lobby/in-call UI
// is Phase 2, the admin/settings pages are Phase 4), but the vitest config already expects this file to exist for
// whichever phase adds them.
import "@testing-library/jest-dom/vitest";

if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    afterEach(() => {
        cleanup();
    });

    if (typeof window.matchMedia !== "function") {
        window.matchMedia = (query: string) =>
            ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                addListener: vi.fn(),
                removeListener: vi.fn(),
                dispatchEvent: vi.fn(() => false),
            }) as MediaQueryList;
    }

    if (typeof (window as any).IntersectionObserver !== "function") {
        (window as any).IntersectionObserver = vi.fn().mockImplementation(function () {
            return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
        });
    }
}
