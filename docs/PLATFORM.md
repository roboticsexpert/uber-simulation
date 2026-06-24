# پلتفرم Matching Arena — معماری و API

> سند فنی پلتفرم. قوانین بازی در [GAME_DESIGN.md](./GAME_DESIGN.md).
> نسخه: ۰.۲ — multi-session

## ۱. معماری

```
┌───────────────────────────────────────────────────┐
│                 SessionManager                     │
│   Map<sessionId, Engine>  (حداکثر ۱۶ سشن)          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Engine A │  │ Engine B │  │ Engine C │  ...     │
│  │ World+loop│ │ World+loop│ │ World+loop│         │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
└───────┼─────────────┼─────────────┼────────────────┘
  /sessions/A/...  /sessions/B/...  /sessions/C/...
   Matcher A         Matcher B        Matcher C
        └──────── GET /sessions ───────► UI گرید (همهٔ دنیاها)
```

- چندین **Engine** مستقل هم‌زمان اجرا می‌شوند؛ هر کدام `World` و حلقهٔ زمانیِ خودش را دارد.
- همهٔ سشن‌ها از یک **config یکسان** (همان `SEED` و پارامترها) استفاده می‌کنند ⇒ دنیای اولیه و تقاضای یکسان. تنها تفاوتِ نتیجه از کیفیتِ **Matcher** می‌آید — عدالتِ کامل.
- سشن‌ها **in-memory** و گذرا هستند؛ با ری‌استارت پروسه پاک می‌شوند.

سه جزء:
- **Engine** (`src/`): هستهٔ شبیه‌سازی. `SessionManager` چند نمونه را نگه می‌دارد.
- **UI** (`public/`): گرید زندهٔ همهٔ دنیاها؛ کلیک روی هر کارت → نمای کامل (مودال).
- **Matcher / Client** (`client/`): کد شرکت‌کننده. هر کلاینت به یک session وصل می‌شود.

## ۲. ساختار فایل‌ها

| فایل | نقش |
|------|-----|
| `src/config.ts` | پارامترهای قابل تیون (با override از env) |
| `src/types.ts` | تایپ‌های مشترک |
| `src/geometry.ts` | فاصله، حرکت، تابع رِیتینگ |
| `src/world.ts` | حالت دنیا + منطق یک step |
| `src/engine.ts` | حلقهٔ session + بافر تخصیص + ماتچرِ داخلیِ اختیاری (`autoMatch`) |
| `src/session-manager.ts` | مدیریت چند Engine هم‌زمان |
| `src/server.ts` | سرور HTTP REST + سرو کردن UI |
| `public/` | UI گرید + مودال |
| `client/sample-client.ts` | Matcher مرجع (per-session) |

## ۳. چرخهٔ یک cycle (در هر Engine)

هر `CYCLE_MS`:
1. اگر `autoMatch` روشن باشد، تخصیص‌ها را خودِ Engine (greedy) می‌سازد؛ وگرنه از تخصیص‌های دریافتیِ Matcher استفاده می‌کند.
2. `world.step()`: حرکت، pickup، رِیتینگ، تکمیل، کنسل، خواب/بیداری، تولید درخواست.
3. snapshot جدید منتشر می‌شود.
4. `tick >= SESSION_TICKS` ⇒ status = `finished`.

## ۴. API

پایه: `http://localhost:8080` (یا `PORT`). JSON، CORS باز.

### مدیریت سشن‌ها
| متد و مسیر | کار |
|-----------|-----|
| `POST /sessions` | ساخت + شروعِ خودکار. body اختیاری `{ "auto": true }` (ماتچرِ داخلی). → `{ id, status }` |
| `GET /sessions` | لیست همهٔ دنیاها — آرایه‌ای از vizState کامل (برای گرید UI) |
| `DELETE /sessions/:id` | حذف سشن |
| `POST /sessions/:id/start` | شروع/ادامه |
| `POST /sessions/:id/reset` | ریست |

### رابط Matcher (هر سشن)
| متد و مسیر | کار |
|-----------|-----|
| `GET /sessions/:id/state` | snapshotِ قابل‌تصمیم: `idleDrivers` + `openRequests` + `config` + `tick` |
| `POST /sessions/:id/assign` | body: `{ "tick", "assignments": [{ "driverId", "tripId" }] }` |
| `GET /sessions/:id/viz` | وضعیت کاملِ یک دنیا (همهٔ رانندگان + سفرها + scoreboard) |

- پاسخِ `/assign`: اگر `tick` قدیمی باشد → ۴۰۹.
- `viz`/`/sessions` شاملِ `stepPerCycle` و `cycleMs` است تا UI انیمیشن را دقیق و هم‌گام پیش‌بینی کند.

## ۵. اجرا

```bash
npm install
npm run engine         # cycle ۳۰ ثانیه (مسابقهٔ واقعی)
npm run engine:fast    # cycle ۵ ثانیه (دمو/توسعه)
npm run client         # یک Matcher که خودش یک دنیای جدید می‌سازد و می‌راند

# چند دنیای هم‌زمان با ماتچرِ بیرونی:
SESSION_ID=s2 npm run client    # وصل‌شدن به دنیای موجودِ s2

# UI: http://localhost:8080/  →  «دنیای جدید (auto)» یا کلاینت‌ها را وصل کن
```

تیون با env: `CYCLE_MS`, `DRIVER_SPEED`, `RIDER_ARRIVAL_RATE`, `DRIVER_COUNT`, `SEED`, …

## ۶. عدالت و تکرارپذیری

- همهٔ سشن‌ها با `SEED` یکسان ساخته می‌شوند ⇒ موقعیت اولیهٔ رانندگان و توالیِ درخواست‌ها یکسان است.
- برای رتبه‌بندی: هر شرکت‌کننده روی یک سشن جدا با همان seed؛ سپس `scoreboard` ها مقایسه می‌شوند.

## ۷. کارهای باقی‌مانده (Roadmap)

- [ ] تیون پارامترها (سرعت، نرخ ورود، کرایه) — فعلاً placeholder.
- [ ] فرمول نهایی امتیاز مسابقه + نمایش رتبه‌بندی بینِ سشن‌ها.
- [ ] احراز هویت/مالکیتِ سشن (الان هرکس به هر سشن دسترسی دارد).
- [ ] پایداریِ سشن‌ها (الان in-memory و با ری‌استارت پاک می‌شوند).
- [ ] حالت headless/batch برای اجرای خودکارِ چند seed.
- [ ] محدودیت زمان پاسخ Matcher در هر cycle + ثبت لاگ برای replay.
