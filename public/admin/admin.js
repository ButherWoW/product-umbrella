// Umbrella admin UI — layout and workflows modelled on Keitaro, backed by the existing tracker API.
const state = { token: null, offers: {}, campaigns: {}, landings: {}, sources: {}, users: [] };
// Set by the server when the tracker runs under a path prefix (BASE_PATH, e.g. /umbrella behind nginx).
const BASE = document.querySelector('meta[name="umbrella-base"]')?.getAttribute('content') || '';
const view = document.getElementById('view');

// ---------- utils ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const store = {
  get(key, fallback) { try { const v = localStorage.getItem('umbrella:' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('umbrella:' + key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};
const nf = new Intl.NumberFormat('ru-RU');
const num = (v) => nf.format(Number(v) || 0);
// Report amounts carry the selected currency sign; `amount` is for raw values that have their own currency column.
const amount = (v) => (Number(v) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v) => { try { return (Number(v) || 0).toLocaleString('ru-RU', { style: 'currency', currency: currency.code, minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch { return amount(v) + ' ' + currency.code; } };
const money4 = (v) => { try { return (Number(v) || 0).toLocaleString('ru-RU', { style: 'currency', currency: currency.code, minimumFractionDigits: 4, maximumFractionDigits: 4 }); } catch { return (Number(v) || 0).toFixed(4) + ' ' + currency.code; } };
const pct = (v) => ((Number(v) || 0) * 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
const dt = (iso) => (iso ? iso.replace('T', ' ').slice(0, 19) : '—');
const ratio = (a, b) => (b ? a / b : 0);
const ID_RE = /^[A-Za-z0-9_-]{2,80}$/;
const splitList = (text) => String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Скопировано: ' + text); }
  catch { toast('Не удалось скопировать, ссылка: ' + text); }
}

function download(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-requested-with': 'umbrella' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  if (path.startsWith('/stats') && currency.code) path += (path.includes('?') ? '&' : '?') + 'currency=' + encodeURIComponent(currency.code);
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    if (state.me?.loginRequired || data.error === 'login_required') { state.me = { ...state.me, user: null, loginRequired: true }; authScreen(); }
    else tokenModal('Для этого действия нужен ключ администратора (ADMIN_TOKEN).');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'HTTP ' + res.status), { status: res.status, data });
  return data;
}
const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

async function loadRefs() {
  const [o, c, l, s] = await Promise.all([api('/api/offers'), api('/api/campaigns'), api('/api/landings'), api('/api/sources')]);
  state.offers = o.offers || {};
  state.campaigns = c.campaigns || {};
  state.landings = l.landings || {};
  state.sources = s.sources || {};
  state.domains = (await api('/api/domains').catch(() => ({ domains: [] }))).domains || [];
  // Owners see the team list (for assigning campaigns and per-buyer earnings); buyers get 403 and an empty list.
  state.users = isOwnerView() ? ((await api('/api/users').catch(() => ({ users: [] }))).users || []) : [];
}

const isOwnerView = () => state.me?.user?.role === 'owner';
const userEmail = (id) => state.users.find((u) => u.id === id)?.email || (id ? 'удалённый пользователь' : '—');

// ---------- period ----------
const PERIODS = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['last_7_days', 'Последние 7 дней'], ['this_month', 'Текущий месяц'], ['prev_month', 'Предыдущий месяц'], ['last_30_days', 'Последние 30 дней'], ['all', 'За всё время'], ['custom', 'Интервал дат']];
const period = store.get('period', { key: 'today', from: '', to: '' });
function periodRange() {
  const now = new Date();
  const day = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n)).toISOString().slice(0, 10);
  const monthStart = (offset) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
  switch (period.key) {
    case 'today': return { from: day(0), to: day(0) };
    case 'yesterday': return { from: day(1), to: day(1) };
    case 'last_7_days': return { from: day(6), to: day(0) };
    case 'last_30_days': return { from: day(29), to: day(0) };
    case 'this_month': return { from: monthStart(0), to: day(0) };
    case 'prev_month': return { from: monthStart(-1), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10) };
    case 'custom': return { from: period.from || day(0), to: period.to || day(0) };
    default: return { from: null, to: null };
  }
}
function periodControl(onChange) {
  const wrap = h('span', { class: 'toolbar', style: 'margin:0' });
  const render = () => {
    put(wrap, 
      h('select', { class: 'select', 'aria-label': 'Период', onchange: (e) => { period.key = e.target.value; store.set('period', period); render(); onChange(); } },
        PERIODS.map(([k, label]) => h('option', { value: k, selected: period.key === k }, label))),
      ...(period.key === 'custom' ? [
        h('input', { class: 'input', type: 'date', value: periodRange().from, 'aria-label': 'С', onchange: (e) => { period.from = e.target.value; store.set('period', period); onChange(); } }),
        '—',
        h('input', { class: 'input', type: 'date', value: periodRange().to, 'aria-label': 'По', onchange: (e) => { period.to = e.target.value; store.set('period', period); onChange(); } }),
      ] : []),
    );
  };
  render();
  return wrap;
}

// ---------- currency ----------
// Reports convert every amount into the chosen currency at the current rate (server side, /api/rates).
const POPULAR = ['EUR', 'USD', 'RUB', 'GBP', 'UAH', 'KZT', 'PLN', 'TRY', 'BRL', 'INR'];
const currency = { code: store.get('currency', ''), info: null };
async function loadRates() {
  if (currency.info) return currency.info;
  try { currency.info = await api('/api/rates'); } catch { currency.info = { defaultCurrency: 'EUR', currencies: ['EUR'], rates: { EUR: 1 } }; }
  if (!currency.code || !currency.info.currencies.includes(currency.code)) currency.code = currency.info.defaultCurrency;
  return currency.info;
}
function currencyControl(onChange) {
  const info = currency.info || { currencies: [currency.code || 'EUR'] };
  const codes = [...POPULAR.filter((c) => info.currencies.includes(c)), ...info.currencies.filter((c) => !POPULAR.includes(c))];
  return h('select', { class: 'select', 'aria-label': 'Валюта', title: 'Валюта отчётов', onchange: (e) => { currency.code = e.target.value; store.set('currency', currency.code); onChange(); } },
    codes.map((c) => h('option', { value: c, selected: c === currency.code }, c)));
}
function ratesNote() {
  const info = currency.info;
  if (!info?.updatedAt) return h('p', { class: 'muted rates-note' }, 'Курсы валют ещё не загружены — суммы в других валютах не пересчитываются.');
  const base = info.defaultCurrency; const rate = currency.code === base ? null : (info.rates[currency.code] / info.rates[base]);
  return h('p', { class: 'muted rates-note' }, `Пересчёт по курсу на ${dt(info.updatedAt).slice(0, 16)} UTC`,
    rate ? ` · 1 ${base} = ${rate.toLocaleString('ru-RU', { maximumFractionDigits: 4 })} ${currency.code}` : '', ' · суммы конверсий хранятся в исходной валюте.');
}

// ---------- change history ----------
const ACTION_LABEL = { create: 'Создание', update: 'Изменение', delete: 'Удаление', pause: 'Автопауза', login: 'Вход' };
const FIELD_LABEL = { conversionCap: 'Кап конверсий', capTz: 'Часовой пояс капа', altOfferId: 'Запасной оффер', name: 'Название', active: 'Состояние', dailyCap: 'Дневной кап', totalCap: 'Общий кап', revenueCap: 'Кап дохода', capUrl: 'URL капа', streams: 'Потоки',
  allowGeos: 'Страны', allowDevices: 'Устройства', allowOS: 'ОС', allowBrowsers: 'Браузеры', blockedIps: 'Черный список IP', allowedIps: 'Белый список IP', botFilter: 'Фильтр ботов', datacenterAsBot: 'Дата-центры = боты',
  dedupeWindow: 'Уникальность', conversionWindowDays: 'Окно конверсии', redirectMethod: 'Способ редиректа', paramMap: 'Параметры', costModel: 'Модель затрат', cpc: 'CPC',
  costFromParam: 'Расход из параметра', url: 'URL', postbackUrl: 'S2S постбэк', dailyCap_offer: 'Дневной кап', reason: 'Причина', email: 'Email', role: 'Роль' };
const showValue = (v) => (v === null || v === undefined || v === '' ? '—' : v === true ? 'да' : v === false ? 'нет' : String(v));
async function historyModal(entity, id, title) {
  const list = h('div', {}, 'Загрузка…');
  openModal({ title: `История: ${title || id}`, wide: true, body: list });
  try {
    const { entries } = await api('/api/audit' + qs({ entity, id, limit: 200 }));
    put(list, entries.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Когда'), h('th', {}, 'Кто'), h('th', {}, 'Действие'), h('th', {}, 'Что изменилось'))),
      h('tbody', {}, entries.map((e) => h('tr', {},
        h('td', { 'data-label': 'Когда' }, dt(e.at)), h('td', { 'data-label': 'Кто' }, e.actor === 'system' ? 'система' : e.actor === 'admin-token' ? 'ключ администратора' : e.actor),
        h('td', { 'data-label': 'Действие' }, ACTION_LABEL[e.action] || e.action),
        h('td', { 'data-label': 'Что изменилось', style: 'white-space:normal' }, Object.entries(e.changes || {}).map(([k, v]) => h('div', {}, h('b', {}, FIELD_LABEL[k] || k), v ? `: ${showValue(v[0])} → ${showValue(v[1])}` : ': изменено'))))))))
      : h('p', { class: 'muted' }, 'Изменений пока нет.'));
  } catch (e) { put(list, h('p', { class: 'err' }, 'Не удалось загрузить историю: ' + e.message)); }
}

// ---------- modal ----------
const modals = [];
function openModal({ title, body, footer, wide }) {
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } });
  const close = () => { back.remove(); modals.splice(modals.indexOf(close), 1); };
  back.append(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: wide ? 'width:min(960px,100%)' : null },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => close() }, '✕')),
    body,
    footer ? h('div', { class: 'modal-foot' }, footer) : null));
  document.body.append(back);
  modals.push(close);
  back.querySelector('input:not([type=checkbox]):not([type=radio]):not([readonly]), select, textarea')?.focus();
  return close;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modals.length) modals[modals.length - 1](); });

function tabs(defs, initial = 0) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div');
  const show = (i) => {
    [...bar.children].forEach((b, j) => b.classList.toggle('on', i === j));
    put(panel, defs[i][1]());
  };
  defs.forEach(([label], i) => bar.append(h('button', { type: 'button', role: 'tab', onclick: () => show(i) }, label)));
  show(initial);
  return h('div', {}, bar, panel);
}

function tokenModal(reason) {
  if (document.querySelector('[aria-label="Ключ администратора"][role=dialog]')) return;
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'ADMIN_TOKEN' });
  const close = openModal({
    title: 'Ключ администратора',
    body: h('div', {},
      reason ? h('p', { class: 'muted' }, reason) : null,
      h('label', { class: 'field' }, h('span', {}, 'Ключ'), input,
        h('span', { class: 'hint' }, 'Хранится только в памяти этой вкладки и пропадает при перезагрузке.'))),
    footer: [
      h('button', { class: 'btn left', onclick: () => { state.token = null; toast('Ключ сброшен'); close(); } }, 'Сбросить'),
      h('button', { class: 'btn', onclick: () => close() }, 'Отмена'),
      h('button', { class: 'btn accent', onclick: () => { state.token = input.value.trim() || null; toast(state.token ? 'Ключ сохранён' : 'Ключ не задан'); close(); } }, 'Сохранить'),
    ],
  });
}

// ---------- data table (column chooser, sort, totals, search, pagination, export) ----------
function dataTable({ id, columns, rows = [], selectable = false, pageSize = 50, rowClass, totals = true, serverPaging = null, empty = 'Нет данных', compact = false }) {
  let data = rows;
  let sort = store.get('sort:' + id, null);
  let page = 0;
  let size = store.get('size:' + id, pageSize);
  let search = document.getElementById('global-search').value.trim().toLowerCase();
  const hidden = new Set(store.get('cols:' + id, columns.filter((c) => c.hidden).map((c) => c.key)));
  const selected = new Set();
  const root = h('div');
  const visible = () => columns.filter((c) => c.fixed || !hidden.has(c.key));
  const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);

  function filtered() {
    let out = data;
    if (search) out = out.filter((r) => columns.some((c) => String(valueOf(c, r) ?? '').toLowerCase().includes(search)));
    if (sort) {
      const c = columns.find((x) => x.key === sort.key);
      if (c) out = [...out].sort((a, b) => {
        const va = valueOf(c, a); const vb = valueOf(c, b);
        const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), 'ru', { numeric: true });
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }

  function render() {
    const cols = visible();
    const all = filtered();
    const pages = serverPaging ? 1 : Math.max(1, Math.ceil(all.length / size));
    page = Math.min(page, pages - 1);
    const shown = serverPaging ? all : all.slice(page * size, page * size + size);
    const headCheck = selectable ? h('th', { style: 'width:30px', onclick: (e) => e.stopPropagation() },
      h('input', { type: 'checkbox', 'aria-label': 'Выбрать все', checked: shown.length > 0 && shown.every((r) => selected.has(r.id)),
        onchange: (e) => { shown.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); render(); root.dispatchEvent(new Event('selection')); } })) : null;
    const thead = h('thead', {}, h('tr', {}, headCheck, cols.map((c) => h('th', {
      class: [c.num ? 'num' : '', sort?.key === c.key ? 'sorted' : ''].join(' '),
      title: c.title || null,
      onclick: c.sortable === false ? null : () => { sort = sort?.key === c.key ? { key: c.key, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key: c.key, dir: c.num ? 'desc' : 'asc' }; store.set('sort:' + id, sort); render(); },
    }, c.label, sort?.key === c.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''))));
    const tbody = h('tbody', {}, shown.length ? shown.map((r) => h('tr', { class: rowClass ? rowClass(r) : null },
      selectable ? h('td', { class: 'sel' }, h('input', { type: 'checkbox', 'aria-label': 'Выбрать', checked: selected.has(r.id),
        onchange: (e) => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); root.dispatchEvent(new Event('selection')); } })) : null,
      cols.map((c) => h('td', { class: [c.num ? 'num' : '', c.cls || ''].join(' '), title: c.tip ? c.tip(r) : null, 'data-label': c.label }, c.render ? c.render(r) : (valueOf(c, r) ?? '—')))))
      : h('tr', {}, h('td', { colspan: cols.length + (selectable ? 1 : 0), class: 'empty' }, empty)));
    const tfoot = totals && all.length ? h('tfoot', {}, h('tr', {}, selectable ? h('td') : null,
      cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.total ? c.total(all) : '')))) : null;
    const sizeSel = h('select', { class: 'select', 'aria-label': 'Строк на странице', onchange: (e) => { size = Number(e.target.value); store.set('size:' + id, size); page = 0; serverPaging ? serverPaging.setLimit(size) : render(); } },
      (serverPaging ? [25, 50, 100] : [25, 50, 100, 250]).map((n) => h('option', { value: n, selected: n === size }, n)));
    const pager = serverPaging
      ? [h('button', { class: 'btn square', disabled: !serverPaging.hasPrev(), 'aria-label': 'Назад', onclick: () => serverPaging.prev() }, '‹'),
        h('button', { class: 'btn square', disabled: !serverPaging.hasNext(), 'aria-label': 'Вперёд', onclick: () => serverPaging.next() }, '›'), sizeSel,
        h('span', { class: 'muted' }, serverPaging.label())]
      : [h('button', { class: 'btn square', disabled: page === 0, 'aria-label': 'Назад', onclick: () => { page -= 1; render(); } }, '‹'),
        h('button', { class: 'btn square', disabled: page >= pages - 1, 'aria-label': 'Вперёд', onclick: () => { page += 1; render(); } }, '›'), sizeSel,
        h('span', { class: 'muted' }, all.length ? `${page * size + 1} - ${Math.min(all.length, (page + 1) * size)} из ${all.length}` : '0 из 0')];
    put(root, 
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, thead, tbody, tfoot)),
      compact ? '' : h('div', { class: 'pager' }, pager, h('span', { class: 'spacer' }), exportMenu(cols, all)));
  }

  function exportMenu(cols, all) {
    const wrap = h('span', { class: 'dropdown' });
    const plain = (c, r) => { const v = valueOf(c, r); return v === null || v === undefined ? '' : String(v); };
    const close = () => wrap.querySelector('.menu')?.remove();
    const csv = () => {
      const esc = (v) => (/[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
      download(id + '.csv', 'text/csv;charset=utf-8', '﻿' + [cols.map((c) => esc(c.label)).join(','), ...all.map((r) => cols.map((c) => esc(plain(c, r))).join(','))].join('\n'));
      close();
    };
    const html = () => {
      const esc = (v) => v.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
      download(id + '.html', 'text/html;charset=utf-8', `<!doctype html><meta charset="utf-8"><title>${id}</title><table border="1" cellpadding="4" style="border-collapse:collapse;font:13px sans-serif"><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>${all.map((r) => `<tr>${cols.map((c) => `<td>${esc(plain(c, r))}</td>`).join('')}</tr>`).join('')}</table>`);
      close();
    };
    wrap.append(h('button', { class: 'btn', onclick: () => { if (wrap.querySelector('.menu')) return close(); wrap.append(h('div', { class: 'menu' }, h('button', { onclick: csv }, 'CSV'), h('button', { onclick: html }, 'HTML'))); } }, 'Экспорт ▴'));
    return wrap;
  }

  function chooser() {
    const draft = new Set(hidden);
    const list = h('div', { class: 'col-list' });
    const filter = h('input', { class: 'input', type: 'search', placeholder: 'Поиск…', style: 'width:100%;margin-bottom:8px', oninput: () => draw() });
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      put(list, 
        h('label', {}, h('input', { type: 'checkbox', checked: columns.every((c) => c.fixed || !draft.has(c.key)), onchange: (e) => { columns.forEach((c) => (e.target.checked ? draft.delete(c.key) : draft.add(c.key))); draw(); } }), h('b', {}, 'Выбрать все')),
        columns.filter((c) => !c.fixed && (c.title || c.label).toLowerCase().includes(q)).map((c) => h('label', {},
          h('input', { type: 'checkbox', checked: !draft.has(c.key), onchange: (e) => (e.target.checked ? draft.delete(c.key) : draft.add(c.key)) }),
          c.title || c.label)));
    };
    draw();
    const close = openModal({
      title: 'Выбор колонок',
      body: h('div', {}, filter, list),
      footer: [
        h('button', { class: 'btn left', onclick: () => { draft.clear(); columns.filter((c) => c.hidden).forEach((c) => draft.add(c.key)); draw(); } }, 'Восстановить'),
        h('button', { class: 'btn', onclick: () => close() }, 'Отменить'),
        h('button', { class: 'btn primary', onclick: () => { hidden.clear(); draft.forEach((k) => hidden.add(k)); store.set('cols:' + id, [...hidden]); close(); render(); } }, 'Применить'),
      ],
    });
  }

  const onSearch = (e) => { search = e.detail; page = 0; render(); };
  document.addEventListener('umbrella:search', onSearch);
  render();
  return Object.assign(root, {
    setRows(next) { data = next; [...selected].forEach((k) => { if (!data.some((r) => r.id === k)) selected.delete(k); }); render(); },
    selected: () => [...selected],
    clearSelection() { selected.clear(); render(); },
    chooser,
    detach() { document.removeEventListener('umbrella:search', onSearch); },
  });
}
document.getElementById('global-search').addEventListener('input', (e) => document.dispatchEvent(new CustomEvent('umbrella:search', { detail: e.target.value.trim().toLowerCase() })));

