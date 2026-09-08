const element = id => document.getElementById(id);
let settings;
lucide.createIcons();

function fail(message) {
  element('error').textContent = message;
  element('error').hidden = false;
  element('status').textContent = '连接未就绪';
  element('status').className = 'status failed';
}

async function check() {
  element('check').disabled = true;
  element('error').hidden = true;
  element('status').textContent = '正在检查';
  element('status').className = 'status pending';
  try {
    const response = await fetch('/_local/check', { headers: { authorization: `Bearer ${settings.api_key}` }, signal: AbortSignal.timeout(35000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.code === 'aily_login_required' ? '飞书登录已失效. 请打开重新登录入口.' : '飞书连接检查失败. 请稍后重试.');
    element('status').textContent = '飞书已连接';
    element('status').className = 'status';
    element('checked-at').textContent = `检查于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (error) { fail(error.message); }
  finally { element('check').disabled = false; }
}

async function copy(value) {
  try { await navigator.clipboard.writeText(value); element('copy-status').textContent = '已复制'; }
  catch { element('copy-status').textContent = '复制失败'; }
}

document.querySelectorAll('.copy').forEach(button => button.addEventListener('click', () => copy(element(button.dataset.field).value)));
element('copy-config').addEventListener('click', () => copy(JSON.stringify({ base_url: settings.base_url, api_key: settings.api_key, model: settings.model }, null, 2)));
element('check').addEventListener('click', check);
element('reveal').addEventListener('click', () => {
  const show = element('api-key').type === 'password';
  element('api-key').type = show ? 'text' : 'password';
  element('reveal').title = show ? '隐藏密钥' : '显示密钥';
  element('reveal').setAttribute('aria-label', element('reveal').title);
  element('reveal').innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}"></i>`;
  lucide.createIcons();
});

(async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get('connect');
  history.replaceState(null, '', location.pathname);
  if (!token) { fail('此连接页已关闭或过期. 请重新打开启动入口.'); return; }
  try {
    const response = await fetch('/_local/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    if (!response.ok) throw new Error('此连接页已过期. 请重新打开启动入口.');
    settings = await response.json();
    element('assistant-name').textContent = settings.assistant_name;
    element('base-url').value = settings.base_url;
    element('model').value = settings.model;
    element('api-key').value = settings.api_key;
    if (settings.avatar_url?.startsWith('https://')) {
      const avatar = element('avatar');
      avatar.addEventListener('load', () => { avatar.hidden = false; element('avatar-placeholder').hidden = true; });
      avatar.src = settings.avatar_url;
    }
    document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    await check();
  } catch (error) { fail(error.message); }
})();
