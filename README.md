# cc-deploy-listener

Webhook de **deploy continuo** del ecosistema Dotrino. Un servicio chico (Node
stdlib, sin dependencias) que corre en cada host, escucha webhooks `push` de GitHub
y, por cada repo configurado, hace un deploy idempotente:

```
git fetch origin <branch> && git reset --hard origin/<branch>
[npm ci]                          # opcional
sudo -n systemctl restart <unit>  # NOPASSWD para ese unit
[curl <healthUrl>]                # opcional, solo log
```

Elegido por encima de GitHub Actions+SSH porque **no expone ninguna clave SSH ni
secreto que alcance producción en GitHub**: la única superficie es un endpoint
HTTPS con un secreto HMAC compartido. El deploy lo ejecuta el propio host sobre su
checkout local.

## Diseño

- **Un listener por host**, con su `deploy.config.json` (no versionado) que mapea
  `owner/repo → { dir, branch, unit, npm, healthUrl }`. Un mismo repo puede
  desplegarse en varios hosts (cada uno con su config): p.ej. `simple-websocket-proxy`
  se despliega como `cc-proxy` en proxy1 y `cc-proxy2` en proxy2.
- Valida `X-Hub-Signature-256` (HMAC-SHA256 del cuerpo crudo) antes de hacer nada.
- Sólo actúa ante `push` a la rama configurada del repo configurado; todo lo demás
  responde 202/204 e ignora.
- **Serializa** los deploys (cola) para que dos webhooks no colisionen.
- Corre como `seyacat` (git/npm con el dueño correcto). Restart por **systemd**
  (`unit`, requiere **sudoers NOPASSWD** sólo para `systemctl restart <unit>`) o
  por **pm2** (`pm2`, sin sudo). Un repo declara uno u otro.
- Carga **nvm** explícitamente antes de cada comando (npm/pm2), porque el
  `~/.bashrc` de muchos hosts no deja node en el PATH de shells no-interactivos.
- `SIGHUP` recarga la config sin reiniciar.

## Instalar en un host

```bash
git clone https://github.com/imdotrino/dotrino-deploy-listener.git ~/cc-deploy-listener
cd ~/cc-deploy-listener
cp deploy.config.proxy1.example.json deploy.config.json   # o proxy2
# editá deploy.config.json: poné un `secret` fuerte y ajustá dir/branch/unit
bash install.sh            # valida, genera el unit, e imprime los pasos sudo
```

`install.sh` no toca producción; imprime los comandos `sudo` para que los corras
vos (instalar el unit, el sudoers, habilitar el servicio, y el location de nginx).

### nginx

Agregá `nginx.example.conf` (location `/hooks/deploy` → `127.0.0.1:9099`) al
`server{}` del dominio del host y recargá nginx. El webhook quedará en
`https://<dominio>/hooks/deploy`.

### sudoers

Copiá `sudoers.example` a `/etc/sudoers.d/cc-deploy` y dejá sólo los units de ese
host. Validá con `sudo visudo -cf /etc/sudoers.d/cc-deploy`.

## Configurar el webhook en GitHub

Por cada repo que despliega el host (con la cuenta `dotrino`):

```bash
gh api -X POST repos/imdotrino/dotrino-proxy/hooks \
  -f name=web -F active=true -f 'events[]=push' \
  -f config[url]=https://proxy.dotrino.com/hooks/deploy \
  -f config[content_type]=json \
  -f config[secret]='<EL_MISMO_SECRET_DE_LA_CONFIG>'
```

Si un repo se despliega en **dos** hosts (caso `simple-websocket-proxy` → proxy1 y
proxy2), creá **dos** webhooks en ese repo, uno por `config[url]` de cada host
(pueden compartir o no el secret; cada host valida con el suyo).

Probá con: Settings → Webhooks → Recent Deliveries → Redeliver, o un push real.
El listener responde `200 {pong:true}` al ping y `202 {queued:true}` al push.

## Estado de los servicios (jun 2026)

| Servicio | Host | Repo | Restart | Listo para CD |
|---|---|---|---|---|
| proxy | proxy.dotrino.com | imdotrino/dotrino-proxy (main) | pm2 `cc-proxy` | ✅ |
| proxy2 | proxy2.dotrino.com | imdotrino/dotrino-proxy (main) | pm2 `cc-proxy2` | ✅ |
| signer | proxy.dotrino.com | imdotrino/dotrino-signer (main) | pm2 `dotrino-signer` | ✅ |
| geo | proxy2.dotrino.com | imdotrino/dotrino-geo | systemd `dotrino-geo` | ⚠️ `~/dotrino-geo` no es checkout git |
| reputation | proxy2.dotrino.com | imdotrino/dotrino-reputation | systemd `dotrino-reputation` | ⚠️ idem geo |

Todos los servicios en CD hoy corren bajo **PM2** → el listener reinicia con `pm2
restart` (sin sudo). geo/reputation siguen en systemd y aún no están en CD; al
sumarlos conviene migrarlos también a pm2 para no reintroducir sudo.

**Normalización pendiente** para los ⚠️: volver el directorio un checkout git del
repo (`git init` + `remote add` + `fetch` + `reset --hard`, o re-clonar) y, para el
signer, crear su `cc-signer.service`. Una vez normalizados, basta poner su `unit`
en la config y crear el webhook.
