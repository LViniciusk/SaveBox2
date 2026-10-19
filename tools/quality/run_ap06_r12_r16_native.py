"""Bounded R12-R16 MemoryInfra parser entrypoint and controlled capability runner."""
from pathlib import Path
import sys

from prepare_ap06_r12_r13 import verify_historical_factorial
import prepare_ap06_r12_r13 as prepare_engine
import run_ap06_r12_r13_native as runner_engine

CAMPAIGN = 'AP-06-R12-R16-native'
OUTPUT = '.quality/readiness-wave12-r16-native'
TASK_PATH = 'quality/ap06-r12-r16.md'
RUNNER_PATH = Path(__file__).resolve()

R16_BUDGET = {
    'capability': 1,
    'profiledA': 0,
    'profiledB': 0,
    'maximum': 1,
    'retries': 0,
}

prepare_engine.configure_campaign(CAMPAIGN, OUTPUT, TASK_PATH, budget=R16_BUDGET)
runner_engine.configure_campaign(CAMPAIGN, OUTPUT, TASK_PATH, RUNNER_PATH, budget=R16_BUDGET)

prepare = runner_engine.prepare
freeze_r16 = runner_engine.freeze_campaign
freeze_campaign = runner_engine.freeze_campaign
verify_frozen_campaign = runner_engine.verify_frozen_campaign
run_capability = runner_engine.run_capability
validate_trace = runner_engine.validate_trace
offline_preflight = runner_engine.offline_preflight
scan_staged_changes = runner_engine.scan_staged_changes
execution_state = runner_engine.execution_state
stop_and_verify_backend_cleanup = runner_engine.stop_and_verify_backend_cleanup
record_durable_stop = runner_engine.record_durable_stop
NativeContractFailure = runner_engine.NativeContractFailure
publish_inconclusive_decision = runner_engine.publish_inconclusive_decision
publish_capability_pass_decision = runner_engine.publish_capability_pass_decision
validate_scientific_authorization = runner_engine.validate_scientific_authorization
capture_capability_once = runner_engine.capture_capability_once
main = runner_engine.main

if __name__ == '__main__':
    sys.exit(main())
