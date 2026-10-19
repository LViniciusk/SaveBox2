# AP-06 R16 — Controlled Native Profiling Capability

**Classificação:** `R16_ENGINEERING_READY_AWAITING_AUTHORIZATION` — Engenharia e infraestrutura concluídas, suíte de 14 contratos íntegra, validações verdes; nenhuma execução de Chromium científico autorizada ou realizada.

**Branch/PR:** `investigation/ap06-r16-native-capability` (base: `frontend`).

---

## 1. Escopo e Limites

Esta rodada entrega a infraestrutura completa, isolada e verificada para a campanha **AP-06-R12-R16-native**, atendendo a todas as diretrizes da especificação `quality/ap06-r12-r16.md` e do protocolo de autoridade:

1. **Zero execução científica de Chromium:** Nenhum browser real foi instanciado com finalidade de medição nesta TASK. Todas as validações utilizam traces sintéticos, mocks contratuais ou CDP simulado.
2. **Caminho desacoplado exclusivo de capability:** Ao contrário das rodadas R13/R14 (nas quais um PASS de capability encadeava medição A/B imediata), a R16 desacopla completamente a capability de qualquer medição pareada. Um `NATIVE_CAPABILITY_PASS` publica decisão terminal de capability e encerra a execução com `abAuthorized: False` e `measurementChromium: 0`.
3. **Barreira explícita de autorização científica:** O runner e a preparação exigem aprovação formal assinada, hash exato de `task.md`, HEAD congelado e orçamento com `maximum: 1, retries: 0, profiled: 0`. Nenhum arquivo de autorização foi criado em disco.
4. **Isolamento de autoridade e freeze:** Autoridade própria (`.owned-ap06-r12-r16-native`) e namespace estrito (`.quality/readiness-wave12-r16-native`), mantendo as evidências históricas de R12, R13 e R14 intactas.

---

## 2. Arquitetura e Desacoplamento da Capability

### 2.1 Separação Funcional do Runner
Nas campanhas legadas, a função `run_capability` realizava o teste de capability e, caso obtivesse sucesso, invocava diretamente `run_profiled_pair(wave, source, frozen, native)`. Para a R16:
- Extraiu-se `capture_capability_once(wave, source, frozen=None, native=None)` para isolar a captura unitária.
- Implementou-se `publish_capability_pass_decision(wave, capability)`:
  - Executa limpeza rigorosa de backend com `stop_and_verify_backend_cleanup(wave)`.
  - Audita consumo durável (`capabilityChromium: 1`, `measurementChromium: 0`, `retries: 0`).
  - Registra explicitamente `abAuthorized: False`.
  - Publica `final/decision.json` com status `R12R16_NATIVE_CAPABILITY_PASS`.
  - **Nunca invoca medições A/B (`run_profiled_pair`).**

### 2.2 Orçamento R16 (`R16_BUDGET`)
O orçamento pré-registrado da campanha foi fixado em:
```python
R16_BUDGET = {
    'capability': 1,
    'profiledA': 0,
    'profiledB': 0,
    'maximum': 1,
    'retries': 0,
}
```
Qualquer tentativa de autorizar ou executar medições além de 1 lançamento de capability resulta em falha de contrato `R12R16_SCIENTIFIC_AUTHORIZATION_INVALID`.

---

## 3. Autoridade, Namespace e Custódia

| Entidade | Valor Registrado | Isolamento Comprovado |
|---|---|---|
| Campanha | `AP-06-R12-R16-native` | `CAMPAIGNS['AP-06-R12-R16-native'] = '.owned-ap06-r12-r16-native'` |
| Namespace Freeze | `readiness-wave12-r16-native` | Incluído em `strict_freeze_namespace` e `validate_test_receipt` |
| Namespace Publicação | `r12-r16-native` | Suporte a `r12-r16-native` em `run_ap06_r9.py` |
| Runner Exclusivo | `tools/quality/run_ap06_r12_r16_native.py` | Configura campaign `AP-06-R12-R16-native`, output `.quality/readiness-wave12-r16-native`, task `quality/ap06-r12-r16.md` |

---

