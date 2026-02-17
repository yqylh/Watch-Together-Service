const loginForm = document.getElementById('loginForm');
const logoutBtn = document.getElementById('logoutBtn');
const loginStatus = document.getElementById('loginStatus');
const roomListEl = document.getElementById('roomList');
const storageSummaryEl = document.getElementById('storageSummary');
const jobStatusFilterEl = document.getElementById('jobStatusFilter');
const refreshJobsBtn = document.getElementById('refreshJobsBtn');
const cleanupDaysEl = document.getElementById('cleanupDays');
const cleanupJobsBtn = document.getElementById('cleanupJobsBtn');
const jobStatusTextEl = document.getElementById('jobStatusText');
const jobListEl = document.getElementById('jobList');

const ROOT_TOKEN_KEY = 'root_token';

function getRootToken() {
  return localStorage.getItem(ROOT_TOKEN_KEY) || '';
}

function setRootToken(token) {
  if (token) {
    localStorage.setItem(ROOT_TOKEN_KEY, token);
  } else {
    localStorage.removeItem(ROOT_TOKEN_KEY);
  }
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getRootToken();
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
  try {
    const data = await apiFetch('/api/admin/storage');
    const pool = data.pool || {};
    const disk = data.disk || null;
    const uploadLimit = data.uploadLimit || {};
    const lines = [];
    lines.push(`播放池: ${formatBytes(pool.usageBytes)} / ${formatBytes(pool.maxBytes)} (可用 ${formatBytes(pool.availableBytes)})`);
    lines.push(`文件数: ${Number(pool.fileCount || 0)}`);
    lines.push(`上传大小限制: ${uploadLimit.maxLabel || formatBytes(uploadLimit.maxBytes)}`);
    if (disk) {
      lines.push(`磁盘剩余: ${formatBytes(disk.freeBytes)} / ${formatBytes(disk.totalBytes)}`);
    } else {
      lines.push('磁盘信息: 当前环境不支持读取');
    }
    storageSummaryEl.innerHTML = lines.join('<br/>');
  } catch (err) {
    storageSummaryEl.textContent = `读取存储状态失败: ${err.message}`;
  }
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
    info.textContent = `${room.sourceLabel || `视频: ${room.videoTitle || '-'}`} | 创建者: ${room.creatorName} | 在线: ${room.memberCount} | 续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

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
  try {
    const data = await apiFetch('/api/admin/rooms');
    loginStatus.textContent = 'Root 已登录';
    renderRooms(data.rooms);
    await Promise.all([loadStorage(), loadJobs()]);
  } catch (err) {
    loginStatus.textContent = `未登录 Root: ${err.message}`;
    roomListEl.innerHTML = '<div class="small">请先登录 Root</div>';
    storageSummaryEl.innerHTML = '<div class="small">请先登录 Root</div>';
    jobStatusTextEl.textContent = '请先登录 Root';
    jobListEl.innerHTML = '<div class="small">请先登录 Root</div>';
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginStatus.textContent = '登录中...';
  const formData = new FormData(loginForm);

  try {
    const result = await apiFetch('/api/auth/root/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password'),
      }),
    });

    setRootToken(result.token);
    loginStatus.textContent = 'Root 登录成功';
    await loadRooms();
  } catch (err) {
    loginStatus.textContent = `登录失败: ${err.message}`;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/auth/root/logout', { method: 'POST' });
  } catch (_err) {
    // ignore
  }

  setRootToken('');
  loginStatus.textContent = 'Root 已退出';
  await loadRooms();
});

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

loadRooms();
