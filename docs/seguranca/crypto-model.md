# Modelo Criptográfico

O Nanika utiliza uma hierarquia de chaves para separar a credencial escolhida pelo usuário das chaves que efetivamente protegem os arquivos.

```text
Frase de Segurança
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
        ├───────────────┐
        ▼               ▼
      FDK A           FDK B
        │               │
        ▼               ▼
    Arquivo A       Arquivo B
```

A ideia central é que a frase de segurança não seja usada diretamente para cifrar todos os arquivos.

Ela protege uma **Vault Key aleatória**, e essa Vault Key protege as **File Data Keys — FDKs** individuais.

---

## Primitivas Principais

| Uso                     | Primitiva                      |
| ----------------------- | ------------------------------ |
| Derivação da Master Key | Argon2id                       |
| Cifragem de nomes       | XChaCha20-Poly1305             |
| Wrapping da Vault Key   | XChaCha20-Poly1305             |
| Wrapping das FDKs       | XChaCha20-Poly1305             |
| Conteúdo dos arquivos   | XChaCha20-Poly1305 por chunk   |
| Metadata Kasumi         | XChaCha20-Poly1305             |
| `name_hash`             | BLAKE2b / `crypto_generichash` |
| Aleatoriedade           | Web Crypto + libsodium         |

As chaves utilizadas pelo modelo do Vault possuem 32 bytes.

Os nonces XChaCha20 utilizados pelo Kasumi possuem 24 bytes e cada autenticação produz um MAC de 16 bytes.

---

# Frase de Segurança

A frase de segurança é uma credencial fornecida pelo usuário.

Ela não cifra diretamente os arquivos.

```text
Frase
  │
  ▼
KDF
  │
  ▼
Master Key
```

O salt utilizado pela KDF começa pelo e-mail normalizado:

```text
email
  │
  ▼
trim()
  │
  ▼
lowercase
  │
  ▼
BLAKE2b → 16 bytes
  │
  ▼
salt Argon2id
```

A derivação ocorre em um Web Worker utilizando:

```text
crypto_pwhash(
    output = 32 bytes,
    algorithm = Argon2id13,
    opslimit = INTERACTIVE,
    memlimit = INTERACTIVE
)
```

Assim:

```text
Master Key =
Argon2id(
    Frase de Segurança,
    BLAKE2b16(email normalizado)
)
```

O e-mail não é um segredo e o salt não pretende fornecer confidencialidade.

Sua função é tornar a derivação determinística para a mesma conta e frase.

---

## Master Key

A Master Key existe apenas como resultado da KDF.

```text
Frase
  │
  ▼
Argon2id
  │
  ▼
Master Key de 32 bytes
```

Ela é utilizada para abrir ou criar o wrapping da Vault Key.

Apesar do nome histórico `deriveVaultKey()` utilizado na implementação, o valor produzido por essa função exerce arquiteturalmente o papel de **Master Key**.

A Vault Key real é gerada separadamente com aleatoriedade criptográfica.

---

# Vault Key

Durante o onboarding, o navegador gera uma Vault Key aleatória:

```text
window.crypto.getRandomValues()
             │
             ▼
      Vault Key — 32 bytes
```

Essa chave é independente da frase de segurança.

Para persistir o Vault sem entregar a chave plaintext ao servidor:

```text
Vault Key
   │
   ▼
Base64
   │
   ▼
XChaCha20-Poly1305
   │
   │ Master Key
   ▼
vault_verification
```

O servidor armazena apenas:

```text
vault_verification
```

O formato utilizado pelo wrapping é o mesmo usado para outros valores textuais:

```text
nonce || MAC || ciphertext
```

serializado em Base64 URL-safe.

---

## Unlock

No desbloqueio:

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
vault_verification
  │
  ▼
XChaCha20-Poly1305 decrypt
  │
  ▼
Base64 Vault Key
  │
  ▼