// Traffic simulation: where a visitor with these properties would go and why. Nothing is recorded.
const SIM_AGENTS = [
  ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'],
  ['Android', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36'],
  ['Windows · Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'],
  ['Mac · Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'],
  ['Бот (Googlebot)', 'Googlebot/2.1 (+http://www.google.com/bot.html)'],
];
const CAP_REASON = { archived: 'в архиве', click_cap: 'кап кликов', conversion_cap: 'кап конверсий' };
function simulateModal(campaignId) {
  const q = { country: 'FR', ua: SIM_AGENTS[0][1], ip: '', language: 'fr', query: '', referrer: '', at: '' };
  const out = h('div', { 'aria-live': 'polite' });
  const input = (key, attrs = {}) => h('input', { class: 'input', value: q[key], oninput: (e) => { q[key] = e.target.value.trim(); }, ...attrs });
  const OUTCOME = { click: 'Клик засчитается', bot: 'Бот: уйдёт туда же, клик не засчитается', redirect: 'Редирект', blocked: 'Отказ', no_stream: 'Нет подходящего потока', not_found: 'Ответ 404', error: 'Ошибка' };
  const run = async () => {
    put(out, h('p', { class: 'muted' }, 'Считаю…'));
    try {
      const r = await api('/api/simulate', { method: 'POST', body: { campaign: campaignId, country: q.country, userAgent: q.ua, ip: q.ip, language: q.language, query: q.query, referrer: q.referrer || undefined, at: q.at ? new Date(q.at).toISOString() : undefined } });
      const v = r.visitor || {};
      put(out,
        h('p', { class: 'muted' }, `Посетитель: ${v.country || 'страна ?'} · ${v.device} · ${v.os} · ${v.browser}${v.language ? ' · ' + v.language : ''}${v.isp ? ' · ' + v.isp : ''}${v.datacenter ? ' (дата-центр)' : ''}`),
        ...r.steps.map((st) => h('div', { class: 'card', style: 'margin-bottom:10px' },
          h('b', {}, st.name || st.campaign), st.checks?.map((c) => h('p', { class: 'err' }, `${c.check}: ${c.note}`)),
          (st.streams || []).map((s) => h('div', { style: 'margin-top:6px' },
            h('span', { class: s.matches && s.enabled ? 'pos' : 'muted' }, `${s.matches && s.enabled ? '✓' : '✗'} ${s.name} (${typeLabel[s.type] || s.type})`),
            !s.enabled ? h('span', { class: 'muted' }, ' — выключен') : null,
            s.checks.length ? h('span', { class: 'muted' }, ' — ' + s.checks.map((c) => (c.op ? `${c.condition}${c.not ? ' НЕ' : ''}: ${c.actual ?? '?'} ${c.op} ${c.expected.join(', ')} ${c.ok ? '✓' : '✗'}`
              : `${c.condition}: ${c.actual ?? '?'} ${c.ok !== Boolean(c.not) ? '∈' : '∉'} ${c.not ? 'НЕ ' : ''}${c.expected.join(', ')}${c.not ? (c.ok ? ' ✓' : ' ✗') : ''}`)).join(s.mode === 'or' ? ' ИЛИ ' : '; ')) : h('span', { class: 'muted' }, ' — без условий'),
            s.cappedOffers?.length ? h('span', { class: 'err' }, ` · кап: ${s.cappedOffers.map((o) => `${o.offerId} (${CAP_REASON[o.reason] || o.reason}${o.altOfferId ? ` → ${o.altOfferId}` : ''})`).join(', ')}`) : null)),
          st.chosen ? h('p', {}, 'Выбор: ', st.chosen.map((c) => `${c.stream} — ${String(c.share).replace('.', ',')}%`).join(', ')) : null)),
        h('div', { class: 'card' },
          h('b', {}, `${OUTCOME[r.result.outcome] || r.result.outcome} · HTTP ${r.result.status}`), r.result.reason ? h('p', { class: 'muted' }, r.result.reason) : null,
          r.result.landing ? h('p', {}, 'Лендинг: ', h('code', {}, r.result.landing)) : null,
          (r.result.destinations || []).map((d) => h('p', {}, d.offerId ? `${d.offerId}${d.insteadOf ? ` вместо ${d.insteadOf}` : ''} (${String(d.share).replace('.', ',')}%): ` : '', h('code', { style: 'word-break:break-all' }, d.url || '—'))),
          r.result.url ? h('p', {}, h('code', { style: 'word-break:break-all' }, r.result.url)) : null));
    } catch (e) { put(out, h('p', { class: 'err' }, 'Не удалось: ' + e.message)); }
  };
  openModal({ title: 'Проверить маршрут', wide: true, body: h('div', {},
    h('p', { class: 'muted' }, 'Показывает, куда уйдёт посетитель с такими свойствами и почему. Клик не записывается.'),
    h('div', { class: 'grid2' },
      field('Страна', input('country', { placeholder: 'FR', maxlength: 2 }), 'Пусто — определить по IP.'),
      field('IP', input('ip', { placeholder: 'необязательно' }), 'Для провайдера, дата-центра и списков IP.'),
      field('Браузер', h('select', { class: 'select', onchange: (e) => { q.ua = e.target.value; } }, SIM_AGENTS.map(([l, ua]) => h('option', { value: ua }, l)))),
      field('Язык', input('language', { placeholder: 'fr', maxlength: 2 })),
      field('Параметры ссылки', input('query', { placeholder: 'fbclid=…&utm_campaign=…' }), 'Как в ссылке кампании, после «?».'),
      field('Реферер', input('referrer', { placeholder: 'https://m.facebook.com/' }), 'Пусто — переход без реферера.'),
      field('Время визита', input('at', { type: 'datetime-local' }), 'Пусто — сейчас. Для расписания потоков.')),
    out),
    footer: [h('button', { class: 'btn primary', onclick: run }, 'Проверить')] });
}

// Metric column helpers shared by stats tables.
const metricCols = (opts = {}) => [
  { key: 'clicks', label: 'Клики', num: true, render: (r) => num(r.clicks), total: (rs) => num(sum(rs, 'clicks')) },
  { key: 'uniqueClicks', label: 'Уник.', title: 'Уникальные клики (кампания)', num: true, render: (r) => num(r.uniqueClicks), total: (rs) => num(sum(rs, 'uniqueClicks')) },
  { key: 'conversions', label: 'Конв.', title: 'Конверсии', num: true, render: (r) => num(r.conversions), total: (rs) => num(sum(rs, 'conversions')) },
  { key: 'cr', label: 'CR', title: 'CR — коэффициент конверсии', num: true, value: (r) => ratio(r.conversions, r.clicks), render: (r) => pct(ratio(r.conversions, r.clicks)), total: (rs) => pct(ratio(sum(rs, 'conversions'), sum(rs, 'clicks'))) },
  { key: 'revenue', label: 'Доход', num: true, render: (r) => money(r.revenue), total: (rs) => money(sum(rs, 'revenue')) },
  { key: 'cost', label: 'Расход', num: true, render: (r) => money(r.cost), total: (rs) => money(sum(rs, 'cost')) },
  { key: 'profit', label: 'Прибыль', num: true, value: (r) => (r.revenue || 0) - (r.cost || 0), render: (r) => { const p = (r.revenue || 0) - (r.cost || 0); return h('span', { class: p >= 0 ? 'pos' : 'neg' }, money(p)); }, total: (rs) => { const p = sum(rs, 'revenue') - sum(rs, 'cost'); return h('span', { class: p >= 0 ? 'pos' : 'neg' }, money(p)); } },
  { key: 'roi', label: 'ROI', num: true, value: (r) => ratio((r.revenue || 0) - (r.cost || 0), r.cost), render: (r) => pct(ratio((r.revenue || 0) - (r.cost || 0), r.cost)), total: (rs) => pct(ratio(sum(rs, 'revenue') - sum(rs, 'cost'), sum(rs, 'cost'))) },
  { key: 'epc', label: 'EPC', title: 'EPC — доход с клика', num: true, value: (r) => ratio(r.revenue, r.clicks), render: (r) => money4(ratio(r.revenue, r.clicks)), total: (rs) => money4(ratio(sum(rs, 'revenue'), sum(rs, 'clicks'))) },
  { key: 'rpm', label: 'RPM', title: 'RPM — доход на 1000 кликов', num: true, hidden: !opts.rpm, value: (r) => ratio(r.revenue * 1000, r.clicks), render: (r) => money(ratio(r.revenue * 1000, r.clicks)), total: (rs) => money(ratio(sum(rs, 'revenue') * 1000, sum(rs, 'clicks'))) },
  { key: 'leads', label: 'Лиды', title: 'Лиды — конверсии в ожидании', num: true, hidden: true, render: (r) => num(r.leads), total: (rs) => num(sum(rs, 'leads')) },
  { key: 'sales', label: 'Продажи', title: 'Продажи — подтверждённые конверсии', num: true, hidden: true, render: (r) => num(r.sales), total: (rs) => num(sum(rs, 'sales')) },
  { key: 'rejected', label: 'Отклонённые', num: true, hidden: true, render: (r) => num(r.rejected), total: (rs) => num(sum(rs, 'rejected')) },
  { key: 'pendingRevenue', label: 'Доход (ожидаемый)', title: 'Сумма по лидам, ещё не подтверждённым', num: true, hidden: true, render: (r) => money(r.pendingRevenue), total: (rs) => money(sum(rs, 'pendingRevenue')) },
  { key: 'uepc', label: 'uEPC', title: 'uEPC — доход на уникальный клик', num: true, hidden: true, value: (r) => (r.uniqueClicks ? r.revenue / r.uniqueClicks : 0), render: (r) => (r.uniqueClicks ? money4(r.revenue / r.uniqueClicks) : '—'), total: (rs) => { const u = sum(rs, 'uniqueClicks'); return u ? money4(sum(rs, 'revenue') / u) : '—'; } },
  { key: 'approvePct', label: 'Approve %', title: 'Approve % — доля подтверждённых от всех завершённых', num: true, hidden: true, value: (r) => { const d = (r.sales || 0) + (r.rejected || 0) + (r.leads || 0); return d ? (r.sales || 0) / d : 0; }, render: (r) => { const d = (r.sales || 0) + (r.rejected || 0) + (r.leads || 0); return d ? pct((r.sales || 0) / d) : '—'; }, total: (rs) => { const d = sum(rs, 'sales') + sum(rs, 'rejected') + sum(rs, 'leads'); return d ? pct(sum(rs, 'sales') / d) : '—'; } },
  { key: 'crHold', label: 'CR (холд)', title: 'CR (холд) — доля лидов от кликов', num: true, hidden: true, value: (r) => ratio(r.leads, r.clicks), render: (r) => (r.clicks ? pct(ratio(r.leads, r.clicks)) : '—'), total: (rs) => { const c = sum(rs, 'clicks'); return c ? pct(sum(rs, 'leads') / c) : '—'; } },
  { key: 'cpa', label: 'CPA', title: 'CPA — расход на продажу', num: true, hidden: true, value: (r) => (r.sales ? (r.cost || 0) / r.sales : 0), render: (r) => (r.sales ? money4((r.cost || 0) / r.sales) : '—'), total: (rs) => { const s = sum(rs, 'sales'); return s ? money4(sum(rs, 'cost') / s) : '—'; } },
];
const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const groupRows = (obj) => Object.entries(obj || {}).map(([id, v]) => ({ id, clicks: v.clicks || 0, uniqueClicks: v.uniqueClicks || 0, conversions: v.conversions || 0, revenue: v.revenue || 0, cost: v.cost || 0, lpClicks: v.lpClicks || 0,
  leads: v.leads || 0, sales: v.sales || 0, rejected: v.rejected || 0, pendingRevenue: v.pendingRevenue || 0 }));
// Campaigns bound to a tracking domain get links on that domain (served at the root, HTTPS).
const trackingUrl = (id) => (state.campaigns[id]?.domain ? `https://${state.campaigns[id].domain}/r/${encodeURIComponent(id)}` : `${location.origin}${BASE}/r/${encodeURIComponent(id)}`);
const typeLabel = { regular: 'Обычный', fallback: 'Замыкающий', forced: 'Перехватывающий' };

// ---------- chart ----------
function lineChart(series, buckets) {
  const box = h('div');
  const on = new Set(store.get('chart', ['clicks', 'conversions']));
  const draw = () => {
    const W = Math.max(320, box.clientWidth || 800); const H = 220; const pad = { l: 44, r: 54, t: 12, b: 26 };
    const svgNS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'График по периоду' });
    const counts = series.filter((s) => on.has(s.key) && !s.right);
    const rights = series.filter((s) => on.has(s.key) && s.right);
    const maxL = Math.max(1, ...counts.flatMap((s) => s.values));
    const maxR = Math.max(1, ...rights.flatMap((s) => s.values));
    const x = (i) => pad.l + (buckets.length <= 1 ? (W - pad.l - pad.r) / 2 : i * (W - pad.l - pad.r) / (buckets.length - 1));
    const yL = (v) => H - pad.b - v / maxL * (H - pad.t - pad.b);
    const yR = (v) => H - pad.b - v / maxR * (H - pad.t - pad.b);
    for (let g = 0; g <= 4; g += 1) {
      const y = pad.t + g * (H - pad.t - pad.b) / 4;
      svg.append(el('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': 0.12 }));
      const lt = el('text', { x: pad.l - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.55 });
      lt.textContent = num(Math.round(maxL * (1 - g / 4))); svg.append(lt);
      if (rights.length) { const rt = el('text', { x: W - pad.r + 6, y: y + 4, 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.55 }); rt.textContent = money(maxR * (1 - g / 4)); svg.append(rt); }
    }
    const step = Math.ceil(buckets.length / Math.max(1, Math.floor((W - pad.l - pad.r) / 56)));
    buckets.forEach((b, i) => { if (i % step) return; const t = el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.55 }); t.textContent = b.label; svg.append(t); });
    for (const s of [...counts, ...rights]) {
      const y = s.right ? yR : yL;
      const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      svg.append(el('polygon', { points: `${x(0)},${H - pad.b} ${pts} ${x(s.values.length - 1)},${H - pad.b}`, fill: s.color, 'fill-opacity': 0.12 }));
      svg.append(el('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2 }));
      s.values.forEach((v, i) => { const c = el('circle', { cx: x(i), cy: y(v), r: 3, fill: '#16191b', stroke: s.color, 'stroke-width': 1.5 }); const tt = el('title', {}); tt.textContent = `${buckets[i].label}: ${s.label} ${s.right ? money(v) : num(v)}`; c.append(tt); svg.append(c); });
    }
    put(box, svg, h('div', { class: 'legend' }, series.map((s) => h('button', {
      class: on.has(s.key) ? '' : 'off', 'aria-pressed': String(on.has(s.key)),
      onclick: () => { on.has(s.key) ? on.delete(s.key) : on.add(s.key); store.set('chart', [...on]); draw(); },
    }, h('i', { style: `background:${s.color}` }), s.label))));
  };
  requestAnimationFrame(draw);
  return box;
}

async function timeseries({ campaign, offer, from, to }) {
  const single = from && from === to;
  const gran = single ? 'hour' : 'day';
  const ts = await api('/stats/timeseries' + qs({ campaign, offer, from, to, granularity: gran }));
  const byKey = new Map(ts.series.map((p) => [String(p.date ?? p.bucket ?? '').slice(0, single ? 13 : 10), p]));
  let keys = [];
  if (single) keys = Array.from({ length: 24 }, (_, i) => `${from}T${String(i).padStart(2, '0')}`);
  else if (from && to) { for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) keys.push(d.toISOString().slice(0, 10)); }
  else keys = [...byKey.keys()].sort();
  return keys.map((k) => { const p = byKey.get(k); return { key: k, label: single ? k.slice(11) + ':00' : k.slice(5).split('-').reverse().join('.'), clicks: p?.clicks || 0, uniqueClicks: p?.uniqueClicks || 0, conversions: p?.conversions || 0, revenue: p?.revenue || 0, cost: p?.cost || 0 }; });
}

// ---------- pages ----------
async function pageDashboard() {
  const body = h('div', {}, 'Загрузка…');
  const campSel = h('select', { class: 'select', 'aria-label': 'Кампания', onchange: () => load() }, h('option', { value: '' }, 'Все кампании'),
    Object.entries(state.campaigns).map(([id, c]) => h('option', { value: id }, c.name || id)));
  put(view, h('div', { class: 'page-head' }, h('h1', {}, 'Дашборд'),
    h('div', { class: 'toolbar', style: 'margin:0' }, campSel, periodControl(() => load()), currencyControl(() => load()), h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'))), body);
  async function load() {
    const { from, to } = periodRange();
    const campaign = campSel.value || null;
    try {
      const [s, series, recent, team, botsData, statsBotsData] = await Promise.all([api('/stats' + qs({ from, to, campaign })), timeseries({ campaign, from, to }), api('/api/clicks' + qs({ from, to, campaign, limit: 10 })).catch(() => ({ clicks: [] })), api('/api/settings').catch(() => ({ buyerSharePct: 35 })), api('/api/bots' + qs({ from, to, campaign, limit: 1000 })).catch(() => ({ bots: [] })), api('/stats/bots' + qs({ from, to, campaign })).catch(() => ({ total: 0, byCampaign: {} }))]);
      const sharePct = Number(team.buyerSharePct) || 0;
      const profit = (s.revenue || 0) - (s.cost || 0);
      // The buyer earns a share of positive net profit; a loss means 0, not a negative payout.
      const buyerEarnings = Math.max(0, profit) * sharePct / 100;
      const isOwner = state.me?.user?.role === 'owner' || !state.me?.loginRequired;
      const earningsTile = h('div', { class: 'kpi' + (isOwner ? ' kpi-edit' : ''), style: 'background:var(--k6)', title: isOwner ? 'Нажмите, чтобы изменить процент' : null,
        onclick: isOwner ? () => shareModal(sharePct, () => load()) : null },
        h('div', { class: 'k' }, `Заработок баера · ${sharePct.toLocaleString('ru-RU')}%`), h('div', { class: 'v' }, money(buyerEarnings)));
      const kpi = (label, value, color) => h('div', { class: 'kpi', style: `background:${color}` }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value));
      const small = (title, id, rows, nameOf, link) => h('div', { class: 'card' }, h('h2', {}, title), dataTable({
        id: 'dash-' + id, pageSize: 10, compact: true, rows: rows.sort((a, b) => b.clicks - a.clicks),
        columns: [{ key: 'id', label: title, fixed: true, cls: 'name', render: (r) => (link ? h('a', { href: link(r) }, nameOf(r)) : nameOf(r)) },
          ...metricCols().filter((c) => ['clicks', 'conversions', 'cr', 'revenue'].includes(c.key))],
      }));
      const top5 = (id, title, rows, nameOf, link) => h('div', { class: 'card' }, h('h2', {}, title), dataTable({ id: 'dash-t5-' + id, pageSize: 5, compact: true, totals: false, rows: [...rows].sort((a, b) => b.revenue - a.revenue).slice(0, 5), columns: [{ key: 'id', label: 'Название', fixed: true, cls: 'name', render: (r) => h('a', { href: link(r) }, nameOf(r)) }, ...metricCols().filter((c) => ['clicks', 'conversions', 'revenue', 'roi'].includes(c.key))] }));
      put(body, 
        h('div', { class: 'kpis' }, kpi('Клики', num(s.clicks), 'var(--k1)'), kpi('Уник. клики', num(s.uniqueClicks), 'var(--k2)'), kpi('Конверсии', num(s.conversions), 'var(--k3)'), kpi('CR', pct(ratio(s.conversions, s.clicks)), 'var(--k2)'),
          kpi('Доход', money(s.revenue), 'var(--k5)'), kpi('Расход', money(s.cost || 0), 'var(--k4)'), kpi('Прибыль', h('span', { class: profit >= 0 ? '' : 'neg' }, money(profit)), 'var(--k8)'), kpi('ROI', pct(ratio(profit, s.cost || 0)), 'var(--k9)'), earningsTile,
          kpi('EPC', money4(ratio(s.revenue, s.clicks)), 'var(--k6)'), kpi('RPM', money(ratio(s.revenue * 1000, s.clicks)), 'var(--k7)'),
          botsData.bots?.length > 0 ? h('a', { href: '#/botlog' + (campaign ? qs({ campaign }) : ''), style: 'text-decoration:none' },
            h('div', { class: 'kpi', style: 'background:var(--bad)' }, h('div', { class: 'k' }, 'Боты'), h('div', { class: 'v' }, botsData.bots.length >= 1000 ? '1000+' : num(botsData.bots.length)))) : null),
        ratesNote(),
        (() => {
          const MIN_CLICKS = 100; const ROI_ALERT = -0.5; const BOT_PCT_ALERT = 0.3;
          const campRows = groupRows(s.byCampaign);
          const botsByCamp = statsBotsData.byCampaign || {};
          const items = [
            ...campRows.filter((r) => r.clicks >= MIN_CLICKS && ratio(r.revenue - r.cost, r.cost) <= ROI_ALERT)
              .map((r) => ({ text: `${state.campaigns[r.id]?.name || r.id}: ROI ${pct(ratio(r.revenue - r.cost, r.cost))}`, link: '#/reports' + qs({ group: 'stream', campaign: r.id }) })),
            ...groupRows(s.byOffer).filter((r) => r.clicks >= MIN_CLICKS && (r.conversions || 0) === 0)
              .map((r) => ({ text: `Оффер ${r.id}: ${num(r.clicks)} кл., 0 конв.`, link: '#/reports' + qs({ group: 'country', offer: r.id }) })),
            ...campRows.filter((r) => r.clicks >= MIN_CLICKS && (botsByCamp[r.id] || 0) / r.clicks > BOT_PCT_ALERT)
              .map((r) => ({ text: `${state.campaigns[r.id]?.name || r.id}: боты ${pct((botsByCamp[r.id] || 0) / r.clicks)}`, link: '#/botlog' + qs({ campaign: r.id }) })),
          ];
          return items.length > 0
            ? h('div', { class: 'card', style: 'margin-bottom:14px;border-left:3px solid var(--bad,#c0392b)' },
                h('h2', { style: 'color:var(--bad,#c0392b);margin:0 0 8px' }, 'Требуют внимания'),
                ...items.map((item) => h('div', { style: 'display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--border,#e0e0e0)' },
                  h('span', { style: 'flex:1' }, item.text),
                  h('a', { href: item.link, class: 'btn' }, 'Открыть'))))
            : null;
        })(),
        h('div', { class: 'card', style: 'margin-bottom:14px' }, lineChart([
          { key: 'clicks', label: 'Клики', color: '#4d86f0', values: series.map((p) => p.clicks) },
          { key: 'conversions', label: 'Конв.', color: '#e0496a', values: series.map((p) => p.conversions) },
          { key: 'revenue', label: 'Доход', color: '#e8913f', right: true, values: series.map((p) => p.revenue) },
        ], series)),
        h('div', { class: 'grid-2', style: 'margin-bottom:14px' },
          top5('camp', 'Топ кампаний', groupRows(s.byCampaign), (r) => state.campaigns[r.id]?.name || r.id, (r) => '#/reports' + qs({ group: 'stream', campaign: r.id })),
          top5('offer', 'Топ офферов', groupRows(s.byOffer), (r) => r.id, (r) => '#/reports' + qs({ group: 'country', offer: r.id })),
          top5('geo', 'Топ стран', groupRows(s.byCountry), (r) => r.id, (r) => '#/reports' + qs({ group: 'campaign', country: r.id }))),
        isOwnerView() ? h('div', { class: 'card', style: 'margin-bottom:14px' }, h('h2', {}, 'Баеры'), dataTable({
          id: 'dash-buyers', compact: true, pageSize: 50,
          rows: Object.values(Object.entries(s.byCampaign || {}).reduce((acc, [cid, v]) => {
            const owner = state.campaigns[cid]?.ownerId || '';
            const row = acc[owner] ||= { id: owner || '(без баера)', name: owner ? userEmail(owner) : 'Без баера', campaigns: 0, clicks: 0, conversions: 0, revenue: 0, cost: 0 };
            row.campaigns += 1; row.clicks += v.clicks || 0; row.conversions += v.conversions || 0; row.revenue += v.revenue || 0; row.cost += v.cost || 0;
            return acc;
          }, {})).sort((a, b) => (b.revenue - b.cost) - (a.revenue - a.cost)),
          columns: [
            { key: 'name', label: 'Баер', fixed: true },
            { key: 'campaigns', label: 'Кампании', num: true },
            ...metricCols().filter((c) => ['clicks', 'conversions', 'revenue'].includes(c.key)),
            { key: 'cost', label: 'Расход', num: true, render: (r) => money(r.cost), total: (rs) => money(sum(rs, 'cost')) },
            { key: 'profit', label: 'Прибыль', num: true, value: (r) => r.revenue - r.cost, render: (r) => h('span', { class: r.revenue - r.cost >= 0 ? 'pos' : 'neg' }, money(r.revenue - r.cost)), total: (rs) => money(sum(rs, 'revenue') - sum(rs, 'cost')) },
            { key: 'earn', label: `Заработок · ${sharePct}%`, num: true, value: (r) => Math.max(0, r.revenue - r.cost) * sharePct / 100, render: (r) => money(Math.max(0, r.revenue - r.cost) * sharePct / 100),
              total: (rs) => money(rs.reduce((t, r) => t + Math.max(0, r.revenue - r.cost) * sharePct / 100, 0)) },
          ],
        })) : null,
        h('div', { class: 'grid-2' },
          small('Кампания', 'campaigns', groupRows(s.byCampaign), (r) => state.campaigns[r.id]?.name || r.id, (r) => '#/campaigns/' + encodeURIComponent(r.id)),
          small('Оффер', 'offers', groupRows(s.byOffer), (r) => r.id, (r) => '#/reports' + qs({ group: 'country', offer: r.id })),
          small('Поток', 'streams', groupRows(s.byStream), (r) => r.id),
          small('Страна', 'countries', groupRows(s.byCountry), (r) => r.id)),
        h('div', { class: 'card' }, h('h2', {}, 'Последние клики'), dataTable({
          id: 'dash-recent', totals: false, compact: true, rows: recent.clicks.map((c) => ({ ...c, id: c.clickId })),
          columns: [
            { key: 'at', label: 'Дата и время', render: (r) => dt(r.at) },
            { key: 'id', label: 'Click ID', cls: 'mono', render: (r) => r.id.slice(0, 8) + '…', tip: (r) => r.id },
            { key: 'campaign', label: 'Кампания', cls: 'name', render: (r) => h('a', { href: '#/campaigns/' + encodeURIComponent(r.campaign) }, state.campaigns[r.campaign]?.name || r.campaign) },
            { key: 'stream', label: 'Поток' }, { key: 'offerId', label: 'Оффер' }, { key: 'ip', label: 'IP' }, { key: 'country', label: 'Страна' },
          ],
        })));
    } catch (e) { put(body, h('p', { class: 'err' }, 'Ошибка загрузки: ' + e.message)); }
  }
  load();
}

function shareModal(current, onSaved) {
  let value = String(current);
  const err = h('p', { class: 'err' });
  const close = openModal({
    title: 'Доля баера',
    body: h('div', {},
      field('Процент от чистой прибыли', h('input', { class: 'input', type: 'number', min: 0, max: 100, step: '0.5', value, oninput: (e) => { value = e.target.value; } }),
        'Чистая прибыль = доход − расход. При убытке заработок баера = 0.'),
      err),
    footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => {
      const pct = Number(value);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) { err.textContent = 'Процент от 0 до 100.'; return; }
      try { await api('/api/settings', { method: 'PATCH', body: { buyerSharePct: pct } }); toast('Доля баера сохранена'); close(); onSaved(); }
      catch (e) { err.textContent = e.message === 'owner_only' ? 'Менять процент может только владелец.' : 'Не сохранено: ' + e.message; }
    } }, 'Сохранить')],
  });
}

