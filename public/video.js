const videoId = window.location.pathname.split('/').filter(Boolean).pop();

const videoTitleEl = document.getElementById('videoTitle');
const videoPlayerEl = document.getElementById('videoPlayer');
const videoMetaEl = document.getElementById('videoMeta');
const videoLinkEl = document.getElementById('videoLink');
const roomListEl = document.getElementById('roomList');
const authInfoEl = document.getElementById('authInfo');
const videoContentEl = document.getElementById('videoContent');
const roomListCardEl = document.getElementById('roomListCard');

const createRoomForm = document.getElementById('createRoomForm');
const roomStatusEl = document.getElementById('roomStatus');

const AUTH_TOKEN_KEY = 'auth_token';
let currentUser = null;

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
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

function canDeleteRoom(room) {
  if (!currentUser) {
    return false;
  }
  return currentUser.role === 'root' || room.createdByUserId === currentUser.id;
}

async function deleteRoom(roomId) {
  await apiFetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
}

function renderRoomRow(room) {
  const row = document.createElement('div');
  row.className = 'room-item';

  const link = document.createElement('a');
  link.href = `/rooms/${room.id}`;
  link.textContent = room.name;

  const info = document.createElement('div');
  info.className = 'small';
  info.textContent = `模式: ${room.roomMode || 'cloud'} | 创建者: ${room.creatorName} | 在线: ${room.memberCount || 0} | 创建时间: ${formatDate(room.createdAt)} | 续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

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
        await deleteRoom(room.id);
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
  if (video.mediaUrl) {
    videoPlayerEl.classList.remove('hidden');
    videoPlayerEl.src = video.mediaUrl;
  } else {
    videoPlayerEl.classList.add('hidden');
    videoPlayerEl.removeAttribute('src');
    videoPlayerEl.load();
  }
  videoMetaEl.textContent = `上传时间: ${formatDate(video.createdAt)} | 文件: ${video.originalName} | 来源: ${video.sourceType} | 本地: ${video.localAvailable ? '有' : '无'} | OSS: ${video.storedInOss ? '有' : '无'}`;
  const cloudModeOption = document.querySelector('#roomMode option[value="cloud"]');
  if (cloudModeOption) {
    cloudModeOption.disabled = !video.mediaUrl;
  }
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
  const roomMode = String(formData.get('roomMode') || '').trim();
  if (!roomMode) {
    roomStatusEl.textContent = '请选择播放模式';
    return;
  }

  try {
    const result = await apiFetch(`/api/videos/${videoId}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        roomName: formData.get('roomName') || '',
        roomMode,
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
    authInfoEl.textContent = `已登录: ${currentUser.username} (${currentUser.role})`;
    return true;
  } catch (_err) {
    currentUser = null;
    authInfoEl.innerHTML = '未登录，请先前往 <a href="/">主页登录</a>';
    videoContentEl.classList.add('hidden');
    roomListCardEl.classList.add('hidden');
    return false;
  }
}

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