Vault Key
```

Uma frase incorreta produz uma Master Key incapaz de validar o MAC do `vault_verification`.

A autenticação do AEAD funciona, portanto, também como verificação criptográfica da frase.

---

## Troca da Frase

Trocar a frase de segurança não exige recriptografar todos os arquivos.

```text
Vault Key existente
       │
       ├── wrapper antigo
       │      ▲
       │  Master Key antiga
       │
       └── wrapper novo
              ▲
          Master Key nova
```

A mesma Vault Key passa a ser cifrada por uma Master Key derivada da nova frase.

As FDKs e os arquivos permanecem inalterados.

---

# File Data Key — FDK

Cada arquivo possui uma chave aleatória independente.

```text
crypto.getRandomValues()
          │
          ▼
      FDK — 32 bytes
```

A FDK é utilizada para cifrar o conteúdo daquele arquivo.

```text
Arquivo A
   │
   ▼
 FDK A


Arquivo B
   │
   ▼
 FDK B
```

Comprometer uma FDK não fornece diretamente a chave dos outros arquivos.

---

## Wrapping da FDK

A FDK não é persistida plaintext.

Antes de enviar os metadados ao backend:

```text
FDK
 │
 ▼
Base64
 │
 ▼
XChaCha20-Poly1305
 │
 │ Vault Key
 ▼
encrypted_fdk
```

Assim, o banco pode persistir:

```text
encrypted_fdk
```

sem precisar possuir a FDK original.

---

# Nomes de Arquivos e Pastas

Os nomes são cifrados utilizando a Vault Key.

```text
"documento.pdf"
       │
       ▼
XChaCha20-Poly1305
       │
       │ Vault Key
       ▼
 encrypted_name
```

Cada operação gera um nonce aleatório de 24 bytes.

O formato textual é:

```text
Base64URL(
    nonce[24]
    ||
    mac[16]
    ||
    ciphertext
)
```

A descriptografia só é aceita se o MAC for válido.

---

# `name_hash`

Além do nome cifrado, o frontend calcula um identificador determinístico:

```text
filename
   │
   ▼
BLAKE2b
   │
   ▼
32 bytes
   │
   ▼
Base64URL
   │
   ▼
name_hash
```

`name_hash` não utiliza chave.

Ele existe para permitir operações como unicidade e detecção de conflitos sem enviar diretamente o filename plaintext.

Porém:

```text
mesmo nome
    │
    ▼
mesmo name_hash
```

Por isso, `name_hash` não possui as propriedades de confidencialidade do `encrypted_name`.

---

# Formato Kasumi

Os arquivos são cifrados pelo formato interno **Kasumi**.

O conteúdo é dividido em chunks de:

```text
4 MiB
```

Cada chunk é autenticado e cifrado independentemente com XChaCha20-Poly1305.

```text
Arquivo
  │
  ├── Chunk 0
  ├── Chunk 1
  ├── Chunk 2
  └── ...
```

Cada arquivo possui:

```text
FDK única
+
baseNonce único
```

---

# Base Nonce

Na criptografia normal de um novo arquivo:

```text
libsodium randombytes
        │
        ▼
baseNonce — 24 bytes
```

O mesmo `baseNonce` é utilizado como origem para todos os nonces daquele arquivo.

Um nonce específico é derivado para cada chunk.

```text
baseNonce
    +
chunkIndex
    │
    ▼
chunkNonce
```

A implementação copia o `baseNonce` e aplica XOR dos bytes do índice sobre seus últimos 8 bytes.

```text
baseNonce[0..15]
        │
        └── permanece

baseNonce[16..23]
        │
        └── XOR chunkIndex
