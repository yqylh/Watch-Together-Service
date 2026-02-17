const roomId = window.location.pathname.split('/').filter(Boolean).pop();

const roomTitleEl = document.getElementById('roomTitle');
const watchVideoEl = document.getElementById('watchVideo');
const playbackRateEl = document.getElementById('playbackRate');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const videoVolumeEl = document.getElementById('videoVolume');
const videoMuteBtn = document.getElementById('videoMuteBtn');
const voiceVolumeEl = document.getElementById('voiceVolume');
const voiceMuteBtn = document.getElementById('voiceMuteBtn');
const autoplayCountdownEl = document.getElementById('autoplayCountdown');
const cancelAutoplayBtn = document.getElementById('cancelAutoplayBtn');
const watchStatusEl = document.getElementById('watchStatus');
const deleteRoomBtn = document.getElementById('deleteRoomBtn');
const episodeListEl = document.getElementById('episodeList');

const joinCamEl = document.getElementById('joinCam');
const joinMicEl = document.getElementById('joinMic');
const displayNameEl = document.getElementById('displayName');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');

const localVideoEl = document.getElementById('localVideo');
const remoteGridEl = document.getElementById('remoteGrid');

const participantListEl = document.getElementById('participantList');
const chatListEl = document.getElementById('chatList');
const chatFormEl = document.getElementById('chatForm');
const chatInputEl = document.getElementById('chatInput');

const ROOT_TOKEN_KEY = 'root_token';

const socket = io();
const peers = new Map();
const participants = new Map();

let joined = false;
let localStream = null;
let playbackSuppressed = false;
let seekDebounce = null;
let roomData = null;
let episodes = [];
let currentEpisodeIndex = 0;
let episodeProgressByIndex = new Map();
let voiceVolumeLevel = 1;
let videoVolumeLevel = 1;
let voiceMuted = false;
let videoMuted = false;
let authoritativeState = null;
let microAdjustTimer = null;
let initialPlaybackAligned = false;
let autoNextTimer = null;
let autoNextRemaining = 0;
let autoNextTargetEpisode = null;
let driftSoftThresholdSec = 0.2;
let driftHardThresholdSec = 1.2;
let autoplayCountdownDefaultSec = 8;

function getRootToken() {
  return localStorage.getItem(ROOT_TOKEN_KEY) || '';
}

function creatorTokenKey(targetRoomId) {
  return `room_creator_token_${targetRoomId}`;
}

