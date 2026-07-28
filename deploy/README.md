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

O Certbot adicionará o bloco HTTPS ao arquivo. Mantenha `client_max_body_size 16m` nos blocos HTTPS.

## Ambiente

Crie o `.env` a partir de `.env.example` e use, no mínimo:

```dotenv
FRONTEND_PORT=6742
PORT=8080
CORS_ORIGIN=https://nanika.lvinik.app
CORS_ALLOWED_ORIGINS=https://nanika.lvinik.app
```

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
