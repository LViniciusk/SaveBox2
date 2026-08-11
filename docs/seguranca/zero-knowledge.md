# Zero-Knowledge

No Nanika, **Zero-Knowledge** descreve a separação entre o servidor que administra o armazenamento e o cliente que possui as informações necessárias para descriptografar os arquivos do Vault.

O backend pode autenticar usuários, organizar arquivos, controlar storages e persistir metadados sem precisar receber diretamente o plaintext dos arquivos ou as chaves utilizadas para recuperá-lo.

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
          ┌────────────┴────────────┐
          ▼                         ▼
       Backend                  Google Drive
          │
      ┌───┴────┐
      ▼        ▼
 PostgreSQL   Local
```

O termo descreve o **modelo de conhecimento do serviço sobre o Vault**. Ele não se refere a protocolos de Zero-Knowledge Proofs.

---

## O que Permanece no Cliente

A hierarquia criptográfica do Vault é construída no navegador:

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

A **frase de segurança** é utilizada localmente para derivar a Master Key.

A **Master Key** é transitória: ela existe somente durante operações como inicialização, desbloqueio ou troca da frase.

A **Vault Key** é uma chave aleatória de 32 bytes mantida em memória enquanto o Vault está desbloqueado.

Cada arquivo possui uma **FDK — File Data Key** própria.

O backend não recebe diretamente:

* frase de segurança;
* Master Key;
* Vault Key plaintext;
* FDK plaintext;
* conteúdo plaintext dos arquivos;
* filename plaintext dos arquivos e pastas.

---

## Desbloqueio do Vault

O servidor persiste `vault_verification`, que contém a Vault Key cifrada sob uma chave derivada da frase de segurança.

O desbloqueio acontece no navegador:

```text
Backend
   │
   │ vault_verification
   ▼
Navegador
   │
   ├── Frase de Segurança
   │
   ▼
Argon2id
   │
   ▼
Master Key
   │
   ▼
decrypt(vault_verification)
   │
   ▼
Vault Key
```

A frase não é enviada ao backend para ser validada.

Em vez disso, o frontend tenta abrir `vault_verification` localmente. Uma frase incorreta produz uma chave incapaz de autenticar o ciphertext.

Depois da operação, a Master Key é sobrescrita.

Ao bloquear o Vault, a Vault Key também é sobrescrita e removida da instância ativa.

```text
Unlocked
   │
   ▼
 lock()
   │
   ▼
Vault Key.fill(0)
   │
   ▼
Vault Key = null
   │
   ▼
Locked
```

---

## Arquivos

Antes de um arquivo ser armazenado, o navegador prepara todo o material criptográfico necessário.

```text
Nome plaintext ──► encrypt ─────► encrypted_name
       │
       └─────────► BLAKE2b ─────► name_hash

random ─────────────────────────► FDK
                                  │
                                  └── encrypt ─► encrypted_fdk

Arquivo plaintext + FDK
          │
          ▼
  frames cifrados incrementais
```

O backend trabalha então com:

| Informação                   | Backend |
| ---------------------------- | :-----: |
| Conteúdo plaintext           |   Não   |
| Filename plaintext           |   Não   |
| FDK plaintext                |   Não   |
| Vault Key                    |   Não   |
| `encrypted_name`             |   Sim   |
| `encrypted_fdk`              |   Sim   |
| `name_hash`                  |   Sim   |
| Tamanho cifrado              |   Sim   |
| Pasta e relações estruturais |   Sim   |
| Provider                     |   Sim   |
| Estado da transferência      |   Sim   |

Zero-Knowledge, portanto, **não significa ausência de metadados**.

---

## Metadata Continua Visível

O servidor precisa conhecer parte da estrutura da aplicação para administrá-la.

Entre as informações observáveis estão:

```text
arquivo existe
      │
      ├── tamanho
      ├── pasta
      ├── provider
      ├── timestamps
      ├── estado de upload
      ├── estado de exclusão
      ├── compartilhamentos
      └── identificadores externos
