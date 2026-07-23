/// Options for preparing an opened database for app suspension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackgroundPreparationOptions {
    /// Request cancellation of active work before the app is suspended.
    pub cancel_active_work: bool,
    /// Run a PostgreSQL checkpoint when the session is idle.
    pub checkpoint_when_idle: bool,
}

impl Default for BackgroundPreparationOptions {
    fn default() -> Self {
        Self {
            cancel_active_work: true,
            checkpoint_when_idle: true,
        }
    }
}

impl BackgroundPreparationOptions {
    /// Create options with the default production behavior.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set whether active work should be cancelled out of band.
    pub fn cancel_active_work(mut self, enabled: bool) -> Self {
        self.cancel_active_work = enabled;
        self
    }

    /// Set whether an idle session should checkpoint before suspension.
    pub fn checkpoint_when_idle(mut self, enabled: bool) -> Self {
        self.checkpoint_when_idle = enabled;
        self
    }
}

/// Reason a background checkpoint was intentionally skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundCheckpointSkipReason {
    /// Work was active when background preparation started.
    ActiveWork,
    /// The physical PostgreSQL session was pinned by a transaction or explicit
    /// session pin.
    SessionPinned,
}

/// Result of preparing an opened database for app suspension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackgroundPreparationResult {
    /// True when an out-of-band cancellation request was sent for active work.
    pub cancelled_active_work: bool,
    /// True when a checkpoint completed.
    pub checkpointed: bool,
    /// Reason checkpointing was skipped.
    pub skipped_checkpoint_reason: Option<BackgroundCheckpointSkipReason>,
}

impl BackgroundPreparationResult {
    pub(crate) fn checkpointed() -> Self {
        Self {
            cancelled_active_work: false,
            checkpointed: true,
            skipped_checkpoint_reason: None,
        }
    }

    pub(crate) fn skipped(
        cancelled_active_work: bool,
        reason: Option<BackgroundCheckpointSkipReason>,
    ) -> Self {
        Self {
            cancelled_active_work,
            checkpointed: false,
            skipped_checkpoint_reason: reason,
        }
    }
}
