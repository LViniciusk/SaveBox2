# Dossiê Pós-Mortem e Hardening de Contratos AP-06 (R12-R14)

- **Repositório:** `LViniciusk/SaveBox2`
- **PR:** #39 — `investigation(ap06): R12-R13 native MemoryInfra recovery`
- **Branch:** `investigation/ap06-r12-r13-native`
- **Base do PR:** `integration/ap06-r12-stabilization`
- **HEAD científico congelado da R14:** `0297ac698a7583b2d6f6d031e7438ee24af97948`
- **HEAD documental anterior:** `f14a73dea360872f81efe0460e3ac9b6f5109a1b`
- **Primeiro commit de hardening:** `bcf497934c9082ea2a20c0d777865dd6eded8a1d`
- **HEAD final desta rodada:** o commit que contém este documento; SHA exato e runs de CI estão registrados na descrição do PR #39 (um commit não pode conter o próprio SHA).
- **Orçamento científico consumido nesta TASK:** **Zero Chromium** (100% replay offline e hardening de contratos).

---

## 1. Sumário Executivo

A auditoria independente pós-R14 identificou cinco defeitos de engenharia no caminho nativo:

1. O agregador `MemoryInfra` rejeitava eventos legítimos e complementares do mesmo GUID de dump.
2. A prova de identidade do renderer usava `Number`/`BigInt` para um FILETIME de 64 bits acima de `Number.MAX_SAFE_INTEGER`.
3. O runner classificava `NATIVE_STOP` como decisão científica inconclusiva.
4. O cleanup de backend não era estritamente verificado e não distinguia backend não iniciado de evidência ausente.
5. O STOP publicado era modificado localmente depois do readback, quebrando a igualdade byte a byte.

Esta rodada corrigiu os contratos, reexecutou o parser **somente em leitura** sobre o trace R14 preservado, ampliou a matriz de testes negativos e manteve a decisão científica histórica intacta. Nenhum processo Chromium foi lançado.

---

## 2. Causa da Divergência: `NATIVE_DUMP_GUID_DUPLICATE` vs. Ausência de `heaps_v2`

### Defeito original

Em `tools/quality/ap06_native.py`, `_aggregate_trace()` rejeitava qualquer segundo evento do renderer com o mesmo GUID:

```python
if event_guid in renderer_dump_guids:
    raise NativeTraceError("NATIVE_DUMP_GUID_DUPLICATE")
```

O Chromium emite múltiplos registros `ph: "v"` sob o mesmo GUID: um com `process_totals` e outro com `allocators`/`allocators_graph`. O agregador abortava no segundo registro. Em seguida, `run_capability()` convertia esse STOP em uma decisão inconclusiva, registrando `NATIVE_DUMP_GUID_DUPLICATE` no manifesto terminal.

### Correção implementada

Em `tools/quality/ap06_native.py`:

1. Eventos complementares do mesmo GUID são fundidos em `dump_events[event_guid]`.
2. PID e timestamp precisam ser idênticos entre eventos do mesmo GUID (`NATIVE_DUMP_PID_CONFLICT`, `NATIVE_DUMP_TIMESTAMP_CONFLICT`).
3. Fragmentos idênticos não duplicam bytes, bins ou stacks.
4. Valores conflitantes em allocators continuam sendo STOP formal (`NATIVE_ALLOCATOR_STATS_DUPLICATE`).
5. A presença de `allocators` não é inferida como presença de `heaps_v2`.
6. `inspect_trace()` permanece estritamente diagnóstico e não promove replay a aceitação.

---

## 3. Diagnóstico Real do Trace Preservado (Replay Offline Read-Only)

O replay foi executado exclusivamente sobre o trace privado preservado na autoridade, com verificação de hash antes e depois.

