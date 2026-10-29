# Product Umbrella — текущее состояние

Свой трекер рекламных кампаний (аналог Keitaro) на `https://nespizdili.lol/umbrella`, репозиторий `ButherWoW/product-umbrella`. С bananabun общий только nginx: своя база, свои пользователи, свой сервис. Это документ о том, **как всё устроено сейчас**; история задач, ревью и переписки до 2026-10-30 — в [`docs/history/HANDOFF-2026-10-30.md`](docs/history/HANDOFF-2026-10-30.md).

## Архитектура

- **Node 20 без фреймворков.** `src/server.js` — HTTP-сервер: трекинг, API панели, отчёты. Рядом модули: `auth.js` (пользователи, сессии, API-ключи), `conversion-recorder.js`, `conversion-cap.js`, `stats-report.js`, `event-logs.js`, `event-mirror.js` (запись событий в PostgreSQL), `monitor.js`, `retention.js`, `source-postback.js`, `visitor-binding.js`, `currency.js`, `rate-limit.js` (лимиты трекинга и входа), `stream-policy.js` (запрет клоакинга: фильтры потоков по ботам и дата-центрам не сохраняются; тот же файл отдаётся панели как `/admin/stream-policy.js`), `migrate.js`.
- **Трекинг (публично):** `/r/:campaign` (потоки → лендинг → оффер), `/r/:campaign/:offer`, `/lp/click`, `/postback`, `/health`. Домены трекинга — `deploy/domains.txt`; на них открыт только трекинг.
- **Панель:** `/admin` — одностраничное приложение `public/admin/` (vanilla JS, DOM только через `h()`/`put()`, без `innerHTML` с данными). Старая страница `/dashboard` удалена — адрес отвечает `302` на `/admin`.
- **API:** источник истины — [`docs/openapi.json`](docs/openapi.json). `test/openapi.test.mjs` сверяет его с `src/server.js` в обе стороны, таблица API в README генерируется `node scripts/gen-api-table.mjs`. Новый маршрут = запись в openapi.json (с `x-summary-ru`) + перегенерация таблицы, иначе CI красный.
- **Переменные окружения** — все перечислены в `.env.example` (проверяет `test/env-example.test.mjs`).

## Хранилища

- **Журнал событий `DATA_DIR/events.jsonl` — источник истины** для кликов, конверсий, ботов, постбэков, расходов. При `DATABASE_URL` каждое событие дублируется в PostgreSQL (`event-mirror.js`, по порядку для одного клика); отчёты читают PostgreSQL, при ошибке базы — журнал. Путь клика не читает журнал целиком: счётчики, последние клики и конверсии — в памяти (`src/journal-index.js`), отчёты читают журнал потоком. Временные ошибки записи в базу повторяются, а `src/reconcile.js` при старте и каждые 15 минут досылает в базу всё, чего там нет (сверка по `event_id`).
- **Сущности** (кампании, офферы, лендинги, источники, сети, пользователи, сессии, API-ключи): в PostgreSQL при `DATABASE_URL`, иначе JSON-файлы в `DATA_DIR`. Настройки команды — `settings.json`, курсы валют — `fx-rates.json`.
- **PostgreSQL на проде:** своя роль и база `umbrella`, только `127.0.0.1`, пароль создаёт `deploy/setup-db.sh` на сервере. Прямого доступа к базе нет ни у кого из агентов — прод проверяется деплоем (`/health` → `"storage":"postgres"`). Схема — `src/migrate.js` (идемпотентно); `schema.sql` — справочно.

## Роли

- **В продукте:** `owner` (всё, пользователи, ключи, очистка статистики), `buyer` (только свои кампании; флаги `hideRevenue`, `offersAccess: own`), `viewer` (только чтение; `viewAll`). Плюс `ADMIN_TOKEN` (Bearer) для скриптов и личные API-ключи `umb_…`. У офферов, лендингов, источников и сетей есть владелец записи (`ownerId`, `null` = командная): баер правит только свои. Любой новый эндпоинт с данными кампаний обязан учитывать `scopeCampaigns(req)` / `campaignScope(...)`.
- **В команде:** владелец — мержит PR и решает спорное; Claude — архитектура, безопасность, деплой, ревью, `src/auth.js`, `deploy/*`, `.github/*`, выбор потока и клик; GPT — конверсии и статистика (`conversion-recorder`, `event-logs`, `stats-report`); dev2/dev3 — UI-задачи в `/admin` по описанию.

