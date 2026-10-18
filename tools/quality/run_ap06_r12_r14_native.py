"""Bounded R12-R14 MemoryInfra parser entrypoint and independent capability runner."""
from pathlib import Path
import sys

from prepare_ap06_r12_r13 import NATIVE_BUDGET, verify_historical_factorial
import prepare_ap06_r12_r13 as prepare_engine
import run_ap06_r12_r13_native as runner_engine

CAMPAIGN = 'AP-06-R12-R14-native'
OUTPUT = '.quality/readiness-wave12-r14-native'
TASK_PATH = 'quality/ap06-r12-r14.md'
RUNNER_PATH = Path(__file__).resolve()

prepare_engine.configure_campaign(CAMPAIGN, OUTPUT, TASK_PATH)
runner_engine.configure_campaign(CAMPAIGN, OUTPUT, TASK_PATH, RUNNER_PATH)

prepare = runner_engine.prepare
freeze_r14 = runner_engine.freeze_campaign
freeze_campaign = runner_engine.freeze_campaign
verify_frozen_campaign = runner_engine.verify_frozen_campaign
run_capability = runner_engine.run_capability
validate_trace = runner_engine.validate_trace
offline_preflight = runner_engine.offline_preflight
scan_staged_changes = runner_engine.scan_staged_changes
execution_state = runner_engine.execution_state
stop_and_verify_backend_cleanup = runner_engine.stop_and_verify_backend_cleanup
record_durable_stop = runner_engine.record_durable_stop
main = runner_engine.main

if __name__ == '__main__':
    sys.exit(main())