- **Arquivo:** `.quality/readiness-wave12-r14-native/authority/r12-r14-native/traces/capability.json`
- **Tamanho:** 4.413.912 bytes
- **SHA-256 antes/depois:** `aefcdf7073eb9137b3c53959af4c93668a03ac19c3903d2901a9bbbde8f66086` (idêntico)
- **Freeze R14 (`freeze/freeze.json`):** `7f58532c8b4ff7021f3b51bbce23cd43db6a2fb95372a4e69e07813808bad658`
- **Decisão local e publicada (`final/decision.json`):** `d078c297e752f6e39757dc3bb9c59cd7eb0d9d35acbade3fbf3e3b38c069aa81` (idênticas)
- **Manifesto da decisão:** `82b06f2ebf85d261ee9d3d6fbebdbd8adedf29442dee108ec6f3577de35829fe`
- **STOP histórico R13 local vs. autoridade:** `97081f17bc48ba55914f61d4a8ce98b7040a58dad1421caae11f0b524ffd04d5` (idênticos)

### Fatos forenses observados

| Métrica | Valor observado |
|---|---|
| Total de eventos no trace | 668 |
| Eventos de dump de memória (`ph: "v"`) | 44 |
| Processos distintos | 5 |
| Dumps do renderer PID 27900 | 8 |
| Dumps de outros processos | 36 |
| GUIDs de checkpoint no receipt | 4 (`0x1` a `0x4`), únicos |
| GUIDs efetivamente correlacionados | 3 (`0x1`, `0x2`, `0x3`); `0x4` não aparece como dump renderer |
| Eventos associados a GUIDs de checkpoint | 33 |
| Referências repetidas ao mesmo GUID | 30, sem conflito de PID ou timestamp |
| Registros de allocator stats | 11.008 |
| Eventos com estrutura `heaps_v2` | **0** |
| Classificação estrita do parser corrigido | `NATIVE_INCONCLUSIVE` / `NATIVE_RENDERER_METADATA_MISSING` |
| Classificação diagnóstica adicional | `NATIVE_HEAPS_V2_NOT_EMITTED` (após binding) |

O receipt histórico da R14 **não contém** `rendererIdentityProof` nem `creationTimeExact`. Portanto o novo contrato de identidade não passaria com as evidências realmente disponíveis; essa é uma limitação de evidência histórica, não uma nova decisão científica. O caminho legado existe apenas para replay explícito e não é aceito como prova nova.

**Conclusão técnica:** a ausência de `heaps_v2` é confirmada após a correção do tratamento de duplicatas. A R14 permanece inconclusiva e **não é reclassificada** por este replay.

---

## 4. Precisão de FILETIME e Prova de Identidade

### Defeito

`GetProcessTimes` retorna um FILETIME de 64 bits em intervalos de 100 ns desde 1601. A R14 registrou `134368223588270130` para o renderer, acima de `Number.MAX_SAFE_INTEGER` (`2^53 - 1`). Comparações via `Number`/`BigInt` perdiam precisão ou rejeitavam processos legítimos.

### Correção

1. Python emite `creationTimeExact = str(creation_time)` diretamente do inteiro Win32.
2. `validate_canonical_filetime()` aceita somente decimal canônico (`^[1-9][0-9]*$`), sem zero à esquerda, sinal, decimal, expoente ou espaço, e limita a `uint64` (`<= 2^64 - 1`).
3. Node expõe `parseExactFiletime()` e `createRendererIdentityProof()` **exige** `creationTimeExact`; não há fallback para `Number` ou `BigInt`.
4. Novas provas comparam `creationTimeExact` da prova com `creationTimeExact` da auditoria Win32. Um `creationTime` legado só é comparado quando é inteiro seguro (`<= 2^53 - 1`); acima disso ele é ignorado por não representar o valor exato.
5. `validate_process_audit_receipt()` aceita `creationTimeExact` opcional, mas exige que ele seja canônico e igual ao `creationTime` inteiro.
6. `_legacy_proof_matches()` isola replay histórico e nunca é usado pelo agregador de novas provas.

---

## 5. Separação Estrita de STOP e Inconclusividade Científica

`run_capability()` classifica explicitamente:

```python
if status == 'NATIVE_CAPABILITY_PASS':
    return run_profiled_pair(wave, source, frozen, native)
if status == 'NATIVE_INCONCLUSIVE':
    return publish_inconclusive_decision(wave, capability)
if status == 'NATIVE_STOP':
    raise NativeContractFailure(capability.get('reason', 'NATIVE_TRACE_CONTRACT_INVALID'))
raise ValueError('NATIVE_CAPABILITY_STATUS_INVALID')
```

