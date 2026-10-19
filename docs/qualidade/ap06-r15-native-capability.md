# AP-06 R15 — recuperação da capability de profiling nativo

**Classificação de engenharia:** `ENGINEERING_READY_FOR_CONTROLLED_CAPABILITY` — prontidão documental para revisão humana; não é PASS científico.

**Escopo:** correção offline do receipt e diagnóstico da captura. Nenhum A/B, benchmark ou capture nativo de capability foi executado.

## Diagnóstico

O pós-mortem R14 já registrado descreve quatro requests explícitos, três dumps correlacionados do renderer, 11.008 registros de allocator stats e zero estruturas `heaps_v2`. Também registra ausência de `rendererIdentityProof` e `creationTimeExact` no receipt histórico. Esses fatos não foram reclassificados.

A nova instalação local resolve para Playwright `1.62.1`, `chromium-headless-shell`, Chromium `151.0.7922.34`, x64, revisão `1234`. A identidade e o launch protocol foram resolvidos sem iniciar o browser. A versão veio do registro instalado; `productVersion` do PE não está disponível. A resolução identifica qual binário seria usado, mas não demonstra que seu serviço de profiling funcione.

| Hipótese | Estado | Evidência e limite |
|---|---|---|
| A — flags e inicialização | **Parcialmente confirmada; ativação não verificável** | O contrato fixa quatro flags e o auditor Win32 compara os argumentos observados do processo browser. Isso prova os argumentos atestados, não a inicialização do serviço nem o profiling do renderer. O Chromium documenta que `--memlog-in-process` apenas move o serviço para o processo browser; por padrão ele roda em processo dedicado. Nenhuma flag nova foi acrescentada. |
| B — CDP/MemoryInfra | **Configuração de request confirmada; causa de `heaps_v2` ausente não verificável** | O tracing começa antes do workload com backend `chrome` e categoria MemoryInfra. O CDP `Tracing.requestMemoryDump` solicita um dump global explicitamente; a resposta `success` não comprova que o renderer emitiu `heaps_v2`. `memoryDumpConfig.triggers: []` deixa sem triggers automáticos e não remove as chamadas explícitas. |
| C — executável | **Compatibilidade funcional não verificável** | O executável e protocolo Playwright estão fixados e identificados, e o pós-mortem registra a mesma versão Chromium na R14. A documentação upstream descreve heap profiling em Windows, mas não atesta especificamente esse `headless-shell`. Não há evidência suficiente para declarar incompatibilidade nem trocar o binário. |
| D — controle de workload | **Alocação nativa confirmada; controle positivo do profiler não verificável** | O `Uint8Array` de 8 MiB tem backing store nativo: a implementação Chromium de `gin::ArrayBufferAllocator` aloca por PartitionAlloc. Isso não prova que este build inclua o processo no profiler nem que registre a alocação em `heaps_v2`. Nenhum workload alternativo foi executado. |

