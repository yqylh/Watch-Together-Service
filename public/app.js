const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const logoutBtn = document.getElementById('logoutBtn');
const authStatusEl = document.getElementById('authStatus');
const currentUserEl = document.getElementById('currentUser');
const appContentEl = document.getElementById('appContent');

const uploadForm = document.getElementById('uploadForm');
const uploadStatus = document.getElementById('uploadStatus');
const uploadModeEl = document.getElementById('uploadMode');
const videoFileEl = document.getElementById('videoFile');
const videoFileLabelEl = document.getElementById('videoFileLabel');
const uploadModeHintEl = document.getElementById('uploadModeHint');

const playlistForm = document.getElementById('playlistForm');
const playlistStatus = document.getElementById('playlistStatus');
const playlistVideosEl = document.getElementById('playlistVideos');
const playlistListEl = document.getElementById('playlistList');

const videoListEl = document.getElementById('videoList');
const globalRoomListEl = document.getElementById('globalRoomList');
const supportedFormatsEl = document.getElementById('supportedFormats');
const storageInfoEl = document.getElementById('storageInfo');

const AUTH_TOKEN_KEY = 'auth_token';
let videosCache = [];
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

function normalizeHash(hash) {
  return String(hash || '').trim().toLowerCase();
}

async function computeFileSha256Hex(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function syncUploadModeUI() {
  const mode = String(uploadModeEl.value || 'cloud').trim();
  const isLocalMode = mode === 'local_file';
  videoFileEl.required = true;
  if (isLocalMode) {
    videoFileLabelEl.textContent = '本地文件（仅用于计算 hash）';
    uploadModeHintEl.textContent = '本地模式不会上传文件本体，前端会计算 SHA-256 后仅提交 hash。';
    return;
  }
  videoFileLabelEl.textContent = '视频文件';
  uploadModeHintEl.textContent = '';
}

function mapJobStage(stage) {
  const dict = {
    upload_received: '上传完成，等待处理',
    hashing: '校验 hash',
    registering_local_hash: '登记本地模式 hash',
    compressing: '压缩转码',
    deduplicating: '重复文件复用',
    storing_local: '写入播放池',
    uploading_oss: '后台传输到 OSS',
    completed: '已完成',
    failed: '失败',
  };
  return dict[stage] || stage || '处理中';
}

function mapJobStatus(status) {
  if (status === 'completed') {
    return '完成';
  }
  if (status === 'failed') {
    return '失败';
  }
  return '处理中';
}

function canDeleteRoom(room) {
  if (!currentUser) {
    return false;
  }
  return currentUser.role === 'root' || room.createdByUserId === currentUser.id;
}

function renderCurrentUser() {
  if (!currentUser) {
    currentUserEl.textContent = '未登录';
    appContentEl.classList.add('hidden');
    return;
  }
  currentUserEl.textContent = `用户: ${currentUser.username} | 角色: ${currentUser.role}`;
  appContentEl.classList.remove('hidden');
}

function modeOptionsHtml(options = {}) {
  const allowCloud = options.allowCloud !== false;
  return `
    <option value="">请选择播放模式</option>
    ${allowCloud ? '<option value="cloud">云端托管</option>' : ''}
    <option value="local_file">本地文件</option>
  `;
}

function renderRoomRow(room) {
  const row = document.createElement('div');
  row.className = 'room-item';

  const openLink = document.createElement('a');
  openLink.href = `/rooms/${room.id}`;
  openLink.textContent = room.name;

  const info = document.createElement('div');
  info.className = 'small';
  info.textContent = `${room.sourceLabel || ''} | 模式: ${room.roomMode || 'cloud'} | 创建者: ${room.creatorName || '-'} | 在线: ${room.memberCount || 0} | 续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `创建时间: ${formatDate(room.createdAt)}`;

  row.appendChild(openLink);
  row.appendChild(info);
  row.appendChild(meta);

  if (canDeleteRoom(room)) {
    const actions = document.createElement('div');
    actions.className = 'flex';

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '删除放映室';
    deleteBtn.className = 'danger';
    deleteBtn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/rooms/${room.id}`, {
          method: 'DELETE',
        });
        await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms()]);
      } catch (err) {
        alert(err.message);
      }
    });

    actions.appendChild(deleteBtn);
    row.appendChild(actions);
  }

  return row;
}

