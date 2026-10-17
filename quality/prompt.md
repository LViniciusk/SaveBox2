# TASK — AP-06 R12-R6: Scientific Authority Recovery, Corpus Provenance and Factorial Execution

## Contexto

**Repositório:** `LViniciusk/SaveBox2`<br>
**Branch nova:** `investigation/ap06-r12-r6`<br>
**Base:** `investigation/ap06-r12-r5` — PR #32<br>
**HEAD de referência:** `25dec809d212dbda1ff93433182e1ed9f332875e`<br>
**Entrega:** PR Draft empilhado sobre #32, sem merge.

A R12-R5 implementou a auditoria de processos Chromium com handles Win32 retidos e corrigiu a retomada do backend experimental. A integração local passou, mas a campanha científica não foi iniciada por ausência de `quality/prompt.md` e da autoridade R12-R5.

Estado confirmado:

- `R12R5_STOP`, AP-06 `OPEN`.
- Zero Chromium científico e zero retries.
- Nenhum freeze, triage, formal ou profiling nativo R12-R5.
- O HEAD atual possui Backend CI e Quality Baseline verdes.
- O PR #32 está incorretamente direcionado a `frontend`, embora a implementação tenha sido construída sobre a R12-R4.
- O corpus regenerado não possui identidade comprovada com os MP4 originais da R6.

**Objetivo da R12-R6:** concluir o experimento fatorial sob uma autoridade nova, verificável e pré-registrada, confirmando ou refutando o efeito do Fetch nos chunks grandes. Executar profiling nativo apenas se a confirmação formal autorizar.

Priorizar reutilização de código, segurança, testes e integridade científica. Não implementar otimizações de produção.

---

## 1. Regularizar a linhagem e materializar a autoridade R12-R6

### PRs e branch

Verificar a ancestralidade Git e o estado do PR #32.

Se não houver impedimento explícito de política do repositório, alterar a base do PR #32 para `investigation/ap06-r12-r4`, sem squash, merge ou rebase destrutivo. Conferir o diff resultante e preservar o histórico dos PRs anteriores.

Criar `investigation/ap06-r12-r6` sobre o HEAD final da R12-R5, nunca diretamente sobre `frontend`.

Não incluir novamente toda a linhagem AP-06 como alterações próprias da R12-R6.

Corrigir as informações de CI da R12-R5 mediante errata, sem substituir seu STOP histórico:

- No HEAD de implementação `9fc6725`, Backend CI e E2E passaram; `quality-report` falhou.
- No HEAD `25dec809`, Backend CI e Quality Baseline passaram integralmente.

Registrar os workflows e os SHAs corretos. Não afirmar que um workflow passou em um commit diferente daquele realmente executado.

### Autoridade científica — bloqueador principal

Criar explicitamente `quality/prompt.md` como **protocolo autorizado da R12-R6**, utilizando esta TASK recebida do usuário.

Não procurar nem inventar o prompt original da R12-R5. O STOP anterior permanece válido.

O documento R12-R6 deve conter, antes de qualquer execução:

- Identidade da campanha e HEAD de implementação.
- Hipóteses e quatro condições.
- Manifesto e critérios de aceitação do corpus.
- Métricas, thresholds e classificador.
- Ordem formal e orçamento.
- Contratos HTTP, segurança e cleanup.
- Condições de STOP e publicação.
- Dependências e regras do profiling nativo.

Gerar também a cópia privada `baseline/task.md` e um recibo de proveniência contendo SHA-256, tamanho e origem da autorização.

Não declarar identidade byte a byte com a mensagem original se isso não puder ser comprovado; a transcrição deve ser fiel e suas limitações explícitas.

Exemplo de gate:

```python
from pathlib import Path
import hashlib

task = Path("quality/prompt.md")
assert task.is_file(), "R12R6_TASK_AUTHORITY_MISSING"

content = task.read_bytes()
assert content and b"AP-06 R12-R6" in content

task_sha256 = hashlib.sha256(content).hexdigest()
```

Complementar com validação semântica dos campos obrigatórios, não somente existência do arquivo.

Depois de aprovado, o protocolo é imutável. Congelar seu hash junto à implementação.

**Nunca gerar ou ajustar o protocolo com base nos resultados da medição.**

---

## 2. Validar o corpus antes da campanha

Revisar as autoridades protegidas R12/R12-R2, os manifests atuais e as fixtures regeneradas.

Arquivos relevantes:

- `tools/quality/run_ap06_r9.py`
- `tools/quality/run_ap06_r12.py`
- `tools/quality/run_ap06_r12_r2.py`
- `tools/quality/ap06_key_custody.py`
- `frontend/tools/ap06-r9-fixtures.mjs`
- Manifests e publicações privadas AP-06.

