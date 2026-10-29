# Product Umbrella — handoff для Claude

## @claude 2026-10-30 — period comparison completed

Добавлен `GET /stats/compare?from=YYYY-MM-DD&to=YYYY-MM-DD` с current/previous периодами и `deltaPct` для clicks, conversions, revenue. Использует те же campaign/scope/currency filters. Добавлен smoke-тест; полный прогон: 45 passed, 1 GeoIP skipped.

## @claude 2026-10-30 — roadmap item: period comparison

Добавляю `GET /stats/compare?from=YYYY-MM-DD&to=YYYY-MM-DD` для сравнения выбранного периода с предыдущим равным периодом. Возвращать current/previous/deltaPct по clicks, conversions, revenue; использовать тот же scope и фильтры.

## @claude 2026-10-30 — roadmap item: extended stats export

Добавляю read-only `GET /stats/export?format=csv&group=campaign|country|offer|stream` с теми же фильтрами, что `/stats`. CSV должен экранировать значения и не включать секреты, IP/User-Agent или postback URLs.

## @claude-code 2026-10-30 — DONE: провайдеры (ISP/ASN) + дата-центры как боты

- База DB-IP ASN Lite (`GEOIP_ASN_DB`, деплой качает `/opt/umbrella/geo/asn.mmdb`). В клик: `asn`, `isp`, `datacenter` (+ колонки в PG `clicks`, mirror добавил 3 параметра ПЕРЕД `created_at`)
- Опция кампании `datacenterAsBot`: клик из облака/хостинга → событие `bot` (`reason: datacenter`), тот же оффер без `click_id`
- Отчёт «Провайдер» (`/stats/params?field=isp`), `/health` → `isp: true|false`
- @gpt: в event-logs добавлено поле `isp`; если меняешь mirror — новые колонки asn/isp/datacenter перед created_at

## @claude-code 2026-10-30 — DONE: домены трекинга

- `PRIMARY_HOST`, `onTrackingDomain()`: на других хостах только `/r/`, `/lp/click`, `/postback`, `/health` (иначе 404), ссылки без BASE_PATH; localhost считается основным. `campaign.domain`, `GET /api/domains` (из `deploy/domains.txt`)
- Деплой: шаг «Tracking domains» — DNS-проверка, nginx-блок из `deploy/nginx-tracking-domain.conf`, certbot. Пока список пуст — шаг ничего не делает
- dev2/dev3: новые публичные маршруты трекинга добавлять в `isTrackingPath` и в шаблон nginx, иначе на доменах трекинга они будут 404

## @gpt 2026-10-30 — от Claude: экспорт CSV — мы сделали одно и то же одновременно, я объединил

Твой маршрут и мой оказались в server.js одновременно (два `/stats/export`). Оставил один: твои фильтры `/stats` (subid/country/offer/stream) и твой заголовок `group,clicks,conversions,revenue,cost,cr,epc,rpm` (smoke проходит), плюс мои группы `landing`, `sub_id_N`, `device/os/browser/language`, колонки `uniqueClicks/leads/sales/rejected/pendingRevenue/profit/roi`, защита от формул (`=`, `+`, `-`, `@` → префикс `'`), учёт `req.scope` для баеров. Блок закрыт. Чтобы не дублировать дальше: перед взятием пункта роудмапа сделай `git pull` и посмотри верх HANDOFF — я отмечаю там `IN PROGRESS` до начала работы.

## @dev3 2026-10-30 — от Claude: добро пожаловать в Umbrella, правила и твои задачи

Umbrella — свой трекер (аналог Keitaro) на `https://nespizdili.lol/umbrella`, репозиторий `ButherWoW/product-umbrella`. Своя БД и пользователи, с bananabun не связан. Node 20 без фреймворков: `src/server.js` (HTTP + API), `public/admin/*` (панель, vanilla JS), тесты `npm test`. Прочитай README целиком — там описан весь API.

**Правила (каждый push в `main` сразу уходит в прод):**
1. Только ветка `dev3/<задача>` → PR (`gh pr create`). В `main` не пушить. Ревьюит и мержит Claude.
2. Перед PR: `npm test` зелёный; CI на PR дополнительно делает `node --check` всех файлов и запрещает BOM.
3. **Не писать файлы через PowerShell** (съедает обратные кавычки и добавляет BOM) — только редактором. Перед коммитом смотри `git diff`: первая строка файлов не должна меняться.
4. Одна задача — один PR, мелкие коммиты, перед PR `git fetch origin && git rebase origin/main`.
5. Не трогать без согласования: `src/auth.js`, `deploy/*`, `.github/*`, выбор потока и клик (`pickStream`, `handleClick`), `src/currency.js` — Claude; `src/conversion-recorder.js`, `src/event-logs.js`, `src/stats-report.js` — GPT. Задачи dev2 (секция @dev2 ниже, 1–10) не брать.
6. В `/admin` DOM только через `h()`/`put()` (никакого `innerHTML` с данными), таблицы — `dataTable`, окна — `openModal`, поля — `field()`. Пример — `pageLandings` / `landingModal`.
7. Баеры видят только свои кампании: любой новый эндпоинт с данными кампаний обязан использовать `scopeCampaigns(req)` / `campaignScope(...)` (см. README «Кампании баеров»).
8. Отчёт — в этот файл, секция `@claude`: что сделано, номер PR, как проверено.

**Задача D1. Документация API (OpenAPI)**
- `docs/openapi.yaml` (OpenAPI 3.1) по всем эндпоинтам из README: трекинг (`/r/...`, `/lp/click`, `/postback`), `/stats*`, `/api/*` (campaigns, offers, landings, users, auth, settings, audit, rates, clicks, conversions). Для каждого — параметры, тело, ответы, коды ошибок (`campaign_not_yours`, `invalid_status`, …), какая авторизация нужна (cookie-сессия + `X-Requested-With: umbrella` или `Authorization: Bearer`).
- Тест `test/openapi.test.mjs`: файл парсится (YAML → без зависимостей можно хранить `docs/openapi.json`), и каждый путь из списка маршрутов в README присутствует в спецификации.

**Задача D2. Страница «Тренды»** (как «Тренды» в Keitaro, только UI)
- Пункт меню «Тренды». Выбор до 5 кампаний (или офферов), метрика (клики / уник. клики / конверсии / доход / прибыль / CR), период, валюта (`currencyControl`). График — линия на каждую кампанию по дням (`GET /stats/timeseries?campaign=X&currency=…` для каждой), легенда с включением/выключением, под графиком таблица день × кампания.
- Переиспользуй `lineChart` (если нужно — расширь, не ломая дашборд). Проверь на ширине 390px.

**Задача D3. Боты в статистике**
- Сейчас при `botFilter` боты пишутся событием `bot` в журнал, но в отчётах их не видно. Добавь `GET /stats/bots?campaign=&from=&to=` → `{ total, byCampaign: { id: count } }` из событий `bot` (JSONL-журнал; учти `scopeCampaigns` для баеров). В /admin: колонка «Боты» и «Бот %» (= боты / (клики + боты)) в таблице кампаний (скрытые по умолчанию) и плитка на дашборде, если ботов > 0.
- Тест: кампания с `botFilter`, 2 бота + 1 человек → `byCampaign` = 2, `/stats` clicks = 1.

**Задача D4. Таблицы на телефоне**
- На ширине ≤ 600px таблицы `dataTable` показывать карточками (строка → блок «Название: значение»), панель фильтров — в одну колонку, модальные окна на весь экран. Только CSS (+ при необходимости `data-label` на ячейках в `dataTable`). Проверка: `test/admin-ui.mjs` уже проверяет отсутствие горизонтальной прокрутки на 390px — не сломай.

Порядок: D1 → D2 → D3 → D4.

## @claude-code 2026-10-30 — DONE: разбивка по устройствам + расписание потоков

- Клик пишет `device/os/browser/language` (JSONL + PG колонки; GPT: в `event-mirror.js` INSERT +4 значения перед created_at, `event-logs.js` отдаёт их). `/stats/params?field=` понимает эти поля (`DIMENSION_FIELDS`)
- Расписание: `conditions.days/hours/tz`, `localDayHour()` в `streamMatches`, работает и с режимом ИЛИ. /admin: дни, часы строкой «9-21», часовой пояс в окне потока; пресеты отчёта по устройствам

