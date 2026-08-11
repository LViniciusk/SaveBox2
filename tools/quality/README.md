# Quality baseline tooling

The quality tooling measures the current tree and is report-oriented. Local `quality:*` commands do not auto-fix findings; cleanup and refactoring are performed only in explicitly scoped quality rounds.

Native portability gates are required for both platforms: `Backend / Linux GCC`, `Backend / Windows MSVC`, `Backend / Linux Coverage`, `Frontend / Linux` and `Frontend / Windows`. MinGW remains a local compatibility path only; the official Windows compiler gate is native MSVC.

From the repository root:

```text
py -m pip install -r tools/quality/requirements.txt
cd frontend
npm ci
npm run test:coverage
npm run quality:dead
npm run quality:dead:prod
npm run quality:cycles
npm run quality:mutation
npm run e2e:chromium
```

## Desenvolvimento local: matriz de testes

`run-tests.ps1` é um wrapper fino para `tools/quality/run_test_matrix.py`.
O perfil `Fast` é apropriado para o ciclo diário; `Full` mantém coverage,
mutation e o E2E canônico, removendo apenas as execuções duplicadas.

Para testes nativos que precisam alcançar o PostgreSQL do Docker, habilite
explicitamente o override local:

```powershell
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres-db
```

O `docker compose up -d` simples não publica PostgreSQL. O override expõe
somente `127.0.0.1:5433:5432`; ele não deve ser renomeado para
`docker-compose.override.yml`.

```powershell
# Confiança rápida: backend completo + frontend unit, em paralelo
.\run-tests.ps1 -Profile Fast

# Validação dinâmica completa: backend + coverage/mutation, depois Playwright
.\run-tests.ps1 -Profile Full

# Diagnóstico determinístico, sem paralelismo de lanes ou shards
.\run-tests.ps1 -Profile Full -BackendShards 1 -Serial
```

O backend pode usar até quatro processos Catch2 isolados (`-BackendShards 1..4`).
Cada shard recebe um banco PostgreSQL e uma árvore de filesystem próprios; os
casos não são paralelizados dentro do mesmo processo. O banco temporário e os
arquivos `.env` de shard são removidos ao final, inclusive após falha quando
possível. Se o binário não oferecer sharding nativo ou o ambiente não permitir
provisionar bancos, o runner recua com segurança para um processo.

Para uma alteração pontual, rode somente a suíte relacionada:

```powershell
# Backend: recompilação incremental e testes de API relacionados
cmake --build backend/build --parallel
Push-Location backend/build
.\savebox_tests.exe "[api][files]" --order rand --rng-seed time
Pop-Location

# Frontend: testes unitários sem coverage
Push-Location frontend
npm.cmd test -- --watch=false --browsers=ChromeHeadless
Pop-Location
```

Backend e frontend também podem ser executados simultaneamente em dois
terminais. O `--parallel` acelera apenas a compilação; o runner de shards já
cuida da separação de banco/CWD. Não execute processos manuais usando o mesmo
banco e o mesmo `NANIKA_STORAGE_PATH`.

O perfil `Full` não é o checkpoint pesado orientado por eventos: não inclui
backend coverage, Cppcheck, Knip, métricas de módulos, OpenAPI, deployment
checks ou geração de baseline. Coverage e mutation continuam sequenciais na
lane frontend; não são shardados.

Cada execução gera um resumo local em `.quality/test-runs/`, que é ignorado pelo
Git. Ele registra comandos, status, duração por lane/shard e o seed, sem
segredos. O E2E continua sendo executado somente por:

```text
py tools/quality/run_playwright.py
```

O runner de matriz não faz retries e só inicia esse Playwright canônico depois
que backend e frontend estão verdes.

O E2E local canônico usa o frontend Angular em desenvolvimento, por padrão em
`http://localhost:4200`, e o backend atual em `http://localhost:8080`. O
frontend Docker é o build de deployment e não deve ser usado como alvo do
Playwright local, pois usa roteamento de upload de produção. Se a porta 4200
estiver indisponível, use uma porta livre e propague ambas as URLs:

O `npm start` vincula o servidor Angular a `127.0.0.1`; o endereço histórico
default do Playwright permanece `localhost`.

```powershell
cd frontend
npm start -- --port 4300

$env:NANIKA_E2E_BASE_URL = "http://127.0.0.1:4300"
$env:NANIKA_E2E_BACKEND_URL = "http://localhost:8080"
cd ..
.\run-tests.ps1 -Profile Full
```

