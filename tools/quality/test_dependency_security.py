"""Fast, offline dependency invariants for the Angular 20 frontend."""

from __future__ import annotations

import json
import re
import unittest
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
PACKAGE_JSON = FRONTEND / "package.json"
PACKAGE_LOCK = FRONTEND / "package-lock.json"

FRAMEWORK_PACKAGES = (
    "@angular/common",
    "@angular/compiler",
    "@angular/core",
    "@angular/forms",
    "@angular/platform-browser",
    "@angular/router",
    "@angular/compiler-cli",
)
ANGULAR_FLOOR = (20, 3, 31)
ANGULAR_TOOLING_PACKAGES = ("@angular/build", "@angular/cli")
FORBIDDEN_SSR_PACKAGES = ("@angular/platform-server", "@angular/ssr")


@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int


def parse_version(value: str) -> Version:
    match = re.fullmatch(r"[~^= ]*(\d+)\.(\d+)\.(\d+)", value)
    if not match:
        raise ValueError(f"unsupported stable semver: {value!r}")
    return Version(*(int(part) for part in match.groups()))


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def manifest_spec(manifest: dict, package: str) -> str:
    return manifest.get("dependencies", {}).get(package) or manifest.get("devDependencies", {}).get(package) or ""


def lock_entries(lockfile: dict, package: str) -> list[tuple[str, dict]]:
    suffix = f"node_modules/{package}"
    return [(key, value) for key, value in lockfile.get("packages", {}).items() if key == suffix or key.endswith(f"/{suffix}")]


class DependencySecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = read_json(PACKAGE_JSON)
        cls.lockfile = read_json(PACKAGE_LOCK)

    def test_framework_manifest_ranges_start_at_approved_angular_20_floor(self) -> None:
        floor = Version(*ANGULAR_FLOOR)
        for package in FRAMEWORK_PACKAGES:
            with self.subTest(package=package):
                spec = manifest_spec(self.manifest, package)
                version = parse_version(spec)
                self.assertEqual(version.major, 20)
                self.assertGreaterEqual(version, floor)

    def test_lockfile_contains_only_angular_20_framework_versions_at_or_above_floor(self) -> None:
        floor = Version(*ANGULAR_FLOOR)
        for package in FRAMEWORK_PACKAGES:
            entries = lock_entries(self.lockfile, package)
            self.assertTrue(entries, f"missing lockfile entry for {package}")
            for location, entry in entries:
                with self.subTest(package=package, location=location):
                    version = parse_version(entry["version"])
                    self.assertEqual(version.major, 20)
                    self.assertGreaterEqual(version, floor)
                    self.assertTrue(entry.get("resolved", "").startswith("https://registry.npmjs.org/"))
                    self.assertTrue(entry.get("integrity"))

    def test_angular_tooling_stays_on_major_20(self) -> None:
        for package in ANGULAR_TOOLING_PACKAGES:
            with self.subTest(package=package):
                entries = lock_entries(self.lockfile, package)
                self.assertTrue(entries, f"missing lockfile entry for {package}")
                self.assertTrue(all(parse_version(entry["version"]).major == 20 for _, entry in entries))

    def test_compiler_cli_remains_a_development_dependency(self) -> None:
        self.assertIn("@angular/compiler-cli", self.manifest.get("devDependencies", {}))
        self.assertNotIn("@angular/compiler-cli", self.manifest.get("dependencies", {}))

    def test_frontend_does_not_introduce_ssr_or_zone_runtime(self) -> None:
        for package in FORBIDDEN_SSR_PACKAGES:
            self.assertNotIn(package, self.manifest.get("dependencies", {}))
            self.assertNotIn(package, self.manifest.get("devDependencies", {}))
            self.assertFalse(lock_entries(self.lockfile, package), f"unexpected lock entry for {package}")

        app_config = (FRONTEND / "src" / "app" / "app.config.ts").read_text(encoding="utf-8")
        self.assertIn("provideZonelessChangeDetection()", app_config)

    def test_lockfile_root_specs_match_manifest(self) -> None:
        root = self.lockfile["packages"][""]
        for section in ("dependencies", "devDependencies"):
            for package, spec in self.manifest.get(section, {}).items():
                with self.subTest(section=section, package=package):
                    self.assertEqual(root.get(section, {}).get(package), spec)


if __name__ == "__main__":
    unittest.main()