async function pageCampaigns() {
  const stateFilter = h('select', { class: 'select', 'aria-label': 'Состояние', onchange: () => load() },
    [['', 'Все состояния'], ['active', 'Активные'], ['inactive', 'Неактивные'], ['clicks', 'С кликами'], ['archived', 'Архив']].map(([v, l]) => h('option', { value: v }, l)));
  const groupSel = groupFilter(() => load());
  const bulk = h('span', { class: 'toolbar', style: 'margin:0' });
  const table = dataTable({
    id: 'campaigns', selectable: true, pageSize: 250,
    rowClass: (r) => (r.active ? '' : 'inactive'),
    columns: [
      { key: 'active', label: '', fixed: true, sortable: false, value: (r) => (r.active ? 'вкл' : 'выкл'), render: (r) => h('span', { class: 'dot' + (r.active ? ' on' : ''), title: r.active ? 'Включена' : 'Выключена' }) },
      { key: 'id', label: 'ID', fixed: true },
      { key: 'name', label: 'Название', fixed: true, cls: 'name', render: (r) => h('a', { href: '#/campaigns/' + encodeURIComponent(r.id), title: r.name }, r.name) },
      { key: 'menu', label: '', title: 'Меню', sortable: false, value: () => '', render: (r) => h('span', { class: 'row-actions' },
        h('button', { title: 'Копировать ссылку', 'aria-label': 'Копировать ссылку', onclick: () => copyText(trackingUrl(r.id)) }, '🔗'),
        h('a', { href: '#/reports' + qs({ group: 'stream', campaign: r.id }), title: 'Отчёт', 'aria-label': 'Отчёт' }, '▥'),
        h('a', { href: '#/clicks' + qs({ campaign: r.id }), title: 'Лог кликов', 'aria-label': 'Лог кликов' }, '☰'),
        h('button', { title: r.active ? 'Выключить' : 'Включить', 'aria-label': r.active ? 'Выключить' : 'Включить', onclick: () => setActive([r.id], !r.active) }, r.active ? '⏸' : '▶')) },
      { key: 'group', label: 'Группа', value: (r) => r.group || '', render: (r) => r.group || '—' },
      { key: 'owner', label: 'Баер', hidden: !isOwnerView(), value: (r) => (r.ownerId ? userEmail(r.ownerId) : '—') },
      { key: 'streams', label: 'Потоки', num: true, render: (r) => h('a', { href: '#/campaigns/' + encodeURIComponent(r.id) }, r.streams), total: (rs) => num(sum(rs, 'streams')) },
      ...metricCols(),
      { key: 'dailyCap', label: 'Дневной кап', num: true, hidden: true, render: (r) => r.dailyCap ?? '—' },
      { key: 'totalCap', label: 'Общий кап', num: true, hidden: true, render: (r) => r.totalCap ?? '—' },
      { key: 'revenueCap', label: 'Кап дохода', num: true, hidden: true, render: (r) => (r.revenueCap == null ? '—' : money(r.revenueCap)) },
      { key: 'botFilter', label: 'Бот-фильтр', hidden: true, value: (r) => (r.botFilter ? 'да' : 'нет') },
      { key: 'bots', label: 'Боты', num: true, hidden: true, render: (r) => num(r.bots || 0), total: (rs) => num(rs.reduce((t, r) => t + (r.bots || 0), 0)) },
      { key: 'botPct', label: 'Бот %', num: true, hidden: true, value: (r) => (r.clicks + (r.bots || 0) > 0 ? (r.bots || 0) / (r.clicks + (r.bots || 0)) : 0), render: (r) => { const t = r.clicks + (r.bots || 0); return pct(t > 0 ? (r.bots || 0) / t : 0); } },
      { key: 'geos', label: 'Гео', hidden: true, value: (r) => (r.allowGeos || []).join(', ') || 'все' },
      { key: 'devices', label: 'Устройства', hidden: true, value: (r) => (r.allowDevices || []).join(', ') || 'все' },
    ],
  });
  table.addEventListener('selection', () => drawBulk());
  function drawBulk() {
    const n = table.selected().length;
    put(bulk, n ? [h('span', { class: 'muted' }, `Выбрано: ${n}`),
      h('button', { class: 'btn', onclick: () => setActive(table.selected(), true) }, 'Включить'),
      h('button', { class: 'btn', onclick: () => setActive(table.selected(), false) }, 'Выключить')] : []);
  }
  async function setActive(ids, active) {
    try {
      await Promise.all(ids.map((id) => api('/api/campaigns/' + encodeURIComponent(id), { method: 'PATCH', body: { active } })));
      toast(`${active ? 'Включено' : 'Выключено'}: ${ids.length}`);
      table.clearSelection(); drawBulk(); load();
    } catch (e) { toast('Не удалось изменить состояние: ' + e.message, true); }
  }
  put(view, 
    h('div', { class: 'toolbar' }, h('a', { class: 'btn primary', href: '#/campaigns/new' }, 'Создать'), bulk),
    h('div', { class: 'toolbar' }, stateFilter, groupSel, periodControl(() => load()), currencyControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table.chooser() }, '⚙')),
    table);
  async function load() {
    try {
      await loadRefs();
      groupSel.refresh(state.campaigns);
      const [s, bots] = await Promise.all([api('/stats' + qs(periodRange())), api('/stats/bots' + qs(periodRange())).catch(() => ({ total: 0, byCampaign: {} }))]);
      let rows = Object.entries(state.campaigns).map(([id, c]) => ({ id, ...c, name: c.name || id, streams: (c.streams || []).length,
        clicks: s.byCampaign[id]?.clicks || 0, uniqueClicks: s.byCampaign[id]?.uniqueClicks || 0, cost: s.byCampaign[id]?.cost || 0, conversions: s.byCampaign[id]?.conversions || 0, revenue: s.byCampaign[id]?.revenue || 0, leads: s.byCampaign[id]?.leads || 0, sales: s.byCampaign[id]?.sales || 0, rejected: s.byCampaign[id]?.rejected || 0, pendingRevenue: s.byCampaign[id]?.pendingRevenue || 0, bots: bots.byCampaign[id] || 0 }));
      const f = stateFilter.value;
      rows = rows.filter((r) => (f === 'archived') === Boolean(r.archived));
      if (groupSel.value) rows = rows.filter((r) => (r.group || '') === groupSel.value);
      if (f === 'active') rows = rows.filter((r) => r.active);
      if (f === 'inactive') rows = rows.filter((r) => !r.active);
      if (f === 'clicks') rows = rows.filter((r) => r.clicks > 0);
      table.setRows(rows);
    } catch (e) { toast('Ошибка загрузки кампаний: ' + e.message, true); }
  }
  load();
  return () => table.detach();
}

