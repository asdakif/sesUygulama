# Replik paneli

Başlıktaki **Replikler** düğmesi Sıfır Bir kliplerini açar. **Dinle** yalnızca yerelde oynatır; **Odaya çal** mevcut sesli kanaldaki katılımcılara gönderir. Mikrofon kapalıyken de kullanılabilir. Ses düzeyi ve odadaki replikleri duyma tercihi bu cihazda saklanır. **Bende durdur** diğer katılımcıların oynatmasını etkilemez.

Sunucu yalnızca katalogdaki kimlikleri kabul eder ve hedef odayı kendi üyelik kaydından belirler. Aynı odada klipler üst üste binmez: bekleme süresi en az 3 saniye, uzun kliplerde klip süresi + 350 ms'dir. Oda değiştirerek bu gönderici sınırı aşılamaz. Bağlantı kesilince veya odadan çıkılınca yerel oynatma durur; bekleyen tıklamalar yeniden bağlantıda gönderilmez.

## Kayıtlar

`public/replik-catalog.json` iki kısa selamlaşma kaydını tanımlar; dosyalar `public/audio/replikler/` altında bulunur. Kaynak dosyalardan müzik veya uzun sahne eklenmedi; hazır kısa kesitler kullanıldı. Dosyalar uygulamayla sunulur, oynatma üçüncü taraf sitelere bağlı değildir.

Kaynak sayfaları ve özgün indirme bağlantıları `docs/replik-sources.json` dosyasında kayıtlıdır (17 Ekim 2026). Bunlar topluluk arşivlerinden alınan kısa alıntılardır; telif hakları özgün hak sahiplerine aittir. Kaynak arşivi bu kesitleri kişisel/eğlence amaçlı sunar; yeniden dağıtım için bir lisans doğrulanmış değildir.

“Selamün aleyküm” ve “Aleyküm selam babba” kayıtları [Ses Efektleri Sıfır Bir arşivinden](https://sesefektleri.com/yapim/sifir-bir) alınmıştır.

Yeni klip eklerken benzersiz bir `id`, aynı kökenden `src`, gerçek `duration` (saniye) ve başlık tanımlayın. Sunucu kataloğu açılışta okuduğundan katalog değişikliği sunucuyu yeniden başlatmayı gerektirir.
