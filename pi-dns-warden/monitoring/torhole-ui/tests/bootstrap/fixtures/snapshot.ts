const counts = { healthy: 1, degraded: 0, offline: 0, total: 1 };
export const snapshot = {
  schema_version: 1, generated_at: "2026-09-13T10:00:00Z", banner: null,
  torhole: { overall_status: "healthy", privacy_intact: true, headline: "DNS is resolving through the isolated Tor path.", summary_sentence: "Privacy path verified." },
  tor: { overall_status: "healthy", summary: "Tor ready", bootstrap: { status: "healthy", percent: 100 }, isolation: { status: "healthy" }, network_path: { status: "healthy" }, plane_identities: { overall_status: "healthy" }, circuits: { available: true, items: [], by_plane: { trusted: [], iot: [] }, count: 0 }, last_rotation_at: null },
  dns: { planes: [{ id: "trusted", label: "Flat LAN", status: "healthy" }], counts, overall_status: "healthy", totals: { queries_today: 100, blocked_today: 10, block_pct: 10 } },
  leak_test: { available: true, last_result: null, last_run_at: null, history_count: 0, recent_pass_rate: null, history: [] },
  containers: [{ id: "tor", name: "tor", label: "Tor", status: "healthy", core: true }], container_counts: counts,
  backup: { snapshot_count: 0, last_snapshot_name: null, last_snapshot_at: null, last_snapshot_size_bytes: null },
  alerts: { total_channels: 0, configured_channels: 0, enabled_channels: 0 }, validation: { last_result: null }, recovery: { status: "idle", latest_archive: null, finished_at: null }, links: {},
};