## 4. Barreira de Autorização Científica

A validação em `validate_scientific_authorization(wave, authorization_path=None)` impõe:
1. Arquivo `baseline/scientific-authorization.json` assinado por signatário válido (`signer` ou `approvedBy`).
2. `campaign == "AP-06-R12-R16-native"`.
3. `scope == "capability-only"`.
4. `approvedByTaskSha256` igual ao hash SHA-256 de `quality/ap06-r12-r16.md`.
5. `implementationHead` correspondente ao commit congelado.
6. `budget` idêntico a `R16_BUDGET` (`maximum: 1, retries: 0, profiled: 0`).
7. Ausência de `pipeline/capability-reservation.json`, `final/STOP.json` ou `final/decision.json` (bloqueio irrestrito contra retries/resumes).

Sem esse arquivo, o comando `--run-capability` falha imediatamente com `R12R16_SCIENTIFIC_AUTHORIZATION_INVALID`, antes de criar reservas ou disparar qualquer processo. O preflight offline registra `R16_ENGINEERING_READY_AWAITING_AUTHORIZATION`.

---

## 5. Captura Nativa e Quatro Checkpoints

A captura preserva a sequência estrita da R15:
```javascript
const CHECKPOINTS = [
  'baseline',
  'cycle-6-close',
  'idle-120s',
  'forced-GC-final'
];
```
Flags atestadas mantidas:
- `--memlog=all`
- `--memlog-stack-mode=native`
- `--memlog-sampling-rate=16384`
- `--memlog-keep-small-allocations`

Condições de aceitação comprovadas:
1. Renderer identificado por PID e criação exata.
2. 4 requests explícitos `GlobalMemoryDump`.
3. 4 dumps correspondentes do renderer.
4. GUIDs canônicos e únicos.
5. `heaps_v2` v1 válido no renderer.
6. Fechamento completo do browser e liberação de handles.

---

## 6. Análise Upstream do Chromium e Proposta de Executável Alternativo

### 6.1 Limitações Conhecidas do `chromium-headless-shell` no Windows
A investigação da arquitetura upstream do Chromium (especialmente nas versões headless-shell para Windows x64) revelou:
- **Ausência de ganchos do heap profiler no processo renderer:** No binário `chromium-headless-shell`, a infraestrutura de tracing MemoryInfra está compilada, porém os ganchos do HeapProfiler (`base::trace_event::AllocationRegister` / PartitionAlloc / malloc shims) frequentemente não são inicializados nos processos sandboxed do renderer sob Windows Job Objects.
- **Processos auxiliares vs. Renderer:** Dumps `heaps_v2` podem ser emitidos por processos de utility ou browser, mas não pelo renderer principal onde o código WebAssembly/JavaScript é executado, resultando no diagnóstico `OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2`.
- **Símbolos nativos sanitizados:** O empacotamento headless-shell omite tabelas de símbolos necessárias para atribuição completa de stack trace sob Windows.

### 6.2 Proposta Técnica de Chromium Alternativo
Caso uma futura execução autorizada confirme a indisponibilidade funcional do `chromium-headless-shell`:
1. **Binário Proposto:** `chrome.exe` oficial com flag `--headless=new` (versão estável correspondente).
2. **Protocolo de Integração:**
   - Registrar novo hash SHA-256 e identidade em `baseline/browser-identity.json`.
   - Congelar caminho de execução em `baseline/native-binary-reuse.json`.
   - Manter launch flags inalteradas (`--memlog=all`, `--memlog-stack-mode=native`, etc.).
   - Reexigir aprovação formal do Diretor Científico antes de qualquer substituição de binário.

---

## 7. Limpeza e Auditoria de Backend

A limpeza executada por `stop_and_verify_backend_cleanup(wave)` garante:
- Encerramento do servidor backend de campanha e de processos órfãos (`processExitAudit: PASS`).
- Liberação total de handles (`handleRelease: PASS`).
- Verificação do PostgreSQL pertencente à campanha, assegurando isolamento contra serviços pessoais do usuário.
- Se a limpeza falhar (`cleanupStatus != "PASS"`), a emissão da decisão PASS é categoricamente bloqueada com `BACKEND_CLEANUP_FAILED`.

