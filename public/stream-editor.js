// Browser-only editor. All user values enter the DOM through textContent/value.
const host = document.querySelector('#stream-editor');
const state = { campaigns: {}, offers: {}, rows: [], token: '', campaign: '', dirty: false };

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(text, action) {
  const item = element('button', text);
  item.type = 'button';
  item.addEventListener('click', action);
  return item;
}

function field(label, input) {
  const wrap = element('label');
  input.setAttribute('aria-label', label);
  wrap.append(element('span', label), input);
  return wrap;
}

function input(value, onInput, type = 'text') {
  const item = element('input');
  item.type = type;
  item.value = value;
  item.addEventListener('input', () => { onInput(item.value); state.dirty = true; });
  return item;
}

function select(options, value, onChange) {
  const item = element('select');
  for (const [key, text] of options) {
    const option = element('option', text);
    option.value = key;
    item.append(option);
  }
  item.value = value;
  item.addEventListener('change', () => onChange(item.value));
  return item;
}

async function request(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) };
  const response = await fetch(path, { ...options, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(response.status === 401
    ? 'Для сохранения укажите административный токен.' : body.error || 'Ошибка запроса');
  return body;
}

function loadRows() {
  state.rows = (state.campaigns[state.campaign]?.streams || []).map((stream) => ({
    name: stream.name || '', type: stream.type || 'regular', weight: stream.weight ?? 1,
    conditions: { ...(stream.conditions || {}) },
    offers: (stream.offers || [{ offerId: stream.offerId, weight: 1 }]).map((offer) => ({ ...offer })),
  }));
  state.dirty = false;
}

const CONDITIONS = [
  ['countries', 'Страны: US, DE'], ['devices', 'Устройства: mobile, tablet, desktop'],
  ['os', 'ОС: android, ios, windows, macos, linux, other'],
  ['browsers', 'Браузеры: chrome, safari, firefox, edge, opera, samsung, other'],
  ['languages', 'Языки: ru, en'],
];

function streamCard(row, index) {
  const card = element('fieldset');
  card.append(element('legend', `Поток ${index + 1}`));
  const line = element('div', undefined, 'editor-row');
  line.append(field('Название', input(row.name, (value) => { row.name = value; })),
    field('Тип', select([['forced', 'Приоритетный'], ['regular', 'Обычный'], ['fallback', 'Резервный']], row.type,
      (value) => { row.type = value; state.dirty = true; })),
    field('Вес потока', input(row.weight, (value) => { row.weight = Number(value); }, 'number')),
    button('Убрать поток', () => { state.rows.splice(index, 1); state.dirty = true; render(); }));
  card.append(line);
  const details = element('details');
  details.append(element('summary', 'Условия отбора — пустые поля подходят всем'));
  const conditions = element('div', undefined, 'editor-grid');
  for (const [key, label] of CONDITIONS) conditions.append(field(label,
    input((row.conditions[key] || []).join(', '), (value) => {
      row.conditions[key] = value.split(',').map((part) => part.trim()).filter(Boolean);
    })));
  details.append(conditions);
  card.append(details, element('p', 'Офферы и их веса'));
  for (const [offerIndex, offer] of row.offers.entries()) {
    const item = element('div', undefined, 'editor-row');
    const options = Object.keys(state.offers).map((id) => [id, id]);
    if (offer.offerId && !state.offers[offer.offerId]) options.unshift([offer.offerId, `${offer.offerId} (не найден)`]);
    item.append(field('Оффер', select(options, offer.offerId, (value) => { offer.offerId = value; state.dirty = true; })),
      field('Вес оффера', input(offer.weight ?? 1, (value) => { offer.weight = Number(value); }, 'number')),
      button('Убрать оффер', () => { row.offers.splice(offerIndex, 1); state.dirty = true; render(); }));
    card.append(item);
  }
  card.append(button('+ Оффер', () => {
    row.offers.push({ offerId: Object.keys(state.offers)[0] || '', weight: 1 });
    state.dirty = true;
    render();
  }));
  return card;
}

function validate() {
  if (state.rows.length > 20) throw new Error('Можно сохранить до 20 потоков.');
  for (const [index, row] of state.rows.entries()) {
    if (row.name.length > 60) throw new Error(`Поток ${index + 1}: название длиннее 60 символов.`);
    if (!Number.isFinite(row.weight) || row.weight <= 0) throw new Error(`Поток ${index + 1}: вес должен быть больше нуля.`);
    if (!row.offers.length || row.offers.length > 20) throw new Error(`Поток ${index + 1}: нужен 1–20 офферов.`);
    for (const offer of row.offers) if (!state.offers[offer.offerId] || !Number.isFinite(offer.weight) || offer.weight <= 0)
      throw new Error(`Поток ${index + 1}: выберите существующий оффер с положительным весом.`);
    const valid = {
      countries: (v) => /^[A-Za-z]{2}$/.test(v), languages: (v) => /^[A-Za-z]{2}$/.test(v),
      devices: (v) => ['mobile', 'tablet', 'desktop'].includes(v.toLowerCase()),
      os: (v) => ['android', 'ios', 'windows', 'macos', 'linux', 'other'].includes(v.toLowerCase()),
      browsers: (v) => ['chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung', 'other'].includes(v.toLowerCase()),
    };
    for (const [key, values] of Object.entries(row.conditions)) if (valid[key] && values.some((value) => !valid[key](value)))
      throw new Error(`Поток ${index + 1}: проверьте поле ${key}.`);
  }
}

function render(message = '') {
  host.replaceChildren(element('h2', 'Редактор потоков'));
  const status = element('p', message);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const picker = select(Object.keys(state.campaigns).map((id) => [id, `${state.campaigns[id].name} (${id})`]),
    state.campaign, (value) => {
      if (state.dirty) { picker.value = state.campaign; status.textContent = 'Сохраните изменения или нажмите «Отменить изменения».'; return; }
      state.campaign = value; loadRows(); render();
    });
  const controls = element('div', undefined, 'editor-row');
  controls.append(field('Кампания', picker), button('Обновить список', async () => {
    if (state.dirty) { status.textContent = 'Сначала сохраните или отмените изменения.'; return; }
    await refresh();
  }));
  host.append(controls, status);
  if (!state.campaign) { status.textContent = 'Сначала создайте кампанию в панели выше.'; return; }
  host.append(element('p', 'Приоритетный → подходящие обычные по весу → резервный. Порядок потоков сохраняется.'));
  const link = element('a', `${location.origin}/r/${state.campaign}`);
  link.href = `/r/${encodeURIComponent(state.campaign)}`;
  link.target = '_blank'; link.rel = 'noopener';
  host.append(element('p', 'Tracking-ссылка:'), link);
  state.rows.forEach((row, index) => host.append(streamCard(row, index)));
  const actions = element('div', undefined, 'editor-row');
  actions.append(button('+ Поток', () => {
    if (state.rows.length >= 20) { status.textContent = 'Достигнут лимит 20 потоков.'; return; }
    state.rows.push({ name: '', type: 'regular', weight: 1, conditions: {},
      offers: [{ offerId: Object.keys(state.offers)[0] || '', weight: 1 }] });
    state.dirty = true; render();
  }), button('Отменить изменения', () => { loadRows(); render('Изменения отменены.'); }));
  const auth = element('details');
  auth.append(element('summary', 'Административный токен (если включён)'));
  const tokenInput = input(state.token, (value) => { state.token = value; }, 'password');
  tokenInput.autocomplete = 'off';
  auth.append(field('Токен хранится только до перезагрузки страницы', tokenInput));
  host.append(actions, auth);
  const save = button('Сохранить потоки', async () => {
    try {
      validate();
      save.disabled = true;
      picker.disabled = true;
      const campaignId = state.campaign;
      const result = await request(`/api/campaigns/${encodeURIComponent(campaignId)}/streams`,
        { method: 'PUT', body: JSON.stringify({ streams: state.rows }) });
      state.campaigns[campaignId].streams = result.streams;
      if (state.campaign === campaignId) { loadRows(); render('Потоки сохранены.'); }
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; picker.disabled = false; }
  });
  host.append(save);
}

async function refresh() {
  try {
    const [campaigns, offers] = await Promise.all([request('/api/campaigns'), request('/api/offers')]);
    state.campaigns = campaigns.campaigns;
    state.offers = offers.offers;
    if (!state.campaigns[state.campaign]) state.campaign = Object.keys(state.campaigns)[0] || '';
    loadRows(); render();
  } catch (error) { host.replaceChildren(element('p', `Редактор не загрузился: ${error.message}`), button('Повторить', refresh)); }
}

if (host) refresh();