function renderVideoCard(video) {
  const item = document.createElement('div');
  item.className = 'video-item';

  const title = document.createElement('h3');
  title.textContent = video.title;

  let player = null;
  if (video.mediaUrl) {
    player = document.createElement('video');
    player.src = video.mediaUrl;
    player.controls = true;
  }

  const uniqueLink = document.createElement('a');
  uniqueLink.href = video.watchUrl;
  uniqueLink.textContent = `唯一链接: ${location.origin}${video.watchUrl}`;

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `上传时间: ${formatDate(video.createdAt)} | 文件: ${video.originalName} | hash: ${video.contentHash || '-'} | 来源: ${video.sourceType} | 本地: ${video.localAvailable ? '有' : '无'} | OSS: ${video.storedInOss ? '有' : '无'}`;
  const allowCloudMode = Boolean(video.mediaUrl);

  const roomForm = document.createElement('form');
  roomForm.className = 'card';
  roomForm.innerHTML = `
    <div class="form-row">
      <label>放映室名称</label>
      <input name="roomName" placeholder="可选" />
    </div>
    <div class="form-row">
      <label>播放模式</label>
      <select name="roomMode" required>
        ${modeOptionsHtml({ allowCloud: allowCloudMode })}
      </select>
    </div>
    <button type="submit">基于此视频创建放映室</button>
  `;

  roomForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(roomForm);

    const roomMode = String(formData.get('roomMode') || '').trim();
    if (!roomMode) {
      alert('请选择播放模式');
      return;
    }

    try {
      const result = await apiFetch(`/api/videos/${video.id}/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: formData.get('roomName') || '',
          roomMode,
        }),
      });

      location.href = `/rooms/${result.room.id}`;
    } catch (err) {
      alert(err.message);
    }
  });

  const roomsWrap = document.createElement('div');
  roomsWrap.className = 'room-list';

  if (!video.rooms.length) {
    roomsWrap.innerHTML = '<div class="small">当前视频还没有放映室</div>';
  } else {
    video.rooms.forEach((room) => roomsWrap.appendChild(renderRoomRow(room)));
  }

  item.appendChild(title);
  if (player) {
    item.appendChild(player);
  } else {
    const tip = document.createElement('div');
    tip.className = 'small';
    tip.textContent = '本地模式视频：服务端不存源文件，无法云端预览。';
    item.appendChild(tip);
  }
  item.appendChild(uniqueLink);
  item.appendChild(meta);
  item.appendChild(roomForm);
  item.appendChild(roomsWrap);
  return item;
}

function renderPlaylistCard(playlist) {
  const item = document.createElement('div');
  item.className = 'video-item';

  const title = document.createElement('h3');
  title.textContent = `${playlist.name} (${playlist.episodes.length} 集)`;

  const desc = document.createElement('div');
  desc.className = 'small';
  desc.textContent = `${playlist.description || '无描述'} | 创建时间: ${formatDate(playlist.createdAt)}`;

  const epWrap = document.createElement('div');
  epWrap.className = 'room-list';
  playlist.episodes.forEach((ep) => {
    const row = document.createElement('div');
    row.className = 'room-item';
    row.innerHTML = `<div>第 ${ep.episodeIndex + 1} 集: <a href="${ep.watchUrl}">${ep.title}</a></div><div class="small">hash: ${ep.contentHash || '-'}</div>`;
    epWrap.appendChild(row);
  });

  const roomForm = document.createElement('form');
  roomForm.className = 'card';
  const allowCloudMode = playlist.episodes.every((ep) => Boolean(ep.mediaUrl));

  const startOptions = playlist.episodes
    .map((ep) => `<option value="${ep.episodeIndex}">第 ${ep.episodeIndex + 1} 集 - ${ep.title}</option>`)
    .join('');

  roomForm.innerHTML = `
    <div class="form-row">
      <label>放映室名称</label>
      <input name="roomName" placeholder="可选" />
    </div>
    <div class="form-row">
      <label>播放模式</label>
      <select name="roomMode" required>
        ${modeOptionsHtml({ allowCloud: allowCloudMode })}
      </select>
    </div>
    <div class="form-row">
      <label>起播集数</label>
      <select name="startEpisodeIndex">${startOptions}</select>
    </div>
    <button type="submit">基于此视频列表创建放映室（多集）</button>
  `;

  roomForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(roomForm);

    const roomMode = String(formData.get('roomMode') || '').trim();
    if (!roomMode) {
      alert('请选择播放模式');
      return;
    }

    try {
      const result = await apiFetch(`/api/playlists/${playlist.id}/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: formData.get('roomName') || '',
          roomMode,
          startEpisodeIndex: Number(formData.get('startEpisodeIndex') || 0),
        }),
      });

      location.href = `/rooms/${result.room.id}`;
    } catch (err) {
      alert(err.message);
    }
  });

  const roomList = document.createElement('div');
  roomList.className = 'room-list';
  if (!playlist.rooms.length) {
    roomList.innerHTML = '<div class="small">该列表还没有放映室</div>';
  } else {
    playlist.rooms.forEach((room) => roomList.appendChild(renderRoomRow(room)));
  }

  item.appendChild(title);
  item.appendChild(desc);
  item.appendChild(epWrap);
  item.appendChild(roomForm);
  item.appendChild(roomList);

  return item;
}

