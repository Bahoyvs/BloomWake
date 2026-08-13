# BloomWake

Bounded Swarm / Survivor-Arena (Vampire Survivors formülü, performans-güvenli hibrit)
Tema: Frutiger Aero + Frutiger Aqua (kahraman tarafı) vs. Frutevil Aero (düşman tarafı)
Platform: CrazyGames

Spesifikasyon: [`Bloomwake_GDD_v1.md`](Bloomwake_GDD_v1.md) · Plan: [`Bloomwake_Development_Plan_v1.md`](Bloomwake_Development_Plan_v1.md)

---

## Durum: Faz 6 tamamlandı (Frutiger Aero görsel katmanı)

| Faz | Kapsam | Durum |
|---|---|---|
| Faz 0 | Mimari iskelet, veri tabloları, event bus | ✅ |
| Faz 1 | Çekirdek hayatta kalma döngüsü | ✅ |
| Faz 2 | Spatial hash + 200 düşman tavanı | ✅ (Faz 4 ile birleştirildi) |
| Faz 3 | Kart sistemi (8 kart, seviye atlama draft'ı) + Buddy Boost gating | ✅ |
| Faz 4 | Tam düşman rosteri (Tarling, Ashfish, Cracked Wisp, Rustbloom, Smogmoth) + Rustwhale Boss & Telegraph | ✅ |
| Faz 5 | Bloom Capsule + Petal Meta-İlerleme + Daily Bloom | ✅ |
| Faz 6 | Görsel/tema katmanı (Frutiger Aero/Aqua + Frutevil) | ✅ |
| Faz 6b | Ses tasarımı (WebAudio) | ⏳ |
| Faz 7 | Mobil kontrol + cilalama | ⏳ |

Faz 4 kapsamı: 5 Frutevil düşman tipi, 64px Spatial Hash Grid collision optimizasyonu, Rustbloom spor tuzak alanları, Rustwhale Boss & formüle bağlı deterministik Kara Gelgit (Black Tide) telegraph AoE saldırısı.

Faz 5 kapsamı: Bloom Capsule ödül sistemi (küçük/büyük kapsül, performansa
bağlı ağırlıklar, 8 run'lık pity garantisi), Petal kalıcı para birimi,
4 meta-yükseltme, 4 kozmetik varyant, yerel-güne bağlı Daily Bloom ve
localStorage kalıcılığı (geriye dönük uyumlu deep-merge yükleme).

### Ekonomi kalibrasyonu (Faz 5 Adım C)

Petal ödül miktarları tahminle değil simülasyonla belirlendi. Bot 200 run
oynatılır, her run'ın kapsül geliri üretim mantığıyla hesaplanır ve 4. Kart
Slotu'na (2000 Petal) ulaşma süresi 15-20 run bandına oturana kadar ödül
aralıkları ölçeklenir.

```bash
node tests/economy-calibration.js --write
```

Ödül tabloları `src/data/rewards.js` içinde CALIBRATED_POOL işaretleri arasında
tutulur; script bu bloğu yeniden yazar. Elle düzenlemek yerine script'i
yeniden çalıştırın.

### Görsel katman ve "Görsel Çorba" testi (Faz 6)

Tema, Dewling'in 200 düşman arasında kaybolmamasını **sayısal olarak** garanti
eden bir parlaklık ayrımı üzerine kurulu:

- Kahraman tarafı (Dewling, izi, kalkanı) ekrandaki tek **çok parlak** öğe.
- Frutevil paleti tamamen **koyu ve doygunluğu düşük**, sadece dört renk ailesi
  (katran, kül, pas, is). Düşman sayısı artınca ortalama ekran parlaklığı
  Dewling'in bandına yaklaşamaz.
- Arka plan sade iki duraklı bir gradient; Dewling ve izi çizim sırasında
  **her zaman en üstte** (`Z_ORDER`, `src/render/theme.js`).

`tests/theme.test.js` bu kuralları WCAG kontrast oranıyla doğrular — paleti
bozacak bir değişiklik playtest'te değil, testte yakalanır.

Ölçüm (200 düşman + 50 mermi, canlı canvas piksel analizi): ekrandaki en parlak
piksel Dewling'in kendisi, Dewling çevresindeki sürüden **9 kat** daha parlak.

Düşman sprite'ları prosedürel olarak Canvas 2D ile çizilir (görsel asset yok),
bu da build boyutunu küçük tutar.

### Denge simülasyonu & Testler

```bash
npm test
```
261 test geçiyor (17 test dosyası).

```bash
node tests/balance-sim.js
```

Eşikler: hiçbir 5. seviye kart diğerlerinin toplamının %40'ını aşamaz, hiçbir kart 3. seviyede "ölü" olamaz.

## Çalıştırma

```bash
npm install
```

```bash
npm run dev
```

## Kontroller

| Girdi | Etki |
|---|---|
| `WASD` / ok tuşları | Hareket (Dewling kendi ateş eder) |
| `1` / `2` / `3` | Seviye atlama draft'ından kart seç (fare tıklaması da olur) |
| `Enter` / `Space` | Run başlat / yeniden başlat |
| `Esc` / `P` | Duraklat / devam |

## Mimari

`src/core/` **saf JavaScript**'tir: `window`/`document`/DOM referansı içermez ve tamamı Node üzerinde test edilir.

```
src/core/      simülasyon çekirdeği (saf, testable)
  constants.js   dünya/ölçek/tuning sabitleri + CARD_MODEL
  math.js        vektör + seeded RNG yardımcıları
  event-bus.js   bus.emit / bus.on
  wave.js        GDD Bölüm 6 dalga formülleri
  spawner.js     dalga spawn zamanlaması, düşman seçimi, boss zamanlaması
  spatial.js     64px Spatial Hash Grid (broadphase collision)
  pool.js        kart kaynaklı nesneler için object pool
  cards.js       8 kartın efekt handler'ları
  draft.js       ağırlıklı kart draft'ı (GDD Bölüm 7) + Buddy Boost gating
  game-state.js  run durumu, XP/seviye, dalga akışı, draft durumu
  simulation.js  varlıklar, düşman davranışları, boss telegraph, çarpışma
  state.js       kalıcı meta-state + geriye dönük uyumlu deep-merge yükleme
  rewards.js     Bloom Capsule çözümü, pity garantisi
  meta-shop.js   meta-yükseltme satın alma + run başlangıcına uygulama
  cosmetics.js   kozmetik sahiplik/kuşanma
  daily-bloom.js yerel-güne bağlı günlük bonus (saf, timestamp parametreli)
  meta-progression.js  run sonucu -> kapsül -> kalıcı state köprüsü
src/data/      düşman, kart, ödül, yükseltme ve kozmetik tabloları
src/render/    Canvas 2D renderer + kamera
  theme.js       Frutiger Aero/Frutevil paleti + kontrast & Z_ORDER kuralları
  sprites.js     prosedürel Frutevil düşman ve Dewling sprite'ları
  particles.js   havuzlanmış parçacık sistemi
  screen-shake.js  trauma tabanlı ekran sarsıntısı
  renderer.js    arka plan, hazard, boss telegraph, çizim sırası
src/ui/        DOM HUD, draft ekranı, meta ekranları (menü/mağaza/sonuç)
  meta-ui.js     Petal mağazası, Bloom Complete, Daily Bloom, toast
  storage.js     localStorage kalıcılığı (tek DOM dokunan katman)
src/input/     klavye girdisi
tests/         vitest birim testleri + balance-sim.js
```
