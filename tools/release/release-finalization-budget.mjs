export const RELEASE_JOB_TIMEOUT_MINUTES = 6 * 60;
export const RELEASE_JOB_CLEANUP_RESERVE_SECONDS = 7 * 60;
export const RELEASE_JOB_HARD_WINDOW_SECONDS =
  (RELEASE_JOB_TIMEOUT_MINUTES * 60) - RELEASE_JOB_CLEANUP_RESERVE_SECONDS;

export const RELEASE_CURRENT_MAIN_STEP_TIMEOUT_MINUTES = 1;
export const RELEASE_CURRENT_MAIN_REVALIDATIONS_AFTER_ADMISSION = 2;
export const RELEASE_CURRENT_MAIN_REVALIDATION_TIMEOUT_SECONDS =
  RELEASE_CURRENT_MAIN_STEP_TIMEOUT_MINUTES
  * 60
  * RELEASE_CURRENT_MAIN_REVALIDATIONS_AFTER_ADMISSION;

export const RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES = Object.freeze({
  enterFinalization: 1,
  preservePublicationReceipts: 3,
  verifyPublishedRelease: 8,
  publicConsumerSmoke: 15,
  preserveConsumerEvidence: 2,
  reverifyPublicationLock: 2,
  preservePacingEvidence: 2,
  promoteDrafts: 12,
});

export const RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS = Object.values(
  RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES,
).reduce((total, minutes) => total + (minutes * 60), 0);

// This margin is deliberately outside every step's hard timeout. It covers
// runner scheduling, shell/action startup, and the transition into job-level
// cleanup after the final promotion step completes.
export const RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS = 3 * 60;
export const RELEASE_MINIMUM_FINALIZATION_SECONDS =
  RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS + RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS;

// Registry mutation stops two minutes before the finalization entry gate's
// minimum, so the registry executor can seal local receipts and return without
// consuming the protected finalization/cleanup envelope.
export const RELEASE_FINALIZATION_RESERVE_SECONDS = 50 * 60;
