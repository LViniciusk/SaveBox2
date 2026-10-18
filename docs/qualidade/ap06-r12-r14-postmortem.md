# Dossiê Pós-Mortem e Hardening de Contratos AP-06 (R12-R14)

**Repositório:** `LViniciusk/SaveBox2`  
**PR:** #39 — `investigation(ap06): R12-R13 native MemoryInfra recovery`  
**Branch:** `investigation/ap06-r12-r13-native`  
**HEAD congelado inicial (científico):** `f14a73dea360872f81efe0460e3ac9b6f5109a1b`  
**Orçamento científico consumido nesta TASK:** **Zero Chromium** (100% replay offline e hardening de contratos).  

---

## 1. Sumário Executivo

A auditoria independente pós-R14 identificou que a decisão registrada `R12R14_NATIVE_CAPABILITY_INCONCLUSIVE` continha o motivo `NATIVE_DUMP_GUID_DUPLICATE`, levantado pelo agregador de traces de memória. Esse erro resultava de uma limitação no agregador, que rejeitava múltiplos eventos legítimos e complementares do Chromium associados ao mesmo GUID de dump. Além disso, o timestamp FILETIME de 64 bits do processo renderer excedia o limite seguro `Number.MAX_SAFE_INTEGER` do JavaScript, impedindo a geração da prova de identidade canônica, o classificador do runner mascarava erros contratuais como inconclusividade científica, o helper de cleanup de backend não estava integrado ao encerramento formal da campanha, e o STOP durável era modificado localmente após a publicação na autoridade, rompendo a igualdade byte a byte.

Esta TASK executou integralmente a correção desses cinco contratos de engenharia, realizou o replay diagnóstico estritamente em leitura do trace R14 preservado, expandiu a suíte de testes unitários e integrados (Node e Python), e validou todas as etapas sem lançar nenhum processo Chromium.

---

## 2. Causa da Divergência: `NATIVE_DUMP_GUID_DUPLICATE` vs. Ausência de `heaps_v2`

### O Defeito Original
Em `tools/quality/ap06_native.py`, a função `_aggregate_trace()` mantinha a verificação simplista:
```python
if event_guid in renderer_dump_guids:
    raise NativeTraceError("NATIVE_DUMP_GUID_DUPLICATE")
```
Durante um checkpoint `MemoryInfra`, o Chromium headless-shell emite múltiplos registros de dump sob o mesmo GUID para o processo renderer:
- **Evento 1:** Contém `process_totals` (nível de detalhe e totais privados/residentes do processo).
- **Evento 2:** Contém o mapa `allocators` e o grafo `allocators_graph`.

O agregador abortava no segundo evento considerando-o uma duplicação inválida. Em seguida, o runner `run_capability()` em `tools/quality/run_ap06_r12_r13_native.py` tratava qualquer status diferente de `NATIVE_CAPABILITY_PASS` como uma decisão científica inconclusiva, gravando `NATIVE_DUMP_GUID_DUPLICATE` no manifesto terminal.

### Correção Implementada
Em `tools/quality/ap06_native.py`:
1. Implementada a fusão de eventos complementares por GUID (`dump_events[event_guid]`).
2. Validação rigorosa de identidade do dump: verificação de que PID e timestamp são idênticos entre eventos do mesmo GUID (`NATIVE_DUMP_PID_CONFLICT` e `NATIVE_DUMP_TIMESTAMP_CONFLICT`).
3. Fragmentos idênticos não duplicam bytes nem stack bins.
4. Conflitos de valores em allocators geram STOP formal (`NATIVE_ALLOCATOR_STATS_DUPLICATE`).
5. A presença de `allocators` não é inferida como presença de `heaps_v2`.

---

## 3. Diagnóstico Real do Trace Preservado (Replay Offline Read-Only)

O replay foi executado exclusivamente sobre o trace original preservado na autoridade privada, verificando hashes antes e após a análise:

- **Arquivo:** `.quality/readiness-wave12-r14-native/authority/r12-r14-native/traces/capability.json`
- **Tamanho:** 4.413.912 bytes
- **SHA-256:** `aefcdf7073eb9137b3c53959af4c93668a03ac19c3903d2901a9bbbde8f66086`
- **Status do Freeze R14:** Íntegro (SHA-256: `7f58532c8b4ff7021f3b51bbce23cd43db6a2fb95372a4e69e07813808bad658`)
- **Decisão Histórica:** Preservada inalterada em `.quality/readiness-wave12-r14-native/final/decision.json`