- `NATIVE_CAPABILITY_PASS`: autoriza o par A/B.
- `NATIVE_INCONCLUSIVE`: decisão terminal com `abAuthorized: false`, cleanup verificado e exit 0.
- `NATIVE_STOP`: STOP formal, cleanup obrigatório, exit 1; nunca vira `NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT`.
- Status desconhecido: STOP formal.

Em `run_profiled_pair()`, o agregado é classificado imediatamente após `validate_trace()`:

- `NATIVE_STOP` interrompe o par antes da segunda medição e levanta `NativeContractFailure`.
- Qualquer agregado não-PASS publica `R12R14_NATIVE_ALLOCATION_COVERAGE_INSUFFICIENT` com `abAuthorized: false` e sem segunda medição.
- O consumo (`capabilityChromium`, `measurementChromium`, `retries`) é derivado dos receipts duráveis em `execution_state()`, nunca de constantes.

---

## 6. Contrato de Cleanup e Imutabilidade do STOP

### Cleanup fail-closed

`stop_and_verify_backend_cleanup()` retorna somente `PASS`, `FAIL` ou `UNVERIFIED` e valida, nesta ordem:

1. Se o backend nunca iniciou, retorna `PASS` com `backendStarted: false` e `BACKEND_NOT_STARTED`, sem sondar portas.
2. Cria o marcador de parada e aguarda o supervisor real, quando existente.
3. Valida `baseline/backend-runtime.local.json`: JSON, `cwd` sob `pipeline/runtime-<16 hex>`, `storagePath = cwd/storage`, `storageId` de 64 hex e origem `http://127.0.0.1:<porta>`.
4. Valida `pipeline/backend-live.json` e `baseline/backend-isolation.json` contra a mesma origem, porta, storage e isolamento.
5. Sonda somente a porta do runtime próprio; listener ativo é `FAIL`, erro de sondagem é `UNVERIFIED`.
6. Exige `pipeline/backend-runtime-cleanup.json` com exatamente `{status, ownedServerStopped, ownedPostgresStopped, ownedClusterStorageAndDotenvRemoved, runtimePreservedForResume, personalServicesTouched, failureClass, errors}` e todos os booleanos corretos.
7. Exige que `cwd` e `storagePath` não existam mais.
8. Publica o receipt, faz readback independente e compara SHA-256 e tamanho.
9. Qualquer exceção inesperada retorna `UNVERIFIED` com classe do erro; nunca `except Exception: pass`.

### STOP imutável

1. `final/STOP.json` é gravado uma única vez com os fatos finais.
2. O SHA-256 local é calculado antes da publicação.
3. O STOP é publicado em `evidence/STOP.json`.
4. O readback confirma igualdade estrita de SHA-256.
5. O resultado da publicação vai para `final/stop-publication-readback.json`, sem editar o STOP.
6. Reexecução com STOP existente preserva os bytes e recusa sobrescrita.

O gate final do runner também compara o SHA-256 de `final/decision.json` com a entrada publicada antes de retornar exit 0, e exige `cleanupStatus == PASS`.

---

## 7. Matriz de Testes (RED → GREEN)

Os testes negativos foram adicionados antes das correções e falharam no estado RED (21 falhas e 5 erros em `test_ap06_r12_r14`, erro de importação em `test_ap06_native` e asserção no teste Node). Após as correções:

| Suíte | Resultado |
|---|---|
| `test_ap06_native.py` | 13 testes OK |
| `test_ap06_browser_identity.py` | 10 testes OK |
| `test_ap06_r12_r14.py` | 32 testes OK |
| `test_ap06_r12_r13.py` | 9 testes OK |
| `test_ap06_freeze.py` | 11 testes OK |
| Node `ap06-browser-identity.test.mjs` | 17 testes, 0 falhas |
| Node global (`node --test tools/*.test.mjs`) | 315 testes, 313 pass, 2 skipped, 0 fail |
| Python global pertinente (25 módulos AP-06, isolados) | 24 PASS; `test_ap06_r12_r9` bloqueado por privilégio ACL do host (código não alterado) |
| Quality Baseline Python | 45 testes OK |
| TypeScript (`npx tsc --noEmit -p tsconfig.json`) | 0 erros |
| Angular build (`npm run build`) | sucesso (somente warnings de budget) |