function refreshPlaylistVideoOptions() {
  playlistVideosEl.innerHTML = '';
  videosCache.forEach((video) => {
    const option = document.createElement('option');
    option.value = video.id;
    option.textContent = `${video.title} (${video.originalName})`;
    playlistVideosEl.appendChild(option);
  });
}

async function loadSupportedFormats() {
  const data = await apiFetch('/api/supported-formats');
  const lines = data.formats
    .map((fmt) => `${fmt.extension}: ${fmt.mimeTypes.join(', ')}`)
    .join('<br/>');
  supportedFormatsEl.innerHTML = `${lines}<br/><br/>${data.note || ''}`;
}

async function loadStorageInfo() {
  const data = await apiFetch('/api/storage');
  const pool = data.pool || {};
  const disk = data.disk || null;
  const lines = [];
  lines.push(`播放池: 已用 ${formatBytes(pool.usageBytes)} / 上限 ${formatBytes(pool.maxBytes)} (可用 ${formatBytes(pool.availableBytes)})`);
  lines.push(`池中文件数: ${Number(pool.fileCount || 0)}`);
  if (disk) {
    lines.push(`所在磁盘: 剩余 ${formatBytes(disk.freeBytes)} / 总计 ${formatBytes(disk.totalBytes)}`);
  } else {
    lines.push('所在磁盘: 当前环境不支持读取');
  }
  storageInfoEl.innerHTML = lines.join('<br/>');
}

async function pollVideoJob(jobId, onUpdate) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const data = await apiFetch(`/api/video-jobs/${jobId}`);
    const job = data.job;
    onUpdate(job);
    if (job.status === 'completed') {
      return job;
    }
    if (job.status === 'failed') {
      throw new Error(job.error || job.message || '任务失败');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('任务超时，请稍后查看状态');
}

async function loadVideos() {
  const data = await apiFetch('/api/videos');
  videosCache = data.videos || [];
  refreshPlaylistVideoOptions();

  videoListEl.innerHTML = '';
  if (!videosCache.length) {
    videoListEl.innerHTML = '<div class="small">还没有上传任何视频</div>';
    return;
  }

  videosCache.forEach((video) => {
    videoListEl.appendChild(renderVideoCard(video));
  });
}

async function loadPlaylists() {
  const data = await apiFetch('/api/playlists');
  playlistListEl.innerHTML = '';

  if (!data.playlists.length) {
    playlistListEl.innerHTML = '<div class="small">还没有创建视频列表</div>';
    return;
  }

  data.playlists.forEach((playlist) => {
    playlistListEl.appendChild(renderPlaylistCard(playlist));
  });
}

