# Product Umbrella — текущее состояние

Свой трекер рекламных кампаний (аналог Keitaro) на `https://nespizdili.lol/umbrella`, репозиторий `ButherWoW/product-umbrella`. С bananabun общий только nginx: своя база, свои пользователи, свой сервис. Это документ о том, **как всё устроено сейчас**; история задач, ревью и переписки до 2026-10-30 — в [`docs/history/HANDOFF-2026-10-30.md`](docs/history/HANDOFF-2026-10-30.md).

## Архитектура

- **Node 20 без фреймворков.** `src/server.js` — HTTP-сервер: трекинг, API панели, отчёты. Рядом модули: `auth.js` (пользователи, сессии, API-ключи), `conversion-recorder.js`, `conversion-cap.js`, `stats-report.js`, `event-logs.js`, `event-mirror.js` (запись событий в PostgreSQL), `monitor.js`, `retention.js`, `source-postback.js`, `visitor-binding.js`, `currency.js`, `db.js` (пул PostgreSQL), `journal.js` (чтение/дозапись `events.jsonl`, оборванные строки), `log-file.js` (`LOG_FILE`), `connection-type.js`, `rate-limit.js` (лимиты трекинга и входа), `stream-policy.js` (запрет клоакинга: фильтры потоков по ботам и дата-центрам не сохраняются; тот же файл отдаётся панели как `/admin/stream-policy.js`), `migrate.js`.
- **Трекинг (публично):** `/r/:campaign` (потоки → лендинг → оффер), `/r/:campaign/:offer`, `/lp/click`, `/postback`, `/health`. Домены трекинга — `deploy/domains.txt`; на них открыт только трекинг.
- **Панель:** одностраничное приложение `public/admin/` (vanilla JS, DOM только через `h()`/`put()`, без `innerHTML` с данными) с адресами-путями: `/login`, `/dashboard`, `/campaigns/<id>`, `/reports?group=…` (под `BASE_PATH`). Сервер отдаёт одну оболочку на пути из `src/panel-routes.js`; новый раздел — добавить в `PANEL_SECTIONS` и в `PAGES` в `admin.js` (`test/panel-routes.test.mjs` сверяет). `/admin` и `/admin/` — `302` на `/` (старые `#/…` ссылки панель переводит в пути).
- **Публичное демо `/demo`** (`/umbrella/demo/…`): та же оболочка с пометкой демо, без входа и без API — запросы панели в браузере отвечает `public/admin/demo.js` выдуманными данными, записи получают 403 «Хуй тебе» (README, «Панель»). Новый эндпоинт, который читает панель, нужно добавить и в `ROUTES` в `demo.js`, иначе раздел демо покажет ошибку (`test/ui/demo.mjs` обходит все разделы).
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

## Задача dev2 (2026-11-02): статус входа в FB у профилей на сервере — в репозитории bananabun

Это задача **не в Umbrella**, а в `ButherWoW/bananabun`. Полное описание — запись `@dev2 2026-11-02` в `docs/HANDOFF.md` bananabun. Зачем: профиль AdsPower на нашем сервере может быть не залогинен в Facebook (сессия осталась на Маке), и платформа узнаёт это только при заливе. Нужно показывать это заранее.

По шагам:

1. `git clone https://github.com/ButherWoW/bananabun` (или `git fetch` в своей копии), прочитай `CLAUDE.md` и верхнюю запись `@dev2` в `docs/HANDOFF.md`.
2. Ветка от свежего main: `git checkout -b dev2-fb-session origin/main`.
3. Бронь: допиши в `docs/HANDOFF.md` bananabun запись `@claude`, что берёшь файлы из списка «Бронь» (журнал правится только в main — запись короткая, отдельным коммитом в main или попроси Claude).
4. Агент — `mac-agent/lib/fbprofile.js`, функция `openFbSession`: когда токена нет, по адресу вкладки определить причину и бросить ошибку с полем `code`: `fb_logged_out` (адрес содержит `/login` или `/loginpage`), `fb_checkpoint` (`/checkpoint`), иначе `fb_timeout`. Текст ошибки оставить как есть. Передать `code` в результате задач `check-profile` и `push` (`mac-agent/bananabun_agent.js`).
5. Тест агента: `mac-agent/test/fbsession.test.js` — разбор адресов без сети (вынеси разбор в отдельную функцию). Запуск: `node --test mac-agent/test/`.
6. Миграция `platform/backend/src/db/migrations/039_fb_session.sql`: в `fb_accounts` поля `fb_session TEXT DEFAULT 'unknown'` и `fb_session_at TIMESTAMPTZ`.
7. Сервер — `platform/backend/src/api/routes/agent.js`, приём результата `check-profile`: успех → `fb_session='ok'`; ошибка с `code` → `logged_out` / `checkpoint` / `timeout`; плюс `fb_session_at=NOW()`. `GET /api/accounts` должен отдавать оба поля.
8. Тест сервера на временной PostgreSQL (как `platform/backend/test/buyer-access.test.js`): результат агента с `code: 'fb_logged_out'` → у аккаунта `fb_session='logged_out'`. Запуск: `BANANABUN_TEST_DATABASE_URL=postgres://…/bb_test npm test --prefix platform/backend` (имя базы должно кончаться на `_test`).
9. Фронт «Аккаунты»: бейдж у аккаунта — зелёный «FB вход есть», красный «Не залогинен на сервере», жёлтый «Чекпоинт». У красного — «?» с текстом: «Открой профиль в AdsPower на Маке, проверь, что Ads Manager открывается, и закрой профиль — сессия уйдёт на сервер. Потом нажми «Проверить»».
10. Фронт «Залив» (`PushWizard`, шаг «Кабинет»): если у профиля выбранного кабинета `fb_session` не `ok` — жёлтое предупреждение с той же подсказкой над «Далее». Залив не блокировать.
11. Проверка: `npm run build --prefix platform/frontend` без ошибок, все тесты зелёные.
12. PR в `main` bananabun с описанием, что сделано и как проверено. Выкатывает Claude — сам на сервер не выкатывай.

Нельзя: вводить или хранить пароли, 2FA, куки; выводить токены FB, заметки профилей, прокси. `services/push.js` и `api/routes/push.js` не трогать — нужна правка там, пиши `@claude`.
