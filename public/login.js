const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const authStatusEl = document.getElementById('authStatus');
const currentUserEl = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');
const goUpload = document.getElementById('goUpload');
const goVideos = document.getElementById('goVideos');

const {
  apiFetch,
  setAuthToken,
} = window.WatchPartyCommon;

let currentUser = null;

function renderAuthState() {
  if (!currentUser) {
    currentUserEl.textContent = '未登录';
    logoutBtn.classList.add('hidden');
    goUpload.classList.add('hidden');
    goVideos.classList.add('hidden');
    return;
  }

  currentUserEl.textContent = `已登录: ${currentUser.username} (${currentUser.role})`;
  logoutBtn.classList.remove('hidden');
  goUpload.classList.remove('hidden');
  goVideos.classList.remove('hidden');
}

async function checkAuth() {
  try {
    const result = await apiFetch('/api/auth/me');
    currentUser = result.user || null;
    authStatusEl.textContent = '登录状态有效';
  } catch (_err) {
    currentUser = null;
  }
  renderAuthState();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authStatusEl.textContent = '登录中...';

  const formData = new FormData(loginForm);
  try {
    const result = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password'),
      }),
    });

    setAuthToken(result.token);
    currentUser = result.user;
    renderAuthState();
    authStatusEl.textContent = '登录成功，正在进入视频页...';
    window.location.href = '/videos';
  } catch (err) {
    authStatusEl.textContent = `登录失败: ${err.message}`;
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authStatusEl.textContent = '注册中...';

  const formData = new FormData(registerForm);
  try {
    const result = await apiFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password'),
      }),
    });

    setAuthToken(result.token);
    currentUser = result.user;
    renderAuthState();
    authStatusEl.textContent = '注册成功，正在进入视频页...';
    window.location.href = '/videos';
  } catch (err) {
    authStatusEl.textContent = `注册失败: ${err.message}`;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (_err) {
    // ignore
  }
  setAuthToken('');
  currentUser = null;
  authStatusEl.textContent = '已退出登录';
  renderAuthState();
});

checkAuth();
