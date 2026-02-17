const authStatusEl = document.getElementById('authStatus');
const adminContentEl = document.getElementById('adminContent');
const logoutBtn = document.getElementById('logoutBtn');

const videoListEl = document.getElementById('videoList');
const playlistListEl = document.getElementById('playlistList');
const roomListEl = document.getElementById('roomList');

const {
  apiFetch,
  setAuthToken,
  formatDate,
  formatSeconds,
  formatBytes,
} = window.WatchPartyCommon;

let currentUser = null;

function renderAuthStatus() {
  if (!currentUser) {
    authStatusEl.innerHTML = '未登录，请先前往 <a href="/">主页登录</a>';
    adminContentEl.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    return;
  }

  if (currentUser.role !== 'root') {
    authStatusEl.textContent = `当前用户 ${currentUser.username} 不是 Root，无权限访问管理台`;
    adminContentEl.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
    return;
  }

  authStatusEl.textContent = `已登录 Root: ${currentUser.username}`;
  adminContentEl.classList.remove('hidden');
  logoutBtn.classList.remove('hidden');
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
    info.textContent = `${room.sourceLabel || `视频: ${room.videoTitle || '-'}`} | 创建者: ${room.creatorName || '-'} | 在线: ${room.memberCount || 0} | 续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

    const createdAt = document.createElement('div');
    createdAt.className = 'small';
    createdAt.textContent = `创建时间: ${formatDate(room.createdAt)}`;

    const action = document.createElement('div');
    action.className = 'flex';

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '删除放映室';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`确认删除放映室「${room.name}」？`)) {
        return;
      }
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

function renderVideos(videos) {
  videoListEl.innerHTML = '';
  if (!videos.length) {
    videoListEl.innerHTML = '<div class="small">当前没有视频</div>';
    return;
  }

  videos.forEach((video) => {
    const row = document.createElement('div');
    row.className = 'video-item';

    const title = document.createElement('a');
    title.href = `/videos/${video.id}`;
    title.textContent = video.title;

    const meta = document.createElement('div');
    meta.className = 'small';
    meta.textContent = `文件: ${video.originalName || '-'} | 大小: ${formatBytes(video.size)} | hash: ${video.contentHash || '-'} | 房间数: ${Array.isArray(video.rooms) ? video.rooms.length : 0} | 创建时间: ${formatDate(video.createdAt)}`;

    const action = document.createElement('div');
    action.className = 'flex';

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '删除视频';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`确认删除视频「${video.title}」？\n该视频关联放映室会被关闭。`)) {
        return;
      }
      try {
        const result = await apiFetch(`/api/admin/videos/${video.id}`, { method: 'DELETE' });
        await Promise.all([loadVideos(), loadPlaylists(), loadRooms()]);
        alert(`已删除视频，关闭放映室 ${Number(result.closedRooms || 0)} 个`);
      } catch (err) {
        alert(err.message);
      }
    });

    action.appendChild(delBtn);
    row.appendChild(title);
    row.appendChild(meta);
    row.appendChild(action);
    videoListEl.appendChild(row);
  });
}

function renderPlaylists(playlists) {
  playlistListEl.innerHTML = '';
  if (!playlists.length) {
    playlistListEl.innerHTML = '<div class="small">当前没有视频列表</div>';
    return;
  }

  playlists.forEach((playlist) => {
    const row = document.createElement('div');
    row.className = 'video-item';

    const title = document.createElement('div');
    title.textContent = playlist.name;

    const meta = document.createElement('div');
    meta.className = 'small';
    meta.textContent = `集数: ${Array.isArray(playlist.episodes) ? playlist.episodes.length : 0} | 房间数: ${Array.isArray(playlist.rooms) ? playlist.rooms.length : 0} | 创建时间: ${formatDate(playlist.createdAt)}`;

    const action = document.createElement('div');
    action.className = 'flex';

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '删除视频列表';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`确认删除视频列表「${playlist.name}」？\n关联放映室会被关闭。`)) {
        return;
      }
      try {
        const result = await apiFetch(`/api/admin/playlists/${playlist.id}`, { method: 'DELETE' });
        await Promise.all([loadPlaylists(), loadRooms()]);
        alert(`已删除视频列表，关闭放映室 ${Number(result.closedRooms || 0)} 个`);
      } catch (err) {
        alert(err.message);
      }
    });

    action.appendChild(delBtn);
    row.appendChild(title);
    row.appendChild(meta);
    row.appendChild(action);
    playlistListEl.appendChild(row);
  });
}

async function loadRooms() {
  const data = await apiFetch('/api/admin/rooms');
  renderRooms(data.rooms || []);
}

async function loadVideos() {
  const data = await apiFetch('/api/videos');
  renderVideos(data.videos || []);
}

async function loadPlaylists() {
  const data = await apiFetch('/api/playlists');
  renderPlaylists(data.playlists || []);
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

(async function init() {
  const isRoot = await checkAuth();
  if (!isRoot) {
    return;
  }

  try {
    await Promise.all([loadVideos(), loadPlaylists(), loadRooms()]);
  } catch (err) {
    authStatusEl.textContent = `加载管理数据失败: ${err.message}`;
    adminContentEl.classList.add('hidden');
  }
})();
