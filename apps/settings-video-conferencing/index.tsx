// Placeholder only - the admin/settings page for this plugin's `mail:videoconf:*` settings is Phase 4 work,
// explicitly out of scope for the Phase 1 backend change this file exists to satisfy: `tsc -p tsconfig.apps.json`
// (see package.json's `build` script) requires at least one file under `apps/`, since this manifest already
// declares this directory as a UI app (`rapidmx.plugin.ui.apps[1].dir`).
export default function VideoConferencingSettingsPage() {
    return <p>Video conferencing settings: coming soon.</p>;
}
