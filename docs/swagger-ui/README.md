# Vendored Swagger UI

The bundle and stylesheet are copied unchanged from the official
[Swagger UI distribution](https://github.com/swagger-api/swagger-ui/tree/e89a91f13cdee432d97ca9d3d1ac1969ff797036/dist)
at version **5.33.2**, commit `e89a91f13cdee432d97ca9d3d1ac1969ff797036`.
`provenance.json` records the immutable source URL and SHA-256 of each upstream
file, including Apache 2.0 `LICENSE` and `NOTICE`. The deployment security gate
checks these hashes without network access.

`swagger-init.js` is Nanika's local initializer. It loads the YAML from the
current documentation path, disables the external validator, and selects the
current origin and public API prefix for Try it out. No CDN fallback is used.
The existing root Dockerfile copies this directory to `/app/docs/swagger-ui`.

The documentation HTML owns its CSP. The SPA and API JSON keep their existing
HTTP contracts. Crow 1.2's automatic slash redirect loses reverse proxy prefixes,
so a documentation suffix route accepts only `/` and serves HTML using `assets/` URLs;
`/api/docs` uses `docs/assets/` URLs. All asset routes are literal whitelisted
paths. Missing or unreadable assets return 503 and never a remote fallback.

Run the cheap gates with:

```sh
python3 -m unittest tools.quality.test_deployment_security tools.quality.test_openapi_contract tools.quality.test_nanika_recovery tools.quality.test_auth_memory_contract
```

Run the optional browser smoke against an isolated backend and an Nginx proxy:

```sh
node frontend/tools/swagger-csp-smoke.mjs http://127.0.0.1:18080 http://127.0.0.1:18081
```

Use this smoke when the documentation assets, routes or policy change. It uses
one Chromium instance and checks both URL variants, local assets, YAML, rendering,
Try it out routing and blocked inline/foreign scripts. It is excluded from the
ordinary PR browser campaign. Review and replace the pinned upstream files and
their integrity records together when updating this distribution.
