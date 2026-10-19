"""Freeze the two raw HTTP budgets and the official folder-batch wire bound."""
import json
from pathlib import Path
import re
import string
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def block(source, marker):
    """Extract one targeted brace-delimited block; not a general config parser."""
    start = source.index(marker) + len(marker)
    start = source.index("{", start)
    depth = 1
    for end in range(start + 1, len(source)):
        depth += (source[end] == "{") - (source[end] == "}")
        if depth == 0:
            return source[start + 1:end]
    raise ValueError("Unclosed block")


def nginx_source(source):
    return re.sub(r"(?m)#.*$", "", source)


def nginx_budget(source):
    # Only the immediate scope owns the default, not a nested location.
    depth = 0
    immediate = []
    for character in source:
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
        elif depth == 0:
            immediate.append(character)
    values = re.findall(r"\bclient_max_body_size\s+([^;]+);", "".join(immediate))
    if len(values) != 1:
        raise ValueError("Exactly one immediate body budget required")
    match = re.fullmatch(r"([1-9][0-9]*)([kKmMgG]?)", values[0].strip())
    if not match:
        raise ValueError("Finite positive body budget required")
    return int(match[1]) * 1024 ** {"": 0, "k": 1, "m": 2, "g": 3}[match[2].lower()]


def integer_constant(source, name):
    expression = re.search(r"\b" + name + r"\s*=\s*([^;]+);", source)[1]
    factors = expression.split("*")
    if not all(re.fullmatch(r"\s*[0-9]+(?:ULL|UL|U|LL|L)?\s*", x) for x in factors):
        raise ValueError("Unsupported constant expression")
    value = 1
    for factor in factors:
        value *= int(re.match(r"\s*([0-9]+)", factor)[1])
    return value


