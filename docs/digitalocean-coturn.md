# DigitalOcean Coturn Kurulumu

Bu rehber, SesApp için en hızlı production TURN kurulum yolunu anlatır.

## 1. Droplet aç

DigitalOcean panelinde:

- `Create -> Droplets`
- `Ubuntu 24.04 LTS`
- `Basic`
- `Regular SSD`
- `1 GB RAM / 1 vCPU`

Öneri:

- Auth yöntemi olarak `SSH key`
- Bölge olarak kullanıcılarına yakın bir bölge seç

## 2. Domain bağla

Bir `A` kaydı oluştur:

- `turn.senin-domainin.com -> DROPLET_IP`

## 3. Firewall aç

DigitalOcean Cloud Firewall ya da sunucu firewall tarafında şunları aç:

- `22/tcp`
- `80/tcp`
- `3478/tcp`
- `3478/udp`
- `5349/tcp`
- `49160-49200/udp`

## 4. Sunucuya bağlan

```bash
ssh root@DROPLET_IP
```

## 5. Coturn ve certbot kur

```bash
apt update
apt install -y coturn certbot
```

## 6. Sertifika al

```bash
certbot certonly --standalone -d turn.senin-domainin.com
```

## 7. Turn config yaz

Repo içindeki örnek dosya:

- [`infra/turn/turnserver.conf.example`](../infra/turn/turnserver.conf.example)

Bunu `/etc/turnserver.conf` olarak düzenle:

```conf
listening-port=3478
tls-listening-port=5349

listening-ip=0.0.0.0
external-ip=DROPLET_PUBLIC_IP

min-port=49160
max-port=49200

fingerprint
lt-cred-mech
realm=sesapp.turn
server-name=sesapp-turn

user=sesappturn:COK_GUCLU_SIFRE

cert=/etc/letsencrypt/live/turn.senin-domainin.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.senin-domainin.com/privkey.pem

no-cli
no-loopback-peers
no-multicast-peers
log-file=stdout
simple-log
```

## 8. Coturn servisini aç

Bazı Ubuntu paketlerinde şu dosyada servis açma flag’i gerekir:

```bash
sed -i 's/^TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

Sonra:

```bash
systemctl enable coturn
systemctl restart coturn
systemctl status coturn
```

## 9. Railway Variables gir

Bu projede artık aşağıdaki env’ler doğrudan destekleniyor:

```env
TURN_HOST=turn.senin-domainin.com
TURN_USERNAME=sesappturn
TURN_PASSWORD=COK_GUCLU_SIFRE
TURN_PORT=3478
TURNS_PORT=5349
TURN_ENABLE_TCP=true
TURN_ENABLE_TLS=true
```

## 10. Redeploy

Railway üzerinde:

- `Deploy Latest Commit`

## 11. Test

Özellikle daha önce birbirini duymayan iki kullanıcıyla test et:

- aynı sesli odada giriş
- ping rozeti geliyor mu
- çift yönlü ses geliyor mu

## Not

Bu yaklaşım, bu proje için Cloudflare TURN entegrasyonundan daha hızlı devreye alınır çünkü:

- ek backend API entegrasyonu gerekmez
- mevcut `/api/client-config` akışıyla hemen çalışır
- sadece env girerek aktif olur
