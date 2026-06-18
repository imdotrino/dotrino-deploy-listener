#!/usr/bin/env bash
# Instalador idempotente del listener en un host. Corré desde el repo clonado:
#   bash install.sh
# Requiere: tener deploy.config.json ya editado (con secret real) en este dir.
# Los pasos con sudo se imprimen al final para que los corras vos (no embebemos
# la contraseña). No reinicia nada de producción.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || echo /home/seyacat/.nvm/versions/node/v24.15.0/bin/node)"

if [[ ! -f "$DIR/deploy.config.json" ]]; then
  echo "❌ Falta $DIR/deploy.config.json — copiá un deploy.config.*.example.json y editá el secret."
  exit 1
fi

mkdir -p "$HOME/cc-deploy"

# Validar config (parsea JSON y arranca-cierra)
echo "🔎 Validando config…"
CC_DEPLOY_CONFIG="$DIR/deploy.config.json" "$NODE_BIN" -e '
  const c=require(process.env.CC_DEPLOY_CONFIG);
  if(!c.secret||c.secret==="CHANGE_ME")throw new Error("secret sin cambiar");
  if(!c.repos||!Object.keys(c.repos).length)throw new Error("sin repos");
  console.log("   ok — repos:",Object.keys(c.repos).join(", "));
'

# Generar el unit con la ruta de node y del repo reales
UNIT_OUT="$DIR/cc-deploy.generated.service"
sed -e "s#/home/seyacat/cc-deploy-listener#$DIR#g" \
    -e "s#/home/seyacat/.nvm/versions/node/v24.15.0/bin/node#$NODE_BIN#g" \
    "$DIR/cc-deploy.service" > "$UNIT_OUT"

echo
echo "✅ Listo el unit generado: $UNIT_OUT"
echo
echo "Ahora corré estos pasos con sudo (revisá la lista de units en sudoers.example):"
echo "  sudo cp $UNIT_OUT /etc/systemd/system/cc-deploy.service"
echo "  sudo cp $DIR/sudoers.example /etc/sudoers.d/cc-deploy   # editá los units por host"
echo "  sudo visudo -cf /etc/sudoers.d/cc-deploy                # validar sintaxis"
echo "  sudo systemctl daemon-reload && sudo systemctl enable --now cc-deploy"
echo "  systemctl status cc-deploy --no-pager"
echo
echo "Y agregá el location de nginx.example.conf al server{} del dominio + reload nginx."