```

O PostgreSQL também persiste `encrypted_name`, `encrypted_fdk` e `name_hash`.

Esses valores não fornecem diretamente o plaintext, mas possuem propriedades diferentes.

### `name_hash`

`name_hash` é calculado com BLAKE2b sobre o nome plaintext e não utiliza uma chave secreta.

```text
"foto.jpg"
    │
    ▼
 BLAKE2b
    │
    ▼
 name_hash
```

Por ser determinístico:

```text
mesmo nome
    ↓
mesmo hash
```

isso permite correlação entre nomes iguais.

Um observador que possua o hash também pode calcular hashes de nomes previsíveis e compará-los com o valor armazenado.

Por isso, `name_hash` não deve ser tratado como ciphertext nem como metadata confidencial.

---

## Frase de Segurança e Ataques Offline

A frase de segurança não é transmitida ao backend, mas existe uma limitação importante.

A derivação atual utiliza:

```text
Frase de Segurança
        +
e-mail normalizado
        │
        ▼
     Argon2id
        │
        ▼
    Master Key
```

O e-mail é conhecido pelo servidor e `vault_verification` também é armazenado pelo servidor.

Assim, uma entidade que obtenha esses dados pode testar frases candidatas localmente:

```text
frase candidata
      │
      ▼
   Argon2id
      │
      ▼
Master Key candidata
      │
      ▼
tenta abrir vault_verification
      │
      ├── falha ─► frase incorreta
      │
      └── sucesso ► frase encontrada
```

Argon2id aumenta o custo de cada tentativa, mas não transforma uma frase fraca em um segredo de alta entropia.

A resistência desse cenário depende, portanto, também da qualidade da frase escolhida pelo usuário.

---

## Storage Local

No provider Local, o backend participa do data plane, mas recebe bytes que já foram cifrados.

```text
Arquivo
   │
   ▼
Browser
   │
   │ criptografia
   ▼
Ciphertext
   │
   ▼
Backend
   │
   ▼
Storage Local
```

No download:

```text
Storage Local
      │
      ▼
   Backend
      │
      │ ciphertext
      ▼
   Browser
      │
      ▼
 descriptografia
      │
      ▼
   plaintext
```

O backend consegue armazenar, mover, servir e remover esses bytes sem precisar interpretá-los como o arquivo original.

---

## Google Drive

A integração com Google Drive separa controle e dados.

```text
                    CONTROL PLANE

Browser ─────────────► Backend ─────────────► Google


                     DATA PLANE

Browser ═══════════ ciphertext ═══════════► Google Drive
```

Para uploads e downloads suportados, os bytes do arquivo trafegam diretamente entre navegador e Google Drive.

O backend continua responsável pelo OAuth e pelas capacidades necessárias para autorizar essas operações.

### Credenciais Google

As credenciais Google **não fazem parte da propriedade Zero-Knowledge do Vault**.

O refresh token é cifrado antes de ser salvo no PostgreSQL, porém o backend possui o segredo necessário para recuperá-lo durante a execução e solicitar novos access tokens.

Essa capacidade permite administrar objetos do provider, mas não fornece diretamente a FDK necessária para transformar os arquivos cifrados em plaintext.

---

## Identidade Está Fora do Vault

Zero-Knowledge não significa anonimato nem desconhecimento da conta pelo servidor.

O backend processa dados como:

* username;
* e-mail;
* senha durante cadastro e login local;
* informações de perfil;
* sessões;
* endereços IP utilizados por mecanismos operacionais;
* identidade Google;
* contas de storage vinculadas.

A senha da conta e a frase de segurança possuem funções diferentes:

```text
Senha da Conta
      │
      ▼
   Backend
      │
      ▼
 Autenticação


Frase de Segurança
      │
      ▼
   Navegador
      │
      ▼
     Vault
