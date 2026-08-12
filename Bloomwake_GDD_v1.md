# BLOOMWAKE — Oyun Tasarım Spesifikasyonu v1

**Alt başlık öneri**: *Aeria: Last Bloom*
**Tür**: Bounded Swarm / Survivor-Arena (Vampire Survivors formülü, performans-güvenli hibrit)
**Tema**: Frutiger Aero + Frutiger Aqua (kahraman tarafı) vs. Frutevil Aero (düşman tarafı)
**Platform**: CrazyGames — Basic Launch → Full Launch hedefli
**Hedef kitle**: 12–18 yaş, PEGI 12

---

## 1. Konsept Özeti

Bir zamanlar tamamen Frutiger Aero estetiğinde bir dünya — yüzen cam adalar, turkuaz denizler, kabarcık bulutları, çiy damlaları, kelebekler — dünyanın kenarlarından yayılan **"Leke" (The Stain)** adlı bir bozulma tarafından karanlık, yağlı, paslı bir Frutevil manzarasına dönüştürülüyor.

Oyuncu, **Dewling** adlı ışık/su kökenli bir varlığı yönetir. Karakter otomatik saldırır (oyuncu sadece hareket eder), her seviye atlayışında 3 yetenek kartından biri seçilir. Dalgalar halinde gelen Frutevil yaratıklarına karşı hayatta kalınır; her dalga sonunda bir **Bloom Capsule** (ödül kapsülü) açılır.

Hiçbir 2000'ler-teknoloji terminolojisi (firewall, antivirus, pop-up, spam vb.) kullanılmaz — tüm isimlendirme doğa/ışık/su motiflerinden gelir.

---

## 2. Çekirdek Döngü (Core Loop)

```
Run başlar → Hareket + otomatik saldırı → XP topla → Seviye atla
   → 3 karttan 1 seç → Dalga tamamlanır → Bloom Capsule (küçük ödül)
      → 5 dalgada bir Boss → Karakter ölür/run biter
         → Sonuç ekranı: skor + Bloom Capsule (büyük, performansa göre ağırlıklı)
            → Kalıcı para (Petal) ile meta-yükseltme → Yeni run
```

Bir run hedefi: **8–14 dakika** (CrazyGames'in 10+ dakika ortalama oynama süresi benchmark'ını doğal olarak karşılamak için tasarlandı).

---

## 3. Oyuncu Karakteri — Dewling

| Özellik | Başlangıç Değeri | Not |
|---|---|---|
| Hareket hızı | 3.2 birim/sn | Meta-yükseltmelerle artar |
| Başlangıç canı | 100 | |
| Başlangıç saldırısı | "Dewdrop Barrage" (otomatik, en yakın düşmana) | İlk kart seçimine kadar tek saldırı |
| Toplama yarıçapı (XP) | 0.8 birim | Meta-yükseltme ile artırılabilir |

Görsel: Yarı saydam su damlası/kabarcık formu, üzerinde speküler highlight, hafif ışık halesi. Hareket ederken arkasında kısa süreli parıltı izi (trail) bırakır — bu hem Frutiger Aero estetiğine hizmet eder hem de oyuncunun kendi konumunu kalabalıkta net görmesini sağlar (okunabilirlik/UX önceliği).

---

## 4. Düşman Rosteri (Frutevil)

Zorluk eğrisi **prosedürel** — el yapımı level yok, dalga numarasına göre formülle üretiliyor (bkz. Bölüm 6).

| Düşman | Görsel | Can | Hız | Davranış | İlk Görülme (Dalga) |
|---|---|---|---|---|---|
| **Tarling** | Küçük, yağlı, kara su damlası | 10 | Orta | Oyuncuya düz çizgi | 1 |
| **Ashfish** | Kül rengi, ölü balık | 15 | Değişken (sinüs) | Dalgalı yaklaşma, sürü halinde | 3 |
| **Cracked Wisp** | Çatlak cam parçacığı ruhu | 6 | Hızlı | Düşük can, sürü halinde hızlı yaklaşır | 4 |
| **Rustbloom** | Paslı, solmuş çiçek-yaratık | 30 | Yavaş | Durur, periyodik alan-hasarı sporu bırakır | 6 |
| **Smogmoth** | İs kelebeği, kırık kanat | 12 | Orta (uçan) | Rastgele/zikzak uçuş, temas hasarı | 8 |

**Boss — The Rustwhale** (her 5. dalgada: 5, 10, 15...)
- Can: `400 + (dalga_no / 5) * 250`
- Saldırı: Periyodik "Kara Gelgit" alan saldırısı (kaçınılması gereken telgraflı AoE)
- Yenilgi ödülü: Garantili Nadir+ Bloom Capsule

