const authStatusEl = document.getElementById('authStatus');
const currentUserEl = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');

const playlistForm = document.getElementById('playlistForm');
const playlistStatus = document.getElementById('playlistStatus');
const playlistListEl = document.getElementById('playlistList');
const selectedCountEl = document.getElementById('selectedCount');

const videoListEl = document.getElementById('videoList');
const globalRoomListEl = document.getElementById('globalRoomList');
const libraryResultsEl = document.getElementById('libraryResults');
const selectedEpisodesEl = document.getElementById('selectedEpisodes');

const librarySearchInput = document.getElementById('librarySearch');
const videoSearchInput = document.getElementById('videoSearchInput');
const playlistSearchInput = document.getElementById('playlistSearchInput');
const roomSearchInput = document.getElementById('roomSearchInput');

const {
  apiFetch,
  setAuthToken,
  formatDate,
  formatSeconds,
  formatBytes,
} = window.WatchPartyCommon;

let currentUser = null;
let videosCache = [];
let playlistsCache = [];
let roomsCache = [];
let selectedEpisodeVideoIds = [];

function toSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function matchesKeyword(value, keyword) {
  return toSearchText(value).includes(keyword);
}

function canDeleteRoom(room) {
  if (!currentUser) {
    return false;
  }
  return currentUser.role === 'root' || room.createdByUserId === currentUser.id;
}

function buildVideoCoverNode(video, compact = false) {
  if (video.coverUrl) {
    const img = document.createElement('img');
    img.src = video.coverUrl;
    img.alt = `${video.title} cover`;
    img.className = compact ? 'cover-thumb' : 'cover-image';
    return img;
  }

  const empty = document.createElement('div');
  empty.className = compact ? 'cover-thumb cover-empty' : 'cover-empty';
  empty.textContent = '无封面';
  return empty;
}

function updateSelectedCount() {
  selectedCountEl.textContent = `${selectedEpisodeVideoIds.length} 集`;
}

function findVideoById(videoId) {
  return videosCache.find((item) => item.id === videoId) || null;
}

function renderLibraryResults() {
  const keyword = toSearchText(librarySearchInput.value);
  const list = !keyword
    ? videosCache
    : videosCache.filter((video) => (
      matchesKeyword(video.title, keyword)
      || matchesKeyword(video.originalName, keyword)
      || matchesKeyword(video.contentHash, keyword)
    ));

  libraryResultsEl.innerHTML = '';
  if (!list.length) {
    libraryResultsEl.innerHTML = '<div class="small">没有匹配的视频</div>';
    return;
  }

  list.forEach((video) => {
    const row = document.createElement('div');
    row.className = 'library-item';

    const cover = buildVideoCoverNode(video, true);
    const main = document.createElement('div');
    main.className = 'library-main';

    const title = document.createElement('div');
    title.className = 'library-title';
    title.textContent = video.title;

    const meta = document.createElement('div');
    meta.className = 'small';
    meta.textContent = `${video.originalName || '-'} | ${formatBytes(video.size)} | ${video.contentHash ? video.contentHash.slice(0, 12) : '-'}`;

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '加入';
    addBtn.addEventListener('click', () => {
      selectedEpisodeVideoIds.push(video.id);
      renderSelectedEpisodes();
    });

    main.appendChild(title);
    main.appendChild(meta);
    row.appendChild(cover);
    row.appendChild(main);
    row.appendChild(addBtn);
    libraryResultsEl.appendChild(row);
  });
}

function moveSelectedEpisode(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= selectedEpisodeVideoIds.length) {
    return;
  }
  const next = [...selectedEpisodeVideoIds];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  selectedEpisodeVideoIds = next;
  renderSelectedEpisodes();
}

function removeSelectedEpisode(index) {
  selectedEpisodeVideoIds = selectedEpisodeVideoIds.filter((_id, idx) => idx !== index);
  renderSelectedEpisodes();
}