async function loadGlobalRooms() {
  const data = await apiFetch('/api/rooms');
  globalRoomListEl.innerHTML = '';

  if (!data.rooms.length) {
    globalRoomListEl.innerHTML = '<div class="small">当前没有放映室</div>';
    return;
  }

  data.rooms.forEach((room) => {
    globalRoomListEl.appendChild(renderRoomRow(room));
  });
}

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  uploadStatus.textContent = '上传中（浏览器 -> 服务器）...';

  try {
    const formData = new FormData(uploadForm);
    const uploadMode = String(formData.get('uploadMode') || 'cloud').trim();
    if (!['cloud', 'local_file'].includes(uploadMode)) {
      throw new Error('上传模式无效');
    }

    const selectedFile = formData.get('video');
    if (!(selectedFile instanceof File) || !selectedFile.name) {
      throw new Error('请选择本地视频文件');
    }

    if (uploadMode === 'cloud') {
      if (!(selectedFile instanceof File) || !selectedFile.name) {
        throw new Error('云端托管模式必须选择视频文件');
      }
    } else {
      uploadStatus.textContent = '本地模式：正在前端计算 SHA-256...';
      let contentHash = '';
      try {
        contentHash = normalizeHash(await computeFileSha256Hex(selectedFile));
      } catch (err) {
        throw new Error(`计算 hash 失败: ${err.message}`);
      }
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new Error('本地模式 hash 计算失败');
      }
      formData.set('contentHash', contentHash);
      formData.set('localFileName', selectedFile.name || '');
      formData.delete('video');
    }

    const submitResult = await apiFetch('/api/videos', {
      method: 'POST',
      body: formData,
    });

    const jobId = submitResult.job?.id;
    if (!jobId) {
      throw new Error('上传任务创建失败');
    }

    const doneJob = await pollVideoJob(jobId, (job) => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(job.progress || 0) * 100)));
      uploadStatus.textContent = `状态: ${mapJobStatus(job.status)} | 阶段: ${mapJobStage(job.stage)} | ${pct}% | ${job.message || ''}`;
    });

    uploadStatus.textContent = `上传成功: ${doneJob.video?.title || doneJob.videoId || '已入库'}`;
    uploadForm.reset();
    syncUploadModeUI();
    await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms(), loadStorageInfo()]);
  } catch (err) {
    uploadStatus.textContent = `上传失败: ${err.message}`;
  }
});

playlistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  playlistStatus.textContent = '创建中...';

  const formData = new FormData(playlistForm);
  const selected = [...playlistVideosEl.options]
    .filter((opt) => opt.selected)
    .map((opt) => opt.value);

  try {
    await apiFetch('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name') || '',
        description: formData.get('description') || '',
        episodeVideoIds: selected,
      }),
    });

    playlistStatus.textContent = '创建成功';
    playlistForm.reset();
    await Promise.all([loadPlaylists(), loadGlobalRooms()]);
  } catch (err) {
    playlistStatus.textContent = `创建失败: ${err.message}`;
  }
});

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
    renderCurrentUser();
    authStatusEl.textContent = '登录成功';
    await loadAllBusinessData();
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
    renderCurrentUser();
    authStatusEl.textContent = '注册成功并已登录';
    await loadAllBusinessData();
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
  renderCurrentUser();
  authStatusEl.textContent = '已退出登录';
});

uploadModeEl.addEventListener('change', syncUploadModeUI);

async function checkAuthState() {
  try {
    const result = await apiFetch('/api/auth/me');
    currentUser = result.user;
    renderCurrentUser();
    return true;
  } catch (_err) {
    currentUser = null;
    renderCurrentUser();
    return false;
  }
}

async function loadAllBusinessData() {
  await Promise.all([
    loadStorageInfo(),
    loadSupportedFormats(),
    loadVideos(),
    loadPlaylists(),
    loadGlobalRooms(),
  ]);
}

(async function init() {
  syncUploadModeUI();
  const authed = await checkAuthState();
  if (!authed) {
    authStatusEl.textContent = '请先登录';
    return;
  }
  await loadAllBusinessData();
})();