def canonical_folder_bound():
    """No giant fixture: sum compact JSON framing and semantic-admitted fields."""
    manager = read("backend/src/database/FolderManager.cpp")
    tree = read("frontend/src/app/features/drive/upload/folder-upload-tree.ts")
    coordinator = read("frontend/src/app/features/drive/upload/folder-upload-coordinator.service.ts")
    drive = read("frontend/src/app/features/drive/services/drive.service.ts")
    crypto = read("frontend/src/app/core/crypto/kasumi-crypto.service.ts")
    wrapper = read("frontend/src/app/core/crypto/crypto.service.ts")
    items = integer_constant(manager, "MAX_BATCH_FOLDERS")
    if integer_constant(tree, "FOLDER_BATCH_LIMIT") != items:
        raise ValueError("Folder count authority drift")
    if not re.search(r"(?m)^\s*referenceFactory:.*=\s*\(\)\s*=>\s*crypto.randomUUID\(\)\s*$", tree):
        raise ValueError("Re-derive the client_ref wire format")
    push = block(coordinator, "folders.push(")
    keys = re.findall(r"(?m)^\s*(\w+):", push)
    if keys != ["client_ref", "parent_client_ref", "encrypted_name", "name_hash"]:
        raise ValueError("Re-derive changed folder wire fields")
    expected_values = ["client_ref: node.clientRef", "parent_client_ref: node.parentClientRef",
                       "encrypted_name: await this.cryptoService.encryptName(node.name)",
                       "name_hash: await this.cryptoService.hashName(node.name)"]
    if re.sub(r"\s+", "", push) != re.sub(r"\s+", "", ",".join(expected_values) + ","):
        raise ValueError("Re-derive changed folder wire values")
    method = drive[drive.index("  batchCreateFolders("):drive.index("  uploadChunk(")]
    request = block(method, "`${environment.apiUrl}/folders/batch-create`,")
    if re.findall(r"(?m)^\s*(\w+)(?::[^\n]+)?,?\s*$", request) != ["root_parent_id", "folders"]:
        raise ValueError("Re-derive changed batch request framing")
    if re.sub(r"\s+", "", request) != "root_parent_id:rootParentId,folders,":
        raise ValueError("Re-derive root ID format")
    hash_method = block(crypto, "async hashName(")
    hash_bytes = int(re.search(r"crypto_generichash\((\d+),", hash_method)[1])
    encrypt_method = block(crypto, "async encryptName(")
    for method_body, variable in ((hash_method, "hash"), (encrypt_method, "result")):
        if not re.search(r"return\s+_sodium.to_base64\(" + variable + r",\s*_sodium.base64_variants.URLSAFE_NO_PADDING\);", method_body):
            raise ValueError("Re-derive Base64 escaping/padding")
    if "NONCE_SIZE + MAC_SIZE + encrypted.ciphertext.length" not in encrypt_method:
        raise ValueError("Re-derive encrypted-name record format")
    if "crypto_aead_xchacha20poly1305_ietf_encrypt_detached" not in encrypt_method:
        raise ValueError("Re-derive name cipher overhead")
    if not all(x in wrapper for x in ("return this.kasumi.encryptName(plaintext, this.vaultKey)",
                                      "return this.kasumi.hashName(plaintext)")):
        raise ValueError("Re-derive wrapper wire format")
    encrypted_bytes = integer_constant(manager, "MAX_ENCRYPTED_NAME_LENGTH")
    hash_wire_bytes = (hash_bytes * 8 + 5) // 6
    item = dict.fromkeys(keys, "")
    compact = lambda value: json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    item_framing = len(compact(item))
    # 20 decimal digits conservatively cover the backend uint64_t root identifier;
    # valid database IDs / their official JavaScript number representation fit.
    outer_framing = len(compact({"root_parent_id": 2**64 - 1, "folders": []}))
    item_bytes = item_framing + 36 + 36 + encrypted_bytes + hash_wire_bytes
    maximum = outer_framing + items * item_bytes + items - 1
    return {"items": items, "clientRefBytes": 36, "parentRefBytes": 36,
            "encryptedNameBytes": encrypted_bytes, "nameHashBytes": hash_wire_bytes,
            "nonceBytes": integer_constant(crypto, "NONCE_SIZE"),
            "macBytes": integer_constant(crypto, "MAC_SIZE"),
            "itemFramingBytes": item_framing, "outerFramingBytes": outer_framing,
            "upperBoundBytes": maximum, "marginBytes": 64 * 1024 * 1024 - maximum}


