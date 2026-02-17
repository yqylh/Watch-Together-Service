const uploadForm = document.getElementById('uploadForm');
const uploadStatus = document.getElementById('uploadStatus');
const remoteImportForm = document.getElementById('remoteImportForm');
const remoteStatus = document.getElementById('remoteStatus');
const sourceTypeEl = document.getElementById('sourceType');
const serverPathRow = document.getElementById('serverPathRow');
const remoteUrlRow = document.getElementById('remoteUrlRow');

const playlistForm = document.getElementById('playlistForm');
const playlistStatus = document.getElementById('playlistStatus');
const playlistVideosEl = document.getElementById('playlistVideos');
const playlistListEl = document.getElementById('playlistList');

const videoListEl = document.getElementById('videoList');
const globalRoomListEl = document.getElementById('globalRoomList');
const supportedFormatsEl = document.getElementById('supportedFormats');
const storageInfoEl = document.getElementById('storageInfo');
const uploadLimitHintEl = document.getElementById('uploadLimitHint');
const remoteLimitHintEl = document.getElementById('remoteLimitHint');

const rootLoginForm = document.getElementById('rootLoginForm');
const rootLogoutBtn = document.getElementById('rootLogoutBtn');
const rootStatusEl = document.getElementById('rootStatus');

const ROOT_TOKEN_KEY = 'root_token';
let videosCache = [];
let maxUploadBytes = 0;

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

function creatorTokenKey(roomId) {
  return `room_creator_token_${roomId}`;
}

function getCreatorToken(roomId) {
  return localStorage.getItem(creatorTokenKey(roomId)) || '';
}

function setCreatorToken(roomId, token) {
  localStorage.setItem(creatorTokenKey(roomId), token);
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

function mapJobStage(stage) {
  const dict = {
    upload_received: '上传完成，等待处理',
    hashing: '校验 hash',
    compressing: '压缩转码',
    deduplicating: '重复文件复用',
    storing_local: '写入播放池',
    uploading_oss: '后台传输到 OSS',
    downloading_remote: '拉取远程文件',
    reading_server_file: '读取服务器文件',
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

function updateSourceTypeView() {
  const type = sourceTypeEl.value;
  if (type === 'server_path') {
    serverPathRow.classList.remove('hidden');
    remoteUrlRow.classList.add('hidden');
  } else {
    serverPathRow.classList.add('hidden');
    remoteUrlRow.classList.remove('hidden');
  }
}

function renderRoomRow(room) {
  const row = document.createElement('div');
  row.className = 'room-item';

  const openLink = document.createElement('a');
  openLink.href = `/rooms/${room.id}`;
  openLink.textContent = room.name;

  const info = document.createElement('div');
  info.className = 'small';
  info.textContent = `${room.sourceLabel || ''} | 创建者: ${room.creatorName || '-'} | 在线: ${room.memberCount || 0} | 续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `创建时间: ${formatDate(room.createdAt)}`;

  row.appendChild(openLink);
  row.appendChild(info);
  row.appendChild(meta);

  if (getCreatorToken(room.id) || getRootToken()) {
    const actions = document.createElement('div');
    actions.className = 'flex';

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '删除放映室';
    deleteBtn.className = 'danger';
    deleteBtn.addEventListener('click', async () => {
      const creatorToken = getCreatorToken(room.id);
      const headers = {};
      if (creatorToken) {
        headers['x-creator-token'] = creatorToken;
      }

      try {
        await apiFetch(`/api/rooms/${room.id}`, {
          method: 'DELETE',
          headers,
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

  const player = document.createElement('video');
  player.src = video.mediaUrl;
  player.controls = true;

  const uniqueLink = document.createElement('a');
  uniqueLink.href = video.watchUrl;
  uniqueLink.textContent = `唯一链接: ${location.origin}${video.watchUrl}`;

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `上传时间: ${formatDate(video.createdAt)} | 文件: ${video.originalName} | hash: ${video.contentHash || '-'} | 来源: ${video.sourceType} | 本地: ${video.localAvailable ? '有' : '无'} | OSS: ${video.storedInOss ? '有' : '无'}`;

  const roomForm = document.createElement('form');
  roomForm.className = 'card';
  roomForm.innerHTML = `
    <div class="form-row">
      <label>放映室名称</label>
      <input name="roomName" placeholder="可选" />
    </div>
    <div class="form-row">
      <label>你的昵称</label>
      <input name="creatorName" placeholder="例如：张三" required />
    </div>
    <button type="submit">基于此视频创建放映室</button>
  `;

  roomForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(roomForm);

    try {
      const result = await apiFetch(`/api/videos/${video.id}/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: formData.get('roomName') || '',
          creatorName: formData.get('creatorName') || '匿名用户',
        }),
      });

      setCreatorToken(result.room.id, result.creatorToken);
      location.href = `/rooms/${result.room.id}?name=${encodeURIComponent(formData.get('creatorName') || '')}`;
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
  item.appendChild(player);
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

  const startOptions = playlist.episodes
    .map((ep) => `<option value="${ep.episodeIndex}">第 ${ep.episodeIndex + 1} 集 - ${ep.title}</option>`)
    .join('');

  roomForm.innerHTML = `
    <div class="form-row">
      <label>放映室名称</label>
      <input name="roomName" placeholder="可选" />
    </div>
    <div class="form-row">
      <label>你的昵称</label>
      <input name="creatorName" required />
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

    try {
      const result = await apiFetch(`/api/playlists/${playlist.id}/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: formData.get('roomName') || '',
          creatorName: formData.get('creatorName') || '匿名用户',
          startEpisodeIndex: Number(formData.get('startEpisodeIndex') || 0),
        }),
      });

      setCreatorToken(result.room.id, result.creatorToken);
      location.href = `/rooms/${result.room.id}?name=${encodeURIComponent(formData.get('creatorName') || '')}`;
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
  maxUploadBytes = Number(data.storage?.maxUploadBytes || 0);
  const limitLabel = maxUploadBytes > 0 ? formatBytes(maxUploadBytes) : '未限制';
  uploadLimitHintEl.textContent = `上传大小限制: ${limitLabel}`;
  remoteLimitHintEl.textContent = `导入大小限制: ${limitLabel}`;
}

