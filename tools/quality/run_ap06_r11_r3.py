"""AP-06 R11-R3: independent renderer attribution campaign."""
from pathlib import Path
import run_ap06_r11 as r11

if __name__ == '__main__':
    r11.OUTPUT='.quality/readiness-wave11-r3'
    r11.CAMPAIGN='AP-06-R11-R3'
    r11.PUBLISHER=Path(__file__).resolve()
    raise SystemExit(r11.main())
