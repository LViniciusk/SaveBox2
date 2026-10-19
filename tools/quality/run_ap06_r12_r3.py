"""R12-R3 campaign entry: reuse the frozen factorial contract with binary attestation."""
from pathlib import Path
import run_ap06_r12_r2 as factorial

if __name__=='__main__':
    factorial.configure_campaign('.quality/readiness-wave12-r3-factorial',Path(__file__),'AP-06-R12-R3-factorial')
    raise SystemExit(factorial.main())
