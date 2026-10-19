# Segurança

A segurança do Nanika é baseada em **criptografia client-side**, separação de chaves e redução do conhecimento necessário pela infraestrutura de armazenamento.

O navegador é a zona que possui as chaves e o plaintext necessários para utilizar o Vault. O backend continua responsável por autenticação, autorização, metadados e coordenação dos storages, mas não recebe diretamente as chaves necessárias para descriptografar os arquivos.

```text
                     Navegador
                        │
              Plaintext + Chaves
                        │
                        ▼
                   Criptografia
                        │
                        ▼
                    Ciphertext
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
          Backend              Google Drive
             │
        ┌────┴────┐
        ▼         ▼
   PostgreSQL    Local
```

## Modelo de Segurança

A hierarquia criptográfica principal é:

```text
Frase de Segurança
        │
        ▼
    Master Key
        │
        ▼
    Vault Key
        │
        ▼
       FDK
        │
        ▼
     Arquivo
```

A frase de segurança deriva uma Master Key transitória.

A Master Key protege uma Vault Key aleatória.

A Vault Key protege as FDKs individuais.

Cada FDK protege um arquivo.

Essa separação permite, entre outras propriedades, trocar a frase de segurança sem precisar recriptografar todo o conteúdo armazenado.

---

## Documentos

### [Zero-Knowledge](zero-knowledge.md)

Define o que **Zero-Knowledge** significa no contexto do Nanika.

Explica:

* quais informações permanecem no cliente;
* o que o backend consegue observar;
* quais metadados permanecem visíveis;
* a relação entre Vault e identidade;
* Google Drive;
* Public Share;
* limitações do modelo.

Também deixa explícito que:

```text
Zero-Knowledge
      ≠
servidor sem conhecimento algum
```

A propriedade se concentra nas chaves e no plaintext necessários para acessar o conteúdo do Vault.

---

### [Modelo Criptográfico](crypto-model.md)

Descreve as primitivas e formatos utilizados pela criptografia do Vault.

Inclui:

* Argon2id;
* Master Key;
* Vault Key;
* FDKs;
* XChaCha20-Poly1305;
* BLAKE2b;
* `encrypted_name`;
* `encrypted_fdk`;
* `name_hash`;
* formato Kasumi;
* nonces;
* autenticação por chunk;
* metadata cifrada;
* limites de integridade do formato.

O caminho principal é:

```text
Frase
  │
  ▼
Argon2id
  │
  ▼
Master Key
  │
  ▼
Vault Key
  │
  ▼
FDK
  │
  ▼
XChaCha20-Poly1305
  │
  ▼
Ciphertext
```

---

### [Ciclo de Vida das Chaves](keys-lifecycle.md)

Explica quando cada segredo nasce, onde permanece e quando deve deixar de existir.

Abrange:

* frase de segurança;
* Master Key;
* Vault Key;
* FDKs;
* uploads;
* downloads;
* thumbnails;
* streaming;
* Public Share;
* `baseNonce`;
* lock;
* logout;
* cancelamentos;
* zeroization.

```text
criar
  │
  ▼
atribuir ownership
  │
  ▼
usar
  │
  ▼
estado terminal
  │
  ▼
wipe
  │
  ▼
remover referência
```

O documento também diferencia explicitamente:

```text
referência removida
        ≠
bytes sobrescritos
```

especialmente considerando as limitações do runtime JavaScript.

---

## Fronteiras de Confiança

A visão de segurança depende diretamente das fronteiras arquiteturais do sistema.

```text
                 SEGREDOS

        Vault Key / FDK / Plaintext
                    │
                    ▼
                 Browser


                 CONTROLE

       Identidade / Metadata / Estado
                    │
                    ▼
                 Backend


               PERSISTÊNCIA

           Ciphertext / Metadata
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
     PostgreSQL    Local     Google
```

A descrição detalhada dessas relações está em:

[**Fronteiras de Confiança**](../arquitetura/trust-boundaries.md)

---

## Criptografia do Vault e Autenticação

O Nanika possui domínios criptográficos diferentes.

```text
              Vault

Frase
  ↓
Master Key
  ↓
Vault Key
  ↓
FDKs
  ↓
Arquivos


          Autenticação

Password
  ↓
Password Hash

JWT
  ↓
Assinatura HS256


       Google Control Plane

Credencial do servidor
  ↓
Refresh Token protegido
```

A senha da conta não é a frase de segurança.

JWT não é uma chave do Vault.

Credenciais Google também não pertencem à hierarquia E2EE dos arquivos.

Cada mecanismo protege uma responsabilidade diferente.

---

## Garantias Principais

O desenho busca manter as seguintes propriedades:

```text
Arquivo plaintext
       │
       ▼
    Browser
       │
       ▼
   criptografia
       │
       ▼
   ciphertext
       │
       ├──► Storage Local
       └──► Google Drive
```

* o conteúdo é cifrado antes do storage;
* a Vault Key plaintext não é persistida pelo servidor;
* FDKs plaintext não são persistidas pelo servidor;
* arquivos utilizam chaves independentes;
* chunks possuem autenticação criptográfica individual;
* material criptográfico de runtime possui lifecycle definido;
* storage e criptografia permanecem responsabilidades separadas.

---

## Limites

O modelo não pretende ocultar toda informação sobre os dados.

A infraestrutura ainda pode observar propriedades como:

* existência dos arquivos;
* estrutura;
* timestamps;
* provider;
* identificadores operacionais;
* `name_hash`;
* tamanho do ciphertext;
* tamanho original presente no header Kasumi;
* padrões de acesso.

Também não protege contra um cliente já comprometido enquanto as chaves estão em uso.

```text
criptografia do storage
          ≠
isolamento contra o próprio cliente
```

O navegador precisa possuir plaintext e chaves durante o uso normal do Vault e, portanto, faz parte da base de confiança do sistema.

---

## Mapa da Segurança

```text
Segurança
   │
   ├── Zero-Knowledge
   │      └── quem conhece o quê?
   │
   ├── Modelo Criptográfico
   │      └── como os dados são protegidos?
   │
   └── Ciclo de Vida das Chaves
          └── por quanto tempo os segredos existem?
```

Os três documentos descrevem aspectos diferentes da mesma propriedade:

**o storage pode ser administrado sem que a infraestrutura precise receber diretamente as chaves e o plaintext necessários para ler os arquivos do Vault.**
