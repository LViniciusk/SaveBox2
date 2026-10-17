# AP-06 R12-R5 — Errata de CI

Esta errata corrige somente o registro de CI do relatório R12-R5. O `R12R5_STOP` científico continua válido; nenhum freeze, raw, STOP ou classificação histórica foi alterado.

| HEAD executado | Backend CI | Quality Baseline | Leitura correta |
|---|---|---|---|
| `9fc6725e151fbde3c1335866efb94f2e135995c6` | Sucesso, 3 jobs | Falha no job `quality-report`, etapa “Frontend machine-readable coverage”; E2E passou | CI parcial; não declarar Quality Baseline verde |
| `25dec809d212dbda1ff93433182e1ed9f332875e` | Sucesso, 3 jobs | Sucesso, todos os jobs | CI final da R12-R5 verde |

Execuções do GitHub Actions:

- HEAD `9fc6725`: [Backend CI 38999853900](https://github.com/LViniciusk/SaveBox2/actions/runs/38999853900), [Quality Baseline 38999853886](https://github.com/LViniciusk/SaveBox2/actions/runs/38999853886).
- HEAD `25dec809`: [Backend CI 38999995971](https://github.com/LViniciusk/SaveBox2/actions/runs/38999995971), [Quality Baseline 38999995938](https://github.com/LViniciusk/SaveBox2/actions/runs/38999995938).

O PR #32 permanece Draft, aberto e não mesclado, com base `investigation/ap06-r12-r4` e head `investigation/ap06-r12-r5`. A campanha R12-R5 não executou Chromium científico porque sua autoridade não estava disponível. A R12-R6 é uma autoridade separada e não muda esse resultado.