async function loadStorageInfo() {
  const data = await apiFetch('/api/storage');
  const pool = data.pool || {};
  const uploadLimit = data.uploadLimit || {};
  const disk = data.disk || null;
  const lines = [];
  lines.push(`播放池: 已用 ${formatBytes(pool.usageBytes)} / 上限 ${formatBytes(pool.maxBytes)} (可用 ${formatBytes(pool.availableBytes)})`);
  lines.push(`池中文件数: ${Number(pool.fileCount || 0)}`);
  lines.push(`上传大小限制: ${uploadLimit.maxLabel || formatBytes(uploadLimit.maxBytes)}`);
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
    const file = formData.get('video');
    if (file && maxUploadBytes > 0 && file.size > maxUploadBytes) {
      throw new Error(`文件过大，限制 ${formatBytes(maxUploadBytes)}`);
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
    await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms(), loadStorageInfo()]);
  } catch (err) {
    uploadStatus.textContent = `上传失败: ${err.message}`;
  }
});

remoteImportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  remoteStatus.textContent = '导入任务创建中...';

  const formData = new FormData(remoteImportForm);
  const sourceType = String(formData.get('sourceType') || 'server_path');

  const payload = {
    title: formData.get('title') || '',
    description: formData.get('description') || '',
    sourceType,
    originalName: formData.get('originalName') || '',
    expectedHash: formData.get('expectedHash') || '',
  };

  if (sourceType === 'server_path') {
    payload.serverPath = formData.get('serverPath') || '';
  } else {
    payload.remoteUrl = formData.get('remoteUrl') || '';
  }

  try {
    const submitResult = await apiFetch('/api/videos/import-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const jobId = submitResult.job?.id;
    if (!jobId) {
      throw new Error('导入任务创建失败');
    }

    const doneJob = await pollVideoJob(jobId, (job) => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(job.progress || 0) * 100)));
      remoteStatus.textContent = `状态: ${mapJobStatus(job.status)} | 阶段: ${mapJobStage(job.stage)} | ${pct}% | ${job.message || ''}`;
    });

    remoteStatus.textContent = `导入成功: ${doneJob.video?.title || doneJob.videoId || '已入库'}`;
    remoteImportForm.reset();
    sourceTypeEl.value = sourceType;
    updateSourceTypeView();
    await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms(), loadStorageInfo()]);
  } catch (err) {
    remoteStatus.textContent = `导入失败: ${err.message}`;
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

rootLoginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  rootStatusEl.textContent = '登录中...';

  const formData = new FormData(rootLoginForm);
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
    rootStatusEl.textContent = 'Root 登录成功';
    await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms(), loadStorageInfo()]);
  } catch (err) {
    rootStatusEl.textContent = `登录失败: ${err.message}`;
  }
});

rootLogoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/auth/root/logout', { method: 'POST' });
  } catch (_err) {
    // ignore
  }

  setRootToken('');
  rootStatusEl.textContent = 'Root 已退出';
  await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms(), loadStorageInfo()]);
});

sourceTypeEl.addEventListener('change', updateSourceTypeView);

async function checkRootState() {
  try {
    const result = await apiFetch('/api/auth/root/me');
    rootStatusEl.textContent = result.isRoot ? '当前已是 Root' : '未登录 Root';
  } catch (_err) {
    rootStatusEl.textContent = '未登录 Root';
  }
}

(async function init() {
  updateSourceTypeView();
  await Promise.all([
    loadStorageInfo(),
    loadSupportedFormats(),
    loadVideos(),
    loadPlaylists(),
    loadGlobalRooms(),
    checkRootState(),
  ]);
})();
