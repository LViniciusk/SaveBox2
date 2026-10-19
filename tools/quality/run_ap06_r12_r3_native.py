"""R12-R3 native entry, gated by the newly attested factorial authority."""
from pathlib import Path
import run_ap06_r12_r2_native as native

if __name__=='__main__':
    native.configure_campaign('.quality/readiness-wave12-r3-native',Path(__file__))
    raise SystemExit(native.main())
