# Ciclo de Vida das Chaves

O Nanika mantém o material criptográfico dividido por **níveis de responsabilidade e tempo de vida**.

Uma chave não permanece disponível apenas porque outra chave acima dela ainda existe. Cada operação assume ownership do material necessário e possui seu próprio momento de criação, uso e descarte.

```text
Frase de Segurança
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
   Upload /          Download /
   Storage           Streaming
```

A intenção é manter cada segredo disponível apenas durante o período em que ele é necessário.

---

## Visão Geral

| Material            | Criado / recuperado em         | Tempo de vida principal             |          Persistido plaintext         |
| ------------------- | ------------------------------ | ----------------------------------- | :-----------------------------------: |
| Frase de Segurança  | entrada do usuário             | operação de setup/unlock/change     |            Não pelo Nanika            |
| Master Key          | derivação Argon2id             | uma operação criptográfica          |                  Não                  |
| Vault Key           | onboarding ou unlock           | sessão do Vault desbloqueado        |                  Não                  |
| FDK                 | criação ou abertura de arquivo | operação ou transferência associada |                  Não                  |
| `baseNonce`         | arquivo cifrado                | operação de arquivo/stream          |      faz parte do formato cifrado     |
| Access Token Google | backend / Google               | capability temporária               | não como estado principal persistente |

As representações persistidas são diferentes das chaves plaintext:

```text
Vault Key
   │
   └── cifrada ─► vault_verification

FDK
   │
   └── cifrada ─► encrypted_fdk
```

---

# Frase de Segurança

A frase de segurança entra no sistema pelo navegador.

Ela participa de três operações principais:

```text
Onboarding
   │
   └──► deriva Master Key

Unlock
   │
   └──► deriva Master Key

Troca de frase
   │
   ├──► deriva Master Key antiga
   └──► deriva Master Key nova
```

A frase não é enviada ao backend pelos fluxos do Vault.

---

## Onboarding

Durante a criação do Vault:

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
cifra Vault Key
```

Depois da inicialização, o componente limpa os campos utilizados pela interface.

O frontend também pode criar um arquivo de recuperação contendo a frase:

```text
Frase
  │
  ▼
nanika-recovery.txt
```

Esse arquivo é criado localmente e passa a possuir lifecycle independente do aplicativo.

---

## Limitação de Strings

A frase é representada por `string` no JavaScript.

A aplicação pode remover suas próprias referências:

```text
phrase = ''
```

mas isso não equivale a sobrescrever deterministicamente os bytes anteriormente utilizados pelo runtime JavaScript.

Por isso, as garantias de zeroization mais fortes do Nanika são aplicadas principalmente ao material representado por buffers mutáveis como `Uint8Array`.

---

# Master Key

A Master Key é derivada da frase de segurança com Argon2id.

Ela é deliberadamente **transitória**.

```text
Frase
  │
  ▼
Argon2id
  │
  ▼
Master Key
  │
  ├── usa
  ▼
operação concluída
  │
  ▼
fill(0)
```

Ela não é armazenada como propriedade persistente de `CryptoService`.

---

## Unlock

No desbloqueio:

```text
derive Master Key
       │
       ▼
GET vault_verification
       │
       ▼
decrypt
       │
       ▼
obtém Vault Key
       │
       ▼
Master Key.fill(0)
```

A Master Key é apagada assim que termina seu último uso necessário.

O `finally` também cobre falhas e cancelamentos.

---

## Troca da Frase de Segurança

Trocar a frase não gera uma nova Vault Key.

O processo altera apenas seu wrapping:

```text
Frase antiga
     │
     ▼
Master Key antiga
     │
     ▼
verifica Vault Key
     │
     ▼
wipe


Frase nova
     │
     ▼
Master Key nova
     │
     ▼
cifra a mesma Vault Key
     │
     ▼
wipe
```

A Master Key antiga é eliminada antes da derivação da nova.

A Master Key nova é eliminada depois de produzir o novo `vault_verification`.

---

# Vault Key

A Vault Key é uma chave aleatória de 32 bytes criada durante o onboarding.

```text
crypto.getRandomValues()
          │
          ▼
      Vault Key
```

Ela possui dois estados diferentes.

### Persistência

A Vault Key plaintext não é persistida.

O servidor recebe somente:

```text
Vault Key
   │
   ▼
encrypt(Master Key)
   │
   ▼
vault_verification
   │
   ▼
Backend / PostgreSQL
```

### Runtime

Quando o Vault está desbloqueado:

```text
CryptoService
     │
     └── vaultKey: Uint8Array