## Деплой и бэкапы

- **Деплой только через GitHub Actions** (`.github/workflows/deploy.yml`) и только из `main` (push или ручной запуск на `main`; ключ хоста закрепляется секретом `SSH_KNOWN_HOSTS`). Релизы: каждый коммит — `/opt/umbrella/releases/<sha>`, `/opt/umbrella/app` — ссылка на живой (`deploy/release.sh`: build → дамп базы `pre-deploy-<sha>.dump` → миграции → переключение, рестарт `umbrella.service` (порт 4110) и проверка `/health`; не поднялся — автоматический откат на прошлый релиз; хранятся 3 релиза). Дальше: проверка, что сервис на PostgreSQL, GeoIP (DB-IP, раз в месяц), nginx с откатом при ошибке, домены трекинга с Let's Encrypt, публичная проверка. Прямой SSH на прод агентам не нужен и не используется.
- **Бэкапы:** `umbrella-backup.timer` каждую ночь в 03:30 UTC — `pg_dump -Fc` + снимок `DATA_DIR`, 14 дней в `/opt/umbrella/backups` (только root); сбой пишется в `backups/LAST_FAILED`. Раз в месяц `umbrella-restore-test.timer` восстанавливает последний дамп во временную базу и проверяет таблицы. Восстановление, откат схемы и очистка статистики — README, «Бэкапы» и «Очистка статистики».

## Как работать

1. **В `main` не пушить никогда.** Ветка `<кто>/<задача>` от свежего `origin/main` → PR. Мержит владелец (или Claude по поручению) только при зелёном CI.
2. **CI на каждый PR** — три job, деплой ждёт все: `test` (`node --check` всех файлов, запрет BOM, `npm test` — unit-тесты, openapi, таблица API, `.env.example`, smoke), `postgres` (миграции с нуля дважды + `test/postgres*.test.mjs` на чистом PostgreSQL), `ui` (Playwright: `npm run test:ui` — файлы `test/ui/*.mjs` параллельно).
3. **Никогда не заменять файл своей старой копией** и не копировать файлы из старых веток: `git fetch && git rebase origin/main` (или merge), конфликты — построчно, сохраняя чужие строки. Перед PR смотреть `git diff origin/main...HEAD`: удалённых чужих строк быть не должно. Файлы — только в `src/`, `test/`, `scripts/`, `public/`, `deploy/`, `docs/`.
4. **Браузерные тесты:** каждый файл `test/ui/*.mjs` поднимает свой сервер, каталог данных и браузер через `test/ui/setup.mjs` (`runUi`, `openWithKey`, `rowCells`, `pageOverflow`) и не зависит от других файлов. Новая проверка панели — новый файл в `test/ui/` или блок в конце подходящего файла со своими данными; без `waitForTimeout`, только явные ожидания. Локально: `PLAYWRIGHT_MODULE=… npm run test:ui`.
5. **Файлы не писать через PowerShell** (BOM, съеденные кавычки). Отчёт о работе — в описание PR, не в этот файл. HANDOFF.md меняется только при изменении архитектуры, правил или списка открытых вопросов.

## Открытые вопросы

- **Старые PR без действия:** #18 (сети, GPT), #32 (D11), #34 (D12), #37 (D13), #52 (D18) — функциональность уже в `main` другими PR; закрыть или пересобрать — решает владелец.
- **Задачи владельца (README, «Деплой» и «Бэкапы»):** секрет `SSH_KNOWN_HOSTS`; маска `secret=` в access-логе nginx; выбор хранилища для копии бэкапов вне сервера (сейчас бэкапы только на том же сервере).
- **Боевые конверсии ещё идут в Keitaro:** офферы перенесены `scripts/import-keitaro-offers.mjs`, но постбэк партнёрки на Umbrella не переключён — переключает владелец.