### Identidade e equivalência

Verificar para cada uma das três fixtures:

- SHA-256 do plaintext, quando disponível.
- SHA-256, tamanho e integridade do ciphertext.
- Formato KAS2, metadata e nonce.
- Codec, duração e características de mídia relevantes.
- Quantidade e tamanho dos chunks.
- Sequência exata de Ranges.
- Autoridade DPAPI e readback criptográfico.

Preferir recuperar e verificar o corpus efetivamente usado na R12/R12-R2, se ainda disponível, em vez de confundir essa referência com os arquivos originais perdidos da R6.

Se a identidade completa com a referência anterior não puder ser comprovada, **estabelecer uma nova baseline de corpus R12-R6**.

Isso não invalida automaticamente o fatorial: os quatro braços continuam comparáveis internamente desde que utilizem os mesmos arquivos e workload congelados.

Entretanto:

- Não afirmar reprodução byte a byte da R12.
- Não combinar estatisticamente raws anteriores e novos.
- Não comparar deltas absolutos como equivalentes sem prova.
- Não alterar thresholds para compensar diferenças observadas.

Se não for possível reproduzir os contratos de Range, conteúdo e fluxo, STOP antes do primeiro Chromium.

### Workload obrigatório

Preservar:

- Três fixtures ABC.
- Seis ciclos e 18 sessões.
- Nove Ranges por ciclo.
- **25.559.136 bytes criptografados por ciclo**.
- Metadata: 393.216 bytes/ciclo.
- Payload: 25.165.920 bytes/ciclo.
- HTTP 206, JWT, Content-Range e Content-Length.
- Nenhum Worker, MSE, SourceBuffer, media element ou playback.
- Payload Blob sem `blob.arrayBuffer()` explícito.

Congelar hashes, contadores e sequência antes de observar memória.

---

## 3. Auditar uma possível inconsistência no bypass experimental

Há um ponto que exige teste negativo específico.

Em `backend/include/middlewares/RateLimitMiddleware.hpp`:

```cpp
#ifdef NANIKA_AP06_LOCAL_TEST_SERVER
if (verified_isolated_test_runtime_ &&
    ClientIp::is_actual_loopback_peer(req))
    return;
#endif
```

O helper `is_actual_loopback_peer()` em `ClientIp.hpp` aceita qualquer endereço loopback, incluindo `127.0.0.2` e `127.0.0.3`.

Esses são justamente os peers usados em `verify_spoof_guard()`.

A R12-R5 reportou a sequência 401/429/403, mas a combinação acima requer uma verificação causal: **o guard não pode passar porque outro mecanismo produziu os mesmos status enquanto o RateLimitMiddleware esperado estava sendo contornado**.

### Correção condicionada à evidência

Primeiro, executar teste de integração que associe os requests ao middleware e comprove a contagem e persistência do ban para o peer real.

Se o bypass alcançar as tentativas de spoofing, restringi-lo exclusivamente às requisições laboratoriais que realmente precisam dele — por exemplo, origem exata `127.0.0.1` em um runtime comprovadamente isolado — sem incluir `127.0.0.2`, `127.0.0.3` ou headers falsificados.

Não transformar essa sugestão em mudança cega: demonstrar previamente o caminho executado e testar a correção.

Exigir:

- `127.0.0.2` e `127.0.0.3` passam pelo rate limiter.
- Sequência 401/429/403 produzida pelo mecanismo correto.
- Ban persistido no banco isolado e conferido somente por leitura.
- Header `X-Real-IP`/`X-Forwarded-For` incapaz de substituir o peer real.
- Sem relaxamento dos thresholds.
- Endpoint `/__ap06/actual-peer` disponível somente no target experimental.
- `savebox_server` de produção sem bypass e sem endpoint experimental.
- Negação de acesso externo e preservação do bind `127.0.0.1`.

Ampliar os testes de `test_b98_rate_limit_ban_cache.cpp` e os testes Python do guard, sem duplicar a lógica do middleware.

Se houver discrepância não explicada entre código e resultado HTTP, bloquear o experimento.

---

## 4. Reutilizar a infraestrutura R12-R5 sem novos componentes desnecessários

Reutilizar:

- `tools/quality/ap06_browser_identity.py`
- `frontend/tools/ap06-browser-identity.mjs`
- `frontend/tools/ap06-process-sample.mjs`
- `tools/quality/ap06_local_backend.py`
- `tools/quality/run_ap06_r12_r2.py`
- `tools/quality/run_ap06_r12_r2_native.py`
- `frontend/tools/ap06-r12-r2-probe.mjs`
- `frontend/tools/ap06-native-trace.mjs`