### Fatos Forenses Observados
| Métrica | Valor Observado |
|---|---|
| Total de eventos no trace | 668 |
| Eventos de dump de memória (`ph: "v"`) | 44 (distribuídos entre 5 processos) |
| Total de registros de allocators | 11.008 |
| Eventos com estrutura `heaps_v2` | **0** (completamente ausente no renderer e demais processos) |
| Checkpoints correlacionados | GUIDs 1, 2 e 3 presentes (GUID 4 emitido com ID base 0 pelo Chromium) |
| Motivo do diagnóstico corrigido | `NATIVE_HEAPS_V2_NOT_EMITTED` / `NATIVE_RENDERER_METADATA_MISSING` |
| Classificação técnica corrigida | **`NATIVE_INCONCLUSIVE`** (Replay Diagnóstico) |

**Conclusão Técnica:** O erro de duplicação mascarava a realidade de que a sessão Chromium não emitiu buffers `heaps_v2`. O resultado científico final da R14 permanece estritamente inconclusivo, confirmando que a configuração de flags e ambiente do Chromium headless-shell 151 não expôs a árvore de heaps nativos.

---

## 4. Correção da Precisão de FILETIME e Prova de Identidade

### O Defeito
No Win32, os tempos de criação de processo retornados por `GetProcessTimes` são representados em intervalos de 100 nanossegundos desde 1º de janeiro de 1601 (FILETIME de 64 bits). Na R14, o tempo do renderer atingiu `134368223588270130`.  
Como `Number.MAX_SAFE_INTEGER` em JavaScript é $9.007.199.254.740.991$ ($2^{53}-1$), a verificação `Number.isSafeInteger(auditedRenderer.creationTime)` falhava e rejeitava processos legítimos.

### Implementação
1. **Representação Canônica:** O timestamp exato é gerado em Python diretamente do inteiro Win32 como string decimal: `creationTimeExact = str(creation_time)`.
2. **Validação no Node (`frontend/tools/ap06-browser-identity.mjs`):**
   - Função exportada `parseExactFiletime(value)` validando expressão `/^[1-9][0-9]*$/` e conferindo que o valor cabe em 64 bits sem sinal (`BigInt(value) <= (1n << 64n) - 1n`).
   - `createRendererIdentityProof()` passa a aceitar `creationTimeExact` string sem conversão para `Number`.
3. **Validação no Python (`tools/quality/ap06_native.py` e `tools/quality/ap06_browser_identity.py`):**
   - Função `validate_canonical_filetime()` aplicando regex estrita e limite de 64 bits uint64.
   - `_proof_matches()` compara os valores canônicos preservando total precisão numérica.

---

## 5. Separação Estrita de STOP e Inconclusividade Científica

O runner `run_capability()` em `tools/quality/run_ap06_r12_r13_native.py` foi reestruturado com classificação explícita em 4 vias:

```python
status = capability.get('status')
if status == 'NATIVE_CAPABILITY_PASS':
    return run_profiled_pair(wave, source, frozen, native)
if status == 'NATIVE_INCONCLUSIVE':
    return publish_inconclusive_decision(wave, capability)
if status == 'NATIVE_STOP':
    raise NativeContractFailure(capability.get('reason', 'NATIVE_TRACE_CONTRACT_INVALID'))
raise ValueError('NATIVE_CAPABILITY_STATUS_INVALID')
```

- `NATIVE_CAPABILITY_PASS`: Autoriza a medição A/B do par profilado.
- `NATIVE_INCONCLUSIVE`: Produz decisão científica terminal com `abAuthorized: false`, executa o cleanup verificado e encerra com **Exit 0**.
- `NATIVE_STOP`: Levanta `NativeContractFailure`, aciona `record_durable_stop()` e encerra com **Exit 1**.
- Status desconhecido: Bloqueado como STOP e encerra com **Exit 1**.

---

## 6. Contrato de Cleanup Obrigatório e Imutabilidade do STOP

