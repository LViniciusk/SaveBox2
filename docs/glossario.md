# Glossário do Nanika

**Status documental:** PARCIAL  
**Escopo:** termos arquiteturais usados no código e nesta documentação  
**Autoridade:** código-fonte atual e tooling versionado  
**Última revisão documental:** 2026-09-03

As definições abaixo descrevem o significado dos termos no Nanika. Elas não substituem os documentos de segurança, dados ou fluxos que serão produzidos posteriormente.

## Arquitetura

- **Frontend:** aplicação Angular executada no navegador. Apresenta a interface, mantém estado cliente e coordena operações client-side.
- **Backend:** processo C++ que expõe a API HTTP por meio do Crow e coordena autenticação, autorização, estado persistente e operações de storage previstas no código.
- **Provider:** destino ou origem de storage representado pela aplicação, como o storage `Local` ou uma conta Google Drive.
- **Control plane:** operações de controle e metadados, como vínculo e gerenciamento de uma conta Google Drive. O termo não representa por si só o transporte dos bytes de um arquivo.

## Criptografia

- **Vault:** contexto protegido do usuário usado pela aplicação para liberar as operações do drive.
- **Vault Key:** chave mantida em memória no cliente durante o uso desbloqueado do Vault.
- **FDK (File Data Key):** chave associada a um arquivo para as operações criptográficas client-side.
- **baseNonce:** valor-base usado pelo formato criptográfico implementado no frontend.
- **ciphertext:** conteúdo cifrado manipulado pelos fluxos de armazenamento.
- **plaintext:** conteúdo em claro disponível no cliente durante operações que exigem a representação original.
- **Zero-Knowledge:** descrição usada pelo projeto para a separação entre operações criptográficas sensíveis no cliente e a API. Este glossário não estabelece, sozinho, um modelo de ameaça ou uma garantia de segurança.

## Storage e transporte

- **Local:** modalidade de storage em que o backend coordena bytes persistidos no armazenamento local configurado para o serviço.
- **Google Drive:** provider externo de storage integrado ao Nanika. A integração possui operações de controle no backend e operações de dados no navegador em fluxos suportados pelo frontend.
- **Storage Move:** operação de movimentação de arquivos entre destinos de storage coordenada pela aplicação.
- **chunk:** parte de um arquivo usada pelos mecanismos de transferência e pelo armazenamento local.
- **Range:** cabeçalho HTTP usado pelos fluxos que leem apenas uma faixa do conteúdo, incluindo operações de streaming e downloads parciais.

## Identidade

- **JWT:** token usado pelo frontend nas requisições autenticadas conforme a configuração atual de autenticação.
- **JTI:** identificador associado a um JWT para controle de sessão e invalidação.
- **sessão:** estado de autenticação associado ao usuário e controlado pelo backend; o frontend mantém sua representação de runtime em memória.

## Testes e qualidade

- **teste de caracterização:** teste que registra o comportamento observado de uma fronteira para servir de evidência e proteção contra regressão.
- **regression guard:** teste ou verificação que protege um comportamento já caracterizado.
- **Full / Heavy:** rótulos usados pelo tooling de qualidade para distinguir conjuntos de verificações mais amplos ou custosos.
- **freeze:** estado de processo usado pelos artefatos de qualidade para indicar que uma rodada foi encerrada formalmente; não é uma propriedade funcional da aplicação.

## Termos ainda não aprofundados

Este pacote não define em profundidade `Master Key`, `E2EE`, lifecycle de chaves, threat model, schema relacional ou protocolos de cada transferência. Esses assuntos dependem de documentação posterior e não devem ser inferidos apenas deste glossário.

## Fontes de autoridade no repositório

- `frontend/src/app/core/crypto/`
- `frontend/src/app/core/auth/`
- `frontend/src/app/features/drive/`
- `backend/src/`
- `backend/include/`
- `tools/quality/README.md`

## Fora do escopo deste documento

- Derivação, rotação, destruição e hierarquia completa de chaves.
- Threat model e análise de propriedades de segurança.
- Contrato completo da API e descrição detalhada dos fluxos de transferência.

