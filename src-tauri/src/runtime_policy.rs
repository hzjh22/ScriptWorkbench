#[derive(Debug, PartialEq)]
pub(crate) enum ConcurrencyAction {
    Proceed,
    Reject,
    StopExisting,
}

pub(crate) fn concurrency_action(policy: &str, active_count: usize) -> ConcurrencyAction {
    if active_count == 0 {
        return ConcurrencyAction::Proceed;
    }
    match policy {
        "reject" => ConcurrencyAction::Reject,
        "stop_existing" => ConcurrencyAction::StopExisting,
        _ => ConcurrencyAction::Proceed,
    }
}

pub(crate) fn should_retry(attempt: u32, retry_count: u32, manually_stopped: bool) -> bool {
    !manually_stopped && attempt <= retry_count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_second_run_when_policy_requires_single_instance() {
        assert_eq!(concurrency_action("reject", 1), ConcurrencyAction::Reject);
    }

    #[test]
    fn stop_existing_policy_replaces_active_runs() {
        assert_eq!(
            concurrency_action("stop_existing", 2),
            ConcurrencyAction::StopExisting
        );
    }

    #[test]
    fn retry_budget_counts_additional_attempts_and_never_retries_manual_stops() {
        assert!(should_retry(1, 1, false));
        assert!(!should_retry(2, 1, false));
        assert!(!should_retry(1, 3, true));
    }
}
