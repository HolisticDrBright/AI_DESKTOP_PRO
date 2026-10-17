/**
 * The BLOCKED workforce-consent-grant-paths-clinic-status candidate: withdrawals-only in a suspended clinic on the two
 * workforce grant paths the consent-decision candidate does not reach (the sync screen's set_sync_consent_scope and the
 * recording consent grant). No TypeScript switch: the SQL is the whole change; nothing calls a new function.
 */
export const WORKFORCE_CONSENT_GRANT_PATHS = {
  release: "blocked",
  sha256: "b6f4b53a640dd362df28613a2953d58cf81082d04bbcc1e55c1530022ac24346",
  rollbackSha256: "6382c13c6dd1c3d2789cd1ccafd54a1418a45ae61e115b3d77ef6f48d0784a96",
  prosrc: {
    sync: "6dc59bb3337cd6135a901444b14fddf701adb5b33513c332b87bf3d62270f723",
    recording: "a7df57f5e4e8e7f29839d47ef1202460dedd0a8d8b92a9644cf6dabcc3ff860f",
  },
  parents: {
    sync: "ebbd09fd16dcf44d8b8c7aac7a3ee0a75fa4a1a3f75011e82006e1da53d202ad",
    recording: "e28248a0ad68b7e3412aaf04cdd9e94fd7f64ee878fa6afc7e32962e4c754625",
    helper: "b0831b02f1f634d5d5d49e29a12c3ac2f0f7d634a834cdd14773a991c4a49888",
  },
} as const;
