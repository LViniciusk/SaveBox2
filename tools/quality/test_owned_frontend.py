"""Additional checks for the shared owned-frontend authority."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).parent))
import owned_frontend as owner  # noqa: E402


class OwnedFrontendTests(unittest.TestCase):
    def test_preferred_url_is_only_a_local_ipv4_authority(self) -> None:
        self.assertEqual(owner.preferred_frontend_port("http://127.0.0.1:4200"), 4200)
        self.assertEqual(owner.preferred_frontend_port("http://localhost:4300"), 4300)
        for url in (
            "https://127.0.0.1:4200",
            "http://[::1]:4200",
            "http://0.0.0.0:4200",
            "http://user@127.0.0.1:4200",
            "http://127.0.0.1:4200/",
            "http://127.0.0.1:4200/path",
            "http://127.0.0.1:4200?x=1",
            "http://127.0.0.1:4200?",
            "http://127.0.0.1:4200#",
            "http://127.0.0.1",
        ):
            with self.subTest(url=url), self.assertRaises(owner.FrontendOwnershipFailure) as error:
                owner.preferred_frontend_port(url)
            self.assertEqual(error.exception.code, "FRONTEND_PREFERENCE_INVALID")

    def test_tooling_resolution_uses_the_local_angular_cli(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cli = root / "frontend" / "node_modules" / "@angular" / "cli" / "bin" / "ng.js"
            cli.parent.mkdir(parents=True)
            cli.write_text("// local cli", encoding="utf-8")
            node, resolved_cli = owner.resolve_frontend_tooling(root, which=mock.Mock(return_value="node.exe"))
            self.assertEqual(node, "node.exe")
            self.assertEqual(resolved_cli, cli)

    def test_tooling_resolution_fails_closed_when_node_or_cli_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(owner.FrontendOwnershipFailure) as no_node:
                owner.resolve_frontend_tooling(root, which=mock.Mock(return_value=None))
            self.assertEqual(no_node.exception.code, "FRONTEND_NODE_UNAVAILABLE")
            with self.assertRaises(owner.FrontendOwnershipFailure) as no_cli:
                owner.resolve_frontend_tooling(root, node_path="node.exe")
            self.assertEqual(no_cli.exception.code, "FRONTEND_TOOLING_UNAVAILABLE")

    def test_owner_does_not_use_global_process_termination_commands(self) -> None:
        source = Path(owner.__file__).read_text(encoding="utf-8").lower()
        for forbidden in ("taskkill", "pkill", "killall"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
