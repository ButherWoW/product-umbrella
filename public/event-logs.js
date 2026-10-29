const host = document.querySelector('#event-logs');

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function field(label, control) {
  control.setAttribute('aria-label', label);
  const wrap = node('label');
  wrap.append(node('span', label), control);
  return wrap;
}

function option(select, value, title) {
  const item = node('option', title);
  item.value = value;
  select.append(item);
}

async function mount() {
  const state = { kind: 'clicks', offset: 0, limit: 25, filters: {}, sequence: 0, controller: null };
  host.append(node('h2', 'Журнал событий'), node('p', 'Клики и конверсии. Фильтры дат используют полные дни UTC.', 'muted'));
  const tabs = node('div', undefined, 'log-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Вид журнала');
  const tabButtons = [];
  for (const [key, title] of [['clicks', 'Клики'], ['conversions', 'Конверсии']]) {
    const button = node('button', title);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(key === state.kind));
    button.addEventListener('click', () => {
      state.kind = key; state.offset = 0;
      for (const [otherKey, otherButton] of tabButtons) otherButton.setAttribute('aria-selected', String(key === otherKey));
      load();
    });
    tabButtons.push([key, button]); tabs.append(button);
  }
  host.append(tabs);
  const form = node('form', undefined, 'log-filters');
  const controls = {};
  for (const [key, title] of [['campaign', 'Кампания журнала'], ['offer', 'Оффер журнала']]) {
    const select = node('select'); select.name = key;
    option(select, '', 'Все'); controls[key] = select;
    form.append(field(title, select));
  }
  for (const [key, title] of [['stream', 'Поток журнала'], ['from', 'С даты (UTC)'], ['to', 'По дату (UTC)']]) {
    const input = node('input'); input.name = key; input.type = key === 'stream' ? 'text' : 'date';
    input.maxLength = 120; controls[key] = input;
    if (key === 'stream') input.placeholder = 'Имя или default';
    form.append(field(title, input));
  }
  const limit = node('select');
  for (const value of [25, 50, 100]) option(limit, String(value), String(value));
  limit.value = String(state.limit);
  form.append(field('Строк на странице', limit));
  const apply = node('button', 'Применить к журналу'); apply.type = 'submit'; form.append(apply);
  const reset = node('button', 'Сбросить фильтры журнала'); reset.type = 'button';
  reset.addEventListener('click', () => {
    for (const control of Object.values(controls)) control.value = '';
    state.filters = {}; state.offset = 0; load();
  });
  form.append(reset);
  const refresh = node('button', 'Обновить журнал'); refresh.type = 'button';
  refresh.addEventListener('click', () => { choices(); load(); });
  form.append(refresh);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    state.filters = Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value]).filter(([, value]) => value));
    state.limit = Number(limit.value); state.offset = 0; load();
  });
  host.append(form);
  const auth = node('details');
  auth.append(node('summary', 'Доступ к журналу'));
  const token = node('input'); token.type = 'password'; token.autocomplete = 'off';
  token.setAttribute('aria-label', 'Административный токен журнала');
  auth.append(field('Административный токен журнала', token), node('small', 'Хранится только в памяти страницы.'));
  host.append(auth);
  const status = node('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const table = node('div', undefined, 'log-table-wrap');
  const pager = node('div', undefined, 'log-pager');
  const previous = node('button', 'Предыдущая страница журнала'); previous.type = 'button';
  const next = node('button', 'Следующая страница журнала'); next.type = 'button';
  const pageLabel = node('span');
  previous.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
  next.addEventListener('click', () => { state.offset += state.limit; load(); });
  pager.append(previous, pageLabel, next);
  host.append(status, table, pager);

  function rowsTable(rows) {
    const result = node('table');
    const head = node('thead'), header = node('tr');
    const columns = [['at', 'Время'], ['clickId', 'Click ID'], ['campaign', 'Кампания'], ['offerId', 'Оффер'], ['stream', 'Поток']];
    columns.push(...(state.kind === 'clicks' ? [['country', 'Страна'], ['subid', 'Sub-ID'], ['details', 'Детали']]
      : [['revenue', 'Revenue'], ['currency', 'Валюта']]));
    for (const [, title] of columns) { const cell = node('th', title); cell.scope = 'col'; header.append(cell); }
    head.append(header); result.append(head);
    const body = node('tbody');
    for (const row of rows) {
      const tr = node('tr');
      for (const [key] of columns) {
        const td = node('td');
        if (key === 'details') {
          const details = node('details'); details.append(node('summary', 'Показать'));
          for (const [field, title] of [['ip', 'IP'], ['path', 'Путь'], ['referrer', 'Реферер'], ['userAgent', 'User-Agent']])
            details.append(node('p', `${title}: ${row[field] ?? '—'}`));
          td.append(details);
        } else if (key === 'at') {
          const value = row.at ? new Date(row.at) : null;
          td.textContent = value && Number.isFinite(value.getTime()) ? value.toLocaleString('ru-RU') : '—';
          td.title = row.at || '';
        } else td.textContent = row[key] === null || row[key] === undefined ? '—' : String(row[key]);
        tr.append(td);
      }
      body.append(tr);
    }
    if (!rows.length) {
      const tr = node('tr'), td = node('td', 'Нет событий по выбранным условиям.');
      td.colSpan = columns.length; tr.append(td); body.append(tr);
    }
    result.append(body);
    return result;
  }

  async function load() {
    const sequence = ++state.sequence;
    state.controller?.abort(); state.controller = new AbortController();
    previous.disabled = true; next.disabled = true;
    table.setAttribute('aria-busy', 'true');
    status.textContent = 'Загрузка журнала…';
    const params = new URLSearchParams({ ...state.filters, limit: String(state.limit), offset: String(state.offset) });
    try {
      const response = await fetch(`/api/${state.kind}?${params}`, {
        signal: state.controller.signal,
        headers: token.value ? { authorization: `Bearer ${token.value}` } : {},
      });
      const data = await response.json();
      if (sequence !== state.sequence) return;
      if (!response.ok) {
        if (response.status === 401) { auth.open = true; throw new Error('Укажите административный токен и нажмите «Применить к журналу».'); }
        throw new Error(data.error === 'invalid_date_range' ? 'Дата начала должна быть не позже даты окончания.' : `Ошибка: ${data.error || response.status}`);
      }
      const rows = data[state.kind];
      table.replaceChildren(rowsTable(rows));
      status.textContent = `${state.kind === 'clicks' ? 'Кликов' : 'Конверсий'} на странице: ${rows.length}`;
      pageLabel.textContent = `Страница ${Math.floor(state.offset / state.limit) + 1}`;
      previous.disabled = state.offset === 0;
      next.disabled = !data.hasMore;
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== state.sequence) return;
      status.textContent = error.message;
      table.replaceChildren(); pageLabel.textContent = '';
    } finally {
      if (sequence === state.sequence) table.setAttribute('aria-busy', 'false');
    }
  }

  // Lists are independently reloadable without losing the selected log filters.
  async function choices() {
    try {
      const [campaigns, offers] = await Promise.all([fetch('/api/campaigns').then((r) => r.json()), fetch('/api/offers').then((r) => r.json())]);
      for (const [key, values] of [['campaign', campaigns.campaigns], ['offer', offers.offers]]) {
        const selected = controls[key].value;
        controls[key].replaceChildren(); option(controls[key], '', 'Все');
        for (const id of Object.keys(values)) option(controls[key], id, id);
        controls[key].value = selected;
      }
    } catch { /* Typed date/stream filters and reload still work if lists cannot load. */ }
  }
  await Promise.all([choices(), load()]);
}

if (host) mount();
