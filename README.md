# BloomWake

Bounded Swarm / Survivor-Arena (Vampire Survivors formülü, performans-güvenli hibrit)
Tema: Frutiger Aero + Frutiger Aqua (kahraman tarafı) vs. Frutevil Aero (düşman tarafı)
Platform: CrazyGames

Spesifikasyon: [`Bloomwake_GDD_v1.md`](Bloomwake_GDD_v1.md) · Plan: [`Bloomwake_Development_Plan_v1.md`](Bloomwake_Development_Plan_v1.md)

---

## Durum: Faz 1 tamamlandı (gri kutu, temasız)

| Faz | Kapsam | Durum |
|---|---|---|
| Faz 0 | Mimari iskelet, veri tabloları, event bus | ✅ |
| Faz 1 | Çekirdek hayatta kalma döngüsü | ✅ |
| Faz 2 | Spatial hash + object pooling + 200 düşman tavanı | ⏳ |

Faz 1 kapsamı: hareket, tek otomatik saldırı (Dewdrop Barrage), XP toplama,
seviye atlama, tek düşman tipi (Tarling) ve sabit 5 dalga. Görsel katman
bilinçli olarak gri kutudur — Frutiger Aero teması Faz 6'da geliyor.

## Çalıştırma

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

## Kontroller

| Girdi | Etki |
|---|---|
| `WASD` / ok tuşları | Hareket (Dewling kendi ateş eder) |
| `Enter` / `Space` | Run başlat / yeniden başlat |
| `Esc` / `P` | Duraklat / devam |

Mobil floating joystick Faz 7'de eklenecek; `src/input/input.js` bunun için
hazırlanmış arayüzdür — `{x, y}` yön vektörü üreten her modül simülasyonu sürer.

## Mimari

`src/core/` **saf JavaScript**'tir: `window`/`document`/DOM referansı içermez ve
tamamı Node üzerinde test edilir. Render, girdi ve HUD katmanları bu çekirdeği
yalnızca okur.

```
src/core/      simülasyon çekirdeği (saf, testable)
  constants.js   dünya/ölçek/tuning sabitleri
  math.js        vektör + seeded RNG yardımcıları
  event-bus.js   bus.emit / bus.on
  wave.js        GDD Bölüm 6 dalga formülleri
  spawner.js     dalga spawn zamanlaması ve konumlandırma
  game-state.js  run durumu, XP/seviye, dalga akışı
  simulation.js  varlıklar, çarpışma, otomatik saldırı
src/data/      düşman ve kart veri tabloları (GDD Bölüm 4/7)
src/render/    Canvas 2D gri-kutu renderer + kamera
src/ui/        DOM HUD ve run akışı overlay'leri
src/input/     klavye girdisi
tests/         vitest birim testleri
```

Simülasyon sabit adımla (1/60 sn) ilerler; render hızından bağımsızdır.
Spawn RNG'si seed'lidir, bu sayede testler deterministiktir.