```

Assim:

```text
Chunk 0 → Nonce 0
Chunk 1 → Nonce 1
Chunk 2 → Nonce 2
...
```

sob a mesma FDK.

---

# Kasumi v1

Quando não existe metadata adicional, o arquivo começa com o header Kasumi v1:

```text
┌─────────────────────────┐
│ baseNonce        24 B   │
├─────────────────────────┤
│ originalSize      8 B   │
├─────────────────────────┤
│ MAC chunk 0      16 B   │
├─────────────────────────┤
│ ciphertext chunk 0      │
├─────────────────────────┤
│ MAC chunk 1      16 B   │
├─────────────────────────┤
│ ciphertext chunk 1      │
├─────────────────────────┤
│ ...                     │
└─────────────────────────┘
```

`originalSize` é armazenado como inteiro de 64 bits little-endian.

---

# Kasumi v2

Quando existe metadata, o formato utiliza um header estendido identificado por:

```text
KAS2
```

O layout é:

```text
┌─────────────────────────┐
│ baseNonce        24 B   │
├─────────────────────────┤
│ originalSize      8 B   │
├─────────────────────────┤
│ "KAS2"            4 B   │
├─────────────────────────┤
│ metadataSize      4 B   │
├─────────────────────────┤
│ metadata MAC     16 B   │
├─────────────────────────┤
│ metadata ciphertext     │
├─────────────────────────┤
│ MAC chunk 0      16 B   │
├─────────────────────────┤
│ ciphertext chunk 0      │
├─────────────────────────┤
│ ...                     │
└─────────────────────────┘
```

A metadata atualmente pode conter informações como thumbnails.

O conteúdo desse bloco é cifrado.

---

## Metadata Kasumi

A metadata possui um nonce reservado:

```text
chunkIndex = 0xFFFFFFFF
```

Assim:

```text
baseNonce
   │
   ├── index 0            → arquivo chunk 0
   ├── index 1            → arquivo chunk 1
   ├── ...
   │
   └── index 0xFFFFFFFF   → metadata
```

A metadata é cifrada e autenticada com a mesma FDK utilizada pelo arquivo.

```text
metadata plaintext
        │
        ▼
XChaCha20-Poly1305
        │
        ▼
MAC + ciphertext
```

---

# Informações Visíveis no Header

O header Kasumi não é completamente cifrado.

São visíveis:

```text
baseNonce
originalSize
```

e, no KAS2:

```text
"KAS2"
metadataSize
```

Portanto, quem possui o blob cifrado consegue observar diretamente o **tamanho original do arquivo**.

```text
Ciphertext
    │
    ▼
Kasumi Header
    │
    └── originalSize
```

O modelo criptográfico não oferece ocultação do tamanho plaintext.

O `baseNonce` também é público por design; sua segurança depende da combinação correta de nonce único com a FDK, não de sua confidencialidade.

---

# Criptografia dos Chunks

Para cada pedaço do arquivo:

```text
plaintext chunk
      │
      ▼
XChaCha20-Poly1305
      │
      ├──► MAC 16 B
      │
      └──► ciphertext
```

O layout persistido é:

```text
MAC || ciphertext
```

A FDK não muda entre chunks.

O que muda é o nonce derivado do índice.

---

## Descriptografia

A leitura segue o caminho inverso:

```text
MAC + ciphertext
        │
        ▼
deriveChunkNonce()
        │
        ▼
XChaCha20-Poly1305
        │
        ├── MAC inválido ─► rejeita
        │
        └── válido ───────► plaintext
```

Cada chunk possui autenticação independente.

Uma alteração no ciphertext ou MAC de um chunk faz a autenticação daquele chunk falhar.

---

# Escopo da Integridade

A unidade criptograficamente autenticada no formato atual é:

```text
metadata
ou
chunk individual
```

O formato não possui um único MAC final cobrindo todo o arquivo.

Além disso, os campos estruturais do header não são fornecidos ao AEAD como **Associated Data**.

```text
Header
   │
   └── sem MAC próprio


Metadata
   │
   └── MAC próprio


Chunk 0
   │
   └── MAC próprio


Chunk 1
   │
   └── MAC próprio
```

Portanto, não deve ser atribuída ao header uma garantia de autenticidade que a implementação atual não fornece.

A autenticação dos chunks protege seus conteúdos individualmente, enquanto validações de tamanho e estrutura complementam o parsing do container.

---

# Tamanho e Truncamento

O tamanho esperado é lido do header:

```text
originalSize
     │
     ▼
