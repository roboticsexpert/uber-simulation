# 🚕 Uber-Sim — Matching Arena

پلتفرم یک مسابقهٔ کدنویسی: شرکت‌کننده‌ها الگوریتم **Matching** (تخصیص راننده به مسافر) را در یک شبیه‌سازی زندهٔ Uber می‌نویسند.

## شروع سریع

```bash
npm install
npm run engine:fast     # engine + UI روی http://localhost:8080  (cycle سریع برای تست)
npm run client          # در ترمینال دیگر: Matcher نمونه
```

سپس `http://localhost:8080/` را باز کن و **▶ شروع** را بزن.

برای اجرای واقعی مسابقه `npm run engine` (cycle = ۳۰ ثانیه، session = ۲ ساعت).

## این چیه؟

- **Engine** دنیایی با راننده و مسافر را شبیه‌سازی می‌کند و هر cycle جلو می‌برد.
- **UI** نقشهٔ زنده را نشان می‌دهد (رانندگان، درخواست‌ها، جدول امتیاز).
- **Matcher** کلاینت شرکت‌کننده است: `GET /state` می‌گیرد، تصمیم می‌گیرد، `POST /assign` می‌فرستد.

شرکت‌کننده فقط تابع `decide()` در [`client/sample-client.ts`](client/sample-client.ts) را عوض می‌کند (یا با هر زبانی همان دو endpoint را صدا می‌زند).

## مستندات

- 📖 [قوانین بازی](docs/GAME_DESIGN.md) — راننده، مسافر، هزینه، رِیتینگ، خواب.
- 🔧 [معماری پلتفرم و API](docs/PLATFORM.md) — endpointها، چرخهٔ cycle، اجرا، تیون.

## وضعیت

نسخهٔ اولیهٔ کارکننده. پارامترها (سرعت، نرخ ورود، کرایه) فعلاً placeholder و قابل تیون با env‌اند — به roadmap در سند پلتفرم نگاه کن.