// Normalize legacy flat streams into the conditional shape used by the editor.
function editableStreams(streams) {
  // Only true legacy streams ({ offerId, weight }) are converted; action streams (url / not_found / campaign) have no offers and stay as they are.
  return (streams || []).map((s) => (s.offers || s.action ? structuredClone(s) : { name: s.name || s.offerId, type: 'regular', conditions: {}, offers: [{ offerId: s.offerId, weight: 1 }], weight: s.weight }));
}
const COND = {
  devices: [['mobile', 'Мобильные'], ['tablet', 'Планшеты'], ['desktop', 'Десктоп']],
  os: [['android', 'Android'], ['ios', 'iOS'], ['windows', 'Windows'], ['macos', 'macOS'], ['linux', 'Linux'], ['other', 'Другие']],
  browsers: [['chrome', 'Chrome'], ['safari', 'Safari'], ['firefox', 'Firefox'], ['edge', 'Edge'], ['opera', 'Opera'], ['samsung', 'Samsung'], ['other', 'Другие']],
};
function checkGroup(options, values, onChange) {
  const set = new Set(values || []);
  return h('div', { class: 'checks' }, options.map(([v, l]) => h('label', {}, h('input', { type: 'checkbox', checked: set.has(v), onchange: (e) => { e.target.checked ? set.add(v) : set.delete(v); onChange([...set]); } }), l)));
}
const field = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
const intOrNull = (v) => (v === '' || v === null ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);
// Groups of campaigns/offers: free text up to 60 chars; existing values feed the datalist and the «Все группы» filter.
const groupsOf = (items) => [...new Set(Object.values(items || {}).map((x) => x.group || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
let groupListSeq = 0;
function groupInput(items, value, onInput) {
  const listId = 'group-list-' + (++groupListSeq);
  return h('span', {}, h('input', { class: 'input', value: value || '', maxlength: 60, list: listId, placeholder: 'без группы', 'aria-label': 'Группа', oninput: (e) => onInput(e.target.value) }),
    h('datalist', { id: listId }, groupsOf(items).map((g) => h('option', { value: g }))));
}
function groupFilter(onChange) {
  const sel = h('select', { class: 'select', 'aria-label': 'Фильтр по группе', onchange: onChange });
  sel.refresh = (items) => {
    const cur = sel.value; const groups = groupsOf(items);
    put(sel, h('option', { value: '' }, 'Все группы'), groups.map((g) => h('option', { value: g }, g)));
    sel.value = groups.includes(cur) ? cur : '';
  };
  sel.refresh({});
  return sel;
}

const TIME_ZONES = ['Europe/Paris', 'Europe/Berlin', 'Europe/London', 'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw', 'Europe/Kyiv', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Bahrain', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC'];
function parseHours(text) {
  const out = new Set();
  for (const part of String(text || '').split(/[\s,;]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) continue;
    const a = Number(m[1]); const b = m[2] === undefined ? a : Number(m[2]);
    if (a > 23 || b > 23) continue;
    for (let h = a; ; h = (h + 1) % 24) { out.add(h); if (h === b) break; }
  }
  return [...out].sort((x, y) => x - y);
}
function compactHours(hours = []) {
  const parts = []; let start = null; let prev = null;
  for (const h of [...hours].sort((a, b) => a - b)) {
    if (start === null) { start = h; prev = h; continue; }
    if (h === prev + 1) { prev = h; continue; }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`); start = h; prev = h;
  }
  if (start !== null) parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(', ');
}
const DAY_NAMES = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Stream params condition as text: "sub_id_3=fb,tt; source=x".
const paramsText = (params = {}) => Object.entries(params).map(([k, v]) => `${k}=${v.join(',')}`).join('; ');
function parseParamsText(text) {
  const out = {};
  for (const part of String(text || '').split(/[;\n]+/)) {
    const [k, v = ''] = part.split('=');
    const values = v.split(',').map((x) => x.trim()).filter(Boolean);
    if (k.trim() && values.length) out[k.trim()] = values;
  }
  return out;
}
const splitComma = (text) => String(text || '').split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);

function summarizeConditions(c = {}) {
  const parts = [];
  const add = (key, label, text) => parts.push(`${label}${c.not?.includes(key) ? ' НЕ' : ''}: ${text}`);
  if (c.countries?.length) add('countries', 'Страны', c.countries.join(', '));
  if (c.devices?.length) add('devices', 'Устройства', c.devices.join(', '));
  if (c.os?.length) add('os', 'ОС', c.os.join(', '));
  if (c.browsers?.length) add('browsers', 'Браузеры', c.browsers.join(', '));
  if (c.languages?.length) add('languages', 'Языки', c.languages.join(', '));
  if (c.isps?.length) add('isps', 'Провайдеры', c.isps.join(', '));
  if (c.referrers?.length) add('referrers', 'Реферер', c.referrers.join(', '));
  if (typeof c.emptyReferrer === 'boolean') add('emptyReferrer', 'Пустой реферер', c.emptyReferrer ? 'да' : 'нет');
  if (c.keywords?.length) add('keywords', 'Ключ. слова', c.keywords.join(', '));
  for (const [k, v] of Object.entries(c.params || {})) add('params', k, v.join(', '));
  if (c.ips?.length) add('ips', 'IP', c.ips.join(', '));
  if (c.userAgents?.length) add('userAgents', 'User-Agent', c.userAgents.join(', '));
  if (c.days?.length) add('days', 'Дни', c.days.map((d) => DAY_NAMES[d]).join(', '));
  if (c.hours?.length) add('hours', 'Часы', `${compactHours(c.hours)} (${c.tz || 'UTC'})`);
  if (c.dateFrom) add('dateFrom', 'С', c.dateFrom);
  if (c.dateTo) add('dateTo', 'По', c.dateTo);
  return parts.length ? parts.join(c.mode === 'or' ? ' ИЛИ ' : ' · ') : 'Без фильтров';
}

function streamModal(stream, onApply, isNew = false, currentCampaignId = null) {
  const s = structuredClone(stream);
  s.conditions = { countries: [], devices: [], os: [], browsers: [], languages: [], isps: [], days: [], hours: [], referrers: [], keywords: [], ips: [], userAgents: [], params: {}, not: [], ...(s.conditions || {}) };
  // «НЕ» toggle next to a condition: the stream matches visitors who are NOT in the list.
  const cfield = (key, label, control, hint) => h('div', { class: 'field' },
    h('span', {}, label, h('label', { class: 'not-toggle', style: 'margin-left:10px;font-weight:400' },
      h('input', { type: 'checkbox', 'aria-label': `${label}: НЕ`, checked: s.conditions.not.includes(key), onchange: (e) => {
        s.conditions.not = e.target.checked ? [...new Set([...s.conditions.not, key])] : s.conditions.not.filter((k) => k !== key); } }), ' НЕ')),
    control, hint ? h('span', { class: 'hint' }, hint) : null);
  s.action = s.action || 'offers';
  s.offers = s.offers || [];
  const err = h('p', { class: 'err' });
  const offerIds = Object.keys(state.offers);
  const landingIds = Object.keys(state.landings);
  s.landings = s.landings || [];
  const landingsBox = h('div');
  const drawLandings = () => put(landingsBox,
    s.landings.length ? s.landings.map((l, i) => h('div', { class: 'offer-row' },
      h('select', { class: 'select', 'aria-label': 'Лендинг', onchange: (e) => { l.landingId = e.target.value; } },
        h('option', { value: '' }, 'Выберите лендинг'), landingIds.map((id) => h('option', { value: id, selected: l.landingId === id }, state.landings[id]?.name ? `${state.landings[id].name} (${id})` : id))),
      h('input', { class: 'input', type: 'number', min: 1, value: l.weight ?? 1, 'aria-label': 'Вес лендинга', title: 'Вес', oninput: (e) => { l.weight = Number(e.target.value); } }),
      h('button', { class: 'btn danger square', 'aria-label': 'Убрать лендинг', onclick: () => { s.landings.splice(i, 1); drawLandings(); } }, '✕'))) : h('p', { class: 'muted' }, 'Без лендинга — посетитель сразу уходит на оффер.'),
    h('button', { class: 'btn', onclick: () => { s.landings.push({ landingId: landingIds[0] || '', weight: 1 }); drawLandings(); } }, '+ Добавить лендинг'),
    landingIds.length ? null : h('p', { class: 'muted' }, 'Лендинги создаются в разделе «Лендинги».'));
  drawLandings();
  const offersBox = h('div');
  const drawOffers = () => put(offersBox, 
    s.offers.length ? s.offers.map((o, i) => h('div', { class: 'offer-row' },
      h('select', { class: 'select', 'aria-label': 'Оффер', onchange: (e) => { o.offerId = e.target.value; } },
        h('option', { value: '' }, 'Выберите оффер'), offerIds.map((id) => h('option', { value: id, selected: o.offerId === id }, state.offers[id]?.name ? `${state.offers[id].name} (${id})` : id))),
      h('input', { class: 'input', type: 'number', min: 1, value: o.weight ?? 1, 'aria-label': 'Вес', title: 'Вес', oninput: (e) => { o.weight = Number(e.target.value); } }),
      h('button', { class: 'btn danger square', 'aria-label': 'Убрать оффер', onclick: () => { s.offers.splice(i, 1); drawOffers(); } }, '✕'))) : h('p', { class: 'muted' }, 'Офферы не добавлены.'),
    h('button', { class: 'btn', onclick: () => { s.offers.push({ offerId: offerIds[0] || '', weight: 1 }); drawOffers(); } }, '+ Добавить оффер'),
    offerIds.length ? null : h('p', { class: 'muted' }, 'Сначала создайте оффер в разделе «Офферы».'));
  drawOffers();
  const body = tabs([
    ['Основные', () => h('div', {},
      field('Название', h('input', { class: 'input', value: s.name || '', maxlength: 60, oninput: (e) => { s.name = e.target.value; } })),
      field('Тип потока', h('div', { class: 'radios' }, Object.entries(typeLabel).map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'stype', value: v, checked: (s.type || 'regular') === v, onchange: () => { s.type = v; } }), l))),
      'Перехватывающий срабатывает первым, если подошли фильтры. Обычные делят трафик по весу. Замыкающий получает то, что не забрали остальные.'),
      field('Вес', h('input', { class: 'input', type: 'number', min: 1, value: s.weight ?? 1, oninput: (e) => { s.weight = Number(e.target.value); } }), 'Учитывается только у обычных потоков.'),
      field('Считать клики', h('div', { class: 'radios' },
        h('label', {}, h('input', { type: 'radio', name: 'scount', checked: s.countClicks !== false, onchange: () => { delete s.countClicks; } }), 'Да'),
        h('label', {}, h('input', { type: 'radio', name: 'scount', checked: s.countClicks === false, onchange: () => { s.countClicks = false; } }), 'Нет')),
        'В выключенном состоянии клики через этот поток не попадут в отчёты и логи.'),
      field('Состояние', h('div', { class: 'radios' },
        h('label', {}, h('input', { type: 'radio', name: 'senabled', checked: s.enabled !== false, onchange: () => { delete s.enabled; } }), 'Включен'),
        h('label', {}, h('input', { type: 'radio', name: 'senabled', checked: s.enabled === false, onchange: () => { s.enabled = false; } }), 'Выключен'))))],
    ['Схема', () => {
      const box = h('div');
      const draw = () => put(box, s.action === 'offers' ? [h('h2', {}, 'Лендинги'), landingsBox, h('h2', { style: 'margin-top:16px' }, 'Офферы'), h('p', { class: 'muted' }, 'Офферы потока и их доля трафика (вес).'), offersBox]
        : s.action === 'url' ? field('URL', h('input', { class: 'input', type: 'url', value: s.url || '', placeholder: 'https://…', oninput: (e) => { s.url = e.target.value.trim(); } }), 'Редирект на этот адрес. Макросы: {click_id} {subid} {campaign} {device} {country}.')
        : s.action === 'campaign' ? field('Кампания', h('select', { class: 'select', onchange: (e) => { s.campaignId = e.target.value; } },
            h('option', { value: '' }, 'Выберите кампанию'),
            Object.entries(state.campaigns).filter(([id]) => id !== currentCampaignId).map(([id, c]) => h('option', { value: id, selected: s.campaignId === id }, `${c.name || id} (${id})`))),
          'Клик уходит в выбранную кампанию без редиректа и проходит её потоки. Учитывается в отчётах той кампании.')
        : h('p', { class: 'muted' }, 'Посетитель получит страницу 404, клик не записывается.'));
      draw();
      return h('div', {}, h('div', { class: 'radios', style: 'margin-bottom:14px' }, [['offers', 'Офферы'], ['url', 'Прямой URL'], ['campaign', 'Другая кампания'], ['not_found', 'Ошибка 404']].map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'saction', checked: s.action === v, onchange: () => { s.action = v; draw(); } }), l))), box);
    }],
    ['Фильтры', () => h('div', {},
      field('Отношение', h('div', { class: 'radios' },
        h('label', {}, h('input', { type: 'radio', name: 'smode', checked: s.conditions.mode !== 'or', onchange: () => { delete s.conditions.mode; } }), 'И — все фильтры'),
        h('label', {}, h('input', { type: 'radio', name: 'smode', checked: s.conditions.mode === 'or', onchange: () => { s.conditions.mode = 'or'; } }), 'ИЛИ — любой из фильтров')),
        'Пустой фильтр не учитывается.'),
      cfield('countries', 'Страны', h('input', { class: 'input', 'aria-label': 'Страны', value: s.conditions.countries.join(', '), placeholder: 'FR, DE, US', oninput: (e) => { s.conditions.countries = splitList(e.target.value).map((x) => x.toUpperCase()); } }), 'ISO-коды через запятую. Без базы GeoIP страна неизвестна и такой фильтр не сработает (с «НЕ» — сработает).'),
      cfield('devices', 'Тип устройства', checkGroup(COND.devices, s.conditions.devices, (v) => { s.conditions.devices = v; })),
      cfield('os', 'Операционные системы', checkGroup(COND.os, s.conditions.os, (v) => { s.conditions.os = v; })),
      cfield('browsers', 'Браузеры', checkGroup(COND.browsers, s.conditions.browsers, (v) => { s.conditions.browsers = v; })),
      cfield('languages', 'Языки', h('input', { class: 'input', 'aria-label': 'Языки', value: s.conditions.languages.join(', '), placeholder: 'fr, de', oninput: (e) => { s.conditions.languages = splitList(e.target.value).map((x) => x.toLowerCase()); } }), 'Два первых символа Accept-Language.'),
      cfield('isps', 'Провайдеры', h('input', { class: 'input', 'aria-label': 'Провайдеры', value: s.conditions.isps.join(', '), placeholder: 'orange, free mobile', oninput: (e) => { s.conditions.isps = splitComma(e.target.value).map((x) => x.toLowerCase()); } }), 'Часть названия провайдера, как в отчёте «Провайдер». Без базы провайдеров условие не срабатывает.'),
      cfield('referrers', 'Реферер', h('input', { class: 'input', 'aria-label': 'Реферер', value: s.conditions.referrers.join(', '), placeholder: 'facebook.com, instagram.com/ads', oninput: (e) => { s.conditions.referrers = splitComma(e.target.value).map((x) => x.toLowerCase()); } }), 'Часть адреса источника перехода (домен и путь), без учёта регистра.'),
      cfield('emptyReferrer', 'Пустой реферер', h('div', { class: 'radios' }, [[undefined, 'Не важно'], [true, 'Пустой'], [false, 'Не пустой']].map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'semptyref', checked: s.conditions.emptyReferrer === v, onchange: () => { if (v === undefined) delete s.conditions.emptyReferrer; else s.conditions.emptyReferrer = v; } }), l)))),
      cfield('keywords', 'Ключевые слова', h('input', { class: 'input', 'aria-label': 'Ключевые слова', value: s.conditions.keywords.join(', '), placeholder: 'ninja, blender', oninput: (e) => { s.conditions.keywords = splitComma(e.target.value).map((x) => x.toLowerCase()); } }), 'Часть значения параметра keyword (с учётом переименования в «Параметрах» кампании).'),
      cfield('params', 'Параметры', h('input', { class: 'input', 'aria-label': 'Параметры', value: paramsText(s.conditions.params), placeholder: 'sub_id_3=fb,tt; source=push', oninput: (e) => { s.conditions.params = parseParamsText(e.target.value); } }), 'Точное совпадение. Поля: keyword, source, external_id, creative_id, ad_campaign_id, sub_id_1…sub_id_30. Должны совпасть все перечисленные.'),
      cfield('ips', 'IP', h('input', { class: 'input', 'aria-label': 'IP', value: s.conditions.ips.join(', '), placeholder: '203.0.113.7, 10.0.0.0/8', oninput: (e) => { s.conditions.ips = splitList(e.target.value); } }), 'Адрес или диапазон IPv4 (CIDR).'),
      cfield('userAgents', 'User-Agent', h('input', { class: 'input', 'aria-label': 'User-Agent', value: s.conditions.userAgents.join(', '), placeholder: 'iPhone OS 17, FBAN', oninput: (e) => { s.conditions.userAgents = splitComma(e.target.value).map((x) => x.toLowerCase()); } }), 'Часть строки User-Agent, без учёта регистра.'),
      cfield('days', 'Дни недели', checkGroup([[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [7, 'Вс']], s.conditions.days, (v) => { s.conditions.days = v.map(Number); }), 'Пусто — любой день.'),
      cfield('hours', 'Часы', h('input', { class: 'input', 'aria-label': 'Часы', value: compactHours(s.conditions.hours), placeholder: '9-21', oninput: (e) => { s.conditions.hours = parseHours(e.target.value); } }), 'Например «9-21» или «0-6, 22-23». Пусто — круглосуточно.'),
      h('div', { class: 'field-row' },
        cfield('dateFrom', 'Дата с', h('input', { class: 'input', type: 'date', 'aria-label': 'Дата с', value: s.conditions.dateFrom || '', oninput: (e) => { s.conditions.dateFrom = e.target.value; } })),
        cfield('dateTo', 'Дата по', h('input', { class: 'input', type: 'date', 'aria-label': 'Дата по', value: s.conditions.dateTo || '', oninput: (e) => { s.conditions.dateTo = e.target.value; } }), 'Включительно.')),
      field('Часовой пояс расписания', h('select', { class: 'select', onchange: (e) => { s.conditions.tz = e.target.value; } },
        TIME_ZONES.map((tz) => h('option', { value: tz, selected: (s.conditions.tz || 'Europe/Paris') === tz }, tz)))))],
  ]);
  const close = openModal({
    title: isNew ? 'Создание потока' : 'Редактирование потока', wide: true,
    body: h('div', {}, body, err),
    footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: () => {
      s.offers = s.offers.filter((o) => o.offerId);
      if (!s.name?.trim()) { err.textContent = 'Укажите название потока.'; return; }
      if (s.action === 'offers' && !s.offers.length) { err.textContent = 'Добавьте хотя бы один оффер на вкладке «Схема».'; return; }
      if (s.action === 'url' && !/^https:\/\//i.test(s.url || '')) { err.textContent = 'Прямой URL должен начинаться с https://'; return; }
      if (s.action === 'campaign' && !s.campaignId) { err.textContent = 'Выберите кампанию на вкладке «Схема».'; return; }
      if (s.offers.some((o) => !(o.weight > 0)) || !(s.weight > 0)) { err.textContent = 'Веса должны быть больше нуля.'; return; }
      s.landings = (s.landings || []).filter((l) => l.landingId);
      if (s.landings.some((l) => !(l.weight > 0))) { err.textContent = 'Веса лендингов должны быть больше нуля.'; return; }
      if (s.action !== 'offers' || !s.landings.length) delete s.landings;
      const cond = s.conditions;
      for (const k of ['referrers', 'keywords', 'ips', 'userAgents']) if (!cond[k].length) delete cond[k];
      if (!Object.keys(cond.params).length) delete cond.params;
      for (const k of ['dateFrom', 'dateTo']) if (!cond[k]) delete cond[k];
      if (cond.dateFrom && cond.dateTo && cond.dateFrom > cond.dateTo) { err.textContent = 'Дата «с» позже даты «по».'; return; }
      if (!cond.days.length && !cond.hours.length && !cond.dateFrom && !cond.dateTo) { delete cond.days; delete cond.hours; delete cond.tz; }
      else cond.tz = cond.tz || 'Europe/Paris';
      cond.not = cond.not.filter((k) => (k === 'emptyReferrer' ? typeof cond[k] === 'boolean' : k === 'params' ? cond.params : cond[k]?.length));
      if (!cond.not.length) delete cond.not;
      if (s.action === 'offers') { delete s.action; delete s.url; delete s.campaignId; } else { delete s.offers; if (s.action !== 'url') delete s.url; if (s.action !== 'campaign') delete s.campaignId; }
      onApply(s); close();
    } }, 'Применить')],
  });
}

async function pageCampaignEditor(id) {
  await loadRefs();
  const isNew = id === 'new';
  const src = isNew ? null : state.campaigns[id];
  if (!isNew && !src) { put(view, h('p', { class: 'err' }, 'Кампания не найдена: ' + id), h('a', { href: '#/campaigns' }, '← К кампаниям')); return; }
  const d = isNew
    ? { id: Math.random().toString(36).slice(2, 10), name: '', active: true, dailyCap: null, totalCap: null, revenueCap: null, capUrl: null, geoCapUrl: null, allowGeos: [], allowDevices: [], allowOS: [], allowBrowsers: [], blockedIps: [], allowedIps: [], dedupeWindow: 0, botFilter: false, datacenterAsBot: false, conversionWindowDays: null, paramMap: {}, costModel: 'none', cpc: null, costFromParam: false, sourceId: null }
    : { id, paramMap: {}, costModel: 'none', cpc: null, costFromParam: false, ...structuredClone(src) };
  d.streams = editableStreams(src?.streams);
  let dirty = false;
  const mark = () => { dirty = true; saveBtn.textContent = isNew ? 'Создать' : 'Сохранить •'; };
  const err = h('p', { class: 'err' });
  const saveBtn = h('button', { class: 'btn primary', onclick: () => save() }, isNew ? 'Создать' : 'Сохранить');
  const nameInput = h('input', { class: 'input name', value: d.name, placeholder: 'Название', 'aria-label': 'Название кампании', maxlength: 120, oninput: (e) => { d.name = e.target.value; mark(); } });
  const bind = (key, type = 'text') => (e) => {
    const v = e.target.value;
    d[key] = type === 'int' ? intOrNull(v) : type === 'float' ? (v === '' ? null : Number(v)) : type === 'url' ? (v.trim() || null) : v;
    mark();
  };

  const left = tabs([
    ['Общие', () => {
      const cpcField = field('Стоимость клика', h('input', { class: 'input', type: 'number', min: 0, step: '0.0001', value: d.cpc ?? '', placeholder: '0.0000', oninput: bind('cpc', 'float') }));
      cpcField.hidden = d.costModel !== 'cpc';
      const costFromParamField = field('Брать из параметра cost', h('label', { class: 'radios' }, h('input', { type: 'checkbox', checked: !!d.costFromParam, onchange: (e) => { d.costFromParam = e.target.checked; mark(); } }), 'Использовать значение параметра cost из ссылки клика'));
      costFromParamField.hidden = d.costModel !== 'cpc';
      return h('div', {},
        field('Идентификатор', h('input', { class: 'input', value: d.id, readonly: !isNew, oninput: (e) => { d.id = e.target.value.trim(); mark(); } }), isNew ? 'Латиница, цифры, - и _. После создания не меняется.' : 'Используется в ссылке кампании.'),
        field('Состояние', h('div', { class: 'radios' },
          h('label', {}, h('input', { type: 'radio', name: 'cstate', checked: d.active, onchange: () => { d.active = true; mark(); } }), 'Включена'),
          h('label', {}, h('input', { type: 'radio', name: 'cstate', checked: !d.active, onchange: () => { d.active = false; mark(); } }), 'Выключена'))),
        field('Группа', groupInput(state.campaigns, d.group, (v) => { d.group = v; mark(); }), 'Для фильтра «Все группы» в списке кампаний. Можно выбрать существующую или ввести новую.'),
        isOwnerView() ? field('Баер', h('select', { class: 'select', onchange: (e) => { d.ownerId = e.target.value || null; mark(); } },
          h('option', { value: '' }, 'Не назначен'), state.users.map((u) => h('option', { value: u.id, selected: d.ownerId === u.id }, `${u.email}${u.role === 'owner' ? ' (владелец)' : ''}`))),
          'Баер видит и правит только свои кампании; его заработок считается по ним.') : null,
        field('Срок уникальности, часов', h('input', { class: 'input', type: 'number', min: 1, max: 720, value: d.uniquenessHours ?? 24, oninput: bind('uniquenessHours', 'int') }), 'Повторный визит с тех же IP и браузера в этом окне считается, но не как уникальный.'),
        field('Не записывать повторные клики, минут', h('input', { class: 'input', type: 'number', min: 0, value: d.dedupeWindow || 0, oninput: bind('dedupeWindow', 'int') }), 'Повторный клик с того же IP в этом окне вообще не записывается. 0 — выключено.'),
        field('Фильтр ботов', h('label', { class: 'radios' }, h('input', { type: 'checkbox', checked: d.botFilter, onchange: (e) => { d.botFilter = e.target.checked; mark(); } }), 'Не считать клики ботов'), 'Боты уходят на тот же оффер, но не попадают в статистику.'),
        field('Дата-центры', h('label', { class: 'radios' }, h('input', { type: 'checkbox', checked: d.datacenterAsBot, onchange: (e) => { d.datacenterAsBot = e.target.checked; mark(); } }), 'Трафик дата-центров считать ботами'), 'Клики из облаков и хостингов (AWS, Google Cloud, OVH…) уходят на тот же оффер, но не попадают в статистику.'),
        field('Ротация потоков', h('div', { class: 'radios' },
          h('label', {}, h('input', { type: 'radio', name: 'crot', checked: d.streamRotation !== 'position', onchange: () => { d.streamRotation = 'weight'; mark(); } }), 'По весу'),
          h('label', {}, h('input', { type: 'radio', name: 'crot', checked: d.streamRotation === 'position', onchange: () => { d.streamRotation = 'position'; mark(); } }), 'По позиции')),
          'По весу — обычные потоки делят трафик по весам. По позиции — клик забирает первый подходящий обычный поток сверху.'),
        field('Способ редиректа', h('div', { class: 'radios' }, [['http', 'HTTP 302'], ['meta', 'Meta refresh'], ['js', 'JavaScript']].map(([v, l]) => h('label', {},
          h('input', { type: 'radio', name: 'credir', checked: (d.redirectMethod || 'http') === v, onchange: () => { d.redirectMethod = v; mark(); } }), l))),
          'Как посетитель уходит на оффер. HTTP 302 — быстрее всего; meta и JS отдают страницу, которая сама переходит дальше.'),
        field('Окно конверсии, дней', h('input', { class: 'input', type: 'number', min: 1, max: 365, value: d.conversionWindowDays ?? '', placeholder: 'без ограничения', oninput: bind('conversionWindowDays', 'int') }), 'Постбэк на клик старше окна отклоняется.'),
        field('Источник трафика', h('select', { class: 'select', 'aria-label': 'Источник трафика', onchange: (e) => {
          const sid = e.target.value; d.sourceId = sid || null;
          if (sid && state.sources[sid]) { const src = state.sources[sid]; d.paramMap = { ...(src.paramMap || {}) }; d.costModel = src.costModel || 'none'; d.cpc = src.cpc ?? null; d.costFromParam = src.costFromParam || false; }
          mark();
        } }, h('option', { value: '' }, 'Без источника'), Object.entries(state.sources).map(([sid, s]) => h('option', { value: sid, selected: (d.sourceId || '') === sid }, s.name || sid))),
        'При выборе источника его параметры копируются в кампанию.'),
        field('Модель затрат', h('div', { class: 'radios' },
          h('label', {}, h('input', { type: 'radio', name: 'costModel', checked: d.costModel !== 'cpc', onchange: () => { d.costModel = 'none'; d.cpc = null; cpcField.hidden = true; costFromParamField.hidden = true; mark(); } }), 'Нет'),
          h('label', {}, h('input', { type: 'radio', name: 'costModel', checked: d.costModel === 'cpc', onchange: () => { d.costModel = 'cpc'; cpcField.hidden = false; costFromParamField.hidden = false; mark(); } }), 'CPC')), 'При CPC расход за клик записывается в статистику.'),
        cpcField,
        costFromParamField);
    }],
    ['Таргетинг', () => h('div', {},
      h('p', { class: 'muted' }, 'Фильтры уровня кампании: не подошедший клик не попадает ни в один поток.'),
      field('Страны', h('input', { class: 'input', value: (d.allowGeos || []).join(', '), placeholder: 'все', oninput: (e) => { d.allowGeos = splitList(e.target.value).map((x) => x.toUpperCase()); mark(); } })),
      field('URL для чужого гео', h('input', { class: 'input', type: 'url', value: d.geoCapUrl || '', placeholder: 'https://…', oninput: bind('geoCapUrl', 'url') })),
      field('Тип устройства', checkGroup(COND.devices, d.allowDevices, (v) => { d.allowDevices = v; mark(); })),
      field('Операционные системы', checkGroup(COND.os, d.allowOS, (v) => { d.allowOS = v; mark(); })),
      field('Браузеры', checkGroup(COND.browsers, d.allowBrowsers, (v) => { d.allowBrowsers = v; mark(); })),
      field('Черный список IP', h('textarea', { class: 'input', placeholder: '203.0.113.7\n198.51.100.0/24', oninput: (e) => { d.blockedIps = splitList(e.target.value); mark(); } }, (d.blockedIps || []).join('\n')), 'По одному на строку, можно IPv4 CIDR.'),
      field('Белый список IP', h('textarea', { class: 'input', placeholder: 'пусто — все', oninput: (e) => { d.allowedIps = splitList(e.target.value); mark(); } }, (d.allowedIps || []).join('\n'))))],
    ['Капы', () => h('div', {},
      h('div', { class: 'field-row' },
        field('Дневной кап кликов', h('input', { class: 'input', type: 'number', min: 1, value: d.dailyCap ?? '', placeholder: 'нет', oninput: bind('dailyCap', 'int') })),
        field('Общий кап кликов', h('input', { class: 'input', type: 'number', min: 1, value: d.totalCap ?? '', placeholder: 'нет', oninput: bind('totalCap', 'int') }), 'При достижении кампания встаёт на паузу.')),
      field(`Дневной кап дохода, ${currency.info?.defaultCurrency || 'EUR'}`, h('input', { class: 'input', type: 'number', min: 0, step: '0.01', value: d.revenueCap ?? '', placeholder: 'нет', oninput: bind('revenueCap', 'float') })),
      field('URL при достижении капа', h('input', { class: 'input', type: 'url', value: d.capUrl || '', placeholder: 'https://… (иначе ответ 429)', oninput: bind('capUrl', 'url') })))],
    ['Tracking', () => isNew ? h('p', { class: 'muted' }, 'Ссылка кампании будет доступна после её сохранения.') : h('div', {},
      field('Домен трекинга', h('select', { class: 'select', onchange: (e) => { d.domain = e.target.value || null; mark(); } },
        h('option', { value: '' }, `${location.host}${BASE} (основной)`), (state.domains || []).map((dm) => h('option', { value: dm, selected: d.domain === dm }, dm))),
        state.domains?.length ? 'Ссылка кампании будет на выбранном домене. Панель на нём недоступна — только трекинг.' : 'Свои домены добавляются в deploy/domains.txt (DNS A-запись на сервер); после деплоя они появятся здесь.'),
      field('Ссылка кампании', h('div', { class: 'link-box' }, h('input', { class: 'input', readonly: true, value: trackingUrl(d.id) }), h('button', { class: 'btn', onclick: () => copyText(trackingUrl(d.id)) }, 'Копировать')), 'Добавьте ?subid=… и utm-метки, они передадутся в оффер.'),
      field('Ссылка на конкретный оффер', h('input', { class: 'input', readonly: true, value: trackingUrl(d.id) + '/{offer_id}' })),
      field('S2S постбэк для партнёрки', h('input', { class: 'input', readonly: true, value: `${location.origin}${BASE}/postback?click_id={click_id}&secret=POSTBACK_SECRET&revenue={payout}&currency=EUR&status={status}` }), 'Замените POSTBACK_SECRET и макросы партнёрки на свои. status: lead / sale / rejected / trash (понимает и approved, pending, declined…); повторный постбэк с другим статусом обновляет конверсию.'),
      h('p', { class: 'muted' }, 'Макросы в URL оффера: {click_id} {subid} {campaign} {offer_id} {device} {country}.'))],
    ['Параметры', () => {
      const PARAM_FIELDS = ['keyword', 'source', 'external_id', 'creative_id', 'ad_campaign_id',
        ...Array.from({ length: 30 }, (_, i) => `sub_id_${i + 1}`), 'cost'];
      const rows = PARAM_FIELDS.map((name) => {
        const inp = h('input', { class: 'input', style: 'padding:2px 6px;height:auto', value: d.paramMap?.[name] || '', placeholder: name,
          oninput: (e) => { const v = e.target.value.trim(); if (!d.paramMap) d.paramMap = {}; if (v && v !== name) d.paramMap[name] = v; else delete d.paramMap[name]; mark(); } });
        return h('tr', {}, h('td', { style: 'padding:4px 8px;white-space:nowrap' }, name), h('td', { style: 'padding:2px 4px;width:100%' }, inp));
      });
      return h('div', {},
        h('p', { class: 'muted' }, 'Имя параметра в ссылке клика. Оставьте пустым — используется имя по умолчанию.'),
        h('div', { style: 'overflow-x:auto' }, h('table', { style: 'width:100%;border-collapse:collapse' },
          h('thead', {}, h('tr', {}, h('th', { style: 'padding:4px 8px;text-align:left;font-weight:500' }, 'Название'), h('th', { style: 'padding:4px 8px;text-align:left;font-weight:500' }, 'Параметр в ссылке'))),
          h('tbody', {}, ...rows))));
    }],
  ]);

  const streamsBox = h('div');
  let streamStats = {};
  function drawStreams() {
    put(streamsBox, d.streams.length ? d.streams.map((s, i) => {
      const st = streamStats[s.name] || {};
      return h('div', { class: 'stream' + (s.enabled === false ? ' disabled' : '') },
        h('div', { class: 'pos-btns' },
          h('button', { 'aria-label': 'Выше', disabled: i === 0, onclick: () => { [d.streams[i - 1], d.streams[i]] = [d.streams[i], d.streams[i - 1]]; mark(); drawStreams(); } }, '▲'),
          h('button', { 'aria-label': 'Ниже', disabled: i === d.streams.length - 1, onclick: () => { [d.streams[i + 1], d.streams[i]] = [d.streams[i], d.streams[i + 1]]; mark(); drawStreams(); } }, '▼')),
        h('div', { style: 'min-width:0' },
          h('div', { class: 'title', onclick: () => streamModal(s, (next) => { d.streams[i] = next; mark(); drawStreams(); }, false, d.id) },
            `${i + 1}. ${s.name} `, h('span', { class: 'badge ' + (s.type || 'regular') }, typeLabel[s.type || 'regular']),
            s.enabled === false ? [' ', h('span', { class: 'badge' }, 'Выключен')] : null,
            s.countClicks === false ? [' ', h('span', { class: 'badge' }, 'Клики не считаются')] : null),
          h('div', { class: 'meta' }, summarizeConditions(s.conditions)),
          h('div', { class: 'meta' }, (s.action === 'url' ? 'Прямой URL: ' + s.url : s.action === 'campaign' ? '→ кампания ' + (state.campaigns[s.campaignId]?.name || s.campaignId) : s.action === 'not_found' ? 'Действие: ошибка 404' : (s.landings?.length ? 'Лендинги: ' + s.landings.map((l) => `${state.landings[l.landingId]?.name || l.landingId} (${l.weight ?? 1})`).join(', ') + ' → ' : '') + 'Офферы: ' + (s.offers || []).map((o) => `${o.offerId} (${o.weight ?? 1})`).join(', ')) + ((s.type || 'regular') === 'regular' ? ` · вес потока ${s.weight ?? 1}` : ''))),
        h('div', { class: 'nums' }, `${num(st.clicks)} кл.`, h('br'), `${num(st.conversions)} конв.`,
          h('div', { class: 'row-actions' },
            h('button', { title: 'Изменить', 'aria-label': 'Изменить поток', onclick: () => streamModal(s, (next) => { d.streams[i] = next; mark(); drawStreams(); }, false, d.id) }, '✎'),
            h('button', { title: 'Удалить', 'aria-label': 'Удалить поток', onclick: (e) => {
              const b = e.currentTarget;
              if (b.dataset.armed) { d.streams.splice(i, 1); mark(); drawStreams(); return; }
              b.dataset.armed = '1'; b.textContent = 'Удалить?'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '✕'; } }, 3000);
            } }, '✕'))));
    }) : h('div', { class: 'empty' }, 'В кампании ещё не создано потоков.'));
  }
  async function loadStreamStats() {
    if (isNew) return drawStreams();
    try { streamStats = (await api('/stats' + qs({ ...periodRange(), campaign: d.id }))).byStream || {}; } catch { streamStats = {}; }
    drawStreams();
  }

  async function save() {
    err.textContent = '';
    if (!d.name.trim()) { err.textContent = 'Укажите название кампании.'; return; }
    if (isNew && !ID_RE.test(d.id)) { err.textContent = 'Идентификатор: 2–80 символов, латиница, цифры, - и _.'; return; }
    if (isNew && state.campaigns[d.id]) { err.textContent = 'Кампания с таким идентификатором уже есть.'; return; }
    for (const k of ['dailyCap', 'totalCap', 'conversionWindowDays']) if (Number.isNaN(d[k]) || (d[k] !== null && d[k] < 1)) { err.textContent = 'Капы и окно конверсии — целые числа больше нуля.'; return; }
    const names = d.streams.map((s) => s.name);
    if (new Set(names).size !== names.length) { err.textContent = 'Названия потоков должны различаться — по ним строится статистика.'; return; }
    const body = { name: d.name.trim(), group: (d.group || '').trim(), active: d.active, streams: d.streams, dailyCap: d.dailyCap, totalCap: d.totalCap, revenueCap: d.revenueCap, capUrl: d.capUrl, geoCapUrl: d.geoCapUrl,
      allowGeos: d.allowGeos, allowDevices: d.allowDevices, allowOS: d.allowOS, allowBrowsers: d.allowBrowsers, blockedIps: d.blockedIps, allowedIps: d.allowedIps,
      dedupeWindow: d.dedupeWindow || 0, botFilter: d.botFilter, datacenterAsBot: Boolean(d.datacenterAsBot), conversionWindowDays: d.conversionWindowDays, redirectMethod: d.redirectMethod || 'http', domain: d.domain || null, uniquenessHours: d.uniquenessHours ?? 24, streamRotation: d.streamRotation || 'weight', ...(isOwnerView() ? { ownerId: d.ownerId || null } : {}), paramMap: d.paramMap || {}, costModel: d.costModel || 'none', cpc: d.cpc, costFromParam: d.costFromParam || false, sourceId: d.sourceId || null };
    saveBtn.disabled = true;
    try {
      const saved = isNew ? await api('/api/campaigns', { method: 'POST', body: { id: d.id, ...body } })
        : await api('/api/campaigns/' + encodeURIComponent(d.id), { method: 'PATCH', body });
      dirty = false;
      const streamsMismatch = (saved.streams || []).length !== d.streams.length;
      if (isNew) {
        if (streamsMismatch) toast('Часть потоков отклонена сервером — проверьте офферы и веса.', true);
        else toast('Кампания создана');
        location.hash = '#/campaigns/' + encodeURIComponent(d.id);
      } else {
        await loadRefs();
        saveBtn.textContent = 'Сохранить';
        const serverCamp = state.campaigns[d.id] || {};
        const sentParamKeys = Object.keys(body.paramMap || {});
        const droppedParams = sentParamKeys.filter((k) => (serverCamp.paramMap || {})[k] !== (body.paramMap || {})[k]);
        if (streamsMismatch) toast('Часть потоков отклонена сервером — проверьте офферы и веса.', true);
        else if (droppedParams.length) toast('Параметры отклонены сервером: ' + droppedParams.join(', '), true);
        else toast('Сохранено');
      }
    } catch (e) { err.textContent = 'Не сохранено: ' + e.message; }
    finally { saveBtn.disabled = false; }
  }

  put(view, 
    h('div', { class: 'editor-head' }, nameInput,
      h('div', { class: 'toolbar', style: 'margin:0' }, saveBtn,
        h('button', { class: 'btn square', title: 'Копировать ссылку', 'aria-label': 'Копировать ссылку', disabled: isNew, onclick: () => copyText(trackingUrl(d.id)) }, '🔗'),
        isNew ? null : h('a', { class: 'btn', href: '#/clicks' + qs({ campaign: d.id }) }, 'Клики'),
        isNew ? null : h('button', { class: 'btn', onclick: () => historyModal('campaign', d.id, d.name) }, 'История'),
        isNew ? null : h('button', { class: 'btn', onclick: () => simulateModal(d.id) }, 'Проверить маршрут'),
        isNew ? null : h('a', { class: 'btn', href: '#/reports' + qs({ group: 'stream', campaign: d.id }) }, 'Отчёт'),
        h('a', { class: 'btn', href: '#/campaigns' }, 'К списку'))),
    err,
    h('div', { class: 'editor' },
      h('div', { class: 'left' }, left),
      h('div', { class: 'right' },
        h('div', { class: 'toolbar' },
          h('button', { class: 'btn primary', onclick: () => streamModal({ name: `Flow ${d.streams.length + 1}`, type: 'regular', weight: 1, conditions: {}, offers: [] }, (s) => { d.streams.push(s); mark(); drawStreams(); }, true, d.id) }, 'Создать поток'),
          h('span', { style: 'flex:1' }),
          periodControl(() => loadStreamStats())),
        streamsBox,
        h('p', { class: 'muted', style: 'font-size:12px' }, 'Изменения потоков применяются к кампании после «Сохранить».'))));
  loadStreamStats();
  const guard = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', guard);
  return () => window.removeEventListener('beforeunload', guard);
}

function sourceModal(id, onSaved) {
  const isNew = !id;
  const SOURCE_PARAM_FIELDS = ['keyword', 'source', 'external_id', 'creative_id', 'ad_campaign_id', ...Array.from({ length: 30 }, (_, i) => `sub_id_${i + 1}`), 'cost'];
  const cur = isNew ? null : state.sources[id];
  const d = isNew
    ? { id: '', name: '', paramMap: {}, costModel: 'none', cpc: '', costFromParam: false }
    : { id, name: cur.name || '', paramMap: { ...(cur.paramMap || {}) }, costModel: cur.costModel || 'none', cpc: cur.cpc ?? '', costFromParam: !!cur.costFromParam };
  const err = h('p', { class: 'err' });
  const cpcField = field('Стоимость клика', h('input', { class: 'input', type: 'number', min: 0, step: '0.0001', value: d.cpc, placeholder: '0.0000', oninput: (e) => { d.cpc = e.target.value; } }));
  cpcField.hidden = d.costModel !== 'cpc';
  const body = tabs([
    ['Основные', () => h('div', {},
      field('ID источника', h('input', { class: 'input', value: d.id, readonly: !isNew, oninput: (e) => { d.id = e.target.value.trim(); } }), isNew ? 'Латиница, цифры, - и _.' : null),
      field('Название', h('input', { class: 'input', value: d.name, maxlength: 200, oninput: (e) => { d.name = e.target.value; } })),
      field('Модель затрат', h('div', { class: 'radios' },
        h('label', {}, h('input', { type: 'radio', name: 'smod', checked: d.costModel !== 'cpc', onchange: () => { d.costModel = 'none'; cpcField.hidden = true; } }), 'Нет'),
        h('label', {}, h('input', { type: 'radio', name: 'smod', checked: d.costModel === 'cpc', onchange: () => { d.costModel = 'cpc'; cpcField.hidden = false; } }), 'CPC'))),
      cpcField,
      field('Брать расход из параметра cost', h('label', { class: 'radios' }, h('input', { type: 'checkbox', checked: d.costFromParam, onchange: (e) => { d.costFromParam = e.target.checked; } }), 'Использовать значение параметра cost из ссылки')))],
    ['Параметры', () => {
      const rows = SOURCE_PARAM_FIELDS.map((name) => {
        const inp = h('input', { class: 'input', style: 'padding:2px 6px;height:auto', value: d.paramMap[name] || '', placeholder: name,
          oninput: (e) => { const v = e.target.value.trim(); if (v && v !== name) d.paramMap[name] = v; else delete d.paramMap[name]; } });
        return h('tr', {}, h('td', { style: 'padding:4px 8px;white-space:nowrap' }, name), h('td', { style: 'padding:2px 4px;width:100%' }, inp));
      });
      return h('div', {},
        h('p', { class: 'muted' }, 'Как называется каждое поле в ссылке отслеживания этого источника.'),
        h('div', { class: 'table-wrap', style: 'max-height:480px;overflow-y:auto' },
          h('table', { class: 'grid' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Поле'), h('th', {}, 'Параметр в ссылке'))),
            h('tbody', {}, ...rows))));
    }],
  ]);
  const close = openModal({
    title: isNew ? 'Создание источника' : 'Редактирование источника', body: h('div', {}, body, err),
    footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => {
      err.textContent = '';
      if (!ID_RE.test(d.id)) { err.textContent = 'ID: 2–80 символов, латиница, цифры, - и _.'; return; }
      if (isNew && state.sources[d.id]) { err.textContent = 'Источник с таким ID уже есть.'; return; }
      try {
        const body2 = { name: d.name.trim() || null, paramMap: d.paramMap, costModel: d.costModel, cpc: d.cpc !== '' ? Number(d.cpc) : 0, costFromParam: d.costFromParam };
        await (isNew ? api('/api/sources', { method: 'POST', body: { id: d.id, ...body2 } }) : api('/api/sources/' + encodeURIComponent(d.id), { method: 'PATCH', body: body2 }));
        toast(isNew ? 'Источник создан' : 'Сохранено'); close(); onSaved();
      } catch (e) { err.textContent = 'Не сохранено: ' + e.message; }
    } }, isNew ? 'Создать' : 'Сохранить')],
  });
}

async function pageSources() {
  const table = dataTable({
    id: 'sources', pageSize: 250,
    columns: [
      { key: 'id', label: 'ID', fixed: true, render: (r) => h('a', { href: '#/sources', onclick: (e) => { e.preventDefault(); sourceModal(r.id, load); } }, r.id) },
      { key: 'menu', label: '', title: 'Меню', sortable: false, value: () => '', render: (r) => h('span', { class: 'row-actions' },
        h('button', { title: 'Изменить', 'aria-label': 'Изменить', onclick: () => sourceModal(r.id, load) }, '✎')) },
      { key: 'name', label: 'Название', cls: 'name', value: (r) => r.name || '', render: (r) => h('span', { title: r.name || '' }, r.name || '—') },
      { key: 'costModel', label: 'Модель', value: (r) => r.costModel === 'cpc' ? 'CPC' : 'Нет' },
      { key: 'cpc', label: 'CPC', num: true, render: (r) => (r.cpc ? money4(r.cpc) : '—') },
    ],
  });
  put(view,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => sourceModal(null, load) }, 'Создать')),
    table);
  async function load() {
    try {
      await loadRefs();
      table.setRows(Object.entries(state.sources).map(([id, s]) => ({ id, ...s })));
    } catch (e) { toast('Ошибка загрузки источников: ' + e.message, true); }
  }
  load();
  return () => table.detach();
}

function offerModal(id, onSaved) {
  const isNew = !id;
  const o = isNew ? { id: '', name: '', url: '', postbackUrl: '', dailyCap: '', conversionCap: '', capTz: 'UTC', altOfferId: '', group: '' }
    : { id, ...state.offers[id], name: state.offers[id].name || '', postbackUrl: state.offers[id].postbackUrl || '', dailyCap: state.offers[id].dailyCap ?? '',
      conversionCap: state.offers[id].conversionCap ?? '', capTz: state.offers[id].capTz || 'UTC', altOfferId: state.offers[id].altOfferId || '', group: state.offers[id].group || '' };
  const zones = TIME_ZONES.includes(o.capTz) ? ['UTC', ...TIME_ZONES.filter((z) => z !== 'UTC')] : [o.capTz, 'UTC', ...TIME_ZONES.filter((z) => z !== 'UTC')];
  const others = Object.keys(state.offers || {}).filter((k) => k !== id && (!state.offers[k].archived || k === o.altOfferId)).sort();
  const err = h('p', { class: 'err' });
  const body = tabs([
    ['Основные', () => h('div', {},
      field('ID оффера', h('input', { class: 'input', value: o.id, readonly: !isNew, oninput: (e) => { o.id = e.target.value.trim(); } }), isNew ? 'Латиница, цифры, - и _.' : null),
      field('Название', h('input', { class: 'input', value: o.name, maxlength: 200, oninput: (e) => { o.name = e.target.value; } })),
      field('Группа', groupInput(state.offers, o.group, (v) => { o.group = v; }), 'Можно выбрать существующую или ввести новую.'),
      field('URL', h('input', { class: 'input', type: 'url', value: o.url, placeholder: 'https://…', oninput: (e) => { o.url = e.target.value.trim(); } }), 'Макросы: {click_id} {subid} {campaign} {offer_id} {device} {country}. Если {click_id} нет — click_id добавится параметром.'))],
    ['Настройки', () => h('div', {},
      field('Дневной кап кликов', h('input', { class: 'input', type: 'number', min: 1, value: o.dailyCap, placeholder: 'нет', oninput: (e) => { o.dailyCap = e.target.value; } }), 'Считается по всем кампаниям; в потоках капнутый оффер пропускается.'),
      field('Кап конверсий в день', h('input', { class: 'input', type: 'number', min: 1, value: o.conversionCap, placeholder: 'нет', 'aria-label': 'Кап конверсий в день', oninput: (e) => { o.conversionCap = e.target.value; } }), 'Лиды + продажи за сутки по всем кампаниям (отклонённые не считаются). Пересчёт — до 30 секунд.'),
      field('Часовой пояс капа', h('select', { class: 'select', 'aria-label': 'Часовой пояс капа', onchange: (e) => { o.capTz = e.target.value; } },
        zones.map((z) => h('option', { value: z, selected: z === o.capTz }, z))), 'Сутки капа начинаются в полночь этого пояса.'),
      field('Запасной оффер', h('select', { class: 'select', 'aria-label': 'Запасной оффер', onchange: (e) => { o.altOfferId = e.target.value; } },
        h('option', { value: '', selected: !o.altOfferId }, '— нет —'), others.map((k) => h('option', { value: k, selected: k === o.altOfferId }, state.offers[k].name ? `${k} — ${state.offers[k].name}` : k))),
        'Куда уходит трафик, когда кап конверсий достигнут (цепочка до 3 переходов). Без запасного оффер просто пропускается в потоке.'),
      field('S2S постбэк в партнёрку', h('input', { class: 'input', type: 'url', value: o.postbackUrl, placeholder: 'https://… (необязательно)', oninput: (e) => { o.postbackUrl = e.target.value.trim(); } }), 'Вызывается при конверсии. Макросы: {click_id} {revenue} {currency}.'))],
  ]);
  const close = openModal({
    title: isNew ? 'Создание оффера' : 'Редактирование оффера', body: h('div', {}, body, err),
    footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => {
      err.textContent = '';
      if (!ID_RE.test(o.id)) { err.textContent = 'ID: 2–80 символов, латиница, цифры, - и _.'; return; }
      if (!/^https:\/\//i.test(o.url)) { err.textContent = 'URL должен начинаться с https://'; return; }
      if (o.postbackUrl && !/^https:\/\//i.test(o.postbackUrl)) { err.textContent = 'S2S URL должен начинаться с https://'; return; }
      const cap = intOrNull(o.dailyCap);
      if (Number.isNaN(cap) || (cap !== null && cap < 1)) { err.textContent = 'Дневной кап — целое число больше нуля.'; return; }
      const convCap = intOrNull(o.conversionCap);
      if (Number.isNaN(convCap) || (convCap !== null && convCap < 1)) { err.textContent = 'Кап конверсий — целое число больше нуля.'; return; }
      if (isNew && state.offers[o.id]) { err.textContent = 'Оффер с таким ID уже есть.'; return; }
      try {
        const body2 = { name: o.name.trim() || null, group: o.group.trim(), url: o.url, postbackUrl: o.postbackUrl || null, dailyCap: cap, conversionCap: convCap, capTz: o.capTz, altOfferId: o.altOfferId || null };
        await (isNew ? api('/api/offers', { method: 'POST', body: { id: o.id, ...body2 } }) : api('/api/offers/' + encodeURIComponent(o.id), { method: 'PATCH', body: body2 }));
        toast(isNew ? 'Оффер создан' : 'Сохранено'); close(); onSaved();
      } catch (e) { err.textContent = 'Не сохранено: ' + e.message; }
    } }, isNew ? 'Создать' : 'Сохранить')],
  });
}

function landingModal(id, onSaved) {
  const isNew = !id;
  const l = isNew ? { id: '', name: '', url: '' } : { id, name: state.landings[id].name || '', url: state.landings[id].url };
  const err = h('p', { class: 'err' });
  const close = openModal({
    title: isNew ? 'Создание лендинга' : 'Редактирование лендинга',
    body: h('div', {},
      field('ID лендинга', h('input', { class: 'input', value: l.id, readonly: !isNew, oninput: (e) => { l.id = e.target.value.trim(); } }), isNew ? 'Латиница, цифры, - и _.' : null),
      field('Название', h('input', { class: 'input', value: l.name, maxlength: 200, oninput: (e) => { l.name = e.target.value; } })),
      field('URL лендинга', h('input', { class: 'input', type: 'url', value: l.url, placeholder: 'https://…', oninput: (e) => { l.url = e.target.value.trim(); } }),
        'Посетитель попадает сюда из потока, к ссылке добавляется click_id. Кнопка на лендинге должна вести на ссылку перехода — её можно передать макросом {lp_click_url}, например https://ваш-лендинг/?go={lp_click_url}'),
      h('p', { class: 'muted' }, `Ссылка перехода на оффер: ${location.origin}${BASE}/lp/click?click_id=<click_id>`),
      err),
    footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => {
      err.textContent = '';
      if (!ID_RE.test(l.id)) { err.textContent = 'ID: 2–80 символов, латиница, цифры, - и _.'; return; }
      if (!/^https:\/\//i.test(l.url)) { err.textContent = 'URL должен начинаться с https://'; return; }
      if (isNew && state.landings[l.id]) { err.textContent = 'Лендинг с таким ID уже есть.'; return; }
      try {
        const body = { name: l.name.trim() || null, url: l.url };
        await (isNew ? api('/api/landings', { method: 'POST', body: { id: l.id, ...body } }) : api('/api/landings/' + encodeURIComponent(l.id), { method: 'PATCH', body }));
        toast(isNew ? 'Лендинг создан' : 'Сохранено'); close(); onSaved();
      } catch (e) { err.textContent = 'Не сохранено: ' + e.message; }
    } }, isNew ? 'Создать' : 'Сохранить')],
  });
}

async function pageLandings() {
  const table = dataTable({
    id: 'landings', pageSize: 250,
    columns: [
      { key: 'id', label: 'ID', fixed: true, render: (r) => h('a', { href: '#/landings', onclick: (e) => { e.preventDefault(); landingModal(r.id, load); } }, r.id) },
      { key: 'name', label: 'Название', cls: 'name', value: (r) => r.name || '', render: (r) => r.name || '—' },
      { key: 'url', label: 'URL', cls: 'name', hidden: true },
      { key: 'clicks', label: 'Просмотры', title: 'Просмотры лендинга (клики, попавшие на лендинг)', num: true, render: (r) => num(r.clicks), total: (rs) => num(sum(rs, 'clicks')) },
      { key: 'lpClicks', label: 'Клики LP', title: 'Переходы с лендинга на оффер', num: true, render: (r) => num(r.lpClicks), total: (rs) => num(sum(rs, 'lpClicks')) },
      { key: 'lpCtr', label: 'LP CTR', num: true, value: (r) => ratio(r.lpClicks, r.clicks), render: (r) => pct(ratio(r.lpClicks, r.clicks)), total: (rs) => pct(ratio(sum(rs, 'lpClicks'), sum(rs, 'clicks'))) },
      ...metricCols().filter((c) => ['conversions', 'cr', 'revenue', 'epc'].includes(c.key)),
    ],
  });
  put(view,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => landingModal(null, load) }, 'Создать')),
    h('div', { class: 'toolbar' }, periodControl(() => load()), currencyControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table.chooser() }, '⚙')),
    table);
  async function load() {
    try {
      await loadRefs();
      const s = await api('/stats' + qs(periodRange()));
      const by = s.byLanding || {};
      table.setRows(Object.entries(state.landings).map(([id, l]) => ({ id, ...l, clicks: by[id]?.clicks || 0, lpClicks: by[id]?.lpClicks || 0, conversions: by[id]?.conversions || 0, revenue: by[id]?.revenue || 0 })));
    } catch (e) { toast('Ошибка загрузки лендингов: ' + e.message, true); }
  }
  load();
  return () => table.detach();
}

async function pageNetworks() {
  const table = dataTable({ id: 'networks', pageSize: 250, columns: [
    { key: 'id', label: 'ID', fixed: true }, { key: 'name', label: 'Название', cls: 'name' },
    { key: 'clickIdParam', label: 'Click ID' }, { key: 'payoutParam', label: 'Payout' }, { key: 'offerParams', label: 'Параметры оффера', cls: 'name' },
    { key: 'notes', label: 'Заметки', cls: 'name' },
    { key: 'actions', label: '', sortable: false, render: (r) => h('span', { class: 'row-actions' }, h('button', { onclick: () => networkModal(r, load) }, 'Изменить')) },
  ] });
  function networkModal(current, onSaved) {
    const n = { id: current?.id || '', name: current?.name || '', offerParams: current?.offerParams || '', clickIdParam: current?.clickIdParam || 'sub1', payoutParam: current?.payoutParam || 'payout', notes: current?.notes || '' };
    const err = h('p', { class: 'err' });
    const close = openModal({ title: current ? 'Редактирование сети' : 'Новая сеть', body: h('div', {},
      field('ID', h('input', { class: 'input', value: n.id, readonly: Boolean(current), oninput: (e) => { n.id = e.target.value.trim(); } })),
      field('Название', h('input', { class: 'input', value: n.name, oninput: (e) => { n.name = e.target.value; } })),
      field('Параметры оффера', h('input', { class: 'input', value: n.offerParams, oninput: (e) => { n.offerParams = e.target.value; } })),
      field('Параметр click ID', h('input', { class: 'input', value: n.clickIdParam, oninput: (e) => { n.clickIdParam = e.target.value; } })),
      field('Параметр выплаты', h('input', { class: 'input', value: n.payoutParam, oninput: (e) => { n.payoutParam = e.target.value; } })),
      field('Заметки', h('textarea', { class: 'input', rows: 4, oninput: (e) => { n.notes = e.target.value; } }, n.notes)), err),
      footer: [h('button', { class: 'btn', onclick: close }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => { try { await api(current ? '/api/networks/' + encodeURIComponent(n.id) : '/api/networks', { method: current ? 'PATCH' : 'POST', body: n }); toast('Сеть сохранена'); close(); onSaved(); } catch (e) { err.textContent = e.message; } } }, 'Сохранить')],
    });
  }
  function load() { api('/api/networks').then((r) => table.setRows(Object.entries(r.networks || {}).map(([id, v]) => ({ id, ...v })))).catch((e) => toast('Ошибка сетей: ' + e.message, true)); }
  put(view, h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => networkModal(null, load) }, 'Создать сеть')), table); load(); return () => table.detach();
}

async function pageOffers() {
  const stateFilter = h('select', { class: 'select', 'aria-label': 'Состояние', onchange: () => { table.clearSelection(); drawBulk(); load(); } },
    [['', 'Все состояния'], ['clicks', 'С кликами'], ['archived', 'Архив']].map(([v, l]) => h('option', { value: v }, l)));
  const groupSel = groupFilter(() => load());
  const bulk = h('span', { class: 'toolbar', style: 'margin:0' });
  const bulkErrors = h('div');
  const table = dataTable({
    id: 'offers', selectable: true, pageSize: 250,
    columns: [
      { key: 'id', label: 'ID', fixed: true, render: (r) => h('a', { href: '#/offers', onclick: (e) => { e.preventDefault(); offerModal(r.id, load); } }, r.id) },
      { key: 'menu', label: '', title: 'Меню', sortable: false, value: () => '', render: (r) => h('span', { class: 'row-actions' },
        h('button', { title: 'Изменить', 'aria-label': 'Изменить', onclick: () => offerModal(r.id, load) }, '✎'),
        h('a', { href: '#/reports' + qs({ group: 'country', offer: r.id }), title: 'Отчёт', 'aria-label': 'Отчёт' }, '▥'),
        h('a', { href: '#/clicks' + qs({ offer: r.id }), title: 'Лог кликов', 'aria-label': 'Лог кликов' }, '☰')) },
      { key: 'name', label: 'Название', cls: 'name', value: (r) => r.name || '', render: (r) => h('span', { title: r.name || '' }, r.name || '—') },
      { key: 'group', label: 'Группа', value: (r) => r.group || '', render: (r) => r.group || '—' },
      { key: 'url', label: 'URL', cls: 'name', hidden: true, render: (r) => h('span', { title: r.url }, r.url) },
      { key: 's2s', label: 'S2S', value: (r) => (r.postbackUrl ? 'да' : 'нет') },
      { key: 'dailyCap', label: 'Дневной кап', num: true, render: (r) => r.dailyCap ?? '—' },
      { key: 'conversionCap', label: 'Кап конверсий', num: true, hidden: true, render: (r) => (r.conversionCap ? `${r.conversionCap}${r.altOfferId ? ` → ${r.altOfferId}` : ''}` : '—') },
      ...metricCols(),
    ],
  });
  table.addEventListener('selection', () => drawBulk());
  function drawBulk() {
    const ids = table.selected();
    const inArchive = stateFilter.value === 'archived';
    put(bulk, ids.length ? [h('span', { class: 'muted' }, `Выбрано: ${ids.length}`),
      // Archiving asks for a second click on the same button instead of confirm().
      h('button', { class: 'btn', onclick: (e) => {
        const b = e.currentTarget;
        if (b.dataset.armed) return bulkPatch(ids, { archived: !inArchive }, inArchive ? 'Восстановлено' : 'В архиве');
        b.dataset.armed = '1'; b.textContent = `${inArchive ? 'Восстановить' : 'В архив'} ${ids.length}? Нажмите ещё раз`;
        setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = inArchive ? 'Из архива' : 'В архив'; } }, 4000);
      } }, inArchive ? 'Из архива' : 'В архив'),
      h('button', { class: 'btn', onclick: () => capModal(ids) }, 'Задать дневной кап…'),
      h('button', { class: 'btn', onclick: () => bulkGroupModal(ids) }, 'Сменить группу…')] : []);
  }
  // PATCH every selected offer; successes are applied, failures are listed per offer under the toolbar.
  async function bulkPatch(ids, body, label) {
    const results = await Promise.allSettled(ids.map((id) => api('/api/offers/' + encodeURIComponent(id), { method: 'PATCH', body })));
    const failed = results.map((r, i) => [ids[i], r]).filter(([, r]) => r.status === 'rejected');
    put(bulkErrors, failed.length ? h('div', { class: 'err', role: 'alert' }, `Не применено к ${failed.length} из ${ids.length}:`,
      h('ul', {}, failed.map(([id, r]) => h('li', {}, `${id}: ${r.reason?.message || 'ошибка'}`)))) : []);
    if (ids.length > failed.length) toast(`${label}: ${ids.length - failed.length}`);
    else toast('Не применено ни к одному офферу', true);
    table.clearSelection(); drawBulk(); load();
    return failed.length === 0;
  }
  function capModal(ids) {
    const input = h('input', { class: 'input', type: 'number', min: 1, placeholder: 'пусто — без капа', 'aria-label': 'Дневной кап кликов' });
    const err = h('p', { class: 'err' });
    const close = openModal({
      title: 'Дневной кап для офферов',
      body: h('div', {}, h('p', { class: 'muted' }, `Выбрано офферов: ${ids.length}`), field('Дневной кап кликов', input, 'Пустое поле снимает кап.'), err),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => {
        const cap = intOrNull(input.value.trim());
        if (Number.isNaN(cap) || (cap !== null && cap < 1)) { err.textContent = 'Дневной кап — целое число больше нуля.'; return; }
        close(); await bulkPatch(ids, { dailyCap: cap }, 'Кап задан');
      } }, 'Применить')],
    });
  }
  function bulkGroupModal(ids) {
    let group = '';
    const close = openModal({
      title: 'Группа для офферов',
      body: h('div', {}, h('p', { class: 'muted' }, `Выбрано офферов: ${ids.length}`), field('Группа', groupInput(state.offers, '', (v) => { group = v; }), 'Пустое поле убирает группу.')),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => {
        close(); await bulkPatch(ids, { group: group.trim() }, 'Группа изменена');
      } }, 'Применить')],
    });
  }
  put(view,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => offerModal(null, load) }, 'Создать'), bulk),
    bulkErrors,
    h('div', { class: 'toolbar' }, stateFilter, groupSel, periodControl(() => load()), currencyControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table.chooser() }, '⚙')),
    table);
  async function load() {
    try {
      await loadRefs();
      groupSel.refresh(state.offers);
      const s = await api('/stats' + qs(periodRange()));
      const f = stateFilter.value;
      let rows = Object.entries(state.offers).map(([id, o]) => ({ id, ...o, clicks: s.byOffer[id]?.clicks || 0, uniqueClicks: s.byOffer[id]?.uniqueClicks || 0, cost: s.byOffer[id]?.cost || 0, conversions: s.byOffer[id]?.conversions || 0, revenue: s.byOffer[id]?.revenue || 0, leads: s.byOffer[id]?.leads || 0, sales: s.byOffer[id]?.sales || 0, rejected: s.byOffer[id]?.rejected || 0, pendingRevenue: s.byOffer[id]?.pendingRevenue || 0 }));
      rows = rows.filter((r) => (f === 'archived') === Boolean(r.archived));
      if (groupSel.value) rows = rows.filter((r) => (r.group || '') === groupSel.value);
      if (f === 'clicks') rows = rows.filter((r) => r.clicks > 0);
      table.setRows(rows);
    } catch (e) { toast('Ошибка загрузки офферов: ' + e.message, true); }
  }
  load();
  return () => table.detach();
}

const GROUPS = [
  ['campaign', 'Кампания', 'byCampaign'], ['offer', 'Оффер', 'byOffer'], ['stream', 'Поток', 'byStream'], ['landing', 'Лендинг', 'byLanding'], ['country', 'Страна', 'byCountry'],
  ['device', 'Устройство', null], ['os', 'ОС', null], ['browser', 'Браузер', null], ['language', 'Язык', null], ['isp', 'Провайдер', null],
  ['day', 'День', null], ['hour', 'Час', null], ['referrer', 'Реферер', null], ['path', 'Путь', null],
];
async function pageReports(params) {
  await loadRefs();
  const f = { group: params.get('group') || 'campaign', campaign: params.get('campaign') || '', offer: params.get('offer') || '', country: params.get('country') || '', stream: params.get('stream') || '', subid: params.get('subid') || '', field: params.get('field') || '' };
  const note = h('p', { class: 'muted' });
  const holder = h('div');
  let table = null;
  const sync = () => { const next = '#/reports' + qs(f); if (location.hash !== next) history.replaceState(null, '', next); };
  const presets = h('div', { class: 'toolbar' });
  let currentParamRows = [];
  const LIST_FIELDS = new Set(['source', 'creative_id', ...Array.from({ length: 30 }, (_, i) => `sub_id_${i + 1}`)]);
  const PARAM_FIELDS = ['keyword', 'source', 'external_id', 'creative_id', 'ad_campaign_id', ...Array.from({ length: 30 }, (_, i) => `sub_id_${i + 1}`)];
  const paramSel = h('select', { class: 'select', 'aria-label': 'Параметр', onchange: (e) => { f.field = e.target.value; drawPresets(); load(); } },
    h('option', { value: '' }, 'Параметр'), PARAM_FIELDS.map((n) => h('option', { value: n, selected: f.field === n }, n)));
  const drawPresets = () => put(presets, [...GROUPS.map(([k, l]) => h('button', { class: 'chip-btn' + (f.group === k && !f.field ? ' on' : ''), onclick: () => { f.group = k; f.field = ''; paramSel.value = ''; drawPresets(); load(); } }, l)), h('button', { class: 'chip-btn' + (f.group === 'heatmap' ? ' on' : ''), onclick: () => { f.group = 'heatmap'; f.field = ''; paramSel.value = ''; drawPresets(); load(); } }, 'Карта по часам')]);
  drawPresets();

  // Period comparison: a second request for the equally long period right before the current one.
  const COMPARE_GROUPS = new Set(['campaign', 'offer', 'stream', 'landing', 'country', 'device', 'os', 'browser', 'language', 'isp']);
  // Named via title, not <label>: a label containing «периодом» would also match lookups of the «Период» select by label.
  const compareBox = h('input', { type: 'checkbox', title: 'Сравнить с предыдущим периодом', checked: store.get('reports:compare', false), onchange: (e) => { store.set('reports:compare', e.target.checked); load(); } });
  const compareLabel = h('span', { class: 'muted', style: 'display:inline-flex;align-items:center;gap:4px;cursor:pointer', onclick: (e) => { if (e.target !== compareBox) compareBox.click(); } }, compareBox, h('span', { 'aria-hidden': 'true' }, 'Сравнить с предыдущим периодом'));
  const prevRange = (from, to) => {
    const start = Date.parse(from + 'T00:00:00Z'); const span = Date.parse(to + 'T00:00:00Z') - start + 86400000;
    return { from: new Date(start - span).toISOString().slice(0, 10), to: new Date(start - 86400000).toISOString().slice(0, 10) };
  };
  const deltaPct = (cur, prev) => (prev ? (cur - prev) / Math.abs(prev) * 100 : null);
  const deltaCell = (d) => (d === null ? '—' : h('span', { class: d > 0 ? 'pos' : d < 0 ? 'neg' : '' }, (d > 0 ? '+' : '') + d.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%'));
  const DELTA_METRICS = { clicks: ['клики', (r) => r.clicks || 0], conversions: ['конверсии', (r) => r.conversions || 0], revenue: ['доход', (r) => r.revenue || 0], profit: ['прибыль', (r) => (r.revenue || 0) - (r.cost || 0)] };
  const withDeltas = (cols) => cols.flatMap((c) => {
    const m = DELTA_METRICS[c.key];
    if (!m) return [c];
    const [name, get] = m;
    const totalOf = (rs) => deltaPct(rs.reduce((s, r) => s + get(r), 0), rs.reduce((s, r) => s + (r.prev ? get(r.prev) : 0), 0));
    return [c, { key: 'delta_' + c.key, label: 'Δ%', title: 'Δ% ' + name + ' к предыдущему периоду', num: true,
      value: (r) => deltaPct(get(r), r.prev ? get(r.prev) : 0), render: (r) => deltaCell(deltaPct(get(r), r.prev ? get(r.prev) : 0)), total: (rs) => deltaCell(totalOf(rs)) }];
  });

  // Saved reports
  const savedBar = h('div', { class: 'toolbar', style: 'flex-wrap:wrap;gap:4px;margin-bottom:4px', 'aria-label': 'Сохранённые отчёты' });
  const drawSaved = () => {
    const saved = store.get('reports:saved', []);
    if (!saved.length) { savedBar.hidden = true; return; }
    savedBar.hidden = false;
    put(savedBar, saved.map((s, i) => h('span', { class: 'chip-btn', style: 'display:inline-flex;align-items:center;gap:4px' },
      h('button', { style: 'background:none;border:none;padding:0;cursor:pointer;color:inherit', 'aria-label': 'Открыть ' + s.name, onclick: () => {
        if (s.period) { period.key = s.period.key; period.from = s.period.from; period.to = s.period.to; store.set('period', period); }
        if (s.currency) { currency.code = s.currency; store.set('currency', currency.code); }
        location.hash = '#/reports' + qs({ group: s.group || 'campaign', campaign: s.campaign || '', offer: s.offer || '', country: s.country || '', stream: s.stream || '', subid: s.subid || '', field: s.field || '' });
      } }, s.name),
      h('button', { style: 'background:none;border:none;padding:0 2px;cursor:pointer;color:var(--fg-3)', 'aria-label': 'Удалить ' + s.name, onclick: () => { const upd = store.get('reports:saved', []).filter((_, j) => j !== i); store.set('reports:saved', upd); drawSaved(); } }, '✕'))));
  };
  drawSaved();

  const saveReport = () => {
    const nameInput = h('input', { class: 'input', placeholder: 'Название', 'aria-label': 'Название отчёта', style: 'width:100%' });
    const close = openModal({ title: 'Сохранить отчёт', body: h('div', { class: 'field' }, nameInput),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отменить'),
        h('button', { class: 'btn primary', onclick: () => {
          const name = nameInput.value.trim(); if (!name) return;
          const saved = store.get('reports:saved', []);
          const entry = { name, ...f, period: { ...periodRange(), key: period.key }, currency: currency.code };
          store.set('reports:saved', [...saved, entry].slice(-20));
          drawSaved(); close();
        } }, 'Сохранить')],
    });
    nameInput.focus();
  };

  const sel = (key, label, options) => h('select', { class: 'select', 'aria-label': label, onchange: (e) => { f[key] = e.target.value; load(); } },
    h('option', { value: '' }, label), options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
  const txt = (key, label) => h('input', { class: 'input', value: f[key], placeholder: label, 'aria-label': label, style: 'width:130px', onchange: (e) => { f[key] = e.target.value.trim(); load(); } });
  const listsBtn = h('button', { class: 'btn', hidden: true, onclick: () => {
    const roiThr = h('input', { type: 'number', class: 'input', value: '-30', style: 'width:80px', 'aria-label': 'Порог ROI (%)' });
    const minCl = h('input', { type: 'number', class: 'input', value: '100', style: 'width:80px', 'aria-label': 'Минимум кликов' });
    const blackOut = h('div');
    const whiteOut = h('div');
    const compute = () => {
      const thr = (Number(roiThr.value) || -30) / 100;
      const min = Number(minCl.value) || 0;
      const eligible = currentParamRows.filter((r) => r.clicks >= min);
      const black = eligible.filter((r) => r.roi < thr).map((r) => r.id);
      const white = eligible.filter((r) => r.roi >= 0).map((r) => r.id);
      const copyBtn = (arr) => arr.length ? h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(arr.join(', ')).catch(() => {}) }, 'Копировать') : null;
      put(blackOut, black.length ? document.createTextNode(black.join(', ')) : h('em', {}, '(нет значений)'), copyBtn(black));
      put(whiteOut, white.length ? document.createTextNode(white.join(', ')) : h('em', {}, '(нет значений)'), copyBtn(white));
    };
    roiThr.addEventListener('input', compute);
    minCl.addEventListener('input', compute);
    compute();
    openModal({ title: 'Списки',
      body: h('div', {},
        h('div', { class: 'toolbar', style: 'margin-bottom:12px' },
          h('label', {}, 'Порог ROI (%): ', roiThr), h('label', {}, 'Мин. кликов: ', minCl)),
        h('h3', {}, 'Чёрный список'), blackOut,
        h('h3', {}, 'Белый список'), whiteOut) });
  } }, 'Списки');
  put(view, h('h1', {}, 'Отчёт'), savedBar, presets,
    h('div', { class: 'toolbar' },
      paramSel,
      sel('campaign', 'Все кампании', Object.entries(state.campaigns).map(([id, c]) => [id, c.name || id])),
      sel('offer', 'Все офферы', Object.keys(state.offers).map((id) => [id, id])),
      txt('country', 'Страна'), txt('stream', 'Поток'), txt('subid', 'Sub ID'),
      periodControl(() => load()), currencyControl(() => load()), compareLabel,
      listsBtn,
      h('button', { class: 'btn', onclick: saveReport }, '💾 Сохранить'),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table?.chooser() }, '⚙')),
    note, holder);

  async function load() {
    sync();
    const { from, to } = periodRange();
    note.textContent = '';
    listsBtn.hidden = !f.field || !LIST_FIELDS.has(f.field);
    compareBox.disabled = !from || !(f.field || COMPARE_GROUPS.has(f.group));
    compareBox.title = compareBox.disabled ? 'Сравнить с предыдущим периодом — недоступно для «За всё время», времени, карты по часам, рефереров и путей' : 'Сравнить с предыдущим периодом';
    const compare = compareBox.checked && !compareBox.disabled;
    const prev = compare ? prevRange(from, to) : null;
    if (f.group === 'heatmap') {
      table?.detach(); table = null;
      const tz = store.get('heatmap:tz', 'UTC');
      const metric = store.get('heatmap:metric', 'clicks');
      const tzSel = h('select', { class: 'select', 'aria-label': 'Часовой пояс', onchange: (e) => { store.set('heatmap:tz', e.target.value); load(); } },
        ['UTC', ...TIME_ZONES.filter((z) => z !== 'UTC')].map((z) => h('option', { value: z, selected: z === tz }, z)));
      const metricSel = h('select', { class: 'select', 'aria-label': 'Метрика тепловой карты', onchange: (e) => { store.set('heatmap:metric', e.target.value); load(); } },
        [['clicks', 'Клики'], ['conversions', 'Конверсии'], ['cr', 'CR'], ['revenue', 'Доход']].map(([k, l]) => h('option', { value: k, selected: k === metric }, l)));
      try {
        const ts = await api('/stats/timeseries' + qs({ campaign: f.campaign, from, to, granularity: 'hour' }));
        const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
        const gConv = Array.from({ length: 7 }, () => new Array(24).fill(0));
        const gRev = Array.from({ length: 7 }, () => new Array(24).fill(0));
        const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        for (const p of ts.series || []) {
          // Hourly buckets come as 'YYYY-MM-DDTHH' (UTC), which Date cannot parse on its own.
          const raw = String(p.bucket ?? p.date); const d = new Date(raw.length === 13 ? `${raw}:00:00Z` : raw);
          const parts = new Intl.DateTimeFormat('en', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit' }).formatToParts(d);
          const wdRaw = WD_SHORT.indexOf(parts.find((x) => x.type === 'weekday')?.value ?? 'Sun');
          const wd = wdRaw < 0 ? 0 : (wdRaw + 6) % 7; // 0=Mon … 6=Sun
          const hr = Number(parts.find((x) => x.type === 'hour')?.value ?? 0) % 24;
          grid[wd][hr] += p.clicks || 0;
          gConv[wd][hr] += p.conversions || 0;
          gRev[wd][hr] += p.revenue || 0;
        }
        const getVal = (wd, hr) => {
          if (metric === 'clicks') return grid[wd][hr];
          if (metric === 'conversions') return gConv[wd][hr];
          if (metric === 'cr') return (grid[wd][hr] ? gConv[wd][hr] / grid[wd][hr] : 0);
          if (metric === 'revenue') return gRev[wd][hr];
          return 0;
        };
        const maxVal = Math.max(...Array.from({ length: 7 }, (_, w) => Array.from({ length: 24 }, (_, h2) => getVal(w, h2))).flat(), 1);
        const fmtVal = (v) => metric === 'revenue' ? money(v) : metric === 'cr' ? pct(v) : num(v);
        const WD_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
        const heatTable = h('div', { style: 'overflow-x:auto' },
          h('table', { class: 'heatmap', 'aria-label': 'Тепловая карта по часам', style: 'border-collapse:collapse;min-width:max-content' },
            h('thead', {}, h('tr', {}, h('th', { style: 'padding:2px 6px' }, ''), ...Array.from({ length: 24 }, (_, hr) => h('th', { style: 'padding:2px 4px;text-align:center;font-size:11px;color:var(--fg-2)' }, String(hr))))),
            h('tbody', {}, ...WD_LABELS.map((label, wd) =>
              h('tr', {},
                h('th', { scope: 'row', style: 'padding:2px 6px;font-size:12px;white-space:nowrap;color:var(--fg-2);font-weight:normal' }, label),
                ...Array.from({ length: 24 }, (_, hr) => {
                  const v = getVal(wd, hr);
                  const op = Math.round(5 + 90 * v / maxVal);
                  return h('td', { 'data-clicks': String(grid[wd][hr]), title: fmtVal(v), style: `padding:2px 4px;text-align:center;font-size:11px;min-width:28px;background:color-mix(in srgb,var(--k1) ${op}%,transparent)` }, v > 0 ? (metric === 'revenue' ? num(Math.round(v)) : metric === 'cr' ? String(Math.round(v * 100)) + '%' : String(v)) : '');
                }))))));
        put(holder, h('div', { class: 'toolbar', style: 'margin-bottom:8px' }, tzSel, metricSel), heatTable);
      } catch (e) { put(holder, h('p', { class: 'err' }, 'Ошибка тепловой карты: ' + e.message)); }
      return;
    }
    const [key, label, prop] = GROUPS.find((g) => g[0] === f.group) || GROUPS[0];
    try {
      let rows; let drill = null;
      if (f.field) {
        const s = await api('/stats/params' + qs({ field: f.field, campaign: f.campaign, from, to }));
        rows = (s.rows || []).map((x) => ({ id: x.value || '(не передан)', clicks: x.clicks || 0, conversions: x.conversions || 0, revenue: x.revenue || 0, cost: x.cost || 0, profit: x.profit || 0, roi: x.roi || 0 }));
        if (prev) {
          const p = await api('/stats/params' + qs({ field: f.field, campaign: f.campaign, ...prev }));
          const byId = new Map((p.rows || []).map((x) => [x.value || '(не передан)', x]));
          rows.forEach((r) => { r.prev = byId.get(r.id) || null; });
        }
        currentParamRows = rows;
        note.textContent = 'Для отчёта по параметру применяются только кампания и период.';
      } else if (prop) {
        const s = await api('/stats' + qs({ from, to, campaign: f.campaign, offer: f.offer, country: f.country, stream: f.stream, subid: f.subid }));
        rows = groupRows(s[prop]);
        if (prev) {
          const p = await api('/stats' + qs({ ...prev, campaign: f.campaign, offer: f.offer, country: f.country, stream: f.stream, subid: f.subid }));
          const byId = new Map(groupRows(p[prop]).map((x) => [x.id, x]));
          rows.forEach((r) => { r.prev = byId.get(r.id) || null; });
        }
        if (key === 'campaign') drill = (r) => ({ group: 'stream', campaign: r.id });
        if (key === 'offer') drill = (r) => ({ group: 'country', offer: r.id });
        if (key === 'stream') drill = (r) => ({ group: 'offer', stream: r.id });
      } else if (['device', 'os', 'browser', 'language', 'isp'].includes(key)) {
        const r = await api('/stats/params' + qs({ field: key, campaign: f.campaign, from, to }));
        rows = (r.rows || []).map((x) => ({ id: x.value || '(неизвестно)', clicks: x.clicks || 0, conversions: x.conversions || 0, revenue: x.revenue || 0, cost: x.cost || 0 }));
        if (prev) {
          const p = await api('/stats/params' + qs({ field: key, campaign: f.campaign, ...prev }));
          const byId = new Map((p.rows || []).map((x) => [x.value || '(неизвестно)', x]));
          rows.forEach((r) => { r.prev = byId.get(r.id) || null; });
        }
        if (f.offer || f.country || f.stream || f.subid) note.textContent = 'Для этой группировки применяются только кампания и период.';
      } else if (key === 'day' || key === 'hour') {
        const ts = await api('/stats/timeseries' + qs({ campaign: f.campaign, from, to, granularity: key }));
        rows = ts.series.map((p) => ({ id: String(p.date ?? p.bucket).replace('T', ' ') + (key === 'hour' ? ':00' : ''), clicks: p.clicks || 0, conversions: p.conversions || 0, revenue: p.revenue || 0 }));
        if (f.offer || f.country || f.stream || f.subid) note.textContent = 'Для группировки по времени применяются только кампания и период.';
      } else {
        const r = await api(`/stats/${key === 'referrer' ? 'referrers' : 'paths'}` + qs({ campaign: f.campaign, limit: 100 }));
        rows = (r.referrers || r.paths || []).map((x) => ({ id: x.referrer ?? x.path ?? '—', clicks: x.clicks || 0, conversions: 0, revenue: 0 }));
        note.textContent = 'Рефереры и пути считаются за всё время, применяется только фильтр кампании; конверсии здесь не считаются.';
      }
      if (prev) note.textContent = [note.textContent, `Δ% — по сравнению с ${prev.from} — ${prev.to}.`].filter(Boolean).join(' ');
      const nameOf = (r) => (key === 'campaign' ? state.campaigns[r.id]?.name || r.id : key === 'landing' ? (r.id === 'none' ? '(без лендинга)' : state.landings[r.id]?.name || r.id) : r.id);
      const expandedRows = new Map();
      const expandRow = async (r, btn) => {
        const tr = btn.closest('tr');
        if (!tr) return;
        if (expandedRows.has(r.id)) {
          expandedRows.get(r.id).remove();
          expandedRows.delete(r.id);
          btn.textContent = '▸';
          return;
        }
        if (expandedRows.size >= 3) return;
        btn.textContent = '▾';
        const subTr = document.createElement('tr');
        subTr.className = 'sub-row';
        const subTd = document.createElement('td');
        subTd.colSpan = 99;
        subTd.style.cssText = 'padding:4px 8px 8px 28px;background:var(--bg2,var(--bg))';
        subTr.appendChild(subTd);
        tr.after(subTr);
        expandedRows.set(r.id, subTr);
        try {
          const dp = drill(r);
          const nextEntry = GROUPS.find((g) => g[0] === dp.group);
          const s2 = await api('/stats' + qs({ from, to, ...dp }));
          const subRows = nextEntry?.[2] ? groupRows(s2[nextEntry[2]]) : [];
          const subNameOf = (sr) => (dp.group === 'campaign' ? state.campaigns[sr.id]?.name || sr.id : sr.id);
          const subTable = dataTable({
            id: 'sub-' + key + '-' + String(r.id).replace(/[^a-z0-9_-]/gi, '_').slice(0, 30),
            pageSize: 20, compact: true, totals: true,
            rows: subRows,
            columns: [
              { key: 'id', label: nextEntry?.[1] || 'ID', fixed: true, cls: 'name', render: subNameOf },
              ...metricCols({ rpm: true }),
            ],
          });
          put(subTd, subTable);
        } catch (e) {
          expandedRows.delete(r.id);
          btn.textContent = '▸';
          put(subTd, h('p', { class: 'err' }, e.message));
        }
      };
      table?.detach();
      table = dataTable({
        id: 'report-' + key, pageSize: 100,
        rows,
        columns: [{ key: 'id', label: f.field ? 'Значение' : label, fixed: true, cls: 'name', value: nameOf,
          render: (r) => drill
            ? h('span', { style: 'display:inline-flex;align-items:center;gap:4px' },
                h('button', { style: 'all:unset;cursor:pointer;font-size:10px;color:var(--fg-2,#999);user-select:none', 'aria-label': 'Развернуть', onclick: (e) => { e.stopPropagation(); expandRow(r, e.currentTarget); } }, '▸'),
                nameOf(r))
            : nameOf(r) },
          ...(prev ? withDeltas(metricCols({ rpm: true })) : metricCols({ rpm: true }))],
      });
      put(holder, table);
    } catch (e) { put(holder, h('p', { class: 'err' }, 'Ошибка отчёта: ' + e.message)); }
  }
  load();
  return () => table?.detach();
}

function pageLog(kind, params) {
  const isClicks = kind === 'clicks';
  const f = { campaign: params.get('campaign') || '', offer: params.get('offer') || '', stream: params.get('stream') || '' };
  let offset = 0; let limit = store.get('size:log-' + kind, 50); let last = { hasMore: false, rows: 0 };
  const holder = h('div');
  let table = null;
  const sel = (key, label, options) => h('select', { class: 'select', 'aria-label': label, onchange: (e) => { f[key] = e.target.value; offset = 0; load(); } },
    h('option', { value: '' }, label), options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
  const toolbar = h('div', { class: 'toolbar' });
  put(view, h('h1', {}, isClicks ? 'Лог кликов' : 'Лог конверсий'), toolbar, holder);
  const columns = isClicks ? [
    { key: 'at', label: 'Дата и время', fixed: true, render: (r) => dt(r.at) },
    { key: 'id', label: 'Click ID', cls: 'mono', render: (r) => h('span', { title: r.id }, r.id.slice(0, 13) + '…') },
    { key: 'subid', label: 'Subid' }, { key: 'ip', label: 'IP' },
    { key: 'campaign', label: 'Кампания', cls: 'name', render: (r) => h('a', { href: '#/campaigns/' + encodeURIComponent(r.campaign) }, state.campaigns[r.campaign]?.name || r.campaign) },
    { key: 'stream', label: 'Поток' }, { key: 'offerId', label: 'Оффер' }, { key: 'country', label: 'Страна' },
    { key: 'referrer', label: 'Реферер', cls: 'name' }, { key: 'path', label: 'Путь', hidden: true },
    { key: 'userAgent', label: 'User Agent', cls: 'name', hidden: true },
    { key: 'sub_id_1', label: 'Sub ID 1', hidden: true, value: (r) => r.params?.sub_id_1 || '', render: (r) => r.params?.sub_id_1 || '' },
    { key: 'sub_id_2', label: 'Sub ID 2', hidden: true, value: (r) => r.params?.sub_id_2 || '', render: (r) => r.params?.sub_id_2 || '' },
    { key: 'sub_id_3', label: 'Sub ID 3', hidden: true, value: (r) => r.params?.sub_id_3 || '', render: (r) => r.params?.sub_id_3 || '' },
    { key: 'sub_id_4', label: 'Sub ID 4', hidden: true, value: (r) => r.params?.sub_id_4 || '', render: (r) => r.params?.sub_id_4 || '' },
    { key: 'sub_id_5', label: 'Sub ID 5', hidden: true, value: (r) => r.params?.sub_id_5 || '', render: (r) => r.params?.sub_id_5 || '' },
    { key: 'source', label: 'Source', hidden: true, value: (r) => r.params?.source || '', render: (r) => r.params?.source || '' },
    { key: 'creative_id', label: 'Creative ID', hidden: true, value: (r) => r.params?.creative_id || '', render: (r) => r.params?.creative_id || '' },
    { key: 'ad_campaign_id', label: 'Ad Campaign ID', hidden: true, value: (r) => r.params?.ad_campaign_id || '', render: (r) => r.params?.ad_campaign_id || '' },
    { key: 'cost', label: 'Расход', num: true, hidden: true, value: (r) => r.cost ?? '', render: (r) => (r.cost != null ? money(r.cost) : '') },
  ] : [
    { key: 'at', label: 'Дата и время', fixed: true, render: (r) => dt(r.at) },
    { key: 'id', label: 'Click ID', cls: 'mono', render: (r) => h('span', { title: r.id }, r.id.slice(0, 13) + '…') },
    { key: 'campaign', label: 'Кампания', cls: 'name', render: (r) => h('a', { href: '#/campaigns/' + encodeURIComponent(r.campaign) }, state.campaigns[r.campaign]?.name || r.campaign) },
    { key: 'stream', label: 'Поток' }, { key: 'offerId', label: 'Оффер' },
    { key: 'status', label: 'Статус', value: (r) => ({ lead: 'Лид', sale: 'Продажа', rejected: 'Отклонена', trash: 'Мусор' })[r.status] || r.status || 'Продажа' },
    { key: 'revenue', label: 'Сумма', title: 'Сумма в валюте конверсии', num: true, render: (r) => (r.revenue == null ? '—' : amount(r.revenue)), total: () => '' },
    { key: 'currency', label: 'Валюта' },
  ];
  const paging = {
    hasPrev: () => offset > 0, hasNext: () => last.hasMore,
    prev: () => { offset = Math.max(0, offset - limit); load(); }, next: () => { offset += limit; load(); },
    setLimit: (n) => { limit = n; offset = 0; load(); },
    label: () => (last.rows ? `${offset + 1} - ${offset + last.rows}${last.hasMore ? '+' : ''}` : '0'),
  };
  loadRefs().then(() => {
    put(toolbar, 
      sel('campaign', 'Все кампании', Object.entries(state.campaigns).map(([id, c]) => [id, c.name || id])),
      sel('offer', 'Все офферы', Object.keys(state.offers).map((id) => [id, id])),
      h('input', { class: 'input', value: f.stream, placeholder: 'Поток', 'aria-label': 'Поток', style: 'width:130px', onchange: (e) => { f.stream = e.target.value.trim(); offset = 0; load(); } }),
      periodControl(() => { offset = 0; load(); }),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table?.chooser() }, '⚙'));
    load();
  });
  async function load() {
    const next = `#/${kind}` + qs(f);
    if (location.hash !== next) history.replaceState(null, '', next);
    try {
      const r = await api(`/api/${kind}` + qs({ ...f, ...periodRange(), limit, offset }));
      const rows = (r[kind] || []).map((x) => ({ ...x, id: x.clickId }));
      last = { hasMore: Boolean(r.hasMore), rows: rows.length };
      table?.detach();
      table = dataTable({ id: 'log-' + kind, columns, rows, serverPaging: paging, pageSize: limit, totals: !isClicks, empty: isClicks ? 'Кликов за период нет' : 'Конверсий за период нет' });
      put(holder, table);
    } catch (e) { put(holder, h('p', { class: 'err' }, 'Ошибка загрузки: ' + e.message)); }
  }
  return () => table?.detach();
}

// ---------- buyers report ----------
async function pageBuyersReport() {
  if (!isOwnerView()) { location.hash = '#/dashboard'; return; }
  await loadRefs();
  await loadRates();
  const holder = h('div');
  let table = null;
  put(view, h('h1', {}, 'Сводка по баерам'),
    h('div', { class: 'toolbar' }, periodControl(() => load()), currencyControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻')), holder);
  async function load() {
    const { from, to } = periodRange();
    try {
      const [s, settings] = await Promise.all([api('/stats' + qs({ from, to })), api('/api/settings').catch(() => ({ buyerSharePct: 35 }))]);
      const sharePct = Number(settings.buyerSharePct) || 0;
      const rows = Object.values(Object.entries(s.byCampaign || {}).reduce((acc, [cid, v]) => {
        const owner = state.campaigns[cid]?.ownerId || '';
        const key = owner || '__none__';
        const row = acc[key] ||= { id: key, name: owner ? userEmail(owner) : 'Не назначен', campaigns: 0, clicks: 0, conversions: 0, revenue: 0, cost: 0 };
        row.campaigns += 1; row.clicks += v.clicks || 0; row.conversions += v.conversions || 0; row.revenue += v.revenue || 0; row.cost += v.cost || 0;
        return acc;
      }, {})).sort((a, b) => (b.revenue - b.cost) - (a.revenue - a.cost));
      table?.detach();
      table = dataTable({ id: 'buyers-report', compact: true, pageSize: 100, rows,
        columns: [
          { key: 'name', label: 'Баер', fixed: true, cls: 'name', render: (r) => h('a', { href: '#/campaigns' }, r.name) },
          { key: 'campaigns', label: 'Кампании', num: true, render: (r) => num(r.campaigns), total: (rs) => num(sum(rs, 'campaigns')) },
          ...metricCols().filter((c) => ['clicks', 'conversions', 'revenue', 'cost', 'profit', 'roi'].includes(c.key)),
          { key: 'earn', label: `Заработок · ${sharePct}%`, num: true, value: (r) => Math.max(0, r.revenue - r.cost) * sharePct / 100, render: (r) => money(Math.max(0, r.revenue - r.cost) * sharePct / 100), total: (rs) => money(rs.reduce((t, r) => t + Math.max(0, r.revenue - r.cost) * sharePct / 100, 0)) },
        ] });
      put(holder, table);
    } catch (e) { put(holder, h('p', { class: 'err' }, 'Ошибка загрузки: ' + e.message)); }
  }
  load();
}

// ---------- accounts ----------
function authScreen() {
  const setup = state.me?.setupRequired;
  document.body.classList.add('auth-mode');
  const err = h('p', { class: 'err' });
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true });
  const password = h('input', { class: 'input', type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 10 : null });
  const adminKey = h('input', { class: 'input', type: 'password', autocomplete: 'off' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, setup ? 'Создать владельца' : 'Войти');
  const form = h('form', { class: 'card auth-card', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; submit.disabled = true;
    try {
      const headers = { 'content-type': 'application/json', 'x-requested-with': 'umbrella', ...(setup && adminKey.value ? { authorization: 'Bearer ' + adminKey.value.trim() } : {}) };
      const res = await fetch(BASE + (setup ? '/api/auth/setup' : '/api/auth/login'), { method: 'POST', headers, body: JSON.stringify({ email: email.value, password: password.value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        err.textContent = ({ invalid_credentials: 'Неверный email или пароль.', too_many_attempts: 'Слишком много попыток, подождите 15 минут.', admin_token_required: 'Неверный ключ администратора.',
          password_too_short: 'Пароль — минимум 10 символов.', invalid_email: 'Проверьте email.', already_set_up: 'Владелец уже создан — войдите.' })[data.error] || 'Ошибка: ' + (data.error || res.status);
        return;
      }
      if (setup && adminKey.value) state.token = adminKey.value.trim();
      state.me = { user: data.user, setupRequired: false, loginRequired: true };
      document.body.classList.remove('auth-mode'); drawUserBox(); state.loaded = false; route();
    } catch (e2) { err.textContent = 'Сеть недоступна: ' + e2.message; }
    finally { submit.disabled = false; }
  } },
    h('h1', {}, setup ? 'Первый запуск' : 'Вход в Umbrella'),
    setup ? h('p', { class: 'muted' }, 'Создайте учётную запись владельца. Это отдельная база пользователей Umbrella — аккаунты других проектов на этом домене здесь не действуют.') : null,
    field('Email', email), field('Пароль', password, setup ? 'Минимум 10 символов.' : null),
    setup ? field('Ключ администратора', adminKey, 'ADMIN_TOKEN сервера — подтверждает, что установку настраивает её хозяин.') : null,
    err, submit);
  put(view, form);
  email.focus();
}

function drawUserBox() {
  const box = document.getElementById('user-box');
  const me = state.me?.user;
  document.querySelectorAll('[data-owner-only]').forEach((el) => { el.hidden = me?.role !== 'owner'; });
  document.querySelectorAll('[data-user-only]').forEach((el) => { el.hidden = !me; });
  put(box, me ? [h('span', { class: 'muted', title: me.role === 'owner' ? 'Владелец' : 'Баер' }, me.email),
    h('button', { class: 'btn', onclick: async () => { await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'umbrella' } }); state.me = { ...state.me, user: null }; drawUserBox(); state.me.loginRequired ? authScreen() : route(); } }, 'Выйти')]
    : state.me?.setupRequired ? h('button', { class: 'btn', onclick: () => authScreen() }, 'Создать владельца') : []);
}

async function pageUsers() {
  const roleLabel = { owner: 'Владелец', buyer: 'Баер' };
  const table = dataTable({
    id: 'users', totals: false,
    columns: [
      { key: 'email', label: 'Email', fixed: true },
      { key: 'role', label: 'Роль', value: (r) => roleLabel[r.role] || r.role },
      { key: 'createdAt', label: 'Создан', render: (r) => dt(r.createdAt) },
      { key: 'menu', label: '', sortable: false, value: () => '', render: (r) => (r.id === state.me?.user?.id ? h('span', { class: 'muted' }, 'это вы') : h('span', { class: 'row-actions' },
        h('button', { title: 'Удалить', 'aria-label': 'Удалить пользователя', onclick: async (e) => {
          const b = e.currentTarget;
          if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Удалить?'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '✕'; } }, 3000); return; }
          try { await api('/api/users/' + r.id, { method: 'DELETE' }); toast('Пользователь удалён'); load(); }
          catch (e2) { toast(({ last_owner: 'Нельзя удалить последнего владельца.' })[e2.message] || 'Не удалось: ' + e2.message, true); }
        } }, '✕'))) },
    ],
  });
  const create = () => {
    const u = { email: '', password: '', role: 'buyer' };
    const err = h('p', { class: 'err' });
    const close = openModal({
      title: 'Новый пользователь',
      body: h('div', {},
        field('Email', h('input', { class: 'input', type: 'email', autocomplete: 'off', oninput: (e) => { u.email = e.target.value; } })),
        field('Пароль', h('input', { class: 'input', type: 'password', autocomplete: 'new-password', oninput: (e) => { u.password = e.target.value; } }), 'Минимум 10 символов. Передайте его пользователю лично.'),
        field('Роль', h('div', { class: 'radios' }, Object.entries(roleLabel).map(([v, l]) => h('label', {}, h('input', { type: 'radio', name: 'urole', checked: v === 'buyer', onchange: () => { u.role = v; } }), l))),
          'Владелец управляет пользователями. Баер работает с кампаниями, офферами и отчётами.'),
        err),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: async () => {
        try { await api('/api/users', { method: 'POST', body: u }); toast('Пользователь создан'); close(); load(); }
        catch (e) { err.textContent = ({ email_taken: 'Такой email уже есть.', password_too_short: 'Пароль — минимум 10 символов.', invalid_email: 'Проверьте email.' })[e.message] || 'Ошибка: ' + e.message; }
      } }, 'Создать')],
    });
  };
  const ipBox = h('div', { class: 'card ip-allowlist' }, h('h2', {}, 'Доступ к панели по IP'), h('p', { class: 'muted' }, 'Загрузка…'));
  put(view, h('div', { class: 'page-head' }, h('h1', {}, 'Пользователи'), h('button', { class: 'btn primary', onclick: create }, 'Создать')),
    h('p', { class: 'muted' }, 'Собственная база пользователей Umbrella, не связанная с другими проектами на домене.'), table, ipBox);
  async function load() {
    try { table.setRows((await api('/api/users')).users); }
    catch (e) { toast('Не удалось загрузить пользователей: ' + e.message, true); }
  }
  // Read-only on purpose: the allowlist lives in ADMIN_ALLOWED_IPS, so nobody can lock the team out from here.
  async function loadSecurity() {
    try {
      const s = await api('/api/security');
      const rules = s.adminAllowedIps || [];
      put(ipBox, h('h2', {}, 'Доступ к панели по IP'),
        rules.length
          ? [h('p', {}, 'Панель, /api и /stats открываются только с адресов: ', h('code', {}, rules.join(', '))),
            h('p', { class: 'muted' }, 'Ваш IP: ', h('code', {}, s.clientIp || '—'), '. Клики, лендинги, postback и /health не ограничены.')]
          : h('p', {}, 'Ограничения нет — панель и API доступны с любого IP (после входа).'),
        h('p', { class: 'muted' }, 'Меняется только переменной окружения ADMIN_ALLOWED_IPS на сервере (IP или IPv4 CIDR через запятую), из панели — нельзя.'));
    } catch (e) { put(ipBox, h('h2', {}, 'Доступ к панели по IP'), h('p', { class: 'err' }, 'Не удалось загрузить: ' + e.message)); }
  }
  load();
  loadSecurity();
  return () => table.detach();
}