function renderSelectedEpisodes() {
  selectedEpisodesEl.innerHTML = '';
  updateSelectedCount();

  if (!selectedEpisodeVideoIds.length) {
    selectedEpisodesEl.innerHTML = '<div class="small">还没有选择剧集，先从左侧视频库加入。</div>';
    return;
  }

  selectedEpisodeVideoIds.forEach((videoId, index) => {
    const video = findVideoById(videoId);
    const row = document.createElement('div');
    row.className = 'selected-item';

    const left = document.createElement('div');
    left.className = 'selected-main';

    const title = document.createElement('div');
    title.className = 'selected-title';
    title.textContent = `第 ${index + 1} 集 · ${video?.title || `未知视频(${videoId})`}`;

    const meta = document.createElement('div');
    meta.className = 'small';
    meta.textContent = video ? `${video.originalName || '-'} | ${formatBytes(video.size)}` : videoId;

    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'selected-actions';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'secondary';
    upBtn.textContent = '上移';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveSelectedEpisode(index, index - 1));

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'secondary';
    downBtn.textContent = '下移';
    downBtn.disabled = index === selectedEpisodeVideoIds.length - 1;
    downBtn.addEventListener('click', () => moveSelectedEpisode(index, index + 1));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', () => removeSelectedEpisode(index));

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    actions.appendChild(removeBtn);

    row.appendChild(left);
    row.appendChild(actions);
    selectedEpisodesEl.appendChild(row);
  });
}

async function deleteRoomAndReload(roomId) {
  await apiFetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
  await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms()]);
}

function renderRoomCard(room) {
  const card = document.createElement('article');
  card.className = 'room-card';

  const name = document.createElement('a');
  name.href = `/rooms/${room.id}`;
  name.className = 'room-title';
  name.textContent = room.name;

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `${room.sourceLabel || ''} | 创建者: ${room.creatorName || '-'} | 在线: ${room.memberCount || 0}`;

  const progress = document.createElement('div');
  progress.className = 'small';
  progress.textContent = `续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

  const created = document.createElement('div');
  created.className = 'small';
  created.textContent = `创建时间: ${formatDate(room.createdAt)}`;

  card.appendChild(name);
  card.appendChild(meta);
  card.appendChild(progress);
  card.appendChild(created);

  if (canDeleteRoom(room)) {
    const action = document.createElement('div');
    action.className = 'flex';

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.type = 'button';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(`确认删除放映室「${room.name}」？`)) {
        return;
      }
      try {
        await deleteRoomAndReload(room.id);
      } catch (err) {
        alert(err.message);
      }
    });

    action.appendChild(delBtn);
    card.appendChild(action);
  }

  return card;
}

function renderVideoCard(video) {
  const card = document.createElement('article');
  card.className = 'media-card';

  const title = document.createElement('h3');
  title.textContent = video.title;

  const coverLink = document.createElement('a');
  coverLink.href = video.watchUrl;
  coverLink.className = 'cover-wrap';
  coverLink.appendChild(buildVideoCoverNode(video, false));

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `${video.originalName || '-'} | ${formatBytes(video.size)} | ${video.contentHash || '-'} | ${formatDate(video.createdAt)}`;

  const roomForm = document.createElement('form');
  roomForm.className = 'quick-room-form';
  roomForm.innerHTML = `
    <input name="roomName" placeholder="放映室名称（可选）" />
    <button type="submit">创建放映室</button>
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

  const roomList = document.createElement('div');
  roomList.className = 'mini-room-list';
  if (!Array.isArray(video.rooms) || !video.rooms.length) {
    roomList.innerHTML = '<div class="small">暂无放映室</div>';
  } else {
    video.rooms.slice(0, 3).forEach((room) => {
      const roomItem = document.createElement('a');
      roomItem.href = `/rooms/${room.id}`;
      roomItem.className = 'mini-room-chip';
      roomItem.textContent = room.name;
      roomList.appendChild(roomItem);
    });
    if (video.rooms.length > 3) {
      const more = document.createElement('div');
      more.className = 'small';
      more.textContent = `还有 ${video.rooms.length - 3} 个放映室`;
      roomList.appendChild(more);
    }
  }

  card.appendChild(title);
  card.appendChild(coverLink);
  card.appendChild(meta);
  card.appendChild(roomForm);
  card.appendChild(roomList);
  return card;
}