---

## 8. Suíte de Testes Contratuais (14 Casos Obrigatórios)

Todos os 14 cenários exigidos pela Seção 10 do documento de requisitos foram implementados e validados em `tools/quality/test_ap06_r12_r16.py`:

| Caso | Descrição | Expectativa Contratual | Resultado |
|---|---|---|---|
| **1** | Preflight íntegro, sem autorização | Preparação permitida; lançamento bloqueado | **PASS** |
| **2** | Autorização inválida ou pertencente à R14 | Bloqueio antes do launch | **PASS** |
| **3** | Capability sintética válida | PASS de capability, zero A/B | **PASS** |
| **4** | Quarto checkpoint ausente | INCONCLUSIVE (`NATIVE_CHECKPOINT_DUMPS_INCOMPLETE`) | **PASS** |
| **5** | `heaps_v2` apenas em processo auxiliar | Não comprova renderer (`OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2`) | **PASS** |
| **6** | Identidade FILETIME divergente | STOP (`_proof_matches` rejeita) | **PASS** |
| **7** | GUID duplicado em formatos equivalentes (`0x01` vs `0x1`) | STOP (`NATIVE_CHECKPOINT_GUID_DUPLICATE`) | **PASS** |
| **8** | Trace truncado ou checksum divergente | STOP (`NATIVE_TRACE_SCHEMA_INVALID` / `TRACE_CHECKSUM_INVALID`) | **PASS** |
| **9** | Cleanup incompleto | Sem decisão científica PASS (`BACKEND_CLEANUP_FAILED`) | **PASS** |
| **10** | Reserva já consumida | Sem retry (`R12R16_NATIVE_NO_RETRY_OR_RESUME`) | **PASS** |
| **11** | Capability PASS | Nunca chama medição A/B (`abAuthorized: False`, sem `run_profiled_pair`) | **PASS** |
| **12** | Autoridade R16 | Não modifica autoridades R13/R14 (`.owned-ap06-r12-r16-native`) | **PASS** |
| **13** | Namespace R16 | Publicação e readback corretos (`readiness-wave12-r16-native`) | **PASS** |
| **14** | Novo estado terminal R16 | Ledger e decisão consistentes (`expected_decision_launches`) | **PASS** |

### RED → GREEN de Bugs Encontrados Durante os Testes
- **Bug 1 (Mock Sequence):** No teste de capability pass, o mock de reserva prévio disparava a guarda de retry prematuramente. Corrigido com side effect que emite a reserva no momento exato do consumo.
- **Bug 2 (Alias Canônico de GUID):** Acesso a `side['checkpoints']` no lugar de `side['trace']['checkpoints']`. Corrigido e validado com rejeição de aliases numéricos (`0x01` == `0x1`).
- **Bug 3 (Trace Authority Path):** Arquivos de trace temporários precisavam estar confinados sob a raiz de autoridade registrada. Corrigido para `self.authority`.
- **Bug 4 (Escopo de `tag` em `validate_trace`):** A variável `tag` estava declarada apenas no bloco `else:`, causando `UnboundLocalError` quando executado em modo sintético pelo teste Node de integração. Corrigido para escopo global da função.

---

## 9. Benchmark Sintético de Desempenho (Seção 11)

Executado benchmark com **8 repetições** por configuração, avaliando o parser de streaming (`ap06_native.trace_events` + `aggregate_trace`) e a leitura diagnóstica (`diagnose_trace`):

| Configuração | Eventos | Tamanho (KB) | Parser Médio (ms) | Parser Min/Max (ms) | Diag Médio (ms) | Diag Min/Max (ms) | Pico Memória (KB) |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Small** | 500 | 47,3 | 14,31 | 11,31 / 15,87 | 4,93 | 3,99 / 5,72 | 123,1 |
| **Medium** | 5.000 | 455,6 | 168,13 | 108,26 / 237,83 | 54,71 | 38,72 / 89,39 | 272,5 |
| **Large** | 20.000 | 1.827,8 | 755,81 | 572,78 / 915,57 | 270,19 | 216,05 / 368,78 | 272,4 |
| **X-Large** | 50.000 | 4.581,7 | 1.626,03 | 1.453,80 / 1.742,30 | 645,62 | 546,53 / 1.006,44 | 272,7 |

