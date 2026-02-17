function initRoomPage() {
const roomId = window.location.pathname.split('/').filter(Boolean).pop();

const authInfoEl = document.getElementById('authInfo');
const currentUserEl = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');
const roomAppEl = document.getElementById('roomApp');
const collapseSidePanelBtn = document.getElementById('collapseSidePanelBtn');
const expandSidePanelBtn = document.getElementById('expandSidePanelBtn');
const roomTabButtons = Array.from(document.querySelectorAll('.room-tab-btn'));
const roomTabPanels = Array.from(document.querySelectorAll('.room-tab-panel'));

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
const playbackFormInfoEl = document.getElementById('playbackFormInfo');
const deleteRoomBtn = document.getElementById('deleteRoomBtn');
const episodeListEl = document.getElementById('episodeList');

const verifyFilesBtn = document.getElementById('verifyFilesBtn');
const verifyFilesInputEl = document.getElementById('verifyFilesInput');
const verifyStateBadgeEl = document.getElementById('verifyStateBadge');
const verifyStatusEl = document.getElementById('verifyStatus');
const verifyProgressTextEl = document.getElementById('verifyProgressText');
const verifyProgressBarEl = document.getElementById('verifyProgressBar');
const verifyMissingEpisodesEl = document.getElementById('verifyMissingEpisodes');
const verifyUnmatchedFilesEl = document.getElementById('verifyUnmatchedFiles');

const joinCamEl = document.getElementById('joinCam');
const joinMicEl = document.getElementById('joinMic');
const toggleCamBtn = document.getElementById('toggleCamBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const joinStateBadgeEl = document.getElementById('joinStateBadge');

const localVideoEl = document.getElementById('localVideo');
const localVideoLabelEl = document.getElementById('localVideoLabel');
const remoteGridEl = document.getElementById('remoteGrid');

const participantListEl = document.getElementById('participantList');
const chatListEl = document.getElementById('chatList');
const chatFormEl = document.getElementById('chatForm');
const chatInputEl = document.getElementById('chatInput');

const AUTH_TOKEN_KEY = 'auth_token';
const HEARTBEAT_MS = 4000;
const SUPPRESS_MS = 900;
const RESYNC_COOLDOWN_MS = 1500;
const RESYNC_THRESHOLD_PLAY_PAUSE_SEC = 0.7;
const RESYNC_THRESHOLD_SEEK_SEC = 0.4;
const RESYNC_THRESHOLD_HEARTBEAT_SEC = 0.9;

let socket = null;
const peers = new Map();
const participants = new Map();
const localFileMapByHash = new Map();
const verifiedEpisodeHashes = new Map();

let joined = false;
let joiningRoom = false;
let localStream = null;
let playbackSuppressed = false;
let seekDebounce = null;
let roomData = null;
let currentUser = null;
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
let localObjectUrl = '';
let localObjectHash = '';
let lastDriftCorrectionAt = 0;
let lastHeartbeatSentAt = 0;
let lastUnmatchedFiles = [];
let layoutFitRaf = 0;

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

function normalizeHash(hash) {
  return String(hash || '').trim().toLowerCase();
}

function displayHash(hash, length = 6) {
  const normalized = normalizeHash(hash);
  if (!normalized) {
    return '-';
  }
  const size = Math.max(1, Number(length) || 6);
  return normalized.slice(0, size);
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

function setStatus(text) {
  watchStatusEl.textContent = text;
}

function applyAutoLayoutBalance() {
  const viewportWidth = Number(window.innerWidth || 0);
  if (viewportWidth < 980 || roomAppEl.classList.contains('side-collapsed')) {
    roomAppEl.style.removeProperty('--room-side-current');
    roomAppEl.style.removeProperty('--room-video-min-height');
    return;
  }

  const containerWidth = Number(roomAppEl.clientWidth || viewportWidth);
  const viewportHeight = Number(window.innerHeight || 0);
  if (!containerWidth || !viewportHeight) {
    return;
  }

  const gridGap = 16;
  const minSideWidth = 300;
  const maxSideWidth = Math.max(minSideWidth, Math.min(440, Math.round(containerWidth * 0.38)));
  const targetVideoHeightByViewport = Math.max(340, Math.min(760, Math.round(viewportHeight * 0.56)));
  const minMainWidthForTarget = Math.max(620, Math.round((targetVideoHeightByViewport * 16) / 9));

  let sideWidth = containerWidth - minMainWidthForTarget - gridGap;
  sideWidth = Math.max(minSideWidth, Math.min(sideWidth, maxSideWidth));

  const mainWidth = Math.max(0, containerWidth - sideWidth - gridGap);
  const targetVideoHeightByWidth = Math.round((mainWidth * 9) / 16);
  const targetVideoMinHeight = Math.max(
    320,
    Math.min(760, targetVideoHeightByViewport, targetVideoHeightByWidth || targetVideoHeightByViewport),
  );

  roomAppEl.style.setProperty('--room-side-current', `${Math.round(sideWidth)}px`);
  roomAppEl.style.setProperty('--room-video-min-height', `${Math.round(targetVideoMinHeight)}px`);
}

function scheduleAutoLayoutBalance() {
  if (layoutFitRaf) {
    cancelAnimationFrame(layoutFitRaf);
  }
  layoutFitRaf = requestAnimationFrame(() => {
    layoutFitRaf = 0;
    applyAutoLayoutBalance();
  });
}

function setSidePanelCollapsed(collapsed) {
  roomAppEl.classList.toggle('side-collapsed', Boolean(collapsed));
  if (collapsed) {
    expandSidePanelBtn.classList.remove('hidden');
  } else {
    expandSidePanelBtn.classList.add('hidden');
  }
  scheduleAutoLayoutBalance();
}

function switchRoomTab(panelId) {
  const targetId = String(panelId || '').trim();
  if (!targetId) {
    return;
  }

  roomTabButtons.forEach((btn) => {
    const active = btn.dataset.roomTab === targetId;
    btn.classList.toggle('is-active', active);
  });

  roomTabPanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.id === targetId);
  });
}