Fontes upstream: [heap profiling com MemoryInfra](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/memory-infra/heap_profiler.md), [debugging de memória e flags `memlog`](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/memory/debugging_memory_issues.md), [handler CDP de `Tracing.requestMemoryDump`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/tracing_handler.cc), [protocolo CDP](https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/inspector/browser_protocol.pdl) e [alocador de backing store de `ArrayBuffer`](https://chromium.googlesource.com/chromium/chromium/+/refs/heads/trunk/gin/array_buffer.cc).

## Matriz de compatibilidade observada

| Camada | Estado atual | Conclusão |
|---|---|---|
| Playwright e identidade | `1.62.1`, `chromium-headless-shell`, `151.0.7922.34`, x64; executável e arquivos da instalação entram no manifesto por hash | Identidade verificável; capacidade nativa não inferida da versão ou do hash. |
| Flags | Lista canônica atestada no processo browser; `--memlog=all`, stack nativa, amostragem `16384` e pequenas alocações preservados | Args observados não equivalem a profiler ativo. |
| MemoryInfra/CDP | Categoria consultada, tracing iniciado antes do workload e requests explícitos detalhados | Solicitar e receber uma resposta CDP não substitui evidência `heaps_v2` por GUID/PID. |
| Dump nativo | Histórico R14 sem `heaps_v2`; artifacts privados não disponíveis para replay nesta tarefa | Causa raiz entre serviço, build e coleta do renderer segue desconhecida. |
| Alternativa | Nenhum binário alternativo fixado ou testado | Se necessário, escolher build desktop com suporte documentado e criar nova identidade, versão, hash, protocolo de launch e freeze. Sem fallback silencioso. |

## Implementação e contratos

Arquivos alterados:

- `frontend/tools/ap06-native-trace.mjs`: registra tentativas de request, impede repetir um checkpoint depois de request sem receipt válido e só marca `complete` se houver exatamente as quatro fases ordenadas, quatro receipts de sucesso, GUIDs válidos e únicos, JSON sem perda e stream com EOF.
- `frontend/tools/ap06-native-trace.test.mjs`: mocks CDP verificam ordem/payloads, falha de categoria, cleanup da sessão, os quatro checkpoints e falha intermediária sem retry ou receipt completo.
- `frontend/tools/ap06-native-integration.test.mjs`: cobre trace válido, ausência de `heaps_v2`, terceiro dump ausente e schema `heaps_v2` incompatível pelo caminho Node → stream → parser Python → classificação.
- `tools/quality/run_ap06_r12_r13_native.py`: reutiliza `inspect_trace()` numa segunda leitura incremental depois da aceitação; publica contagens sanitizadas de categoria, flags atestadas, requests, correlação renderer, prova de identidade e estado de `heaps_v2`. O CLI inclui esse diagnóstico. Trace inválido ou diagnóstico impossível vira `UNVERIFIED`.

| Contrato | Antes | Depois |
|---|---|---|
| `trace.complete` | Tracing iniciado, JSON, sem data loss e EOF | Mantém essas condições e exige quatro checkpoints completos, ordenados, bem-sucedidos, com GUID válido/único e sem retry após request incompleto. |
| Request CDP vs. dump emitido | Receipt de request e validação científica em etapas distintas | Continua distinto; `requestAttempts` e receipts são comparados ao inventário real dos dumps renderer. |
| Diagnóstico | `inspect_trace()` era usado em replay/preparação, não no resultado de `validate_trace()` | Contagens sanitizadas adicionadas ao resultado; leitura é incremental e não altera a decisão de aceitação. |
| Aceitação | Gates de `GlobalMemoryDump`, PID, GUID, FILETIME, quatro fases e `heaps_v2` | Inalterados. `inspect_trace()` não pode produzir PASS; somente `aggregate_trace()` pode classificar `NATIVE_CAPABILITY_PASS`. |
| Memória e publicação | Streaming limitado, SHA-256, arquivo temporário e publicação atômica | Preservados; nenhum trace inteiro é carregado em memória. |

Não houve refatoração ampla: os helpers existentes cobriam as demais validações, e nenhuma remoção adicional tinha evidência de estar sem consumidores.

## Validação

| Verificação | Resultado |
|---|---|
| RED antes da correção | O teste de falha no segundo checkpoint observou `complete: true`; o teste Node → Python não recebeu `diagnostic`. |
| Node AP-06 identidade/trace/integração | 24 testes passaram; produtor e parser exercitados com fixtures válidas e inválidas. |
| Node global compatível | 300 testes: 299 passaram, 1 skip; excluídos dois arquivos de suíte que podem iniciar shell. |
| Python AP-06 parser/identidade/R13/R14/freeze | 84 testes passaram. |
| Python global | 626 testes: 4 erros de ordem nos módulos antigos R12-R2/R3 e 4 skips. Os mesmos quatro testes passaram quando executados isoladamente; os arquivos afetados não fazem parte deste diff. |
| TypeScript / Angular | `tsc --noEmit` passou; build passou com avisos de budget já existentes. |
| Documentação / sintaxe / diff | 7 checks documentais passaram; `py_compile` e `git diff --check` passaram. |
| Gitleaks | Zero achados nos cinco arquivos alterados. |
| C++ local | Não executado: o diff só altera JavaScript/Python e não muda backend C++; Backend CI cobre essa verificação. |

O teste de identidade R12-R7 mencionado abaixo foi executado separadamente e abriu um processo `headless-shell` com CDP simulado. Não houve coleta de trace. As suítes Angular/browser não foram iniciadas localmente; Frontend CI é executado no HEAD final. `npm ci` reportou 30 advisories de dependências (7 moderados, 20 altos, 3 críticos); nenhuma dependência ou lockfile foi alterado ou triado nesta tarefa.

## Integridade histórica e limites

Os arquivos privados correspondentes ao freeze R14 (`0297ac698a7583b2d6f6d031e7438ee24af97948`), trace (`aefcdf7073eb9137b3c53959af4c93668a03ac19c3903d2901a9bbbde8f66086`), decisão (`d078c297e752f6e39757dc3bb9c59cd7eb0d9d35acbade3fbf3e3b38c069aa81`) e STOP R13 (`97081f17bc48ba55914f61d4a8ce98b7040a58dad1421caae11f0b524ffd04d5`) não estavam disponíveis no workspace. Seus hashes não foram recriados nem os arquivos históricos modificados. O relatório pós-mortem versionado permanece intacto.

Uma execução de suíte incluiu um teste existente de identidade R12-R7 que abriu um `chromium-headless-shell` descartável com CDP simulado. Esse teste não coletou trace, não executou workload de profiling e não realizou medição AP-06. Nenhuma capability R15 ou A/B foi executada.

Uma futura capability exige autorização e freeze próprios, orçamento sem retries, identidade e hash do executável escolhido, atestação de flags/processos, cleanup PASS, trace íntegro e quatro dumps do renderer ligados a GUIDs e janelas `GlobalMemoryDump`, cada um com `heaps_v2` v1 estruturalmente válido e dados utilizáveis. Somente depois desse PASS científico pode ser considerada uma decisão separada sobre A/B. Os workflows CI e seus resultados para o HEAD final serão referenciados na descrição do PR.