expectedSize
```

Durante a descriptografia, o frontend verifica:

* quantidade de bytes disponível;
* tamanho esperado de cada chunk;
* MAC de cada chunk;
* total final descriptografado.

```text
totalDecrypted == expectedSize
```

Essas validações detectam diversas formas de corrupção estrutural.

Elas não equivalem, porém, a um MAC global autenticando o próprio `expectedSize` e a sequência completa do container.

---

# Upload e Transporte

A criptografia dos chunks e os chunks HTTP são conceitos distintos.

Atualmente ambos utilizam capacidade de 4 MiB, mas pertencem a camadas diferentes.

```text
Kasumi
   │
   └── crypto chunks


UploadEngine
   │
   └── transport chunks
```

Primeiro o arquivo inteiro é transformado em um blob Kasumi:

```text
plaintext
   │
   ▼
Kasumi incremental
   │
   ├── frame 0
   ├── frame 1
   └── ...
```

O backend Local recebe os frames cifrados. O mesmo modelo é usado pelo upload
resumable direto ao Google Drive; a memória de ciphertext ativo permanece em
escala de chunk.

---

# Recuperação de Upload Local

Um upload Local parcialmente concluído precisa continuar produzindo o mesmo formato criptográfico.

Quando já existem chunks enviados, o frontend recupera o início do ciphertext pendente e extrai:

```text
baseNonce
metadata
originalSize
```

Depois reutiliza:

```text
mesma FDK
+
mesmo baseNonce
+
mesma metadata
```

para reconstruir o blob.

```text
upload original
      │
      └── baseNonce
             │
             ▼
       upload recovery
```

Esse é um caminho especial.

A criptografia normal de um novo arquivo utiliza sempre um novo `baseNonce`.

---

## Validação do Recovery

Antes de continuar, o frontend compara:

```text
tamanho plaintext
geometria cifrada
quantidade de blocos
```

com o estado persistido do upload pendente.

O protocolo atual realiza uma validação **estrutural**.

Ele não calcula um hash criptográfico do plaintext selecionado para provar que o arquivo escolhido no recovery possui exatamente o mesmo conteúdo do arquivo original.

---

# Public Share

Public Share reutiliza a FDK do arquivo como capability de descriptografia.

Para evitar depender da Vault Key do proprietário, o filename é novamente cifrado, agora com a FDK:

```text
filename
   │
   ▼
XChaCha20-Poly1305
   │
   │ FDK
   ▼
encrypted_name_fdk
```

O destinatário recebe:

```text
/share/<id>#<FDK>
```

e consegue utilizar a FDK para:

```text
FDK
 ├──► decrypt encrypted_name_fdk
 └──► decrypt arquivo Kasumi
```

O conteúdo do arquivo não precisa ser recriptografado para o compartilhamento.

---

# Criptografia Fora do Vault

Nem toda criptografia usada pelo Nanika pertence ao modelo E2EE dos arquivos.

Existem primitivas server-side independentes.

---

## Senha da Conta

A senha utilizada para autenticação é processada pelo backend.

Antes do password hash, o backend aplica um `crypto_generichash` com `PASS_PEPPER` como chave:

```text
password
   │
   ▼
keyed generichash
   │
   │ PASS_PEPPER
   ▼
pre-hash
   │
   ▼
crypto_pwhash_str
   │
   ▼
password_hash
```

A verificação reproduz o pre-hash e utiliza:

```text
crypto_pwhash_str_verify
```

Essa senha pertence ao sistema de autenticação e não à hierarquia:

```text
Master Key
→ Vault Key
→ FDK
```

---

## JWT

Os JWTs são assinados com:

```text
HS256
```

```text
claims
  │
  ▼
HMAC-SHA256
  │
  ▼
