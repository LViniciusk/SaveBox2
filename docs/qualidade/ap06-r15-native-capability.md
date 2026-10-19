# AP-06 R15 — native capability engineering recovery

**Classificação:** ENGINEERING_READY_FOR_CONTROLLED_CAPABILITY — engenharia revisada para futura revisão humana; não é aprovação científica nem PASS de profiling.

**Branch/PR:** investigation/ap06-r15-native-capability-recovery / [PR #42](https://github.com/LViniciusk/SaveBox2/pull/42), base frontend.

## Escopo e limites

Esta rodada corrige identidade/correlação de traces, restringe os diagnósticos de heaps_v2 ao processo renderer esperado, isola estado de testes e registra a triagem de desempenho e dependências.

Nenhuma capability R15, campanha, medição XHR/Fetch, comparação A/B ou profiling científico foi executado. Os traces de desempenho abaixo são JSON sintéticos, escritos e lidos incrementalmente; não representam Chrome ou hardware. Os testes Node usam CDP simulado. A suíte Python global inclui o teste existente de identidade R12-R7, que pode iniciar um headless-shell descartável com CDP simulado; ele não coleta trace nem executa workload de profiling.

## Correções e findings

| Finding | Correção |
|---|---|
| A comparação de GUIDs no Node só ignorava caixa; 0x01 e 1 podiam ser tratados como IDs distintos. | Uma chave canônica remove prefixo 0x, zeros iniciais e diferenças de caixa, igualando o comportamento inteiro do Python. Captura e gate final do receipt rejeitam duplicatas e GUIDs inválidos. |
| Três requests/dumps podiam ser apresentados como correlação completa. Contagens agregadas não provavam request válido nem vínculo temporal. | COMPLETE exige quatro fases ordenadas, receipts válidos e GUIDs únicos, quatro requests GlobalMemoryDump de sucesso e dumps do renderer dentro da janela de cada request. correlatedRendererDumps agora conta correlações efetivas; rendererDumpGuidMatches preserva a contagem bruta para diagnóstico. PARTIAL, MISSING e UNVERIFIED continuam distintos. |
| Qualquer heaps_v2 de browser/GPU/utility podia sugerir profiling do renderer. | A evidência agora distingue estrutura v1 válida no renderer esperado, somente em outros processos, sem estruturas válidas e processo indeterminado. PID precisa ser inteiro exato; true não pode corresponder a PID 1. Essa leitura é diagnóstica e não altera a aceitação. |
| A inspeção mantinha cardinalidade crescente por PID e chaves arbitrárias de dump_type. | PID distinto é limitado a 1.024 com indicador de truncamento; os mapas de contagem por PID foram removidos; tipos desconhecidos entram no bucket other. Só quatro checkpoints são inspecionados. |
| Os testes R12-R2/R3 dependiam de globais da campanha, alteradas por testes R12-R14. | Cada classe configura seu estado esperado em setUp e restaura OUTPUT, PUBLISHER e CAMPAIGN em tearDown. A reprodução anterior falhava com os mesmos quatro erros na base frontend e no HEAD antigo; a sequência R12-R14 → R2 → R3 passou após o isolamento. Produção não foi alterada por essa correção. |

O diagnóstico de correlação verifica o marcador de início/fim, o GUID local e o dump_guid, categoria MemoryInfra, dump_type, sucesso, detalhe, PID da janela e timestamp do dump renderer. GUIDs ou receipts inválidos continuam fail-closed. Os caminhos de aceitação científica em aggregate_trace permanecem a autoridade; inspect_trace nunca cria PASS.

## Auditorias

### 1. Correção e segurança

- Conferidos todos os chamadores alterados, os testes Node/Python, o consumidor do diagnóstico e o runner R12-R13.
- Confirmado que só o parser estrito agrega/aceita dados; requests aceitos não são confundidos com dumps emitidos.
- Revistos sessão CDP, timeout, bloqueio de retry, EOF, limite de bytes, hash incremental, arquivo temporário e publicação por hard link sem sobrescrita. Falhas de leitura/fechamento removem publicação parcial e encerram a sessão.
- Revistos identidade do executável, PID/FILETIME, handles retidos, ACL, caminhos relativos, rejeição de reparse point e publicação imutável. Nenhum bypass foi encontrado nem alterado nesta rodada.
- A auditoria encontrou uma ambiguidade diagnóstica: uma estrutura inválida sem PID podia receber PROCESS_UNDETERMINED. A classificação foi corrigida para usar esse rótulo só quando há estrutura v1 válida de processo desconhecido, com regressão específica.
- O inventário aceita apenas formato v1 com arrays e números em limites. Ele é evidência de forma/estrutura, não prova de lifetimes, leaks ou retenção de alocação individual.
- Nenhum freeze, trace, decisão ou STOP histórico foi regravado.

### 2. Desempenho e manutenção

A leitura incremental extra de inspect_trace foi mantida: ela mantém a aceitação isolada e o custo observado foi limitado. O teste escreveu uma fixture sintética por linha, sem guardar o trace completo na memória. Python 3.12.0, cinco execuções por caso, mediana de tempo e maior pico Python medido por tracemalloc:

| Trace sintético | aggregate_trace | inspect_trace (custo da leitura diagnóstica) |
|---:|---:|---:|
| 101.740 bytes | 4,31 ms; 269,3 KiB | 3,16 ms; 269,5 KiB |
| 2.096.460 bytes | 57,50 ms; 271,2 KiB | 93,74 ms; 272,0 KiB |
| 8.388.459 bytes | 256,67 ms; 271,0 KiB | 191,09 ms; 271,8 KiB |

O pico permaneceu próximo de 272 KiB nos três tamanhos, além dos buffers e do estado agregado já existentes. A segunda leitura aumenta tempo de I/O/parsing linearmente, mas não a memória proporcional ao trace. Não foi feita otimização especulativa nem benchmark científico.

## Testes e recuperação

| Verificação | Resultado |
|---|---|
| RED → GREEN dos findings | Antes da correção, a regressão de alias numérico não rejeitava duplicata; diagnóstico aceitava 3 correlações como completas e usava qualquer processo para heaps_v2. Após as correções, os testes correspondentes passaram. |
| Node trace + integração sintética Node → parser Python | 10 passaram, 0 falharam. Inclui alias/GUID inválido, falha no segundo/terceiro/quarto request, timeout sem sleep, retry proibido, stream inválida, cleanup e classificações com 4/3/0 correlações. |
| Parser/diagnósticos AP-06 (test_ap06_native) | 17 passaram. |
| Regressão de ordem R12-R14 → R2 → R3 | 50 passaram, incluindo os 41 testes R12-R14 e os testes R2/R3 afetados. |
| Suíte Python global | 629 testes executados, 4 skips, resultado OK. Discovery foi executado da raiz do worktree. |
| Invocação de discovery recuperada | A primeira chamada foi iniciada dentro de tools/quality e falhou ao importar tools; a execução da suíte passou ao iniciar da raiz SaveBox2-ap06-r15-native-capability. |
| Sintaxe e diff | py_compile e git diff --check passaram. |
| Gitleaks | Passou no intervalo de 4 commits do PR; nenhum segredo detectado. |
| Frontend CI | Linux e Windows passaram, incluindo testes unitários e builds de produção. |
| Quality Baseline | quality-report e e2e passaram. |
| Backend CI | Linux GCC, Linux Coverage e Windows MSVC passaram. |

## Segurança de dependências

Leitura somente de npm audit e árvore instalada em 2026-10-18: 30 findings/grupos (7 moderados, 20 altos, 3 críticos); npm audit --omit=dev encontrou um finding alto e nenhum crítico/moderado. Não houve edição de package.json ou lockfile.

| Pacote instalado | Superfície e triagem |
|---|---|
| @angular/router@20.3.31 (runtime, direto) | GHSA-ff3f-86qr-9cv3, DoS quando SSR Node está habilitado; corrigido em 20.3.32. Este frontend não tem @angular/ssr e é SPA client-side; o advisory informa que SPAs sem SSR não são afetadas. Ainda é recomendável atualizar a família Angular em patch coordenado. |
| piscina@5.2.0 via @angular/build@20.3.32 (dev) | GHSA-67c8-pqhq-4rmx, RCE via gadget se Object.prototype já estiver poluído; correção 5.3.2. Não está no grafo de runtime. |
| proxy-addr@2.0.7 via Express → MCP SDK → @angular/cli@20.3.32 (dev) | GHSA-jqcg-44mw-7w3h permite spoofing de IP se trust subnet IPv4-mapped IPv6 for configurada com prefixo curto; correção 2.0.8. A cadeia está em tooling de desenvolvimento, não no frontend publicado. |
| undici@6.27.0, fast-uri@3.1.3, ip-address@10.2.0, postcss@8.5.16, tar@7.5.19 | Achados transitivos de ferramentas CLI/build. Ex.: GHSA-8xcm-r25x-g524 afeta o retry interceptor do undici ao combinar upstream parcial malformado com encaminhamento sem recalcular Content-Length; GHSA-v2hh-gcrm-f6hx afeta comparação de host no fast-uri. Uso alcançável depende da API e do input de cada ferramenta; os pacotes não são runtime direto do frontend. |
| Outras entradas de tooling (@angular/cli, @modelcontextprotocol/sdk, brace-expansion, postcss e transitivos listados pelo audit) | Permanecem registradas pelo audit e requerem atualização validada. A presença como devDependency reduz exposição em produção, mas não elimina risco durante instalação/build/servidor de desenvolvimento. |

Recomendação: PR separado com atualização focada de dependências transitivas e Angular, lockfile revisado, npm audit repetido e build/testes completos. Não se declara segurança global com base nesta triagem, Gitleaks ou CI.

Fontes dos advisories: [Angular router SSR DoS](https://github.com/advisories/GHSA-ff3f-86qr-9cv3), [Piscina prototype-pollution gadget](https://github.com/advisories/GHSA-67c8-pqhq-4rmx), [proxy-addr trust-subnet spoofing](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), [undici retry interceptor](https://github.com/advisories/GHSA-8xcm-r25x-g524), [fast-uri host confusion](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx).

## Integridade histórica, ciência e pendências

Freeze R14 0297ac698a7583b2d6f6d031e7438ee24af97948, trace SHA-256 aefcdf7073eb9137b3c53959af4c93668a03ac19c3903d2901a9bbbde8f66086, decisão SHA-256 d078c297e752f6e39757dc3bb9c59cd7eb0d9d35acbade3fbf3e3b38c069aa81 e STOP R13 SHA-256 97081f17bc48ba55914f61d4a8ce98b7040a58dad1421caae11f0b524ffd04d5 permanecem imutáveis. AP06_AUTHORITY_ROOT não está configurado e os arquivos privados não estavam disponíveis neste workspace; não foram recriados nem publicados. Nenhum resultado de STOP histórico foi reclassificado.

**Zero novas execuções científicas.** Permanece pendente a validação real da capability, que exige autorização e seus próprios freeze, identidade, budget, cleanup e evidência de quatro dumps do renderer com heaps_v2 válido. Também permanece pendente a atualização direcionada das dependências.

## CI no HEAD de entrega

| Workflow | Resultado | Run | SHA |
|---|---|---|---|
| Backend CI — Linux GCC, Linux Coverage, Windows MSVC | Sucesso | [39191490193](https://github.com/LViniciusk/SaveBox2/actions/runs/39191490193) | `34ecc1d9a9330043ff288a18f05e0cb07555a8cf` |
| Frontend CI — Linux, Windows | Sucesso | [39191493670](https://github.com/LViniciusk/SaveBox2/actions/runs/39191493670) | `34ecc1d9a9330043ff288a18f05e0cb07555a8cf` |
| Quality Baseline — quality-report, e2e | Sucesso | [39191490076](https://github.com/LViniciusk/SaveBox2/actions/runs/39191490076) | `34ecc1d9a9330043ff288a18f05e0cb07555a8cf` |

Os três workflows passaram no HEAD de implementação acima. Este relatório registra esses resultados; após este commit documental, os workflows serão executados novamente no HEAD final e os resultados serão registrados na descrição do PR. Nenhum merge foi executado; o PR permanece direcionado a frontend.
