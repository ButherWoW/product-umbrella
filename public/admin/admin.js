// Umbrella admin UI — layout and workflows modelled on Keitaro, backed by the existing tracker API.
const state = { token: null, offers: {}, campaigns: {}, landings: {}, sources: {} };
// Set by the server when the tracker runs under a path prefix (BASE_PATH, e.g. /umbrella behind nginx).
const BASE = typeof window.UMBRELLA_BASE === 'string' ? window.UMBRELLA_BASE : '';
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
const money = (v) => (Number(v) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money4 = (v) => (Number(v) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
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
}

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
      selectable ? h('td', {}, h('input', { type: 'checkbox', 'aria-label': 'Выбрать', checked: selected.has(r.id),
        onchange: (e) => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); root.dispatchEvent(new Event('selection')); } })) : null,
      cols.map((c) => h('td', { class: [c.num ? 'num' : '', c.cls || ''].join(' '), title: c.tip ? c.tip(r) : null }, c.render ? c.render(r) : (valueOf(c, r) ?? '—')))))
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

// Metric column helpers shared by stats tables.
const metricCols = (opts = {}) => [
  { key: 'clicks', label: 'Клики', num: true, render: (r) => num(r.clicks), total: (rs) => num(sum(rs, 'clicks')) },
  { key: 'conversions', label: 'Конв.', title: 'Конверсии', num: true, render: (r) => num(r.conversions), total: (rs) => num(sum(rs, 'conversions')) },
  { key: 'cr', label: 'CR', title: 'CR — коэффициент конверсии', num: true, value: (r) => ratio(r.conversions, r.clicks), render: (r) => pct(ratio(r.conversions, r.clicks)), total: (rs) => pct(ratio(sum(rs, 'conversions'), sum(rs, 'clicks'))) },
  { key: 'revenue', label: 'Доход', num: true, render: (r) => money(r.revenue), total: (rs) => money(sum(rs, 'revenue')) },
  { key: 'epc', label: 'EPC', title: 'EPC — доход с клика', num: true, value: (r) => ratio(r.revenue, r.clicks), render: (r) => money4(ratio(r.revenue, r.clicks)), total: (rs) => money4(ratio(sum(rs, 'revenue'), sum(rs, 'clicks'))) },
  { key: 'rpm', label: 'RPM', title: 'RPM — доход на 1000 кликов', num: true, hidden: !opts.rpm, value: (r) => ratio(r.revenue * 1000, r.clicks), render: (r) => money(ratio(r.revenue * 1000, r.clicks)), total: (rs) => money(ratio(sum(rs, 'revenue') * 1000, sum(rs, 'clicks'))) },
];
const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const groupRows = (obj) => Object.entries(obj || {}).map(([id, v]) => ({ id, clicks: v.clicks || 0, conversions: v.conversions || 0, revenue: v.revenue || 0, cost: v.cost || 0, lpClicks: v.lpClicks || 0 }));
const trackingUrl = (id) => `${location.origin}${BASE}/r/${encodeURIComponent(id)}`;
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

async function timeseries({ campaign, from, to }) {
  const single = from && from === to;
  const gran = single ? 'hour' : 'day';
  const ts = await api('/stats/timeseries' + qs({ campaign, from, to, granularity: gran }));
  const byKey = new Map(ts.series.map((p) => [String(p.date ?? p.bucket ?? '').slice(0, single ? 13 : 10), p]));
  let keys = [];
  if (single) keys = Array.from({ length: 24 }, (_, i) => `${from}T${String(i).padStart(2, '0')}`);
  else if (from && to) { for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) keys.push(d.toISOString().slice(0, 10)); }
  else keys = [...byKey.keys()].sort();
  return keys.map((k) => ({ key: k, label: single ? k.slice(11) + ':00' : k.slice(5).split('-').reverse().join('.'), clicks: byKey.get(k)?.clicks || 0, conversions: byKey.get(k)?.conversions || 0, revenue: byKey.get(k)?.revenue || 0 }));
}

