# Deploy no servidor

## Nginx

O frontend Docker publica a porta `6742`. Copie `deploy/nginx/nanika.conf` para `/etc/nginx/sites-available/nanika` e habilite-o:

```bash
sudo ln -s /etc/nginx/sites-available/nanika /etc/nginx/sites-enabled/nanika
sudo nginx -t
sudo systemctl reload nginx
```

O registro `upload.nanika.lvinik.app` deve apontar diretamente para o IP do servidor. Depois, gere o certificado:

```bash
sudo certbot --nginx -d nanika.lvinik.app -d upload.nanika.lvinik.app
```

O Certbot adicionará o bloco HTTPS ao arquivo. Preserve nos blocos HTTP e HTTPS
o default `client_max_body_size 16m` e a location exata
`/backend/folders/batch-create` com `client_max_body_size 64m`. O proxy interno
do frontend aplica os mesmos ceilings e encaminha essa exceção para
`/folders/batch-create` no backend. Apenas o POST dessa rota recebe o budget
de 64 MiB na aplicação; os demais requests continuam com 16 MiB.

Esses ceilings limitam o body HTTP bruto, incluindo framing JSON. O batch
canônico de até 1000 pastas cabe em 64 MiB sem particionar a operação atômica;
os limites semânticos dos campos e o chunk Local de 4 MiB permanecem.
O guard do Crow roda após a materialização do body e impede parsers de negócio
e side effects, sem limitar a alocação inicial do parser. Os dois Nginx são
as barreiras de body anteriores ao Crow no deployment canônico.

O Nginx do host é o único ingress público. O Compose publica o backend em
`127.0.0.1:8080` e o frontend em `127.0.0.1:6742`; não remova o prefixo de
loopback. PostgreSQL permanece somente na rede interna do Compose principal.
Para testes nativos no host, habilite explicitamente o override:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres-db
```

Esse override publica PostgreSQL apenas em `127.0.0.1:5433`; não use um
`docker-compose.override.yml` automático no deployment. O backend só deve usar
`TRUST_PROXY_HEADERS=true` nesse desenho: o Nginx sanitiza `X-Real-IP`, o
`cloudflared` local é o único peer autorizado a fornecer `CF-Connecting-IP`, e
o hostname de upload continua DNS-only para preservar o caminho direto de
upload.
o Nginx sanitiza `X-Real-IP`, o `cloudflared` local é o único peer autorizado
a fornecer `CF-Connecting-IP`, e o hostname de upload continua DNS-only para
preservar o caminho direto de upload.

## Ambiente

Crie o `.env` a partir de `.env.example` e use, no mínimo:

```dotenv
FRONTEND_PORT=6742
PORT=8080
CORS_ORIGIN=https://nanika.lvinik.app
CORS_ALLOWED_ORIGINS=https://nanika.lvinik.app
TRUST_PROXY_HEADERS=true
NANIKA_BIND_ADDRESS=0.0.0.0
```

O Compose de deployment mantém o backend escutando em `0.0.0.0` dentro da rede
Docker; a publicação no host continua restrita a `127.0.0.1:8080`. Para uma
execução nativa do backend no host, use `NANIKA_BIND_ADDRESS=127.0.0.1`.
Valores vazios ou diferentes desses dois endereços são rejeitados antes de o
servidor abrir o socket.

Em desenvolvimento local, mantenha `TRUST_PROXY_HEADERS=false` quando o
backend for acessado diretamente. Essa opção não substitui o fechamento dos
ports públicos.

## Storage Local e identidade do backend

O backend Docker de produção executa como UID/GID numérico `10001:10001`.
Somente `/app/nanika_storage` é a área de dados gravável dentro de `/app`;
binário, configuração e documentação da imagem permanecem fora da escrita do
processo. O caminho persistente não muda:

```text
./nanika_storage -> /app/nanika_storage
```

Em uma instalação Linux nova, crie o diretório antes de subir o Compose:

```bash
sudo install -d -o 10001 -g 10001 -m 0750 ./nanika_storage
```

Para uma instalação existente que foi executada anteriormente como root,
pare o backend e faça somente a transição de ownership, sem copiar, mover,
reescrever ou recriptografar os blobs:

```bash
docker compose stop backend
sudo chown \
  -R \
  --no-dereference \
  10001:10001 \
  ./nanika_storage
sudo chmod 0750 ./nanika_storage
docker compose up -d --build backend
```

O primeiro start após essa mudança deve reconstruir o backend para garantir
que a imagem em execução use a identidade `10001:10001` correspondente ao novo
ownership do storage.

Não use `chmod 777`, não restaure `user: root` no Compose e não substitua o
bind mount por um volume nomeado. O bind mount usa `create_host_path: false`,
portanto um diretório ausente falha em vez de ser criado silenciosamente com
ownership incorreto. Esses comandos de UID/GID são para host Linux; Docker
Desktop no Windows/macOS não deve ser tratado como prova equivalente das
permissões do host Linux.

## Cloudflare Tunnel

Mantenha somente o frontend principal no Tunnel. O hostname de upload deve continuar como registro `A` em modo DNS-only.

```yaml
ingress:
  - hostname: lvinik.app
    service: http://localhost:80
  - hostname: nanika.lvinik.app
    service: http://localhost:80
  - service: http_status:404
```

## Subida

```bash
docker compose up -d --build
docker compose ps
```

O frontend usará `https://upload.nanika.lvinik.app/backend` somente para enviar chunks. As demais requisições continuam em `/backend`.
