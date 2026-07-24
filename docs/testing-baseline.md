# Baseline de testes

Data da medição: 25/07/2026.

## Ambiente observado

- Windows, Node.js 22.19.0, npm 10.9.3 e Angular CLI 20.2.2.
- CMake 3.30.2 e compilador MinGW UCRT64 (g++).
- ChromeHeadless 150 para Karma.
- O repositório já tinha alterações locais antes desta baseline; elas foram preservadas.

## Frontend

| Etapa | Comando | Resultado |
| --- | --- | --- |
| Instalação | `npm ci` | Não reexecutada: `node_modules` e `package-lock.json` já estavam presentes; a reinstalação removeria a árvore local. |
| Build de produção | `npm run build` | Sucesso em 10,365 s. Saída em `frontend/dist/frontend`. |
| Testes e cobertura | `npm run test:coverage` | Sucesso: 229 specs, 0 falhas. |

Cobertura global medida:

| Statements | Branches | Functions | Lines |
| --- | --- | --- | --- |
| 63,20% (2262/3579) | 50,03% (637/1273) | 70,88% (409/577) | 65,41% (2088/3192) |

O threshold global configurado no Karma é 50% para todos os indicadores. A cobertura de branches passa por margem mínima (0,03 ponto percentual); toda adição de teste deve rodar a suíte completa antes de ser aceita.

## Validação após os novos testes

Depois dos dois cenários adicionados ao `DriveStore`, `npm run test:coverage` concluiu com 231 specs, 0 falhas e a seguinte cobertura:

| Statements | Branches | Functions | Lines |
| --- | --- | --- | --- |
| 63,39% (2269/3579) | 50,19% (639/1273) | 70,88% (409/577) | 65,63% (2095/3192) |

Isso mantém todos os thresholds e melhora a cobertura de branches em 0,16 ponto percentual sobre a baseline.

Warnings observados no build, sem falha:

- Importação de `MP4Box` em `stream-transmux.worker.ts` não foi resolvida estaticamente.
- Bundle inicial: 839,86 kB, 339,86 kB acima do budget de 500 kB.
- Budgets CSS excedidos em Topbar, VaultHome, VideoPlayer e FileList.

## Backend

| Etapa | Comando | Resultado |
| --- | --- | --- |
| Configuração | `cmake -S backend -B backend/build -DBUILD_TESTS=ON` | Sucesso, após liberar rede para obter `jwt-cpp`. |
| Build | `cmake --build backend/build --target savebox_server savebox_tests --parallel 1` e `cmake --build backend/build --target savebox_tests --parallel 1` | `savebox_server` e `savebox_tests` compilados com sucesso. |
| Catch2 | `./savebox_tests.exe --order rand --rng-seed 12345` | Inconclusivo: iniciou setup e testes, mas havia um processo `savebox_tests` pré-existente, iniciado às 12:41, ainda em execução. Não foi encerrado por segurança. |
| Cobertura | configuração CMake existente com `ENABLE_COVERAGE=ON` | Não gerada nesta máquina: `gcovr` não está disponível e não houve resultado final confiável da suíte. |

Não existe `backend/.env` nesta cópia local. A CI cria a configuração PostgreSQL de teste antes de rodar a suíte; a reprodução local deve fornecer um banco descartável e as variáveis equivalentes, sem reutilizar dados de produção.

## Reprodução recomendada

```powershell
Set-Location frontend
npm ci
npm run build
npm run test:coverage

Set-Location ../backend
cmake -S . -B build -DBUILD_TESTS=ON -DENABLE_COVERAGE=ON -DCMAKE_BUILD_TYPE=Debug
cmake --build build --target savebox_server savebox_tests --parallel 1
Set-Location build
./savebox_tests.exe --order rand --rng-seed 12345
```

Para obter cobertura do backend, instale `gcovr` no ambiente de desenvolvimento e execute os testes apenas contra PostgreSQL de teste isolado.