`4300` é apenas um exemplo; valide uma porta livre antes de iniciar o servidor.

Rodadas leves de hardening usam build incremental e somente testes determinísticos
diretamente relacionados. O checkpoint pesado é orientado por eventos: execute-o
para ratificação final/release, após mudança material transversal (por exemplo
DatabasePool, auth/JWT/crypto, upload/storage moves, schema, frontend global ou
CI), quando a evidência for invalidada, quando houver RED inexplicado entre
suítes, ou na fronteira de um refactor amplo. A quantidade de rodadas, sozinha,
não exige um checkpoint pesado.

Lightweight candidate generation must neither execute nor read repository-wide coverage, mutation, Playwright or full-suite artifacts; those belong exclusively to the next heavy checkpoint.

The canonical E2E command is run from the repository root:

```text
py tools/quality/run_playwright.py
```

It deletes `.quality/playwright/results.json` and `run-status.json` before preflight, checks the configured frontend/backend URLs, runs `npm run e2e:chromium`, and writes a sanitized current-run status plus the SHA-256 of the exact report. It never retries automatically. A missing report, failed preflight or non-zero Playwright exit remains non-green.

The E2E suite needs an already running local Nanika frontend/backend and the `nanika_e2e_fixture` target built with `BUILD_TESTS=ON`. Each test provisions a random `nanika_e2e_*` user through fixture stdin, then cleans only that user up. No human credentials or Google OAuth are used. Playwright artifacts are disabled by default unless the canonical runner enables the JSON report.

Knip is report-only in the local `quality:*` scripts via `--no-exit-code`, so findings remain visible without making those scripts fail. A strict invocation uses exit `0` for no findings, `1` for findings and `>=2` for execution/configuration errors. CI invokes strict Knip and accepts only `0` or `1`.

The frontend Knip configuration keeps Angular and Playwright plugin discovery as the source of truth. Do not add a manual `entry` or `project` override: in production mode those overrides can stop traversal at `src/main.ts` and create false unused-dependency reports. The four `ignoreFiles` entries are intentionally limited to runtime FFmpeg assets and E2E harness support files. Dependency, export, type and cycle categories remain enabled without file-wide issue-category suppression.

Generate complexity and module reports without touching application sources:

```text
py tools/quality/test_module_metrics.py
py tools/quality/module_metrics.py --root . --output .quality/module-metrics.json
```

On Linux/CI, run Cppcheck against `backend/src` and `backend/include` while excluding `crow_all.h`, build directories and fetched dependencies. Run gcovr with the existing project filter and line threshold; add `--json-summary .quality/backend-coverage.json` when supported. Missing optional tools are documented as unavailable rather than reported as green.

Run the same Cppcheck configuration locally from the repository root:

```text
py tools/quality/run_cppcheck.py --root . --output .quality/cppcheck.xml
```

Install Cppcheck separately when it is not on `PATH` (Windows: `winget install --id Cppcheck.Cppcheck -e` or `choco install cppcheck -y`). Exit code `0` means no findings, `1` means findings were reported, and `2` means the tool is unavailable or could not be executed.

Finally, create a local baseline snapshot after reports exist:

```text
py tools/quality/generate_baseline.py \
  --frontend-tests 541 \
  --backend-cases 69 \
  --backend-assertions 6340 \
  --fixture-cases 4 \
  --fixture-assertions 15
```

Replace the example values with the actual current test output whenever the snapshot is regenerated. Both generated baseline files are local-only and intentionally ignored.

## Calibração local de recursos MP4

O probe isolado de MP4Box fica em `frontend/tools/`; ele gera fixtures pequenas
e temporárias em `.quality/mp4-resource-calibration/`, mede apenas quando Node
é iniciado com `--expose-gc` e não faz parte do CI. FFmpeg e ffprobe são
dependências locais opcionais para gerar e validar o corpus; nenhum vídeo é
baixado ou versionado.

```powershell
cd frontend
npm run quality:mp4-resource:test
npm run quality:mp4-resource -- smoke
npm run quality:mp4-resource -- run
```

`smoke` mede um fixture com três processos Node isolados. `run` executa a
matriz finita, valida o corpus com ffprobe e MP4Box, mede o heap JavaScript do
Worker dedicado no Chromium via CDP e salva resultados JSON por execução sob
`.quality/mp4-resource-calibration/runs/`. A medição não representa memória
total do player: decoder, MSE, GPU e alocações nativas ficam fora do modelo.
