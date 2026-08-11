"""Verificações estruturais mínimas da documentação D.1."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"

REQUIRED_DOCUMENTS = (
    "docs/README.md",
    "docs/glossario.md",
    "docs/arquitetura/README.md",
    "docs/arquitetura/visao-geral.md",
    "docs/arquitetura/frontend.md",
    "docs/arquitetura/backend.md",
    "docs/arquitetura/deployment.md",
    "docs/fluxos/README.md",
    "docs/seguranca/README.md",
    "docs/dados/README.md",
    "docs/api/README.md",
    "docs/operacoes/README.md",
    "docs/qualidade/README.md",
    "docs/decisoes/README.md",
)

SUBSTANTIVE_DOCUMENTS = (
    "docs/arquitetura/visao-geral.md",
    "docs/arquitetura/frontend.md",
    "docs/arquitetura/backend.md",
    "docs/arquitetura/deployment.md",
)

MARKDOWN_LINK = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
PLACEHOLDER = re.compile(r"\b(?:TODO|TBD|Lorem ipsum)\b", re.IGNORECASE)
WINDOWS_USER_PATH = re.compile(r"[A-Za-z]:\\Users\\")
AUTHORITY_HEADING = "## Fontes de autoridade no repositório"
CODE_SPAN = re.compile(r"`([^`\n]+)`")
ROOT_FILES = {"Dockerfile", "README.md", ".env.example"}


def extract_authority_section(content: str) -> str:
    start = content.find(AUTHORITY_HEADING)
    if start == -1:
        return ""

    body_start = start + len(AUTHORITY_HEADING)
    next_heading = re.search(r"^##\s+", content[body_start:], re.MULTILINE)
    if next_heading:
        return content[body_start : body_start + next_heading.start()]
    return content[body_start:]


class DocumentationStructureTests(unittest.TestCase):
    def test_required_documents_exist(self):
        for relative_path in REQUIRED_DOCUMENTS:
            with self.subTest(path=relative_path):
                self.assertTrue((ROOT / relative_path).is_file())

    def test_portal_navigates_to_all_areas(self):
        portal = (ROOT / "docs/README.md").read_text(encoding="utf-8")
        expected_links = (
            "arquitetura/README.md",
            "fluxos/README.md",
            "seguranca/README.md",
            "dados/README.md",
            "api/README.md",
            "operacoes/README.md",
            "qualidade/README.md",
            "decisoes/README.md",
        )
        for link in expected_links:
            with self.subTest(link=link):
                self.assertIn(link, portal)
                self.assertTrue((DOCS / link).is_file())

    def test_local_markdown_links_resolve(self):
        documents = [ROOT / relative_path for relative_path in REQUIRED_DOCUMENTS]
        for document in documents:
            content = document.read_text(encoding="utf-8")
            for raw_target in MARKDOWN_LINK.findall(content):
                target = raw_target.strip().split("#", 1)[0]
                if not target or target.startswith(("http://", "https://", "mailto:")):
                    continue
                target = target.strip("<>").split("?", 1)[0]
                with self.subTest(document=document, target=target):
                    self.assertTrue((document.parent / target).is_file())

    def test_root_readme_and_openapi_contract_references(self):
        root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
        api_readme = (ROOT / "docs/api/README.md").read_text(encoding="utf-8")

        self.assertIn("docs/README.md", root_readme)
        self.assertIn("../swagger.yaml", api_readme)
        self.assertTrue((DOCS / "swagger.yaml").is_file())

    def test_substantive_documents_have_boundaries(self):
        required_sections = (
            "Status documental",
            "Fontes de autoridade no repositório",
            "Fora do escopo",
        )
        for relative_path in SUBSTANTIVE_DOCUMENTS:
            content = (ROOT / relative_path).read_text(encoding="utf-8")
            with self.subTest(path=relative_path):
                for section in required_sections:
                    self.assertIn(section, content)
                self.assertIsNone(PLACEHOLDER.search(content))

    def test_new_documents_contain_no_local_windows_user_path(self):
        for relative_path in REQUIRED_DOCUMENTS:
            content = (ROOT / relative_path).read_text(encoding="utf-8")
            with self.subTest(path=relative_path):
                self.assertIsNone(WINDOWS_USER_PATH.search(content))

    def test_documented_source_authorities_exist(self):
        for relative_path in REQUIRED_DOCUMENTS:
            content = (ROOT / relative_path).read_text(encoding="utf-8")
            section = extract_authority_section(content)
            for candidate in CODE_SPAN.findall(section):
                candidate = candidate.strip()
                if any(char in candidate for char in "*?["):
                    continue
                if "/" not in candidate and candidate not in ROOT_FILES:
                    continue
                with self.subTest(document=relative_path, path=candidate):
                    self.assertTrue(
                        (ROOT / candidate).exists(),
                        f"{relative_path}: source authority does not exist: {candidate}",
                    )


if __name__ == "__main__":
    unittest.main()
