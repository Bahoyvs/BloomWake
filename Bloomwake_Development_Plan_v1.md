# BLOOMWAKE — Geliştirme Planı v1

Bu doküman, `Bloomwake_GDD_v1.md`'yi ve ardından gelen risk analizini temel alır. Her risk maddesi somut bir görev + doğrulama kriterine (acceptance criteria) bağlanmıştır — "verify before planning" prensibinize uygun olarak, hiçbir faz bir önceki fazın doğrulama testinden geçmeden başlamaz.

---

## 0. Ön-Üretim Kararları (Kilitlendi)

Risk analizindeki yanıtlar doğrultusunda:

| Karar | Değer |
|---|---|
| Kozmetik Dewling varyant sayısı (Basic Launch) | 4 (başlangıç / ucuz-Petal / pahalı-Petal / %1 Legendary-only "Prestij" skin) |
| Mobil kontrol şeması | Dokunmatik floating joystick (dokunulan noktayı merkez kabul eden) |
| Reklam entegrasyonu | Basic Launch'ta SDK yok; "Revive" butonu UI'da gri/dummy olarak yerinde durur, Full Launch'ta `requestAd` bağlanır |

Bu üç karar artık spec'e sabitlenmiştir, fazlar arasında yeniden tartışılmaz.

---

## 1. Risk → Görev Haritası

Analizdeki 4 riskin her biri, belirli bir fazda somut bir teknik görev + ölçülebilir doğrulama kriteriyle karşılanır:

| Risk | Hangi Fazda Çözülür | Somut Görev | Doğrulama Kriteri |
|---|---|---|---|
| Görsel Çorba | Faz 6 | Dewling trail'i her zaman en üst z-index katmanında render edilir; oyun alanı arka planı, 200 düşman senaryosunda bile Dewling'in kontrast oranı ölçülebilir şekilde yüksek kalacak şekilde koyulaştırılır (düşman/mermi renk paleti sınırlandırılır, arka plan gradient'i sadeleştirilir) | 200 düşman + 50 mermi aktifken masaüstünde ve düşük-orta mobil cihazda Dewling'in konumu playtester tarafından 1 saniye içinde bulunabilmeli |
| Kart Sinerjisi / Dengeleme Kabusu | Faz 3 (kodlamadan ÖNCE) | Kartlar kodlanmadan önce ayrı bir DPS simülasyon script'i (Node, `tests/balance-sim.js`) yazılır — her kart/seviye kombinasyonu için teorik DPS ve "afk-survivability" skorunu hesaplar | Hiçbir tekil kart 5. seviyede diğerlerinin toplamının >%40'ı kadar DPS üretmemeli; hiçbir kart 3. seviyede "ölü" (0 pratik katkı) kalmamalı |
| Snowball Etkisi | Faz 4 | Oyuncu-DPS-büyüme-eğrisi ile düşman-HP-büyüme-formülü ($1 + (dalga-1) \times 0.12$) aynı simülasyon script'inde karşılaştırılır, dalga bazında "ortalama öldürme süresi" grafiği çıkarılır | Dalga 1–20 arası ortalama düşman öldürme süresi 0.3sn–2.5sn bandında kalmalı (bandın altı = "ekran koruyucu" hissi, üstü = geçilemez zorluk) |
| Kaçınma (Evasion) Zorluğu | Faz 4 | Boss "Kara Gelgit" telegraph süresi milisaniye hassasiyetinde formülle bağlanır: `telegraph_ms = (AoE_yaricap / dewling_hiz) * 1000 + 300ms_güvenlik_payı` | Playtest'te "haksız hissettim" geri bildirimi 10 test run'ında %10'un altında kalmalı |

---

## 2. Fazlı Geliştirme Planı

### Faz 0 — Mimari İskelet (1 birim*)
- `src/core/` altında oyun durumu, dalga zamanlayıcı, DPS/HP hesaplama fonksiyonları — **AeroOS kuralı burada da geçerli**: `window`/`document`/DOM'a hiç referans yok, saf Node'da test edilebilir.
- `src/data/` altında düşman tablosu, kart tablosu, dalga formülü sabitleri (Bölüm 4/6/7'deki GDD tabloları veri olarak buraya girilir).
- Event bus pattern AeroOS'takiyle birebir aynı şekilde kurulur (`bus.emit` / `game.bus.on`).
- **Çıktı**: Boş ama testable bir simülasyon iskeleti, hiç render yok.
- **Doğrulama**: `vitest run` — dalga formülü, HP/hız çarpanları için birim testleri geçmeli.

### Faz 1 — Çekirdek Hayatta Kalma Döngüsü (temasız gri kutu)
- Hareket, tek otomatik saldırı (Dewdrop Barrage), XP toplama, seviye atlama, tek düşman tipi (kare/daire gri kutu), sabit 5 dalga.
- **Doğrulama**: Oyun baştan sona oynanabilir olmalı — "eğlenceli mi" sorusu bu noktada zaten cevaplanabilmeli. Cevap hayırsa, temaya geçmeden önce döngü yeniden tasarlanır.

### Faz 2 — Bounded Swarm Performans Katmanı
- Spatial hash grid (64px hücre), object pooling (mermi/parçacık/XP-orb), 200 düşman tavanı + spawn kuyruğu.
- **Doğrulama**: Düşük-orta mobil cihaz simülasyonunda (Chrome DevTools CPU throttling 4x-6x) 200 düşman + 50 mermi aynı anda ekrandayken 60 FPS'e kilitli kalmalı. Bu sayı tutmuyorsa tavan sayısı gerçek performansa göre aşağı çekilir — **spec'teki 200 sayısı ölçümle doğrulanana kadar hedef, kesin değer değildir.**

### Faz 3 — Kart Sistemi (önce simülasyon, sonra kod)
1. **Adım A**: `tests/balance-sim.js` yazılır — 8 kart × 5 seviye için teorik DPS/etki tablosu hesaplanır, Excel/CSV çıktısı alınır (Risk analizindeki "Excel DPS simülasyonu" önerisi burada karşılanıyor).
2. **Adım B**: Simülasyon sonuçları Bölüm 1'deki eşiklerle karşılaştırılır, aşırı güçlü/zayıf kartlar sayısal olarak ayarlanır.
3. **Adım C**: Ancak bu doğrulamadan sonra kartlar oyun içi koda geçirilir.
- **Doğrulama**: Simülasyon çıktısı Bölüm 1'deki DPS-dağılım eşiğini geçmeli.

### Faz 4 — Düşman Rosteri + Boss + Eğri Doğrulama
- Tam düşman tablosu (Tarling → Smogmoth) ve Rustwhale boss eklenir.
- Snowball simülasyonu (Bölüm 1) çalıştırılır, dalga formülü katsayıları gerekirse ayarlanır.
- Boss telegraph süresi formülle bağlanır ve playtest edilir.
- **Doğrulama**: Bölüm 1'deki Snowball ve Evasion eşikleri.

### Faz 5 — Bloom Capsule + Petal Meta-İlerleme
- Dalga-sonu küçük kapsül + run-sonu büyük kapsül (performans ağırlıklı tablo, GDD Bölüm 8).
- Petal kalıcı para sistemi + meta-yükseltmeler.
- Daily Bloom günlük giriş bonusu.
- Pity sistemi (8 run'da 1 garanti Rare+).
- **Doğrulama**: `tests/rewards.test.js` — ağırlıklı olasılık dağılımı 10.000 simülasyonda GDD tablosundaki yüzdelere ±%1 toleransla oturmalı.

### Faz 6 — Görsel/Tema Katmanı + Ses
- Frutiger Aero/Aqua arayüz, Frutevil düşman sprite'ları.
- **Görsel Çorba mitigasyonu burada uygulanır** (Bölüm 1) — z-index kuralı, kontrast paleti, trail sistemi.
- Ses tasarımı: mermi çarpışmalarında kısa perküsif/metalik "shaker" tarzı sentetik vuruşlar, boss/büyük yetenek anlarında alt-frekans ağırlıklı sub-bass synth — mevcut WebAudio `TONE` objenizle tutarlı, ek statik ses dosyası gerekmez.
- **Doğrulama**: Bölüm 1'deki Görsel Çorba doğrulama testi (1 saniyede karakter bulma).

### Faz 7 — Mobil Kontrol + Cilalama
- Floating joystick implementasyonu.
- AeroOS'un mobil touch-hit-target derslerinin doğrudan uygulanması (dokunma alanı büyütme, reflow kontrolü).
- Revive butonu dummy/disabled state ile UI'a eklenir (Faz 8'de gerçek bağlantı).
- **Doğrulama**: Gerçek mobil cihazda (değil sadece emulator) 10 dakikalık test oturumu, hiçbir yanlış-dokunma/kayıp-parmak olayı raporlanmamalı.

### Faz 8 — CrazyGames SDK + QA + Basic Launch Gönderimi
- SDK entegrasyonu, save/cloud-data bağlantısı.
- Build boyutu kontrolü (<20MB hedef — conversion benchmarkı).
- İlk 10 saniye yük süresi testi.
- **Doğrulama**: CrazyGames Preview tool ile tam bir "gerçek kullanıcı" akışı simüle edilir; Basic Launch gönderim checklisti tamamlanır.

*(*"1 birim" gibi kesin gün sayısı vermiyorum çünkü AI-agent destekli iterasyon hızınız değişken; her fazın gerçek süresi bir önceki fazın doğrulama testinin ne kadar iterasyon gerektirdiğine bağlı.)*

---

## 3. Faz Sırası Neden Bu Şekilde?

- **Faz 3'te "önce simülasyon, sonra kod"** kuralı bilinçli — kart dengelemesi kodlandıktan sonra yapılırsa, her denge değişikliği bir kod değişikliği + build + playtest döngüsü gerektirir. Simülasyon önce yapılırsa, sadece sayı değiştirip yeniden çalıştırmak yeterli — çok daha ucuz bir iterasyon döngüsü.
- **Faz 6 (tema) bilinçli olarak Faz 4'ten sonra** — gri kutu halinde eğlenceli olmayan bir döngü, üstüne Frutiger Aero cilası sürülse de eğlenceli olmaz. Görsel yatırım, çekirdek döngü sayısal olarak doğrulandıktan sonra yapılır.
- **Faz 8 (SDK/QA) en sona bırakıldı** çünkü Basic Launch'ta SDK zaten opsiyonel — bu, geliştirme hızını korumak için risk analizindeki tavsiyeyle birebir örtüşüyor.

---

## 4. Açık Risk Kaydı (İzlenmesi Gerekenler)

| Risk | Durum | Sonraki Adım |
|---|---|---|
| 200 düşman tavanı gerçek mobilde tutmayabilir | Ölçülmedi | Faz 2 doğrulamasında kesinleşecek |
| Kart sinerjisi simülasyonu gerçek oyuncu davranışını tam yakalamayabilir (AFK-build riski) | Kısmen azaltıldı | Faz 3 sonrası gerçek playtest ile çapraz doğrulama şart |
| Telegraph formülü farklı ekran boyutlarında (mobil vs masaüstü) farklı hissedilebilir | Tanımlanmadı | Faz 4 doğrulamasına "cihaz başına ayrı test" eklenmeli |