```

A imagem de perfil também está fora do modelo criptográfico do Vault e atualmente atravessa o backend antes de ser enviada ao Imgur.

---

## Compartilhamento Público

Public Share cria deliberadamente uma nova entidade capaz de descriptografar um arquivo.

O fluxo atual é restrito ao provider Local.

O proprietário recupera a FDK no navegador e gera um link:

```text
/share/<share-id>#<FDK>
```

A parte depois de `#` é o fragmento da URL.

```text
                Link completo
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
      share-id               FDK
          │                   │
          ▼                   │
       Backend                │
          │                   │
          ▼                   │
      ciphertext ─────────► Browser
                              │
                              ▼
                          plaintext
```

O backend recebe `share-id` e serve o ciphertext.

A FDK é lida do fragmento pelo navegador do destinatário e utilizada localmente para descriptografar o nome e o conteúdo.

O link completo é, portanto, uma **capability de acesso**.

Quem possui o link possui também a chave daquele arquivo.

Revogar o share impede novas requisições através daquele identificador, mas não pode apagar uma chave ou um plaintext que já tenham sido obtidos pelo destinatário.

---

## Arquivo de Recuperação

Durante a inicialização do Vault, o frontend pode gerar:

```text
nanika-recovery.txt
```

Esse arquivo contém a **frase de segurança em plaintext**.

Ele é criado localmente pelo navegador e não é enviado ao backend.

```text
Frase de Segurança
        │
        ▼
     Browser
        │
        ▼
nanika-recovery.txt
        │
        ▼
 armazenamento escolhido
 pelo próprio usuário
```

A partir desse momento, a proteção dessa cópia passa a depender do dispositivo e do local em que o usuário decidir armazená-la.

---

## O que Zero-Knowledge Não Significa

O modelo não implica que o servidor seja incapaz de observar ou controlar qualquer aspecto do sistema.

```text
Zero-Knowledge do Vault
          ≠
servidor sem conhecimento algum
```

Ele não oculta:

* identidade da conta;
* tamanhos;
* timestamps;
* estrutura de diretórios;
* providers;
* padrões de acesso;
* hashes determinísticos;
* existência dos arquivos.

Também não garante disponibilidade.

O backend continua possuindo autoridade para negar operações, remover objetos ou controlar o estado persistente da aplicação.

---

## Confiança no Cliente

O modelo depende do navegador executar o frontend esperado.

```text
Frontend
   │
   ├── vê plaintext
   ├── vê Vault Key
   ├── vê FDKs
   └── executa criptografia
```

Qualquer código executado com autoridade suficiente dentro dessa zona pode acessar os segredos enquanto eles estão em uso.

Por isso, comprometimento do navegador, extensões maliciosas, XSS ou uma versão adulterada do frontend estão fora da proteção fornecida apenas pela criptografia do storage.

Zero-Knowledge protege a separação entre **cliente criptográfico** e **infraestrutura de armazenamento**; ele não cria uma fronteira entre os segredos e o próprio cliente que precisa utilizá-los.

---

## Resumo

A propriedade central pode ser resumida como:

```text
                O servidor precisa saber?

Identidade                  Sim
Estrutura                   Sim
Tamanho                     Sim
Provider                    Sim
Estado operacional          Sim

Conteúdo plaintext          Não
Filename plaintext          Não
FDK plaintext               Não
Vault Key plaintext         Não
Frase de segurança          Não
```

Ou, arquiteturalmente:

```text
       CONHECIMENTO OPERACIONAL
                 │
                 ▼
              Backend


        CONHECIMENTO CRIPTOGRÁFICO
                 │
                 ▼
              Cliente
```

O Nanika não tenta tornar o servidor completamente ignorante sobre a existência e organização dos dados.

O objetivo do modelo Zero-Knowledge é mais específico: **permitir que o serviço administre e armazene os arquivos sem exigir que o servidor receba diretamente as chaves e o plaintext necessários para lê-los.**
