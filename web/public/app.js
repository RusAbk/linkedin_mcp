const $ = selector => document.querySelector(selector);
let csrf = '', currentUser = null, mcpUrl = '', personalToken = '', frame = null, timer = null, polling = false;
let browserQueue = Promise.resolve();
function notice(message, error = false) { $('#notice').hidden = false; $('#notice').textContent = message; $('#notice').classList.toggle('error', error); }
function clearBrowser() { clearTimeout(timer); polling = false; frame = null; $('#browser-panel').hidden = true; $('#browser-image').removeAttribute('src'); $('#browser-text-form').reset(); }
function leave() { csrf = ''; currentUser = null; personalToken = ''; clearBrowser(); $('#configuration').hidden = true; $('#config-json').textContent = ''; $('#mcp-token').value = ''; $('#workspace').hidden = true; $('#login-view').hidden = false; $('#users-list').replaceChildren(); }
async function api(path, data) {
  const response = await fetch(`/api/${path}`, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const payload = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== 'login') leave(); throw new Error(`${payload.error?.code ?? response.status}: ${payload.error?.message ?? 'Ошибка запроса'}`); }
  return payload.data;
}
async function enter(data) { csrf = data.csrf; currentUser = data.user; mcpUrl = data.mcpUrl; $('#username').textContent = currentUser.username; $('#mcp-url').value = mcpUrl; $('#linkedin-state').textContent = 'Подключение не проверено'; $('#notice').hidden = true; $('#action-mode').textContent = currentUser.action_mode === 'execute' ? 'Агент может отправлять сообщения и приглашения с commit=true.' : 'Для вашего аккаунта включён предпросмотр. Отправки разрешает администратор.'; $('#workspace').hidden = false; $('#login-view').hidden = true; $('#admin-panel').hidden = currentUser.role !== 'admin'; if (currentUser.role === 'admin') await users(); }
function bind(element, event, fn) { element.addEventListener(event, e => { e.preventDefault(); Promise.resolve().then(() => fn(e)).catch(error => notice(error.message, true)); }); }
async function busy(button, fn) { button.disabled = true; try { return await fn(); } finally { button.disabled = false; } }
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function serialBrowser(fn) { const operation = browserQueue.then(fn); browserQueue = operation.catch(() => {}); return operation; }
async function refreshFrame() {
  const result = await api('linkedin/frame');
  if (!polling) return;
  frame = result;
  if (result.complete) { clearBrowser(); notice('Вход завершён. Проверяю доступ к Sales Navigator…'); await status(); return; }
  $('#browser-image').src = `data:image/jpeg;base64,${result.image}`; $('#browser-url').textContent = result.url;
}
async function poll() { if (!polling) return; try { await serialBrowser(refreshFrame); } catch (error) { polling = false; notice(error.message, true); } if (polling) timer = setTimeout(poll, 1600); }
async function input(value) { return serialBrowser(async () => { await api('linkedin/input', value); if (polling) await refreshFrame(); }); }
async function status() { const result = await api('linkedin/status', {}); $('#linkedin-state').textContent = { authenticated: 'LinkedIn и Sales Navigator подключены', auth_required: 'Нужен вход в LinkedIn', challenge_required: 'Нужна проверка LinkedIn', unavailable: 'Sales Navigator недоступен' }[result.state] ?? result.state; if (result.state === 'authenticated') notice('Сессия сохранена. Теперь создайте MCP-ключ и подключите агента.'); }
bind($('#login-form'), 'submit', () => busy($('#login-form button'), async () => { try { await enter(await api('login', { username: $('#login-form').elements.username.value, password: $('#login-form').elements.password.value })); $('#login-form').reset(); $('#login-error').textContent = ''; } catch (error) { $('#login-error').textContent = error.message; } }));
bind($('#logout'), 'click', async () => { await api('logout', {}); leave(); });
bind($('#open-linkedin'), 'click', () => busy($('#open-linkedin'), async () => { clearBrowser(); await api('linkedin/open', {}); $('#browser-panel').hidden = false; polling = true; await poll(); $('#browser-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
bind($('#check-linkedin'), 'click', () => busy($('#check-linkedin'), status));
bind($('#close-browser'), 'click', () => busy($('#close-browser'), async () => { clearBrowser(); await api('linkedin/release', {}); notice('Браузер закрыт. Сохранённая сессия останется доступна агенту.'); }));
bind($('#hide-browser'), 'click', async () => { clearBrowser(); await api('linkedin/finish', {}); });
bind($('#refresh-browser'), 'click', async () => { polling = true; clearTimeout(timer); await poll(); });
bind($('#browser-image'), 'click', async event => { if (!frame) return; const rect = $('#browser-image').getBoundingClientRect(); await input({ type: 'click', x: Math.min(frame.width - 1, Math.max(0, (event.clientX - rect.left) * frame.width / rect.width)), y: Math.min(frame.height - 1, Math.max(0, (event.clientY - rect.top) * frame.height / rect.height)) }); $('#browser-text-form').elements.text.focus(); });
bind($('#browser-text-form'), 'submit', () => busy($('#browser-text-form button'), async () => { const field = $('#browser-text-form').elements.text; const text = field.value; field.value = ''; if (text) await input({ type: 'text', text }); }));
for (const button of document.querySelectorAll('[data-key]')) bind(button, 'click', () => input({ type: 'key', key: button.dataset.key }));
bind($('#scroll-up'), 'click', () => input({ type: 'scroll', delta: -500 }));
bind($('#scroll-down'), 'click', () => input({ type: 'scroll', delta: 500 }));
function config() { return { mcpServers: { linkedin: { url: mcpUrl, headers: { Authorization: `Bearer ${personalToken}` } } } }; }
bind($('#create-token'), 'click', () => busy($('#create-token'), async () => { const result = await api('token', {}); personalToken = result.token; $('#mcp-token').value = personalToken; $('#mcp-token').type = 'password'; $('#show-token').textContent = 'Показать ключ'; $('#configuration').hidden = false; $('#config-json').textContent = JSON.stringify({ mcpServers: { linkedin: { url: mcpUrl, headers: { Authorization: 'Bearer <ваш персональный ключ>' } } } }, null, 2); notice('Персональный ключ создан. Скопируйте конфигурацию; предыдущий ключ отозван.'); }));
bind($('#revoke-token'), 'click', () => busy($('#revoke-token'), async () => { await api('token/revoke', {}); personalToken = ''; $('#configuration').hidden = true; $('#mcp-token').value = ''; notice('MCP-ключ отозван. Новые запросы агента будут отклонены.'); }));
bind($('#show-token'), 'click', () => { const field = $('#mcp-token'); field.type = field.type === 'password' ? 'text' : 'password'; $('#show-token').textContent = field.type === 'password' ? 'Показать ключ' : 'Скрыть ключ'; });
bind($('#copy-config'), 'click', async () => { await navigator.clipboard.writeText(JSON.stringify(config(), null, 2)); notice('Конфигурация с персональным ключом скопирована. Вставьте её в настройки MCP вашего агента.'); });
bind($('#password-form'), 'submit', () => busy($('#password-form button'), async () => { const form = $('#password-form'); await api('password', { currentPassword: form.elements.currentPassword.value, password: form.elements.password.value }); form.reset(); leave(); $('#login-error').textContent = 'Пароль изменён. Войдите с новым паролем.'; }));
bind($('#create-user'), 'submit', () => busy($('#create-user button'), async () => { const form = $('#create-user'); await api('admin/users', { username: form.elements.username.value, password: form.elements.password.value }); form.reset(); await users(); notice('Пользователь создан. Передайте ему адрес портала, логин и начальный пароль.'); }));
async function users() {
  const list = await api('admin/users'), target = $('#users-list'); target.replaceChildren();
  for (const user of list) {
    const row = node('article', undefined, 'user-row'); row.append(node('h3', user.username), node('span', user.role === 'admin' ? 'Администратор' : user.disabled ? 'Заблокирован' : 'Активен', 'badge'));
    if (user.role !== 'admin') {
      const controls = node('div', undefined, 'buttons');
      const action = async (values, message) => { await api('admin/user', { id: user.id, ...values }); await users(); notice(message); };
      const toggle = node('button', user.disabled ? 'Разблокировать' : 'Заблокировать', 'secondary'); bind(toggle, 'click', () => busy(toggle, () => action({ disabled: !user.disabled }, 'Статус пользователя изменён. MCP-ключ отозван.')));
      const revoke = node('button', 'Отозвать MCP-ключ', 'secondary'); bind(revoke, 'click', () => action({ revokeToken: true }, 'Ключ пользователя отозван.'));
      const release = node('button', 'Закрыть браузер', 'secondary'); bind(release, 'click', () => action({ release: true }, 'Браузер пользователя закрыт. Вход сохранён.'));
      const mode = node('select'); for (const [value, label] of [['review','Только предпросмотр'],['execute','Разрешить отправки']]) { const option = node('option', label); option.value = value; option.selected = user.action_mode === value; mode.append(option); } bind(mode, 'change', () => action({ actionMode: mode.value }, 'Режим действий изменён. Браузер перезапустится при следующем обращении.'));
      controls.append(toggle, revoke, release, mode); row.append(controls);
      const reset = node('form', undefined, 'buttons'); const password = node('input'); password.type = 'password'; password.placeholder = 'Новый пароль · от 16 символов'; password.minLength = 16; password.maxLength = 512; password.required = true; password.autocomplete = 'new-password'; const save = node('button', 'Сбросить пароль', 'secondary'); reset.append(password, save); bind(reset, 'submit', () => busy(save, async () => { const value = password.value; password.value = ''; await action({ password: value }, 'Пароль сброшен. Сессии портала и MCP-ключ отозваны.'); })); row.append(reset);
    }
    target.append(row);
  }
}
bind($('#refresh-users'), 'click', users);
api('me').then(enter).catch(() => {});