Cobertura inclui: FILETIME acima de `2^53 - 1`, `uint64` máximo, zero, negativo, decimal, exponencial, não canônico e valor arredondado por `Number`; prova sem vínculo com auditoria; PID correto com FILETIME divergente; cleanup não iniciado, config ausente/corrompida, origem estrangeira, ownership inválido, listener ativo, receipt incompleto, serviços pessoais tocados, runtime remanescente e readback divergente; `NATIVE_STOP` após o primeiro agregado; inconclusivo sem segunda medição; consumo derivado de receipts; STOP imutável e reexecução bloqueada. Nenhum threshold, hash, ACL ou limite de segurança foi reduzido.

---

## 8. Rastreabilidade de Commits, Gates e CI

| Marco | Commit |
|---|---|
| HEAD científico congelado da R14 | `0297ac698a7583b2d6f6d031e7438ee24af97948` |
| HEAD documental anterior | `f14a73dea360872f81efe0460e3ac9b6f5109a1b` |
| Primeiro hardening | `bcf497934c9082ea2a20c0d777865dd6eded8a1d` |
| HEAD final desta rodada | commit que contém este documento (SHA na descrição do PR #39) |

Gates finais reforçados:

- `NATIVE_STOP` e status desconhecido encerram com exit 1 e STOP durável.
- `NATIVE_INCONCLUSIVE` e cobertura insuficiente exigem cleanup `PASS` e publicação com readback.
- Exit 0 exige `final/decision.json` local, status idêntico ao decidido e SHA-256 igual ao manifesto publicado.
- STOP publicado e STOP local mantêm hashes idênticos; o receipt de publicação é separado.

CI final: os três workflows (`Backend CI`, `Frontend CI` e `Quality Baseline`) foram executados no HEAD final; SHA exato, run IDs e conclusão por job estão na descrição do PR #39. Workflows antigos não são usados como validação deste código.

---

## 9. Separação Engenharia vs. Ciência e Limitações Persistentes

**Engenharia:** os cinco contratos foram corrigidos; a matriz de testes e os gates finais estão verdes. O replay é diagnóstico e não altera a autoridade.

**Ciência:** a R14 continua `R12R14_NATIVE_CAPABILITY_INCONCLUSIVE`, com `abAuthorized: false`. Esta TASK não criou R15, não abriu nova autoridade, não repetiu capability, não executou A/B e não alterou freeze, raws, decisões ou STOPs históricos.

**Limitação persistente:** o Chromium headless-shell usado na R14 não emitiu buffers `heaps_v2`; sem quatro dumps correlacionados nessa estrutura, nenhuma medição A/B é autorizada. O receipt histórico também não contém `rendererIdentityProof`/`creationTimeExact`, então o novo contrato de identidade não pode ser satisfeito retroativamente. Uma conclusão nativa exigiria nova investigação autorizada, fora do escopo desta TASK.

---

## 10. Errata de Links do Relatório Histórico

O relatório `docs/qualidade/ap06-r12-r14.md` é preservado byte a byte como registro histórico. Seus links absolutos `file:///C:/Users/...` não são portáveis entre máquinas; as referências relativas equivalentes, a partir de `docs/qualidade/`, são:

- `../../tools/quality/ap06_freeze.py`
- `../../frontend/tools/ap06-browser-identity.mjs`
- `../../tools/quality/ap06_native.py`
- `../../tools/quality/run_ap06_r12_r13_native.py`
- `../../tools/quality/test_ap06_native.py`
- `../../tools/quality/test_ap06_r12_r13.py`
- `../../tools/quality/test_ap06_r12_r14.py`
- `../../tools/quality/test_ap06_freeze.py`
- `../../frontend/tools/ap06-browser-identity.test.mjs`
- `../../frontend/tools/ap06-native-trace.test.mjs`
- `../../frontend/tools/ap06-native-integration.test.mjs`

Nenhum byte do relatório histórico, do freeze, dos raws, das decisões ou dos STOPs foi alterado por esta errata.
