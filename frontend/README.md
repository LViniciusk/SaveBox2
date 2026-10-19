# Nanika Frontend

Frontend Angular 20 standalone do Nanika. A aplicação usa Signals, componentes standalone e detecção zoneless; a descriptografia e a Vault Key permanecem no navegador.

## Desenvolvimento

```bash
npm install
npm start
```

A aplicação fica disponível em `http://127.0.0.1:4200/`. O servidor de desenvolvimento usa IPv4 loopback por padrão para evitar diferenças de resolução de `localhost`/IPv6 entre ambientes.

## Build e testes

```bash
npm run build
npm test -- --watch=false --browsers=ChromeHeadless
npm run test:coverage
npm run e2e:chromium
```

O build de produção é gerado em `dist/frontend`. A suíte E2E usa Playwright/Chromium e precisa de um backend local acessível, do target `nanika_e2e_fixture` compilado com `BUILD_TESTS=ON` e do frontend/backend em execução. As credenciais e a frase do Vault são geradas em memória por teste; não é necessário configurar usuário humano.
