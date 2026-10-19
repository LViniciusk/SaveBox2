import re
import json
import hashlib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class DeploymentSecurityTests(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_swagger_has_its_own_local_only_browser_policy(self):
        router = self.read('backend/src/controllers/ApiRouter.cpp')
        docs = router.split('void ApiRouter::setup_routes(', 1)[1].split('CROW_ROUTE(app, "/health")', 1)[0]
        self.assertNotIn('https://', docs)
        self.assertNotIn('<script>', docs)
        self.assertNotIn('window.onload', docs)
        self.assertNotIn('onload=', docs)
        self.assertIn('Content-Security-Policy', docs)
        for directive in ["default-src 'none'", "script-src 'self'", "style-src 'self'",
                          "connect-src 'self'", "base-uri 'none'", "object-src 'none'",
                          "frame-ancestors 'none'", "form-action 'none'"]:
            self.assertIn(directive, docs)
        for forbidden in ['unsafe-inline', 'unsafe-eval', 'https:', '/assets/<path>', '/assets/<string>']:
            self.assertNotIn(forbidden, docs)
        for asset in ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-init.js']:
            self.assertIn('"/api/docs/assets/' + asset + '"', docs)
        self.assertIn('"/api/docs<path>"', docs)
        self.assertIn('if (suffix != "/") return crow::response(404);', docs)
        init = self.read('docs/swagger-ui/swagger-init.js')
        self.assertIn('window.location.pathname', init)
        self.assertIn('swagger.yaml', init)
        self.assertNotIn('https://', init)
        self.assertIn('validatorUrl: null', init)

    def test_swagger_vendored_integrity_and_production_packaging(self):
        provenance = json.loads(self.read('docs/swagger-ui/provenance.json'))
        self.assertEqual(provenance['repository'], 'https://github.com/swagger-api/swagger-ui')
        self.assertRegex(provenance['commit'], r'^[a-f0-9]{40}$')
        self.assertRegex(provenance['version'], r'^5\.\d+\.\d+$')
        for name in ['swagger-ui-bundle.js', 'swagger-ui.css', 'LICENSE', 'NOTICE']:
            record = provenance['files'][name]
            self.assertTrue(record['source'].startswith('https://raw.githubusercontent.com/swagger-api/swagger-ui/' + provenance['commit'] + '/'))
            self.assertEqual(hashlib.sha256((ROOT / 'docs/swagger-ui' / name).read_bytes()).hexdigest(), record['sha256'])
            self.assertIn(name + ' -text', self.read('docs/swagger-ui/.gitattributes').splitlines())
        self.assertIn('COPY --from=builder /src/docs /app/docs', self.read('Dockerfile'))
        self.assertNotIn('docs', self.read('.dockerignore').splitlines())

    def test_spa_browser_policy_is_narrow_and_does_not_cover_backend_docs(self):
        nginx = self.read('frontend/nginx.conf')
        match = re.search(r'location\s+/\s*\{([^{}]*)\}', nginx)
        self.assertIsNotNone(match, 'SPA location required')
        spa = match[1]
        headers = dict(re.findall(r'add_header\s+([\w-]+)\s+"([^"]+)"\s+always\s*;', spa))
        self.assertIn('Content-Security-Policy', headers)
        policy = {}
        for directive in headers['Content-Security-Policy'].split(';'):
            words = directive.split()
            if words:
                self.assertNotIn(words[0], policy, 'Duplicate CSP directive')
                policy[words[0]] = set(words[1:])
        for key, value in {'default-src': {"'self'"}, 'base-uri': {"'self'"}, 'object-src': {"'none'"},
                           'frame-ancestors': {"'none'"}, 'form-action': {"'self'"}}.items():
            self.assertEqual(policy[key], value)
        self.assertNotIn("'unsafe-inline'", policy['script-src'])
        self.assertNotIn("'unsafe-eval'", policy['script-src'])
        self.assertIn("'wasm-unsafe-eval'", policy['script-src'])
        self.assertEqual(policy['connect-src'], {"'self'", 'https://upload.nanika.lvinik.app', 'https://www.googleapis.com'})
        for values in policy.values():
            self.assertNotIn('*', values); self.assertNotIn('https:', values)
        self.assertEqual(policy['media-src'], {"'self'", 'blob:'})
        self.assertEqual(policy['worker-src'], {"'self'", 'blob:'})
        self.assertEqual(policy['img-src'], {"'self'", 'data:', 'blob:', 'https://i.imgur.com', 'https://lh3.googleusercontent.com'})
        self.assertEqual(policy['font-src'], {"'self'", 'https://fonts.gstatic.com'})
        self.assertEqual(policy['style-src'], {"'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'})
        for key, values in policy.items():
            if key != 'style-src': self.assertNotIn('https://fonts.googleapis.com', values)
            if key != 'font-src': self.assertNotIn('https://fonts.gstatic.com', values)
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertEqual(headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
        outside_spa = nginx[:match.start()] + nginx[match.end():]
        self.assertNotIn('Content-Security-Policy', outside_spa)
        self.assertIn('location /backend/', outside_spa)
        self.assertNotIn('cdnjs.cloudflare.com', nginx)
        self.assertNotIn('Strict-Transport-Security', nginx)
        self.assertNotIn('X-XSS-Protection', nginx)

    def test_production_styles_do_not_generate_inline_script_handlers(self):
        production = json.loads(self.read('frontend/angular.json'))['projects']['frontend']['architect']['build']['configurations']['production']
        self.assertIs(production.get('optimization', {}).get('styles', {}).get('inlineCritical'), False,
                      'Angular critical-style optimization emits an inline onload handler that CSP blocks')

    def service_block(self, compose: str, service: str) -> str:
        lines = compose.splitlines()
        marker = f"  {service}:"
        try:
            start = lines.index(marker)
        except ValueError:
            self.fail(f"Missing Compose service: {service}")

        block: list[str] = []
        for line in lines[start + 1:]:
            if line.startswith("  ") and not line.startswith("    ") and line.rstrip().endswith(":"):
                break
            block.append(line)
        return "\n".join(block)

    def test_compose_keeps_api_and_frontend_ports_loopback_only(self) -> None:
        compose = self.read("docker-compose.yml")
        self.assertIn('"127.0.0.1:8080:8080"', compose)
        self.assertIn('"127.0.0.1:${FRONTEND_PORT:-6742}:80"', compose)
        self.assertNotIn('"8080:8080"', compose)
        self.assertNotIn('"${FRONTEND_PORT:-6742}:80"', compose)
        self.assertIn("TRUST_PROXY_HEADERS: ${TRUST_PROXY_HEADERS:-false}", compose)
        self.assertIn("NANIKA_BIND_ADDRESS: ${NANIKA_BIND_ADDRESS:-0.0.0.0}", compose)

    def test_postgres_remains_internal_to_compose_network(self) -> None:
        compose = self.read("docker-compose.yml")
        postgres = self.service_block(compose, "postgres-db")
        backend = self.service_block(compose, "backend")

        self.assertNotRegex(postgres, r"(?m)^\s{4}ports:\s*$")
        self.assertNotIn("docker-compose.test.yml", compose)
        self.assertIn("- nanika_network", postgres)
        self.assertIn("DB_HOST: postgres-db", backend)
        self.assertIn("DB_PORT: 5432", backend)

    def test_local_test_compose_exposes_postgres_on_loopback_only(self) -> None:
        override = self.read("docker-compose.test.yml")
        self.assertIn("postgres-db:", override)
        self.assertIn('"127.0.0.1:5433:5432"', override)
        self.assertNotIn('"5433:5432"', override)
        self.assertNotIn("0.0.0.0", override)
        self.assertNotIn("[::]", override)
        for secret_key in ("DB_PASSWORD", "PASS_PEPPER", "NANIKA_JWT_SECRET", "GOOGLE_CLIENT_SECRET"):
            self.assertNotIn(secret_key, override)

    def test_host_nginx_canonicalizes_only_at_the_trusted_local_boundary(self) -> None:
        nginx = self.read("deploy/nginx/nanika.conf")
        self.assertIn("set_real_ip_from 127.0.0.1;", nginx)
        self.assertIn("set_real_ip_from ::1;", nginx)
        self.assertIn("real_ip_header CF-Connecting-IP;", nginx)
        self.assertIn("real_ip_recursive on;", nginx)
        self.assertIn("proxy_set_header X-Real-IP $remote_addr;", nginx)
        self.assertIn("proxy_set_header X-Forwarded-For $remote_addr;", nginx)
        self.assertIn("proxy_set_header CF-Connecting-IP $remote_addr;", nginx)
        self.assertNotIn("$proxy_add_x_forwarded_for", nginx)

    def test_frontend_proxy_preserves_the_canonical_header(self) -> None:
        nginx = self.read("frontend/nginx.conf")
        self.assertIn("proxy_set_header X-Real-IP $http_x_real_ip;", nginx)
        self.assertIn("proxy_set_header CF-Connecting-IP $http_x_real_ip;", nginx)

    def test_upload_stays_outside_the_cloudflare_tunnel(self) -> None:
        cloudflared = self.read("deploy/cloudflared/config.yml.example")
        self.assertNotIn("upload.nanika.lvinik.app", cloudflared)

    def test_proxy_trust_default_is_fail_closed_and_documented(self) -> None:
        env_example = self.read(".env.example")
        readme = self.read("deploy/README.md")
        self.assertIn("TRUST_PROXY_HEADERS=false", env_example)
        self.assertIn("TRUST_PROXY_HEADERS=true", readme)
        self.assertIn("127.0.0.1:8080", readme)

    def test_backend_image_freezes_non_root_identity_and_storage_boundary(self) -> None:
        dockerfile = self.read("Dockerfile")
        self.assertIn("groupadd", dockerfile)
        self.assertIn("--gid 10001", dockerfile)
        self.assertIn("useradd", dockerfile)
        self.assertIn("--uid 10001", dockerfile)
        self.assertIn("--no-create-home", dockerfile)
        self.assertIn("--home-dir /nonexistent", dockerfile)
        self.assertIn("--shell /usr/sbin/nologin", dockerfile)
        self.assertIn("install", dockerfile)
        self.assertIn("-o 10001", dockerfile)
        self.assertIn("-g 10001", dockerfile)
        self.assertIn("-m 0750", dockerfile)
        self.assertIn("/app/nanika_storage", dockerfile)
        user_directives = [
            line.strip()
            for line in dockerfile.splitlines()
            if line.strip().startswith("USER ")
        ]
        self.assertTrue(user_directives, "Dockerfile must define a runtime USER")
        self.assertEqual(user_directives[-1], "USER 10001:10001")
        self.assertNotRegex(dockerfile, r"(?m)^\s*RUN\s+.*chown\s+-R\s+.*\s+/app\s*$")
        self.assertNotIn("useradd -m nanika", dockerfile)

    def test_backend_compose_has_no_identity_override_and_fail_closed_bind(self) -> None:
        compose = self.read("docker-compose.yml")
        backend = self.service_block(compose, "backend")
        self.assertNotRegex(backend, r"(?m)^\s+user:\s*")
        self.assertRegex(
            backend,
            r"(?ms)\s+- type: bind\s+source: \.\/nanika_storage\s+target: /app/nanika_storage\s+bind:\s+create_host_path: false",
        )
        self.assertNotRegex(backend, r"(?m)^\s+privileged:\s*")
        self.assertNotRegex(backend, r"(?m)^\s+cap_add:\s*$")

    def test_native_bind_address_is_loopback_and_deployment_bind_is_container_wide(self) -> None:
        env_example = self.read(".env.example")
        compose_source = self.read("docker-compose.yml")
        compose = self.service_block(compose_source, "backend")
        owner = self.read("tools/quality/run_playwright_campaign_env.py")
        self.assertIn("NANIKA_BIND_ADDRESS=0.0.0.0", env_example)
        self.assertIn('"NANIKA_BIND_ADDRESS": "127.0.0.1"', owner)
        self.assertIn('"127.0.0.1:8080:8080"', compose)
        self.assertIn("- nanika_network", compose)
        self.assertIn("NANIKA_BIND_ADDRESS: ${NANIKA_BIND_ADDRESS:-0.0.0.0}", compose)

    def test_deployment_documents_linux_storage_ownership_transition(self) -> None:
        readme = self.read("deploy/README.md")
        migration_start = readme.index("Para uma instalação existente")
        migration_end = readme.index("Não use `chmod 777`", migration_start)
        migration = " ".join(
            readme[migration_start:migration_end].replace("\\", "").split()
        )

        self.assertIn("docker compose stop backend", migration)
        self.assertIn(
            "sudo chown -R --no-dereference 10001:10001 ./nanika_storage",
            migration,
        )
        self.assertIn("sudo chmod 0750 ./nanika_storage", migration)
        self.assertIn("docker compose up -d --build backend", migration)
        self.assertNotIn("docker compose up -d backend", migration)

        stop = migration.index("docker compose stop backend")
        chown = migration.index(
            "sudo chown -R --no-dereference 10001:10001 ./nanika_storage"
        )
        chmod = migration.index("sudo chmod 0750 ./nanika_storage")
        start_backend = migration.index("docker compose up -d --build backend")

        self.assertLess(stop, chown)
        self.assertLess(chown, chmod)
        self.assertLess(chmod, start_backend)
        self.assertIn("Não use `chmod 777`", readme)


if __name__ == "__main__":
    unittest.main()
