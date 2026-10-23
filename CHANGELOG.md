# Changelog

## 2.2.1
- `server2browser`: importهای نسبی داخل `server.ts` (مثل `./src/utils/x`) برای مکان جدید بازنویسی می‌شوند؛ بدون این، پروژه‌هایی که سرورشان کد پروژه را import می‌کند (مثل Code Converter Pro) بیلد نمی‌شدند.

## 2.2.0
- **PWA pass-through** (`pwasite.mjs`): پروژه‌ای که خودش PWA قابل‌نصب است (manifest + service worker، یا CSP سخت که اسکریپت inline را ممنوع می‌کند) دیگر در یک HTML ادغام نمی‌شود؛ همان‌طور که هست در `outputs/<name>/` کپی می‌شود و `outputs/<name>.html` فقط یک راه‌انداز است. بدون تغییر workflow.
- خروجی روی یک سرور محلی در Chromium تست می‌شود (نه فقط file://) تا CSP/ماژول/sw واقعی بررسی شود.
- آیکن‌هایی که کنار پوشه‌ی پروژه در ریشه‌ی zip هستند و در index/manifest به آن‌ها اشاره شده، خودکار کپی می‌شوند.
- هشدار برای مسیرهای مطلق `/` در manifest و ثبت sw. غیرفعال‌سازی: `--no-pwa`.

## 2.1.0
- `server2browser` عمومی شد: هر Express (نه فقط Gemini)؛ `:params`، `Router()`، middleware، `fs`/`path`/`crypto` مجازی، تنظیمات `process.env` در ⚙︎، Base URL برای Gemini، حذف خودکار `startServer`.
- مرحله‌ی تست خودکار: خروجی هر روش در Chromium باز و بررسی می‌شود؛ خروجی خراب → روش بعدی؛ گزارش هاست‌های نیازمند اینترنت.
- تست محلی: ۸ routeی Content Studio تبدیل‌شده در Node اجرا شد (media/generate و fallback متن فارسی جواب دادند). تست کامل Action روی GitHub هنوز انجام نشده.

## 2.0.0
- **جدید:** `server2browser.mjs` — پروژه‌ی Express + Gemini (`server.ts` با `/api/*` و `@google/genai`) قبل از بیلد به یک فرانت‌اند خالص تبدیل می‌شود؛ مسیرهای `/api` داخل مرورگر اجرا می‌شوند. در خروجی دکمه‌ی ⚙︎ برای کلید Gemini و Base URL (فقط روی همان دستگاه). غیرفعال‌سازی: `--no-browser-server`.
- عکس‌هایی که سرور با مسیر `/src/...` اشاره می‌کرد حالا داخل خود HTML جاسازی می‌شوند.
- نام برنامه‌ی PWA و عنوان صفحه «AnyHTML v2» شد تا کنار نسخه‌ی قبلی روی هوم‌اسکرین قابل تشخیص باشد.
- هنوز روی GitHub واقعی اجرا نشده؛ ماژول جدید روی زیپ Content Studio تست محلی شده.

## 1.0.0
- نسخه‌ی اولیه: build / static / serve / explorer.