**Análise de Desempenho:**
- **Pico de Memória Constante:** O pico de alocação de memória estabiliza em ~272 KB a partir de 500 KB e permanece inalterado até 4,58 MB (50.000 eventos). Isso comprova a eficácia do parser via generator/streaming (`JsonStream` chunked a 64 KB), sem buffering do arquivo inteiro em memória.
- **Escalabilidade Linear $O(N)$:** O tempo de processamento cresce de forma perfeitamente linear e previsível tanto no parser quanto na inspeção diagnóstica.

---

## 10. Integridade Histórica Preservada

Os artefatos e decisões históricas permanecem intocados e verificados em modo somente leitura:
- **Freeze R14:** `0297ac698a7583b2d6f6d031e7438ee24af97948`
- **Trace R14:** `aefcdf7073eb9137b3c53959af4c93668a03ac19c3903d2901a9bbbde8f66086`
- **Decisão R14:** `d078c297e752f6e39757dc3bb9c59cd7eb0d9d35acbade3fbf3e3b38c069aa81`
- **STOP R13:** `97081f17bc48ba55914f61d4a8ce98b7040a58dad1421caae11f0b524ffd04d5`

Nenhum resultado de STOP histórico foi reclassificado e nenhum dado privado foi publicado.

---

## 11. Instruções para Futura Execução Autorizada

Quando houver emissão formal de aprovação pelo Diretor Científico, o operador deverá seguir este procedimento estrito:

1. **Emitir Autorização Científica:**
   Gravar em `.quality/readiness-wave12-r16-native/baseline/scientific-authorization.json`:
   ```json
   {
     "campaign": "AP-06-R12-R16-native",
     "scope": "capability-only",
     "approved": true,
     "approvedByTaskSha256": "<SHA-256 de quality/ap06-r12-r16.md>",
     "implementationHead": "<HEAD congelado>",
     "signer": "<Chave do Diretor Científico>",
     "budget": {
       "capability": 1,
       "profiledA": 0,
       "profiledB": 0,
       "maximum": 1,
       "retries": 0
     }
   }
   ```
2. **Executar o Preflight:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --offline-preflight
   ```
3. **Disparar a Captura Única de Capability:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --run-capability --authorization .quality/readiness-wave12-r16-native/baseline/scientific-authorization.json
   ```
4. **Verificar a Publicação e Encerramento:**
   O runner validará os 4 checkpoints, auditará o renderer, encerrará o browser, executará o cleanup do backend e publicará `final/decision.json` (`R12R16_NATIVE_CAPABILITY_PASS` ou `R12R16_NATIVE_CAPABILITY_INCONCLUSIVE`).
   Em nenhuma circunstância haverá disparos adicionais de Chromium ou tentativas de A/B.

---

## 12. CI no HEAD de Entrega

| Workflow | Resultado | Run | SHA |
|---|---|---|---|
| **Quality Baseline** (quality-report, e2e) | **Sucesso** (2m18s) | [39231317047](https://github.com/LViniciusk/SaveBox2/actions/runs/39231317047) | `e6cefd70b2d2c61e00a07cde308bec26717e478c` |
| **Frontend CI** (Linux, Windows) | **Sucesso** (2m05s) | [39231477233](https://github.com/LViniciusk/SaveBox2/actions/runs/39231477233) | `e6cefd70b2d2c61e00a07cde308bec26717e478c` |
| **Backend CI** (Linux GCC, Linux Coverage, Windows MSVC) | **Sucesso** (7m10s) | [39231317073](https://github.com/LViniciusk/SaveBox2/actions/runs/39231317073) | `e6cefd70b2d2c61e00a07cde308bec26717e478c` |

**Pull Request:** [PR #43](https://github.com/LViniciusk/SaveBox2/pull/43) direcionado à base `frontend`. Nenhum merge automático foi executado.