// ---------- API keys ----------
async function pageKeys() {
  if (!state.me?.user) { location.hash = '#/dashboard'; return; }
  const owner = isOwnerView();
  let showAll = owner && store.get('keys:all', false);
  const table = dataTable({
    id: 'api-keys', totals: false, empty: 'Ключей пока нет',
    columns: [
      { key: 'name', label: 'Название', fixed: true, cls: 'name' },
      owner ? { key: 'email', label: 'Пользователь', value: (r) => r.email || userEmail(r.userId) } : null,
      { key: 'last4', label: 'Ключ', value: (r) => 'umb_…' + r.last4 },
      { key: 'createdAt', label: 'Создан', render: (r) => dt(r.createdAt) },
      { key: 'lastUsedAt', label: 'Последнее использование', render: (r) => (r.lastUsedAt ? dt(r.lastUsedAt) : h('span', { class: 'muted' }, 'ещё не использовался')) },
      { key: 'menu', label: '', sortable: false, value: () => '', render: (r) => h('span', { class: 'row-actions' },
        h('button', { title: 'Удалить', 'aria-label': 'Удалить ключ ' + r.name, onclick: async (e) => {
          const b = e.currentTarget;
          if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Удалить?'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '✕'; } }, 3000); return; }
          try { await api('/api/keys/' + r.id, { method: 'DELETE' }); toast('Ключ удалён'); load(); }
          catch (e2) { toast('Не удалось: ' + e2.message, true); }
        } }, '✕')) },
    ].filter(Boolean),
  });
  const showSecret = (secret) => {
    const close = openModal({
      title: 'Ключ создан',
      body: h('div', {},
        h('p', {}, 'Скопируйте ключ сейчас — он показывается один раз. Umbrella хранит только его хеш, восстановить ключ нельзя: потерянный — удалите и создайте новый.'),
        field('API-ключ', h('div', { class: 'link-box' }, h('input', { class: 'input', readonly: true, value: secret, 'aria-label': 'API-ключ', onfocus: (e) => e.target.select() }),
          h('button', { class: 'btn', onclick: async () => {
            try { await navigator.clipboard.writeText(secret); toast('Ключ скопирован'); }
            catch { toast('Не удалось скопировать — выделите ключ и скопируйте вручную', true); }
          } }, 'Копировать')),
        'Заголовок запроса: Authorization: Bearer <ключ>. Права и кампании — как у вашего аккаунта.')),
      footer: [h('button', { class: 'btn primary', onclick: () => close() }, 'Готово')],
    });
  };
  const create = () => {
    let name = '';
    const err = h('p', { class: 'err' });
    const submit = async () => {
      try { const { secret } = await api('/api/keys', { method: 'POST', body: { name } }); close(); showSecret(secret); load(); }
      catch (e) { err.textContent = ({ invalid_key_name: 'Укажите название до 60 символов.' })[e.message] || 'Ошибка: ' + e.message; }
    };
    const close = openModal({
      title: 'Новый API-ключ',
      body: h('div', {},
        field('Название', h('input', { class: 'input', maxlength: 60, autocomplete: 'off', placeholder: 'Например: скрипт отчётов', oninput: (e) => { name = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') submit(); } }),
          'Чтобы потом понять, какой ключ где используется.'),
        err),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Отмена'), h('button', { class: 'btn primary', onclick: submit }, 'Создать')],
    });
  };
  const allToggle = owner ? h('label', {}, h('input', { type: 'checkbox', checked: showAll, onchange: (e) => { showAll = e.target.checked; store.set('keys:all', showAll); load(); } }), ' Ключи всей команды') : null;
  put(view, h('div', { class: 'page-head' }, h('h1', {}, 'API-ключи'), h('button', { class: 'btn primary', onclick: create }, 'Создать')),
    h('p', { class: 'muted' }, 'Личные ключи для скриптов и интеграций: Authorization: Bearer umb_… Ключ действует от вашего имени, с вашей ролью и вашими кампаниями.'),
    allToggle ? h('div', { class: 'toolbar' }, allToggle) : null, table);
  async function load() {
    try { table.setRows((await api('/api/keys' + (showAll ? '?all=1' : ''))).keys); }
    catch (e) { toast('Не удалось загрузить ключи: ' + e.message, true); }
  }
  load();
  return () => table.detach();
}

// ---------- trends ----------
async function pageTrends() {
  await loadRefs();
  const COLORS = ['#4d86f0', '#e0496a', '#e8913f', '#3dc98b', '#a25fe0'];
  const METRICS = [
    ['clicks', 'Клики', (p) => p.clicks, false],
    ['uniqueClicks', 'Уник. клики', (p) => p.uniqueClicks, false],
    ['conversions', 'Конверсии', (p) => p.conversions, false],
    ['revenue', 'Доход', (p) => p.revenue, true],
    ['profit', 'Прибыль', (p) => p.revenue - p.cost, true],
    ['cr', 'CR', (p) => (p.clicks ? p.conversions / p.clicks : 0), false],
  ];
  let mode = store.get('trends:mode', 'campaign');
  let selections = store.get('trends:sel:' + mode, []);
  let metric = store.get('trends:metric', 'clicks');
  const selList = h('div', { class: 'toolbar trends-sel', style: 'margin:0;flex-wrap:wrap;gap:4px;align-items:center' });
  function getItems() { return mode === 'campaign' ? state.campaigns : state.offers; }
  function getLabel(id) { return mode === 'campaign' ? (state.campaigns[id]?.name || id) : id; }
  function renderSelections() {
    const items = getItems();
    selections = selections.filter((id) => id in items);
    store.set('trends:sel:' + mode, selections);
    const available = Object.keys(items).filter((id) => !selections.includes(id));
    put(selList,
      selections.map((id, i) => h('span', { class: 'trends-tag', style: `--c:${COLORS[i]}` },
        h('i', { style: `background:${COLORS[i]};width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px` }),
        getLabel(id),
        h('button', { class: 'icon-btn', style: 'font-size:11px;padding:0 2px', 'aria-label': 'Удалить', onclick: () => { selections.splice(i, 1); renderSelections(); load(); } }, '✕'))),
      selections.length < 5 && available.length > 0 ?
        h('select', { class: 'select', 'aria-label': 'Добавить', onchange: (e) => { const v = e.target.value; if (v && !selections.includes(v)) { selections.push(v); renderSelections(); load(); } e.target.value = ''; } },
          h('option', { value: '' }, '+ Добавить ' + (mode === 'campaign' ? 'кампанию' : 'оффер')),
          available.map((id) => h('option', { value: id }, getLabel(id)))) : null);
  }
  const typeSelect = h('select', { class: 'select', 'aria-label': 'Тип', onchange: () => { mode = typeSelect.value; store.set('trends:mode', mode); selections = store.get('trends:sel:' + mode, []); renderSelections(); load(); } },
    h('option', { value: 'campaign', selected: mode === 'campaign' }, 'Кампании'), h('option', { value: 'offer', selected: mode === 'offer' }, 'Офферы'));
  const metricSel = h('select', { class: 'select', 'aria-label': 'Метрика', onchange: () => { metric = metricSel.value; store.set('trends:metric', metric); load(); } },
    METRICS.map(([key, label]) => h('option', { value: key, selected: key === metric }, label)));
  const chartHolder = h('div', { class: 'card', style: 'margin-bottom:14px' });
  const tableHolder = h('div');
  let tblCleanup = null;
  renderSelections();
  put(view,
    h('div', { class: 'page-head' }, h('h1', {}, 'Тренды')),
    h('div', { class: 'toolbar' }, typeSelect, selList, metricSel, periodControl(() => load()), currencyControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻')),
    chartHolder, tableHolder);
  async function load() {
    if (!selections.length) {
      put(chartHolder, h('p', { class: 'muted', style: 'padding:16px' }, 'Выберите до 5 ' + (mode === 'campaign' ? 'кампаний' : 'офферов') + ' для сравнения.'));
      if (tblCleanup) { tblCleanup(); tblCleanup = null; } put(tableHolder, '');
      return;
    }
    const { from, to } = periodRange();
    put(chartHolder, h('p', { class: 'muted', style: 'padding:16px' }, 'Загрузка…'));
    try {
      const allSeries = await Promise.all(selections.map((id) =>
        timeseries({ campaign: mode === 'campaign' ? id : undefined, offer: mode === 'offer' ? id : undefined, from, to })));
      const dateSet = new Set(allSeries.flatMap((s) => s.map((p) => p.key)));
      const dates = [...dateSet].sort();
      const labelOf = (k) => { const ref = allSeries.flat().find((p) => p.key === k); return ref?.label || k.slice(5).split('-').reverse().join('.'); };
      const buckets = dates.map((k) => ({ key: k, label: labelOf(k) }));
      const metricDef = METRICS.find(([k]) => k === metric) || METRICS[0];
      const metricFn = metricDef[2]; const isRight = metricDef[3];
      const chartSeries = selections.map((id, i) => {
        const byDate = new Map(allSeries[i].map((p) => [p.key, p]));
        return { key: id, label: getLabel(id), color: COLORS[i], right: isRight, values: dates.map((d) => { const p = byDate.get(d); return p ? metricFn(p) : 0; }) };
      });
      put(chartHolder, lineChart(chartSeries, buckets));
      if (tblCleanup) { tblCleanup(); tblCleanup = null; }
      const tblRows = dates.map((d) => {
        const row = { id: d };
        for (let i = 0; i < selections.length; i++) { const p = allSeries[i].find((x) => x.key === d); row['s' + i] = p ? metricFn(p) : 0; }
        return row;
      });
      const fmtVal = isRight ? (v) => money(v) : metric === 'cr' ? (v) => pct(v) : (v) => num(v);
      const tbl = dataTable({
        id: 'trends-table', totals: true, rows: tblRows,
        columns: [
          { key: 'id', label: 'Дата', fixed: true, render: (r) => h('span', {}, labelOf(r.id)) },
          ...selections.map((id, i) => ({ key: 's' + i, label: getLabel(id), render: (r) => fmtVal(r['s' + i]) })),
        ],
      });
      tblCleanup = () => tbl.detach();
      put(tableHolder, tbl);
    } catch (e) {
      put(chartHolder, h('p', { class: 'err', style: 'padding:16px' }, 'Ошибка загрузки: ' + e.message));
    }
  }
  load();
  return () => { if (tblCleanup) tblCleanup(); };
}

// ---------- bot log ----------
function pageBotLog(params) {
  const f = { campaign: params.get('campaign') || '' };
  const holder = h('div');
  let table = null;
  const sel = (key, label, options) => h('select', { class: 'select', 'aria-label': label, onchange: (e) => { f[key] = e.target.value; load(); } },
    h('option', { value: '' }, label), options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
  const toolbar = h('div', { class: 'toolbar' });
  put(view, h('h1', {}, 'Лог ботов'), toolbar, holder);
  const REASONS = { user_agent: 'Бот по User-Agent', datacenter: 'Дата-центр' };
  const columns = [
    { key: 'at', label: 'Дата и время', fixed: true, render: (r) => dt(r.at) },
    { key: 'campaign', label: 'Кампания', cls: 'name', render: (r) => h('a', { href: '#/campaigns/' + encodeURIComponent(r.campaign || '') }, state.campaigns[r.campaign]?.name || r.campaign || '—') },
    { key: 'reason', label: 'Причина', render: (r) => REASONS[r.reason] || r.reason || 'Бот по User-Agent' },
    { key: 'isp', label: 'Провайдер' },
    { key: 'userAgent', label: 'User-Agent', cls: 'name' },
    { key: 'ip', label: 'IP' },
    { key: 'offerId', label: 'Оффер', hidden: true },
    { key: 'stream', label: 'Поток', hidden: true },
  ];
  loadRefs().then(() => {
    put(toolbar,
      sel('campaign', 'Все кампании', Object.entries(state.campaigns).map(([id, c]) => [id, c.name || id])),
      periodControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table?.chooser() }, '⚙'));
    load();
  });
  async function load() {
    const next = '#/botlog' + qs(f);
    if (location.hash !== next) history.replaceState(null, '', next);
    try {
      const r = await api('/api/bots' + qs({ ...f, ...periodRange(), limit: 1000 }));
      table?.detach();
      table = dataTable({ id: 'log-botlog', columns, rows: r.bots || [], serverPaging: null, pageSize: 100, empty: 'Ботов за период нет' });
      put(holder, table);
    } catch (e) { put(holder, h('p', { class: 'err' }, 'Ошибка загрузки: ' + e.message)); }
  }
  return () => table?.detach();
}

// ---------- router ----------
let cleanup = null;
async function route() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  const section = parts[0] || 'dashboard';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  document.body.classList.remove('nav-open');
  if (cleanup) { cleanup(); cleanup = null; }
  modals.slice().forEach((close) => close());
  put(view, 'Загрузка…');
  try {
    if (!state.me) { state.me = await (await fetch(BASE + '/api/auth/me')).json(); drawUserBox(); }
    if ((state.me.loginRequired || state.me.setupRequired && state.me.loginRequired) && !state.me.user) return authScreen();
    document.body.classList.remove('auth-mode');
    if (!state.loaded) { await loadRefs(); await loadRates(); state.loaded = true; }
    if (section === 'campaigns' && parts[1]) cleanup = await pageCampaignEditor(decodeURIComponent(parts[1]));
    else if (section === 'campaigns') cleanup = await pageCampaigns();
    else if (section === 'offers') cleanup = await pageOffers();
    else if (section === 'networks') cleanup = await pageNetworks();
    else if (section === 'landings') cleanup = await pageLandings();
    else if (section === 'reports') cleanup = await pageReports(params);
    else if (section === 'clicks' || section === 'conversions') cleanup = pageLog(section, params);
    else if (section === 'trends') cleanup = await pageTrends();
    else if (section === 'botlog') cleanup = pageBotLog(params);
    else if (section === 'sources') cleanup = await pageSources();
    else if (section === 'users') cleanup = await pageUsers();
    else if (section === 'keys') cleanup = await pageKeys();
    else if (section === 'buyers') cleanup = await pageBuyersReport();
    else cleanup = await pageDashboard();
  } catch (e) { put(view, h('p', { class: 'err' }, 'Ошибка: ' + e.message)); }
}
window.addEventListener('hashchange', route);
document.getElementById('menu-toggle').addEventListener('click', () => {
  if (matchMedia('(max-width: 860px)').matches) document.body.classList.toggle('nav-open');
  else document.body.classList.toggle('nav-collapsed');
});
document.getElementById('token-btn').addEventListener('click', () => tokenModal());
if (!location.hash) location.hash = '#/dashboard';
route();
