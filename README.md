# BloomWake

Bounded Swarm / Survivor-Arena (Vampire Survivors formülü, performans-güvenli hibrit)
Tema: Frutiger Aero + Frutiger Aqua (kahraman tarafı) vs. Frutevil Aero (düşman tarafı)
Platform: CrazyGames

Spesifikasyon: [`Bloomwake_GDD_v1.md`](Bloomwake_GDD_v1.md) · Plan: [`Bloomwake_Development_Plan_v1.md`](Bloomwake_Development_Plan_v1.md)

---

## Durum: Faz 4 tamamlandı (Düşman Rosteri + Rustwhale Boss)

| Faz | Kapsam | Durum |
|---|---|---|
| Faz 0 | Mimari iskelet, veri tabloları, event bus | ✅ |
| Faz 1 | Çekirdek hayatta kalma döngüsü | ✅ |
| Faz 2 | Spatial hash + 200 düşman tavanı | ✅ (Faz 4 ile birleştirildi) |
| Faz 3 | Kart sistemi (8 kart, seviye atlama draft'ı) + Buddy Boost gating | ✅ |
| Faz 4 | Tam düşman rosteri (Tarling, Ashfish, Cracked Wisp, Rustbloom, Smogmoth) + Rustwhale Boss & Telegraph | ✅ |
| Faz 5 | Bloom Capsule + Petal Meta-İlerleme | ⏳ |

Faz 4 kapsamı: 5 Frutevil düşman tipi, 64px Spatial Hash Grid collision optimizasyonu, Rustbloom spor tuzak alanları, Rustwhale Boss & formüle bağlı deterministik Kara Gelgit (Black Tide) telegraph AoE saldırısı.

### Denge simülasyonu & Testler

```bash
npm test
```
148 test geçiyor (12 test dosyası).

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
src/data/      düşman ve kart veri tabloları (GDD Bölüm 4/7)
src/render/    Canvas 2D renderer + boss telegraph / spor çizimi + kamera
src/ui/        DOM HUD, draft ekranı, run akışı overlay'leri
src/input/     klavye girdisi
tests/         vitest birim testleri + balance-sim.js
```
