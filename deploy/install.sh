#!/usr/bin/env bash
# ================================================================
#  ВЕЧЕ · установка на чистый сервер Ubuntu/Debian одной командой
# ----------------------------------------------------------------
#  curl -fsSL https://raw.githubusercontent.com/romashka5911anton-cmyk/veche/main/deploy/install.sh | sudo bash
#
#  Что делает:
#   1. ставит Node.js 22, git, nginx, certbot
#   2. скачивает ВЕЧЕ в /opt/veche, данные хранит в /var/lib/veche
#   3. запускает ВЕЧЕ как службу systemd (сама поднимется после перезагрузки)
#   4. настраивает nginx и бесплатный HTTPS-сертификат Let's Encrypt
#
#  Настройки (необязательно), передаются переменными окружения:
#   DOMAIN=chat.example.org   свой домен; по умолчанию — <ip>.sslip.io (работает без покупки домена)
#   BRANCH=main               ветка репозитория
#   EMAIL=me@example.org      почта для Let's Encrypt (напоминания об истечении сертификата)
#  Пример: curl -fsSL …/install.sh | sudo DOMAIN=chat.example.org bash
#
#  Повторный запуск безопасен: обновит код и перезапустит службу, данные не трогает.
# ================================================================
set -euo pipefail

REPO="${REPO:-https://github.com/romashka5911anton-cmyk/veche.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/veche
DATA_DIR=/var/lib/veche
PORT="${PORT:-4040}"

say()  { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите через sudo:  curl -fsSL … | sudo bash"
command -v apt-get >/dev/null || die "Нужен Ubuntu или Debian (apt-get)."
export DEBIAN_FRONTEND=noninteractive

say "Ставлю системные пакеты"
apt-get update -qq
apt-get install -y -qq curl ca-certificates git nginx certbot python3-certbot-nginx >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  say "Ставлю Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

say "Скачиваю ВЕЧЕ (ветка $BRANCH)"
id veche >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin veche
mkdir -p "$DATA_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR" || die "Не удалось скачать код. Если репозиторий приватный — сделайте его публичным или скачайте код вручную в $APP_DIR."
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R veche:veche "$DATA_DIR"

# настройки службы: создаём один раз, дальше правятся руками (TURN, ключи Алисы и т.п.)
if [ ! -f /etc/veche.env ]; then
  cat > /etc/veche.env <<EOF
PORT=$PORT
DATA_DIR=$DATA_DIR
# Администраторы (ники через запятую). Пусто — админом станет первый зарегистрировавшийся.
# ADMINS=
# Звонки через NAT (coturn):
# TURN_HOST=
# TURN_SECRET=
# ИИ-ассистент «Алиса» (YandexGPT):
# YANDEX_API_KEY=
# YANDEX_FOLDER_ID=
EOF
  chmod 600 /etc/veche.env
fi

say "Запускаю службу veche"
cat > /etc/systemd/system/veche.service <<EOF
[Unit]
Description=VECHE messenger
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=veche
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/veche.env
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3
# немного изоляции: служба пишет только в папку данных
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q veche
systemctl restart veche
sleep 2
systemctl is-active -q veche || { journalctl -u veche -n 30 --no-pager; die "Служба не запустилась (лог выше)."; }

# домен: свой или бесплатный <ip>.sslip.io (указывает на этот же IP)
if [ -z "${DOMAIN:-}" ]; then
  IP="$(curl -fsS4 --max-time 8 https://ifconfig.me || curl -fsS4 --max-time 8 https://api.ipify.org || true)"
  [ -n "$IP" ] || die "Не удалось узнать внешний IP. Запустите с DOMAIN=ваш.домен"
  DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi

say "Настраиваю nginx для $DOMAIN"
cat > /etc/nginx/sites-available/veche <<EOF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 45m;   # файлы до 40 МБ

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;          # WebSocket
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/veche /etc/nginx/sites-enabled/veche
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
systemctl reload nginx

say "Выпускаю HTTPS-сертификат"
if [ -n "${EMAIL:-}" ]; then CERT_MAIL=(--email "$EMAIL"); else CERT_MAIL=(--register-unsafely-without-email); fi
if certbot certificates 2>/dev/null | grep -q "Domains: .*$DOMAIN"; then
  echo "Сертификат для $DOMAIN уже есть."
  URL="https://$DOMAIN"
elif certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${CERT_MAIL[@]}" >/tmp/veche-certbot.log 2>&1; then
  URL="https://$DOMAIN"
else
  warn "HTTPS не получился (лог: /tmp/veche-certbot.log). Частая причина — закрыты порты 80/443"
  warn "в группе безопасности облака. Откройте их и запустите скрипт ещё раз."
  URL="http://$DOMAIN"
fi

cat <<EOF

  ⬡ ВЕЧЕ работает ⬡

  Адрес:        $URL
  Первый, кто зарегистрируется, станет администратором — зарегистрируйтесь сразу.

  Обновить:     curl -fsSL https://raw.githubusercontent.com/romashka5911anton-cmyk/veche/$BRANCH/deploy/install.sh | sudo BRANCH=$BRANCH bash
  Логи:         sudo journalctl -u veche -f
  Перезапуск:   sudo systemctl restart veche
  Настройки:    sudo nano /etc/veche.env   (после правки — перезапуск)
  Данные:       $DATA_DIR  (бэкап — просто скопировать папку)

EOF