// ---------- pages ----------
async function pageDashboard() {
  const body = h('div', {}, 'Загрузка…');
  const campSel = h('select', { class: 'select', 'aria-label': 'Кампания', onchange: () => load() }, h('option', { value: '' }, 'Все кампании'),
    Object.entries(state.campaigns).map(([id, c]) => h('option', { value: id }, c.name || id)));
  put(view, h('div', { class: 'page-head' }, h('h1', {}, 'Дашборд'),
    h('div', { class: 'toolbar', style: 'margin:0' }, campSel, periodControl(() => load()), h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'))), body);
  async function load() {
    const { from, to } = periodRange();
    const campaign = campSel.value || null;
    try {
      const [s, series, recent] = await Promise.all([api('/stats' + qs({ from, to, campaign })), timeseries({ campaign, from, to }), api('/api/clicks' + qs({ from, to, campaign, limit: 10 }))]);
      const kpi = (label, value, color) => h('div', { class: 'kpi', style: `background:${color}` }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value));
      const small = (title, id, rows, nameOf, link) => h('div', { class: 'card' }, h('h2', {}, title), dataTable({
        id: 'dash-' + id, pageSize: 10, compact: true, rows: rows.sort((a, b) => b.clicks - a.clicks),
        columns: [{ key: 'id', label: title, fixed: true, cls: 'name', render: (r) => (link ? h('a', { href: link(r) }, nameOf(r)) : nameOf(r)) },
          ...metricCols().filter((c) => ['clicks', 'conversions', 'cr', 'revenue'].includes(c.key))],
      }));
      put(body, 
        h('div', { class: 'kpis' }, kpi('Клики', num(s.clicks), 'var(--k1)'), kpi('Конверсии', num(s.conversions), 'var(--k3)'), kpi('CR', pct(ratio(s.conversions, s.clicks)), 'var(--k2)'),
          kpi('Доход', money(s.revenue), 'var(--k5)'), kpi('EPC', money4(ratio(s.revenue, s.clicks)), 'var(--k6)'), kpi('RPM', money(ratio(s.revenue * 1000, s.clicks)), 'var(--k7)')),
        h('div', { class: 'card', style: 'margin-bottom:14px' }, lineChart([
          { key: 'clicks', label: 'Клики', color: '#4d86f0', values: series.map((p) => p.clicks) },
          { key: 'conversions', label: 'Конв.', color: '#e0496a', values: series.map((p) => p.conversions) },
          { key: 'revenue', label: 'Доход', color: '#e8913f', right: true, values: series.map((p) => p.revenue) },
        ], series)),
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

async function pageCampaigns() {
  const stateFilter = h('select', { class: 'select', 'aria-label': 'Состояние', onchange: () => load() },
    [['', 'Все состояния'], ['active', 'Активные'], ['inactive', 'Неактивные'], ['clicks', 'С кликами']].map(([v, l]) => h('option', { value: v }, l)));
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
      { key: 'streams', label: 'Потоки', num: true, render: (r) => h('a', { href: '#/campaigns/' + encodeURIComponent(r.id) }, r.streams), total: (rs) => num(sum(rs, 'streams')) },
      ...metricCols(),
      { key: 'dailyCap', label: 'Дневной кап', num: true, hidden: true, render: (r) => r.dailyCap ?? '—' },
      { key: 'totalCap', label: 'Общий кап', num: true, hidden: true, render: (r) => r.totalCap ?? '—' },
      { key: 'revenueCap', label: 'Кап дохода', num: true, hidden: true, render: (r) => (r.revenueCap == null ? '—' : money(r.revenueCap)) },
      { key: 'botFilter', label: 'Бот-фильтр', hidden: true, value: (r) => (r.botFilter ? 'да' : 'нет') },
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
    h('div', { class: 'toolbar' }, stateFilter, periodControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table.chooser() }, '⚙')),
    table);
  async function load() {
    try {
      await loadRefs();
      const s = await api('/stats' + qs(periodRange()));
      let rows = Object.entries(state.campaigns).map(([id, c]) => ({ id, ...c, name: c.name || id, streams: (c.streams || []).length,
        clicks: s.byCampaign[id]?.clicks || 0, conversions: s.byCampaign[id]?.conversions || 0, revenue: s.byCampaign[id]?.revenue || 0 }));
      const f = stateFilter.value;
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

function summarizeConditions(c = {}) {
  const parts = [];
  if (c.countries?.length) parts.push('Страны: ' + c.countries.join(', '));
  if (c.devices?.length) parts.push('Устройства: ' + c.devices.join(', '));
  if (c.os?.length) parts.push('ОС: ' + c.os.join(', '));
  if (c.browsers?.length) parts.push('Браузеры: ' + c.browsers.join(', '));
  if (c.languages?.length) parts.push('Языки: ' + c.languages.join(', '));
  return parts.length ? parts.join(c.mode === 'or' ? ' ИЛИ ' : ' · ') : 'Без фильтров';
}

function streamModal(stream, onApply, isNew = false, currentCampaignId = null) {
  const s = structuredClone(stream);
  s.conditions = { countries: [], devices: [], os: [], browsers: [], languages: [], ...(s.conditions || {}) };
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
      field('Страны', h('input', { class: 'input', value: s.conditions.countries.join(', '), placeholder: 'FR, DE, US', oninput: (e) => { s.conditions.countries = splitList(e.target.value).map((x) => x.toUpperCase()); } }), 'ISO-коды через запятую. Без базы GeoIP страна неизвестна и такой фильтр не сработает.'),
      field('Тип устройства', checkGroup(COND.devices, s.conditions.devices, (v) => { s.conditions.devices = v; })),
      field('Операционные системы', checkGroup(COND.os, s.conditions.os, (v) => { s.conditions.os = v; })),
      field('Браузеры', checkGroup(COND.browsers, s.conditions.browsers, (v) => { s.conditions.browsers = v; })),
      field('Языки', h('input', { class: 'input', value: s.conditions.languages.join(', '), placeholder: 'fr, de', oninput: (e) => { s.conditions.languages = splitList(e.target.value).map((x) => x.toLowerCase()); } }), 'Два первых символа Accept-Language.'))],
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
    ? { id: Math.random().toString(36).slice(2, 10), name: '', active: true, dailyCap: null, totalCap: null, revenueCap: null, capUrl: null, geoCapUrl: null, allowGeos: [], allowDevices: [], allowOS: [], allowBrowsers: [], blockedIps: [], allowedIps: [], dedupeWindow: 0, botFilter: false, conversionWindowDays: null, sourceId: null, paramMap: {} }
    : { id, ...structuredClone(src) };
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
    ['Общие', () => h('div', {},
      field('Идентификатор', h('input', { class: 'input', value: d.id, readonly: !isNew, oninput: (e) => { d.id = e.target.value.trim(); mark(); } }), isNew ? 'Латиница, цифры, - и _. После создания не меняется.' : 'Используется в ссылке кампании.'),
      field('Состояние', h('div', { class: 'radios' },
        h('label', {}, h('input', { type: 'radio', name: 'cstate', checked: d.active, onchange: () => { d.active = true; mark(); } }), 'Включена'),
        h('label', {}, h('input', { type: 'radio', name: 'cstate', checked: !d.active, onchange: () => { d.active = false; mark(); } }), 'Выключена'))),
      field('Срок уникальности, минут', h('input', { class: 'input', type: 'number', min: 0, value: d.dedupeWindow || 0, oninput: bind('dedupeWindow', 'int') }), 'Повторный клик с того же IP в этом окне не считается. 0 — выключено.'),
      field('Фильтр ботов', h('label', { class: 'radios' }, h('input', { type: 'checkbox', checked: d.botFilter, onchange: (e) => { d.botFilter = e.target.checked; mark(); } }), 'Не считать клики ботов'), 'Боты уходят на тот же оффер, но не попадают в статистику.'),
      field('Способ редиректа', h('div', { class: 'radios' }, [['http', 'HTTP 302'], ['meta', 'Meta refresh'], ['js', 'JavaScript']].map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'credir', checked: (d.redirectMethod || 'http') === v, onchange: () => { d.redirectMethod = v; mark(); } }), l))),
        'Как посетитель уходит на оффер. HTTP 302 — быстрее всего; meta и JS отдают страницу, которая сама переходит дальше.'),
      field('Окно конверсии, дней', h('input', { class: 'input', type: 'number', min: 1, max: 365, value: d.conversionWindowDays ?? '', placeholder: 'без ограничения', oninput: bind('conversionWindowDays', 'int') }), 'Постбэк на клик старше окна отклоняется.'),
      field('Источник трафика', h('select', { class: 'select', 'aria-label': 'Источник трафика', onchange: (e) => {
        const sid = e.target.value; d.sourceId = sid || null;
        if (sid && state.sources[sid]?.paramMap) d.paramMap = { ...state.sources[sid].paramMap };
        mark();
      } }, h('option', { value: '' }, 'Без источника'), Object.entries(state.sources).map(([sid, s]) => h('option', { value: sid, selected: (d.sourceId || '') === sid }, s.name || sid))),
      'При выборе источника его параметры копируются в кампанию.'))],
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
      field('Дневной кап дохода', h('input', { class: 'input', type: 'number', min: 0, step: '0.01', value: d.revenueCap ?? '', placeholder: 'нет', oninput: bind('revenueCap', 'float') })),
      field('URL при достижении капа', h('input', { class: 'input', type: 'url', value: d.capUrl || '', placeholder: 'https://… (иначе ответ 429)', oninput: bind('capUrl', 'url') })))],
    ['Tracking', () => isNew ? h('p', { class: 'muted' }, 'Ссылка кампании будет доступна после её сохранения.') : h('div', {},
      field('Ссылка кампании', h('div', { class: 'link-box' }, h('input', { class: 'input', readonly: true, value: trackingUrl(d.id) }), h('button', { class: 'btn', onclick: () => copyText(trackingUrl(d.id)) }, 'Копировать')), 'Добавьте ?subid=… и utm-метки, они передадутся в оффер.'),
      field('Ссылка на конкретный оффер', h('input', { class: 'input', readonly: true, value: trackingUrl(d.id) + '/{offer_id}' })),
      field('S2S постбэк для партнёрки', h('input', { class: 'input', readonly: true, value: `${location.origin}${BASE}/postback?click_id={click_id}&secret=POSTBACK_SECRET&revenue={payout}&currency=EUR` }), 'Замените POSTBACK_SECRET и макросы партнёрки на свои.'),
      h('p', { class: 'muted' }, 'Макросы в URL оффера: {click_id} {subid} {campaign} {offer_id} {device} {country}.'))],
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
    const body = { name: d.name.trim(), active: d.active, streams: d.streams, dailyCap: d.dailyCap, totalCap: d.totalCap, revenueCap: d.revenueCap, capUrl: d.capUrl, geoCapUrl: d.geoCapUrl,
      allowGeos: d.allowGeos, allowDevices: d.allowDevices, allowOS: d.allowOS, allowBrowsers: d.allowBrowsers, blockedIps: d.blockedIps, allowedIps: d.allowedIps,
      dedupeWindow: d.dedupeWindow || 0, botFilter: d.botFilter, conversionWindowDays: d.conversionWindowDays, redirectMethod: d.redirectMethod || 'http', sourceId: d.sourceId || null, ...(d.paramMap && Object.keys(d.paramMap).length ? { paramMap: d.paramMap } : {}) };
    saveBtn.disabled = true;
    try {
      const saved = isNew ? await api('/api/campaigns', { method: 'POST', body: { id: d.id, ...body } })
        : await api('/api/campaigns/' + encodeURIComponent(d.id), { method: 'PATCH', body });
      if ((saved.streams || []).length !== d.streams.length) toast('Часть потоков отклонена сервером — проверьте офферы и веса.', true);
      else toast(isNew ? 'Кампания создана' : 'Сохранено');
      dirty = false;
      if (isNew) location.hash = '#/campaigns/' + encodeURIComponent(d.id);
      else { await loadRefs(); saveBtn.textContent = 'Сохранить'; }
    } catch (e) { err.textContent = 'Не сохранено: ' + e.message; }
    finally { saveBtn.disabled = false; }
  }

  put(view, 
    h('div', { class: 'editor-head' }, nameInput,
      h('div', { class: 'toolbar', style: 'margin:0' }, saveBtn,
        h('button', { class: 'btn square', title: 'Копировать ссылку', 'aria-label': 'Копировать ссылку', disabled: isNew, onclick: () => copyText(trackingUrl(d.id)) }, '🔗'),
        isNew ? null : h('a', { class: 'btn', href: '#/clicks' + qs({ campaign: d.id }) }, 'Лог'),
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
  const o = isNew ? { id: '', name: '', url: '', postbackUrl: '', dailyCap: '' } : { id, ...state.offers[id], name: state.offers[id].name || '', postbackUrl: state.offers[id].postbackUrl || '', dailyCap: state.offers[id].dailyCap ?? '' };
  const err = h('p', { class: 'err' });
  const body = tabs([
    ['Основные', () => h('div', {},
      field('ID оффера', h('input', { class: 'input', value: o.id, readonly: !isNew, oninput: (e) => { o.id = e.target.value.trim(); } }), isNew ? 'Латиница, цифры, - и _.' : null),
      field('Название', h('input', { class: 'input', value: o.name, maxlength: 200, oninput: (e) => { o.name = e.target.value; } })),
      field('URL', h('input', { class: 'input', type: 'url', value: o.url, placeholder: 'https://…', oninput: (e) => { o.url = e.target.value.trim(); } }), 'Макросы: {click_id} {subid} {campaign} {offer_id} {device} {country}. Если {click_id} нет — click_id добавится параметром.'))],
    ['Настройки', () => h('div', {},
      field('Дневной кап кликов', h('input', { class: 'input', type: 'number', min: 1, value: o.dailyCap, placeholder: 'нет', oninput: (e) => { o.dailyCap = e.target.value; } }), 'Считается по всем кампаниям; в потоках капнутый оффер пропускается.'),
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
      if (isNew && state.offers[o.id]) { err.textContent = 'Оффер с таким ID уже есть.'; return; }
      try {
        const body2 = { name: o.name.trim() || null, url: o.url, postbackUrl: o.postbackUrl || null, dailyCap: cap };
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
    h('div', { class: 'toolbar' }, periodControl(() => load()),
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

async function pageOffers() {
  const table = dataTable({
    id: 'offers', pageSize: 250,
    columns: [
      { key: 'id', label: 'ID', fixed: true, render: (r) => h('a', { href: '#/offers', onclick: (e) => { e.preventDefault(); offerModal(r.id, load); } }, r.id) },
      { key: 'menu', label: '', title: 'Меню', sortable: false, value: () => '', render: (r) => h('span', { class: 'row-actions' },
        h('button', { title: 'Изменить', 'aria-label': 'Изменить', onclick: () => offerModal(r.id, load) }, '✎'),
        h('a', { href: '#/reports' + qs({ group: 'country', offer: r.id }), title: 'Отчёт', 'aria-label': 'Отчёт' }, '▥'),
        h('a', { href: '#/clicks' + qs({ offer: r.id }), title: 'Лог кликов', 'aria-label': 'Лог кликов' }, '☰')) },
      { key: 'name', label: 'Название', cls: 'name', value: (r) => r.name || '', render: (r) => h('span', { title: r.name || '' }, r.name || '—') },
      { key: 'url', label: 'URL', cls: 'name', hidden: true, render: (r) => h('span', { title: r.url }, r.url) },
      { key: 's2s', label: 'S2S', value: (r) => (r.postbackUrl ? 'да' : 'нет') },
      { key: 'dailyCap', label: 'Дневной кап', num: true, render: (r) => r.dailyCap ?? '—' },
      ...metricCols(),
    ],
  });
  put(view, 
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: () => offerModal(null, load) }, 'Создать')),
    h('div', { class: 'toolbar' }, periodControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table.chooser() }, '⚙')),
    table);
  async function load() {
    try {
      await loadRefs();
      const s = await api('/stats' + qs(periodRange()));
      table.setRows(Object.entries(state.offers).map(([id, o]) => ({ id, ...o, clicks: s.byOffer[id]?.clicks || 0, conversions: s.byOffer[id]?.conversions || 0, revenue: s.byOffer[id]?.revenue || 0 })));
    } catch (e) { toast('Ошибка загрузки офферов: ' + e.message, true); }
  }
  load();
  return () => table.detach();
}

const GROUPS = [
  ['campaign', 'Кампания', 'byCampaign'], ['offer', 'Оффер', 'byOffer'], ['stream', 'Поток', 'byStream'], ['landing', 'Лендинг', 'byLanding'], ['country', 'Страна', 'byCountry'],
  ['day', 'День', null], ['hour', 'Час', null], ['referrer', 'Реферер', null], ['path', 'Путь', null],
];
async function pageReports(params) {
  await loadRefs();
  const f = { group: params.get('group') || 'campaign', campaign: params.get('campaign') || '', offer: params.get('offer') || '', country: params.get('country') || '', stream: params.get('stream') || '', subid: params.get('subid') || '' };
  const note = h('p', { class: 'muted' });
  const holder = h('div');
  let table = null;
  const sync = () => { const next = '#/reports' + qs(f); if (location.hash !== next) history.replaceState(null, '', next); };
  const presets = h('div', { class: 'toolbar' });
  const drawPresets = () => put(presets, GROUPS.map(([k, l]) => h('button', { class: 'chip-btn' + (f.group === k ? ' on' : ''), onclick: () => { f.group = k; drawPresets(); load(); } }, l)));
  drawPresets();
  const sel = (key, label, options) => h('select', { class: 'select', 'aria-label': label, onchange: (e) => { f[key] = e.target.value; load(); } },
    h('option', { value: '' }, label), options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
  const txt = (key, label) => h('input', { class: 'input', value: f[key], placeholder: label, 'aria-label': label, style: 'width:130px', onchange: (e) => { f[key] = e.target.value.trim(); load(); } });
  put(view, h('h1', {}, 'Отчёт'), presets,
    h('div', { class: 'toolbar' },
      sel('campaign', 'Все кампании', Object.entries(state.campaigns).map(([id, c]) => [id, c.name || id])),
      sel('offer', 'Все офферы', Object.keys(state.offers).map((id) => [id, id])),
      txt('country', 'Страна'), txt('stream', 'Поток'), txt('subid', 'Sub ID'),
      periodControl(() => load()),
      h('button', { class: 'btn square', title: 'Обновить', 'aria-label': 'Обновить', onclick: () => load() }, '↻'),
      h('button', { class: 'btn square', title: 'Колонки', 'aria-label': 'Колонки', onclick: () => table?.chooser() }, '⚙')),
    note, holder);

  async function load() {
    sync();
    const { from, to } = periodRange();
    const [key, label, prop] = GROUPS.find((g) => g[0] === f.group) || GROUPS[0];
    try {
      let rows; let drill = null;
      note.textContent = '';
      if (prop) {
        const s = await api('/stats' + qs({ from, to, campaign: f.campaign, offer: f.offer, country: f.country, stream: f.stream, subid: f.subid }));
        rows = groupRows(s[prop]);
        if (key === 'campaign') drill = (r) => ({ group: 'stream', campaign: r.id });
        if (key === 'offer') drill = (r) => ({ group: 'country', offer: r.id });
        if (key === 'stream') drill = (r) => ({ group: 'offer', stream: r.id });
      } else if (key === 'day' || key === 'hour') {
        const ts = await api('/stats/timeseries' + qs({ campaign: f.campaign, from, to, granularity: key }));
        rows = ts.series.map((p) => ({ id: String(p.date ?? p.bucket).replace('T', ' ') + (key === 'hour' ? ':00' : ''), clicks: p.clicks || 0, conversions: p.conversions || 0, revenue: p.revenue || 0 }));
        if (f.offer || f.country || f.stream || f.subid) note.textContent = 'Для группировки по времени применяются только кампания и период.';
      } else {
        const r = await api(`/stats/${key === 'referrer' ? 'referrers' : 'paths'}` + qs({ campaign: f.campaign, limit: 100 }));
        rows = (r.referrers || r.paths || []).map((x) => ({ id: x.referrer ?? x.path ?? '—', clicks: x.clicks || 0, conversions: 0, revenue: 0 }));
        note.textContent = 'Рефереры и пути считаются за всё время, применяется только фильтр кампании; конверсии здесь не считаются.';
      }
      const nameOf = (r) => (key === 'campaign' ? state.campaigns[r.id]?.name || r.id : key === 'landing' ? (r.id === 'none' ? '(без лендинга)' : state.landings[r.id]?.name || r.id) : r.id);
      table?.detach();
      table = dataTable({
        id: 'report-' + key, pageSize: 100,
        rows,
        columns: [{ key: 'id', label, fixed: true, cls: 'name', value: nameOf, render: (r) => (drill ? h('a', { href: '#/reports' + qs({ ...f, ...drill(r) }), title: 'Детализировать' }, nameOf(r)) : nameOf(r)) },
          ...metricCols({ rpm: true })],
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
  ] : [
    { key: 'at', label: 'Дата и время', fixed: true, render: (r) => dt(r.at) },
    { key: 'id', label: 'Click ID', cls: 'mono', render: (r) => h('span', { title: r.id }, r.id.slice(0, 13) + '…') },
    { key: 'campaign', label: 'Кампания', cls: 'name', render: (r) => h('a', { href: '#/campaigns/' + encodeURIComponent(r.campaign) }, state.campaigns[r.campaign]?.name || r.campaign) },
    { key: 'stream', label: 'Поток' }, { key: 'offerId', label: 'Оффер' },
    { key: 'revenue', label: 'Доход', num: true, render: (r) => (r.revenue == null ? '—' : money(r.revenue)), total: (rs) => money(sum(rs, 'revenue')) },
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
  put(view, h('div', { class: 'page-head' }, h('h1', {}, 'Пользователи'), h('button', { class: 'btn primary', onclick: create }, 'Создать')),
    h('p', { class: 'muted' }, 'Собственная база пользователей Umbrella, не связанная с другими проектами на домене.'), table);
  async function load() {
    try { table.setRows((await api('/api/users')).users); }
    catch (e) { toast('Не удалось загрузить пользователей: ' + e.message, true); }
  }
  load();
  return () => table.detach();
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
    if (!state.loaded) { await loadRefs(); state.loaded = true; }
    if (section === 'campaigns' && parts[1]) cleanup = await pageCampaignEditor(decodeURIComponent(parts[1]));
    else if (section === 'campaigns') cleanup = await pageCampaigns();
    else if (section === 'offers') cleanup = await pageOffers();
    else if (section === 'landings') cleanup = await pageLandings();
    else if (section === 'reports') cleanup = await pageReports(params);
    else if (section === 'clicks' || section === 'conversions') cleanup = pageLog(section, params);
    else if (section === 'sources') cleanup = await pageSources();
    else if (section === 'users') cleanup = await pageUsers();
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
