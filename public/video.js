const videoId = window.location.pathname.split('/').filter(Boolean).pop();

const videoTitleEl = document.getElementById('videoTitle');
const videoPlayerEl = document.getElementById('videoPlayer');
const videoMetaEl = document.getElementById('videoMeta');
const videoLinkEl = document.getElementById('videoLink');
const roomListEl = document.getElementById('roomList');

const createRoomForm = document.getElementById('createRoomForm');
const roomStatusEl = document.getElementById('roomStatus');

const ROOT_TOKEN_KEY = 'root_token';

function getRootToken() {
  return localStorage.getItem(ROOT_TOKEN_KEY) || '';
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

async function deleteRoom(roomId) {
  const creatorToken = getCreatorToken(roomId);
  const headers = {};
  if (creatorToken) {
    headers['x-creator-token'] = creatorToken;
  }

  await apiFetch(`/api/rooms/${roomId}`, {
    method: 'DELETE',
    headers,
  });
}

function renderRoomRow(room) {
  const row = document.createElement('div');
  row.className = 'room-item';

  const link = document.createElement('a');
  link.href = `/rooms/${room.id}`;
  link.textContent = room.name;

  const info = document.createElement('div');
  info.className = 'small';
  info.textContent = `创建者: ${room.creatorName} | 在线: ${room.memberCount || 0} | 创建时间: ${formatDate(room.createdAt)} | 续播: 第 ${Number(room.latestEpisodeIndex || 0) + 1} 集 ${formatSeconds(room.latestCurrentTime || 0)} | 累计观看: ${formatSeconds(room.totalWatchedSeconds || 0)}`;

  row.appendChild(link);
  row.appendChild(info);

  if (getCreatorToken(room.id) || getRootToken()) {
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
  videoPlayerEl.src = video.mediaUrl;
  videoMetaEl.textContent = `上传时间: ${formatDate(video.createdAt)} | 文件: ${video.originalName} | 本地: ${video.localAvailable ? '有' : '无'} | OSS: ${video.storedInOss ? '有' : '无'}`;
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
        creatorName: formData.get('creatorName') || '匿名用户',
      }),
    });

    setCreatorToken(result.room.id, result.creatorToken);
    location.href = `/rooms/${result.room.id}?name=${encodeURIComponent(formData.get('creatorName') || '')}`;
  } catch (err) {
    roomStatusEl.textContent = `创建失败: ${err.message}`;
  }
});

(async function init() {
  try {
    await loadVideo();
  } catch (err) {
    videoTitleEl.textContent = '视频不存在或已删除';
    videoMetaEl.textContent = err.message;
  }
})();