function renderPlaylistCard(playlist) {
  const card = document.createElement('article');
  card.className = 'media-card';

  const title = document.createElement('h3');
  title.textContent = `${playlist.name} (${playlist.episodes.length} 集)`;

  const meta = document.createElement('div');
  meta.className = 'small';
  meta.textContent = `${playlist.description || '无描述'} | 创建时间: ${formatDate(playlist.createdAt)}`;

  const episodes = document.createElement('div');
  episodes.className = 'mini-room-list';
  playlist.episodes.slice(0, 6).forEach((ep) => {
    const chip = document.createElement('a');
    chip.href = ep.watchUrl;
    chip.className = 'mini-room-chip';
    chip.textContent = `E${ep.episodeIndex + 1} ${ep.title}`;
    episodes.appendChild(chip);
  });
  if (playlist.episodes.length > 6) {
    const more = document.createElement('div');
    more.className = 'small';
    more.textContent = `还有 ${playlist.episodes.length - 6} 集`;
    episodes.appendChild(more);
  }

  const roomForm = document.createElement('form');
  roomForm.className = 'quick-room-form';
  const startOptions = playlist.episodes
    .map((ep) => `<option value="${ep.episodeIndex}">第 ${ep.episodeIndex + 1} 集</option>`)
    .join('');
  roomForm.innerHTML = `
    <input name="roomName" placeholder="放映室名称（可选）" />
    <select name="startEpisodeIndex">${startOptions}</select>
    <button type="submit">创建放映室</button>
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
  roomList.className = 'mini-room-list';
  if (!playlist.rooms.length) {
    roomList.innerHTML = '<div class="small">暂无放映室</div>';
  } else {
    playlist.rooms.slice(0, 3).forEach((room) => {
      const roomItem = document.createElement('a');
      roomItem.href = `/rooms/${room.id}`;
      roomItem.className = 'mini-room-chip';
      roomItem.textContent = room.name;
      roomList.appendChild(roomItem);
    });
    if (playlist.rooms.length > 3) {
      const more = document.createElement('div');
      more.className = 'small';
      more.textContent = `还有 ${playlist.rooms.length - 3} 个放映室`;
      roomList.appendChild(more);
    }
  }

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(episodes);
  card.appendChild(roomForm);
  card.appendChild(roomList);
  return card;
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
    videoListEl.innerHTML = '<div class="small">没有匹配的视频</div>';
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
    playlistListEl.innerHTML = '<div class="small">没有匹配的视频列表</div>';
    return;
  }

  list.forEach((playlist) => playlistListEl.appendChild(renderPlaylistCard(playlist)));
}

function renderGlobalRooms() {
  const keyword = toSearchText(roomSearchInput.value);
  const list = !keyword
    ? roomsCache
    : roomsCache.filter((room) => (
      matchesKeyword(room.name, keyword)
      || matchesKeyword(room.creatorName, keyword)
      || matchesKeyword(room.sourceLabel, keyword)
    ));

  globalRoomListEl.innerHTML = '';
  if (!list.length) {
    globalRoomListEl.innerHTML = '<div class="small">没有匹配的放映室</div>';
    return;
  }

  list.forEach((room) => globalRoomListEl.appendChild(renderRoomCard(room)));
}

async function loadVideos() {
  const data = await apiFetch('/api/videos');
  videosCache = data.videos || [];
  renderVideos();
  renderLibraryResults();
}

async function loadPlaylists() {
  const data = await apiFetch('/api/playlists');
  playlistsCache = data.playlists || [];
  renderPlaylists();
}

async function loadGlobalRooms() {
  const data = await apiFetch('/api/rooms');
  roomsCache = data.rooms || [];
  renderGlobalRooms();
}

playlistForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  playlistStatus.textContent = '创建中...';

  const formData = new FormData(playlistForm);
  if (!selectedEpisodeVideoIds.length) {
    playlistStatus.textContent = '请先从视频库加入至少 1 集';
    return;
  }

  try {
    await apiFetch('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formData.get('name') || '',
        description: formData.get('description') || '',
        episodeVideoIds: selectedEpisodeVideoIds,
      }),
    });

    playlistStatus.textContent = '创建成功';
    playlistForm.reset();
    selectedEpisodeVideoIds = [];
    renderSelectedEpisodes();
    renderLibraryResults();
    await Promise.all([loadPlaylists(), loadGlobalRooms()]);
  } catch (err) {
    playlistStatus.textContent = `创建失败: ${err.message}`;
  }
});

librarySearchInput.addEventListener('input', renderLibraryResults);
videoSearchInput.addEventListener('input', renderVideos);
playlistSearchInput.addEventListener('input', renderPlaylists);
roomSearchInput.addEventListener('input', renderGlobalRooms);

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

  renderSelectedEpisodes();
  await Promise.all([loadVideos(), loadPlaylists(), loadGlobalRooms()]);
})();
