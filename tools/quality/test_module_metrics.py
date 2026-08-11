"""Stdlib regression tests for function-level complexity reporting."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent))
from module_metrics import metric  # noqa: E402


class ModuleMetricsTests(unittest.TestCase):
    def test_complexity_is_the_maximum_of_individual_functions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "frontend" / "src" / "app" / "sample.ts"
            source.parent.mkdir(parents=True)
            source.write_text(
                """
                export function simple(): number { return 1; }

                export function branched(value: number): number {
                  if (value > 0) {
                    return value;
                  }
                  if (value < -1) {
                    return -value;
                  }
                  return 0;
                }
                """,
                encoding="utf-8",
            )

            result = metric("frontend", source, root)

            complexities = [item["cyclomatic_complexity"] for item in result["functions"]]
            self.assertEqual(result["function_count"], 2)
            self.assertEqual(result["max_cyclomatic_complexity"], max(complexities))
            self.assertGreater(result["max_cyclomatic_complexity"], 1)
            self.assertNotEqual(result["max_cyclomatic_complexity"], sum(complexities))


if __name__ == "__main__":
    unittest.main()