---

## 5. "Bounded Swarm" Teknik Yaklaşımı (Performans Güvenliği)

Önceki tartışmada belirlenen risk azaltma stratejisi burada teknik olarak sabitleniyor:

- **Sert düşman tavanı**: Ekranda aynı anda maksimum **200 aktif düşman**. Tavan dolduğunda fazla spawn'lar bir kuyrukta bekler, biri ölünce kuyruktan biri girer.
- **AI**: Gerçek pathfinding YOK. Her düşman sadece oyuncuya doğru düz vektör hareketi yapar (+ tip'e özel sinüs/zikzak modifikatörü). Bu, Vampire Survivors'ın kendisinin de kullandığı yaklaşımdır.
- **Çarpışma optimizasyonu**: Spatial hash grid (hücre boyutu ~64px). Her frame'de sadece komşu hücrelerdeki nesneler karşılaştırılır — O(n²) yerine ~O(n).
- **Render**: PixiJS veya HTML5 Canvas + sprite batching. AeroOS'un mevcut render yaklaşımıyla uyumlu, WebGL zorunlu değil (MindSync'teki gibi tek istisna dışında WebGL'den kaçınma prensibinizle tutarlı).
- **Mermi/parçacık havuzu (object pooling)**: Tüm mermi, parçacık ve XP-orb nesneleri önceden ayrılmış bir havuzdan çekilir; `new` / GC baskısı çalışma sırasında sıfıra yakın tutulur.

---

## 6. Dalga (Wave) Formülü

```
düşman_sayısı(dalga) = min(200, 8 + dalga * 6)
düşman_can_çarpanı(dalga) = 1 + (dalga - 1) * 0.12
düşman_hız_çarpanı(dalga) = min(1.5, 1 + (dalga - 1) * 0.03)
dalga_süresi = 35 saniye (boss dalgaları hariç)
```

Yeni düşman tipi kilidi dalga eşiğine göre otomatik açılır (Bölüm 4'teki "İlk Görülme" sütunu) — level tasarımcısının elle bölüm kurması gerekmez, sadece yeni bir düşman *tipi* eklemek istediğinde veri tablosuna satır eklenir.

---

## 7. Yetenek Kartları

Seviye atlayışında 3 kart sunulur (havuzdan ağırlıklı rastgele, zaten sahip olunanlar öncelik kazanır — "build etrafında büyüme" hissi için).

| Kart | Tip | Etki | Nadir |
|---|---|---|---|
| Dewdrop Barrage | Mermi | En yakın düşmana otomatik atış, hız/hasar seviyeyle artar | Common |
| Sunbeam Lance | Işın | Sabit yönde sürekli hasar şeridi | Common |
| Glasswing | Orbit | Karakter etrafında dönen kesici kanatlar | Common |
| Petal Storm | Mermi (çoklu) | Rastgele yönlere yaprak salvo | Uncommon |
| Aurora Pulse | AoE | Periyodik patlama, çevresel hasar | Uncommon |
| Bloomshield | Kalkan | Periyodik geçici hasar emici çiçek kalkanı | Rare |
| Buddy Boost | Pasif | +hareket hızı / +hasar (yığılabilir) | Common (pasif havuz) |
| Tidewave | AoE + itme | Alan hasarı + düşmanları geriye iter (crowd control) | Rare |

**Dengeleme notu**: Her kart 5 seviyeye kadar yükseltilebilir (aynı kart tekrar çıkarsa güçlenir). Combo/sinerji test süreci (örn. Glasswing + Buddy Boost'un oyunu "kırmaması") haftalık bir denge geçişi gerektirir — bu, sizin GDD sürecinizdeki "verify before planning" prensibiyle uyumlu şekilde, her yeni kart eklendiğinde manuel playtestle doğrulanmalı.

---

## 8. Bloom Capsule (Ödül Sistemi)

**Önceki tasarımdan temel fark**: Bu oyun için sandık **key/zamanlayıcı ekonomisi kullanmaz** (o sistem merge-oyunu konseptine özeldi). Burada ödül tamamen **performansa bağlı** ve iki katmanlıdır:

### Küçük Bloom Capsule (her dalga sonunda)
- Görsel: Kapanık bir tomurcuk, dalga bitince yavaşça açılıyor.
- İçerik: Küçük Petal (kalıcı para) miktarı + nadiren küçük kozmetik parça.

### Büyük Bloom Capsule (run bitince / karakter öldüğünde)
- "Extraction Complete" yerine: **"Bloom Complete"** ekranı — hayatta kalınan dalga sayısı + toplam skor gösterilir.
- Ödül ağırlığı performansa göre skalalanır:

| Performans (hayatta kalınan dalga) | Ödül Havuzu Ağırlığı |
|---|---|
| 1–4 | Common %85 / Uncommon %14 / Rare %1 |
| 5–9 | Common %65 / Uncommon %28 / Rare %6 / Legendary %1 |
| 10+ | Common %45 / Uncommon %35 / Rare %16 / Legendary %4 |

- **Şeffaflık**: Oranlar oyun içi bir "?" ikonuyla her zaman görüntülenebilir (önceki turda belirlediğimiz prensip — gizli oran yok).
- **Pity sistemi**: Son 8 run'da hiç Rare+ çıkmadıysa, 9. run'ın büyük kapsülü garantili Rare+ olur.

---

## 9. Meta-İlerleme (Retention Motoru)

Kalıcı para birimi: **Petal** (run içi XP'den ayrı, prestige tarzı — AeroOS'taki iki-para-birimi çakışması hatasından ders alınarak net ayrılmıştır).

Petal ile satın alınabilecek kalıcı yükseltmeler:
- Başlangıç canı +
- Toplama yarıçapı +
- Kart seçim ekranında 4. seçenek açma (yüksek Petal maliyeti, geç oyun hedefi)
- Kozmetik Dewling varyantları (Bloom Capsule'dan da düşebilir)

**Günlük kanca**: Günün ilk run'ında bitişte ekstra bir "Daily Bloom" kapsülü (giriş bonusu, D1/D7 retention'a doğrudan hizmet eder — CrazyGames'in kendi rehberinin önerdiği "basit giriş bonusu" formülü).

---

## 10. CrazyGames Metrik Haritalaması

| Metrik | Bu Tasarımdaki Karşılığı | Hedef |
|---|---|---|
| **Gameplay Conversion** | İlk 5 saniyede hareket + otomatik saldırı zaten aktif, tutorial modal yok, sadece 1 kez "hareket et" ipucu | %80+ |
| **Average Playtime** | Run uzunluğu 8–14 dk + "bir run daha" çekimi (yeni build denemek) | 10+ dk |
| **Retention (D1)** | Meta-ilerleme (Petal) + Daily Bloom günlük kanca + pity sistemi | %10–15 |
| **Players** | Genre zaten CrazyGames'te kanıtlanmış (Swarm Survivor, EvoWars.io gibi başlıklar mevcut), iyi retention/playtime algoritmik keşfi besler | Dolaylı |

---

## 11. Build Sırası (Önerilen Fazlar)

1. **Faz 1 — Çekirdek hayatta kalma döngüsü**: Hareket, tek otomatik saldırı, XP toplama, seviye atlama, tek düşman tipi, sabit dalga sayısı (playable prototip, tema yok).
2. **Faz 2 — Bounded Swarm performans katmanı**: Spatial hash, object pooling, 200 düşman tavanı testi.
3. **Faz 3 — Kart sistemi**: 8 kartlık havuz, seviye atlama UI, dengeleme geçişi.
4. **Faz 4 — Düşman rosterinin tamamı + Boss**: Tarling → Rustwhale zinciri, dalga formülü.
5. **Faz 5 — Bloom Capsule + Petal meta-ilerleme**.
6. **Faz 6 — Görsel/tema katmanı**: Frutiger Aero/Aqua arayüz, Frutevil düşman sprite'ları, parçacık efektleri, ekran sarsıntısı.
7. **Faz 7 — CrazyGames SDK entegrasyonu + QA + Basic Launch gönderimi**.

Faz 1–3, temasız/gri-kutu halde oynanabilirliği doğrulamak için önceliklidir — "game feel" işçiliği (Faz 6) en son yatırım yapılacak alan olmalı, çünkü temel döngü eğlenceli değilse görsel cila onu kurtarmaz.

---

## 12. Açık Sorular (Bir sonraki tartışma için)

- Kozmetik Dewling varyantları kaç tane olacak, ilk sürümde kaç tanesi Bloom Capsule'dan mı yoksa doğrudan Petal mağazasından mı erişilebilir olacak?
- Mobil kontrol şeması: sanal joystick mi, dokunmatik-sürükle mi? (AeroOS'un mobil touch-hit-target deneyiminden alınacak dersler burada uygulanmalı.)
- Rewarded-ad entegrasyonu Full Launch'a kadar ertelenecek mi, yoksa "run'ı devam ettir" gibi bir Basic Launch-uyumlu (SDK'sız) opsiyonel özellik mi olacak?