function mapSourceTypeLabel(sourceType) {
  if (sourceType === 'local_hash') {
    return '本地文件模式（仅 hash）';
  }
  return '本地文件模式';
}

function updatePlaybackFormInfo() {
  const episode = episodes[normalizeEpisodeIndex(currentEpisodeIndex)] || null;
  if (!episode) {
    playbackFormInfoEl.textContent = '';
    return;
  }
  const sourceLabel = mapSourceTypeLabel(episode.sourceType);
  const playingFrom = '本地文件';
  playbackFormInfoEl.textContent = `当前视频形式: ${sourceLabel} | 当前播放来源: ${playingFrom}`;
}

function setVerifyStatus(text) {
  verifyStatusEl.textContent = text || '';
}

function truncateLabel(value, maxLen = 24) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLen - 1))}...`;
}

function formatCompactList(items, maxCount = 4) {
  const values = Array.from(items || []).filter(Boolean);
  if (!values.length) {
    return '';
  }
  const shown = values.slice(0, maxCount).join('、');
  if (values.length <= maxCount) {
    return shown;
  }
  return `${shown} 等 ${values.length} 项`;
}

function formatEpisodeLabel(episodeIndex) {
  const index = Number(episodeIndex || 0);
  const episode = episodes[index];
  const title = truncateLabel(episode?.title || '', 18);
  return title ? `第 ${index + 1} 集(${title})` : `第 ${index + 1} 集`;
}

function setPlaybackSuppressed(durationMs = SUPPRESS_MS) {
  playbackSuppressed = true;
  setTimeout(() => {
    playbackSuppressed = false;
  }, durationMs);
}

function getRemoteParticipantCount() {
  if (!participants.size) {
    return 0;
  }
  const selfId = socket?.id || '';
  let remoteCount = 0;
  for (const participantId of participants.keys()) {
    if (!selfId || participantId !== selfId) {
      remoteCount += 1;
    }
  }
  return remoteCount;
}

function hasRemoteParticipants() {
  return getRemoteParticipantCount() > 0;
}

function clearLocalObjectUrl() {
  if (!localObjectUrl) {
    localObjectHash = '';
    return;
  }
  URL.revokeObjectURL(localObjectUrl);
  localObjectUrl = '';
  localObjectHash = '';
}

function setWatchVideoSource(sourceUrl, isLocalObjectUrl = false, localHash = '') {
  const currentSrc = watchVideoEl.getAttribute('src') || '';
  if (currentSrc === String(sourceUrl || '')) {
    return;
  }

  clearLocalObjectUrl();
  if (isLocalObjectUrl && sourceUrl) {
    localObjectUrl = sourceUrl;
    localObjectHash = normalizeHash(localHash);
  }
  if (sourceUrl) {
    watchVideoEl.src = sourceUrl;
    return;
  }
  watchVideoEl.removeAttribute('src');
  watchVideoEl.load();
}

function hasAllEpisodesVerified() {
  if (!episodes.length) {
    return false;
  }
  for (let idx = 0; idx < episodes.length; idx += 1) {
    const episode = episodes[idx];
    const hash = normalizeHash(episode.contentHash || '');
    if (!hash) {
      return false;
    }
    if (!isEpisodeVerified(idx, hash)) {
      return false;
    }
  }
  return true;
}

function updateVerificationStateUI() {
  const total = episodes.length;
  let verifiedCount = 0;
  const missingEpisodes = [];
  for (let idx = 0; idx < episodes.length; idx += 1) {
    const episode = episodes[idx];
    if (isEpisodeVerified(idx, episode.contentHash || '')) {
      verifiedCount += 1;
      continue;
    }
    missingEpisodes.push(formatEpisodeLabel(idx));
  }

  verifyProgressTextEl.textContent = `${verifiedCount}/${total} 已校验`;
  const progressPercent = total > 0 ? Math.round((verifiedCount / total) * 100) : 0;
  verifyProgressBarEl.style.width = `${progressPercent}%`;

  if (total === 0) {
    verifyStateBadgeEl.textContent = '无剧集可校验';
    verifyMissingEpisodesEl.textContent = '当前房间无可校验剧集';
    verifyUnmatchedFilesEl.textContent = '';
    updateJoinStateUI();
    return;
  }

  const allReady = total > 0 && verifiedCount === total;
  verifyStateBadgeEl.textContent = allReady
    ? `文件已齐全 (${verifiedCount}/${total})`
    : `文件校验中 (${verifiedCount}/${total})`;

  if (missingEpisodes.length) {
    verifyMissingEpisodesEl.textContent = `待补齐: ${formatCompactList(missingEpisodes, 4)}`;
  } else {
    verifyMissingEpisodesEl.textContent = '待补齐: 无';
  }

  if (lastUnmatchedFiles.length) {
    verifyUnmatchedFilesEl.textContent = `未匹配文件: ${formatCompactList(lastUnmatchedFiles, 3)}`;
  } else {
    verifyUnmatchedFilesEl.textContent = '未匹配文件: 无';
  }

  updateJoinStateUI();
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
    row.textContent = socket && id === socket.id ? `${name} (你)` : name;
    participantListEl.appendChild(row);
  }
}

function removeRemoteVideo(peerId) {
  const box = document.getElementById(`remote-${peerId}`);
  if (box) {
    box.remove();
  }
}

function updateJoinStateUI() {
  const joining = Boolean(joiningRoom);
  const inRoom = Boolean(joined);
  const allVerified = hasAllEpisodesVerified();

  joinBtn.disabled = joining || inRoom || !allVerified;
  leaveBtn.disabled = joining || !inRoom;

  if (joining) {
    joinStateBadgeEl.textContent = '加入中';
    return;
  }

  joinStateBadgeEl.textContent = inRoom ? '已加入' : '未加入';
}

function updateMediaToggleButtons() {
  const camOn = Boolean(joinCamEl.checked);
  const micOn = Boolean(joinMicEl.checked);

  toggleCamBtn.textContent = camOn ? '关闭摄像头' : '开启摄像头';
  toggleMicBtn.textContent = micOn ? '关闭麦克风' : '开启麦克风';

  toggleCamBtn.classList.toggle('secondary', !camOn);
  toggleMicBtn.classList.toggle('secondary', !micOn);
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
    box.className = 'video-tile';

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;

    const label = document.createElement('div');
    label.className = 'video-tile-label';
    label.textContent = peerName || '远端用户';

    box.appendChild(video);
    box.appendChild(label);
    remoteGridEl.appendChild(box);
  }

  const video = box.querySelector('video');
  const label = box.querySelector('.video-tile-label');
  if (label && peerName) {
    label.textContent = peerName;
  }
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
    if (!event.candidate || !socket) {
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

  if (shouldCreateOffer && socket) {
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
  if (!joinCamEl.checked && !joinMicEl.checked) {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }
    localVideoEl.srcObject = null;
    updateMediaToggleButtons();
    return;
  }

  let nextStream = null;
  try {
    nextStream = await navigator.mediaDevices.getUserMedia({
      video: joinCamEl.checked,
      audio: joinMicEl.checked,
    });
  } catch (err) {
    if (joinCamEl.checked && joinMicEl.checked) {
      try {
        nextStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        joinMicEl.checked = false;
      } catch (_videoErr) {
        try {
          nextStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
          joinCamEl.checked = false;
        } catch (_audioErr) {
          joinCamEl.checked = false;
          joinMicEl.checked = false;
        }
      }
    } else {
      if (joinCamEl.checked) {
        joinCamEl.checked = false;
      }
      if (joinMicEl.checked) {
        joinMicEl.checked = false;
      }
    }

    if (!nextStream) {
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
      localStream = null;
      localVideoEl.srcObject = null;
      updateMediaToggleButtons();
      alert(`获取本地音视频失败，将仅使用聊天与同步播放: ${err.message}`);
      return;
    }
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = nextStream;
  localVideoEl.srcObject = localStream;
  localVideoEl.volume = voiceVolumeLevel;
  updateMediaToggleButtons();
}

async function rebuildPeerConnectionsForMediaChange() {
  if (!joined || !socket) {
    return;
  }

  const selfId = socket.id || '';
  const targets = [];
  for (const [id, name] of participants.entries()) {
    if (selfId && id === selfId) {
      continue;
    }
    targets.push({ id, name });
  }

  targets.forEach(({ id }) => closePeer(id));
  for (const target of targets) {
    try {
      await createPeerConnection(target.id, target.name, true);
    } catch (err) {
      console.error('rebuild peer failed', err);
    }
  }
}

async function applyMediaPreferenceChange() {
  await prepareLocalMedia();
  if (joined) {
    await rebuildPeerConnectionsForMediaChange();
    setStatus('本地音视频设置已更新');
  }
}

function emitPlayback(action, overrides = {}, force = false) {
  if (!socket || !joined || (!force && playbackSuppressed)) {
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

  // 保持本地权威态跟随最新操作，避免单人场景被旧状态拉回。
  setAuthoritativeState(payload);
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
  if (!hasRemoteParticipants() && !options.forceSeek) {
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
  const now = Date.now();
  const isHeartbeatLike = action === 'timeupdate' || action === 'drift-tick';
  const baseThreshold = action === 'seek' || action === 'episode-switch'
    ? Math.max(RESYNC_THRESHOLD_SEEK_SEC, driftSoftThresholdSec)
    : action === 'play' || action === 'pause'
      ? Math.max(RESYNC_THRESHOLD_PLAY_PAUSE_SEC, driftSoftThresholdSec)
      : Math.max(RESYNC_THRESHOLD_HEARTBEAT_SEC, driftSoftThresholdSec);
  const threshold = options.forceSeek ? 0 : baseThreshold;

  if (!options.forceSeek && isHeartbeatLike && drift < 0) {
    // 心跳只向前追，不回退，避免来回拉扯。
    return;
  }
  if (!options.forceSeek && absDrift <= threshold) {
    return;
  }
  if (!options.forceSeek && now - lastDriftCorrectionAt < RESYNC_COOLDOWN_MS) {
    return;
  }

  if (absDrift >= Math.max(driftHardThresholdSec, threshold + 0.25) || options.forceSeek) {
    lastDriftCorrectionAt = now;
    clearMicroAdjustTimer();
    setPlaybackSuppressed(260);
    watchVideoEl.currentTime = Math.max(0, targetTime);
    watchStatusEl.textContent = `已对齐房间进度 (${Math.round(drift * 1000)}ms)`;
    applyRoomPlaybackRate(roomRate);
    return;
  }

  if (authoritativeState.isPlaying && absDrift > Math.max(driftSoftThresholdSec, threshold)) {
    if (microAdjustTimer) {
      return;
    }
    lastDriftCorrectionAt = now;
    const adjustedRate = drift > 0
      ? Math.min(4, roomRate * 1.06)
      : Math.max(0.25, roomRate * 0.94);

    setPlaybackSuppressed(260);
    watchVideoEl.playbackRate = adjustedRate;
    microAdjustTimer = setTimeout(() => {
      applyRoomPlaybackRate(roomRate);
      watchStatusEl.textContent = `漂移已微调 (${Math.round(drift * 1000)}ms)`;
    }, 1200);
    return;
  }

  if (!authoritativeState.isPlaying && absDrift > Math.max(driftSoftThresholdSec, threshold)) {
    lastDriftCorrectionAt = now;
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

function markEpisodeVerified(episodeIndex, hash) {
  const safeHash = normalizeHash(hash);
  if (!safeHash) {
    return;
  }
  verifiedEpisodeHashes.set(Number(episodeIndex || 0), safeHash);
}

function isEpisodeVerified(episodeIndex, hash) {
  const safeHash = normalizeHash(hash);
  if (!safeHash) {
    return false;
  }
  const saved = verifiedEpisodeHashes.get(Number(episodeIndex || 0));
  return saved === safeHash;
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
    const verifiedText = isEpisodeVerified(idx, ep.contentHash || '') ? '已校验' : '未校验';
    const sourceLabel = mapSourceTypeLabel(ep.sourceType);
    hash.textContent = `形式: ${sourceLabel} | hash: ${displayHash(ep.contentHash)} | ${verifiedText} | ${progressText}`;

    row.appendChild(btn);
    row.appendChild(hash);
    episodeListEl.appendChild(row);
  });

  updateVerificationStateUI();
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

  const hash = normalizeHash(episode.contentHash || '');
  const localFile = hash ? localFileMapByHash.get(hash) : null;
  if (localFile) {
    const currentSrc = watchVideoEl.getAttribute('src') || '';
    const canReuseCurrent = Boolean(currentSrc) && localObjectHash === hash;
    if (!canReuseCurrent) {
      setWatchVideoSource(URL.createObjectURL(localFile), true, hash);
      await waitForMetadata(watchVideoEl);
    }
  } else {
    setWatchVideoSource('', false);
  }

  if (Number.isFinite(Number(options.resumeTime))) {
    watchVideoEl.currentTime = Math.max(0, Number(options.resumeTime));
  } else if (options.useSavedProgress) {
    const savedTime = getEpisodeResumeTime(currentEpisodeIndex);
    if (savedTime > 0) {
      watchVideoEl.currentTime = savedTime;
    }
  }

  updatePlaybackFormInfo();
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
  if (!hasRemoteParticipants()) {
    return;
  }
  if (!watchVideoEl.paused || authoritativeState.isPlaying) {
    correctPlaybackDrift({ action: 'drift-tick' });
  }
}

async function computeFileSha256Hex(file, options = {}) {
  if (window.WatchPartyCommon?.computeFileSha256Hex) {
    return window.WatchPartyCommon.computeFileSha256Hex(file, options);
  }
  throw new Error('缺少哈希模块，请刷新页面后重试');
}

async function verifySelectedFiles(fileList) {
  if (!episodes.length) {
    setVerifyStatus('当前房间无可校验剧集');
    return;
  }

  const files = Array.from(fileList || []).filter((item) => item instanceof File);
  if (!files.length) {
    setVerifyStatus('请选择至少一个本地视频文件');
    return;
  }

  const episodeIndexesByHash = new Map();
  episodes.forEach((episode, index) => {
    const hash = normalizeHash(episode.contentHash || '');
    if (!hash) {
      return;
    }
    if (!episodeIndexesByHash.has(hash)) {
      episodeIndexesByHash.set(hash, []);
    }
    episodeIndexesByHash.get(hash).push(index);
  });

  let matchedEpisodes = 0;
  let matchedFiles = 0;
  let unmatchedFiles = 0;
  const unmatchedFileLabels = [];

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    setVerifyStatus(`正在校验文件 ${fileIndex + 1}/${files.length}: ${file.name}`);

    let calculatedHash = '';
    try {
      calculatedHash = normalizeHash(await computeFileSha256Hex(file, {
        onProgress: (loaded, total) => {
          const pct = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
          setVerifyStatus(`校验 ${file.name} (${fileIndex + 1}/${files.length})... ${pct}%`);
        },
      }));
    } catch (err) {
      unmatchedFiles += 1;
      unmatchedFileLabels.push(`${truncateLabel(file.name, 20)}(读取失败)`);
      setVerifyStatus(`文件 ${file.name} 读取失败: ${err.message}`);
      continue;
    }

    const indexes = episodeIndexesByHash.get(calculatedHash) || [];
    if (!indexes.length) {
      unmatchedFiles += 1;
      unmatchedFileLabels.push(`${truncateLabel(file.name, 20)}(hash:${displayHash(calculatedHash)})`);
      continue;
    }

    matchedFiles += 1;
    localFileMapByHash.set(calculatedHash, file);
    indexes.forEach((episodeIndex) => {
      if (!isEpisodeVerified(episodeIndex, calculatedHash)) {
        matchedEpisodes += 1;
      }
      markEpisodeVerified(episodeIndex, calculatedHash);
    });
  }

  lastUnmatchedFiles = unmatchedFileLabels;
  renderEpisodeList();
  updateJoinStateUI();

  const total = episodes.length;
  const verified = episodes.filter((ep, idx) => isEpisodeVerified(idx, ep.contentHash || '')).length;
  const readyText = verified === total ? '全部剧集已校验，可加入房间。' : '还有剧集未校验，暂不可加入房间。';
  setVerifyStatus(`匹配文件 ${matchedFiles} 个，新增匹配剧集 ${matchedEpisodes} 集，未匹配文件 ${unmatchedFiles} 个。${readyText}`);
}

async function joinRoom() {
  if (joined || joiningRoom || !socket) {
    return;
  }

  if (!hasAllEpisodesVerified()) {
    setStatus('请先完成全部剧集文件校验后再加入');
    setVerifyStatus('当前仍有未校验剧集，请点击“选择文件并校验”补齐。');
    updateJoinStateUI();
    return;
  }

  joiningRoom = true;
  updateJoinStateUI();

  try {
    await prepareLocalMedia();
  } catch (_err) {
    // ignore
  }

  const verifiedEpisodeHashesPayload = {};
  episodes.forEach((episode, idx) => {
    const savedHash = normalizeHash(verifiedEpisodeHashes.get(idx) || '');
    if (savedHash) {
      verifiedEpisodeHashesPayload[idx] = savedHash;
    }
  });

  socket.emit('join-room', {
    roomId,
    verifiedEpisodeHashes: verifiedEpisodeHashesPayload,
  }, (result) => {
    joiningRoom = false;
    updateJoinStateUI();

    if (!result?.ok) {
      setStatus(result?.error || '加入失败');
      return;
    }

    joined = true;
    updateJoinStateUI();
    lastHeartbeatSentAt = 0;
    lastDriftCorrectionAt = 0;
    setStatus('已加入放映室');

    if (currentUser?.username && socket.id) {
      participants.set(socket.id, currentUser.username);
      renderParticipants();
    }
  });
}

function leaveRoom() {
  if (joined && socket) {
    socket.emit('leave-room');
  }
  joiningRoom = false;
  joined = false;
  initialPlaybackAligned = false;
  lastHeartbeatSentAt = 0;
  lastDriftCorrectionAt = 0;
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
  clearLocalObjectUrl();

  setStatus('已离开放映室');
  updateJoinStateUI();
}

function canDeleteRoom() {
  if (!currentUser || !roomData?.room) {
    return false;
  }
  return currentUser.role === 'root' || roomData.room.createdByUserId === currentUser.id;
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

  if (canDeleteRoom()) {
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
  updateVerificationStateUI();
  if (hasAllEpisodesVerified()) {
    setVerifyStatus('全部剧集已校验，可直接加入房间');
  } else {
    setVerifyStatus('请先点击“选择文件并校验”，补齐全部剧集后再加入');
  }
}

async function deleteCurrentRoom() {
  await apiFetch(`/api/rooms/${roomId}`, {
    method: 'DELETE',
  });
}

function bindSocketEvents() {
  if (!socket) {
    return;
  }

  socket.on('connect_error', (err) => {
    setStatus(`实时连接失败: ${err.message || '未知错误'}`);
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
}

function connectSocket() {
  const token = getAuthToken();
  socket = io({
    auth: token ? { token } : undefined,
  });
  bindSocketEvents();
}

joinBtn.addEventListener('click', () => {
  joinRoom().catch((err) => setStatus(`加入失败: ${err.message}`));
});

leaveBtn.addEventListener('click', () => {
  leaveRoom();
});

toggleCamBtn.addEventListener('click', () => {
  joinCamEl.checked = !joinCamEl.checked;
  applyMediaPreferenceChange().catch((err) => {
    console.error('toggle camera failed', err);
  });
});

toggleMicBtn.addEventListener('click', () => {
  joinMicEl.checked = !joinMicEl.checked;
  applyMediaPreferenceChange().catch((err) => {
    console.error('toggle microphone failed', err);
  });
});

collapseSidePanelBtn.addEventListener('click', () => {
  setSidePanelCollapsed(true);
});

expandSidePanelBtn.addEventListener('click', () => {
  setSidePanelCollapsed(false);
});

roomTabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    switchRoomTab(btn.dataset.roomTab);
  });
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

chatFormEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = (chatInputEl.value || '').trim();
  if (!text || !joined || !socket) {
    return;
  }
  socket.emit('chat-message', { text });
  chatInputEl.value = '';
});

verifyFilesBtn.addEventListener('click', () => {
  if (!episodes.length) {
    setVerifyStatus('当前房间无可校验剧集');
    return;
  }
  verifyFilesInputEl.click();
});

verifyFilesInputEl.addEventListener('change', () => {
  const files = verifyFilesInputEl.files;
  verifySelectedFiles(files).catch((err) => {
    setVerifyStatus(`校验失败: ${err.message}`);
  }).finally(() => {
    verifyFilesInputEl.value = '';
  });
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

window.addEventListener('beforeunload', () => {
  leaveRoom();
  clearLocalObjectUrl();
});

window.addEventListener('resize', () => {
  scheduleAutoLayoutBalance();
});

setInterval(() => {
  if (!joined) {
    return;
  }

  updateLocalEpisodeProgress(currentEpisodeIndex, watchVideoEl.currentTime || 0);
  maybeCorrectPlaybackDrift();

  if (!playbackSuppressed && !watchVideoEl.paused) {
    const now = Date.now();
    if (now - lastHeartbeatSentAt >= HEARTBEAT_MS) {
      emitPlayback('timeupdate');
      lastHeartbeatSentAt = now;
    }
  }
}, 1000);

setInterval(() => {
  if (!joined) {
    return;
  }
  renderEpisodeList();
}, 5000);

async function checkAuth() {
  try {
    const result = await apiFetch('/api/auth/me');
    currentUser = result.user;
    authInfoEl.textContent = `已登录: ${currentUser.username} (${currentUser.role})`;
    currentUserEl.textContent = `${currentUser.username} (${currentUser.role})`;
    localVideoLabelEl.textContent = `${currentUser.username} (你)`;
    roomAppEl.classList.remove('hidden');
    scheduleAutoLayoutBalance();
    return true;
  } catch (_err) {
    currentUser = null;
    setAuthToken('');
    authInfoEl.textContent = '未登录，正在跳转...';
    roomAppEl.classList.add('hidden');
    window.location.href = '/';
    return false;
  }
}

(async function init() {
  switchRoomTab('episodeTabPanel');
  setSidePanelCollapsed(false);
  joinCamEl.checked = false;
  joinMicEl.checked = false;
  updateMediaToggleButtons();
  updateJoinStateUI();

  const authed = await checkAuth();
  if (!authed) {
    return;
  }

  try {
    await initRoomInfo();
    connectSocket();
    scheduleAutoLayoutBalance();
    setStatus('请点击“加入”进入放映室');
  } catch (err) {
    roomTitleEl.textContent = '放映室不存在或已删除';
    setStatus(err.message);
    roomAppEl.classList.add('hidden');
  }
})();
}

Vue.createApp({
  mounted() {
    initRoomPage();
  },
}).mount('#app');
