import re
import unittest
from pathlib import Path


SWAGGER = Path(__file__).resolve().parents[2] / "docs" / "swagger.yaml"


def schema_block(source, name):
    match = re.search(
        rf"^    {re.escape(name)}:\n(?P<body>.*?)(?=^    [A-Za-z0-9_]+:\n|\Z)",
        source,
        re.MULTILINE | re.DOTALL,
    )
    if not match:
        raise AssertionError(f"schema not found: {name}")
    return match.group("body")


def path_block(source, path):
    match = re.search(
        rf"^  {re.escape(path)}:\n(?P<body>.*?)(?=^  /|\Z)",
        source,
        re.MULTILINE | re.DOTALL,
    )
    if not match:
        raise AssertionError(f"path not found: {path}")
    return match.group("body")


class OpenApiBatchInitContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SWAGGER.read_text(encoding="utf-8")

    def test_batch_request_is_batch_specific(self):
        item = schema_block(self.source, "BatchInitUploadItemRequest")
        self.assertIn("$ref: '#/components/schemas/InitUploadRequest'", item)
        self.assertRegex(item, r"required:\s*\[client_ref\]")
        self.assertRegex(item, r"client_ref:\n\s+type: string\n\s+minLength: 1\n\s+maxLength: 128")

        batch = schema_block(self.source, "BatchInitUploadRequest")
        self.assertRegex(batch, r"required:\s*\[files\]")
        self.assertIn("$ref: '#/components/schemas/BatchInitUploadItemRequest'", batch)
        self.assertRegex(batch, r"minItems: 1")
        self.assertRegex(batch, r"maxItems: 100")

    def test_batch_response_documents_client_ref(self):
        response = schema_block(self.source, "BatchInitUploadItemResponse")
        self.assertRegex(response, r"required:\s*\[client_ref, file_id, name_hash, storage_provider\]")
        self.assertRegex(response, r"client_ref:\n\s+type: string\n\s+minLength: 1\n\s+maxLength: 128")

    def test_single_upload_does_not_require_client_ref(self):
        request = schema_block(self.source, "InitUploadRequest")
        required = re.search(r"^      required: \[(.*?)\]", request, re.MULTILINE)
        self.assertIsNotNone(required)
        self.assertNotIn("client_ref", required.group(1))

    def test_batch_endpoint_documents_insufficient_google_capacity(self):
        self.assertRegex(path_block(self.source, "/files/batch-init"), r"['\"]507['\"]:")

    def test_local_chunk_upload_documents_runtime_validation(self):
        chunks = path_block(self.source, "/files/{fileId}/chunks")
        self.assertRegex(chunks, r"(?m)^    post:$")
        self.assertRegex(chunks, r"name: X-Chunk-Index\n\s+in: header\n\s+required: true")
        self.assertIn("application/octet-stream", chunks)
        self.assertRegex(
            chunks,
            r"'400':\n\s+description:.*(índice inválido|tamanho incompatível)",
        )

    def test_google_external_lifecycle_conflicts_are_documented(self):
        unlink = path_block(self.source, "/api/storage/google/accounts/{accountId}")
        self.assertRegex(unlink, r"['\"]409['\"]:")
        self.assertRegex(unlink, r"(?i)uploads Google pendentes")

        finalize = path_block(self.source, "/files/{fileId}/finalize-external")
        self.assertRegex(finalize, r"['\"]409['\"]:")
        self.assertRegex(finalize, r"(?i)conflito no ciclo de vida")


if __name__ == "__main__":
    unittest.main()
