const authStatusEl = document.getElementById('authStatus');
const adminContentEl = document.getElementById('adminContent');
const logoutBtn = document.getElementById('logoutBtn');

const roomListEl = document.getElementById('roomList');
const storageSummaryEl = document.getElementById('storageSummary');
const jobStatusFilterEl = document.getElementById('jobStatusFilter');
const refreshJobsBtn = document.getElementById('refreshJobsBtn');
const cleanupDaysEl = document.getElementById('cleanupDays');
const cleanupJobsBtn = document.getElementById('cleanupJobsBtn');
const jobStatusTextEl = document.getElementById('jobStatusText');
const jobListEl = document.getElementById('jobList');

const AUTH_TOKEN_KEY = 'auth_token';
let currentUser = null;

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAuthToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const resp = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `Request failed: ${resp.status}`);
  }
  return data;
}

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function formatSeconds(value) {
  const sec = Math.max(0, Math.floor(Number(value) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  if (size >= 100 || idx === 0) {
    return `${Math.round(size)} ${units[idx]}`;
  }
  return `${size.toFixed(1)} ${units[idx]}`;
}

function formatProgress(value) {
  const p = Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100)));
  return `${p}%`;
}

function renderAuthStatus() {
  if (!currentUser) {
    authStatusEl.innerHTML = '未登录，请先前往 <a href="/">主页登录</a>';
    adminContentEl.classList.add('hidden');
    if (logoutBtn) {
      logoutBtn.classList.add('hidden');
    }
    return;
  }

  if (currentUser.role !== 'root') {
    authStatusEl.textContent = `当前用户 ${currentUser.username} 不是 Root，无权限访问管理台`;
    adminContentEl.classList.add('hidden');
    if (logoutBtn) {
      logoutBtn.classList.remove('hidden');
    }
    return;
  }

  authStatusEl.textContent = `已登录 Root: ${currentUser.username}`;
  adminContentEl.classList.remove('hidden');
  if (logoutBtn) {
    logoutBtn.classList.remove('hidden');
  }
}

function renderJobs(jobs) {
  jobListEl.innerHTML = '';
  if (!jobs.length) {
    jobListEl.innerHTML = '<div class="small">暂无任务</div>';
    return;
  }

  jobs.forEach((job) => {
    const row = document.createElement('div');
    row.className = 'room-item';

    const title = document.createElement('div');
    const linkedVideo = job.video?.title || job.videoId || '-';
    title.textContent = `[${job.status}] ${job.stage} | 进度 ${formatProgress(job.progress)} | 视频 ${linkedVideo}`;

    const message = document.createElement('div');
    message.className = 'small';
    message.textContent = `来源: ${job.sourceType} | 信息: ${job.message || '-'} | 更新时间: ${formatDate(job.updatedAt)}`;

    const error = document.createElement('div');
    error.className = 'small';
    error.textContent = job.error ? `错误: ${job.error}` : '错误: -';

    row.appendChild(title);
    row.appendChild(message);
    row.appendChild(error);
    jobListEl.appendChild(row);
  });
}

async function loadJobs() {
  const status = String(jobStatusFilterEl.value || '').trim();
  const qs = new URLSearchParams();
  if (status) {
    qs.set('status', status);
  }
  qs.set('limit', '100');

  const data = await apiFetch(`/api/admin/video-jobs?${qs.toString()}`);
  const total = Number(data.paging?.total || 0);
  jobStatusTextEl.textContent = `任务总数: ${total}${status ? ` (过滤: ${status})` : ''}`;
  renderJobs(data.jobs || []);
}

