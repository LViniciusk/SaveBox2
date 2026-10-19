# Fronteiras de Confiança

## Modelo de Confiança

O Nanika separa a proteção criptográfica dos arquivos das responsabilidades operacionais do servidor.

O **navegador** é a zona confiável para plaintext e chaves do Vault. O **backend** é confiável para autenticação, autorização, metadados, coordenação de storage e integração com provedores externos, mas não precisa das chaves que permitem descriptografar os arquivos armazenados.

```text
                         ┌──────────────────────────┐
                         │        Navegador         │
                         │                          │
                         │  Plaintext               │
                         │  Vault Key               │
                         │  FDKs                    │
                         │  Criptografia            │
                         └────────────┬─────────────┘
                                      │
                          metadata + ciphertext
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │         Backend          │
                         │                          │
                         │  Auth / autorização      │
                         │  Metadados               │
                         │  Storage control plane   │
                         └───────┬─────────┬────────┘
                                 │         │
                         ┌───────▼───┐ ┌───▼─────────────┐
                         │PostgreSQL │ │  Storage Local  │
                         │ metadata  │ │   ciphertext    │
                         └───────────┘ └─────────────────┘

                 Browser ═════ ciphertext ═════► Google Drive
                              acesso direto
```

O modelo protege principalmente o **conteúdo e as chaves criptográficas do Vault**. Ele não tenta esconder do servidor toda informação sobre a conta ou sobre a estrutura dos arquivos.

---

## Navegador

A criptografia dos arquivos ocorre no cliente.

Antes de um arquivo sair do navegador, o frontend:

1. gera uma FDK para o arquivo;
2. cifra o nome;
3. cifra a FDK sob a chave do Vault;
4. cifra o conteúdo;
5. envia ao backend apenas o resultado necessário ao armazenamento.

```text
Arquivo plaintext
      │
      ▼
     FDK
      │
      ├──► Nome cifrado
      │
      ├──► FDK cifrada
      │
      └──► Conteúdo cifrado
                  │
                  ▼
               Upload
```

Durante uma sessão desbloqueada, o navegador pode possuir em memória:

* Vault Key;
* FDKs;
* conteúdo e nomes plaintext;
* buffers temporários de criptografia;
* JWT da sessão;
* access tokens Google usados por operações client-side.

Esses valores não devem ser tratados como dados persistentes do servidor.

---

## Navegador → Backend

Para arquivos do Vault, o backend recebe metadados como:

| Informação                       | Visibilidade |
| -------------------------------- | ------------ |
| Nome original                    | Não          |
| Conteúdo plaintext               | Não          |
| FDK plaintext                    | Não          |
| Vault Key                        | Não          |
| Frase de segurança               | Não          |
| Nome cifrado                     | Sim          |
| FDK cifrada                      | Sim          |
| `name_hash`                      | Sim          |
| Tamanho do ciphertext            | Sim          |
| Estrutura de pastas              | Sim          |
| Provider de armazenamento        | Sim          |
| Estado de upload e transferência | Sim          |

O backend, portanto, não é completamente cego aos arquivos. Ele conhece sua **estrutura e metadata operacional**, mas não precisa do plaintext para gerenciá-los.

```text
Browser                              Backend

"documento.pdf"
      │
      ├── encrypt ───────────────► encrypted_name
      │
      ├── hash ──────────────────► name_hash
      │
arquivo
      └── encrypt ───────────────► ciphertext
```

### `name_hash`

`name_hash` é atualmente um BLAKE2b determinístico do nome plaintext.

Ele permite ao backend detectar conflitos de nomes sem receber diretamente o nome original, mas **não possui as mesmas propriedades de confidencialidade de um ciphertext**.

Nomes iguais produzem hashes iguais, permitindo correlação e tentativa de candidatos previsíveis.

---

## PostgreSQL

O PostgreSQL mantém a autoridade estrutural e operacional do sistema.

Entre os dados persistidos estão:

* usuários e informações de conta;
* sessões e estado de autenticação;
* estrutura de arquivos e pastas;
* `encrypted_name`;
* `encrypted_fdk`;
* `name_hash`;
* tamanho e estado dos arquivos;
* provider e identificadores externos;
* links de compartilhamento;
* estado de Storage Move;
* credenciais Google persistidas de forma cifrada.

```text
                PostgreSQL

Conta ───────► identidade / sessões

Vault ───────► encrypted_name
               encrypted_fdk
               name_hash
               tamanho
               relações estruturais

Google ──────► conta vinculada
               IDs externos
               refresh token cifrado
```

O banco não armazena a Vault Key, FDK plaintext ou conteúdo plaintext dos arquivos.

---

## Storage Local

No provider Local, o backend recebe e persiste bytes que já foram cifrados pelo navegador.

```text
Browser
   │
   │ ciphertext
   ▼
Backend
   │
   ▼
Storage Local
   │
   ├── <file_id>.dat
   └── <file_id>.proxy.dat
```