class HttpBodyPolicyTests(unittest.TestCase):
    def test_changed_canonical_wire_shapes_require_a_new_derivation(self):
        original_read = read
        changes = [
            ("frontend/src/app/features/drive/upload/folder-upload-tree.ts", "crypto.randomUUID()", "crypto.randomUUID() + '-extra'"),
            ("frontend/src/app/core/crypto/kasumi-crypto.service.ts", "return _sodium.to_base64(hash, _sodium.base64_variants.URLSAFE_NO_PADDING);", "return _sodium.to_base64(hash, _sodium.base64_variants.URLSAFE_NO_PADDING).repeat(2);"),
            ("frontend/src/app/features/drive/services/drive.service.ts", "      folders,", "      folders,\n      ...metadata,"),
            ("frontend/src/app/features/drive/upload/folder-upload-coordinator.service.ts", "name_hash: await this.cryptoService.hashName(node.name),", "name_hash: await this.cryptoService.hashName(node.name),\n        ...metadata,"),
        ]
        for path, old, new in changes:
            def changed_read(relative):
                value = original_read(relative)
                return value.replace(old, new) if relative == path else value
            with self.subTest(path=path), patch(__name__ + ".read", side_effect=changed_read):
                with self.assertRaises(ValueError):
                    canonical_folder_bound()

    def test_nginx_budget_parser_rejects_missing_zero_comments_and_conflicts(self):
        self.assertEqual(nginx_budget(nginx_source("client_max_body_size 16m;")), 16 * 1024 * 1024)
        for source in ("", "client_max_body_size 0;", "# client_max_body_size 16m;",
                       "client_max_body_size bad;", "client_max_body_size 16m; client_max_body_size 64m;"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                nginx_budget(nginx_source(source))

    def test_proxies_have_default_and_exact_folder_budgets_with_correct_uris(self):
        for path, upstream in (("deploy/nginx/nanika.conf", "http://127.0.0.1:6742"),
                               ("frontend/nginx.conf", "http://backend:8080/folders/batch-create")):
            with self.subTest(path=path):
                source = nginx_source(read(path))
                server = block(source, "server")
                self.assertEqual(nginx_budget(server), 16 * 1024 * 1024)
                self.assertNotRegex(source, r"client_max_body_size\s+0\s*;")
                special = block(server, "location = /backend/folders/batch-create")
                self.assertEqual(nginx_budget(special), 64 * 1024 * 1024)
                self.assertEqual(re.findall(r"proxy_pass\s+([^;]+);", special), [upstream])
                ordinary = block(server, "location /" if path.startswith("deploy/") else "location /backend/")
                self.assertEqual(re.findall(r"proxy_set_header\s+([^;]+);", special),
                                 re.findall(r"proxy_set_header\s+([^;]+);", ordinary))
                self.assertIn("proxy_http_version 1.1;", special)
                if path.startswith("deploy/"):
                    self.assertIn("proxy_request_buffering off;", special)

    def test_backend_budgets_and_composition_match_proxy_authority(self):
        policy = read("backend/include/middlewares/HttpBodyLimitMiddleware.hpp")
        self.assertEqual(integer_constant(policy, "DEFAULT_BODY_LIMIT_BYTES"), 16 * 1024 * 1024)
        self.assertEqual(integer_constant(policy, "FOLDER_BATCH_BODY_LIMIT_BYTES"), 64 * 1024 * 1024)
        self.assertIn('req.url == "/folders/batch-create"', policy)
        self.assertIn("req.method == crow::HTTPMethod::Post", policy)
        self.assertIn("req.body.size()", policy)
        self.assertNotIn("Content-Length", policy)
        header = read("backend/include/controllers/ApiRouter.hpp")
        self.assertRegex(header, r"using NanikaCrowApp = crow::App<\s*CustomCorsMiddleware,\s*HttpBodyLimitMiddleware,\s*RateLimitMiddleware\s*>")
        self.assertIn("NanikaCrowApp app;", read("backend/src/main.cpp"))
        self.assertIn("setup_routes(NanikaCrowApp& app)", header)
        self.assertIn("setup_routes(NanikaCrowApp& app)", read("backend/src/controllers/ApiRouter.cpp"))

    def test_canonical_producer_fits_special_budget_without_json_escape_expansion(self):
        bound = canonical_folder_bound()
        self.assertEqual(bound["items"], 1000)
        self.assertEqual(bound["nameHashBytes"], 43)
        self.assertLess(bound["upperBoundBytes"], 64 * 1024 * 1024)
        self.assertGreaterEqual(bound["marginBytes"], 1024 * 1024)
        alphabet = string.ascii_letters + string.digits + "-_"
        self.assertEqual(json.dumps(alphabet), '"' + alphabet + '"')
        self.assertEqual((49112 + bound["nonceBytes"] + bound["macBytes"]) * 8 // 6, bound["encryptedNameBytes"])

    def test_chunks_and_loopback_publication_remain_inside_the_default_envelope(self):
        self.assertEqual(integer_constant(read("backend/include/storage/FileChunker.hpp"), "MAX_CHUNK_SIZE"), 4 * 1024 * 1024)
        self.assertLess(4 * 1024 * 1024, 16 * 1024 * 1024)
        compose = read("docker-compose.yml")
        self.assertIn('"127.0.0.1:8080:8080"', compose)
        self.assertIn('"127.0.0.1:${FRONTEND_PORT:-6742}:80"', compose)


if __name__ == "__main__":
    unittest.main()
