const videoId = window.location.pathname.split('/').filter(Boolean).pop();

const videoTitleEl = document.getElementById('videoTitle');
const videoCoverWrapEl = document.getElementById('videoCoverWrap');
const videoMetaEl = document.getElementById('videoMeta');
const videoLinkEl = document.getElementById('videoLink');
const roomListEl = document.getElementById('roomList');
const authStatusEl = document.getElementById('authStatus');
const currentUserEl = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');
const videoContentEl = document.getElementById('videoContent');
const roomListCardEl = document.getElementById('roomListCard');

const createRoomForm = document.getElementById('createRoomForm');
const roomStatusEl = document.getElementById('roomStatus');

const {
  apiFetch,
  setAuthToken,
  formatDate,
  formatSeconds,
  formatBytes,
} = window.WatchPartyCommon;

let currentUser = null;

function canDeleteRoom(room) {
  if (!currentUser) {
    return false;
  }
  return currentUser.role === 'root' || room.createdByUserId === currentUser.id;
}

function renderCover(video) {
  videoCoverWrapEl.innerHTML = '';
  if (video.coverUrl) {
    const img = document.createElement('img');
    img.src = video.coverUrl;
    img.alt = `${video.title} cover`;
    img.className = 'cover-image';
    videoCoverWrapEl.appendChild(img);
    return;
  }

  const empty = document.createElement('div');
  empty.className = 'cover-empty';
  empty.textContent = '无封面';
  videoCoverWrapEl.appendChild(empty);
}

function renderRoomRow(room) {
  const row = document.createElement('article');
  row.className = 'room-card';

  const link = document.createElement('a');
  link.href = `/rooms/${room.id}`;
  link.className = 'room-title';
  link.textContent = room.name;

  const info = document.createElement('div');
  info.className = 'small';
  info.textContent = `创建者: ${room.creatorName} | 在线: ${room.memberCount || 0} | 创建时间: ${formatDate(room.createdAt)} | 续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

  row.appendChild(link);
  row.appendChild(info);

  if (canDeleteRoom(room)) {
    const action = document.createElement('div');
    action.className = 'flex';

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除放映室';
    del.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/rooms/${room.id}`, { method: 'DELETE' });
        await loadVideo();
      } catch (err) {
        alert(err.message);
      }
    });

    action.appendChild(del);
    row.appendChild(action);
  }

  return row;
}

async function loadVideo() {
  const data = await apiFetch(`/api/videos/${videoId}`);
  const video = data.video;

  videoTitleEl.textContent = video.title;
  renderCover(video);
  videoMetaEl.textContent = `上传时间: ${formatDate(video.createdAt)} | 文件: ${video.originalName} | 大小: ${formatBytes(video.size)} | 来源: 本地模式（hash） | hash: ${video.contentHash || '-'}`;
  videoLinkEl.innerHTML = `唯一链接: <a href="${video.watchUrl}">${location.origin}${video.watchUrl}</a>`;

  roomListEl.innerHTML = '';
  if (!video.rooms.length) {
    roomListEl.innerHTML = '<div class="small">当前视频还没有放映室</div>';
    return;
  }

  video.rooms.forEach((room) => roomListEl.appendChild(renderRoomRow(room)));
}

createRoomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  roomStatusEl.textContent = '创建中...';

  const formData = new FormData(createRoomForm);
  try {
    const result = await apiFetch(`/api/videos/${videoId}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        roomName: formData.get('roomName') || '',
      }),
    });

    location.href = `/rooms/${result.room.id}`;
  } catch (err) {
    roomStatusEl.textContent = `创建失败: ${err.message}`;
  }
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
    authStatusEl.textContent = '未登录，正在跳转...';
    videoContentEl.classList.add('hidden');
    roomListCardEl.classList.add('hidden');
    window.location.href = '/';
    return false;
  }
}

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch (_err) {
    // ignore
  }
  setAuthToken('');
  window.location.href = '/';
});

(async function init() {
  const authed = await checkAuth();
  if (!authed) {
    return;
  }

  videoContentEl.classList.remove('hidden');
  roomListCardEl.classList.remove('hidden');

  try {
    await loadVideo();
  } catch (err) {
    videoTitleEl.textContent = '视频不存在或已删除';
    videoMetaEl.textContent = err.message;
  }
})();