```

essa é a chave raiz disponível para abrir as FDKs dos arquivos.

---

## Lock

Trancar o Vault elimina a referência ativa:

```text
Vault Key
   │
   ▼
fill(0)
   │
   ▼
null
   │
   ▼
Locked
```

O lock também invalida tentativas de desbloqueio ainda em andamento.

```text
unlock A
   │
   │ KDF pendente
   │
lock
   │
   ▼
generation++
   │
   ▼
resultado antigo rejeitado
```

Uma operação antiga não pode publicar uma nova Vault Key depois que um lock venceu a corrida.

---

## Lock manual e apresentação decifrada

`Lock manual do Vault` **não é** `Logout`.

O lock manual encerra a disponibilidade da Vault Key e a apresentação decifrada
que pertence à sessão, mas não encerra automaticamente operações que já
assumiram ownership próprio:

```text
Lock manual
   │
   ├── Vault Key                         → wipe/release
   ├── DriveStore (árvore, lixeira)     → invalida e limpa
   ├── ComputerStore (arquivos, paths,  → invalida e limpa
   │   previews e histórico)
   ├── cache de thumbnails               → invalida e limpa
   ├── player de imagem/vídeo             → destruição pelo owner
   ├── diálogo ativo                      → cancelamento
   ├── Share Modal                        → destruição + generation guard
   ├── downloads                          → reset do runtime
   ├── rótulos do Storage Move            → redaction
   ├── execução do Storage Move           → continua
   ├── runtime de upload                  → continua
   └── sessão de autenticação/JWT         → continua
```

O `DriveStore` mantém uma geração específica para a apresentação decifrada.
Uma leitura de árvore, lixeira ou redecifragem captura a geração na entrada;
se o lock incrementar essa geração antes do retorno assíncrono, a continuação
antiga não pode publicar nomes decifrados ou atualizar a apresentação.

As pendências de upload usam duas autoridades separadas: a geração do runtime
de upload controla a continuidade da recuperação, enquanto a geração de
apresentação controla apenas a publicação do nome decifrado. Por isso, um lock
que atravesse a decifragem preserva a linha de recovery, seu `pendingData`,
status e progresso, mas exibe `Arquivo Desconhecido` até que um novo unlock
permita a redecifragem. O logout invalida também a geração do runtime e remove
essa linha de apresentação.

O estado `isRecovery` descreve a fase operacional da recuperação, não a origem
do rótulo apresentado. Enquanto `pendingData.encrypted_name` permanecer
associado ao transfer, o `fileName` derivado dessa metadata continua pertencendo
à apresentação decifrada, inclusive depois que a recuperação termina. Por isso,
o lock manual redige esse rótulo mesmo quando `isRecovery` é `false`, sem
remover o transfer nem seu `pendingData`.

O `ComputerStore` reutiliza a identidade de request existente para invalidar
continuações antigas de provider. O clear síncrono remove arquivos, previews,
`folderPath` e histórico de navegação. Os targets de provider/account são
metadados de seleção e permanecem preservados por padrão.

O reset de downloads é uma fronteira separada: ele impede que uma operação de
download publique plaintext depois do lock. Em contraste, o upload não é
terminado pelo lock manual; sua FDK continua sob ownership do runtime de
upload até sucesso, erro terminal ou cancelamento. Logout possui uma boundary
mais ampla e aplica o teardown de sessão documentado adiante.

Essas invalidações impedem nova publicação na apresentação. Elas não afirmam
apagamento físico garantido de toda cópia que o runtime JavaScript ou o
navegador possa ter criado.

---

## Novo Unlock

Se um unlock bem-sucedido substituir uma Vault Key já presente:

```text
Vault Key antiga
      │
      ▼
nova candidata validada
      │
      ├──► nova Vault Key torna-se ativa
      │
      └──► antiga.fill(0)
```

A candidata não é publicada como chave ativa antes da validação completa.

---

# FDK

Cada arquivo possui sua própria **File Data Key**.

```text
Arquivo A ─► FDK A
Arquivo B ─► FDK B
Arquivo C ─► FDK C
```

A FDK é usada para criptografar o conteúdo e os metadados criptográficos associados àquele arquivo.

Persistida, ela aparece somente em forma cifrada:

```text
FDK
 │
 ▼
encrypt(Vault Key)
 │
 ▼
encrypted_fdk
```

Quando uma operação precisa abrir o arquivo:

```text
encrypted_fdk
      │
      ▼
Vault Key
      │
      ▼
FDK plaintext
```

A partir desse momento, a cópia criada passa a pertencer ao lifecycle daquela operação.

---

# FDK de Upload

Um novo upload gera uma FDK aleatória antes da criptografia do arquivo.

```text
UploadPlan
     │
     ▼
