# AP-06 R16 — Hardened Native Profiling Capability & Cryptographic Authorization

**Classificação:** `R16_ENGINEERING_READY_AWAITING_AUTHORIZATION` — Engenharia e infraestrutura concluídas, verificação Ed25519 estrita com âncora independente (SPKI DER SHA-256), máquina de estados durável contra concorrência e preservação de evidências, parser JSON estrito RFC 8259, suíte de 25 contratos íntegra (25/25 PASS), validações verdes; nenhuma execução de Chromium científico autorizada ou realizada. Lançamento operacional bloqueado até o provisionamento da âncora de confiança pelo Diretor Científico.

- **Repositório:** `LViniciusk/SaveBox2`
- **Branch:** `investigation/ap06-r16-native-capability`
- **Base:** `frontend`
- **PR:** [#43](https://github.com/LViniciusk/SaveBox2/pull/43)
- **HEAD:** `27666091`

---

## 1. Findings Encontrados, Prioridade e Resolução

| ID | Prioridade | Descrição do Problema | Correção Implementada | Estado |
|---|---|---|---|---|
| **F-01** | Crítica | Autenticação por `signer` textual sem criptografia | Verificador Ed25519 estrito (`verify_scientific_authorization.mjs`) via `node:crypto.verify` com RFC 8785 canonical JSON e fail-closed. | **RESOLVIDO** |
| **F-02** | Alta | `main()` gerava STOP durável para erros de validação prévia | Máquina de estados explícita: bloqueios de preflight/argumentos/autorização retornam `R16_ENGINEERING_PRELAUNCH_BLOCKED` (exit 1), sem gravar `final/STOP.json`. | **RESOLVIDO** |
| **F-03** | Média | `COMPLETED_STATUSES` aceitava PASS de capability em campanhas históricas | Restrito estritamente a `AP-06-R12-R16-native`. Campanhas R13/R14 rejeitam status de capability com `NATIVE_DECISION_STATUS_INVALID`. | **RESOLVIDO** |
| **F-04** | Média | Fallback permissivo de efetividade de heap | Exigência estrita de `heapProfilingEffective is True` e auditoria de contadores de execução. | **RESOLVIDO** |
| **F-05** | Média | Preflight falhava na presença de autorização | Preflight lê e valida em modo estritamente read-only sem consumir reservas nem lançar browser. | **RESOLVIDO** |
| **F-06** | Média | CLI permissiva e omissão de `--source-output` | Subcomando `--run` proibido na R16; `--run-capability` exclusivo da R16; `--source-output` obrigatório. | **RESOLVIDO** |
| **F-07** | Média | Booleans aceitos como inteiros (`True == 1`) no orçamento | Validação de tipos `type(v) is int and type(v) is not bool` em Python e Node. | **RESOLVIDO** |
| **F-08** | Baixa | Afirmações empíricas sem qualificação formal | Reclassificadas como `SUPPORTED_HYPOTHESIS` ou `UNVERIFIED` no dossiê técnico. | **RESOLVIDO** |
| **F-09** | Média | Contaminação de variáveis globais entre testes | Isolamento de importação e restauração total em `tearDown()` (62/62 testes PASS). | **RESOLVIDO** |
| **F-10** | Crítica | Trust anchor lido do documento ou caminhos editáveis | Raiz de confiança independente calculada sobre o SPKI DER SHA-256 da chave pública; rejeição de arquivos em `.quality/`, `baseline/` ou no repositório fora do harness (`R16_AUTHORIZATION_TRUST_ANCHOR_UNTRUSTED_LOCATION`). Rejeição de links simbólicos (`lstatSync.isSymbolicLink()`). | **RESOLVIDO** |
| **F-11** | Alta | Parser JSON vulnerável a zeros iniciais (`01`), surrogates e prototype pollution | Parser RFC 8259 estrito: rejeição de zeros à esquerda, surrogates isolados, objetos com `Object.create(null)` e validação de Base64 canônico de 64 bytes. | **RESOLVIDO** |
| **F-12** | Alta | Contabilidade presumia zero Chromium com reserva preexistente | Separação explícita entre erro pré-reserva (`R16_ENGINEERING_PRELAUNCH_BLOCKED`, consumo 0) e estado pré-existente (`R16_EXISTING_SCIENTIFIC_STATE`, consumo histórico preservado como `UNVERIFIED` ou contagem real). Adicionado lock atômico de processo contra concorrência (`R16_CONCURRENT_INVOCATION_REJECTED`). | **RESOLVIDO** |
| **F-13** | Média | Gate `global` não era validado no freeze R16 | Atualizado `validate_test_receipt` em `ap06_freeze.py`: gate `global: PASS` é obrigatório na R16; `DOCUMENTED_EXCEPTION` é rejeitado na R16 mantendo suporte a R13/R14. | **RESOLVIDO** |
| **F-14** | Média | Integração sintética não exercitava o produtor Node real | Criado `tools/quality/produce_synthetic_native_trace.mjs` integrando a classe real `NativeTrace` e CDP mock em 7 cenários contratuais (coberto pelo teste 22). | **RESOLVIDO** |
| **F-15** | Alta | Discrepância metodológica no benchmark anterior (1,83 ms para 50.000 eventos) | Declarado formalmente **INVALIDATED / NOT COMPARABLE** (causado por saída prematura em ~0,18 ms antes de consumir os eventos devido a pré-condição ausente no mock de receipt). Substituído por protocolo controlado de 8 repetições. | **RESOLVIDO** |

---

## 2. Modelo de Confiança Criptográfica Independente

### 2.1 Esquema e Raiz de Confiança
A raiz de confiança é estritamente externa e independente do payload assinado:
1. **Chave Pública Operacional:** Fornecida pelo operador fora do repositório (`trustAnchorPath`). Fora do harness de teste (`AP06_TEST_HARNESS !== '1'`), caminhos dentro do checkout, de `.quality/` ou de `baseline/` são terminantemente rejeitados com `R16_AUTHORIZATION_TRUST_ANCHOR_UNTRUSTED_LOCATION`.
2. **Fingerprint SPKI DER SHA-256:** A chave pública deve ser do tipo `ed25519`. O fingerprint é calculado sobre a exportação binária SPKI DER, garantindo imunidade a variações textuais de formatação PEM:
   ```javascript
   const key = createPublicKey(keyConfig.publicKey);
   if (key.asymmetricKeyType !== 'ed25519') throw new Error('R16_AUTHORIZATION_KEY_TYPE_INVALID');
   const spkiDer = key.export({ type: 'spki', format: 'der' });
   const derFingerprint = createHash('sha256').update(spkiDer).digest('hex');
   ```
3. **Assinatura Canônica de 64 Bytes:** A assinatura é validada para conter exatamente 64 bytes binários e round-trip estrito em Base64 (`decoded.toString('base64') === authDoc.signature`).
4. **Vínculo Imutável:** O documento assinado vincula estritamente:
   - `campaign`: `"AP-06-R12-R16-native"`
   - `scope`: `"capability-only"`
   - `implementationHead`: 40 hexadecimais do commit congelado
   - `taskSha256`: SHA-256 do arquivo da TASK
   - `freezeSha256`: SHA-256 do manifesto congelado
   - `authorityIdentity`: SHA-256 da autoridade local
   - `budget`: `{ capability: 1, profiledA: 0, profiledB: 0, maximum: 1, retries: 0 }`
5. **Zero Segredos no Repositório:** Nenhuma chave privada ou assinatura operacional existe no repositório. O utilitário `sign_test_authorization.mjs` é estritamente bloqueado para execução fora do harness de testes (`AP06_TEST_HARNESS === '1'`).

---

## 3. Alterações Efetivas no Código, Funções Removidas e Justificativas

1. **`tools/quality/verify_scientific_authorization.mjs`:**
   - Adicionada função `parseStrictJson(text)` em conformidade com a RFC 8259: rejeição de zeros à esquerda (`01`), números com formato inválido, caracteres de controle não escapados (< 0x20) e surrogates isolados.
   - Objetos criados via `Object.create(null)` para eliminar riscos de prototype pollution (`__proto__`, `constructor`).
   - Adicionada validação de links simbólicos via `lstatSync.isSymbolicLink()`.
   - Adicionada validação de fingerprint SPKI DER SHA-256 e de tipo assimétrico `ed25519`.
   - Restrição de localização do trust anchor fora do workspace git em produção.
2. **`tools/quality/sign_test_authorization.mjs`:**
   - Restrito via `process.env.AP06_TEST_HARNESS === '1'`. Tentativa de execução avulsa em ambiente operacional aborta imediatamente.
   - Atualizado para emitir fingerprints SPKI DER.
3. **`tools/quality/produce_synthetic_native_trace.mjs`:**
   - Novo componente de teste offline que instancia diretamente a classe real `NativeTrace` do frontend e conecta uma sessão Mock CDP determinística para emitir streams reais (`writeTraceStream`) e receipts em 7 cenários.
4. **`tools/quality/run_ap06_r12_r13_native.py`:**
   - Implementado context manager `execution_lock(wave)` que adquire lock atômico exclusivo em `.execution.lock`. Tentativa de execução paralela é abortada com `R16_CONCURRENT_INVOCATION_REJECTED`.
   - Em `main()`: separada a classificação de incidentes. Se `reservation_already_existed` for verdadeiro, o runner reporta `R16_EXISTING_SCIENTIFIC_STATE` e preserva o consumo (`scientificChromium: UNVERIFIED` ou contagem real), nunca declarando zero. Se o erro for pré-reserva, reporta `R16_ENGINEERING_PRELAUNCH_BLOCKED` com `scientificChromium: 0`.
   - Propagação transparente dos códigos de erro específicos do verificador Node (`R16_AUTHORIZATION_*`).
5. **`tools/quality/ap06_freeze.py`:**
   - Atualizado `validate_test_receipt()`: R16 exige expressamente `tests['global']['status'] == 'PASS'`. Falta do gate `global` ou presença de `DOCUMENTED_EXCEPTION` gera erro `AP06_FREEZE_TEST_AUTHORITY_INVALID`.
6. **`tools/quality/ap06_native.py`:**
   - Preservados os contratos históricos de compatibilidade para garantir que rejeições de prova continuem emitindo `NATIVE_RENDERER_METADATA_MISSING` em conformidade com R13/R14.
7. **`tools/quality/test_ap06_r12_r16.py`:**
   - Expandido de 21 para 25 casos de teste contratuais, cobrindo cenários do produtor real Node, concorrência, contabilidade durável e parser lexical.
8. **Simplificações e Remoções:**
   - Removido fallback permissivo `capability.get('heapProfilingEffective', True)`.
   - Removida permissão genérica do subcomando `--run` na R16.

---

## 4. Testes RED → GREEN e Matriz de Falhas Injetadas

### 4.1 Matriz de Falhas Injetadas

| Vetor de Falha Injetada | Ponto da Injeção | Comportamento Esperado | Resultado |
|---|---|---|---|
| Ausência de arquivo de autorização | Preflight / Prelaunch | Rejeição `R12R16_SCIENTIFIC_AUTHORIZATION_MISSING`, zero reserva, zero browser | **PASS** |
| Assinatura Ed25519 adulterada (1 byte modificado) | Verificador Node | Rejeição `R16_AUTHORIZATION_SIGNATURE_INVALID`, sem reserva | **PASS** |
| Chave pública não constante no trust store | Verificador Node | Rejeição `R16_AUTHORIZATION_KEY_NOT_FOUND` | **PASS** |
| Chave pública RSA fornecida como Ed25519 | Verificador Node | Rejeição `R16_AUTHORIZATION_KEY_TYPE_INVALID` | **PASS** |
| Fingerprint SPKI DER divergente | Verificador Node | Rejeição `R16_AUTHORIZATION_TRUST_ANCHOR_FINGERPRINT_MISMATCH` | **PASS** |
| Trust anchor localizado em `.quality/` ou `baseline/` | Verificador Node | Rejeição `R16_AUTHORIZATION_TRUST_ANCHOR_UNTRUSTED_LOCATION` | **PASS** |
| Trust anchor apontando para link simbólico | Verificador Node | Rejeição `R16_AUTHORIZATION_TRUST_ANCHOR_SYMLINK_REJECTED` | **PASS** |
| Número com zero inicial (`01`) no JSON de autorização | Parser JSON | Rejeição `UNEXPECTED_CHAR: 1` pelo parser estrito | **PASS** |
| Chave duplicada no JSON de autorização | Parser JSON | Rejeição `DUPLICATE_KEY` | **PASS** |
| Surrogate pair isolado (`\uD83D`) no JSON | Parser JSON | Rejeição `UNPAIRED_HIGH_SURROGATE` | **PASS** |
| Injeção de `__proto__` no JSON | Parser JSON | Objeto com protótipo nulo; chave tratada como dado sem poluição | **PASS** |
| Orçamento com valor booleano (`capability: True`) | Verificador / Runner | Rejeição `R12R16_SCIENTIFIC_AUTHORIZATION_INVALID` | **PASS** |
| Commit HEAD divergente do freeze | Prelaunch | Rejeição `R12R16_AUTHORIZATION_FREEZE_HEAD_MISMATCH` | **PASS** |
| Hash de TASK divergente | Prelaunch | Rejeição `R12R16_AUTHORIZATION_TASK_HASH_MISMATCH` | **PASS** |
| Invocação paralela com lock ativo | Runner Python | Rejeição `R16_CONCURRENT_INVOCATION_REJECTED` | **PASS** |
| Campanha com reserva preexistente | Runner Python | Rejeição `R16_EXISTING_SCIENTIFIC_STATE`, consumo `UNVERIFIED` | **PASS** |
| Quarto dump de trace ausente | Consumidor Python | Classificação `R12R16_NATIVE_CAPABILITY_INCONCLUSIVE` | **PASS** |
| Heaps_v2 emitido apenas por outro PID | Consumidor Python | Diagnóstico `OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2` | **PASS** |
| Divergência de FILETIME do processo | Consumidor Python | Rejeição de identidade do processo renderer | **PASS** |
| GUIDs de checkpoint duplicados em formatos equivalentes | Consumidor Python | Rejeição `NATIVE_CHECKPOINT_GUID_DUPLICATE` | **PASS** |
| Truncamento de stream ou checksum divergente | Consumidor Python | STOP durável `NATIVE_TRACE_CHECKSUM_INVALID` | **PASS** |
| Falha no cleanup de backend | Pós-execução | Bloqueio de PASS com `BACKEND_CLEANUP_FAIL` | **PASS** |
| Receipt sem gate `global` no freeze | Freeze R16 | Rejeição `AP06_FREEZE_TEST_AUTHORITY_INVALID` | **PASS** |

### 4.2 Evolução RED → GREEN
- **RED:** Gate global não era validado na R16 em `ap06_freeze.py`, aceitando omissão ou `DOCUMENTED_EXCEPTION`.
  **GREEN:** Atualizado `validate_test_receipt()` para exigir expressamente `tests['global']['status'] == 'PASS'` para R16.
- **RED:** Chave e fingerprint no próprio documento permitiam auto-aprovação com chave arbitrária.
  **GREEN:** Implementada validação externa contra trust store independente e cálculo sobre SPKI DER binário.
- **RED:** Números com zeros à esquerda (`01`) e surrogates isolados eram aceitos pelo parser JSON simplificado.
  **GREEN:** Implementado parser RFC 8259 estrito com checagem léxica integral.
- **RED:** Erros pós-reserva anteriores reportavam falsamente consumo zero em novas tentativas bloqueadas.
  **GREEN:** Separação estrita entre `R16_EXISTING_SCIENTIFIC_STATE` (consumo histórico preservado) e `R16_ENGINEERING_PRELAUNCH_BLOCKED` (consumo 0).

---

## 5. Regressões R13/R14 e Isolamento Entre Campanhas

1. **Preservação de Linhas Históricas:**
   - O repositório preserva integralmente os estados duráveis, freezes e evidências de R12, R13 STOP e R14 freeze.
   - Status exclusivo da R16 (`R12R16_NATIVE_CAPABILITY_PASS`) é explicitamente rejeitado pelas máquinas de estado R13/R14 com `NATIVE_DECISION_STATUS_INVALID`.
2. **Exceções Aprovadas de R13/R14:**
   - As exceções históricas aprovadas para R13/R14 em `validate_test_receipt` foram rigorosamente mantidas. Apenas a R16 exige `global: PASS`.
3. **Isolamento de Variáveis Globais de Módulo:**
   - Os testes de `test_ap06_r12_r16.py` salvam o estado prévio dos módulos `runner` e `prepare_engine` em `setUp()` e restauram 100% dos valores em `tearDown()`.
   - A execução encadeada das suítes de teste em diferentes ordens (R16 → R14 ou R14 → R16) passa com **62/62 OK** sem contaminação mútua.

---

## 6. Benchmarks com Dados Individuais das Oito Repetições

### 6.1 Invalidação Metodológica do Benchmark Anterior
A alegação anterior de que o parser consumia 50.000 eventos em 1,83 ms foi comprovada como resultado de saída prematura por validação de pré-condições ausentes no receipt de mock, retornando em **0,18 ms** antes de consumir qualquer evento. O resultado anterior é formalmente **INVALIDATED / NOT COMPARABLE**.

### 6.2 Resultados Consolidados do Protocolo de 8 Repetições
Executado sob Python 3.12 (Windows x64) com aquecimento prévio descartado, processando traces JSON sintéticos válidos com metadados, 4 checkpoints e allocators `heaps_v2`:

| Configuração | Eventos | Tamanho | Agregação (ms)<br>Mediana ± DesvPadrão | Diagnóstico (ms)<br>Mediana ± DesvPadrão | Tempo Total (ms)<br>Mediana ± DesvPadrão | Pico Memória (tracemalloc) | Status Contratual |
|---|---:|---:|---:|---:|---:|---:|---|
| **Small** | 500 | 101,6 KB | 15,13 ± 4,78 ms | 18,71 ± 8,93 ms | 33,78 ± 13,40 ms | **205,2 KB** | `NATIVE_CAPABILITY_PASS` |
| **Medium** | 5.000 | 1.011,2 KB | 163,09 ± 45,24 ms | 237,19 ± 19,05 ms | 412,50 ± 57,14 ms | **339,4 KB** | `NATIVE_CAPABILITY_PASS` |
| **Large** | 20.000 | 4.053,7 KB | 787,82 ± 116,42 ms | 1.159,97 ± 244,43 ms | 1.925,48 ± 293,32 ms | **339,3 KB** | `NATIVE_CAPABILITY_PASS` |
| **X-Large** | 50.000 | 10.147,4 KB | 1.908,79 ± 119,24 ms | 2.806,86 ± 293,00 ms | 4.793,63 ± 262,61 ms | **339,2 KB** | `NATIVE_CAPABILITY_PASS` |
| **Falha Precoce** | 50.000 | 10.147,4 KB | 0,18 ± 0,05 ms | N/A | 0,18 ± 0,05 ms | 14,2 KB | `NATIVE_STOP` *(reprodução do artefato)* |

### 6.3 Dados Individuais das 8 Repetições

#### Small (500 eventos, 101,6 KB)
| Repetição | Agregação (ms) | Diagnóstico (ms) | Tempo Total (ms) | Pico Memória (KB) |
|---|---:|---:|---:|---:|
| Rep 1 | 27,18 | 43,80 | 70,98 | 205,4 |
| Rep 2 | 19,61 | 20,34 | 39,95 | 205,4 |
| Rep 3 | 14,98 | 22,25 | 37,23 | 205,3 |
| Rep 4 | 13,38 | 19,10 | 32,48 | 205,2 |
| Rep 5 | 14,58 | 18,22 | 32,80 | 205,2 |
| Rep 6 | 12,12 | 17,42 | 29,54 | 205,1 |
| Rep 7 | 15,28 | 17,19 | 32,47 | 205,0 |
| Rep 8 | 16,45 | 18,32 | 34,77 | 205,0 |
| **Mediana** | **15,13** | **18,71** | **33,78** | **205,2** |
| **Desvio Padrão** | ±4,78 | ±8,93 | ±13,40 | N/A |

#### Medium (5.000 eventos, 1.011,2 KB)
| Repetição | Agregação (ms) | Diagnóstico (ms) | Tempo Total (ms) | Pico Memória (KB) |
|---|---:|---:|---:|---:|
| Rep 1 | 130,68 | 209,56 | 340,23 | 339,4 |
| Rep 2 | 189,00 | 232,18 | 421,18 | 339,4 |
| Rep 3 | 160,14 | 243,68 | 403,82 | 339,2 |
| Rep 4 | 155,73 | 239,34 | 395,07 | 339,2 |
| Rep 5 | 132,15 | 235,05 | 367,20 | 339,4 |
| Rep 6 | 264,40 | 264,86 | 529,27 | 339,3 |
| Rep 7 | 166,04 | 268,52 | 434,56 | 339,4 |
| Rep 8 | 216,14 | 230,87 | 447,01 | 339,3 |
| **Mediana** | **163,09** | **237,19** | **412,50** | **339,3** |
| **Desvio Padrão** | ±45,24 | ±19,05 | ±57,14 | N/A |

#### Large (20.000 eventos, 4.053,7 KB)
| Repetição | Agregação (ms) | Diagnóstico (ms) | Tempo Total (ms) | Pico Memória (KB) |
|---|---:|---:|---:|---:|
| Rep 1 | 676,56 | 1.054,15 | 1.730,71 | 339,5 |
| Rep 2 | 781,91 | 1.755,89 | 2.537,80 | 339,1 |
| Rep 3 | 1.030,33 | 1.216,92 | 2.247,25 | 339,3 |
| Rep 4 | 753,37 | 996,08 | 1.749,45 | 339,4 |
| Rep 5 | 800,58 | 1.108,26 | 1.908,83 | 339,2 |
| Rep 6 | 793,74 | 1.100,95 | 1.894,69 | 339,3 |
| Rep 7 | 730,43 | 1.211,69 | 1.942,12 | 339,1 |
| Rep 8 | 944,03 | 1.385,09 | 2.329,12 | 339,3 |
| **Mediana** | **787,82** | **1.159,97** | **1.925,48** | **339,3** |
| **Desvio Padrão** | ±116,42 | ±244,43 | ±293,32 | N/A |

#### X-Large (50.000 eventos, 10.147,4 KB)
| Repetição | Agregação (ms) | Diagnóstico (ms) | Tempo Total (ms) | Pico Memória (KB) |
|---|---:|---:|---:|---:|
| Rep 1 | 2.164,59 | 2.645,31 | 4.809,90 | 339,2 |
| Rep 2 | 1.862,70 | 2.468,42 | 4.331,12 | 339,1 |
| Rep 3 | 1.898,79 | 3.043,64 | 4.942,43 | 339,2 |
| Rep 4 | 1.859,81 | 3.010,62 | 4.870,43 | 339,1 |
| Rep 5 | 1.850,68 | 2.917,05 | 4.767,72 | 339,1 |
| Rep 6 | 2.080,67 | 2.696,67 | 4.777,35 | 339,4 |
| Rep 7 | 2.038,81 | 2.418,11 | 4.456,93 | 339,2 |
| Rep 8 | 1.918,80 | 3.239,69 | 5.158,49 | 339,3 |
| **Mediana** | **1.908,79** | **2.806,86** | **4.793,63** | **339,2** |
| **Desvio Padrão** | ±119,24 | ±293,00 | ±262,61 | N/A |

### 6.4 Conclusão de Eficiência
- **Streaming O(1):** O pico de alocação de memória permaneceu em ~339 KB de 5.000 a 50.000 eventos, demonstrando que o `JsonStream` não faz buffering total do arquivo em RAM.
- **Escalabilidade Linear O(N):** O tempo total de parsing e agregação escala estritamente linear com o número de eventos sem degradação quadrática.

---

## 7. Evidências de CI, SHA e Resultado de Cada Gate

### 7.1 Matriz de Gates da TASK (Seção 10)

| Gate | Requisito da TASK | Status no HEAD Final | Evidência / Validação |
|---|---|---|---|
| **Autorização Ed25519** | Assinaturas válidas aceitas; manipulações rejeitadas | **PASS** | Coberto pelos testes 2, 25 e `verify_scientific_authorization.mjs` |
| **Trust Store** | Confiança independente demonstrada | **PASS** | SPKI DER SHA-256 e fail-closed para caminhos não confiáveis |
| **JSON / Canonicalização** | Vetores válidos e inválidos cobertos | **PASS** | Parser RFC 8259 estrito testado contra vetores malformados |
| **Contabilidade** | Nenhum zero presumido após reserva | **PASS** | `R16_EXISTING_SCIENTIFIC_STATE` com consumo histórico |
| **Crash / Recovery** | Falhas injetadas preservam estado | **PASS** | Erros pré-reserva sem STOP; erros pós-reserva registram STOP durável |
| **Freeze R16** | Gate global PASS obrigatório | **PASS** | `validate_test_receipt` exige `tests['global']['status'] == 'PASS'` |
| **R13 / R14** | Contratos históricos preservados | **PASS** | Isolamento bidirecional verde (62/62 PASS na suíte combinada) |
| **Node → Python** | Integração offline real | **PASS** | `produce_synthetic_native_trace.mjs` testado no teste 22 |
| **Python Global** | Sem falhas introduzidas | **PASS** | 62 testes unitários em 84s sem falhas |
| **Frontend / Backend** | Build, testes e CI pertinentes | **PASS** | 1.530 testes Karma SUCCESS; 5/5 jobs de CI verdes |
| **Segurança** | Gitleaks e verificações | **PASS** | Gitleaks: 0 segredos; `git diff --check`: 0 erros |
| **Desempenho** | Benchmark comparável, 8 repetições | **PASS** | Protocolo de 8 repetições concluído e tabelado |

### 7.2 Resultados no GitHub Actions (Commit `27666091`)

| Workflow | Job | Status | Duração | URL |
|---|---|---|---|---|
| **Backend CI** | Linux Coverage | **PASS** | 6m58s | [Run 39265973350](https://github.com/LViniciusk/SaveBox2/actions/runs/39265973350/job/118105510119) |
| **Backend CI** | Linux GCC | **PASS** | 5m34s | [Run 39265973350](https://github.com/LViniciusk/SaveBox2/actions/runs/39265973350/job/118105510785) |
| **Backend CI** | Windows MSVC | **PASS** | 6m38s | [Run 39265973350](https://github.com/LViniciusk/SaveBox2/actions/runs/39265973350/job/118105509646) |
| **Quality Baseline** | e2e | **PASS** | 2m53s | [Run 39265973405](https://github.com/LViniciusk/SaveBox2/actions/runs/39265973405/job/118105514197) |
| **Quality Baseline** | quality-report | **PASS** | 1m53s | [Run 39265973405](https://github.com/LViniciusk/SaveBox2/actions/runs/39265973405/job/118105513648) |

---

## 8. Diff Exato dos Arquivos de Implementação e Testes

Diff exato de código e testes entre a referência (`54293175`) e o HEAD endurecido (`27666091`), **excluindo o próprio relatório técnico para evitar autorreferência**:

```text
 tools/quality/ap06_freeze.py                      |   4 +-
 tools/quality/ap06_native.py                      |   2 +-
 tools/quality/produce_synthetic_native_trace.mjs  | 185 +++++++++++++++++++
 tools/quality/run_ap06_r12_r13_native.py          | 133 +++++++++++---
 tools/quality/sign_test_authorization.mjs         |  10 +-
 tools/quality/test_ap06_freeze.py                 |  12 +-
 tools/quality/test_ap06_r12_r16.py                | 160 ++++++++++++++++-
 tools/quality/verify_scientific_authorization.mjs | 207 ++++++++++++++++------
 8 files changed, 614 insertions(+), 99 deletions(-)
```

Diff completo do PR #43 em relação à base `frontend`: [https://github.com/LViniciusk/SaveBox2/pull/43/files](https://github.com/LViniciusk/SaveBox2/pull/43/files).

---

## 9. Bloqueios Operacionais Restantes e Instruções Futuras de Provisionamento

A infraestrutura está pronta para medição quando a autorização legítima for concedida. Os seguintes passos devem ser seguidos pelo operador/Diretor Científico:

1. **Provisionamento da Raiz de Confiança:**
   Criar um arquivo de trust store protegido por ACL em local seguro fora do repositório (ex: `C:\ProgramData\SaveBox2\trust-anchor.json`):
   ```json
   {
     "schema": 1,
     "keys": {
       "scientific-director-production": {
         "algorithm": "ed25519",
         "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
         "spkiFingerprint": "<sha256-hex-do-spki-der>"
       }
     }
   }
   ```
2. **Executar Preflight Offline:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --offline-preflight --source-output .quality/readiness-wave12-r12-factorial
   ```
3. **Congelar o HEAD:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --freeze
   ```
4. **Assinar e Gravar a Autorização:**
   Gerar o payload vinculado ao commit congelado e assiná-lo com a chave privada offline do Diretor Científico.
5. **Disparar a Captura Única de Capability:**
   ```powershell
   py -3.12 tools/quality/run_ap06_r12_r16_native.py --run-capability --source-output .quality/readiness-wave12-r12-factorial --authorization <caminho-da-autorizacao> --trust-anchor <caminho-do-trust-store>
   ```

---

## 10. Confirmação de Zero Execuções Científicas e Nenhuma Alteração Histórica

- **Zero Execução Científica:** Nenhum binário do Chromium foi instanciado para coleta ou profiling científico nesta rodada. Nenhum teste A/B foi executado. Todos os ensaios utilizaram geradores de eventos sintéticos, mocks contratuais ou instâncias offline de teste.
- **Preservação Histórica:** As decisões, autoridades e evidências de R12, R13 STOP e R14 freeze não foram alteradas nem reescritas.
