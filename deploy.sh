#!/bin/bash
# Hetzner sunucusuna otomatik kurulum scripti
# Kullanım: bash deploy.sh SUNUCU_IP

set -e

IP=$1
if [ -z "$IP" ]; then
  echo "Kullanım: bash deploy.sh SUNUCU_IP"
  exit 1
fi

APP_DIR="/opt/sesapp"
APP_PASSWORD=${PASSWORD:-$(cat /dev/urandom | tr -dc 'A-Z0-9' | head -c 8)}

echo "🚀 SesApp → $IP adresine kuruluyor..."
echo "🔑 Oda şifresi: $APP_PASSWORD"

# Dosyaları sunucuya kopyala
echo "📦 Dosyalar kopyalanıyor..."
ssh -o StrictHostKeyChecking=no root@$IP "mkdir -p $APP_DIR"
scp -r -o StrictHostKeyChecking=no \
  server.js database.js package.json package-lock.json public \
  root@$IP:$APP_DIR/

# Sunucuda kurulum
ssh -o StrictHostKeyChecking=no root@$IP bash << EOF
set -e

echo "📥 Node.js kuruluyor..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "📥 PM2 kuruluyor..."
npm install -g pm2

echo "📦 Bağımlılıklar kuruluyor..."
cd $APP_DIR
npm install --production

echo "🔒 Firewall ayarlanıyor..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 3000/tcp
ufw --force enable

echo "▶️  Uygulama başlatılıyor..."
cd $APP_DIR
pm2 stop sesapp 2>/dev/null || true
PASSWORD=$APP_PASSWORD pm2 start server.js --name sesapp
pm2 save
pm2 startup | tail -1 | bash || true

echo ""
echo "✅ Kurulum tamamlandı!"
echo "🌐 Adres  : http://$IP:3000"
echo "🔑 Şifre  : $APP_PASSWORD"
echo ""
EOF