random FDK
     │
     ├──► encrypted_fdk
     │
     └──► encryptFileParts()
              │
              ▼
       frames de transporte
```

Depois do planejamento, a FDK é mantida junto ao runtime do upload.

```text
LocalUploadPlan / GoogleUploadPlan
│
├── encryptedName
├── encryptedFdk
├── fdk
├── baseNonce
└── rematerializationMetadata opcional
```

---

## Upload Ativo

Enquanto a transferência pode continuar, sua FDK continua disponível.

```text
processing
    │
    ├── pause ─────► paused
    │                 │
    │                 └── resume
    │
    └──────────────► processing
```

Uma pausa não é um estado terminal.

A FDK precisa continuar disponível para permitir a retomada da operação atual.

---

## Terminal

Quando o upload chega a um estado terminal:

```text
success
error
cancelled
```

o runtime correspondente é liberado.

```text
UploadPlan.fdk
       │
       ▼
    fill(0)
       │
       ▼
activeUploads.delete()
```

Cancelamentos também zeram a FDK antes da remoção da operação.

---

## Falha Durante a Preparação

Se o planejamento for cancelado através de `AbortSignal`, a FDK local é explicitamente zerada.

```text
planUpload
     │
     ├── abort
     │     │
     │     ▼
     │  fdk.fill(0)
     │
     └── sucesso
           │
           ▼
     ownership transferido
```

O upload ativo não retém um ciphertext inteiro: `encryptFileParts()` produz
frames sob demanda. Em um cancelamento ambíguo de PUT Google, a FDK é zerada e
o backend recebe somente a solicitação de limpeza do estado persistente.

---

# Lock e Uploads Ativos

A Vault Key e a FDK de uma transferência possuem owners diferentes.

Depois que uma FDK já foi recuperada ou gerada por um upload, a operação não depende mais da Vault Key para possuir aquela cópia.

Por isso:

```text
Vault Key
   │
  lock
   │
   ▼
 wipe


FDK de upload ativo
   │
   └── continua sob ownership da transferência
```

Trancar o Vault **não cancela automaticamente uploads já iniciados**.

A FDK da transferência permanece até:

* conclusão;
* erro terminal;
* cancelamento;
* cleanup correspondente.

Isso evita misturar o lifecycle do Vault com o lifecycle de uma operação que já assumiu sua própria chave.

## Uploads Durante Logout

Logout e cancelamento explícito de uma transferência são operações diferentes.
O logout desanexa a sessão do runtime de uploads; ele não chama
`cancelTransfer()` para cada item e não inicia, por esse motivo, limpeza remota,
trash ou hard delete.

O `DriveStore.resetUploadRuntimeState()` executa a fronteira local de teardown:

```text
logout
   │
   ├── incrementa a geração do runtime
   ├── aborta controllers de uploads e grupos
   ├── zera FDKs dos runtimes ativos pertencentes ao DriveStore
   ├── libera mapas e referências do runtime
   ├── remove as linhas de apresentação dos uploads
   └── invalida continuations da geração anterior
```

Uma continuação assíncrona pertencente à geração anterior não pode publicar
progresso, resultado, nome decifrado de pendência ou recapturar a lista de
uploads depois do logout. Isso é uma barreira de publicação e não uma garantia
de interrupção instantânea de toda promessa JavaScript já iniciada.

Antes da transferência de ownership para o executor, planos ainda em
preparação são descartados pelo owner da preparação. Depois da transferência,
o runtime ativo do `DriveStore` é o owner da FDK e a zera durante o teardown.

Uma limpeza remota iniciada anteriormente por cancelamento explícito pode
terminar, porque esse cleanup pertence à ação do usuário que já ocorreu. O
logout não cria uma nova limpeza remota. Uma operação pendente no backend pode
permanecer disponível para recuperação posterior.

O `fill(0)` cobre os buffers `Uint8Array` mantidos por esses owners. Ele não
representa apagamento físico garantido de cópias internas do JavaScript, nem
implica que strings ou cópias internas do runtime possam ser zeradas pela
aplicação.

---

# FDK de Download

Um download recupera a FDK cifrada e cria uma cópia própria em memória.

```text
encrypted_fdk
     │
     ▼
decrypt com Vault Key
     │
     ▼
FDK do Download
```

O estado ativo possui:

```text
DownloadState
│
├── FDK
│
├── controller
│
└── estado específico do provider
```

No provider Local, também inclui:

```text
baseNonce
plaintextChunks
offsets
```

---

## Finalização do Download

Ao terminar:

```text
download
   │
   ▼