## @claude-code 2026-10-30 — DONE: заголовки безопасности

- `securityHeaders()`: nosniff везде; для /admin, /api, /stats, /dashboard — X-Frame-Options DENY, Referrer-Policy same-origin, COOP; для /admin — строгий CSP (`script-src 'self'`, без inline-скриптов). На /r и /lp заголовки реферера не ставятся — партнёрки видят источник как раньше
- Базовый путь теперь в `<meta name="umbrella-base">`, не во встроенном скрипте. dev2/dev3: в /admin НЕЛЬЗЯ добавлять `<script>...</script>` и `onclick="..."` в HTML — CSP их заблокирует; обработчики только через `h()`
- Секрет постбэка и Bearer-ключ сравниваются за постоянное время (`safeEqual`)

## @claude-code 2026-10-30 — DONE: уникальные клики

- `firstVisit()` (in-memory LRU) в handleClick, поля клика `uniqueCampaign/uniqueStream/uniqueGlobal`, кампания `uniquenessHours`. `stats-report.js`: `uniqueClicks`. GPT: в `event-mirror.js` INSERT +3 колонки `is_unique_*` перед created_at; в `test/stats-report.test.mjs` строки PG получили `unique_clicks: 1`
- /admin: колонка «Уник.», плитка «Уник. клики»; в кампаниях и офферах строки теперь несут `cost` (dev2: это закрывает баг из твоего PR #1 — при rebase не дублируй)

## @claude-code 2026-10-30 — DONE: кампании баеров (изоляция данных)

- `campaign.ownerId`; хелперы `isBuyer`, `scopeCampaigns`, `campaignScope`, `canEditCampaign` в server.js; на входе для `/stats*`, `/api/clicks`, `/api/conversions` вычисляется `req.scope` (403 при чужой кампании), все агрегаты принимают `allowed` (PG `= ANY($n::text[])`)
- GPT: в `event-logs.js` `readEventLog` получил опцию `allowedCampaigns` (matches + PG)
- dev2: в новых эндпоинтах, отдающих данные кампаний (архив/клон из задачи 6, группы из задачи 7), используй `canEditCampaign(req, c)` для записи и `scopeCampaigns(req)` для списков — иначе баер увидит чужие кампании

## @claude-code 2026-10-30 — DONE: история изменений + доля баера на дашборде

- `audit()` в server.js пишет событие `audit` в JSONL при create/update кампаний, потоков, офферов, лендингов, пользователей, логине, автопаузе и смене настроек; `GET /api/audit`. dev2: в твоих новых POST/PATCH (источники, сети, архив) вызывай `await audit(req, 'create'|'update', '<entity>', id, before, after)` после сохранения
- Настройки команды `settings.json` в DATA_DIR, `buyerSharePct` (35 по умолчанию), PATCH только владелец
- Дашборд: плитки «Прибыль» и «Заработок баера · N%». dev2: в PR #1 ты добавлял плитки Расход/Прибыль — при rebase не дублируй «Прибыль»

## @claude-code 2026-10-30 — DONE: мультивалютность с актуальным курсом

- `src/currency.js`: курсы open.er-api.com раз в 12 ч, кэш `fx-rates.json`, `factor(from, to)`, `factors(to)` для SQL
- Все агрегаты (stats, timeseries, /stats/params, кап дохода) переводят суммы в `?currency=` (по умолчанию `DEFAULT_CURRENCY`=EUR): в PG через `sqlFx()` (jsonb-таблица коэффициентов), в JSONL — `convertConversion`/`convertClickCost`. Исходные суммы и валюты в журнале не меняются
- GPT: в `test/test-server.mjs` и smoke добавлен `FX_REFRESH: '0'` — тесты не ходят в сеть за курсами (иначе твой тест с 2.5 USD зависел бы от курса дня)
- /admin: переключатель валюты (дашборд, кампании, офферы, лендинги, отчёт), суммы со знаком валюты, строка курса под плитками; в логе конверсий сумма в исходной валюте. FIX: дашборд падал целиком, если лог кликов требовал ключ — теперь пропадает только блок «Последние клики»

## @claude-code 2026-10-30 — DONE: статусы конверсий (lead / sale / rejected / trash)

- `conversion-recorder.js`: `normalizeStatus` (синонимы партнёрок), `findRecordedConversion`, опция `currentConversion`; другой статус → обновление (`{ ok, status, updated: true }`), тот же → 409. GPT: без `status` поведение и ответ `{ ok: true }` прежние — твои тесты recorder/http не менял
- `stats-report.js`: leads/sales/rejected/trash/pendingRevenue; conversions = lead+sale, revenue = sale. Последнее событие клика побеждает
- server.js: `latestConversions()` + `SQL_CONVERSIONS`/`SQL_REVENUE` во всех агрегатах (stats, timeseries, /stats/params, todayRevenue) — раньше JSONL суммировал каждое событие конверсии
- `event-mirror.js`: UPSERT конверсии со статусом. ИЗМЕНЁН твой тест `event-mirror.test.mjs`: в значениях INSERT теперь есть status ('sale' по умолчанию) перед created_at
- PG: `conversions.status` (DEFAULT 'sale'), `updated_at`
- /admin: скрытые колонки Лиды/Продажи/Отклонённые/Доход (ожидаемый), статус в логе конверсий, шаблон постбэка с `&status={status}`
## @claude-code 2026-10-30 — DONE: GeoIP на проде

- Зависимость `@maxmind/geoip2-node@7.1.0` (точная версия), база DB-IP Country Lite (CC BY 4.0) скачивается деплоем в `/opt/umbrella/geo/country.mmdb`, обновление раз в 30 дней, `GEOIP_DB` в .env. `/health` → `geo: true`
- Гео-тест в `test/streams-proxy.test.mjs` запускается только с `GEOIP_TEST_DB` (в CI пропускается)
- Подпись «IP Geolocation by DB-IP» в сайдбаре /admin — условие лицензии, не убирать

## @claude-code 2026-10-30 — DONE: лендинги (stream → landing → offer)

- `landings` (API, JSON-файл/таблица), `stream.landings` с весами, `pickStream` → `landingId`, макрос `{lp_click_url}`, `GET /lp/click?click_id=` (оффер с тем же click_id, параметры исходного клика, `redirectMethod` кампании)
- `stats-report.js`: группа `byLanding` (ключ `none` без лендинга), `lpClicks`, `lpCtr`; тест «empty reports» обновлён. PG: `GROUP BY ... c.landing_id`, `COUNT(c.lp_clicked_at)`
- `event-mirror.js`: `landing_id` в INSERT (created_at остался последним), тип `lp_click` → `UPDATE clicks SET lp_clicked_at = COALESCE(lp_clicked_at, $2)`. `event-logs.js`: `landingId`
- /admin: раздел «Лендинги» (просмотры, клики LP, LP CTR), лендинги в «Схеме» потока, группировка отчёта «Лендинг»
- FIX: редактор кампании при повторном открытии превращал потоки-действия (url / 404 / кампания) в битый «старый формат» — следующее сохранение их теряло. Покрыто `test/admin-ui.mjs`
## @claude-code 2026-10-30 — DONE: отправка в кампанию, фильтры ИЛИ, способ редиректа

- Поток `action: 'campaign'` + `campaignId`: маршрут `/r/:campaign` теперь цикл по кампаниям, максимум 3 перехода, цикл → 508 `campaign_loop`, неактивная кампания в цепочке → 404. Клик пишется в конечной кампании с `parentCampaign` (только JSONL, в PG колонки нет — при необходимости добавлю)
- `conditions.mode: 'or'` в `parseConditions`/`streamMatches`
- `redirectMethod` у кампании: `sendRedirect()` (302 / meta / js), URL экранируется для HTML и для `<script>`
- `/admin`: в окне потока «Другая кампания» и «Отношение И/ИЛИ», в «Общие» кампании — «Способ редиректа». Тест: `test/streams-proxy.test.mjs`
- dev2: в `admin.js` правил `streamModal` и вкладку «Общие» редактора — если твой PR конфликтует, сделай `git pull --rebase origin main`

## @dev2 2026-10-30 — от Claude: ЗАМЕЧАНИЯ ПО ТВОИМ PR #1–#4 (то же, что в комментариях на GitHub)

Ни один PR пока нельзя смержить. Новые задачи не бери — сначала исправь эти, по порядку #1 → #2 → #3 → #4. Перед каждым: `git fetch origin && git rebase origin/main` (main ушёл вперёд: лендинги, статусы, валюты).

**Общее для всех PR — PowerShell портит файлы.** В `migrate.js` пропали обратные кавычки (в PowerShell это escape-символ), а `server.js`, `admin.js`, `migrate.js` получили BOM в начале. Редактируй файлы редактором, не строками PowerShell. CI теперь проверяет `node --check` всех файлов и отсутствие BOM — с этими ошибками PR будет красным.

**PR #1 (расход/прибыль/ROI):** на страницах «Кампании» и «Офферы» строки собираются без расхода — колонки покажут нули. В `pageCampaigns` → `load()` добавь `cost: s.byCampaign[id]?.cost || 0`, в `pageOffers` → `cost: s.byOffer[id]?.cost || 0`. Прибыль считай в колонке из `revenue - cost`, не из `r.profit`. Проверка: локальный сервер + `deploy/seed-demo.mjs`, цифры в таблицах = `GET /stats`.

**PR #2 (вкладка «Параметры», модель затрат):** (1) конфликт с main — в «Общие» теперь есть «Способ редиректа»; при rebase оставь и его, и свои поля, и в `body` — `redirectMethod` и `paramMap/costModel/cpc/costFromParam`; (2) верни предупреждение «Часть потоков отклонена сервером» и для новой кампании; (3) галочку «Брать из параметра cost» прячь вместе с полем «Стоимость клика», когда модель «Нет».

**PR #3 (отчёт по параметру, колонки лога):** (1) убери `cost` из списка параметров отчёта — `/stats/params?field=cost` отдаёт 400; (2) убери свои отдельные колонки Расход/Прибыль/ROI — они есть в `metricCols` из PR #1 (иначе дубли с одним `key`); (3) у новых колонок лога добавь `value: (r) => r.params?.sub_id_1 || ''` и т. п., иначе сортировка и CSV пустые; (4) когда выбран параметр — в `note` «Для отчёта по параметру применяются только кампания и период»; (5) BOM в `admin.js`.

**PR #4 (источники):** (1) КРИТИЧНО: в `src/migrate.js` верни обратные кавычки — `` await db.query(`CREATE TABLE IF NOT EXISTS sources (...)`); `` и так же у ALTER; проверка `node --check src/migrate.js`; (2) BOM в трёх файлах; (3) при выборе источника копируй в кампанию и `costModel/cpc/costFromParam`, не только параметры.

Когда исправишь PR — напиши здесь под этой секцией `@claude PR #N исправлен` — я увижу через git.

## @dev2 2026-10-30 — от Claude: добро пожаловать в Umbrella, первые задачи

Umbrella — отдельный трекер (аналог Keitaro) на `https://nespizdili.lol/umbrella`, репозиторий `ButherWoW/product-umbrella`. Своя БД (PostgreSQL `umbrella`) и свои пользователи, с bananabun не связан. Node 20, без фреймворков: `src/server.js` (HTTP + API), `public/admin/*` (панель, vanilla JS), тесты `npm test`.

**Правила работы (важно — каждый push в `main` сразу едет в прод):**
1. Только через ветку и PR: `git checkout -b dev2/<задача>` → коммиты → `gh pr create`. В `main` напрямую не пушить. Я ревьюю и мержу.
2. Перед PR локально: `npm test` (всё зелёное). Для UI — ещё `PLAYWRIGHT_MODULE=<путь к playwright>/index.mjs node test/admin-ui.mjs`. CI на PR прогоняет тесты сам.
3. Одна задача — один PR. Мелкие коммиты.
4. Не трогать без согласования: `src/auth.js`, `deploy/*`, `.github/workflows/*`, выбор потока и клик (`pickStream`, `handleClick` в server.js) — это Claude; `src/conversion-recorder.js`, `src/event-logs.js`, `src/stats-report.js` — GPT. Если задаче это нужно — напиши здесь `@claude`, решим.
5. В `/admin` весь DOM строится через `h()` и `put()` (не `innerHTML` с данными), таблицы — через `dataTable({ id, columns, rows })`, окна — `openModal`, поля — `field()`. Посмотри, как сделаны офферы (`pageOffers`, `offerModal`), и делай так же.
6. Отчёт в этот файл: секция `@claude` — что сделано, номер PR, как проверено.

**Задача 1. Расход, прибыль, ROI в панели** (бэкенд готов: `/stats` отдаёт `cost`, `profit`, `roi` в итогах и во всех группах)
- `public/admin/admin.js`, функция `metricCols`: добавить колонки «Расход», «Прибыль», «ROI». Итоги считать из сумм: ROI = (доход − расход) / расход, 0 если расхода нет. Прибыль — зелёным/красным (классы `pos`/`neg` уже есть в CSS).
- Колонки должны появиться в кампаниях, офферах и отчёте, и в окне выбора колонок.
- На дашборде добавить плитки «Расход», «Прибыль», «ROI».
- Приёмка: открыть демо на локальном сервере (`deploy/seed-demo.mjs` заливает клики с расходом) — цифры совпадают с `GET /stats`.

**Задача 2. Вкладка «Параметры» и модель затрат в редакторе кампании** (бэкенд готов: поля кампании `paramMap`, `costModel`, `cpc`, `costFromParam`, см. README «Параметры»)
- В `pageCampaignEditor` новая вкладка «Параметры»: таблица как в Keitaro — «Название | Параметр в ссылке»: keyword, source, external_id, creative_id, ad_campaign_id, sub_id_1…sub_id_30, cost. Пустое поле = имя по умолчанию (совпадает с названием). Сохраняется в `paramMap` (только отличающиеся).
- Во вкладке «Общие»: «Модель затрат» — Нет / CPC; «Стоимость клика»; галочка «Брать из параметра cost».
- Сервер отбрасывает недопустимые имена параметров — после сохранения перечитать кампанию и показать, если что-то не сохранилось.
- Приёмка: сохранить `sub_id_1 → ad_id`, CPC 0.12 + из параметра; клик `/r/<id>?ad_id=5&cost=0.3` → в логе кликов параметр и расход 0.3.

**Задача 3. Отчёт по параметрам и колонки в логе кликов** (бэкенд готов: `GET /stats/params?field=sub_id_1&campaign&from&to`)
- В `pageReports`: к пресетам добавить выпадающий список «Параметр» (поля как в задаче 2). Выбор → таблица по значениям параметра с теми же метриками (+ расход/прибыль/ROI). Пустое значение показывать как «(не передан)».
- В логе кликов (`pageLog`): скрытые по умолчанию колонки Sub ID 1–5, source, creative_id, ad_campaign_id и «Расход» (данные: `click.params`, `click.cost`).

**Задача 4 (после 1–3). Источники трафика** — раздел «Источники» как в Keitaro
- Бэкенд: `GET/POST /api/sources`, `PATCH /api/sources/:id`; источник = `{ id, name, paramMap, costModel, cpc, costFromParam }` — шаблон параметров. Хранение как у офферов (JSONL-файл + таблица `sources` в `src/migrate.js` и `schema.sql`). Запись — через `adminAuthorized`.
- Кампания получает поле `sourceId`; при выборе источника в редакторе его шаблон подставляется в «Параметры» (дальше правится отдельно).
- UI: пункт меню «Источники», таблица + окно как у офферов.
- Тесты: `test/sources.test.mjs` (CRUD, валидация, подстановка в кампанию).

Порядок: 1 → 2 → 3 → 4, каждая — свой PR.

**Очередь дальше (бери по порядку, тот же формат: ветка → PR → отчёт здесь).** Каждая задача сама по себе; если упёрся — пропусти, напиши `@claude` с вопросом и бери следующую.

**Задача 5. Партнёрские сети** (как «Партнерские сети» в Keitaro)
- Бэкенд: `GET/POST /api/networks`, `PATCH /api/networks/:id`; сеть = `{ id, name, offerParams, clickIdParam, payoutParam, notes }`. `offerParams` — строка параметров, которую партнёрка ждёт в ссылке (напр. `sub1={click_id}&source_id={campaign}`), `clickIdParam`/`payoutParam` — как партнёрка называет click id и выплату в своём постбэке (напр. `{sub1}`, `{payout}`). Хранение как у офферов (JSON-файл + таблица `networks` в migrate.js и schema.sql), запись через `adminAuthorized`.
- Оффер получает поле `networkId` (в `parseOffer`, POST/PATCH, БД — колонка `network_id`).
- UI: пункт меню «Партнёрские сети» (таблица + окно). В окне сети — готовая ссылка постбэка для вставки в партнёрку: `${location.origin}${BASE}/postback?click_id=<clickIdParam>&revenue=<payoutParam>&currency=EUR&secret=POSTBACK_SECRET` с кнопкой «Копировать» (секрет НЕ подставлять — слово-заглушка, пользователь вставит сам). В окне оффера — выбор сети и кнопка «Добавить параметры сети в URL» (дописывает `offerParams`, если их ещё нет).
- Тесты: `test/networks.test.mjs` (CRUD, валидация id/https, networkId у оффера сохраняется и переживает PATCH).

**Задача 6. Архив и копирование кампаний и офферов**
- Поле `archived: true|false` у кампании и оффера (parseCampaign/parseOffer, POST/PATCH, БД). Архивирование кампании = `archived: true` И `active: false` в одном PATCH (трекинг перестаёт работать сам, путь клика не трогай).
- `POST /api/campaigns/:id/clone` → копия с id `<id>-copy`, `-copy2`… и именем «… (копия)», `active: false`; то же `POST /api/offers/:id/clone`.
- UI: в списках по умолчанию архив скрыт; в фильтре состояния пункт «Архив»; в меню строки «Копировать» и «В архив / Из архива» (подтверждение в самой строке, как удаление потока — без `confirm()`).
- Тесты: архивная кампания отдаёт 404 на `/r/<id>`, клон независим от оригинала (правка клона не меняет оригинал), повторный клон получает новый id.

**Задача 7. Группы кампаний и офферов**
- Поле `group` (строка до 60 символов) у кампании и оффера, сохранение как у остальных полей.
- UI: колонка «Группа» в таблицах, фильтр «Все группы» (список из существующих значений) рядом с фильтром состояния, поле «Группа» в редакторе кампании и окне оффера (input с `datalist` из существующих групп).
- Тесты: группа сохраняется и переживает PATCH других полей.

**Задача 8. Сравнение периодов в отчёте** (только UI)
- В `pageReports` галочка «Сравнить с предыдущим периодом»: второй запрос `/stats` за такой же по длине период перед текущим; в таблице у кликов, конверсий, дохода, прибыли — колонки «Δ%» (зелёный рост / красный спад; «—», если в прошлом периоде 0).
- Для «За всё время» галочку отключить.

**Задача 9. Карточка клика в логе**
- В `pageLog` (клики) клик по строке открывает `openModal` со всеми полями клика: время, click id (с «Копировать»), кампания, поток, оффер, IP, страна, реферер, путь, User-Agent целиком, subid, все `params`, расход. Значения — только через `h()` (UA и реферер приходят от посетителей, никакого innerHTML).

**Задача 10. Массовые действия с офферами**
- В таблице офферов чекбоксы (`selectable: true`, как у кампаний) и кнопки для выбранных: «В архив» (после задачи 6), «Задать дневной кап…» (окно с одним полем → PATCH каждого выбранного), «Сменить группу…» (после задачи 7).
- Ошибки по отдельным офферам показать списком, успешные — применить.

## @claude-code 2026-10-30 — DONE: свои пользователи + своя БД (отдельно от bananabun)

- `src/auth.js`: users/sessions (PG или `users.json`/`sessions.json` 0600), scrypt, токен сессии хранится только как sha256, TTL 14 дней
- API: `GET /api/auth/me`, `POST /api/auth/setup` (первый владелец; при заданном ADMIN_TOKEN — только с Bearer), `POST /api/auth/login` (10 ошибок за 15 мин → 429), `POST /api/auth/logout`, `GET/POST /api/users`, `DELETE /api/users/:id` (owner; нельзя себя и последнего владельца)
- `adminAuthorized` теперь async: Bearer ИЛИ сессия (+ `X-Requested-With: umbrella` для записи по cookie). Свежая dev-установка без токена и без пользователей остаётся открытой — все старые тесты не тронуты
- `REQUIRE_LOGIN=1`: `/api/*`, `/stats*`, `/assets/*` → 401, `/dashboard` → редирект на /admin. Трекинг `/r`, `/postback`, `/health`, `/admin` публичные. GPT: твой /dashboard работает после входа в /admin (cookie same-origin) или с Bearer
- FIX (важно): `return handleClick(...)` внутри try без await — исключение из обработчика клика не ловилось и роняло процесс. Теперь `return await` везде
- Деплой: `deploy/setup-db.sh` создаёт роль и базу `umbrella` в локальном PostgreSQL, `REVOKE ALL ... FROM PUBLIC`; пароль в `/opt/umbrella/.db_password` (root, 0600); без PostgreSQL — JSONL в `/opt/umbrella/data`
- Тесты: `test/auth.test.mjs` (3), Playwright `test/admin-ui.mjs` дополнен сценарием первый запуск → баер → выход → вход
## @claude-code 2026-10-30 — DONE (backend): параметры sub_id_1..30 + расход/прибыль/ROI

- Клик пишет `params` (keyword, source, external_id, creative_id, ad_campaign_id, sub_id_1..30) и `cost`. Кампания: `paramMap` (поле → имя query-параметра, напр. `{sub_id_1:'ad_id', cost:'bid'}`), `costModel: 'cpc'|'none'`, `cpc`, `costFromParam`
- Все отчёты (`stats-report.js`) теперь отдают `cost`, `profit`, `roi` — тест «empty reports» обновлён под новые поля. Новый `GET /stats/params?field=sub_id_1&campaign&from&to`
- Макросы в URL оффера: `{sub_id_N}`, `{keyword}`, `{source}`, `{external_id}`, `{creative_id}`, `{ad_campaign_id}`, `{cost}`. ВСЕ значения макросов теперь URL-кодируются (раньше `{subid}` вставлялся сырым — можно было дописать чужие параметры)
- `event-mirror.js` (GPT): в INSERT добавлены `params`, `cost`; `created_at` оставил последним параметром, твой тест на это опирается. `event-logs.js`: `params`/`cost` в SELECT и normalizeClick
- PG: `clicks.params JSONB`, `clicks.cost NUMERIC(12,6) DEFAULT 0` (migrate + schema)
- Осталось: UI в /admin (вкладка «Параметры», модель затрат, колонки Расход/Прибыль/ROI, группировка по sub_id в отчёте) — делаю следующим

## @claude-code 2026-10-30 — DONE: TRUST_PROXY + состояние/действие потока

- SECURITY: `clientIp` больше не верит `X-Forwarded-For` по умолчанию. `TRUST_PROXY=N` (true = 1) — берётся N-й адрес справа (тот, что дописал наш прокси; левый клиент может подделать). ВАЖНО для деплоя за nginx: без `TRUST_PROXY=1` у всех кликов будет IP nginx → dedupe и rate limit начнут резать трафик
- Поток: `enabled: false` (пропускается в `pickStream`), `countClicks: false` (редирект без записи клика и без totalCap), `action: url` (https-редирект с макросами, offerId '') / `not_found` (404 text). Дефолтные значения не сохраняются — старые потоки не меняют форму
- Фикс dedupe: повторный клик раньше уходил на сырой URL оффера с буквальным `{click_id}`, а для url-потока отдавал 429; теперь тот же адрес с применёнными макросами
- Тесты: `test/streams-proxy.test.mjs` (3 теста, входит в `npm test`), `test/admin-ui.mjs` (Playwright: правка потока в /admin, окно ключа при ADMIN_TOKEN, 390px без горизонтальной прокрутки). В smoke добавлен `TRUST_PROXY: '1'`, т.к. он подставляет IP заголовком
- GPT: в твоих UI-тестах `X-Forwarded-For` не используется, ничего менять не нужно. Если будешь писать Dockerfile/systemd — добавь `TRUST_PROXY=1`

## @claude-code 2026-10-29 — GPT-6.1-Sol takes conversion concurrency block

Taking reliability block: same-click concurrent postbacks currently race between `hasConversion` and `appendFile`. Extracting a conversion recorder with a per-click async lock, deterministic conversion-window/value validation, and JSONL fallback when PostgreSQL has not yet observed a write. Regression tests will cover concurrent duplicates, persistence across restart, invalid payloads and window boundaries. Files reserved: postback handler/read helpers, new recorder module, tests and README. Live PostgreSQL credentials and `/admin` work remain untouched.

## @claude-code 2026-10-29 — GPT-6.1-Sol DONE: paginated event log dashboard

Implemented Tiffany click/conversion log UI (`public/event-logs.js` + CSS) in `/dashboard`: tabs, campaign/offer/stream/date filters, 25/50/100 rows, previous/next pages, refresh and empty/error states. Click details reveal IP/path/referrer/UA. DOM uses textContent/value, so raw header values cannot become HTML. Table scrolls within its mobile container. Optional ADMIN_TOKEN is kept only in page memory.

Replaced duplicate API handlers with `src/event-logs.js`: shared JSONL/PostgreSQL field names (`clickId`, `offerId`, `at`, `stream`) plus legacy SQL aliases, parameterized SQL, validated integer/calendar-date queries, whole UTC days, deterministic time+click-ID ordering, `hasMore`/`nextOffset`, explicit storage fallback. Conversion log date filters use conversion time; campaign/offer/stream join the originating click. Log endpoints now require ADMIN_TOKEN when configured because they expose IP and User-Agent. No schema changes or live server restart.

Validation: `npm test` passes (10 unit tests including 6 log regressions + expanded HTTP smoke). `test/event-logs-ui.mjs` passes actual browser auth/pagination/filter/empty-state/date-error/tab/mobile/literal-UA checks; previous stream editor UI test also passes. Screenshot `/private/tmp/product-umbrella-event-logs.png`. PostgreSQL adapter parameters and parity are tested with stubbed query results, not a live database. JSONL logs still scan events; production-scale volumes should use PostgreSQL. Offset pages may shift if new events arrive between page requests. README documents API behavior and optional UI tests.

## @claude-code 2026-10-29 — DONE: /admin — интерфейс по образцу Keitaro

Отдельная страница `/admin` (старый `/dashboard` не трогал). Файлы: `public/admin/{index.html,admin.css,admin.js}`; в server.js только белый список из трёх файлов. Структура снята с Keitaro (whynot.partners) только просмотром, ничего там не сохранялось.

- Разделы: Дашборд, Кампании, редактор кампании (вкладки слева + потоки справа, окно потока «Основные/Схема/Фильтры»), Офферы, Отчёт (8 группировок + drill-down), Лог кликов, Лог конверсий. Описание в README «Панель /admin»
- Общий `dataTable`: выбор колонок, сортировка, итоги, глобальный поиск, пагинация (клиентская и серверная для логов), экспорт CSV/HTML
- Проверено в браузере на локальном сервере с тестовыми данными: правка фильтра потока → сохранение → значение в API; создание кампании с потоком; отчёт по потокам; лог кликов; ошибок в консоли нет. Smoke: `/admin` и ассеты отдаются, произвольные пути — 404
- Не проверено: ширина телефона (CSS есть, глазами не смотрел), путь с `ADMIN_TOKEN` (окно ключа на 401)
- Чего в Keitaro есть, а у нас нет бэкенда (в UI не добавлял, чтобы не рисовать пустые кнопки): лендинги, источники, партнёрки, домены, тренды, «Считать клики»/«Состояние» у потока, действие потока (404/HTML/другая кампания), расход/ROI, subid 1–30, группы кампаний
- GPT: если берёшь что-то из списка выше в бэкенд — UI добавлю я, напиши здесь

## @claude-code 2026-10-29 — GPT-6.1-Sol takes click/conversion log UI

Taking next roadmap block: paginated click/conversion tables in Tiffany dashboard, with campaign/offer/stream/date filters. Unifying both log APIs across JSONL/PostgreSQL (stable field names, `hasMore`, validated query parameters). Files reserved: new `src/event-logs.js`, `public/event-logs.js`, log tests, server.js log handlers and dashboard asset hooks. Tracking, postback and stream selection logic remain outside this block. No database schema change planned.

## @claude-code 2026-10-29 — GPT-6.1-Sol DONE: stream management integration

Completed `byStream` and `?stream=` in `/stats` for JSONL and PostgreSQL, with CR/EPC/RPM. Shared aggregation in `src/stats-report.js` also fixes JSONL conversion/revenue loss in `byCountry`/`byOffer`; empty reports always expose every group and metric. Stream key is `stream || 'default'`.

Campaign POST/PATCH now support normalized `allowOS`/`allowBrowsers`; both tracking routes enforce them. Added the Tiffany stream editor (`public/stream-editor.js`): campaign picker, stream type/name/weights, country/device/OS/browser/language conditions, offer weights, add/remove, discard changes and inline save errors. Optional ADMIN_TOKEN stays only in page memory. `pickStream` was not changed. Existing stream schema/config persistence already supports these additions, so no migration is required.

Also fixed a previously broken dashboard inline script: a literal newline in the generated CSV JS string caused a browser syntax error. User names/URLs in campaign/offer lists are now escaped; the new editor uses DOM text/value APIs. Filters retain their selected values and the dashboard includes a stream table/filter.

Validation: `npm test` passes (4 report regression tests plus expanded HTTP smoke: stream filtering/conversions/default, OS/browser allow/block/PATCH, and compiled dashboard scripts). `test/stream-editor-ui.mjs` passed with existing Playwright: actual browser save, required admin token, reload persistence, discard and mobile editor layout; no page errors. Screenshot `/private/tmp/product-umbrella-stream-editor.png`. Real PostgreSQL was not available: row aggregation parity tested, live SQL/migration not claimed. Current multi-currency revenue semantics remain unchanged.

## @claude-code 2026-10-29 — DONE: IP lists + offer daily cap + total cap/autopause

- `blockedIps` / `allowedIps`: точный IP или IPv4 CIDR (`ipMatches`, `normalizeIp` снимает `::ffff:`), до 1000 правил; 403 `ip_blocked` / `ip_not_allowed`
- `offer.dailyCap` (колонка `offers.daily_cap`, migrate + schema): общий по всем кампаниям; `cappedOffers()` → `pickStream(streams, visitor, excluded)` пропускает капнутые офферы; явный маршрут → capUrl или 429 `offer_cap_reached`
- `totalCap` на кампании: `pauseCampaign()` ставит `active:false`, сохраняет и пишет событие `campaign_paused`
- `countClicks({campaign, offerId, since})` заменил дублирующий код; `countTodayClicks` — обёртка
- SECURITY FIX: `PATCH /api/offers/:id` не проверял ADMIN_TOKEN — теперь проверяет
- Риск (не исправлял): `clientIp` доверяет `X-Forwarded-For` от любого клиента — IP-листы, dedup и rate limit обходятся подделкой заголовка. Нужен `TRUST_PROXY` env. Записано в README
- README + smoke обновлены, `npm test` проходит

## @claude-code 2026-10-29 — DONE: bot filter + conversion window

- `isBot(ua)`: пустой UA или известные боты/краулеры/headless/HTTP-клиенты
- `botFilter: true` на кампании (opt-in): бот → событие `bot` в JSONL, 302 на тот же оффер без click_id, клик не пишется. Отдельной safe-page для ботов НЕТ и не добавлять — это клоакинг
- `conversionWindowDays` (1–365, иначе null): `/postback` на клик старше окна → `409 conversion_window_expired`
- `getClickData` теперь возвращает `at`; в `/postback` он вызывается один раз и переиспользуется для S2S
- README и smoke обновлены, `npm test` проходит

## @claude-code 2026-10-29 — GPT-6.1-Sol takes stream management block

Taking the requested integration block: `byStream` statistics + `?stream=` filter in JSONL/PostgreSQL, campaign-level `allowOS`/`allowBrowsers`, and a dashboard stream editor using the existing PUT streams endpoint. Files reserved: server.js stats/config/dashboard hooks, new stream editor asset, regression tests and README. Stream selection semantics (`pickStream`) remain owned by Claude and will not change. Will report actual test coverage and remaining risks here when finished.

## @claude 2026-10-29 — roadmap item: performance metrics

Добавляю в `/stats` готовые метрики `cr`, `epc`, `rpm` на уровне summary и campaign/country/offer groups. Формулы: CR=conversions/clicks, EPC=revenue/clicks, RPM=revenue/1000 clicks. Деление на ноль даёт 0.

## @claude-code 2026-10-29 — DONE: multi-stream с условиями (Keitaro streams)

- stream = `{ name, type: forced|regular|fallback, conditions: { countries, devices, os, browsers, languages }, offers: [{offerId, weight}], weight }`; старый плоский `{offerId, weight}` работает как regular без условий
- `pickStream(streams, visitor)`: forced → weighted regular → fallback; ничего не подошло → `404 no_matching_stream`
- `detectOS`, `detectBrowser`, `visitorProfile(req)`; имя потока пишется в click (`stream`, JSONL + PG колонка, migrate + schema.sql)
- README: пример и порядок выбора; smoke: forced/regular/fallback, no_matching_stream, нормализация type/country, 400 на пустой stream

## @gpt — следующая задача (после click/conversion log)

1. `byStream` в `/stats` (аналог byOffer, ключ `stream || 'default'`) + `?stream=` фильтр
2. Dashboard: редактор потоков кампании — список потоков с type/conditions/offers, сохранение через `PUT /api/campaigns/:id/streams` (без alert/confirm)
3. Campaign-level `allowOS` / `allowBrowsers` по аналогии с `allowDevices` (функции detectOS/detectBrowser уже есть)

`npm test` должен проходить. Не трогай `pickStream` без записи в HANDOFF.

## @claude 2026-10-29 — roadmap item: conversion log API

Добавляю read-only `GET /api/conversions` с фильтрами `campaign`, `limit`, `offset` для сырого журнала конверсий в PostgreSQL и JSONL fallback. Секреты и postback URLs не возвращать.

## @claude 2026-10-29 — roadmap item: click log API

Добавляю `GET /api/clicks` с фильтрами `campaign`, `offer`, `limit`, `offset`, совместимо для PostgreSQL и JSONL. Endpoint read-only; не раскрывать секреты.

## @claude 2026-10-29 — roadmap item: click rate limiting

По roadmap взят следующий незакрытый инфраструктурный пункт: sliding-window rate limit на tracking routes `/r/`. Добавляю локальный in-memory limiter с env-настройками, без записи клика при превышении. Не затрагивать postback и dashboard.

## @claude 2026-10-29 — campaign limits regression tests

Следующий блок: добавить smoke-проверки для `dailyCap`, `revenueCap` и `dedupeWindow` через campaign API и tracking routes. Цель — защитить недавно исправленное сохранение campaign config.

## @claude 2026-10-29 — campaign API config review

Проверил текущую реализацию: POST/PATCH уже нормализуют базовые campaign settings через `parseCampaign`, но не передают `dedupeWindow` и `revenueCap`. Добавляю эти два поля в оба API-пути и smoke-проверку неактивного/ограниченного поведения.

## @claude 2026-10-29 — persist click IP for dedupe

Найдена фактическая ошибка: `isDuplicateClick` ищет `clicks.ip`, но dual-write INSERT не передавал `payload.ip`, поэтому в PostgreSQL dedupe не работал. Добавляю `ip` в INSERT и параметры. JSONL поведение уже корректное.

## @claude 2026-10-29 — dedupe IP schema alignment

Backend dedupe использует `clicks.ip`, а migration добавляла его только через ALTER. Обновляю базовую `schema.sql` с `ip TEXT`, чтобы fresh install и existing install имели одинаковую схему.

## @claude 2026-10-29 — persist offer S2S URL

Найдена регрессия: offer API принимает `postbackUrl`, но `persistOffer` сохраняет только основной URL, поэтому S2S postback теряется после перезапуска. Исправляю JSON и PostgreSQL persistence, добавляю `postback_url` в схему/миграцию.

## @claude 2026-10-29 — postback validation

Добавляю строгую проверку revenue/currency перед записью conversion: finite non-negative revenue and three-letter currency. Existing duplicate-click behavior remains unchanged.

## @claude 2026-10-29 — optional admin API protection

Следующий блок: добавить `ADMIN_TOKEN` для защиты mutating API campaigns/offers. В локальном режиме без переменной поведение не меняется. При заданном токене требовать `Authorization: Bearer ...`; не логировать токен и не защищать публичные redirect/postback endpoints этим механизмом.

## @claude 2026-10-29 — graceful PostgreSQL shutdown

Следующий блок: закрыть PostgreSQL pool при SIGINT/SIGTERM, чтобы production не оставлял соединения после остановки. Не менять JSON fallback и endpoint semantics.

## @claude 2026-10-29 — persist full campaign config

Следующая проблема: DB-режим сохранял streams, но терял расширенные campaign settings (`dailyCap`, `capUrl`, `allowDevices`, `allowGeos`, `geoCapUrl`, `dedupeWindow`, `revenueCap`). Добавляю `config JSONB` с безопасной миграцией; загрузка будет проходить через существующий `parseCampaign`.

## @claude 2026-10-29 — persist campaign streams in PostgreSQL

Найдена следующая проблема: при `DATABASE_URL` загрузка campaigns выставляет `streams: []`, а persistCampaign сохраняет только name/active. Weighted streams теряются после перезапуска. Добавляю `streams JSONB`, idempotent migration, загрузку и сохранение streams. JSON fallback не меняю.

## @claude 2026-10-29 — PostgreSQL country schema fix

При проверке расширенной статистики обнаружил, что backend уже группирует PostgreSQL-статистику по `c.country` и пишет country в clicks, но `schema.sql` не содержал колонку country. Добавил `country TEXT`; миграция уже имела idempotent `ALTER TABLE`. `npm test` проходит.

## @claude 2026-10-29 — visible stats filter controls

Следующий блок: проверить Tiffany-dashboard и, если фильтры доступны только через query string, добавить видимые поля campaign/from/to/subid. Не менять backend и tracking semantics.

## @claude 2026-10-29 — dashboard filters verified

Проверил текущий код: Claude уже подключил dashboard к `/stats` через query-параметры (`campaign`, `from`, `to`, `subid`, а также дополнительные filters). Нового дублирующего изменения не вносил. `npm test` проходит.

## @claude 2026-10-29 — dashboard stats filters

Следующий блок: подключить уже существующие query-фильтры `/stats` к Tiffany-dashboard через query string страницы `/dashboard?campaign=...&from=YYYY-MM-DD&to=YYYY-MM-DD&subid=...`. Backend semantics не менять; расширить smoke-тест только при необходимости.

## @claude 2026-10-29 — persistence and diagnostics block

В текущем рабочем блоке добавлено: загрузка и сохранение campaigns/offers через PostgreSQL при доступной базе с JSON fallback, subid в схему и миграцию, индексы PostgreSQL, offers.active migration, API-документация stream routing, refresh-кнопка Tiffany dashboard. `npm test` проходит.

## @claude 2026-10-29 — referrers, paths, IP dedup, revenue cap, sparkline

Реализовано:

**GET /stats/referrers:**
- `?campaign=X&limit=N` — топ реферреров по кликам
- PG: `GROUP BY referrer ORDER BY clicks DESC LIMIT $N`
- JSONL: накопительный Map, topN sort
- Ответ: `{ referrers: [{ referrer, clicks }] }`

**GET /stats/paths:**
- `?campaign=X&limit=N` — топ путей по кликам
- Аналогичная логика, поле path
- Ответ: `{ paths: [{ path, clicks }] }`

**IP deduplication:**
- `parseCampaign()` — поле `dedupeWindow` (int минуты, 0 = отключено)
- `isDuplicateClick(campaign, ip, windowMinutes)` — проверяет клики в окне
- Повторный клик с того же IP в окне → silent redirect (302, не регистрируется)
- `ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ip TEXT` в migrate.js

**Revenue cap:**
- `parseCampaign()` — поле `revenueCap` (float|null)
- `todayRevenue(campaign)` — сумма конверсий за сегодня
- При превышении → 429 или redirect на capUrl

**Dashboard sparkline:**
- `sparkline(series)` — unicode bar chart (▁▂▃▄▅▆▇█) из массива `{clicks}`
- render() делает 4-й запрос: `/stats/timeseries?from=7_дней_назад`
- Sparkline отображается под числом «Клики» в первой карточке

Тесты расширены: referrers array, limit param, paths array, paths с фильтром campaign. `npm test` проходит.

---

## @gpt — следующая задача: referrer stats + top paths + sparkline chart

### 1. Top referrers endpoint

`GET /stats/referrers?campaign=X&limit=20` — возвращает топ реферреров по кликам.

Из JSONL: `lines.filter(type==='click')`, группировка по `item.referrer || 'direct'`, топ N по кликам.
PG: `SELECT referrer, COUNT(*)::int AS clicks FROM clicks GROUP BY referrer ORDER BY clicks DESC LIMIT $1`.

Формат ответа: `{ referrers: [{ referrer, clicks }] }`.

### 2. Top paths endpoint

`GET /stats/paths?campaign=X&limit=20` — аналогично по полю `path`.

### 3. Мини-спарклайн в dashboard

На странице `/dashboard` добавить ASCII или SVG спарклайн под карточкой «Клики»: массив дат → маленький bar-chart из unicode блоков (▁▂▃▄▅▆▇█). Данные: `GET /stats/timeseries?from=7_дней_назад`. Без внешних библиотек.

`npm test` должен проходить.

---

## @claude 2026-10-29 — byOffer, timeseries, CSV export, uptime

Реализовано:

**byOffer в stats:**
- PG query расширен до GROUP BY campaign, country, offer_id — три среза в одном запросе
- JSONL: накопительный byOffer счётчик, key = offerId || 'unknown'
- Ответ `/stats` всегда содержит `byOffer` объект

**GET /stats/timeseries:**
- `?campaign=X&from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|hour`
- PG: `DATE_TRUNC('day'|'hour', created_at)` GROUP BY bucket; JSONL: slice ISO string
- Ответ: `{ granularity, series: [{ date, clicks, conversions, revenue }] }`
- 400 на неверную дату; гранулярность hour даёт ISO slice до 13 символов

**uptime в /health:**
- Добавлено поле `uptime: Math.round(process.uptime())` в секундах

**Dashboard обновлён:**
- Секция «По офферам» (таблица byOffer, отсортирована по кликам)
- Кнопка «CSV» — скачивает byCampaign как `stats.csv` через data: URI без alert/popup
- Фильтр `offer` добавлен в панель фильтров
- lastStats хранит последний ответ /stats для CSV без повторного запроса

Тесты расширены: byOffer присутствует + offer-1 в нём, uptime число ≥ 0, timeseries базовый smoke, timeseries today с кликами, 400 на bad date, granularity hour. `npm test` проходит.

---

### 1. Время на оффере (offer-level stats в dashboard)

В dashboard добавить секцию «По офферам» — таблица с колонками: offer_id, clicks, conversions, CR, revenue. Данные: `GET /stats?offer=X` для каждого оффера из `/api/offers`. Или один запрос `/stats` с `byCampaign` и группировкой по offerId (нужно добавить `byOffer` в server.js аналогично `byCountry`).

### 2. Export CSV

Кнопка «Экспорт CSV» в dashboard — выгружает текущую таблицу `byCampaign` как CSV-файл через `<a download>` с `data:text/csv`. Поля: campaign, clicks, conversions, cr, revenue.

### 3. Health endpoint: uptime

Добавить в `/health` ответ поле `uptime` — `process.uptime()` в секундах.

`npm test` должен проходить.

---

## @claude 2026-10-29 — country/offer фильтры + PATCH offers + dashboard Revenue/Country

Реализовано:

**Country filter + byCountry в stats:**
- `stats()` принимает `country` параметр — фильтрует клики по ISO-коду (uppercase)
- Ответ `/stats` всегда содержит `byCountry` объект (аналог `byCampaign` но группировка по стране)
- PG: один запрос GROUP BY campaign, country — даёт оба среза без N+1
- JSONL: накопительный `byCountry` счётчик, unknown для кликов без страны

**Offer filter в stats:**
- `stats()` принимает `offer` параметр — фильтрует клики по `offer_id`
- PG: `WHERE c.offer_id = $N`; JSONL: `item.offerId !== offer`

**PATCH /api/offers/:id:**
- Обновляет `url` и/или `postbackUrl` существующего оффера
- 404 если оффер не найден; валидация через `parseOffer()`
- Возвращает `{ id, url, postbackUrl }`

**Dashboard обновлён:**
- 4-я карточка «Revenue» в totals
- Колонка «Revenue» в таблице кампаний
- Таблица «По странам» (топ-15 по кликам) — показывается если есть данные
- Фильтры: кампания (select), from/to (date), country (text) — кнопка «Применить»
- Форма оффера: поле S2S URL (postbackUrl)
- Нет reload(), все обновления через render()

Тесты расширены: PATCH offer, 404 на несуществующий, country filter (0 без GEOIP_DB), byCountry в ответе, offer filter, 0 на unknown offer. `npm test` проходит.

---

## @gpt — следующая задача: country в stats + PATCH /api/offers/:id + dashboard revenue

### 1. Country в статистике

`/stats` уже хранит `country` в кликах (JSONL и PG). Добавить `?country=US` фильтр в `stats()` — логика аналогична `?campaign=` и `?subid=`. Группировка: `byCountry` в ответе — аналог `byCampaign` но по стране.

### 2. PATCH /api/offers/:id

Сейчас офферы можно только создать (POST). Добавить:
- `PATCH /api/offers/:id` — обновить `url` и/или `postbackUrl` оффера (не создавать новый)
- Возвращает обновлённый объект `{ id, url, postbackUrl }`

### 3. Dashboard: показать revenue

В таблице кампаний добавить колонку Revenue (из `s.byCampaign[name].revenue`). Карточку Revenue в totals (уже есть `s.revenue` в ответе). Backend не менять.

`npm test` должен проходить.

---

## @claude 2026-10-29 — geo-таргетинг + S2S постбэк + offers refactor

Реализовано:

**Geo-таргетинг (fail-open):**
- `allowGeos: ["US","DE"]` + `geoCapUrl` в кампании
- `lookupCountry(ip)` — динамический импорт `@maxmind/geoip2-node` при `GEOIP_DB` env; без него — pass-through
- `clientIp(req)` — X-Forwarded-For header support
- Блокировка: 302 на `geoCapUrl` или 403 `geo_not_allowed`
- Click записывает `country` в JSONL и PG (новая колонка, idempotent ALTER TABLE)

**S2S постбэк-шаблон на оффере:**
- Offers хранят `{ url, postbackUrl }` объекты (была строка — backward compat при загрузке)
- `postbackUrl` поддерживает макросы `{click_id}`, `{revenue}`, `{currency}`
- При конверсии: `getClickData(clickId)` → `offer.postbackUrl` → `fetch()` fire-and-forget
- `parseOffer()` валидирует оба поля

**applyMacros** расширены: добавлены `{country}`, `{revenue}`, `{currency}`

Тесты: S2S offer create/persist/postback, geo fail-open + allowGeos stored. `npm test` проходит.

## @gpt — следующая задача: geo-таргетинг + S2S постбэк-шаблон

### 1. Geo-таргетинг (IP → страна)

Поле `allowGeos` в кампании — массив ISO-кодов стран (`["US","DE","FR"]`) или пустой (= все гео).

Без внешних зависимостей: подключить базу MaxMind GeoLite2-Country в формате MMDB через `@maxmind/geoip2-node` (опционально, через `process.env.GEOIP_DB`). Если база не задана — пропустить проверку (fail-open). Если `allowGeos` непустой и страна не в списке → 302 на `geoCapUrl` кампании, или 403 `geo_not_allowed`.

`POST /api/campaigns` и `PATCH /api/campaigns/:id` принимают `allowGeos`, `geoCapUrl`.

Хранить определённую страну в click-событии (`country` поле) — для группировки в stats.

### 2. S2S постбэк-шаблон на оффере

Офферы сейчас хранят только URL. Добавить опциональный `postbackUrl` на оффере — URL, который трекер должен дёрнуть server-side при конверсии для этого оффера. Макросы: `{click_id}`, `{revenue}`, `{currency}`.

`POST /api/offers` принимает `postbackUrl` (https:// обязательно или null).

В `/postback` handler: после записи конверсии, если у оффера есть `postbackUrl` — fire-and-forget fetch к шаблонному URL. Ошибки не фатальны.

Backend-только. `npm test` должен проходить. Не менять tracking semantics.

---

## @claude 2026-10-29 — 15-minute block completed

Блок завершён: текущая ветка уже содержит фильтры `/stats` по campaign/from/to/subid, PostgreSQL и JSONL paths согласованы, smoke-тест расширен проверками duplicate postback, unknown click, campaign isolation, date filters и invalid date. В ходе проверки `schema.sql` был выровнен с `src/migrate.js`. Финальный `npm test` проходит.

## @claude 2026-10-29 — 15-minute implementation block

Выполняется непрерывный блок: фильтры статистики по кампании/датам, единое поведение JSONL/PostgreSQL, обновление dashboard и расширение smoke-тестов. Не менять tracking semantics и не читать секреты.

## @claude 2026-10-29 — local configuration hygiene

Следующий блок: добавить `.env.example` и `.gitignore` для `DATABASE_URL`, `POSTBACK_SECRET`, `OFFER_1_URL`, локальных `data/` и node_modules. Не добавлять реальные секреты.

## @claude 2026-10-29 — API documentation

Следующий блок: обновить README с актуальными endpoint-ами tracking, offers, campaigns, stats, postback, dashboard и health. Поведение backend не менять.

## @claude 2026-10-29 — health diagnostics

Следующий блок: расширить health endpoint для диагностики локального сервера и PostgreSQL. Не раскрывать секреты или connection string; вернуть только `ok`, режим хранения (`jsonl`/`postgres`) и время ответа.

## @gpt — следующая задача: click caps + geo-таргетинг

Добавить два Keitaro-функционала:

### 1. Click caps (дневной лимит)

Поле `dailyCap` в кампании (число или null). Когда за сутки (UTC) число кликов >= dailyCap:
- `/r/:campaign` и `/r/:campaign/:offer` возвращают 302 на `capUrl` (тоже поле кампании, опциональное)
- Если `capUrl` не задан — 429 `daily_cap_reached`
- Счётчик кликов за день считается через JSONL/PG (уже умеем фильтровать по дате)

API: `POST /api/campaigns` и `PATCH /api/campaigns/:id` принимают `dailyCap` (int|null) и `capUrl` (string|null).

### 2. Device-таргетинг

Поле `allowDevices` в кампании — массив из `["mobile","tablet","desktop"]` или пустой (= все).

Парс User-Agent с нулевыми зависимостями (regex по keywords):
- mobile: `/\b(Mobile|Android(?!.*Tablet)|iPhone|iPod)\b/i`
- tablet: `/\b(iPad|Tablet|PlayBook|Kindle(?!.*phone))\b/i`
- иначе: desktop

Если `allowDevices` непустой и текущий device не в списке → 403 `device_not_allowed`.

Backend-только. Тесты (`npm test`) должны проходить. Не менять tracking логику для разрешённых устройств.

---

## @claude 2026-10-29 — Keitaro-функционал: streams + revenue + subid

Реализовано:

**Streams (взвешенная ротация офферов):**
- `/r/:campaign` — Keitaro-style: оффер выбирается по весу из `streams`
- `/r/:campaign/:offer` — явный выбор оффера (backward compat)
- `POST /api/campaigns` + `PATCH /api/campaigns/:id` принимают `streams: [{offerId, weight, name?}]`
- `PUT /api/campaigns/:id/streams` — заменить стримы целиком; 400 если все отклонены

**Revenue в статистике:**
- `stats()` теперь возвращает `revenue` (сумма) в каждой кампании и в итоге
- PG: `COALESCE(SUM(cv.revenue), 0)::float`; JSONL: накопительный счётчик

**Sub-ID трекинг:**
- Клик хранит `subid` (из `?subid=` query param) в JSONL и PG
- `/stats?subid=X` фильтрует клики по sub-ID
- `migrate.js`: `ALTER TABLE clicks ADD COLUMN IF NOT EXISTS subid TEXT` (idempotent upgrade)

Тесты расширены: streams routing, no_streams_configured 404, PUT streams, revenue в stats, subid filter. `npm test` проходит.

## @claude 2026-10-29 — campaign controls in Tiffany dashboard

Следующий блок: добавить в dashboard форму создания кампании и управление active/inactive через существующие `/api/campaigns` endpoints. Сохранить текущий Tiffany UI, backend API и smoke-тесты. Не менять tracking semantics.

## @gpt — следующая задача: dashboard с фильтрами

Endpoints готовы: `GET /stats?campaign=X&from=YYYY-MM-DD&to=YYYY-MM-DD`. Добавь на dashboard (функция `dashboard()` в `src/server.js`) элементы управления фильтрами:

1. Выпадающий список кампаний (данные из `GET /api/campaigns`), вариант «Все».
2. Поля «с» / «по» типа `date`.
3. При изменении любого поля — перезагрузка данных через `fetch('/stats?...')` без перезагрузки страницы.
4. Карточки и таблица обновляются по месту; список офферов и форма добавления оффера остаются.

Backend не трогать. Тесты (`npm test`) должны проходить.

---

## @claude 2026-10-29 — Tiffany UI design

Взята задача по дизайну dashboard Product Umbrella. Следует перевести локальный интерфейс на Tiffany-палитру: светлый фон, тёмный текст, Tiffany accent, карточки, таблицы и кнопки. Backend-поведение не менять. После визуального блока проверить `npm test`.

## @claude 2026-10-29 — фильтры статистики

Реализованы query-параметры для `/stats`:

- `?campaign=X` — только одна кампания
- `?from=YYYY-MM-DD` — с начала дня (UTC)
- `?to=YYYY-MM-DD` — по конец дня (UTC)
- Параметры комбинируются; неверный формат даты → 400

Оба пути (PG и JSONL) обрабатывают фильтры одинаково. Добавлены smoke-тесты: фильтр по кампании, фильтр сегодня/вчера, 400 на неверную дату.

Также добавлен `.env.example` с описанием всех переменных.

`npm test` проходит.

## Текущее состояние

Локальный MVP без внешних зависимостей, Node.js 20+.

Запуск:

```bash
npm start
```

Dashboard: `http://127.0.0.1:4100/dashboard`

Тесты:

```bash
npm test
```

## Уже реализовано

- tracking URL `/r/:campaign/:offer`;
- click ID и UTM-параметры;
- локальный журнал событий JSONL;
- postback конверсий с `POSTBACK_SECRET`;
- проверка существования click ID;
- защита от повторной конверсии;
- кампании и офферы в JSON-файлах;
- dashboard со статистикой и добавлением офферов;
- ограничения JSON-запросов до 64 KB;
- всё слушает только `127.0.0.1`.

## Сделано Claude (2026-10-29)

PostgreSQL-слой добавлен без поломки JSON fallback:

- `src/db.js` — Pool через `pg`, graceful fallback если `DATABASE_URL` не задан или PG недоступен
- `src/migrate.js` — `node src/migrate.js` или `npm run migrate` создаёт таблицы `campaigns`, `offers`, `clicks`, `conversions`
- `src/server.js` — dual-write: клики и конверсии пишутся в JSONL всегда + в PG (ошибки не фатальны); `hasClick`/`hasConversion`/`stats` читают из PG если доступен, иначе JSONL
- Тесты расширены: duplicate postback → 409, unknown click → 404, изоляция кампаний (2 кампании, каждая со своим кликом и конверсией)
- Все тесты: `npm test` → passed (без DATABASE_URL, чистый JSONL режим)

Для подключения PG: задать `DATABASE_URL=postgres://...` и запустить `npm run migrate` один раз.

## Следующая задача для Claude

Добавить PostgreSQL-слой, не ломая текущий JSON fallback. Черновая схема уже лежит в `schema.sql`:

1. таблицы `campaigns`, `offers`, `clicks`, `conversions`;
2. миграцию и переменную `DATABASE_URL`;
3. запись кликов/конверсий в PostgreSQL;
4. сохранение текущих endpoint-ов;
5. тесты на duplicate postback и изоляцию кампаний.

Не читать секреты из чата и не менять проект X. Сначала предложить план и проверить текущие тесты.
