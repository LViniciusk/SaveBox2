# Nanika Security Track A

Result: **PASS_SECURITY_TRACK_A_HARDENED**. SEC-01, SEC-03 and QA-01 are CLOSED.

Baseline: `d99f93473eb1ebc8bd5e8d08783008cf1250b833`, branch `frontend`.
Delivery branch: `security/track-a-hardening`; PR base: `frontend`, selected by the user so the six earlier commits are excluded from this PR.
PR: https://github.com/LViniciusk/SaveBox2/pull/18. Remote `frontend` was fast-forwarded to the already committed local baseline, with no other open PR on that branch; inherited unstaged work remains local.

## Changes and rationale

- `backend/src/controllers/ApiRouter.cpp`: replace CDN scripts and inline initialization with local whitelisted asset routes; document HTML owns a restrictive CSP and no-store/nosniff/referrer/frame headers. YAML and assets reuse a fixed-path reader and return 503 on missing/unreadable files. JSON response contracts are preserved.
- `docs/swagger-ui/`: upstream Swagger UI **5.33.2**, fixed to official commit `e89a91f13cdee432d97ca9d3d1ac1969ff797036`; unchanged bundle, CSS, Apache LICENSE and NOTICE have immutable source URLs and SHA-256 records. Scoped `.gitattributes` preserves upstream bytes on Windows. Nanika's initializer loads relative YAML, disables the remote validator and uses the public prefix for Try it out.
- `docs/swagger.yaml`: quote one existing flow-mapping description containing `Content-Range: ...`; the former YAML could not be parsed by Swagger's actual parser.
- `backend/tests/test_api_docs.cpp`: route/MIME/CSP, slash variant, whitelist/traversal, fail-closed assets and unchanged JSON policy contracts.
- `frontend/tools/swagger-csp-smoke.mjs`: optional one-browser smoke, direct and Nginx paths, real YAML parsing/rendering/Try it out, local stylesheet loading and inline/foreign script blocking.
- `backend/include/Services/detail/ScopedMemoryWipe.hpp`, `backend/src/Services/AuthService.cpp`, `backend/include/Services/AuthService.hpp`: one allocation-free scoped wipe guard protects pre-hash, peppered password and temporary encoded hash on success and exception. `pre_hash` was vulnerable if allocation of its hex string failed. All seams/observers are conditional on `NANIKA_TESTING`; production contains none of these symbols. Hash failure exposes only `AUTH_CRYPTO_FAILURE`.
- `backend/tests/test_auth.cpp`: live-buffer wiping on return/unwinding, correct/incorrect passwords, independent reproduction of the previous hashing algorithm, failpoint after material exists, negative pwhash result after writing output, throwing crypto seam, and unchanged Argon2id format/costs.
- `.github/workflows/quality-baseline.yml`, `.github/workflows/backend-ci.yml`, deployment/OpenAPI/memory/CI contracts: mandatory Python unittest gate uses existing Python, with no new dependency installation, job, or continue-on-error. Existing `savebox_tests`/backend CI picks up C++ regressions. Both workflows now accept PRs targeting `main` or `frontend`, so the selected PR base actually schedules these gates; this filter received RED/GREEN regression checks. The first GitHub run exposed two inherited workflow defects before backend tests: a folded YAML scalar broke Linux build arguments, and a cold Windows vcpkg cache directory was missing. The build now uses a literal block and the Windows install creates its configured cache directory; deterministic contract regressions cover both. Browser smoke remains manual/on authority changes; heavy campaigns are not added to every PR.
- Newly tracked recovery helper/tests are the preexisting requested gate dependencies. The tests use a synthetic schema authority so their unit/mock gate also runs in a fresh checkout without the separate inherited migration. The preexisting streaming SHA helper, SPA CSP and Angular inlineCritical setting are included **byte-for-byte unchanged from the entry worktree** because these contracts depend on them. No other inherited changes are included.

## RED and GREEN evidence

RED Python contracts detected missing local Swagger policy/assets and unguarded password lifetimes. C++ RED: **3 failing cases, 7 failing assertions**, covering real exception/failure cleanup and documentation headers; two independent guard/compatibility tests already passed. Two initial test compilation errors were corrected before this RED execution.

GREEN affected backend build: `savebox_tests` and `savebox_server`, existing MinGW/GCC CMake build, tests enabled only for the test target. **62 cases / 567 assertions passed**, including authentication, cookies/session behavior, prior DB lease regressions, and Track A. After the final slash-route change, the two Swagger cases were rerun: **61 assertions passed**. Authentication code was unchanged after its GREEN execution.

New Python gate: **44 tests passed**. Existing dependency/native CI contracts: **18 passed**. Shared SHA helper caller regressions: **26 passed**. The exact submitted Git index was extracted into a disposable checkout and the 62 gate tests passed there, without unstaged inherited files. Its first invocation identified the missing streaming-hash prerequisite; that prerequisite was included without changing its inherited bytes.

The final Chromium **151.0.7922.34** smoke passed all four scenarios:

| Path | Local assets/YAML/rendering | Try it out | Inline + foreign scripts blocked |
| --- | --- | --- | --- |
| `/api/docs` | PASS | PASS | PASS |
| `/api/docs/` | PASS | PASS | PASS |
| `/backend/api/docs` | PASS | PASS | PASS |
| `/backend/api/docs/` | PASS | PASS | PASS |

Zero unexpected CSP violations or page errors. Nginx syntax passed. Its temporary configuration changed only the backend upstream; SPA CSP was preserved. JSON `/health` had no documentation CSP. Vendored hashes and read permissions passed under Linux UID/GID `10001:10001` at `/app/docs`. The root Dockerfile's existing docs COPY and Docker context inclusion were checked; no new packaging chain was added.

Browser diagnostics found the inherited YAML parse defect and a Crow catchall completion problem that only appeared on the real HTTP boundary. The final implementation uses a suffix route that accepts only the literal `/`, registered after the fixed asset whitelist because Crow selects the first matching route. Unknown suffixes/traversal return 404. All failures were corrected and the final smoke passed.

## Resources, integrity and limits

One existing backend CMake configuration was reused. Incremental builds were repeated for RED, two test compilation fixes and route corrections; no new dependency/toolchain setup. Five Chromium launches in total were needed during diagnostics; the final smoke itself used one browser and four scenarios. No npm install, frontend build, full production Docker rebuild, full restore, C.03, AP-06, memory, coverage or mutation campaign was run.

Every isolated PostgreSQL/backend/Nginx process was cleaned up; preexisting containers were preserved. The baseline inventoried **543 files**; all **533 outside the allowed changes** matched their initial bytes, including video streaming/workers, DatabasePool, DatabaseMigration and AP-06 evidence. Required inherited dependencies retained their baseline bytes. `git diff --check` passed; real configured secrets and GitHub token patterns were absent from the evidence. Test-only crypto seam and observer symbols were absent from the production executable.

GitHub `quality-report` passed on the first scheduled run. Its backend jobs failed before compilation/testing because of the two workflow defects described above; their minimal fixes passed the local workflow contracts and submitted-index gate. Final remote backend/E2E jobs are pending, and their full success is not claimed. Production packaging was verified by its copy contract, file hashes and Linux runtime UID readability, without rebuilding the full image. Real recovery/restore depends on the separately excluded C.01 migration authority and was not claimed here. Source-level contracts complement the executed C++ and browser checks; they do not substitute for those executions.

Detailed sanitized local evidence is in `.quality/security-track-a/{baseline,sec01,sec03,qa01,final}`. This report and `decision.json` are included in the PR; diagnostic output and the inherited patch remain local.