arquivo entregue
   │
   ▼
deleteState()
   │
   ▼
wipeState()
```

`wipeState()`:

```text
FDK.fill(0)

Local:
    baseNonce.fill(0)
    plaintextChunks.length = 0
```

---

## Cancelamento

O cancelamento aborta primeiro a operação de rede e depois elimina o estado:

```text
cancel()
   │
   ├── AbortController.abort()
   │
   ├── FDK.fill(0)
   │
   ├── baseNonce.fill(0)
   │
   └── delete state
```

Um logout também chama o reset global dos downloads ativos.

---

# Thumbnails

A geração de thumbnails cria uma FDK apenas para a operação corrente.

```text
encrypted_fdk
      │
      ▼
decrypt
      │
      ▼
FDK temporária
      │
      ▼
metadata / thumbnail
      │
      ▼
finally
      │
      ▼
fill(0)
```

Mesmo quando:

* a metadata não existe;
* a geração é invalidada;
* ocorre erro;
* acontece retry;

a FDK temporária passa pelo `finally`.

---

# Streaming de Vídeo

O streaming possui um lifecycle criptográfico independente.

A inicialização obtém uma FDK própria e extrai o `baseNonce` necessário ao processamento dos chunks.

```text
FDK
 │
 ├──────────► Crypto Worker
 │
baseNonce
 │
 ▼
StreamState
```

A sessão mantém esses valores enquanto o vídeo está ativo.

---

## Teardown do Stream

Ao fechar ou substituir o vídeo:

```text
destroyStream()
      │
      ▼
invalidate initialization
      │
      ▼
abort requests
      │
      ▼
terminate workers
      │
      ▼
remove MediaSource
      │
      ▼
FDK.fill(0)
baseNonce.fill(0)
      │
      ▼
release state
```

O teardown também elimina:

* requests ativos;
* timers;
* listeners;
* workers;
* `SourceBuffer`s;
* Object URLs;
* access token Google mantido pelo stream.

---

## Falha Durante Inicialização

Se uma inicialização falhar antes de publicar um `StreamState`, os recursos candidatos também passam por cleanup:

```text
FDK candidata ──────► fill(0)
baseNonce candidato ─► fill(0)
workers ─────────────► terminate()
```

Assim, uma inicialização incompleta não precisa esperar a criação de um estado ativo para liberar o material criptográfico que já havia adquirido.

---

# `baseNonce`

`baseNonce` não é uma chave secreta, mas participa do estado necessário para derivar os nonces utilizados nos chunks do arquivo.

```text
baseNonce
    +
chunk index
    │
    ▼
chunk nonce
```

Ele faz parte do formato do ciphertext e pode ser recuperado do arquivo armazenado.

Mesmo não sendo tratado como uma chave secreta, as operações que mantêm uma cópia mutável em runtime a zeram junto com a FDK para evitar reutilização acidental ou sobrevivência de estado criptográfico obsoleto.

---

# Public Share

Public Share altera o lifecycle da FDK porque o destinatário não possui a Vault Key original.

O proprietário gera:

```text
/share/<share-id>#<FDK>
```

No navegador destinatário:

```text
URL fragment
    │
    ▼
decode
    │
    ▼
FDK
    │
    ├── decrypt filename
    ├── decrypt file
    └── streaming
```

A FDK passa a representar a capability daquele compartilhamento.

---

## Streaming Público

Quando uma FDK de Public Share é entregue ao pipeline de vídeo, o stream cria sua própria cópia:

```text
Share FDK
    │
    ▼
slice()
    │
    ▼
Stream FDK
```

O teardown do stream zera essa cópia independentemente da FDK mantida pela página pública.

---

## Lifecycle da FDK Principal do Share

`SharedFileComponent` mantém:

```text
fdkUint8: Uint8Array | null
```

durante a vida da página.

O fragmento é aceito somente quando representa uma FDK canônica de 32 bytes.
Depois que os metadados são obtidos, o componente cria uma cópia temporária para
descriptografar o nome e a zera em `finally`. O estado descriptografado só é
publicado depois dessa operação e de uma nova verificação do lifecycle.

A FDK raiz é utilizada para:

* descriptografar o nome;
* alimentar visualizações públicas.

O componente possui teardown próprio: aborta trabalho pendente, remove a
referência do campo e executa:

```text
fdkUint8.fill(0)
```

O `PublicMediaPlayerComponent` recebe a referência da página apenas na fronteira
de entrada e cria uma cópia própria antes de iniciar seu trabalho. Cada operação
de thumbnail, imagem ou download cria outra cópia curta, zerada em `finally`.
Quando o player é destruído ou fechado, ele aborta o trabalho, encerra o stream,
limpa seus recursos e zera sua FDK própria.

No caminho de vídeo, o `DriveFile` público referencia a FDK pertencente ao player;
o `VideoStreamService` continua criando e zerando a cópia própria do stream.

---

# Logout

Logout é uma boundary mais ampla que apenas trancar o Vault.

O frontend executa:

```text
logout
  │
  ├── JWT = null
  │
  ├── reset Storage Move runtime
  │
  ├── reset uploads
  │       │
  │       ├── incrementa a geração do runtime
  │       ├── aborta controllers
  │       ├── zera FDKs sob ownership do DriveStore
  │       └── remove continuations e linhas de upload
  │
  ├── reset downloads
  │
  ├── lockVault()
  │       │
  │       └── Vault Key.fill(0)
  │
  ├── estado → Unauthenticated
  │
  └── request de logout ao backend
