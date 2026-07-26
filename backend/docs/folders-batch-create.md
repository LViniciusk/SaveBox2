# `POST /folders/batch-create`

Cria ou reutiliza uma hierarquia de pastas em uma única transação. O cliente envia apenas nomes já criptografados, `name_hash` e referências temporárias opacas; caminhos e nomes em texto puro não fazem parte do contrato.

## Request

```json
{
  "root_parent_id": null,
  "folders": [
    {
      "client_ref": "550e8400-e29b-41d4-a716-446655440000",
      "parent_client_ref": null,
      "encrypted_name": "ciphertext",
      "name_hash": "blind-index"
    }
  ]
}
```

`root_parent_id` deve ser `null` ou uma pasta ativa do usuário. Cada referência aceita somente caracteres alfanuméricos, `-` e `_`, com até 128 caracteres. O lote aceita de 1 a 1000 pastas; a profundidade máxima é 128; `encrypted_name` aceita até 64 KiB e `name_hash` até 128 caracteres.

Filhos podem preceder os pais no array. A estrutura é validada e ordenada topologicamente antes dos inserts. Duplicidade de referência, ciclos, referências desconhecidas e colisões lógicas retornam `400`.

Pastas ativas com o mesmo `name_hash`, usuário e pai são reutilizadas (`created: false`). A criação individual já colide com linhas soft-deleted por uma constraint histórica; portanto esse caso permanece `409 Conflict`, sem restauração automática.

O frontend só oferece upload de pasta quando existem arquivos selecionados pelo input de diretório; pastas vazias não são enviadas nesta etapa.

Todas as operações de criação usam o mesmo advisory transaction lock por usuário, evitando corridas entre criação individual e batch. O endpoint nunca retorna nomes ou caminhos.

## Response `200`

```json
{
  "folders": [
    {
      "client_ref": "550e8400-e29b-41d4-a716-446655440000",
      "folder_id": 123,
      "created": true
    }
  ]
}
```
