const authStatusEl = document.getElementById('authStatus');
const currentUserEl = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');

const playlistForm = document.getElementById('playlistForm');
const playlistStatus = document.getElementById('playlistStatus');
const playlistVideosEl = document.getElementById('playlistVideos');
const playlistListEl = document.getElementById('playlistList');

const videoListEl = document.getElementById('videoList');
const globalRoomListEl = document.getElementById('globalRoomList');

const {
  apiFetch,
  setAuthToken,
  formatDate,
  formatSeconds,
  formatBytes,
} = window.WatchPartyCommon;

let currentUser = null;
let videosCache = [];

function canDeleteRoom(room) {
  if (!currentUser) {
    return false;
  }
  return currentUser.role === 'root' || room.createdByUserId === currentUser.id;
}

function buildVideoCoverNode(video) {
  if (video.coverUrl) {
    const img = document.createElement('img');
    img.src = video.coverUrl;
    img.alt = `${video.title} cover`;
    img.className = 'cover-image';
    return img;
  }

  const empty = document.createElement('div');
  empty.className = 'cover-empty';
  empty.textContent = '无封面';
  return empty;
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

  if (canDeleteRoom(room)) {
    const actions = document.createElement('div');
    actions.className = 'flex';

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '删除放映室';
    deleteBtn.className = 'danger';
    deleteBtn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/rooms/${room.id}`, { method: 'DELETE' });
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

  const coverWrap = document.createElement('div');
  coverWrap.className = 'cover-wrap';
  coverWrap.appendChild(buildVideoCoverNode(video));

  const uniqueLink = document.createElement('a');
  uniqueLink.href = video.watchUrl;
  uniqueLink.textContent = `唯一链接: ${location.origin}${video.watchUrl}`;

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `上传时间: ${formatDate(video.createdAt)} | 文件: ${video.originalName} | 大小: ${formatBytes(video.size)} | hash: ${video.contentHash || '-'} | 形式: 本地模式（hash）`;

  const roomForm = document.createElement('form');
  roomForm.className = 'card';
  roomForm.innerHTML = `
    <div class="form-row">
      <label>放映室名称</label>
      <input name="roomName" placeholder="可选" />
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
        }),
      });
      window.location.href = `/rooms/${result.room.id}`;
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
  item.appendChild(coverWrap);
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
    row.innerHTML = `<div>第 ${ep.episodeIndex + 1} 集: <a href="${ep.watchUrl}">${ep.title}</a></div><div class="small">形式: 本地模式（hash） | hash: ${ep.contentHash || '-'} | ${formatBytes(ep.size)}</div>`;
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
      <label>起播集数</label>
      <select name="startEpisodeIndex">${startOptions}</select>
    </div>
    <button type="submit">基于此列表创建放映室</button>
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
          startEpisodeIndex: Number(formData.get('startEpisodeIndex') || 0),
        }),
      });
      window.location.href = `/rooms/${result.room.id}`;
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

async function loadVideos() {
  const data = await apiFetch('/api/videos');
  videosCache = data.videos || [];
  refreshPlaylistVideoOptions();

  videoListEl.innerHTML = '';
  if (!videosCache.length) {
    videoListEl.innerHTML = '<div class="small">还没有登记任何视频</div>';
    return;
  }

  videosCache.forEach((video) => videoListEl.appendChild(renderVideoCard(video)));
}

async function loadPlaylists() {
  const data = await apiFetch('/api/playlists');
  playlistListEl.innerHTML = '';

  if (!data.playlists.length) {
    playlistListEl.innerHTML = '<div class="small">还没有创建视频列表</div>';
    return;
  }

  data.playlists.forEach((playlist) => playlistListEl.appendChild(renderPlaylistCard(playlist)));
}

async function loadGlobalRooms() {
  const data = await apiFetch('/api/rooms');
  globalRoomListEl.innerHTML = '';

  if (!data.rooms.length) {
    globalRoomListEl.innerHTML = '<div class="small">当前没有放映室</div>';
    return;
  }

  data.rooms.forEach((room) => globalRoomListEl.appendChild(renderRoomRow(room)));
}

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

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (_err) {
    // ignore
  }
  setAuthToken('');
  window.location.href = '/';
});

async function checkAuth() {
  try {
    const result = await apiFetch('/api/auth/me');
    currentUser = result.user;
    currentUserEl.textContent = `${currentUser.username} (${currentUser.role})`;
    authStatusEl.textContent = '登录状态有效';
    return true;
  } catch (_err) {
    currentUser = null;
    setAuthToken('');
    authStatusEl.textContent = '请先登录，正在跳转...';
    window.location.href = '/';
    return false;
  }
}

(async function init() {
  const authed = await checkAuth();
  if (!authed) {
    return;
  }
  await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms()]);
})();
