"""Independent R11-R2 namespace and authorization, sharing the R11 runner."""
from pathlib import Path
import run_ap06_r11 as r11

if __name__=='__main__':
    r11.OUTPUT='.quality/readiness-wave11-r2'
    r11.CAMPAIGN='AP-06-R11-R2'
    r11.PUBLISHER=Path(__file__)
    raise SystemExit(r11.main())