```

O mesmo cleanup local ocorre no logout global.

---

# Zeroization

O padrão utilizado para buffers criptográficos mutáveis é:

```text
Uint8Array.fill(0)
```

seguido da remoção da referência quando aplicável:

```text
key.fill(0)
key = null
```

Esse padrão aparece em diferentes owners:

```text
Master Key       → operação criptográfica
Vault Key        → CryptoService
Upload FDK       → upload runtime
Download FDK     → DownloadEngine
Thumbnail FDK    → ThumbnailLoader
Stream FDK       → VideoStream
baseNonce        → download / stream
```

A remoção da referência e a sobrescrita são tratadas como operações diferentes.

```text
fill(0)
   ↓
reduz lifetime útil dos bytes

null / delete
   ↓
remove ownership da aplicação
```

---

## Limites da Zeroization em JavaScript

A aplicação controla seus próprios buffers, mas não controla toda a memória interna do navegador.

Operações como:

* serialização;
* `atob` / `btoa`;
* strings intermediárias;
* cópias internas de APIs;
* buffers criados pelo runtime;

podem produzir representações que a aplicação não consegue sobrescrever diretamente.

Por isso:

```text
zeroization explícita
        ≠
prova de ausência física de qualquer cópia na memória
```

Ela representa uma redução deliberada do lifetime das cópias mutáveis que permanecem sob controle direto da aplicação.

---

# Matriz de Lifecycle

| Material                      | Owner principal       | Termina normalmente em          |      Wipe explícito     |
| ----------------------------- | --------------------- | ------------------------------- | :---------------------: |
| Master Key                    | operação de Vault     | após decrypt/encrypt necessário |           Sim           |
| Vault Key                     | `CryptoService`       | lock / logout / substituição    |           Sim           |
| FDK de upload                 | runtime do upload     | success/error/cancel/logout/session reset |     Sim           |
| FDK de download               | `DownloadEngine`      | success/cancel/reset/manual lock |           Sim           |
| FDK de thumbnail              | `ThumbnailLoader`     | fim da tentativa/prune/manual lock |           Sim           |
| FDK de stream                 | `VideoStreamService`  | destroy/failure/manual lock pelo player |           Sim           |
| `baseNonce` de download       | `DownloadEngine`      | fim/cancel/reset/manual lock    |           Sim           |
| `baseNonce` de stream         | `VideoStreamService`  | destroy/failure/manual lock pelo player |           Sim           |
| FDK principal de Public Share | `SharedFileComponent` | destruição da página            |           Sim           |
| Frase em campos da UI         | componente            | conclusão da operação           |     referência limpa    |
| Recovery file                 | usuário / filesystem  | definido externamente           | Não controlado pelo app |

---

# Resumo

O ciclo de vida das chaves do Nanika segue principalmente o princípio:

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
transferir ownership, se necessário
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

A chave de maior duração é a **Vault Key**, que permanece enquanto o Vault está desbloqueado.

As **Master Keys** são transitórias.

As **FDKs** possuem lifecycle independente por operação e podem continuar existindo depois de um lock quando já foram entregues a uma transferência ativa.

Downloads, thumbnails e streaming possuem cleanup explícito de suas cópias.

Uploads zeram a FDK ao atingir estado terminal ou cancelamento.

Public Share entrega deliberadamente uma FDK ao navegador destinatário. A página,
o player, cada operação criptográfica e o stream possuem owners distintos quando
mantêm cópias mutáveis, com teardown explícito para as cópias sob controle desses
owners.

O objetivo geral é evitar que o material criptográfico permaneça acessível por mais tempo do que o owner que realmente precisa dele.