Os nomes físicos utilizam IDs internos, e não o filename original do usuário.

No download, o caminho é invertido:

```text
Storage Local
      │
      ▼
   Backend
      │
      │ ciphertext
      ▼
   Navegador
      │
      ▼
 descriptografia
      │
      ▼
   plaintext
```

O backend consegue ler, mover e remover os bytes armazenados, mas a interpretação do conteúdo depende da chave mantida pelo cliente.

---

## Google Drive

A integração com Google Drive possui dois caminhos distintos:

```text
                    CONTROL PLANE

Browser ─────────────► Backend ─────────────► Google APIs


                     DATA PLANE

Browser ═══════════ ciphertext ═══════════► Google Drive
```

### Control plane

O backend administra:

* OAuth da conta vinculada;
* refresh tokens;
* access tokens;
* quota;
* pasta raiz do Nanika;
* seleção de conta;
* resumable sessions;
* unlink e cleanup;
* identificadores dos arquivos externos.

O refresh token é armazenado cifrado no PostgreSQL, mas o backend possui o segredo necessário para recuperá-lo durante a execução.

Por isso, as **credenciais Google não fazem parte da propriedade Zero-Knowledge do Vault**.

### Data plane

Os bytes dos arquivos Google não precisam passar pelo backend.

O navegador recebe a capability necessária e transfere o ciphertext diretamente para a API do Google Drive.

No download ocorre o mesmo princípio:

```text
Google Drive
      │
      │ ciphertext
      ▼
   Navegador
      │
      ▼
 descriptografia
```

O provider recebe o objeto cifrado e metadados necessários ao próprio serviço, mas não recebe a FDK plaintext pelo protocolo de armazenamento.

---

## Compartilhamento Público

Public Share é suportado apenas para arquivos armazenados no provider Local.

Ao gerar um link, o navegador recupera a FDK do arquivo e coloca essa chave no **fragmento da URL**:

```text
https://nanika.example/share/<share-id>#<FDK>
```

O servidor recebe somente:

```text
/share/<share-id>
```

O trecho após `#` permanece no navegador e não faz parte da requisição HTTP.

```text
Proprietário

FDK ────────────────────┐
                        │
share-id ──────────┐    │
                   ▼    ▼
https://.../share/<id>#<FDK>
                       │
                       ▼
                  Destinatário
                       │
             ┌─────────┴─────────┐
             │                   │
         share-id               FDK
             │                   │
             ▼                   │
          Backend                │
             │                   │
          ciphertext             │
             │                   │
             └─────────► Browser ◄┘
                            │
                            ▼
                      descriptografia
```

O backend conhece:

* `share_uuid`;
* arquivo associado;
* tamanho;
* nome cifrado para o compartilhamento;
* existência e estado do link.

Ele não recebe a FDK necessária para descriptografar o arquivo.

### O link é uma capability

Quem possui o link completo possui tanto:

1. o identificador que permite obter o ciphertext;
2. a chave que permite descriptografá-lo.

Por isso, o link completo deve ser tratado como um segredo.

Revogar o compartilhamento impede novas requisições pelo `share-id`, mas não pode recuperar uma chave ou plaintext que um destinatário já tenha obtido.

---

## Dados Fora do Vault

A fronteira criptográfica dos arquivos não se aplica automaticamente a todos os dados da aplicação.

O backend processa diretamente informações necessárias ao funcionamento do serviço, como:

* username e e-mail;
* senha durante cadastro e login;
* informações de perfil;
* tokens de autenticação;
* credenciais OAuth;
* endereço IP utilizado por mecanismos antiabuso.

A foto de perfil também possui um fluxo próprio:

```text
Navegador ── imagem ──► Backend ── imagem ──► Imgur
```

Esses dados pertencem à identidade e operação da conta, não ao modelo E2EE dos arquivos armazenados.

---

## Resumo das Fronteiras

| Componente                   | Pode observar plaintext dos arquivos? | Possui chave de descriptografia? | Papel                                     |
| ---------------------------- | :-----------------------------------: | :------------------------------: | ----------------------------------------- |
| Navegador do usuário         |                  Sim                  |                Sim               | Criptografia e uso dos arquivos           |
| Backend                      |                  Não                  |                Não               | Auth, autorização, metadata e coordenação |
| PostgreSQL                   |                  Não                  |                Não               | Estado persistente                        |
| Storage Local                |                  Não                  |                Não               | Armazenamento de ciphertext               |
| Google Drive                 |                  Não                  |                Não               | Armazenamento externo de ciphertext       |
| Destinatário de Public Share |                  Sim                  |   FDK do arquivo compartilhado   | Acesso delegado                           |

O princípio central da arquitetura é:

```text
Controle e metadata
        │
        ▼
     Backend

Conteúdo e chaves
        │
        ▼
     Cliente
```

O servidor continua sendo uma autoridade importante para identidade, acesso e estado operacional, mas a confidencialidade do conteúdo armazenado é construída de forma que a descriptografia permaneça no cliente.
