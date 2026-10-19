# AP-06 R16 — Hardened Native Profiling Capability & Cryptographic Authorization

**Classificação:** `R16_ENGINEERING_READY_AWAITING_AUTHORIZATION` — Engenharia e infraestrutura concluídas, suíte de 25 contratos íntegra (25/25 PASS), validações verdes; nenhuma execução de Chromium científico autorizada ou realizada. Lançamento bloqueado até o provisionamento da chave pública confiável e da aprovação assinada pelo operador externo.

**Branch/PR:** `investigation/ap06-r16-native-capability` (base: `frontend`, PR #43).

---

## 1. Escopo e Diretrizes

Esta rodada atende integralmente à especificação de endurecimento `quality/ap06-r12-r16.md` e às diretrizes da auditoria do PR #43:

1. **Zero execução científica de Chromium:** Nenhum browser real foi instanciado com finalidade de medição nesta TASK. Todas as validações utilizam traces sintéticos, mocks contratuais ou CDP simulado.
2. **Caminho desacoplado exclusivo de capability:** Ao contrário das rodadas R13/R14 (nas quais um PASS de capability encadeava medição A/B imediata), a R16 desacopla completamente a capability de qualquer medição pareada. Um `NATIVE_CAPABILITY_PASS` publica decisão terminal de capability e encerra a execução com `abAuthorized: False` e `measurementChromium: 0`.
3. **Barreira de autorização criptográfica Ed25519:** Substituição do modelo anterior de signatário textual por verificação criptográfica real de assinaturas Ed25519, canonização estrita (RFC 8785), âncora de confiança externa com fingerprint SHA-256 SPKI DER e fail-closed (`R16_AUTHORIZATION_TRUST_ANCHOR_MISSING` / `R16_AUTHORIZATION_TRUST_ANCHOR_UNTRUSTED_LOCATION`). Nenhuma chave privada ou arquivo de autorização real foi criado no repositório ou em disco.
4. **Separação estrita de erros de engenharia e STOP científico:** Erros de preparação, ausência de autorização, assinaturas inválidas ou parâmetros de CLI defeituosos produzem relatório de bloqueio pré-lançamento de engenharia (`R16_ENGINEERING_PRELAUNCH_BLOCKED`) com código de saída 1, **sem gravar `final/STOP.json`** nem contaminar autoridades. STOP científico durável é reservado exclusivamente para falhas pós-reserva.
5. **Máquina de estados durável e contabilidade de consumo:** Invocação sobre campanha com evidência durável preexistente reporta `R16_EXISTING_SCIENTIFIC_STATE` e preserva contabilidade histórica (`scientificChromium: UNVERIFIED` ou contagem real), nunca presumindo consumo zero.
6. **Proteção contra concorrência:** Lock exclusivo de processo durante a execução de capability previne invocações paralelas com `R16_CONCURRENT_INVOCATION_REJECTED`.
7. **Isolamento de estado e proteção contra contaminação:** Estados e decisões R16 são estritamente isolados da linhagem R13/R14. Qualquer alteração de variáveis globais de campanha é integralmente restaurada em `tearDown()`, garantindo 100% de passagem em testes executados em ordens variadas (62/62 PASS na suíte combinada).
8. **Integridade de autoridade e freeze:** Autoridade própria (`.owned-ap06-r12-r16-native`) e namespace estrito (`.quality/readiness-wave12-r16-native`), mantendo as evidências históricas de R12, R13 e R14 intactas. Gate `global: PASS` é estritamente exigido na R16.

---

## 2. Findings da Auditoria e Correções Implementadas

| Finding | Prioridade | Descrição do Problema | Correção Implementada | Estado |
|---|---|---|---|---|
| **F-01** | Crítica | `signer` textual em `validate_scientific_authorization` aceitava qualquer string não vazia sem criptografia | Implementado verificador Ed25519 estrito (`verify_scientific_authorization.mjs`) com parser JSON sem duplicações, canonização RFC 8785, verificação via `node:crypto.verify` e fail-closed. | **RESOLVIDO** |
| **F-02** | Alta | `main()` capturava `ValueError` e chamava `record_durable_stop()` indiscriminadamente, gravando `final/STOP.json` para erros pré-lançamento | Máquina de estados explícita: se a reserva durável (`capability-reservation.json`) não foi criada nesta execução, o erro é tratado como `R16_ENGINEERING_PRELAUNCH_BLOCKED` (exit 1), sem gravação de STOP durável. | **RESOLVIDO** |
| **F-03** | Média | `COMPLETED_STATUSES` e `expected_decision_launches` aceitavam PASS de capability genericamente para qualquer campanha | Restrito `R12R16_NATIVE_CAPABILITY_PASS` exclusivamente para `AP-06-R12-R16-native`. Campanhas R13/R14 rejeitam esse status com `NATIVE_DECISION_STATUS_INVALID`. Decisões A/B são rejeitadas na R16. | **RESOLVIDO** |
| **F-04** | Média | Fallback permissivo `capability.get('heapProfilingEffective', True)` em `publish_capability_pass_decision` | Removido fallback; exigência explícita de `capability.get('heapProfilingEffective') is True`, validação de hash SHA-256 e auditoria direta dos contadores obtidos de `execution_state()`. | **RESOLVIDO** |
| **F-05** | Média | Preflight offline falhava caso autorização estivesse presente em disco | Removida exigência de ausência de autorização. O preflight agora inspeciona a autorização em modo somente leitura (se presente), reportando `scientificAuthorizationPresent` e `authorizationVerified` sem disparar processos. | **RESOLVIDO** |
| **F-06** | Média | Contaminação de variáveis globais entre testes de campanhas diferentes | Isolamento de importação e restauração completa de variáveis globais no `tearDown()` de `test_ap06_r12_r16.py`. Execução combinada 62/62 PASS. | **RESOLVIDO** |
| **F-07** | Média | Orçamento aceitava booleans como inteiros (`True == 1` em Python) | Validação estrita de tipo `type(budget[k]) is int and type(budget[k]) is not bool`, tanto no verificador Node quanto no runner Python. | **RESOLVIDO** |
| **F-08** | Média | Inconsistência na CLI: `--run` vs `--run-capability` e omissão de `--source-output` | CLI endurecida: `--run` rejeitado na R16 (`R12R16_RUN_NOT_SUPPORTED_USE_RUN_CAPABILITY`), `--run-capability` permitido apenas na R16, e `--source-output` obrigatório. | **RESOLVIDO** |
| **F-09** | Baixa | Afirmações sobre limitações do headless-shell sem classificação formal | Afirmações reclassificadas em `PROVEN`, `SUPPORTED_HYPOTHESIS` ou `UNVERIFIED`. Linguagem de desempenho ajustada para precisão técnica. | **RESOLVIDO** |
| **F-10** | Crítica | Trust anchor lido do documento ou caminhos editáveis pelo runner | Raiz de confiança externa com fingerprint calculado sobre SPKI DER. Rejeição de âncoras em `.quality/`, `baseline/` ou no repositório fora de ambiente de teste (`AP06_TEST_HARNESS === '1'`). | **RESOLVIDO** |
| **F-11** | Alta | Parser JSON suscetível a zeros iniciais (`01`), surrogates e prototype pollution | Parser estrito RFC 8259: rejeição de zeros à esquerda, surrogates isolados, `Object.create(null)` para objetos, validação de Base64 canônico de 64 bytes e verificação de tipo de chave assimétrica (`ed25519`). | **RESOLVIDO** |
| **F-12** | Alta | Contabilidade presumia zero Chromium quando reserva anterior existia | Separação explícita entre erro pré-reserva (`R16_ENGINEERING_PRELAUNCH_BLOCKED`, consumo 0) e estado pré-existente (`R16_EXISTING_SCIENTIFIC_STATE`, consumo 'UNVERIFIED' ou real). Adicionado lock de concorrência. | **RESOLVIDO** |
| **F-13** | Média | Gate `global` não era exigido no freeze R16 | Atualizado `validate_test_receipt` em `ap06_freeze.py`: `global: PASS` é estritamente exigido na R16; exceções documentadas e ausência de gate são categoricamente rejeitadas. | **RESOLVIDO** |
| **F-14** | Média | Integração sintética não exercitava o produtor Node real | Criado `tools/quality/produce_synthetic_native_trace.mjs` integrando `NativeTrace` e CDP mock offline em 7 cenários distintos, validado via `test_case_22`. | **RESOLVIDO** |
| **F-15** | Alta | Benchmark anterior de 1,83 ms para 50.000 eventos decorrente de falha precoce | Declarado **INVALIDATED / NOT COMPARABLE**. Substituído por benchmark controlado de 8 repetições medindo streaming, agregação, diagnóstico e memória. | **RESOLVIDO** |

---

## 3. Modelo de Confiança Criptográfica Independente Ed25519

### 3.1 Raiz de Confiança e Provisionamento Externo
O verificador `tools/quality/verify_scientific_authorization.mjs` rejeita terminantemente qualquer autorização que tente especificar sua própria chave pública ou cujo trust anchor esteja em locais controlados pelo executor (`.quality/`, `baseline/`, workspace git):

1. **Fingerprint SPKI DER SHA-256:**
   O fingerprint não é calculado sobre texto PEM arbitrário, mas sobre os bytes binários da estrutura SPKI DER:
   ```javascript
   const key = createPublicKey(keyConfig.publicKey);
   if (key.asymmetricKeyType !== 'ed25519') throw new Error('R16_AUTHORIZATION_KEY_TYPE_INVALID');
   const spkiDer = key.export({ type: 'spki', format: 'der' });
   const fingerprint = createHash('sha256').update(spkiDer).digest('hex');
   if (fingerprint !== keyConfig.fingerprint) throw new Error('R16_AUTHORIZATION_KEY_FINGERPRINT_MISMATCH');
   ```
2. **Localização Segura do Trust Store:**
   Fora do ambiente controlado de testes (`process.env.AP06_TEST_HARNESS === '1'`), âncoras em caminhos de repositório são rejeitadas com `R16_AUTHORIZATION_TRUST_ANCHOR_UNTRUSTED_LOCATION`.
3. **Assinatura Canônica de 64 Bytes:**
   O verificador valida que o buffer decodificado possui exatamente 64 bytes e que sua recodificação coincide estritamente com a string Base64 informada (`decoded.toString('base64') === authDoc.signature`), rejeitando representações não canônicas.
4. **Proteção Contra Prototype Pollution:**
   Todos os objetos decodificados utilizam protótipo nulo (`Object.create(null)`), neutralizando vetores baseados em `__proto__` ou `constructor`.

---

## 4. Máquina de Estados e Separação de Incidentes

A execução é governada por transições unidirecionais com atomicidade em cada fronteira:

```
[PREPARATION] ──(Lock Concorrente, CLI, Freeze, Trust Anchor)
      │
      ▼
[AUTHORIZED] ──(Verificação Criptográfica Ed25519 Externa)
      │
      ├───────────────────────► [FALHA PRÉ-LANÇAMENTO] (Exit 1, sem STOP.json, consumo 0)
      ▼
[RESERVED] ────(Criação de capability-reservation.json e Publicação)
      │
      ├───────────────────────► [ESTADO PRÉ-EXISTENTE] (R16_EXISTING_SCIENTIFIC_STATE, consumo histórico)
      ▼
[EXECUTING] ───(Execução Única de Capability via CDP e Browser)
      │
      ├───────────────────────► [STOP CIENTÍFICO DURÁVEL] (Gravação de final/STOP.json)
      ▼
[FINALIZED] ───(Cleanup PASS, Decisão Terminal e Readback na Autoridade)
```

- **Invocação Concorrente:** Tentativa simultânea é rejeitada via lock atômico de arquivo (`.execution.lock`) retornando `R16_CONCURRENT_INVOCATION_REJECTED`.
- **Pré-reserva:** Erros pré-lançamento retornam `R16_ENGINEERING_PRELAUNCH_BLOCKED` com `scientificChromium: 0` e nenhum arquivo `STOP.json` é criado.
- **Pós-reserva:** Falhas pós-reserva preservam o ledger e gravam incidente durável em `final/STOP.json`. Reinvocações reportam `R16_EXISTING_SCIENTIFIC_STATE` com consumo `UNVERIFIED` ou contagem real auditada, impedindo retries silenciosos.

---

## 5. Reclassificação Técnica das Afirmações Upstream do Chromium

| Afirmação | Classificação | Evidência e Fundamentação |
|---|---|---|
| O empacotamento `chromium-headless-shell` no Windows x64 omite símbolos nativos de depuração | `SUPPORTED_HYPOTHESIS` | Observado em releases oficiais do Playwright/Chromium para Windows, onde pdb/syms não acompanham o binário headless-shell. Requer auditoria de dumps PE/COFF com ferramentas binárias para prova cabal. |
| Ganchos do heap profiler não são inicializados no processo renderer sandboxed sob Job Objects | `SUPPORTED_HYPOTHESIS` | Compatível com a evidência empírica da R15 (`OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2`), na qual dumps com heaps_v2 foram emitidos por processos auxiliares mas não pelo renderer principal. |
| Comportamento efetivo do Chromium headless-shell na R16 sob flags de profile | `UNVERIFIED` | Impossível comprovar sem a realização de uma captura real com browser ativo. Como esta rodada mantém estritamente zero execução de Chromium científico, o comportamento exato nesta versão permanece não verificado. |
| Benchmarks sintéticos de streaming e diagnóstico | `PROVEN` (como teste de engenharia do repositório) | Demonstrado matematicamente e medido empiricamente sobre geradores de eventos sintéticos em Python/Node sob protocolo controlado de 8 repetições. **Não constitui prova do comportamento interno do Chromium real.** |

---

## 6. Suíte de Testes Contratuais e Matriz RED → GREEN

Todos os 25 cenários contratuais obrigatórios estão implementados e validados em `tools/quality/test_ap06_r12_r16.py`:

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
| **22** | `real_node_producer_integration_scenarios` | Produtor Node real (`NativeTrace`) integrado ao consumidor Python em 7 cenários | **PASS** |
| **23** | `concurrent_invocation_protection` | Lock atômico rejeita invocações concorrentes com `R16_CONCURRENT_INVOCATION_REJECTED` | **PASS** |
| **24** | `existing_scientific_state_distinguished` | Campanhas com reserva pré-existente reportam `R16_EXISTING_SCIENTIFIC_STATE` | **PASS** |
| **25** | `strict_json_parser_and_spki_fingerprint` | Rejeição de números malformados (`01`), surrogates, prototype pollution e RSA | **PASS** |

### Matriz RED → GREEN de Resolução de Bloqueios
- **RED:** Gate global não era validado na R16 em `ap06_freeze.py`, aceitando omissão ou `DOCUMENTED_EXCEPTION`.
  **GREEN:** Atualizado `validate_test_receipt()` para exigir expressamente `tests['global']['status'] == 'PASS'` para R16, mantendo compatibilidade histórica de R13/R14.
- **RED:** Autorização aceitava âncoras de confiança com qualquer chave pública desde que o fingerprint no documento coincidisse.
  **GREEN:** Implementada validação de SPKI DER SHA-256 e rejeição de âncoras fora de local confiável do operador.
- **RED:** Números com zeros à esquerda (`01`) e surrogates isolados eram aceitos pelo parser JSON simplificado.
  **GREEN:** Parser estrito RFC 8259 com validação lexical de inteiros, frações, expoentes e sequências de escape Unicode.
- **RED:** Erros pós-reserva anteriores reportavam falsamente consumo zero em novas tentativas bloqueadas.
  **GREEN:** Separação entre `R16_EXISTING_SCIENTIFIC_STATE` (consumo histórico preservado) e `R16_ENGINEERING_PRELAUNCH_BLOCKED` (consumo 0).

---

## 7. Benchmark Reproduzível: Invalidação e Protocolo de Oito Repetições

### 7.1 Invalidação Metodológica do Benchmark Anterior
A descrição anterior do PR #43 afirmava que o tempo de agregação havia caído de aproximadamente 1.626 ms para 1,83 ms em 50.000 eventos.
A reprodução empírica sob o protocolo de teste demonstrou a causa raiz dessa discrepância:
- No teste anterior, o receipt de mock utilizado omitia campos de pré-condição obrigatórios (`tracingStarted`, `streamEof`).
- Como consequência, a rotina `_aggregate_trace` falhava imediatamente com `NATIVE_TRACE_INCOMPLETE_OR_DATA_LOSS` e retornava em **0,18 ms** antes de consumir qualquer evento do gerador.
- Portanto, o tempo medido refletia apenas uma falha antecipada de validação de metadados, e **não** o processamento real de 50.000 eventos.
- **Conclusão:** O benchmark preliminar é formalmente declarado **INVALIDATED / NOT COMPARABLE**.

### 7.2 Resultados do Benchmark Controlado de 8 Repetições
Executado sob Python 3.12 (Windows x64) processando fluxos completos de traces JSON válidos com 4 checkpoints reais, mapeamento heaps_v2 e eventos de background:

| Configuração | Eventos | Tamanho | Agregação (ms)<br>Mediana ± DesvPadrão | Diagnóstico (ms)<br>Mediana ± DesvPadrão | Tempo Total (ms)<br>Mediana ± DesvPadrão | Pico Memória (tracemalloc) | Status Contratual |
|---|---:|---:|---:|---:|---:|---:|---|
| **Small** | 500 | 101,6 KB | 15,13 ± 4,78 ms | 18,71 ± 8,93 ms | 33,78 ± 13,40 ms | **205,2 KB** | `NATIVE_CAPABILITY_PASS` |
| **Medium** | 5.000 | 1.011,2 KB | 163,09 ± 45,24 ms | 237,19 ± 19,05 ms | 412,50 ± 57,14 ms | **339,4 KB** | `NATIVE_CAPABILITY_PASS` |
| **Large** | 20.000 | 4.053,7 KB | 787,82 ± 116,42 ms | 1.159,97 ± 244,43 ms | 1.925,48 ± 293,32 ms | **339,3 KB** | `NATIVE_CAPABILITY_PASS` |
| **X-Large** | 50.000 | 10.147,4 KB | 1.908,79 ± 119,24 ms | 2.806,86 ± 293,00 ms | 4.793,63 ± 262,61 ms | **339,2 KB** | `NATIVE_CAPABILITY_PASS` |
| **Falha Precoce** | 50.000 | 10.147,4 KB | 0,18 ± 0,05 ms | N/A | 0,18 ± 0,05 ms | 14,2 KB | `NATIVE_STOP` *(reprodução do artefato)* |

### 7.3 Análise Assintótica
1. **Streaming com Memória Estritamente O(1):**
   O pico de memória adicional permaneceu estável em **~339 KB** tanto para 5.000 eventos (1 MB) quanto para 50.000 eventos (10,1 MB), comprovando que o `JsonStream` não carrega o trace integralmente na memória RAM.
2. **Complexidade de Tempo Linear O(N):**
   O tempo de agregação e diagnóstico cresce de maneira estritamente linear com o volume de dados (15 ms para 500 ev → 1,9 s para 50.000 ev), refletindo a taxa natural de decodificação JSON e varredura de eventos sem gargalos quadráticos.

---

## 8. Procedimento Operacional para Futura Execução Autorizada

Para executar a campanha quando a aprovação formal for concedida pelo Diretor Científico:

1. **Provisionar a Âncora de Confiança:**
   Registrar a chave pública SPKI Ed25519 em arquivo de trust store de operador protegido por ACL.
2. **Executar Preflight Offline:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --offline-preflight --source-output .quality/readiness-wave12-r12-factorial
   ```
3. **Congelar o HEAD:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --freeze
   ```
4. **Receber e Gravar a Autorização Externa Assinada:**
   Gravar o documento com assinatura Ed25519 (vinculado ao `freezeSha256`, `implementationHead` e autoridade).
5. **Disparar a Captura Única de Capability:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --run-capability --source-output .quality/readiness-wave12-r12-factorial --authorization <caminho-da-autorizacao>
   ```
6. **Verificar a Publicação e Encerramento:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --verify-publication
   ```

---

## 9. Auditoria de Segurança e Integridade

- **Gitleaks:** `gitleaks protect --staged` executado — 0 segredos ou chaves detectados. Nenhuma chave privada ou credencial real persistida no repositório.
- **Git diff check:** `git diff --check` executado — 0 conflitos ou espaços em branco incorretos.
- **Privacidade e Proteção de Dados:** Nenhuma chave privada, token de sessão, PID pessoal ou caminho absoluto confidencial foi publicado.

---

## 10. Status da Integração Contínua (CI)

- **Pull Request:** [PR #43](https://github.com/LViniciusk/SaveBox2/pull/43) (branch: `investigation/ap06-r16-native-capability`, base: `frontend`).
- **Suíte AP-06:** 62/62 testes unitários PASS (incluindo 25 contratos contratuais R16 e testes de isolamento R13/R14).
- **Frontend Unit Tests:** 1.530/1.530 testes Karma com status SUCCESS.
- **GitHub Actions:** Backend CI (Linux Coverage, Linux GCC, Windows MSVC), E2E e Quality Report verificados.
