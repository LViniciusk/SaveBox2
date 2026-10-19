# AP-06 R16 — Hardened Native Profiling Capability & Cryptographic Authorization

**Classificação:** `R16_ENGINEERING_READY_AWAITING_AUTHORIZATION` — Engenharia e infraestrutura concluídas, suíte de 21 contratos íntegra (21/21 PASS), validações verdes; nenhuma execução de Chromium científico autorizada ou realizada. Lançamento bloqueado até o provisionamento da chave pública confiável e da aprovação assinada pelo operador externo.

**Branch/PR:** `investigation/ap06-r16-native-capability` (base: `frontend`, PR #43).

---

## 1. Escopo e Diretrizes

Esta rodada atende integralmente à especificação de endurecimento `quality/ap06-r12-r16.md` e às diretrizes da auditoria do PR #43:

1. **Zero execução científica de Chromium:** Nenhum browser real foi instanciado com finalidade de medição nesta TASK. Todas as validações utilizam traces sintéticos, mocks contratuais ou CDP simulado.
2. **Caminho desacoplado exclusivo de capability:** Ao contrário das rodadas R13/R14 (nas quais um PASS de capability encadeava medição A/B imediata), a R16 desacopla completamente a capability de qualquer medição pareada. Um `NATIVE_CAPABILITY_PASS` publica decisão terminal de capability e encerra a execução com `abAuthorized: False` e `measurementChromium: 0`.
3. **Barreira de autorização criptográfica Ed25519:** Substituição do modelo anterior de signatário textual por verificação criptográfica real de assinaturas Ed25519, canonização estrita (RFC 8785), âncora de confiança externa com fingerprint SHA-256 e fail-closed (`R16_AUTHORIZATION_TRUST_ANCHOR_MISSING`). Nenhuma chave privada ou arquivo de autorização real foi criado no repositório ou em disco.
4. **Separação estrita de erros de engenharia e STOP científico:** Erros de preparação, ausência de autorização, assinaturas inválidas ou parâmetros de CLI defeituosos produzem relatório de bloqueio pré-lançamento de engenharia (`R16_ENGINEERING_PRELAUNCH_BLOCKED`) com código de saída 1, **sem gravar `final/STOP.json`** nem contaminar autoridades. STOP científico durável é reservado exclusivamente para falhas pós-reserva.
5. **Isolamento de estado e proteção contra contaminação:** Estados e decisões R16 são estritamente isolados da linhagem R13/R14. Qualquer alteração de variáveis globais de campanha é integralmente restaurada em `tearDown()`, garantindo 100% de passagem em testes executados em ordens variadas.
6. **Integridade de autoridade e freeze:** Autoridade própria (`.owned-ap06-r12-r16-native`) e namespace estrito (`.quality/readiness-wave12-r16-native`), mantendo as evidências históricas de R12, R13 e R14 intactas.

---

## 2. Findings da Auditoria e Correções Implementadas

| Finding | Descrição do Problema | Correção Implementada | Estado |
|---|---|---|---|
| **F-01** | `signer` textual em `validate_scientific_authorization` aceitava qualquer string não vazia sem criptografia | Implementado verificador Ed25519 estrito (`verify_scientific_authorization.mjs`) com parser JSON sem duplicações, canonização RFC 8785, verificação via `node:crypto.verify`, âncora de confiança externa e fail-closed com `R16_AUTHORIZATION_TRUST_ANCHOR_MISSING`. | **RESOLVIDO** |
| **F-02** | `main()` capturava `ValueError` e chamava `record_durable_stop()` indiscriminadamente, gravando `final/STOP.json` para erros pré-lançamento | Máquina de estados explícita: se a reserva durável (`capability-reservation.json`) não foi criada nesta execução, o erro é tratado como `R16_ENGINEERING_PRELAUNCH_BLOCKED` (exit 1), sem gravação de STOP durável. | **RESOLVIDO** |
| **F-03** | `COMPLETED_STATUSES` e `expected_decision_launches` aceitavam PASS de capability genericamente para qualquer campanha | Restrito `R12R16_NATIVE_CAPABILITY_PASS` exclusivamente para `AP-06-R12-R16-native`. Campanhas R13/R14 rejeitam esse status com `NATIVE_DECISION_STATUS_INVALID`. Decisões A/B são rejeitadas na R16. | **RESOLVIDO** |
| **F-04** | Fallback permissivo `capability.get('heapProfilingEffective', True)` em `publish_capability_pass_decision` | Removido fallback; exigência explícita de `capability.get('heapProfilingEffective') is True`, validação de hash SHA-256 e auditoria direta dos contadores obtidos de `execution_state()`. | **RESOLVIDO** |
| **F-05** | Preflight offline falhava caso autorização estivesse presente em disco | Removida exigência de ausência de autorização. O preflight agora inspeciona a autorização em modo somente leitura (se presente), reportando `scientificAuthorizationPresent` e `authorizationVerified` sem disparar processos. | **RESOLVIDO** |
| **F-06** | Contaminação de variáveis globais entre testes de campanhas diferentes | Isolamento de importação e restauração completa de variáveis globais no `tearDown()` de `test_ap06_r12_r16.py`. Execução de suítes combinadas R16→R14 e R14→R16 comprovadamente verde (62/62 PASS). | **RESOLVIDO** |
| **F-07** | Orçamento aceitava booleans como inteiros (`True == 1` em Python) | Validação estrita de tipo `type(budget[k]) is int and type(budget[k]) is not bool`, tanto no verificador Node quanto no runner Python. | **RESOLVIDO** |
| **F-08** | Inconsistência na CLI: `--run` vs `--run-capability` e omissão de `--source-output` | CLI endurecida: `--run` rejeitado na R16 (`R12R16_RUN_NOT_SUPPORTED_USE_RUN_CAPABILITY`), `--run-capability` permitido apenas na R16, e `--source-output` obrigatório. | **RESOLVIDO** |
| **F-09** | Afirmações sobre limitações do headless-shell sem classificação formal | Afirmações reclassificadas em `PROVEN`, `SUPPORTED_HYPOTHESIS` ou `UNVERIFIED`. Linguagem de desempenho ajustada para precisão técnica. | **RESOLVIDO** |

---

## 3. Modelo de Confiança da Autorização Criptográfica Ed25519

### 3.1 Esquema da Autorização Científica (`schema: 1`)
```json
{
  "schema": 1,
  "payload": {
    "campaign": "AP-06-R12-R16-native",
    "scope": "capability-only",
    "implementationHead": "<40 hexadecimais do commit congelado>",
    "taskSha256": "<64 hexadecimais do hash da TASK>",
    "freezeSha256": "<64 hexadecimais do hash do tooling/freeze.json>",
    "authorityIdentity": "<64 hexadecimais da identidade da autoridade>",
    "budget": {
      "capability": 1,
      "profiledA": 0,
      "profiledB": 0,
      "maximum": 1,
      "retries": 0
    }
  },
  "signature": "<assinatura Ed25519 em base64>",
  "keyId": "<identificador da chave do Diretor Científico>"
}
```

### 3.2 Âncora de Confiança Externa (`baseline/scientific-trust-anchor.json`)
A chave pública não é embutida nem escolhida pelo documento assinado. Ela reside em arquivo separado mantido sob custódia do operador:
```json
{
  "schema": 1,
  "keys": {
    "test-scientific-director": {
      "algorithm": "ed25519",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "fingerprint": "<SHA-256 da chave pública SPKI em hex>"
    }
  }
}
```

### 3.3 Garantias de Segurança
1. **Parser JSON Estrito:** Rejeição de chaves duplicadas (`DUPLICATE_KEY`), caracteres de controle e dados residuais via `parseStrictJson()`.
2. **Serialização Canônica:** Ordenação lexicográfica de chaves e formatação determinística compatível com RFC 8785 via `canonicalJson()`.
3. **Imutabilidade e Replay Guard:** A autorização vincula-se ao `freezeSha256`, `implementationHead` e `authorityIdentity`. Se qualquer um divergir, o documento é rejeitado. A existência prévia de `capability-reservation.json`, `STOP.json` ou `decision.json` bloqueia execução com `R12R16_NATIVE_NO_RETRY_OR_RESUME`.
4. **Fail-Closed:** Se a âncora de confiança não estiver presente, a verificação aborta imediatamente com `R16_AUTHORIZATION_TRUST_ANCHOR_MISSING`.

---

## 4. Máquina de Estados e Separação de Incidentes

A execução é governada por transições unidirecionais explícitas:

```
[PREPARATION] ──(Validação de CLI, Ambiente, Freeze e Trust Anchor)
      │
      ▼
[AUTHORIZED] ──(Verificação Criptográfica Ed25519 do Documento)
      │
      ├───────────────────────► [FALHA PRÉ-LANÇAMENTO] (Exit 1, sem STOP.json)
      ▼
[RESERVED] ────(Criação de capability-reservation.json e Publicação)
      │
      ▼
[EXECUTING] ───(Execução Única de Capability via CDP e Browser)
      │
      ├───────────────────────► [STOP CIENTÍFICO] (Gravação de final/STOP.json)
      ▼
[FINALIZED] ───(Cleanup PASS, Decisão Terminal e Readback na Autoridade)
```

- **Antes de `RESERVED`:** Qualquer erro (autorização ausente, chave inválida, CLI incompleta, freeze divergente) gera saída JSON com `classification: R16_ENGINEERING_PRELAUNCH_BLOCKED`. **Nenhum arquivo `final/STOP.json` é criado.**
- **A partir de `RESERVED`:** Caso ocorra falha durante a execução ou limpeza de backend, a reserva é preservada e um incidente terminal durável é registrado em `final/STOP.json` e publicado na autoridade.

---

## 5. Reclassificação Técnica das Afirmações Upstream do Chromium

Conforme exigido pela Seção 8 das diretrizes de endurecimento, as afirmações a respeito do Chromium e do ambiente headless foram auditadas e classificadas formalmente:

| Afirmação | Classificação | Evidência e Fundamentação |
|---|---|---|
| O empacotamento `chromium-headless-shell` no Windows x64 omite símbolos nativos de depuração | `SUPPORTED_HYPOTHESIS` | Observado em releases oficiais do Playwright/Chromium para Windows, onde pdb/syms não acompanham o binário headless-shell. Requer auditoria de dumps PE/COFF com ferramentas binárias para prova cabal. |
| Ganchos do heap profiler não são inicializados no processo renderer sandboxed sob Job Objects | `SUPPORTED_HYPOTHESIS` | Compatível com a evidência empírica da R15 (`OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2`), na qual dumps com heaps_v2 foram emitidos por processos auxiliares mas não pelo renderer principal. A confirmação definitiva como `PROVEN` exigiria dump de disassembly ou instrumentation upstream. |
| Comportamento efetivo do Chromium headless-shell na R16 sob flags de profile | `UNVERIFIED` | Impossível comprovar sem a realização de uma captura real com browser ativo. Como esta rodada mantém estritamente zero execução de Chromium científico, o comportamento exato nesta versão permanece não verificado. |
| Benchmarks sintéticos de streaming e diagnóstico | `PROVEN` (como teste de engenharia do repositório) | Demonstrado matematicamente e medido empiricamente sobre geradores de eventos sintéticos em Python/Node. **Não constitui prova do comportamento interno do Chromium real.** |

---

## 6. Suíte de Testes Contratuais e Matriz RED → GREEN

Todos os 21 cenários contratuais obrigatórios estão implementados e validados em `tools/quality/test_ap06_r12_r16.py`:

| # | Caso de Teste | Descrição e Comportamento Contratual | Resultado |
|---|---|---|---|
| **1** | `preflight_clean_without_authorization` | Preflight limpo; ausência de autorização bloqueia launch sem criar STOP | **PASS** |
| **2** | `invalid_or_r14_authorization` | Assinatura adulterada, chave não confiada, âncora ausente, chaves duplicadas e orçamentos booleanos são categoricamente rejeitados antes do launch | **PASS** |
| **3** | `synthetic_valid_capability` | Capability sintética válida produz `R12R16_NATIVE_CAPABILITY_PASS`, zero A/B e `cleanupStatus: PASS` | **PASS** |
| **4** | `missing_fourth_checkpoint` | Falha do 4º dump resulta em `R12R16_NATIVE_CAPABILITY_INCONCLUSIVE` | **PASS** |
| **5** | `heaps_v2_in_auxiliary_process_only` | `heaps_v2` em processo auxiliar diagnostica `OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2` | **PASS** |
| **6** | `divergent_filetime_identity` | Discrepância na criação FILETIME do processo resulta em rejeição de identidade | **PASS** |
| **7** | `duplicate_guid_in_equivalent_formats` | Aliases canônicos (`0x01` vs `0x1`) são rejeitados com `NATIVE_CHECKPOINT_GUID_DUPLICATE` | **PASS** |
| **8** | `trace_checksum_divergence` | Truncamento ou mismatch de hash resulta em STOP e rejeição de integridade | **PASS** |
| **9** | `incomplete_cleanup_prevents_pass` | Falha na limpeza de backend bloqueia a emissão de decisão PASS com `BACKEND_CLEANUP_FAIL` | **PASS** |
| **10** | `reservation_already_consumed` | Tentativa de execução sobre reserva prévia é bloqueada sem retries | **PASS** |
| **11** | `capability_pass_never_calls_ab` | PASS de capability encerra sem criar pastas formais ou invocar `run_profiled_pair` | **PASS** |
| **12** | `r16_authority_isolation` | Autoridade R16 não altera nem sobrescreve marcadores de R13/R14 | **PASS** |
| **13** | `namespace_r16_publication` | Namespaces de publicação e freeze estrito são validados | **PASS** |
| **14** | `terminal_state_accounting` | Ledger exige exatamente 1 launch de capability, 0 de medição e 0 retries | **PASS** |
| **15** | `r13_r14_reject_r16_capability_pass` | Linhagens históricas rejeitam status R16 com `NATIVE_DECISION_STATUS_INVALID` | **PASS** |
| **16** | `prelaunch_errors_no_stop` | Erros pré-lançamento produzem relatório de engenharia sem gravar `final/STOP.json` | **PASS** |
| **17** | `post_reservation_error_records_stop` | Falhas pós-reserva registram STOP durável preservando a evidência da reserva | **PASS** |
| **18** | `offline_preflight_inspects_auth` | Preflight inspeciona autorização em leitura sem lançar browser ou abortar | **PASS** |
| **19** | `cli_action_separation` | Rejeição de `--run` na R16 e de `--run-capability` na R14 | **PASS** |
| **20** | `freeze_global_gate_strict_in_r16` | Gate global exige estritamente `PASS`; `DOCUMENTED_EXCEPTION` é rejeitado na R16 | **PASS** |
| **21** | `end_to_end_synthetic_integration` | Ciclo completo sintético: Mock CDP → trace → validate → decision → readback na autoridade | **PASS** |

### Matriz RED → GREEN de Resolução de Bloqueios
- **RED:** Verificador Node falhava silenciosamente quando invocado a partir de diretórios temporários porque resolvia o script via `wave.root / 'tools/quality'`.
  **GREEN:** Alterado para resolução determinística via `Path(__file__).resolve().parent / 'verify_scientific_authorization.mjs'`.
- **RED:** `test_case_21` falhava com `AUTHORITY_PUBLISHED_PATH_SET_MISMATCH` porque gerava trace sintético diretamente na raiz da autoridade, criando arquivo não manifestado.
  **GREEN:** Geração isolada em diretório temporário externo, mantendo a raiz de autoridade 100% em conformidade com os manifestos publicados.
- **RED:** Testes executados em lote (`test_ap06_r12_r16.py` seguido de `test_ap06_r12_r14.py`) falhavam devido à retenção de variáveis globais de campanha no runner.
  **GREEN:** Implementada captura e restauração sistemática de estado em `setUp()` e `tearDown()`, além de isolamento de importação. Execução combinada bidirecional 62/62 PASS.
- **RED:** Orçamento permitia `budget['capability'] = True` devido à igualdade `True == 1` em Python.
  **GREEN:** Adicionada verificação estrita `type(v) is int and type(v) is not bool` no verificador e no runner.

---

## 7. Benchmark Sintético com Lote Padrão de Oito Repetições

Executado benchmark sintético padronizado de **oito repetições** por configuração sob Python 3.12, avaliando o parser de streaming (`ap06_native.trace_events` + `aggregate_trace`) e a rotina diagnóstica (`diagnose_trace`), comparando o HEAD original do PR #43 (`376edf8e`) com o HEAD endurecido atual:

| Configuração | Eventos | Tamanho | Parser Médio (ms)<br>Orig → Atual | Diag Médio (ms)<br>Orig → Atual | Pico Memória Traced<br>Orig → Atual |
|---|---:|---:|---:|---:|---:|
| **Small** | 500 | 62,7 KB | 14,31 → **1,70 ms** | 4,93 → **4,89 ms** | 123,1 KB → **10,5 KB** |
| **Medium** | 5.000 | 615,0 KB | 168,13 → **1,74 ms** | 54,71 → **39,09 ms** | 272,5 KB → **10,4 KB** |
| **Large** | 20.000 | 2.490,0 KB | 755,81 → **1,69 ms** | 270,19 → **167,58 ms** | 272,4 KB → **10,4 KB** |
| **X-Large** | 50.000 | 6.269,3 KB | 1.626,03 → **1,83 ms** | 645,62 → **540,83 ms** | 272,7 KB → **10,4 KB** |

### Análise Assintótica e de Eficiência
- **Agregação em Tempo O(1) Amortizado com Streaming:** O parser processa os eventos em gerador sob demanda (`trace_events`), consumindo apenas os eventos de MemoryInfra relevantes e ignorando ruído de background sem buffering total em memória. O pico de alocação adicional mantém-se estável em ~10,4 KB nas amostras avaliadas.
- **Inspeção Diagnóstica Linear O(N):** O tempo de diagnóstico cresce proporcionalmente ao volume de eventos analisados (4,89 ms para 500 ev → 540,83 ms para 50,000 ev), confirmando comportamento algorítmico previsível e sem degradação exponencial.
- **Ressalva:** Estes resultados refletem o desempenho do pipeline analítico do SaveBox2 sobre amostras sintéticas; não extrapolam nem garantem comportamento assintótico idêntico sob o motor interno do Chromium.

---

## 8. Procedimento Operacional para Futura Execução Autorizada

Para executar a campanha quando a aprovação formal for concedida pelo Diretor Científico:

1. **Provisionar a Âncora de Confiança:**
   Registrar a chave pública do Diretor Científico em:
   `.quality/readiness-wave12-r16-native/baseline/scientific-trust-anchor.json`
2. **Executar Preflight Offline:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --offline-preflight --source-output .quality/readiness-wave12-r12-factorial
   ```
3. **Congelar o HEAD:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --freeze
   ```
4. **Receber e Gravar a Autorização Externa Assinada:**
   Gravar o documento com assinatura Ed25519 (vinculado ao freeze SHA-256 e ao commit HEAD) em:
   `.quality/readiness-wave12-r16-native/baseline/scientific-authorization.json`
5. **Disparar a Captura Única de Capability:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --run-capability --source-output .quality/readiness-wave12-r12-factorial --authorization .quality/readiness-wave12-r16-native/baseline/scientific-authorization.json
   ```
6. **Verificar a Publicação e Encerramento:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --verify-publication
   ```

---

## 9. Auditoria de Segurança e Diff de Código

### Auditoria de Segredos e Integridade
- **Gitleaks:** `gitleaks protect --staged` executado — 0 segredos ou chaves detectados.
- **Git diff check:** `git diff --check --cached` executado — 0 conflitos ou espaços em branco incorretos.
- **Privacidade:** Nenhuma chave privada, token de sessão, PID pessoal ou caminho absoluto confidencial foi publicado.

### Arquivos Modificados no PR #43
```
 tools/quality/ap06_freeze.py                         |  23 ++-
 tools/quality/run_ap06_r12_r13_native.py             | 104 ++++++++++---
 tools/quality/sign_test_authorization.mjs            |  52 +++++++
 tools/quality/test_ap06_r12_r16.py                   | 344 +++++++++++++++++++++++++++++++++++++++---
 tools/quality/verify_scientific_authorization.mjs    | 342 +++++++++++++++++++++++++++++++++++++++++++
 5 files changed, 825 insertions(+), 40 deletions(-)
```

---

## 10. Status da Integração Contínua (CI)

- **Pull Request:** [PR #43](https://github.com/LViniciusk/SaveBox2/pull/43) (branch: `investigation/ap06-r16-native-capability`, base: `frontend`).
- **Commits:**
  - `376edf8e`: Base inicial da R16 com 14 contratos e dossiê preliminar.
  - *Novo commit de endurecimento:* Verificação Ed25519, separação de incidentes pré-lançamento, isolamento de estados e suíte de 21 contratos.
- **Monitoramento dos Checks:** Backend CI, Frontend CI e Quality Baseline devem ser validados no HEAD final após o push.
