# Documentação do Nanika

**Status documental:** VERIFICADO-NO-CÓDIGO  
**Escopo:** portal da documentação técnica do estado atual do repositório  
**Autoridade:** código-fonte atual  
**Última revisão documental:** 2026-09-03

## Objetivo

Esta área organiza a documentação técnica do Nanika: arquitetura, fluxos, segurança, dados, API, operação, qualidade e decisões. O [README do projeto](../README.md) continua sendo a porta de entrada geral; este arquivo é a porta de entrada para a documentação técnica aprofundada.

## Princípios documentais

- O código-fonte atual é a autoridade primária para afirmações sobre o comportamento existente.
- A documentação é source-first: não transforma nomes de classes, intenção presumida ou histórico em fatos.
- Limitações e áreas não verificadas são explicitadas.
- A documentação acompanha mudanças arquiteturais relevantes na mesma fronteira de trabalho, sem exigir atualização para toda alteração trivial.
- Nenhum segredo, token, credencial ou dado pessoal deve ser copiado para a documentação.

## Estado da documentação

| Área | Status | Entrada |
| --- | --- | --- |
| Arquitetura | VERIFICADO-NO-CÓDIGO | [Arquitetura](arquitetura/README.md) |
| Fluxos | PLANEJADO | [Fluxos](fluxos/README.md) |
| Segurança | PARCIAL | [Segurança](seguranca/README.md) |
| Dados | PLANEJADO | [Dados](dados/README.md) |
| API | PARCIAL | [API](api/README.md) |
| Operações | PARCIAL | [Operações](operacoes/README.md) |
| Qualidade | PARCIAL | [Qualidade](qualidade/README.md) |
| Decisões | PLANEJADO | [Decisões](decisoes/README.md) |

## Comece por aqui

- [Visão geral da arquitetura](arquitetura/visao-geral.md)
- [Arquitetura do frontend](arquitetura/frontend.md)
- [Arquitetura do backend](arquitetura/backend.md)
- [Arquitetura de deployment](arquitetura/deployment.md)
- [Glossário](glossario.md)
- [Especificação OpenAPI](swagger.yaml)

## Como interpretar as afirmações

- **ATUAL:** comportamento ou organização comprovados no código revisado.
- **INVARIANTE:** propriedade que o projeto exige preservar e para a qual há evidência suficiente no source e, quando aplicável, nos testes.
- **JUSTIFICATIVA:** motivo de uma decisão somente quando esse motivo é sustentado por documentação ou evidência do projeto.
- **LIMITAÇÃO:** restrição conhecida do estado atual ou do documento.
- **PLANEJADO:** documentação ainda não produzida ou aspecto explicitamente reservado para etapa posterior. Não significa que uma funcionalidade futura esteja implementada.

## Transparência

Comportamento não comprovado não é apresentado como garantia. Boundaries de segurança são descritos em termos verificáveis, e cada documento aponta para suas fontes no repositório. A documentação descreve o estado atual revisado; isso não implica que ele já tenha sido publicado como release.

## Como manter esta documentação

Quando uma mudança alterar a arquitetura ou uma fronteira de responsabilidade, atualize o documento correspondente na mesma fronteira de trabalho. Preserve a distinção entre estado atual, invariantes, limitações e conteúdo planejado. Detalhes operacionais devem continuar nas documentações operacionais existentes, em vez de serem duplicados aqui.

## Roteiro documental

Arquitetura atual → segurança e criptografia → identidade e Vault → fluxos de dados → providers e storage → dados e API → operações e qualidade → threat model. Os índices das áreas futuras indicam o que ainda não foi documentado em profundidade.

## Fontes de autoridade no repositório

- `frontend/src/`
- `backend/src/`
- `backend/include/`
- `docker-compose.yml`
- `frontend/Dockerfile`
- `frontend/nginx.conf`
- `deploy/`
- `docs/swagger.yaml`

## Fora do escopo deste documento

- Protocolos detalhados de upload, download, streaming e movimentação entre storages.
- Modelo criptográfico completo, threat model e referência endpoint por endpoint.
- Runbooks operacionais, geração de site, PDF ou integração automática deste teste ao CI.