function getCreatorToken(targetRoomId) {
  return localStorage.getItem(creatorTokenKey(targetRoomId)) || '';
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

function setStatus(text) {
  watchStatusEl.textContent = text;
}

function setPlaybackSuppressed(durationMs = 280) {
  playbackSuppressed = true;
  setTimeout(() => {
    playbackSuppressed = false;
  }, durationMs);
}

function formatDate(value) {
  return new Date(value).toLocaleTimeString();
}

function appendChatMessage(message) {
  const item = document.createElement('div');
  item.className = 'chat-item';
  item.textContent = `[${formatDate(message.createdAt)}] ${message.senderName}: ${message.text}`;
  chatListEl.appendChild(item);
  chatListEl.scrollTop = chatListEl.scrollHeight;
}

function renderParticipants() {
  participantListEl.innerHTML = '';
  if (participants.size === 0) {
    participantListEl.innerHTML = '<div class="small">暂无成员</div>';
    return;
  }

  for (const [id, name] of participants.entries()) {
    const row = document.createElement('div');
    row.className = 'participant-item';
    row.textContent = id === socket.id ? `${name} (你)` : name;
    participantListEl.appendChild(row);
  }
}

function removeRemoteVideo(peerId) {
  const box = document.getElementById(`remote-${peerId}`);
  if (box) {
    box.remove();
  }
}

function applyVideoVolume() {
  watchVideoEl.volume = videoVolumeLevel;
  watchVideoEl.muted = videoMuted;
  videoMuteBtn.textContent = videoMuted ? '取消视频静音' : '视频静音';
}

function applyVoiceVolume() {
  const remoteVideos = remoteGridEl.querySelectorAll('video');
  remoteVideos.forEach((video) => {
    video.volume = voiceVolumeLevel;
    video.muted = voiceMuted;
  });
  localVideoEl.muted = true;
  voiceMuteBtn.textContent = voiceMuted ? '取消语音静音' : '语音静音';
}

function attachRemoteStream(peerId, peerName, stream) {
  let box = document.getElementById(`remote-${peerId}`);
  if (!box) {
    box = document.createElement('div');
    box.id = `remote-${peerId}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;

    const label = document.createElement('div');
    label.className = 'small';
    label.textContent = peerName || '远端用户';

    box.appendChild(video);
    box.appendChild(label);
    remoteGridEl.appendChild(box);
  }

  const video = box.querySelector('video');
  video.srcObject = stream;
  video.volume = voiceVolumeLevel;
  video.muted = voiceMuted;
}

function closePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) {
    return;
  }
  peer.pc.close();
  peers.delete(peerId);
  removeRemoteVideo(peerId);
}

async function createPeerConnection(peerId, peerName, shouldCreateOffer) {
  if (peers.has(peerId)) {
    return peers.get(peerId).pc;
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  peers.set(peerId, { pc, name: peerName || '远端用户' });

  let hasVideoTrack = false;
  let hasAudioTrack = false;
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      if (track.kind === 'video') {
        hasVideoTrack = true;
      }
      if (track.kind === 'audio') {
        hasAudioTrack = true;
      }
      pc.addTrack(track, localStream);
    });
  }

  if (!hasVideoTrack) {
    pc.addTransceiver('video', { direction: 'recvonly' });
  }
  if (!hasAudioTrack) {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    attachRemoteStream(peerId, peerName, stream);
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    socket.emit('webrtc-ice-candidate', {
      targetId: peerId,
      candidate: event.candidate,
    });
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      closePeer(peerId);
      participants.delete(peerId);
      renderParticipants();
    }
  };

  if (shouldCreateOffer) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', {
      targetId: peerId,
      sdp: offer,
    });
  }

  return pc;
}

async function prepareLocalMedia() {
  const wantVideo = joinCamEl.checked;
  const wantAudio = joinMicEl.checked;

  if (!wantVideo && !wantAudio) {
    localStream = null;
    localVideoEl.srcObject = null;
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: wantVideo,
      audio: wantAudio,
    });
    localVideoEl.srcObject = localStream;
    localVideoEl.volume = voiceVolumeLevel;
  } catch (err) {
    localStream = null;
    localVideoEl.srcObject = null;
    alert(`获取本地音视频失败，将仅使用聊天与同步播放: ${err.message}`);
  }
}

function emitPlayback(action, overrides = {}, force = false) {
  if (!joined || (!force && playbackSuppressed)) {
    return;
  }

  const duration = Number.isFinite(Number(watchVideoEl.duration)) ? Number(watchVideoEl.duration) : 0;
  const payload = {
    action,
    currentTime: Number.isFinite(Number(overrides.currentTime)) ? Number(overrides.currentTime) : (watchVideoEl.currentTime || 0),
    isPlaying: typeof overrides.isPlaying === 'boolean' ? overrides.isPlaying : !watchVideoEl.paused,
    playbackRate: Number.isFinite(Number(overrides.playbackRate)) ? Number(overrides.playbackRate) : (watchVideoEl.playbackRate || 1),
    episodeIndex: Number.isFinite(Number(overrides.episodeIndex)) ? Number(overrides.episodeIndex) : currentEpisodeIndex,
    duration: Number.isFinite(Number(overrides.duration)) ? Number(overrides.duration) : duration,
  };

  if (Number.isFinite(Number(overrides.countdownSeconds))) {
    payload.countdownSeconds = Number(overrides.countdownSeconds);
  }
  if (Number.isFinite(Number(overrides.countdownToEpisode))) {
    payload.countdownToEpisode = Number(overrides.countdownToEpisode);
  }

  socket.emit('playback-update', payload);
}

function waitForMetadata(video) {
  return new Promise((resolve) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }

    const onLoaded = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      resolve();
    };

    video.addEventListener('loadedmetadata', onLoaded);
  });
}

function normalizeEpisodeIndex(index) {
  if (!episodes.length) {
    return 0;
  }
  return Math.max(0, Math.min(Number(index) || 0, episodes.length - 1));
}

function setAuthoritativeState(state) {
  authoritativeState = state ? {
    ...state,
    episodeIndex: normalizeEpisodeIndex(state.episodeIndex),
    currentTime: Number(state.currentTime || 0),
    playbackRate: Number(state.playbackRate || 1),
    isPlaying: Boolean(state.isPlaying),
    receivedAtMs: Date.now(),
  } : null;
}

function getAuthoritativeTargetTime() {
  if (!authoritativeState) {
    return null;
  }
  let target = Number(authoritativeState.currentTime || 0);
  if (authoritativeState.isPlaying) {
    const elapsedSec = Math.max(0, (Date.now() - authoritativeState.receivedAtMs) / 1000);
    target += elapsedSec * Number(authoritativeState.playbackRate || 1);
  }
  return Math.max(0, target);
}

function clearMicroAdjustTimer() {
  if (!microAdjustTimer) {
    return;
  }
  clearTimeout(microAdjustTimer);
  microAdjustTimer = null;
}

function applyRoomPlaybackRate(baseRate) {
  const rate = Number.isFinite(Number(baseRate)) ? Number(baseRate) : 1;
  setPlaybackSuppressed(180);
  watchVideoEl.playbackRate = rate;
  playbackRateEl.value = String(rate);
}

function getEpisodeProgress(index) {
  return episodeProgressByIndex.get(normalizeEpisodeIndex(index)) || null;
}

function getEpisodeResumeTime(index) {
  const progress = getEpisodeProgress(index);
  const value = Number(progress?.lastPositionSeconds || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateLocalEpisodeProgress(episodeIndex, currentTime) {
  const index = normalizeEpisodeIndex(episodeIndex);
  const safeCurrent = Math.max(0, Number(currentTime || 0));
  const prev = getEpisodeProgress(index);
  episodeProgressByIndex.set(index, {
    episodeIndex: index,
    lastPositionSeconds: safeCurrent,
    maxPositionSeconds: Math.max(safeCurrent, Number(prev?.maxPositionSeconds || 0)),
    watchedSeconds: Number(prev?.watchedSeconds || 0),
    updatedAt: new Date().toISOString(),
  });
}

function cancelAutoNextCountdown(shouldNotify = false) {
  if (autoNextTimer) {
    clearInterval(autoNextTimer);
    autoNextTimer = null;
  }
  autoNextRemaining = 0;
  autoNextTargetEpisode = null;
  autoplayCountdownEl.classList.add('hidden');
  autoplayCountdownEl.textContent = '';
  cancelAutoplayBtn.classList.add('hidden');

  if (shouldNotify && joined) {
    emitPlayback('autoplay-cancel', { isPlaying: false }, true);
  }
}

function renderAutoNextCountdown() {
  if (!Number.isFinite(autoNextTargetEpisode) || autoNextRemaining <= 0) {
    autoplayCountdownEl.classList.add('hidden');
    cancelAutoplayBtn.classList.add('hidden');
    return;
  }
  autoplayCountdownEl.classList.remove('hidden');
  cancelAutoplayBtn.classList.remove('hidden');
  autoplayCountdownEl.textContent = `${autoNextRemaining}s 后自动播放下一集（第 ${autoNextTargetEpisode + 1} 集）`;
}

function startAutoNextCountdown(targetEpisode, seconds = autoplayCountdownDefaultSec, shouldNotify = false) {
  const nextEpisode = normalizeEpisodeIndex(targetEpisode);
  if (nextEpisode <= currentEpisodeIndex) {
    return;
  }

  cancelAutoNextCountdown(false);

  autoNextTargetEpisode = nextEpisode;
  autoNextRemaining = Math.max(1, Math.min(30, Math.floor(Number(seconds) || autoplayCountdownDefaultSec)));
  renderAutoNextCountdown();

  if (shouldNotify) {
    emitPlayback('autoplay-countdown', {
      countdownSeconds: autoNextRemaining,
      countdownToEpisode: nextEpisode,
      currentTime: Number.isFinite(Number(watchVideoEl.duration)) ? Number(watchVideoEl.duration) : (watchVideoEl.currentTime || 0),
      isPlaying: false,
    }, true);
  }

  autoNextTimer = setInterval(() => {
    autoNextRemaining -= 1;
    if (autoNextRemaining <= 0) {
      cancelAutoNextCountdown(false);
      switchEpisode(nextEpisode, true, true, { useSavedProgress: true }).catch((err) => {
        console.error('auto next failed', err);
      });
      return;
    }
    renderAutoNextCountdown();
  }, 1000);
}

function correctPlaybackDrift(options = {}) {
  if (!joined || !authoritativeState) {
    return;
  }

  const action = options.action || '';
  const targetTime = getAuthoritativeTargetTime();
  if (!Number.isFinite(targetTime)) {
    return;
  }

  const current = Number(watchVideoEl.currentTime || 0);
  const drift = targetTime - current;
  const absDrift = Math.abs(drift);
  const roomRate = Number(authoritativeState.playbackRate || 1);

  if (absDrift >= driftHardThresholdSec || options.forceSeek) {
    clearMicroAdjustTimer();
    setPlaybackSuppressed(260);
    watchVideoEl.currentTime = Math.max(0, targetTime);
    watchStatusEl.textContent = `已对齐房间进度 (${Math.round(drift * 1000)}ms)`;
    applyRoomPlaybackRate(roomRate);
    return;
  }

  if (authoritativeState.isPlaying && absDrift > driftSoftThresholdSec) {
    if (microAdjustTimer) {
      return;
    }
    const adjustedRate = drift > 0
      ? Math.min(4, roomRate * 1.08)
      : Math.max(0.25, roomRate * 0.92);

    setPlaybackSuppressed(260);
    watchVideoEl.playbackRate = adjustedRate;
    microAdjustTimer = setTimeout(() => {
      applyRoomPlaybackRate(roomRate);
      watchStatusEl.textContent = `漂移已微调 (${Math.round(drift * 1000)}ms)`;
    }, 1200);
    return;
  }

  if (!authoritativeState.isPlaying && absDrift > driftSoftThresholdSec) {
    clearMicroAdjustTimer();
    setPlaybackSuppressed(220);
    watchVideoEl.currentTime = Math.max(0, targetTime);
    applyRoomPlaybackRate(roomRate);
    return;
  }

  if (action === 'play' || action === 'seek' || action === 'episode-switch') {
    clearMicroAdjustTimer();
    applyRoomPlaybackRate(roomRate);
  }
}

function renderEpisodeList() {
  episodeListEl.innerHTML = '';
  if (!episodes.length) {
    episodeListEl.innerHTML = '<div class="small">当前房间无可播放剧集</div>';
    return;
  }

  episodes.forEach((ep, idx) => {
    const row = document.createElement('div');
    row.className = 'room-item';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = idx === currentEpisodeIndex ? '' : 'secondary';
    btn.textContent = `第 ${idx + 1} 集: ${ep.title}`;
    btn.addEventListener('click', async () => {
      await switchEpisode(idx, true, false);
    });

    const hash = document.createElement('div');
    hash.className = 'small';
    const progress = getEpisodeProgress(idx);
    const progressText = progress
      ? `进度: ${formatSeconds(progress.lastPositionSeconds || 0)} | 最远: ${formatSeconds(progress.maxPositionSeconds || 0)} | 已看: ${formatSeconds(progress.watchedSeconds || 0)}`
      : '进度: 未开始';
    hash.textContent = `hash: ${ep.contentHash || '-'} | ${progressText}`;

    row.appendChild(btn);
    row.appendChild(hash);
    episodeListEl.appendChild(row);
  });
}

async function setEpisode(index, options = {}) {
  if (!episodes.length) {
    return;
  }

  const nextIndex = Math.max(0, Math.min(Number(index) || 0, episodes.length - 1));
  const changed = currentEpisodeIndex !== nextIndex;
  currentEpisodeIndex = nextIndex;

  const episode = episodes[currentEpisodeIndex];
  if (!episode) {
    return;
  }

  if (changed || watchVideoEl.src !== new URL(episode.mediaUrl, window.location.origin).href) {
    watchVideoEl.src = episode.mediaUrl;
    await waitForMetadata(watchVideoEl);
  }

  if (Number.isFinite(Number(options.resumeTime))) {
    watchVideoEl.currentTime = Math.max(0, Number(options.resumeTime));
  } else if (options.useSavedProgress) {
    const savedTime = getEpisodeResumeTime(currentEpisodeIndex);
    if (savedTime > 0) {
      watchVideoEl.currentTime = savedTime;
    }
  }

  renderEpisodeList();
}

async function switchEpisode(index, shouldEmit, autoPlayNext, options = {}) {
  cancelAutoNextCountdown(false);
  setPlaybackSuppressed(350);
  await setEpisode(index, {
    resumeTime: options.resumeTime,
    useSavedProgress: options.useSavedProgress !== false,
  });
  if (!Number.isFinite(Number(options.resumeTime)) && options.useSavedProgress === false) {
    watchVideoEl.currentTime = 0;
  }
  if (autoPlayNext) {
    watchVideoEl.play().catch(() => {});
  } else {
    watchVideoEl.pause();
  }
  if (shouldEmit) {
    emitPlayback('episode-switch', {
      episodeIndex: currentEpisodeIndex,
      currentTime: watchVideoEl.currentTime || 0,
      isPlaying: Boolean(autoPlayNext),
      playbackRate: watchVideoEl.playbackRate || 1,
    }, true);
  }
}

async function applyPlaybackState(state, actionHint) {
  if (!state) {
    return;
  }

  const action = actionHint || state.action;
  setAuthoritativeState(state);

  if (action === 'autoplay-cancel') {
    cancelAutoNextCountdown(false);
  }

  const episodeIndex = normalizeEpisodeIndex(state.episodeIndex);
  await setEpisode(episodeIndex);
  applyRoomPlaybackRate(state.playbackRate);

  if (action === 'autoplay-countdown') {
    watchVideoEl.pause();
    const countdownTo = Number.isFinite(Number(state.countdownToEpisode))
      ? Number(state.countdownToEpisode)
      : Math.min(currentEpisodeIndex + 1, Math.max(0, episodes.length - 1));
    startAutoNextCountdown(countdownTo, Number(state.countdownSeconds || autoplayCountdownDefaultSec), false);
    initialPlaybackAligned = true;
    return;
  }

  cancelAutoNextCountdown(false);

  if (state.isPlaying || action === 'play') {
    watchVideoEl.play().catch(() => {});
  } else if (action === 'pause' || action === 'seek' || !state.isPlaying) {
    watchVideoEl.pause();
  }

  correctPlaybackDrift({
    action,
    forceSeek: !initialPlaybackAligned || action === 'seek' || action === 'episode-switch',
  });
  initialPlaybackAligned = true;
  updateLocalEpisodeProgress(currentEpisodeIndex, watchVideoEl.currentTime || 0);
  renderEpisodeList();
}

function maybeCorrectPlaybackDrift() {
  if (!joined || playbackSuppressed || !authoritativeState) {
    return;
  }
  if (!watchVideoEl.paused || authoritativeState.isPlaying) {
    correctPlaybackDrift({ action: 'drift-tick' });
  }
}

async function joinRoom() {
  if (joined) {
    return;
  }

  const displayName = (displayNameEl.value || '').trim() || `用户-${Math.random().toString(16).slice(2, 7)}`;

  try {
    await prepareLocalMedia();
  } catch (_err) {
    // ignore
  }

  socket.emit('join-room', { roomId, displayName }, (result) => {
    if (!result?.ok) {
      setStatus(result?.error || '加入失败');
      return;
    }

    joined = true;
    setStatus('已加入放映室');
    participants.set(socket.id, displayName);
    renderParticipants();
  });
}

function leaveRoom() {
  if (joined) {
    socket.emit('leave-room');
  }
  joined = false;
  initialPlaybackAligned = false;
  setAuthoritativeState(null);
  cancelAutoNextCountdown(false);
  clearMicroAdjustTimer();

  for (const peerId of peers.keys()) {
    closePeer(peerId);
  }

  participants.clear();
  renderParticipants();

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideoEl.srcObject = null;

  setStatus('已离开放映室');
}

async function initRoomInfo() {
  const result = await apiFetch(`/api/rooms/${roomId}`);
  roomData = result;
  const syncConfig = result.syncConfig || {};
  driftSoftThresholdSec = Math.max(0.05, Number(syncConfig.driftSoftThresholdMs || 200) / 1000);
  driftHardThresholdSec = Math.max(
    driftSoftThresholdSec,
    Number(syncConfig.driftHardThresholdMs || 1200) / 1000,
  );
  autoplayCountdownDefaultSec = Math.max(3, Math.min(30, Number(syncConfig.autoplayCountdownSeconds || 8)));

  roomTitleEl.textContent = `${result.room.name} (${result.playlist.name})`;
  episodes = result.playlist.episodes || [];
  currentEpisodeIndex = Number(result.state?.episodeIndex || result.room.startEpisodeIndex || 0);
  episodeProgressByIndex = new Map(
    (result.progress?.episodes || []).map((item) => [Number(item.episodeIndex || 0), item]),
  );

  const queryName = new URLSearchParams(window.location.search).get('name');
  if (queryName) {
    displayNameEl.value = queryName;
  }

  const canDelete = Boolean(getCreatorToken(roomId) || getRootToken());
  if (canDelete) {
    deleteRoomBtn.classList.remove('hidden');
  }

  await setEpisode(currentEpisodeIndex, {
    resumeTime: Number(result.state?.currentTime || 0),
  });
  videoVolumeLevel = Math.max(0, Math.min(1, Number(videoVolumeEl.value || 100) / 100));
  voiceVolumeLevel = Math.max(0, Math.min(1, Number(voiceVolumeEl.value || 100) / 100));
  applyVideoVolume();
  applyVoiceVolume();

  if (Number.isFinite(Number(result.state?.playbackRate))) {
    watchVideoEl.playbackRate = Number(result.state.playbackRate);
    playbackRateEl.value = String(result.state.playbackRate);
  }
  setAuthoritativeState(result.state || null);
}

async function deleteCurrentRoom() {
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

joinBtn.addEventListener('click', () => {
  joinRoom().catch((err) => setStatus(`加入失败: ${err.message}`));
});

leaveBtn.addEventListener('click', () => {
  leaveRoom();
});

chatFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = (chatInputEl.value || '').trim();
  if (!text || !joined) {
    return;
  }
  socket.emit('chat-message', { text });
  chatInputEl.value = '';
});

watchVideoEl.addEventListener('play', () => {
  cancelAutoNextCountdown(false);
  emitPlayback('play');
});
watchVideoEl.addEventListener('pause', () => emitPlayback('pause'));
watchVideoEl.addEventListener('seeking', () => {
  cancelAutoNextCountdown(false);
  if (seekDebounce) {
    clearTimeout(seekDebounce);
  }
  seekDebounce = setTimeout(() => emitPlayback('seek'), 150);
});

watchVideoEl.addEventListener('ratechange', () => {
  if (playbackSuppressed) {
    return;
  }
  cancelAutoNextCountdown(false);
  playbackRateEl.value = String(watchVideoEl.playbackRate || 1);
  emitPlayback('ratechange', { playbackRate: watchVideoEl.playbackRate || 1 });
});

playbackRateEl.addEventListener('change', () => {
  cancelAutoNextCountdown(false);
  const rate = Number(playbackRateEl.value || 1);
  setPlaybackSuppressed(180);
  watchVideoEl.playbackRate = rate;
  emitPlayback('ratechange', { playbackRate: rate }, true);
});

videoVolumeEl.addEventListener('input', () => {
  videoVolumeLevel = Math.max(0, Math.min(1, Number(videoVolumeEl.value || 0) / 100));
  applyVideoVolume();
});

videoMuteBtn.addEventListener('click', () => {
  videoMuted = !videoMuted;
  applyVideoVolume();
});

voiceVolumeEl.addEventListener('input', () => {
  voiceVolumeLevel = Math.max(0, Math.min(1, Number(voiceVolumeEl.value || 0) / 100));
  applyVoiceVolume();
});

voiceMuteBtn.addEventListener('click', () => {
  voiceMuted = !voiceMuted;
  applyVoiceVolume();
});

cancelAutoplayBtn.addEventListener('click', () => {
  cancelAutoNextCountdown(true);
});

fullscreenBtn.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await watchVideoEl.requestFullscreen();
    }
  } catch (_err) {
    // ignore
  }
});

watchVideoEl.addEventListener('ended', () => {
  if (!joined) {
    return;
  }
  if (currentEpisodeIndex < episodes.length - 1) {
    startAutoNextCountdown(currentEpisodeIndex + 1, autoplayCountdownDefaultSec, true);
  }
});

deleteRoomBtn.addEventListener('click', async () => {
  try {
    await deleteCurrentRoom();
  } catch (err) {
    alert(err.message);
  }
});

socket.on('existing-participants', async ({ participants: list }) => {
  for (const member of list) {
    participants.set(member.id, member.name);
    try {
      await createPeerConnection(member.id, member.name, true);
    } catch (err) {
      console.error('create offer failed', err);
    }
  }
  renderParticipants();
});

socket.on('participant-joined', ({ id, name }) => {
  participants.set(id, name);
  renderParticipants();
});

socket.on('participant-left', ({ id }) => {
  participants.delete(id);
  closePeer(id);
  renderParticipants();
});

socket.on('chat-history', ({ messages }) => {
  chatListEl.innerHTML = '';
  messages.forEach(appendChatMessage);
});

socket.on('chat-message', (message) => {
  appendChatMessage(message);
});

socket.on('playback-state', (state) => {
  applyPlaybackState(state, state?.isPlaying ? 'play' : 'pause').catch((err) => {
    console.error('apply playback state failed', err);
  });
});

socket.on('playback-update', (state) => {
  applyPlaybackState(state, state?.action).catch((err) => {
    console.error('apply playback update failed', err);
  });
});

socket.on('webrtc-offer', async ({ fromId, sdp, name }) => {
  try {
    participants.set(fromId, name || '远端用户');
    renderParticipants();

    const pc = await createPeerConnection(fromId, name, false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('webrtc-answer', {
      targetId: fromId,
      sdp: answer,
    });
  } catch (err) {
    console.error('webrtc-offer handling failed', err);
  }
});

socket.on('webrtc-answer', async ({ fromId, sdp }) => {
  const peer = peers.get(fromId);
  if (!peer) {
    return;
  }
  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (err) {
    console.error('set answer failed', err);
  }
});

socket.on('webrtc-ice-candidate', async ({ fromId, candidate }) => {
  const peer = peers.get(fromId);
  if (!peer || !candidate) {
    return;
  }

  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('add ICE failed', err);
  }
});

socket.on('room-closed', ({ reason }) => {
  alert(`放映室已关闭 (${reason})`);
  leaveRoom();
  window.location.href = '/';
});

window.addEventListener('beforeunload', () => {
  leaveRoom();
});

setInterval(() => {
  if (!joined) {
    return;
  }
  updateLocalEpisodeProgress(currentEpisodeIndex, watchVideoEl.currentTime || 0);
  maybeCorrectPlaybackDrift();

  if (!playbackSuppressed && !watchVideoEl.paused) {
    emitPlayback('timeupdate');
  }
}, 1000);

setInterval(() => {
  if (!joined) {
    return;
  }
  renderEpisodeList();
}, 5000);

(async function init() {
  try {
    await initRoomInfo();
    setStatus('请填写昵称后点击加入');
  } catch (err) {
    setStatus(`加载失败: ${err.message}`);
    joinBtn.disabled = true;
  }
})();
