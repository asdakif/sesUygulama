# TURN Setup

Bu proje artık gerçek TURN servisini iki şekilde besleyebilir:

1. `RTC_ICE_SERVERS_JSON` ile doğrudan özel ICE listesi vererek
2. Daha kolay olan `TURN_*` environment variable'larıyla

En pratik production kurulum yolu, Railway dışında küçük bir VPS üstünde `coturn`
çalıştırıp uygulamayı ona bağlamaktır.

## Önerilen mimari

- 1 adet küçük VPS
- DNS: `turn.senin-domainin.com`
- Üstünde `coturn`
- Uygulama Railway'de kalabilir

DigitalOcean ile hızlı kurulum için:

- [`docs/digitalocean-coturn.md`](./digitalocean-coturn.md)

## Uygulama environment variable'ları

Railway Variables içine şunları ekle:

```env
TURN_HOST=turn.senin-domainin.com
TURN_USERNAME=sesappturn
TURN_PASSWORD=guclu-bir-sifre-yaz
TURN_PORT=3478
TURNS_PORT=5349
TURN_ENABLE_TCP=true
TURN_ENABLE_TLS=true
```

Notlar:

- `TURN_HOSTS` ile birden fazla host da verebilirsin. Virgülle ayır.
- `RTC_ICE_SERVERS_JSON` verilirse, `TURN_*` ayarlarının önüne geçer.
- `TURN_*` ayarı yoksa uygulama geliştirme için fallback relay kullanır.

## Coturn kurulumu

Ubuntu/Debian örnek akış:

```bash
sudo apt update
sudo apt install -y coturn
```

Örnek config dosyası bu repoda var:

- [`infra/turn/turnserver.conf.example`](../infra/turn/turnserver.conf.example)

Sunucudaki ana config olarak kopyala:

```bash
sudo cp infra/turn/turnserver.conf.example /etc/turnserver.conf
```

Sonra kendi domain, public IP, cert ve şifrelerini doldur.

## Gerekli portlar

Firewall / provider security group tarafında aç:

- `3478/tcp`
- `3478/udp`
- `5349/tcp`
- `49160-49200/udp`

## TLS sertifikası

`turns:` kullanmak için sertifika gerekir. En kolay yol Let’s Encrypt:

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d turn.senin-domainin.com
```

Sonra config içindeki:

- `cert=`
- `pkey=`

alanlarını gerçek dosya yollarıyla doldur.

## Servisi açma

```bash
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn
```

## Bu projede ne değişti

Artık uygulama şu env’lerden otomatik ICE listesi üretebilir:

- `TURN_HOST` / `TURN_HOSTS`
- `TURN_USERNAME`
- `TURN_PASSWORD`
- `TURN_PORT`
- `TURNS_PORT`
- `TURN_ENABLE_TCP`
- `TURN_ENABLE_TLS`

Bu sayede Railway’e uzun JSON yazmadan gerçek TURN servisi bağlayabilirsin.
