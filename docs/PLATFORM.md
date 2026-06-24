# پلتفرم Matching Arena — معماری و API

> سند فنی پلتفرم. قوانین بازی در [GAME_DESIGN.md](./GAME_DESIGN.md).
> نسخه: ۰.۱

## ۱. معماری

```
┌──────────────────────────────────────────────┐
│                 Engine (Node + TS)            │
│                                               │
│  World  ──► snapshot ──► /state ──► Matcher    │
│   ▲                                   │        │
│   │           /assign  ◄──────────────┘        │
│  step() هر cycle (پیش‌فرض ۳۰ ثانیه)            │
│                                               │
│  /viz ──► UI مرورگر (نقشهٔ زنده، فقط خواندنی)   │
└──────────────────────────────────────────────┘
```

سه جزء:
- **Engine** (`src/`): هستهٔ شبیه‌سازی + سرور HTTP. تنها مرجع حقیقت دنیاست.
- **UI** (`public/`): صفحهٔ مرورگری که هر ثانیه `/viz` را poll می‌کند و نقشه را می‌کشد. هیچ تصمیمی نمی‌گیرد.
- **Matcher / Client** (`client/`): کد شرکت‌کننده. هر cycle `/state` می‌گیرد و `/assign` می‌فرستد.

## ۲. ساختار فایل‌ها

| فایل | نقش |
|------|-----|
| `src/config.ts` | تمام پارامترهای قابل تیون (با override از طریق env) |
| `src/types.ts` | تایپ‌های مشترک |
| `src/geometry.ts` | فاصله، حرکت، تابع رِیتینگ |
| `src/world.ts` | حالت دنیا + منطق یک step (هستهٔ شبیه‌سازی) |
| `src/engine.ts` | حلقهٔ session، زمان‌بندی cycle، بافر تخصیص |
| `src/server.ts` | سرور HTTP REST + سرو کردن UI |
| `public/` | UI نقشهٔ زنده |
| `client/sample-client.ts` | Matcher مرجع (greedy nearest) |

## ۳. چرخهٔ یک cycle

هر `CYCLE_MS` (پیش‌فرض ۳۰۰۰۰):
1. تخصیص‌های دریافت‌شده برای snapshot جاری اعمال می‌شوند (`applyAssignments`).
2. `world.step()` اجرا می‌شود:
   - حرکت رانندگان `ON_TRIP` به سمت مسافر/مقصد،
   - pickup و محاسبهٔ رِیتینگ مسافر و راننده،
   - تکمیل سفر و محاسبهٔ کرایه،
   - کنسل‌کردن مسافرهایی که از سقف صبر گذشته‌اند،
   - خواب/بیداری رانندگان،
   - تولید درخواست‌های جدید (پواسون).
3. snapshot جدید منتشر می‌شود.
4. وقتی `tick >= SESSION_TICKS` ⇒ status = `finished`.

> snapshot هر tick دقیقاً برای یک cycle باز است. تخصیصی که با `tick` قدیمی POST شود رد می‌شود (پاسخ ۴۰۹).

## ۴. API

پایه: `http://localhost:8080` (یا `PORT`). همهٔ پاسخ‌ها JSON، با CORS باز.

### `GET /state` — برای Matcher
snapshot قابل‌تصمیم‌گیری:
```jsonc
{
  "status": "running",
  "tick": 14,
  "minute": 14,
  "sessionTicks": 240,
  "config": { "worldWidth": 100, "worldHeight": 100, "driverSpeed": 8,
              "riderPatienceMinutes": 5, "baseFare": 5, "perDistanceFare": 1.5 },
  "idleDrivers": [ { "id": "d3", "pos": { "x": 12.1, "y": 80.4 } } ],
  "openRequests": [
    { "id": "t42", "origin": {"x":..}, "destination": {"x":..},
      "requestedTick": 12, "waitedMinutes": 2 }
  ]
}
```

### `POST /assign` — از Matcher
```jsonc
// body
{ "tick": 14, "assignments": [ { "driverId": "d3", "tripId": "t42" } ] }
// پاسخ 200: { "ok": true, "message": "1 تخصیص دریافت شد" }
// پاسخ 409: { "ok": false, "message": "tick قدیمی است (الان 15)" }
```
- آخرین POST معتبر برای یک tick، کل مجموعهٔ تخصیص را تعیین می‌کند.
- تخصیص نامعتبر (راننده مشغول، trip بسته، راننده تکراری) بی‌صدا هنگام اعمال رد می‌شود.

### `GET /viz` — برای UI
وضعیت کامل: همهٔ رانندگان (هر حالت)، سفرهای فعال، و `scoreboard` با میانگین‌ها.

### کنترل session
- `POST /session/start` — ریست + شروع.
- `POST /session/reset` — توقف و پاک‌سازی.

## ۵. اجرا

```bash
npm install            # tsx + typescript (dev)
npm run engine         # cycle واقعی ۳۰ ثانیه
npm run engine:fast    # CYCLE_MS=1000 برای توسعه/تست
npm run client         # Matcher نمونه

# نقشه: http://localhost:8080/
```

تیون با env، مثلا:
```bash
CYCLE_MS=500 DRIVER_SPEED=12 RIDER_ARRIVAL_RATE=3 DRIVER_COUNT=30 npm run engine
```

## ۶. عدالت و تکرارپذیری

- موقعیت اولیهٔ رانندگان و توالی درخواست‌ها از یک RNG با **seed ثابت** (`SEED`) می‌آید ⇒ همهٔ شرکت‌کننده‌ها دنیای یکسان می‌بینند.
- برای رتبه‌بندی نهایی، همه را با یک `SEED` (یا چند seed و میانگین) اجرا کنید و `scoreboard` را مقایسه کنید.

## ۷. کارهای باقی‌مانده (Roadmap)

- [ ] تیون پارامترها (سرعت، نرخ ورود، کرایه) — فعلاً placeholder.
- [ ] فرمول نهایی امتیاز مسابقه (بخش ۶ سند بازی) و نمایش رتبه.
- [ ] احراز هویت/شناسهٔ شرکت‌کننده تا چند Matcher هم‌زمان قابل تفکیک باشند.
- [ ] حالت headless/batch برای اجرای سریع و خودکارِ چند seed بدون UI.
- [ ] محدودیت زمان پاسخ Matcher در هر cycle.
- [ ] ثبت لاگ کامل سفرها برای بازپخش (replay).
