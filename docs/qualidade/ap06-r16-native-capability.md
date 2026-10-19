# AP-06 R16 — Simplificação Radical e Retorno à Investigação de Memória

**Classificação:** `R16_ENGINEERING_READY_FOR_CAPABILITY` — Infraestrutura simplificada e validada, remoção completa da arquitetura experimental de autorização Ed25519/trust anchor/SPKI, preservação rigorosa dos contratos MemoryInfra `heaps_v2` e isolamento de processos, runner e CLI determinísticos (`--run-capability`), suíte contratual íntegra (25/25 PASS), validações verdes; nenhuma execução de Chromium científico ou A/B autorizada ou realizada nesta rodada.

- **Repositório:** `LViniciusk/SaveBox2`
- **Branch:** `investigation/ap06-r16-native-capability`
- **Base:** `frontend`
- **PR:** [#43](https://github.com/LViniciusk/SaveBox2/pull/43)
- **HEAD:** `17860c98`
- **Classificação Prévia:** `R16_ENGINEERING_READY_AWAITING_AUTHORIZATION` (obsoleta)
- **Classificação Atual:** `R16_ENGINEERING_READY_FOR_CAPABILITY`

---

## 1. Objetivo e Princípios da Simplificação

A campanha AP-06 investiga a divergência de aproximadamente 431 MiB observada entre os transportes XHR/XHR e XHR/Fetch no cliente SaveBox2. O objetivo exclusivo da R16 é comprovar se o Chromium local consegue produzir quatro snapshots nativos válidos (`heaps_v2`) do renderer, habilitando análises causais subsequentes sem comprometer o isolamento de processo.

As iterações anteriores haviam introduzido um aparato experimental de segurança contendo:
- Verificação criptográfica Ed25519 via subprocesso Node.js (`verify_scientific_authorization.mjs`).
- Utilitário auxiliar de geração de pares de chaves e assinatura (`sign_test_authorization.mjs`).
- Verificação externa de trust anchors com impressões digitais SPKI DER SHA-256 e restrição de localizações.
- Parser léxico JSON RFC 8259 customizado contra zeros iniciais e surrogates.
- Controles de custódia, flags operacionais redundantes (`--authorization`, `--trust-anchor`) e testes dedicados exclusivamente a essa infraestrutura.

Esse mecanismo revelou-se sobre-engenharia desnecessária para conduzir um experimento científico local controlado em máquina do operador. A TASK determinou sua eliminação radical, sem substituição por HMAC, tokens, certificados ou políticas HKLM, retornando o foco estritamente à capacidade de profiling de memória.

---

## 2. Contexto Histórico vs. Estado Atual

| Aspecto | Histórico (Engenharia Anterior) | Estado Atual (Simplificação Radical) |
|---|---|---|
| **Autorização de Execução** | Documento JSON assinado via Ed25519, exigindo chave do Diretor Científico. | Comando explícito do operador via CLI (`--run-capability`). |
| **Trust Anchor / SPKI** | Raiz de confiança externa com fingerprint SPKI DER SHA-256 em `verify_scientific_authorization.mjs`. | **Removido integralmente.** Zero trust anchors ou arquivos de chave pública. |
| **Scripts Node Exclusivos** | `verify_scientific_authorization.mjs` (384 linhas) e `sign_test_authorization.mjs` (57 linhas). | **Excluídos do repositório** via `git rm` (0 arquivos, 0 linhas). |
| **Parâmetros da CLI** | `--authorization <path>` e `--trust-anchor <path>` obrigatórios. | **Removidos.** Apenas `--run-capability --source-output <path>`. |
| **Classificação de Preflight** | `R16_ENGINEERING_READY_AWAITING_AUTHORIZATION` | `R16_ENGINEERING_READY_FOR_CAPABILITY` |
| **Campos de Inspeção** | `scientificAuthorizationPresent`, `authorizationVerified` | **Removidos.** Preflight verifica exclusivamente sanidade ambiental e binários. |
| **Lock de Concorrência** | Verificação em Node acoplada com lock atômico em Python. | Lock nativo exclusivo e atômico da plataforma (`execution_lock`) em Python. |
| **Orçamento Científico** | Orçamento validado em dois parsers (Python e Node). | Orçamento estrito verificado no runner Python (`R16_BUDGET`). |

---

## 3. Tabela Comparativa de Métricas e Redução de Código

| Métrica | Antes (HEAD `4228edce`) | Depois (Simplificação R16) | Delta Líquido |
|---|---:|---:|---:|
| **Linhas de código da infraestrutura R16** | 2.894 linhas | 2.179 linhas | **-715 linhas (-24,7%)** |
| `tools/quality/verify_scientific_authorization.mjs` | 384 linhas | 0 linhas (excluído) | -384 linhas |
| `tools/quality/sign_test_authorization.mjs` | 57 linhas | 0 linhas (excluído) | -57 linhas |
| `tools/quality/run_ap06_r12_r13_native.py` | 1.470 linhas | 1.377 linhas | -93 linhas |
| `tools/quality/test_ap06_r12_r16.py` | 945 linhas | 765 linhas | -180 linhas |
| `tools/quality/run_ap06_r12_r16_native.py` | 38 linhas | 37 linhas | -1 linha |
| **Arquivos exclusivos de autorização** | 2 arquivos | **0 arquivos** | **-2 arquivos (-100%)** |
| **Dependências exclusivas de autorização** | 4 (Node `crypto`, SPKI DER, RFC 8785, Base64 64B) | **0 dependências** | **-4 dependências (-100%)** |
| **Parâmetros operacionais obrigatórios** | 3 (`--source-output`, `--authorization`, `--trust-anchor`) | 1 (`--source-output`) | **-2 parâmetros (-66,7%)** |
| **Testes unitários R16 válidos** | 25 testes (mistos com cripto) | **25 testes (100% científicos/isolamento)** | **25/25 PASS** |
| **Testes históricos de regressão** | 87 testes | **87 testes** | **87/87 PASS (zero regressões)** |
| **Testes Node de trace e integração** | 10 testes | **10 testes** | **10/10 PASS** |
| **Desempenho e memória do parser** | Streaming O(1), ~339 KB | **Streaming O(1), ~339 KB** | **Sem regressão** |

---

## 4. Procedimento Operacional Simplificado da CLI

A CLI da R16 opera com comandos determinísticos, atômicos e previsíveis:

### 4.1 Preparação de Ambiente
```powershell
py -3.12 tools/quality/run_ap06_r12_r16_native.py `
  --prepare `
  --source-output .quality/readiness-wave12-r12-factorial
```
Valida a árvore de build, binários nativos do backend e dependências sem criar reservas científicas.

### 4.2 Preflight Offline
```powershell
py -3.12 tools/quality/run_ap06_r12_r16_native.py `
  --offline-preflight `
  --source-output .quality/readiness-wave12-r12-factorial
```
Verifica em modo somente-leitura o ambiente Windows, integridade do Chromium headless-shell, sanidade dos XMLs Catch2 e relata prontidão operacional (`R16_ENGINEERING_READY_FOR_CAPABILITY`) sem lançar browser ou criar reservas.

### 4.3 Congelamento (Freeze)
```powershell
py -3.12 tools/quality/run_ap06_r12_r16_native.py --freeze
```
Registra os hashes de todos os artefatos de código, manifestos de teste e proveniência da tarefa em `tooling/freeze.json`, exigindo gate `global: PASS`.

### 4.4 Disparo Local Explícito da Capability (Futuro)
```powershell
py -3.12 tools/quality/run_ap06_r12_r16_native.py `
  --run-capability `
  --source-output .quality/readiness-wave12-r12-factorial
```
O comando `--run-capability` é suficiente para expressar a decisão do operador, adquirindo o lock de processo (`execution_lock`) e gravando a reserva científica única (`capability-reservation.json`). Nenhuma chave ou assinatura adicional é requerida.

> [!IMPORTANT]
> Os comandos acima definem o contrato da interface implementada e testada. **Nenhum Chromium científico foi lançado durante esta rodada de engenharia.**

---

## 5. Contratos de Profiling e Núcleo Científico Preservados

A simplificação radical removeu exclusivamente o arcabouço criptográfico, mantendo 100% da integridade científica do analisador:

1. **4 Checkpoints Temporais:**
   - `baseline`: antes de qualquer carga de trabalho.
   - `cycle-6-close`: encerramento do sexto ciclo de sincronização.
   - `idle-120s`: 120 segundos de inatividade monitorada.
   - `forced-GC-final`: coleta forçada de lixo via CDP antes da captura final.
2. **MemoryInfra e `heaps_v2` v1:**
   - Dumps detalhados de heap alocados no processo `Renderer`.
   - Rejeição contratual de traces contendo `heaps_v2` exclusivamente em processos auxiliares (`OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2`).
3. **Identidade do Renderer e Isolamento:**
   - Vínculo imutável de PID, GUID e FILETIME de criação do processo Win32 (`_proof_matches`).
   - Rejeição de GUIDs duplicados ou alias numéricos equivalentes (`NATIVE_CHECKPOINT_GUID_DUPLICATE`).
4. **Streaming O(1) e Limites de Integridade:**
   - Limite estrito de 512 MiB por arquivo de trace e 32 MiB por evento.
   - Validação contínua de checksum SHA-256 e integridade de schema.
5. **Orçamento Fixo e Reserva Única:**
   ```python
   R16_BUDGET = {
       'capability': 1,
       'profiledA': 0,
       'profiledB': 0,
       'maximum': 1,
       'retries': 0,
   }
   ```
   - Reserva persistida em disco impede segundas tentativas ou replays.
   - Proibição absoluta de medições A/B (`profiledA: 0, profiledB: 0`).
6. **Cleanup de Processos e Serviços:**
   - Parada forçada e verificação de encerramento de servidores backend e processos órfãos (`stop_and_verify_backend_cleanup`).
   - Cleanup não comprovado impede a emissão de decisão `PASS`.

---

## 6. Refatoração da Suíte de Testes Contratuais

A suíte `tools/quality/test_ap06_r12_r16.py` foi reorganizada para eliminar os cenários de assinatura e validar diretamente os contratos de profiling e isolamento:

| Caso | Escopo do Teste | Comportamento Verificado | Status |
|---|---|---|---|
| **Caso 1** | Execução offline sem chaves | Execução com mock capture opera sem autorização ou chaves em disco | **PASS** |
| **Caso 2** | Preflight e freeze sem browser | `freeze_campaign` congela artefatos sem lançar Chromium nem criar reserva | **PASS** |
| **Caso 3** | Capability sintética válida | 4 checkpoints produzem `R12R16_NATIVE_CAPABILITY_PASS` e zero A/B | **PASS** |
| **Caso 4** | Quarto dump ausente | Trace incompleto resulta em `R12R16_NATIVE_CAPABILITY_INCONCLUSIVE` | **PASS** |
| **Caso 5** | heaps_v2 em processo auxiliar | Heap em outro PID não comprova o renderer (`OBSERVED_ONLY_OTHER_PROCESS_HEAPS_V2`) | **PASS** |
| **Caso 6** | FILETIME divergente | Divergência temporal de criação do renderer gera rejeição imediata | **PASS** |
| **Caso 7** | GUID duplicado | Rejeição contratual de checkpoints com dump_guid repetido | **PASS** |
| **Caso 8** | Truncamento e checksum | Checksum divergente ou JSON corrompido aciona STOP durável | **PASS** |
| **Caso 9** | Cleanup incompleto | Porta ou processo remanescente bloqueia emissão de decisão PASS | **PASS** |
| **Caso 10** | Reserva consumida | Tentativa de reexecução após reserva existente é bloqueada | **PASS** |
| **Caso 11** | Zero A/B após PASS | Capability PASS garante que pares A/B nunca são invocados | **PASS** |
| **Caso 12** | Isolamento de autoridade | Autoridade R16 não altera diretórios pertencentes a R13/R14 | **PASS** |
| **Caso 13** | Namespace de publicação | Namespace `r12-r16-native` respeitado em publicação e readback | **PASS** |
| **Caso 14** | Contabilidade de estados | Decisão e ledger registram estritamente 1 capability e 0 medições | **PASS** |
| **Caso 15** | Rejeição por R13/R14 | Máquinas históricas rejeitam status exclusivo de PASS da R16 | **PASS** |
| **Caso 16** | Erros pré-reserva | Falha de pré-lançamento retorna erro de engenharia sem STOP | **PASS** |
| **Caso 17** | Erros pós-reserva | Falha após reserva registra STOP durável com reserva preservada | **PASS** |
| **Caso 18** | Preflight somente-leitura | Relata `R16_ENGINEERING_READY_FOR_CAPABILITY` sem chaves | **PASS** |
| **Caso 19** | Separação da CLI | Rejeita `--run` na R16 e rejeita `--run-capability` na R14 | **PASS** |
| **Caso 20** | Freeze estrito | Gate `global: PASS` obrigatório na R16 (rejeita `DOCUMENTED_EXCEPTION`) | **PASS** |
| **Caso 21** | Integração sintética E2E | Mock CDP → trace → validate → decision → readback com integridade | **PASS** |
| **Caso 22** | 8 Cenários do Produtor Node | Integração de `NativeTrace` real com CDP mock em 8 fluxos contratuais | **PASS** |
| **Caso 23** | Concorrência com lock ativo | Rejeição de invocação concorrente via `R16_CONCURRENT_INVOCATION_REJECTED` | **PASS** |
| **Caso 24** | Estado científico preexistente | Distinção entre preflight bloqueado e consumo científico não verificado | **PASS** |
| **Caso 25** | Mútua exclusão concorrente | Dois fluxos simultâneos competindo pelo lock atômico respeitam exclusão mútua | **PASS** |

---

## 7. Desempenho e Memória do Parser (Protocolo de 8 Repetições)

O parser de streaming `ap06_native.py` não foi modificado nesta rodada, preservando os tempos e a eficiência de memória validados:

| Configuração | Eventos | Tamanho | Agregação (ms) Mediana ± DP | Diagnóstico (ms) Mediana ± DP | Tempo Total (ms) Mediana ± DP | Pico Memória (tracemalloc) | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| **Small** | 500 | 101,6 KB | 15,13 ± 4,78 ms | 18,71 ± 8,93 ms | 33,78 ± 13,40 ms | **205,2 KB** | `NATIVE_CAPABILITY_PASS` |
| **Medium** | 5.000 | 1.011,2 KB | 163,09 ± 45,24 ms | 237,19 ± 19,05 ms | 412,50 ± 57,14 ms | **339,4 KB** | `NATIVE_CAPABILITY_PASS` |
| **Large** | 20.000 | 4.053,7 KB | 787,82 ± 116,42 ms | 1.159,97 ± 244,43 ms | 1.925,48 ± 293,32 ms | **339,3 KB** | `NATIVE_CAPABILITY_PASS` |
| **X-Large** | 50.000 | 10.147,4 KB | 1.908,79 ± 119,24 ms | 2.806,86 ± 293,00 ms | 4.793,63 ± 262,61 ms | **339,2 KB** | `NATIVE_CAPABILITY_PASS` |

- **Streaming O(1):** Pico de memória estável em ~339 KB de 5.000 a 50.000 eventos.
- **Linearidade O(N):** Tempo proporcional à quantidade de dados sem overhead desnecessário.

---

## 8. Preservação Histórica e Zero Execuções Científicas

- **Zero Execução Científica:** Nenhum processo Chromium real foi disparado para coleta ou profiling nesta rodada.
- **Zero Medição A/B:** O caminho de comparação de transporte permanece bloqueado contratual e programaticamente (`profiledA: 0, profiledB: 0`).
- **Preservação Histórica:** As autoridades e evidências de R12-R12 (`R12R12_FACTORIAL_CONFIRMED`), R12-R13 STOP e R12-R14 freeze permanecem intocadas e imutáveis.
- **Isolamento de Branches:** Todas as alterações pertencem exclusivamente ao branch `investigation/ap06-r16-native-capability` direcionadas ao PR #43 com base em `frontend`.

---

## 9. Evidências de Validação Contratual e CI no HEAD Final (`17860c98`)

| Workflow | Job | Status | Duração | URL |
|---|---|---|---|---|
| **Backend CI** | Linux GCC | **PASS** | 4m56s | [Job 118198085118](https://github.com/LViniciusk/SaveBox2/actions/runs/39292967840/job/118198085118) |
| **Backend CI** | Linux Coverage | **PASS** | 7m28s | [Job 118198085689](https://github.com/LViniciusk/SaveBox2/actions/runs/39292967840/job/118198085689) |
| **Backend CI** | Windows MSVC | **PASS** | 6m29s | [Job 118198085801](https://github.com/LViniciusk/SaveBox2/actions/runs/39292967840/job/118198085801) |
| **Quality Baseline** | quality-report | **PASS** | 2m00s | [Job 118201022090](https://github.com/LViniciusk/SaveBox2/actions/runs/39292967894/job/118201022090) |
| **Quality Baseline** | e2e | **PASS** | 3m01s | [Job 118201018870](https://github.com/LViniciusk/SaveBox2/actions/runs/39292967894/job/118201018870) |

- **Suíte Python Completa (112 testes):** `Ran 112 tests in 86.341s — OK`
- **Produtor Node (`NativeTrace`):** `10/10 PASS (4.3s)`
- **TypeScript:** `tsc --noEmit -p frontend/tsconfig.app.json` — 0 erros.
- **Segurança e Segredos:** `gitleaks protect --staged` — 0 leaks detectados.
- **Formatação Git:** `git diff --check` — 0 erros.