Criar somente os wrappers:

- `tools/quality/run_ap06_r12_r6.py`
- `tools/quality/run_ap06_r12_r6_native.py`

Usar:

- `.quality/readiness-wave12-r6-factorial`
- `.quality/readiness-wave12-r6-native`

Prefixos de publicação R12-R6 exclusivos.

Estender a allowlist de `configure_campaign()`, os gates de identidade e o namespace do publisher sem copiar integralmente runners anteriores.

Caso a proliferação de verificações `CAMPAIGN == ...` esteja causando duplicação, substituí-las por uma pequena configuração explícita de campanha, preservando os comportamentos legados.

Não criar framework genérico ou abstração extensa para resolver dois novos namespaces.

### Attestation e cleanup

Validar offline o contrato existente:

- Binário headless shell real e SHA-256 congelado.
- PID e instante de criação.
- Argumentos OS e Playwright.
- Handles de processos registrados antes das medições.
- Auditoria final com prazo total de 10 segundos.
- Handle release integral.
- Ausência de processo externo encerrado.
- Recibos rejeitados se incompletos ou adulterados.

O `close-audit` só aprova processos originais efetivamente encerrados. PID reutilizado deve ser distinguido por criação/handle.

Não permitir que uma auditoria global posterior transforme um cleanup científico FAIL em PASS.

---

## 5. Gates obrigatórios antes do Chromium

Executar testes RED→GREEN e integração sintética para:

**Autoridade e corpus**

- `quality/prompt.md` ausente, vazio, adulterado ou sem campos obrigatórios.
- Hash do protocolo divergente.
- Corpus diferente da baseline declarada.
- Fixture ausente, Range inesperado ou total de bytes divergente.
- Referência histórica não verificável corretamente classificada como nova baseline.
- Alteração de código ou corpus após freeze rejeitada.

**Identidade e backend**

- Processo original encerrado ou encerramento tardio.
- PID reutilizado.
- Timeout, falha WinAPI e handle não liberado.
- Falha do helper após browser launch.
- Erro funcional preservado separadamente de erro de cleanup.
- Spoof guard no runtime novo e retomado.
- Confirmação do rate limiter real para peers `127.0.0.2`/`127.0.0.3`.
- Cleanup de contas e readback.
- Rejeição de macro experimental no target de produção.

**Contrato científico**

- Quatro braços e routing metadata/payload.
- Auth/Store XHR.
- HTTP 206/JWT/Ranges/headers/bytes.
- Counters e checkpoints.
- Classificador, ordem formal e thresholds.
- Orçamento global e zero retries.
- Ausência de Worker/MSE/playback.
- Captura nativa inválida, incompleta ou indisponível.

Executar testes Python, Node, C++ relevantes, Angular/TypeScript, análise de segurança, scanner de segredos e `git diff --check`.

Exigir **Backend CI e Quality Baseline verdes no HEAD exato de implementação da R12-R6**.

Os sucessos do HEAD R12-R5 não substituem o CI da nova implementação.

Não consumir Chromium científico se qualquer gate falhar.

---

## 6. Executar o fatorial original, sem redesenho

Condições:

| Condição | Metadata | Payload |
|---|---|---|
| r12r2.0 | XHR | XHR |
| r12r2.1 | Fetch | XHR |
| r12r2.2 | XHR | Fetch |
| r12r2.3 | Fetch | Fetch |

### Orçamento R12-R6

**Máximo: 14 Chromium. Zero retries.**

| Etapa | Máximo |
|---|---:|
| Preflight único | 1 |
| Triagem fatorial | 4 |
| Formal opcional | 6 |
| Capacidade nativa opcional | 1 |
| Profiling nativo opcional | 2 |

Cada lançamento consome orçamento mesmo se ocorrer STOP após `chromium.launch()`.

### Execução

Primeiro, executar o preflight único, atestando navegador, transportes, backend, worktree, processo e cleanup.

Somente após preflight PASS, gerar o freeze definitivo de implementação, protocolo, corpus, assets, executáveis, recibos e autoridades.

Executar quatro Chromium independentes de triagem.

Métrica primária: delta de memória privada do renderer entre baseline e fechamento do ciclo 6.

Métrica secundária: memória privada total dos processos Chromium.

**Controle obrigatório:** Fetch/Fetch ≥300 MiB.

Selecionar o primeiro contraste elegível com diferença absoluta ≥150 MiB, nesta ordem:

1. r12r2.0 × r12r2.2 — efeito do payload com metadata XHR.
2. r12r2.1 × r12r2.3 — efeito do payload com metadata Fetch.
3. r12r2.0 × r12r2.1 — efeito da metadata com payload XHR.
4. r12r2.2 × r12r2.3 — efeito da metadata com payload Fetch.

Formal somente se houver candidato:

`A, B, B, A, A, B`

Três medições por braço, mesmo sinal da triagem e separação conservadora:

```javascript
const separation =
  Math.min(...highDeltas) - Math.max(...lowDeltas);

const confirmed = separation >= 150;
```

Não alterar seleção, valores-limite ou critérios após observar resultados.

Se o controle não reproduzir, classificar explicitamente. Se não houver contraste elegível, INCONCLUSIVE. Se houver divergência formal, registrar a falha sem trocar de par.

Não reutilizar raws R12/R12-R2/R12-R4 na classificação.

---

## 7. Profiling nativo somente após confirmação formal

Se e somente se houver `R12R6_FACTORIAL_CONFIRMED`, autorizar a fase nativa.

Reutilizar `ap06-native-trace.mjs`, `ap06-native-capability.mjs`, `ap06_native.py` e os runners existentes.

Um Chromium para comprovar capacidade real de MemoryInfra e amostragem nativa.

Exigir:

- Flags memlog atestadas no processo real.
- Tracing ativado antes do workload.
- PIDs e dumps correspondentes.
- Dados de alocações nativas utilizáveis.
- Integridade do stream, hash e EOF.
- Nenhuma perda de eventos.
- Limites de memória, tamanho e timeout respeitados.

Sem capacidade suficiente: `R12R6_NATIVE_PROFILER_UNAVAILABLE`.

Não iniciar os dois browsers perfilados nesse caso.

Com capability PASS: dois Chromium independentes, um por braço confirmado.

Checkpoints:

1. Baseline.
2. Cycle-6-close.
3. Idle natural de 120 segundos.
4. GC diagnóstico final.

Distinguir retenção de objetos, reserva de alocador, commit, memória privada e amostragem.

Não afirmar vazamento nativo definitivamente sem evidência suficiente.

Uma fase nativa inconclusiva não invalida uma confirmação fatorial válida.

---

## 8. Custódia, STOPs e publicação

Preservar integralmente as campanhas anteriores:

R10, R11, R12, R12-R2, R12-R3, R12-R4 e R12-R5.

Não alterar seus freezes, raws, STOPs, manifests ou classificações.

Manter:

- DPAPI CurrentUser.
- Banco e storage isolados.
- JWT, autenticação e interceptors.
- Backend exclusivo em loopback.
- Ban e rate limiting de produção.
- ACL e validação de ownership.
- Zero plaintext FDK persistido.
- Traces nativas exclusivamente privadas.
- Cleanup apenas dos recursos próprios.
- Readback independente das publicações.

Um STOP deve gerar evidência de motivo, estágio, orçamento consumido, hashes, cleanup e recursos remanescentes, sem executar outro Chromium.

### Entrega

Criar PR Draft:

`investigation(ap06): R12-R6 scientific authority and factorial execution`

Relatórios:

- `docs/qualidade/ap06-r12-r6.md`
- `docs/qualidade/ap06-r12-r6.json`

Documentar:

- HEAD de implementação e HEAD de evidência.
- Base Git e estado do PR anterior.
- Autoridade R12-R6 e seu SHA-256.
- Proveniência/equivalência do corpus.
- Testes, CI e correção de eventuais discrepâncias do guard.
- Preflight, freeze e identidade Chromium.
- Quatro triagens e seis medições formais, se autorizadas.
- Classificação fatorial e separação conservadora.
- Profiling nativo, se executado.
- Orçamento real e zero retries.
- Cleanup, custódia, limitações e próxima hipótese.

Não fazer merge nem alterar produção.

### Critério de conclusão

A R12-R6 deve conseguir executar, sob uma autoridade íntegra e corpus validado, a comparação formal entre XHR e Fetch nos chunks de payload, isolando o efeito da metadata.

Se o experimento confirmar o contraste, disponibilizar evidência suficiente para orientar uma futura rodada de otimização do streaming. Se não confirmar, registrar a refutação ou inconclusão sem modificar os critérios.

**Prioridade absoluta:** código enxuto, funcional, seguro e testável. Reutilizar a infraestrutura já construída, corrigir somente falhas comprovadas, evitar duplicação de runners e preservar o desempenho e a integridade de todas as medições.
