const authStatusEl = document.getElementById('authStatus');
const currentUserEl = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');
const adminContentEl = document.getElementById('adminContent');

const videoListEl = document.getElementById('videoList');
const playlistListEl = document.getElementById('playlistList');
const roomListEl = document.getElementById('roomList');

const videoSearchInput = document.getElementById('videoSearchInput');
const playlistSearchInput = document.getElementById('playlistSearchInput');
const roomSearchInput = document.getElementById('roomSearchInput');

const {
  apiFetch,
  setAuthToken,
  formatDate,
  formatSeconds,
  formatBytes,
  shortenHash,
} = window.WatchPartyCommon;

let currentUser = null;
let videosCache = [];
let playlistsCache = [];
let roomsCache = [];

function toSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function matchesKeyword(value, keyword) {
  return toSearchText(value).includes(keyword);
}

function renderAuthStatus() {
  if (!currentUser) {
    setAuthToken('');
    authStatusEl.textContent = '未登录，正在跳转...';
    window.location.href = '/';
    return false;
  }

  currentUserEl.textContent = `${currentUser.username} (${currentUser.role})`;

  if (currentUser.role !== 'root') {
    authStatusEl.textContent = `当前用户 ${currentUser.username} 不是 Root，无权限访问管理台`;
    adminContentEl.classList.add('hidden');
    return false;
  }

  authStatusEl.textContent = `已登录 Root: ${currentUser.username}`;
  adminContentEl.classList.remove('hidden');
  return true;
}

function renderRoomCard(room) {
  const card = document.createElement('article');
  card.className = 'room-card';

  const name = document.createElement('a');
  name.href = `/rooms/${room.id}`;
  name.className = 'room-title';
  name.textContent = room.name;

  const info = document.createElement('div');
  info.className = 'small';
  info.textContent = `${room.sourceLabel || `视频: ${room.videoTitle || '-'}`} | 创建者: ${room.creatorName || '-'} | 在线: ${room.memberCount || 0}`;

  const progress = document.createElement('div');
  progress.className = 'small';
  progress.textContent = `续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

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
  card.appendChild(name);
  card.appendChild(info);
  card.appendChild(progress);
  card.appendChild(createdAt);
  card.appendChild(action);
  return card;
}

function renderVideoCard(video) {
  const card = document.createElement('article');
  card.className = 'media-card';

  const title = document.createElement('h3');
  const link = document.createElement('a');
  link.href = `/videos/${video.id}`;
  link.textContent = video.title;
  title.appendChild(link);

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `文件: ${video.originalName || '-'} | 大小: ${formatBytes(video.size)} | hash: ${shortenHash(video.contentHash)} | 房间数: ${Array.isArray(video.rooms) ? video.rooms.length : 0} | 创建时间: ${formatDate(video.createdAt)}`;

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
  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(action);
  return card;
}

function renderPlaylistCard(playlist) {
  const card = document.createElement('article');
  card.className = 'media-card';

  const title = document.createElement('h3');
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
  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(action);
  return card;
}

function renderRooms() {
  const keyword = toSearchText(roomSearchInput.value);
  const list = !keyword
    ? roomsCache
    : roomsCache.filter((room) => (
      matchesKeyword(room.name, keyword)
      || matchesKeyword(room.creatorName, keyword)
      || matchesKeyword(room.sourceLabel, keyword)
      || matchesKeyword(room.videoTitle, keyword)
      || matchesKeyword(room.playlistName, keyword)
    ));

  roomListEl.innerHTML = '';
  if (!list.length) {
    roomListEl.innerHTML = '<div class="small">当前没有匹配的放映室</div>';
    return;
  }

  list.forEach((room) => roomListEl.appendChild(renderRoomCard(room)));
}

function renderVideos() {
  const keyword = toSearchText(videoSearchInput.value);
  const list = !keyword
    ? videosCache
    : videosCache.filter((video) => (
      matchesKeyword(video.title, keyword)
      || matchesKeyword(video.originalName, keyword)
      || matchesKeyword(video.contentHash, keyword)
    ));

  videoListEl.innerHTML = '';
  if (!list.length) {
    videoListEl.innerHTML = '<div class="small">当前没有匹配的视频</div>';
    return;
  }

  list.forEach((video) => videoListEl.appendChild(renderVideoCard(video)));
}

function renderPlaylists() {
  const keyword = toSearchText(playlistSearchInput.value);
  const list = !keyword
    ? playlistsCache
    : playlistsCache.filter((playlist) => (
      matchesKeyword(playlist.name, keyword)
      || matchesKeyword(playlist.description, keyword)
    ));

  playlistListEl.innerHTML = '';
  if (!list.length) {
    playlistListEl.innerHTML = '<div class="small">当前没有匹配的视频列表</div>';
    return;
  }

  list.forEach((playlist) => playlistListEl.appendChild(renderPlaylistCard(playlist)));
}

async function loadRooms() {
  const data = await apiFetch('/api/admin/rooms');
  roomsCache = data.rooms || [];
  renderRooms();
}

async function loadVideos() {
  const data = await apiFetch('/api/videos');
  videosCache = data.videos || [];
  renderVideos();
}

async function loadPlaylists() {
  const data = await apiFetch('/api/playlists');
  playlistsCache = data.playlists || [];
  renderPlaylists();
}

videoSearchInput.addEventListener('input', renderVideos);
playlistSearchInput.addEventListener('input', renderPlaylists);
roomSearchInput.addEventListener('input', renderRooms);

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (_err) {
    // ignore
  }
  setAuthToken('');
  currentUser = null;
  window.location.href = '/';
});

async function checkAuth() {
  try {
    const result = await apiFetch('/api/auth/me');
    currentUser = result.user || null;
  } catch (_err) {
    currentUser = null;
  }
  return renderAuthStatus();
}

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