async function loadStorage() {
  const data = await apiFetch('/api/admin/storage');
  const pool = data.pool || {};
  const disk = data.disk || null;

  const lines = [];
  const poolLimitLabel = pool.isUnlimited ? '无上限' : formatBytes(pool.maxBytes);
  const poolAvailableLabel = pool.isUnlimited ? '不限制' : formatBytes(pool.availableBytes);
  lines.push(`播放池: ${formatBytes(pool.usageBytes)} / ${poolLimitLabel} (可用 ${poolAvailableLabel})`);
  lines.push(`文件数: ${Number(pool.fileCount || 0)}`);
  if (disk) {
    lines.push(`磁盘剩余: ${formatBytes(disk.freeBytes)} / ${formatBytes(disk.totalBytes)}`);
  } else {
    lines.push('磁盘信息: 当前环境不支持读取');
  }

  storageSummaryEl.innerHTML = lines.join('<br/>');
}

function renderRooms(rooms) {
  roomListEl.innerHTML = '';
  if (!rooms.length) {
    roomListEl.innerHTML = '<div class="small">当前没有放映室</div>';
    return;
  }

  rooms.forEach((room) => {
    const row = document.createElement('div');
    row.className = 'room-item';

    const link = document.createElement('a');
    link.href = `/rooms/${room.id}`;
    link.textContent = room.name;

    const info = document.createElement('div');
    info.className = 'small';
    info.textContent = `${room.sourceLabel || `视频: ${room.videoTitle || '-'}`} | 模式: ${room.roomMode || 'cloud'} | 创建者: ${room.creatorName || '-'} | 在线: ${room.memberCount || 0} | 续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

    const createdAt = document.createElement('div');
    createdAt.className = 'small';
    createdAt.textContent = `创建时间: ${formatDate(room.createdAt)}`;

    const action = document.createElement('div');
    action.className = 'flex';

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = 'Root 删除';
    delBtn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/admin/rooms/${room.id}`, { method: 'DELETE' });
        await loadRooms();
      } catch (err) {
        alert(err.message);
      }
    });

    action.appendChild(delBtn);

    row.appendChild(link);
    row.appendChild(info);
    row.appendChild(createdAt);
    row.appendChild(action);

    roomListEl.appendChild(row);
  });
}

async function loadRooms() {
  const data = await apiFetch('/api/admin/rooms');
  renderRooms(data.rooms || []);
}

async function checkAuth() {
  try {
    const result = await apiFetch('/api/auth/me');
    currentUser = result.user || null;
  } catch (_err) {
    currentUser = null;
  }
  renderAuthStatus();
  return Boolean(currentUser && currentUser.role === 'root');
}

async function loadDashboard() {
  await Promise.all([loadStorage(), loadJobs(), loadRooms()]);
}

refreshJobsBtn.addEventListener('click', async () => {
  try {
    await loadJobs();
  } catch (err) {
    jobStatusTextEl.textContent = `加载任务失败: ${err.message}`;
  }
});

jobStatusFilterEl.addEventListener('change', async () => {
  try {
    await loadJobs();
  } catch (err) {
    jobStatusTextEl.textContent = `加载任务失败: ${err.message}`;
  }
});

cleanupJobsBtn.addEventListener('click', async () => {
  const olderThanDays = Math.max(1, Math.floor(Number(cleanupDaysEl.value || 30)));
  try {
    const result = await apiFetch(`/api/admin/video-jobs?olderThanDays=${olderThanDays}`, {
      method: 'DELETE',
    });
    jobStatusTextEl.textContent = `已清理 ${result.removed} 条任务（>${olderThanDays} 天）`;
    await loadJobs();
  } catch (err) {
    jobStatusTextEl.textContent = `清理失败: ${err.message}`;
  }
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_err) {
      // ignore
    }
    setAuthToken('');
    currentUser = null;
    renderAuthStatus();
    window.location.href = '/';
  });
}

(async function init() {
  const isRoot = await checkAuth();
  if (!isRoot) {
    return;
  }

  try {
    await loadDashboard();
  } catch (err) {
    authStatusEl.textContent = `加载管理数据失败: ${err.message}`;
    adminContentEl.classList.add('hidden');
  }
})();
