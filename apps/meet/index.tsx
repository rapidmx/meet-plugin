// Placeholder only - the join/lobby/in-call UI (mesh WebRTC, gallery/speaker/presentation) is Phase 2 work,
// explicitly out of scope for the Phase 1 backend change this file exists to satisfy: `tsc -p tsconfig.apps.json`
// (see package.json's `build` script) requires at least one file under `apps/`, since this manifest already
// declares this directory as a UI app (`rapidmx.plugin.ui.apps[0].dir`).
export default function MeetPage() {
    return <p>Video meetings: coming soon.</p>;
}