JWT assinado
```

Assinatura não significa cifragem.

Os claims do JWT não devem ser tratados como confidenciais apenas por estarem dentro de um token assinado.

O JWT prova integridade e autenticidade da sessão, não confidencialidade do payload.

---

## Refresh Token Google

O refresh token Google é protegido separadamente no backend.

Uma chave simétrica é derivada de:

```text
PASS_PEPPER
     │
     ▼
crypto_generichash
     │
     ▼
key
```

O token é então protegido com:

```text
crypto_secretbox
```

e um nonce aleatório.

A representação persistida é:

```text
Base64(
    nonce
    ||
    ciphertext autenticado
)
```

Essa proteção é server-side.

O backend possui os meios para recuperar o refresh token e utilizá-lo, portanto ela não faz parte do Zero-Knowledge do Vault.

---

# Separação dos Domínios Criptográficos

O sistema possui, portanto, domínios diferentes:

```text
                 CRIPTOGRAFIA DO VAULT

Frase
  ↓
Master Key
  ↓
Vault Key
  ↓
FDKs
  ↓
Arquivos


                 AUTENTICAÇÃO

Password
  ↓
Password Hash

JWT
  ↓
HS256


                 GOOGLE CONTROL PLANE

PASS_PEPPER
  ↓
Server Key
  ↓
Refresh Token
```

Esses mecanismos possuem finalidades diferentes e não devem ser tratados como uma única hierarquia de chaves.

---

# Propriedades do Modelo

O desenho fornece algumas propriedades importantes.

### Separação entre frase e arquivos

```text
Frase
  ↓
Master Key
  ↓
Vault Key
  ↓
FDK
```

Trocar a frase não exige recriptografar todos os arquivos.

---

### Chaves independentes por arquivo

```text
Arquivo A → FDK A
Arquivo B → FDK B
```

Cada arquivo possui seu próprio segredo de conteúdo.

---

### Autenticação criptográfica por chunk

```text
ciphertext alterado
       │
       ▼
MAC inválido
       │
       ▼
rejeição
```

---

### Nonces aleatórios por arquivo

Novas criptografias recebem um `baseNonce` aleatório.

Os nonces dos chunks são derivados desse valor sem exigir armazenamento separado para cada chunk.

---

### Criptografia antes do storage

```text
plaintext
   │
   ▼
Browser
   │
   ▼
ciphertext
   │
   ├──► Local
   └──► Google Drive
```

O provider recebe o formato Kasumi, não o arquivo plaintext.

---

# Limites do Modelo

O modelo criptográfico não tenta fornecer:

* ocultação do tamanho original;
* ocultação de igualdade de `name_hash`;
* autenticação criptográfica do header Kasumi;
* MAC global de todo o container;
* proteção contra comprometimento do navegador enquanto as chaves estão em uso;
* proteção contra uma frase de segurança fraca;
* confidencialidade dos claims de JWT;
* Zero-Knowledge das credenciais Google.

Além disso:

```text
criptografia client-side
        ≠
proteção contra cliente comprometido
```

O navegador é a zona que possui as chaves e o plaintext necessários ao uso do Vault.

---

# Resumo

O núcleo criptográfico do Nanika pode ser representado como:

```text
                         Frase
                           │
                        Argon2id
                           │
                           ▼
                       Master Key
                           │
                 XChaCha20-Poly1305
                           │
                           ▼
                       Vault Key
                           │
                 XChaCha20-Poly1305
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
           FDK A         FDK B         FDK C
             │             │             │
             ▼             ▼             ▼
          Kasumi A      Kasumi B      Kasumi C
```

Cada arquivo é cifrado com uma FDK independente.

Cada FDK é protegida pela Vault Key.

A Vault Key é protegida por uma Master Key derivada da frase.

A frase não é usada diretamente na criptografia dos arquivos.

O conteúdo dos arquivos e a metadata Kasumi são autenticados com XChaCha20-Poly1305, enquanto o header mantém informações estruturais em claro e não possui autenticação própria.

Esse desenho mantém a criptografia do Vault separada tanto do storage quanto dos mecanismos server-side de autenticação e integração com providers.