### Cleanup de Backend Integrado
1. O helper `stop_and_verify_backend_cleanup()` foi integrado em todas as saídas da campanha:
   - Capability PASS (encerramento pós A/B).
   - Capability INCONCLUSIVE (encerramento antes de qualquer A/B).
   - STOP pós-reserva.
   - STOP pós-lançamento.
   - Falha de publicação.
   - Falha durante o par profilado A/B.
2. A porta do backend é obtida dinamicamente a partir de `backend-runtime.local.json` (`backendOrigin`), evitando assumir portas globais fixas.
3. A ausência de listener, a confirmação do recibo `backend-runtime-cleanup.json` com status `PASS` e a inexistência de diretórios remanescentes de runtime/storage são exigidos antes de conceder status `PASS`.
4. Falha ou recibo ausente retorna `FAIL` ou `UNVERIFIED`, bloqueando qualquer resultado GREEN operacional.
5. Falha no cleanup durante um STOP não mascara o motivo de falha original.

### STOP Imutável Pós-Publicação
1. O arquivo `final/STOP.json` é gravado uma única vez com os fatos conhecidos, **sem** a chave mutável `publicationStatus: PENDING`.
2. O SHA-256 local é calculado.
3. O STOP é publicado na autoridade (`evidence/STOP.json`).
4. A publicação é confirmada por readback independente conferindo igualdade estrita do digest SHA-256.
5. O resultado da publicação é gravado em recibo separado: `final/stop-publication-readback.json`.
6. O hash do arquivo local `final/STOP.json` é idêntico byte a byte ao hash do arquivo na autoridade (`stopSha256`).
7. Reexecuções quando `final/STOP.json` já existe preservam o arquivo e recusam sobrescrita.

---

## 7. Matriz de Testes (RED → GREEN)

Todos os testes foram executados localmente e validados em ambiente offline (zero Chromium):

1. **Testes do Agregador e Parser Nativo (`tools/quality/test_ap06_native.py`):**
   - 12 testes passando (1.59s): fusão estruturada de eventos válidos por GUID, fragmentos complementares, dois eventos idênticos sem duplicação de métricas, detecção de conflitos de allocators, timestamps inconsistentes, conflito de PID, representações canônicas de FILETIME e limites de arrays.
2. **Testes de Identidade e Prova do Renderer (`frontend/tools/ap06-browser-identity.test.mjs`):**
   - 20 testes passando (14.1s): validação de FILETIME $> 2^{53}-1$, rejeição de exponenciais, inteiros negativos, números truncados, prova de identidade ligada ao processo perfilado e auditorias Win32.
3. **Testes do Runner e Imutabilidade (`tools/quality/test_ap06_r12_r14.py`):**
   - 19 testes passando (9.43s): classificação em 4 vias do runner, paridade byte a byte de hashes do STOP publicado, isolamento de recibo de readback, bloqueio de reexecução com STOP, falha de publicação preservando STOP local, erro de cleanup preservando causa primária, e detecção dinâmica de portas.
4. **Testes de Regressão Histórica (`tools/quality/test_ap06_r12_r13.py` e `test_ap06_freeze.py`):**
   - 20 testes passando (32.14s): conformidade de autoridade, ausência de regressões em freeze e estabilidade das campanhas R12-R13 e R12-R14.
5. **Verificação de Tipos TypeScript:**
   - `npx tsc --noEmit -p tsconfig.app.json`: 0 erros.

---

## 8. Rastreabilidade de Commits e HEADs

- **HEAD congelado inicial (R14 freeze):** `f14a73dea360872f81efe0460e3ac9b6f5109a1b`
- **Branch de trabalho:** `investigation/ap06-r12-r13-native`
- **PR:** #39
- **Escopo das alterações:**
  - `tools/quality/ap06_native.py`
  - `tools/quality/ap06_browser_identity.py`
  - `tools/quality/run_ap06_r12_r13_native.py`
  - `tools/quality/run_ap06_r12_r14_native.py`
  - `tools/quality/test_ap06_native.py`
  - `tools/quality/test_ap06_r12_r14.py`
  - `frontend/tools/ap06-browser-identity.mjs`
  - `frontend/tools/ap06-browser-identity.test.mjs`
  - `docs/qualidade/ap06-r12-r14-postmortem.md`
