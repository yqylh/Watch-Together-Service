require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');
const {
  countUsers,
  createUser,
  getUserById,
  getUserByUsername,
  touchUserLastLogin,
  createVideo,
  getVideo,
  getVideoByHash,
  listVideos,
  createPlaylist,
  getPlaylist,
  listPlaylists,
  listPlaylistEpisodes,
  createRoom,
  getRoom,
  getRoomWithSource,
  deleteRoom,
  listRoomsByVideo,
  listRoomsByPlaylist,
  listAllRooms,
  getRoomPlaybackState,
  listRoomEpisodeProgress,
  updateRoomPlaybackState,
  touchVideoAccess,
  touchVideosByFilename,
  markLocalUnavailableByFilename,
  markLocalAvailableByFilename,
  markVideosStoredInOssByHash,
  listLocalEvictionCandidates,
  listLocalPoolFiles,
  createVideoJob,
  updateVideoJob,
  getVideoJob,
  listVideoJobs,
  countVideoJobs,
  cleanupOldVideoJobs,
  isRoomOwner,
} = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});

const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || 'replace-this-secret';
const authTokenCookieName = 'auth_token';

const poolDir = path.join(__dirname, process.env.PLAY_POOL_DIR || 'playback_pool');
const tempDir = path.join(__dirname, process.env.TEMP_UPLOAD_DIR || 'uploads_tmp');
const playPoolMaxBytes = Number(process.env.PLAY_POOL_MAX_BYTES || 10 * 1024 * 1024 * 1024);

const enableTranscode = isTruthy(process.env.ENABLE_TRANSCODE || 'true');
const ffmpegPath = (process.env.FFMPEG_PATH || 'ffmpeg').trim();
const transcodeVideoCodec = (process.env.TRANSCODE_VIDEO_CODEC || 'libx264').trim();
const transcodeAudioCodec = (process.env.TRANSCODE_AUDIO_CODEC || 'aac').trim();
const transcodePreset = (process.env.TRANSCODE_PRESET || 'veryfast').trim();
const transcodeVideoBitrate = (process.env.TRANSCODE_VIDEO_BITRATE || '').trim();
const transcodeAudioBitrate = (process.env.TRANSCODE_AUDIO_BITRATE || '96k').trim();
const transcodeCrf = Number(process.env.TRANSCODE_CRF || 28);
const transcodeMaxWidth = Number(process.env.TRANSCODE_MAX_WIDTH || 1280);
const transcodeHwaccel = (process.env.TRANSCODE_HWACCEL || '').trim();
const transcodeFallbackCpu = isTruthy(process.env.TRANSCODE_FALLBACK_CPU || 'true');
const syncDriftSoftThresholdMs = Math.max(50, Number(process.env.SYNC_DRIFT_SOFT_THRESHOLD_MS || 200));
const syncDriftHardThresholdMs = Math.max(syncDriftSoftThresholdMs, Number(process.env.SYNC_DRIFT_HARD_THRESHOLD_MS || 1200));
const autoplayCountdownSeconds = Math.max(3, Math.min(30, Number(process.env.AUTOPLAY_COUNTDOWN_SECONDS || 8)));

const ossRegion = (process.env.OSS_REGION || '').trim();
const ossBucket = (process.env.OSS_BUCKET || '').trim();
const ossAccessKeyId = (process.env.OSS_ACCESS_KEY_ID || '').trim();
const ossAccessKeySecret = (process.env.OSS_ACCESS_KEY_SECRET || '').trim();
const ossEndpoint = (process.env.OSS_ENDPOINT || '').trim();
const ossStsToken = (process.env.OSS_STS_TOKEN || '').trim();
const ossPrefix = normalizeOssPrefix(process.env.OSS_PREFIX || 'videos/');

for (const dir of [poolDir, tempDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const ossClient = createOssClient();

const SUPPORTED_VIDEO_FORMATS = [
  { extension: '.mp4', mimeTypes: ['video/mp4'] },
  { extension: '.webm', mimeTypes: ['video/webm'] },
  { extension: '.ogg', mimeTypes: ['video/ogg'] },
  { extension: '.ogv', mimeTypes: ['video/ogg'] },
  { extension: '.m4v', mimeTypes: ['video/x-m4v', 'video/mp4'] },
  { extension: '.mov', mimeTypes: ['video/quicktime'] },
  { extension: '.mkv', mimeTypes: ['video/x-matroska'] },
  { extension: '.avi', mimeTypes: ['video/x-msvideo'] },
  { extension: '.ts', mimeTypes: ['video/mp2t'] },
];

const SUPPORTED_MIME_SET = new Set(SUPPORTED_VIDEO_FORMATS.flatMap((item) => item.mimeTypes));
const SUPPORTED_EXT_SET = new Set(SUPPORTED_VIDEO_FORMATS.map((item) => item.extension));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tempDir),
  filename: (_req, file, cb) => {
    const ext = getExtension(file.originalname) || '.mp4';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (!isSupportedFormat(file.originalname, file.mimetype)) {
      cb(new Error('不支持该视频格式，请查看 /api/supported-formats'));
      return;
    }
    cb(null, true);
  },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, 'public')));

const roomMembers = new Map();
const roomPlayback = new Map();
const roomMessages = new Map();
const roomEpisodes = new Map();
const activeMediaReads = new Map();
const localFileLocks = new Map();
const roomLocalVerification = new Map();

function nowIso() {
  return new Date().toISOString();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = units[0];

  for (let i = 0; i < units.length; i += 1) {
    unit = units[i];
    if (size < 1024 || i === units.length - 1) {
      break;
    }
    size /= 1024;
  }

  if (size >= 100 || unit === 'B') {
    return `${Math.round(size)} ${unit}`;
  }
  return `${size.toFixed(1)} ${unit}`;
}

function toNumberSafe(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeOssPrefix(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function createOssClient() {
  const enabled = Boolean(ossRegion && ossBucket && ossAccessKeyId && ossAccessKeySecret);
  if (!enabled) {
    return null;
  }

  let OSS;
  try {
    // eslint-disable-next-line global-require
    OSS = require('ali-oss');
  } catch (_err) {
    throw new Error('检测到 OSS 配置，但未安装 ali-oss 依赖。请执行 npm install ali-oss。');
  }

  const options = {
    region: ossRegion,
    bucket: ossBucket,
    accessKeyId: ossAccessKeyId,
    accessKeySecret: ossAccessKeySecret,
    secure: true,
  };

  if (ossEndpoint) {
    options.endpoint = ossEndpoint;
  }
  if (ossStsToken) {
    options.stsToken = ossStsToken;
  }

  return new OSS(options);
}

function normalizeHash(hash) {
  if (!hash) {
    return '';
  }
  return String(hash).trim().toLowerCase();
}

function validateRequiredHash(hash, fieldName = 'contentHash') {
  const normalized = normalizeHash(hash);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${fieldName} must be a 64-char hex SHA-256`);
  }
  return normalized;
}

function getExtension(fileName) {
  return (path.extname(fileName || '') || '').toLowerCase();
}

function inferMimeFromExt(ext) {
  const format = SUPPORTED_VIDEO_FORMATS.find((item) => item.extension === ext);
  return format ? format.mimeTypes[0] : '';
}

function isSupportedFormat(fileName, mimeType) {
  const ext = getExtension(fileName);
  const mime = (mimeType || '').toLowerCase();
  return SUPPORTED_EXT_SET.has(ext) || (mime && SUPPORTED_MIME_SET.has(mime));
}

function assertSupportedFormat(fileName, mimeType) {
  if (!isSupportedFormat(fileName, mimeType)) {
    throw new Error('不支持该视频格式，请查看 /api/supported-formats');
  }
}

function serializeUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at,
  };
}

function issueAuthToken(user) {
  return jwt.sign({
    uid: user.id,
    username: user.username,
    role: user.role || 'user',
    ts: Date.now(),
  }, jwtSecret, { expiresIn: '30d' });
}

function parseAuthToken(req) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const cookieToken = req.cookies[authTokenCookieName];
  return bearerToken || cookieToken || '';
}

function authRequired(req, res, next) {
  const token = parseAuthToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch (_err) {
    res.status(401).json({ error: 'Invalid authentication token' });
    return;
  }

  const user = getUserById(payload.uid);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  req.authUser = serializeUser(user);
  req.authToken = token;
  next();
}

function authRootRequired(req, res, next) {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.authUser.role !== 'root') {
    res.status(403).json({ error: 'Root permission required' });
    return;
  }
  next();
}

function parseCookiesHeader(rawCookie) {
  const parsed = {};
  const source = String(rawCookie || '');
  if (!source) {
    return parsed;
  }
  source.split(';').forEach((part) => {
    const [key, ...rest] = part.split('=');
    if (!key) {
      return;
    }
    parsed[key.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return parsed;
}

function getSocketAuthToken(socket) {
  const authToken = socket.handshake?.auth?.token;
  if (authToken) {
    return String(authToken);
  }
  const cookies = parseCookiesHeader(socket.handshake?.headers?.cookie);
  return cookies[authTokenCookieName] || '';
}

function ensureRoomVerification(roomId) {
  if (!roomLocalVerification.has(roomId)) {
    roomLocalVerification.set(roomId, new Map());
  }
  return roomLocalVerification.get(roomId);
}

function setRoomVerification(roomId, userId, episodeIndex, contentHash) {
  const byUser = ensureRoomVerification(roomId);
  if (!byUser.has(userId)) {
    byUser.set(userId, new Map());
  }
  byUser.get(userId).set(Number(episodeIndex || 0), normalizeHash(contentHash));
}

function isRoomEpisodeVerified(roomId, userId, episodeIndex, contentHash) {
  const byUser = roomLocalVerification.get(roomId);
  if (!byUser) {
    return false;
  }
  const episodes = byUser.get(userId);
  if (!episodes) {
    return false;
  }
  const savedHash = episodes.get(Number(episodeIndex || 0));
  return Boolean(savedHash && savedHash === normalizeHash(contentHash));
}

function clearRoomVerificationByUser(roomId, userId) {
  const byUser = roomLocalVerification.get(roomId);
  if (!byUser) {
    return;
  }
  byUser.delete(userId);
  if (byUser.size === 0) {
    roomLocalVerification.delete(roomId);
  }
}

function buildLocalFileRequiredPayload(roomId, roomStateOverride) {
  const room = getRoomWithSource(roomId);
  if (!room || room.room_mode !== 'local_file') {
    return null;
  }

  const episodes = getRoomEpisodes(roomId, room);
  if (!episodes.length) {
    return null;
  }

  const state = roomStateOverride || roomPlayback.get(roomId) || getRoomPlaybackState(roomId) || getDefaultRoomState(room);
  const index = Math.max(0, Math.min(Number(state.episodeIndex || 0), episodes.length - 1));
  const episode = episodes[index];
  if (!episode) {
    return null;
  }

  return {
    roomId,
    episodeIndex: index,
    videoId: episode.videoId,
    title: episode.title,
    contentHash: normalizeHash(episode.contentHash || ''),
  };
}

function serializeRoom(room) {
  const members = roomMembers.get(room.id);
  return {
    id: room.id,
    videoId: room.video_id,
    playlistId: room.playlist_id || null,
    roomMode: room.room_mode || 'cloud',
    createdByUserId: room.created_by_user_id || null,
    startEpisodeIndex: Number(room.start_episode_index || 0),
    name: room.name,
    creatorName: room.creator_username || room.creator_name,
    createdAt: room.created_at,
    videoTitle: room.video_title,
    playlistName: room.playlist_name || null,
    sourceLabel: room.playlist_name ? `列表: ${room.playlist_name}` : `视频: ${room.video_title}`,
    latestEpisodeIndex: Number(room.last_episode_index || room.start_episode_index || 0),
    latestCurrentTime: Number(room.last_current_time || 0),
    latestPlaybackRate: Number(room.last_playback_rate || 1),
    totalWatchedSeconds: Number(room.total_watched_seconds || 0),
    lastUpdatedAt: room.last_updated_at || null,
    memberCount: members ? members.size : 0,
  };
}

function serializeVideo(video) {
  const rooms = listRoomsByVideo(video.id).map(serializeRoom);
  const hasCloudMedia = video.source_type !== 'local_hash';
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    originalName: video.original_name,
    mimeType: video.mime_type,
    size: video.size,
    contentHash: video.hash || '',
    sourceType: video.source_type || 'local_upload',
    sourceValue: video.source_value || '',
    localAvailable: Boolean(video.local_available),
    storedInOss: Boolean(video.stored_in_oss),
    createdAt: video.created_at,
    watchUrl: `/videos/${video.id}`,
    mediaUrl: hasCloudMedia ? `/media/${video.id}` : null,
    rooms,
  };
}

function serializeVideoJob(job) {
  if (!job) {
    return null;
  }

  const linkedVideo = job.video_id ? getVideo(job.video_id) : null;
  return {
    id: job.id,
    videoId: job.video_id || null,
    sourceType: job.source_type,
    status: job.status,
    stage: job.stage,
    message: job.message || '',
    progress: Number(job.progress || 0),
    error: job.error || '',
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    video: linkedVideo ? serializeVideo(linkedVideo) : null,
  };
}

function serializePlaylistEpisode(item) {
  const title = item.title_override && item.title_override.trim()
    ? item.title_override.trim()
    : item.video_title;

  const hasCloudMedia = item.video_source_type !== 'local_hash';
  return {
    id: item.id,
    playlistId: item.playlist_id,
    videoId: item.video_id,
    episodeIndex: item.episode_index,
    title,
    originalTitle: item.video_title,
    mediaUrl: hasCloudMedia ? `/media/${item.video_id}` : null,
    watchUrl: `/videos/${item.video_id}`,
    mimeType: item.video_mime_type,
    size: item.video_size,
    sourceType: item.video_source_type || 'local_upload',
    contentHash: item.video_hash || '',
    localAvailable: Boolean(item.video_local_available),
    storedInOss: Boolean(item.video_stored_in_oss),
  };
}

function serializePlaylist(playlist) {
  const episodes = listPlaylistEpisodes(playlist.id).map(serializePlaylistEpisode);
  const rooms = listRoomsByPlaylist(playlist.id).map(serializeRoom);

  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    createdAt: playlist.created_at,
    episodes,
    rooms,
  };
}

function buildRoomPlaylist(room) {
  if (room.playlist_id) {
    const playlist = getPlaylist(room.playlist_id);
    if (playlist) {
      return {
        id: playlist.id,
        name: playlist.name,
        episodes: listPlaylistEpisodes(playlist.id).map(serializePlaylistEpisode),
      };
    }
  }

  const video = getVideo(room.video_id);
  if (!video) {
    return null;
  }

  return {
    id: null,
    name: video.title,
    episodes: [{
      id: `single-${video.id}`,
      playlistId: null,
      videoId: video.id,
      episodeIndex: 0,
      title: video.title,
      originalTitle: video.title,
      mediaUrl: video.source_type === 'local_hash' ? null : `/media/${video.id}`,
      watchUrl: `/videos/${video.id}`,
      mimeType: video.mime_type,
      size: video.size,
      sourceType: video.source_type || 'local_upload',
      contentHash: video.hash || '',
      localAvailable: Boolean(video.local_available),
      storedInOss: Boolean(video.stored_in_oss),
    }],
  };
}

function getRoomEpisodes(roomId, roomSource) {
  if (roomEpisodes.has(roomId)) {
    return roomEpisodes.get(roomId);
  }

  const room = roomSource || getRoomWithSource(roomId);
  const playlist = room ? buildRoomPlaylist(room) : null;
  const episodes = playlist?.episodes || [];
  roomEpisodes.set(roomId, episodes);
  return episodes;
}

function getDefaultRoomState(room) {
  return {
    currentTime: Number(room?.last_current_time || 0),
    isPlaying: Boolean(room?.last_is_playing),
    playbackRate: Number(room?.last_playback_rate || 1),
    episodeIndex: Number(room?.last_episode_index ?? room?.start_episode_index ?? 0),
    updatedAt: room?.last_updated_at || nowIso(),
    totalWatchedSeconds: Number(room?.total_watched_seconds || 0),
  };
}

function ensureRoomState(roomId, room) {
  if (!roomMembers.has(roomId)) {
    roomMembers.set(roomId, new Map());
  }
  if (!roomMessages.has(roomId)) {
    roomMessages.set(roomId, []);
  }

  getRoomEpisodes(roomId, room);

  if (!roomPlayback.has(roomId)) {
    const persisted = getRoomPlaybackState(roomId);
    roomPlayback.set(roomId, persisted ? {
      currentTime: Number(persisted.currentTime || 0),
      isPlaying: Boolean(persisted.isPlaying),
      playbackRate: Number(persisted.playbackRate || 1),
      episodeIndex: Number(persisted.episodeIndex || room?.start_episode_index || 0),
      updatedAt: persisted.updatedAt || nowIso(),
      totalWatchedSeconds: Number(persisted.totalWatchedSeconds || 0),
    } : getDefaultRoomState(room));
  }
}

function removeSocketFromRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) {
    return;
  }

  const members = roomMembers.get(roomId);
  if (members) {
    const currentUserId = socket.data.userId;
    members.delete(socket.id);
    const sameUserStillOnline = [...members.values()].some((member) => member.userId === currentUserId);
    if (!sameUserStillOnline) {
      clearRoomVerificationByUser(roomId, currentUserId);
    }
    socket.to(roomId).emit('participant-left', {
      id: socket.id,
      name: socket.data.username,
    });

    if (members.size === 0) {
      roomMembers.delete(roomId);
      roomMessages.delete(roomId);
      roomPlayback.delete(roomId);
      roomEpisodes.delete(roomId);
      roomLocalVerification.delete(roomId);
    }
  }

  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.username = null;
  socket.data.userId = null;
}

function closeRoom(roomId, reason) {
  const room = getRoom(roomId);
  if (!room) {
    return false;
  }

  io.to(roomId).emit('room-closed', { roomId, reason });

  const members = roomMembers.get(roomId);
  if (members) {
    for (const socketId of members.keys()) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) {
        continue;
      }
      socket.leave(roomId);
      socket.data.roomId = null;
      socket.data.username = null;
      socket.data.userId = null;
    }
  }

  roomMembers.delete(roomId);
  roomPlayback.delete(roomId);
  roomMessages.delete(roomId);
  roomEpisodes.delete(roomId);
  roomLocalVerification.delete(roomId);
  return deleteRoom(roomId);
}

async function removeFileIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (_err) {
    // ignore
  }
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (_err) {
    return false;
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;

    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    input.on('error', reject);
    input.on('end', () => {
      resolve({
        hash: hash.digest('hex'),
        size: bytes,
      });
    });
  });
}

async function copyAndHash(readable, targetPath, options = {}) {
  const maxBytes = Number(options.maxBytes || 0);
  const hash = createHash('sha256');
  let size = 0;

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(targetPath);
    let settled = false;

    const finalizeError = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      output.destroy();
      reject(err);
    };

    readable.on('data', (chunk) => {
      size += chunk.length;
      if (maxBytes > 0 && size > maxBytes) {
        readable.destroy(new Error(`文件超过大小限制 ${formatBytes(maxBytes)}`));
        return;
      }
      hash.update(chunk);
    });
    readable.on('error', finalizeError);
    output.on('error', finalizeError);
    output.on('finish', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    });
    readable.pipe(output);
  });

  return {
    hash: hash.digest('hex'),
    size,
  };
}

async function moveFileSafely(src, dest) {
  try {
    await fsp.rename(src, dest);
    return;
  } catch (err) {
    if (err && err.code !== 'EXDEV') {
      throw err;
    }
  }

  await fsp.copyFile(src, dest);
  await fsp.unlink(src);
}

function getPoolFilePath(filename) {
  return path.join(poolDir, filename);
}

function buildOssKey(contentHash, filename) {
  const ext = getExtension(filename) || '.mp4';
  return `${ossPrefix}${contentHash}${ext}`;
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      if (stderr.length < 7000) {
        stderr += chunk.toString();
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg 执行失败 (exit=${code}) ${stderr.trim()}`));
      }
    });
  });
}

function buildFfmpegArgs({ inputPath, outputPath, videoCodec }) {
  const args = ['-y'];

  if (transcodeHwaccel) {
    args.push('-hwaccel', transcodeHwaccel);
  }

  args.push('-i', inputPath, '-map_metadata', '-1');

  if (Number.isFinite(transcodeMaxWidth) && transcodeMaxWidth > 0) {
    args.push('-vf', `scale='min(${transcodeMaxWidth},iw)':-2`);
  }

  args.push('-c:v', videoCodec);
  if (transcodePreset) {
    args.push('-preset', transcodePreset);
  }

  if (transcodeVideoBitrate) {
    args.push('-b:v', transcodeVideoBitrate, '-maxrate', transcodeVideoBitrate, '-bufsize', transcodeVideoBitrate);
  } else if (Number.isFinite(transcodeCrf)) {
    args.push('-crf', String(transcodeCrf));
  }

  args.push('-c:a', transcodeAudioCodec, '-b:a', transcodeAudioBitrate, '-ac', '2');
  args.push('-movflags', '+faststart', '-pix_fmt', 'yuv420p', outputPath);

  return args;
}

async function transcodeVideoFile(inputPath, originalName, codec) {
  const outputFilename = `${uuidv4()}-compressed.mp4`;
  const outputPath = path.join(tempDir, outputFilename);

  await runCommand(ffmpegPath, buildFfmpegArgs({
    inputPath,
    outputPath,
    videoCodec: codec,
  }));

  const stat = await fsp.stat(outputPath);
  const safeName = `${path.basename(originalName || 'video', path.extname(originalName || '')) || 'video'}.mp4`;

  return {
    path: outputPath,
    filename: outputFilename,
    originalName: safeName,
    mimeType: 'video/mp4',
    size: stat.size,
  };
}

async function maybeTranscodeVideo(inputPath, originalName) {
  if (!enableTranscode) {
    const stat = await fsp.stat(inputPath);
    return {
      path: inputPath,
      filename: path.basename(inputPath),
      originalName,
      mimeType: inferMimeFromExt(getExtension(originalName)) || 'video/mp4',
      size: stat.size,
      transcoded: false,
    };
  }

  try {
    const result = await transcodeVideoFile(inputPath, originalName, transcodeVideoCodec);
    await removeFileIfExists(inputPath);
    return { ...result, transcoded: true };
  } catch (err) {
    if (transcodeFallbackCpu && transcodeVideoCodec !== 'libx264') {
      const fallback = await transcodeVideoFile(inputPath, originalName, 'libx264');
      await removeFileIfExists(inputPath);
      return { ...fallback, transcoded: true, fallbackCodec: 'libx264' };
    }
    throw err;
  }
}

function clampPlaybackRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) {
    return 1;
  }
  return Math.max(0.25, Math.min(4, rate));
}

function clampCurrentTime(value) {
  const t = Number(value);
  if (!Number.isFinite(t)) {
    return 0;
  }
  return Math.max(0, t);
}

function parseBoundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseRoomMode(value) {
  const mode = String(value || '').trim();
  if (!mode || !['cloud', 'local_file'].includes(mode)) {
    throw new Error('roomMode 必须是 cloud 或 local_file');
  }
  return mode;
}

function parseUploadMode(value) {
  const mode = String(value || '').trim();
  if (!mode || !['cloud', 'local_file'].includes(mode)) {
    throw new Error('uploadMode 必须是 cloud 或 local_file');
  }
  return mode;
}

function incrementActiveRead(videoId) {
  activeMediaReads.set(videoId, Number(activeMediaReads.get(videoId) || 0) + 1);
}

function decrementActiveRead(videoId) {
  const next = Number(activeMediaReads.get(videoId) || 0) - 1;
  if (next <= 0) {
    activeMediaReads.delete(videoId);
  } else {
    activeMediaReads.set(videoId, next);
  }
}

function getProtectedVideoIds() {
  const ids = new Set();

  for (const [roomId, members] of roomMembers.entries()) {
    if (!members || members.size === 0) {
      continue;
    }

    const room = getRoomWithSource(roomId);
    if (!room) {
      continue;
    }

    const episodes = getRoomEpisodes(roomId, room);
    if (!episodes.length) {
      continue;
    }

    const state = roomPlayback.get(roomId) || getRoomPlaybackState(roomId) || getDefaultRoomState(room);
    const idx = Math.max(0, Math.min(Number(state.episodeIndex || 0), episodes.length - 1));
    const videoId = episodes[idx] && episodes[idx].videoId;
    if (videoId) {
      ids.add(videoId);
    }
  }

  for (const [videoId, count] of activeMediaReads.entries()) {
    if (count > 0) {
      ids.add(videoId);
    }
  }

  return ids;
}

function getProtectedFilenames(protectedVideoIds) {
  const names = new Set();
  for (const videoId of protectedVideoIds) {
    const video = getVideo(videoId);
    if (video && video.filename) {
      names.add(video.filename);
    }
  }
  return names;
}

async function getPoolUsageBytes() {
  let usage = 0;

  const entries = await fsp.readdir(poolDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const fullPath = path.join(poolDir, entry.name);
    const stat = await fsp.stat(fullPath);
    usage += stat.size;
  }

  return usage;
}

async function ensurePoolSpace(requiredBytes, protectedVideoIds) {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) {
    return;
  }

  let usage = await getPoolUsageBytes();
  if (usage + requiredBytes <= playPoolMaxBytes) {
    return;
  }

  const candidates = listLocalEvictionCandidates();
  const protectedFilenames = getProtectedFilenames(protectedVideoIds || new Set());
  const seenFilenames = new Set();

  for (const candidate of candidates) {
    const filename = candidate.filename;
    if (!filename || seenFilenames.has(filename)) {
      continue;
    }
    seenFilenames.add(filename);

    if (protectedFilenames.has(filename)) {
      continue;
    }

    const filePath = getPoolFilePath(filename);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (_err) {
      markLocalUnavailableByFilename(filename);
      continue;
    }

    await removeFileIfExists(filePath);
    usage -= stat.size;
    markLocalUnavailableByFilename(filename);

    if (usage + requiredBytes <= playPoolMaxBytes) {
      return;
    }
  }

  throw new Error('播放池空间不足，且没有可淘汰文件（可能都在播放中）。请扩容或稍后重试。');
}

async function placeFileIntoPool(tempPath, targetFilename) {
  const targetPath = getPoolFilePath(targetFilename);
  if (await fileExists(targetPath)) {
    const stat = await fsp.stat(targetPath);
    await removeFileIfExists(tempPath);
    markLocalAvailableByFilename(targetFilename, stat.size, nowIso());
    return {
      path: targetPath,
      size: stat.size,
    };
  }

  const stat = await fsp.stat(tempPath);
  await ensurePoolSpace(stat.size, getProtectedVideoIds());
  await moveFileSafely(tempPath, targetPath);
  markLocalAvailableByFilename(targetFilename, stat.size, nowIso());

  return {
    path: targetPath,
    size: stat.size,
  };
}

async function uploadToOss(localPath, ossKey) {
  if (!ossClient) {
    return;
  }
  await ossClient.put(ossKey, localPath);
}

async function downloadFromOss(ossKey, destinationPath) {
  if (!ossClient) {
    throw new Error('OSS 未配置');
  }
  await ossClient.get(ossKey, destinationPath);
}

async function withLocalFileLock(filename, fn) {
  const key = filename || '__unknown__';
  while (localFileLocks.has(key)) {
    // eslint-disable-next-line no-await-in-loop
    await localFileLocks.get(key);
  }

  let release;
  const lock = new Promise((resolve) => {
    release = resolve;
  });
  localFileLocks.set(key, lock);

  try {
    return await fn();
  } finally {
    localFileLocks.delete(key);
    release();
  }
}

async function ensureLocalVideoAvailable(videoId) {
  const video = getVideo(videoId);
  if (!video) {
    throw new Error('Video not found');
  }

  return withLocalFileLock(video.filename, async () => {
    const refreshed = getVideo(videoId) || video;
    const localPath = getPoolFilePath(refreshed.filename);

    if (await fileExists(localPath)) {
      const stat = await fsp.stat(localPath);
      markLocalAvailableByFilename(refreshed.filename, stat.size, nowIso());
      touchVideoAccess(refreshed.id, nowIso());
      touchVideosByFilename(refreshed.filename, nowIso());
      return {
        video: refreshed,
        path: localPath,
        size: stat.size,
      };
    }

    markLocalUnavailableByFilename(refreshed.filename);

    if (!ossClient || !refreshed.stored_in_oss || !refreshed.oss_key) {
      throw new Error('本地不存在该视频，且 OSS 不可用或未找到对象');
    }

    const tempPullPath = path.join(tempDir, `pull-${uuidv4()}${getExtension(refreshed.filename) || '.mp4'}`);
    await downloadFromOss(refreshed.oss_key, tempPullPath);

    const pulled = await hashFile(tempPullPath);
    if (refreshed.hash && normalizeHash(refreshed.hash) !== pulled.hash) {
      await removeFileIfExists(tempPullPath);
      throw new Error('从 OSS 回源后 hash 校验失败');
    }

    await ensurePoolSpace(pulled.size, getProtectedVideoIds());

    if (await fileExists(localPath)) {
      await removeFileIfExists(tempPullPath);
    } else {
      await moveFileSafely(tempPullPath, localPath);
    }

    markLocalAvailableByFilename(refreshed.filename, pulled.size, nowIso());
    touchVideoAccess(refreshed.id, nowIso());
    touchVideosByFilename(refreshed.filename, nowIso());

    return {
      video: refreshed,
      path: localPath,
      size: pulled.size,
    };
  });
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) {
    return null;
  }

  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;

  if (start === null && end === null) {
    return null;
  }

  if (start === null) {
    const suffixLen = end;
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      return null;
    }
    start = Math.max(0, size - suffixLen);
    end = size - 1;
  } else if (end === null) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start > end || start >= size) {
    return null;
  }

  end = Math.min(end, size - 1);
  return { start, end };
}

function updateVideoJobState(jobId, patch) {
  return updateVideoJob({
    id: jobId,
    ...patch,
    updatedAt: nowIso(),
  });
}

async function readDiskStatsSnapshot() {
  if (typeof fsp.statfs !== 'function') {
    return null;
  }

  try {
    const stat = await fsp.statfs(poolDir);
    const blockSize = toNumberSafe(stat.bsize || stat.frsize);
    if (!blockSize) {
      return null;
    }

    const totalBytes = blockSize * toNumberSafe(stat.blocks);
    const freeBytes = blockSize * toNumberSafe(stat.bavail || stat.bfree);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      totalBytes,
      freeBytes,
      usedBytes,
    };
  } catch (_err) {
    return null;
  }
}

async function getStorageSnapshot() {
  const poolUsage = await getPoolUsageBytes();
  const poolFiles = listLocalPoolFiles();
  const disk = await readDiskStatsSnapshot();

  return {
    pool: {
      dir: poolDir,
      maxBytes: playPoolMaxBytes,
      usageBytes: poolUsage,
      availableBytes: Math.max(0, playPoolMaxBytes - poolUsage),
      fileCount: poolFiles.length,
    },
    disk,
    oss: {
      enabled: Boolean(ossClient),
      bucket: ossBucket || null,
      region: ossRegion || null,
      prefix: ossPrefix || null,
    },
  };
}

async function storeVideoRecord({
  title,
  description,
  originalName,
  mimeType,
  sourceHash,
  sourceType,
  sourceValue,
  preparedFilePath,
  preparedFileName,
  onStage,
}) {
  const hash = normalizeHash(sourceHash);
  const existingByHash = getVideoByHash(hash);

  let filename = preparedFileName;
  let filePath = preparedFilePath;
  let fileSize = 0;

  if (existingByHash && existingByHash.filename) {
    filename = existingByHash.filename;
    const existedPath = getPoolFilePath(filename);

    if (await fileExists(existedPath)) {
      await removeFileIfExists(preparedFilePath);
      filePath = existedPath;
      const stat = await fsp.stat(existedPath);
      fileSize = stat.size;
    } else {
      const placed = await placeFileIntoPool(preparedFilePath, filename);
      filePath = placed.path;
      fileSize = placed.size;
    }
  } else {
    const placed = await placeFileIntoPool(preparedFilePath, filename);
    filePath = placed.path;
    fileSize = placed.size;
  }

  let storedInOss = Boolean(existingByHash && existingByHash.stored_in_oss);
  let ossKey = existingByHash ? (existingByHash.oss_key || '') : '';

  if (ossClient && hash) {
    if (!ossKey) {
      ossKey = buildOssKey(hash, filename);
    }

    if (!storedInOss) {
      if (onStage) {
        await onStage({
          stage: 'uploading_oss',
          status: 'processing',
          message: '后台传输到 OSS 中',
          progress: 0.92,
        });
      }
      await uploadToOss(filePath, ossKey);
      storedInOss = true;
      markVideosStoredInOssByHash(hash, ossKey);
    }
  }

  const createdAt = nowIso();
  const video = createVideo({
    id: uuidv4(),
    title: (title || '').trim() || originalName || 'Untitled video',
    description: (description || '').trim(),
    filename,
    originalName,
    mimeType,
    size: fileSize,
    hash,
    sourceType,
    sourceValue,
    ossKey,
    storedInOss,
    localAvailable: 1,
    lastAccessedAt: createdAt,
    localSize: fileSize,
    createdAt,
  });

  return video;
}

function isPathInDirectory(targetPath, baseDir) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseDir);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`);
}

async function processLocalUploadJob(jobId, payload) {
  let sourcePath = '';
  let workingPath = '';
  try {
    if (!payload?.file) {
      throw new Error('Video file is required');
    }

    sourcePath = path.join(tempDir, payload.file.filename);
    workingPath = sourcePath;

    updateVideoJobState(jobId, {
      status: 'processing',
      stage: 'hashing',
      message: '校验文件 hash 中',
      progress: 0.25,
      error: '',
    });

    assertSupportedFormat(payload.file.originalname, payload.file.mimetype);

    const sourceHashResult = await hashFile(sourcePath);

    const existing = getVideoByHash(sourceHashResult.hash);
    let preparedName = payload.file.filename;
    let preparedOriginalName = payload.file.originalname;
    let preparedMime = payload.file.mimetype || inferMimeFromExt(getExtension(payload.file.originalname)) || 'video/mp4';

    if (!existing && enableTranscode) {
      updateVideoJobState(jobId, {
        status: 'processing',
        stage: 'compressing',
        message: '压缩转码中（统一输出 MP4）',
        progress: 0.55,
      });
      const transcoded = await maybeTranscodeVideo(sourcePath, payload.file.originalname);
      workingPath = transcoded.path;
      preparedName = transcoded.filename;
      preparedOriginalName = transcoded.originalName;
      preparedMime = transcoded.mimeType;
    } else if (existing) {
      updateVideoJobState(jobId, {
        status: 'processing',
        stage: 'deduplicating',
        message: '检测到相同 hash，复用已存在资源',
        progress: 0.6,
      });
    }

    updateVideoJobState(jobId, {
      status: 'processing',
      stage: 'storing_local',
      message: '写入播放池中',
      progress: 0.78,
    });

    const video = await storeVideoRecord({
      title: payload.title,
      description: payload.description,
      originalName: preparedOriginalName,
      mimeType: preparedMime,
      sourceHash: sourceHashResult.hash,
      sourceType: 'local_upload',
      sourceValue: payload.file.originalname,
      preparedFilePath: workingPath,
      preparedFileName: existing ? existing.filename : preparedName,
      onStage: (stagePatch) => updateVideoJobState(jobId, stagePatch),
    });

    updateVideoJobState(jobId, {
      status: 'completed',
      stage: 'completed',
      message: '已完成',
      progress: 1,
      videoId: video.id,
      error: '',
    });
  } catch (err) {
    if (workingPath && isPathInDirectory(workingPath, tempDir)) {
      await removeFileIfExists(workingPath);
    }
    if (sourcePath && sourcePath !== workingPath && isPathInDirectory(sourcePath, tempDir)) {
      await removeFileIfExists(sourcePath);
    }

    updateVideoJobState(jobId, {
      status: 'failed',
      stage: 'failed',
      message: '处理失败',
      progress: 1,
      error: err?.message || '未知错误',
    });
  }
}

function buildLocalHashPlaceholderName(contentHash) {
  const prefix = String(contentHash || '').slice(0, 12) || uuidv4();
  return `local-hash-${prefix}.mp4`;
}

async function processLocalHashOnlyJob(jobId, payload) {
  try {
    const contentHash = validateRequiredHash(payload?.contentHash, 'contentHash');
    const localFileName = String(payload?.localFileName || '').trim();
    const placeholderName = buildLocalHashPlaceholderName(contentHash);
    const originalName = localFileName || placeholderName;

    updateVideoJobState(jobId, {
      status: 'processing',
      stage: 'registering_local_hash',
      message: '注册本地模式视频 hash',
      progress: 0.6,
      error: '',
    });

    const existing = getVideoByHash(contentHash);
    const video = existing || createVideo({
      id: uuidv4(),
      title: (payload?.title || '').trim() || `本地模式视频 ${contentHash.slice(0, 8)}`,
      description: (payload?.description || '').trim(),
      filename: placeholderName,
      originalName,
      mimeType: 'video/mp4',
      size: 0,
      hash: contentHash,
      sourceType: 'local_hash',
      sourceValue: localFileName || contentHash,
      ossKey: '',
      storedInOss: 0,
      localAvailable: 0,
      lastAccessedAt: nowIso(),
      localSize: 0,
      createdAt: nowIso(),
    });

    updateVideoJobState(jobId, {
      status: 'completed',
      stage: 'completed',
      message: existing ? 'hash 已存在，复用视频记录' : '本地模式视频已登记',
      progress: 1,
      videoId: video.id,
      error: '',
    });
  } catch (err) {
    updateVideoJobState(jobId, {
      status: 'failed',
      stage: 'failed',
      message: '处理失败',
      progress: 1,
      error: err?.message || '未知错误',
    });
  }
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(String(password || ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password, storedHash) {
  const raw = String(storedHash || '');
  const parts = raw.split('$');
  if (parts.length === 3 && parts[0] === 'scrypt') {
    const [, salt, digestHex] = parts;
    const actual = scryptSync(String(password || ''), salt, 64);
    const expected = Buffer.from(digestHex, 'hex');
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  }
  return false;
}

function validateUserInput(username, password) {
  const safeUsername = normalizeUsername(username);
  if (!/^[a-z0-9_]{3,32}$/.test(safeUsername)) {
    throw new Error('用户名需为 3-32 位，且仅支持小写字母/数字/下划线');
  }
  const safePassword = String(password || '');
  return { safeUsername, safePassword };
}

app.post('/api/auth/register', (req, res, next) => {
  try {
    const { safeUsername, safePassword } = validateUserInput(req.body?.username, req.body?.password);
    if (getUserByUsername(safeUsername)) {
      res.status(409).json({ error: '用户名已存在' });
      return;
    }

    const createdAt = nowIso();
    const role = countUsers() === 0 ? 'root' : 'user';
    const passwordHash = hashPassword(safePassword);
    const user = createUser({
      id: uuidv4(),
      username: safeUsername,
      passwordHash,
      role,
      createdAt,
      updatedAt: createdAt,
      lastLoginAt: createdAt,
    });

    const token = issueAuthToken(user);
    res.cookie(authTokenCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ token, user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || '');
    const user = getUserByUsername(username);
    if (!user) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    const ok = verifyPassword(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    const loginAt = nowIso();
    touchUserLastLogin(user.id, loginAt);
    const refreshed = getUserById(user.id) || user;

    const token = issueAuthToken(refreshed);
    res.cookie(authTokenCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.json({ token, user: serializeUser(refreshed) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(authTokenCookieName);
  res.json({ ok: true });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ isAuthenticated: true, user: req.authUser });
});

app.get('/api/supported-formats', authRequired, (_req, res) => {
  res.json({
    uploadModes: [
      { value: 'cloud', label: '云端托管（上传文件）' },
      { value: 'local_file', label: '本地模式（前端计算 hash，仅上传 contentHash）' },
    ],
    formats: SUPPORTED_VIDEO_FORMATS,
    transcode: {
      enabled: enableTranscode,
      unifiedOutput: 'mp4(h264/aac)',
      ffmpegPath,
      videoCodec: transcodeVideoCodec,
      audioCodec: transcodeAudioCodec,
      preset: transcodePreset,
      maxWidth: transcodeMaxWidth,
      videoBitrate: transcodeVideoBitrate || null,
      crf: transcodeVideoBitrate ? null : transcodeCrf,
      hwaccel: transcodeHwaccel || null,
      fallbackCpu: transcodeFallbackCpu,
    },
    storage: {
      poolDir,
      poolMaxBytes: playPoolMaxBytes,
      ossEnabled: Boolean(ossClient),
      ossBucket: ossBucket || null,
      ossRegion: ossRegion || null,
      ossPrefix: ossPrefix || null,
    },
    sync: {
      driftSoftThresholdMs: syncDriftSoftThresholdMs,
      driftHardThresholdMs: syncDriftHardThresholdMs,
      autoplayCountdownSeconds,
    },
    note: '最终播放能力取决于浏览器对编码器/封装格式的支持。',
  });
});

app.get('/api/storage', authRequired, async (_req, res, next) => {
  try {
    const snapshot = await getStorageSnapshot();
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/storage', authRequired, authRootRequired, async (_req, res, next) => {
  try {
    const snapshot = await getStorageSnapshot();
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/video-jobs', authRequired, authRootRequired, (req, res) => {
  const status = String(req.query.status || '').trim();
  const limit = parseBoundedInt(req.query.limit, 50, 1, 200);
  const offset = parseBoundedInt(req.query.offset, 0, 0, 1000000);
  const jobs = listVideoJobs({ status, limit, offset }).map(serializeVideoJob);
  const total = countVideoJobs({ status });
  res.json({
    jobs,
    paging: {
      status: status || null,
      limit,
      offset,
      total,
    },
  });
});

app.delete('/api/admin/video-jobs', authRequired, authRootRequired, (req, res) => {
  const olderThanDays = parseBoundedInt(req.query.olderThanDays, 30, 1, 3650);
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const removed = cleanupOldVideoJobs(cutoff);
  res.json({
    ok: true,
    removed,
    olderThanDays,
    cutoff,
  });
});

app.post('/api/videos', authRequired, upload.single('video'), async (req, res, next) => {
  try {
    let uploadMode;
    try {
      uploadMode = parseUploadMode(req.body?.uploadMode || 'cloud');
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }

    if (uploadMode === 'cloud' && !req.file) {
      res.status(400).json({ error: 'Video file is required in cloud mode' });
      return;
    }
    if (uploadMode === 'local_file') {
      try {
        validateRequiredHash(req.body?.contentHash, 'contentHash');
      } catch (err) {
        res.status(400).json({ error: err.message });
        return;
      }
    }

    const createdAt = nowIso();
    const job = createVideoJob({
      id: uuidv4(),
      videoId: null,
      sourceType: uploadMode === 'local_file' ? 'local_hash' : 'local_upload',
      status: 'processing',
      stage: 'upload_received',
      message: uploadMode === 'local_file'
        ? '本地模式 hash 已提交，等待处理'
        : '文件已上传，等待处理',
      progress: 0.12,
      error: '',
      createdAt,
      updatedAt: createdAt,
    });

    if (uploadMode === 'local_file') {
      if (req.file?.filename) {
        await removeFileIfExists(path.join(tempDir, req.file.filename));
      }
      processLocalHashOnlyJob(job.id, {
        title: req.body.title,
        description: req.body.description,
        contentHash: req.body.contentHash,
        localFileName: req.body.localFileName,
      }).catch(() => {
        // handled in job processor
      });
    } else {
      const payload = {
        file: {
          filename: req.file.filename,
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
        },
        title: req.body.title,
        description: req.body.description,
      };

      processLocalUploadJob(job.id, payload).catch(() => {
        // handled in job processor
      });
    }

    res.status(202).json({ job: serializeVideoJob(job) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/video-jobs/:jobId', authRequired, (req, res) => {
  const job = getVideoJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({ job: serializeVideoJob(job) });
});

app.get('/api/videos', authRequired, (_req, res) => {
  const videos = listVideos().map(serializeVideo);
  res.json({ videos });
});

app.get('/api/videos/:videoId', authRequired, (req, res) => {
  const video = getVideo(req.params.videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }
  res.json({ video: serializeVideo(video) });
});

app.get('/media/:videoId', authRequired, async (req, res, next) => {
  let video;
  try {
    video = getVideo(req.params.videoId);
    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }
    if (video.source_type === 'local_hash') {
      res.status(404).json({ error: '该视频为本地模式，仅支持客户端本地文件播放' });
      return;
    }

    const ensured = await ensureLocalVideoAvailable(req.params.videoId);
    video = ensured.video;

    const filePath = ensured.path;
    const stat = await fsp.stat(filePath);
    const fileSize = stat.size;
    const mime = video.mime_type || 'video/mp4';
    const hasRangeHeader = Boolean(req.headers.range);
    const range = parseRangeHeader(req.headers.range, fileSize);

    const accessAt = nowIso();
    touchVideoAccess(video.id, accessAt);
    touchVideosByFilename(video.filename, accessAt);
    markLocalAvailableByFilename(video.filename, fileSize, accessAt);

    incrementActiveRead(video.id);

    const finalize = () => {
      decrementActiveRead(video.id);
    };

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=60');

    if (hasRangeHeader && !range) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.end();
      finalize();
      return;
    }

    if (!range) {
      res.status(200);
      res.setHeader('Content-Length', String(fileSize));
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        finalize();
        next(err);
      });
      res.on('close', finalize);
      stream.pipe(res);
      return;
    }

    const { start, end } = range;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', String(chunkSize));

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (err) => {
      finalize();
      next(err);
    });
    res.on('close', finalize);
    stream.pipe(res);
  } catch (err) {
    if (err?.message === 'Video not found') {
      res.status(404).json({ error: 'Video not found' });
      return;
    }
    next(err);
  }
});

app.get('/api/videos/:videoId/rooms', authRequired, (req, res) => {
  const video = getVideo(req.params.videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const rooms = listRoomsByVideo(video.id).map(serializeRoom);
  res.json({ rooms });
});

app.post('/api/videos/:videoId/rooms', authRequired, (req, res) => {
  const video = getVideo(req.params.videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  let roomMode;
  try {
    roomMode = parseRoomMode(req.body.roomMode);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (video.source_type === 'local_hash' && roomMode !== 'local_file') {
    res.status(400).json({ error: '本地模式视频仅允许创建 local_file 放映室' });
    return;
  }

  const roomName = (req.body.roomName || '').trim() || `${video.title} - 放映室`;

  const room = createRoom({
    id: uuidv4(),
    videoId: video.id,
    playlistId: null,
    startEpisodeIndex: 0,
    name: roomName,
    creatorName: req.authUser.username,
    creatorToken: `deprecated-${uuidv4()}`,
    createdByUserId: req.authUser.id,
    roomMode,
    createdAt: nowIso(),
  });

  const fullRoom = getRoomWithSource(room.id);
  res.status(201).json({ room: serializeRoom(fullRoom) });
});

app.post('/api/playlists', authRequired, (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  const episodeVideoIds = Array.isArray(req.body.episodeVideoIds)
    ? req.body.episodeVideoIds.map((id) => String(id))
    : [];

  if (!name) {
    res.status(400).json({ error: '列表名称不能为空' });
    return;
  }

  if (!episodeVideoIds.length) {
    res.status(400).json({ error: '列表至少需要 1 集视频' });
    return;
  }

  const uniqueIds = [...new Set(episodeVideoIds)];
  const videos = uniqueIds.map((id) => getVideo(id)).filter(Boolean);
  if (videos.length !== uniqueIds.length) {
    res.status(400).json({ error: 'episodeVideoIds 中存在无效视频' });
    return;
  }

  const playlistId = uuidv4();
  const createdAt = nowIso();

  createPlaylist({
    playlist: {
      id: playlistId,
      name,
      description,
      createdAt,
    },
    episodeItems: episodeVideoIds.map((videoId, index) => ({
      id: uuidv4(),
      playlistId,
      videoId,
      episodeIndex: index,
      titleOverride: '',
      createdAt,
    })),
  });

  const playlist = getPlaylist(playlistId);
  res.status(201).json({ playlist: serializePlaylist(playlist) });
});

app.get('/api/playlists', authRequired, (_req, res) => {
  const playlists = listPlaylists().map((playlist) => serializePlaylist(playlist));
  res.json({ playlists });
});

app.get('/api/playlists/:playlistId', authRequired, (req, res) => {
  const playlist = getPlaylist(req.params.playlistId);
  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }

  res.json({ playlist: serializePlaylist(playlist) });
});

app.post('/api/playlists/:playlistId/rooms', authRequired, (req, res) => {
  const playlist = getPlaylist(req.params.playlistId);
  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }

  const episodes = listPlaylistEpisodes(playlist.id);
  if (!episodes.length) {
    res.status(400).json({ error: 'Playlist has no episodes' });
    return;
  }

  let roomMode;
  try {
    roomMode = parseRoomMode(req.body.roomMode);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (roomMode !== 'local_file' && episodes.some((item) => item.video_source_type === 'local_hash')) {
    res.status(400).json({ error: '列表包含本地模式视频，仅允许创建 local_file 放映室' });
    return;
  }

  const roomName = (req.body.roomName || '').trim() || `${playlist.name} - 放映室`;
  const startEpisodeIndex = Math.max(0, Math.min(Number(req.body.startEpisodeIndex || 0), episodes.length - 1));

  const room = createRoom({
    id: uuidv4(),
    videoId: episodes[0].video_id,
    playlistId: playlist.id,
    startEpisodeIndex,
    name: roomName,
    creatorName: req.authUser.username,
    creatorToken: `deprecated-${uuidv4()}`,
    createdByUserId: req.authUser.id,
    roomMode,
    createdAt: nowIso(),
  });

  const fullRoom = getRoomWithSource(room.id);
  res.status(201).json({ room: serializeRoom(fullRoom) });
});

app.get('/api/rooms', authRequired, (_req, res) => {
  const rooms = listAllRooms().map(serializeRoom);
  res.json({ rooms });
});

app.get('/api/rooms/:roomId', authRequired, (req, res) => {
  const room = getRoomWithSource(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  const playlist = buildRoomPlaylist(room);
  if (!playlist || !playlist.episodes.length) {
    res.status(404).json({ error: 'Room playlist not found' });
    return;
  }

  const persisted = getRoomPlaybackState(room.id) || getDefaultRoomState(room);
  const live = roomPlayback.get(room.id);

  const state = {
    episodeIndex: Number(live?.episodeIndex ?? persisted.episodeIndex),
    playbackRate: Number(live?.playbackRate ?? persisted.playbackRate ?? 1),
    currentTime: Number(live?.currentTime ?? persisted.currentTime ?? 0),
    isPlaying: Boolean(live?.isPlaying ?? persisted.isPlaying),
    updatedAt: live?.updatedAt || persisted.updatedAt || nowIso(),
  };

  const progress = {
    totalWatchedSeconds: Number(persisted.totalWatchedSeconds || 0),
    episodes: listRoomEpisodeProgress(room.id),
  };

  res.json({
    room: serializeRoom(room),
    playlist: {
      id: playlist.id,
      name: playlist.name,
      episodes: playlist.episodes,
    },
    state,
    progress,
    localFileRequirement: buildLocalFileRequiredPayload(room.id, state),
    syncConfig: {
      driftSoftThresholdMs: syncDriftSoftThresholdMs,
      driftHardThresholdMs: syncDriftHardThresholdMs,
      autoplayCountdownSeconds,
    },
  });
});

app.delete('/api/rooms/:roomId', authRequired, (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }

  const creatorAllowed = isRoomOwner(room.id, req.authUser.id);
  const rootAllowed = req.authUser.role === 'root';

  if (!rootAllowed && !creatorAllowed) {
    res.status(403).json({ error: 'Only creator or root can delete this room' });
    return;
  }

  closeRoom(room.id, rootAllowed ? 'deleted-by-root' : 'deleted-by-creator');
  res.json({ ok: true });
});

app.get('/api/admin/rooms', authRequired, authRootRequired, (_req, res) => {
  const rooms = listAllRooms().map(serializeRoom);
  res.json({ rooms });
});

app.delete('/api/admin/rooms/:roomId', authRequired, authRootRequired, (req, res) => {
  const ok = closeRoom(req.params.roomId, 'deleted-by-root');
  if (!ok) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  res.json({ ok: true });
});

app.get('/videos/:videoId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

app.get('/videos', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'videos.html'));
});

app.get('/upload', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

app.get('/rooms/:roomId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.use((socket, next) => {
  const token = getSocketAuthToken(socket);
  if (!token) {
    next(new Error('Authentication required'));
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret);
  } catch (_err) {
    next(new Error('Invalid authentication token'));
    return;
  }

  const user = getUserById(payload.uid);
  if (!user) {
    next(new Error('User not found'));
    return;
  }

  socket.data.userId = user.id;
  socket.data.username = user.username;
  socket.data.userRole = user.role || 'user';
  socket.data.roomId = null;
  next();
});

io.on('connection', (socket) => {
  socket.on('join-room', (payload = {}, callback) => {
    const roomId = String(payload.roomId || '').trim();
    if (!roomId) {
      callback?.({ ok: false, error: 'roomId is required' });
      return;
    }

    const room = getRoomWithSource(roomId);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found' });
      return;
    }

    removeSocketFromRoom(socket);
    ensureRoomState(roomId, room);

    const name = socket.data.username || `用户-${socket.id.slice(0, 5)}`;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = name;

    const members = roomMembers.get(roomId);
    members.set(socket.id, {
      id: socket.id,
      name,
      userId: socket.data.userId,
    });

    const existingParticipants = [...members.values()].filter((member) => member.id !== socket.id);

    socket.emit('existing-participants', { participants: existingParticipants });
    socket.emit('chat-history', { messages: roomMessages.get(roomId) || [] });
    socket.emit('playback-state', roomPlayback.get(roomId));
    const localFileRequired = buildLocalFileRequiredPayload(roomId);
    if (localFileRequired) {
      socket.emit('local-file-required', localFileRequired);
    }

    socket.to(roomId).emit('participant-joined', {
      id: socket.id,
      name,
    });

    callback?.({ ok: true, participants: existingParticipants });
  });

  socket.on('local-file-verified', (payload = {}, callback) => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      callback?.({ ok: false, error: 'Not in room' });
      return;
    }

    const room = getRoomWithSource(roomId);
    if (!room || room.room_mode !== 'local_file') {
      callback?.({ ok: false, error: 'Room is not local_file mode' });
      return;
    }

    const episodes = getRoomEpisodes(roomId, room);
    if (!episodes.length) {
      callback?.({ ok: false, error: 'No episodes' });
      return;
    }

    const episodeIndex = Math.max(0, Math.min(Number(payload.episodeIndex || 0), episodes.length - 1));
    const episode = episodes[episodeIndex];
    const expected = normalizeHash(episode?.contentHash || '');
    const provided = normalizeHash(payload.contentHash || '');
    if (!expected || expected !== provided) {
      callback?.({ ok: false, error: 'contentHash mismatch' });
      return;
    }

    setRoomVerification(roomId, socket.data.userId, episodeIndex, provided);
    callback?.({ ok: true, episodeIndex, contentHash: provided });
  });

  socket.on('chat-message', ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      return;
    }

    const value = (text || '').trim();
    if (!value) {
      return;
    }

    const message = {
      id: uuidv4(),
      senderId: socket.id,
      senderName: socket.data.username || '匿名用户',
      text: value,
      createdAt: nowIso(),
    };

    const messages = roomMessages.get(roomId) || [];
    messages.push(message);
    if (messages.length > 100) {
      messages.shift();
    }
    roomMessages.set(roomId, messages);

    io.to(roomId).emit('chat-message', message);
  });

  socket.on('playback-update', (payload = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      return;
    }

    const room = getRoomWithSource(roomId);
    if (!room) {
      return;
    }

    ensureRoomState(roomId, room);

    const episodes = getRoomEpisodes(roomId, room);
    const prev = roomPlayback.get(roomId) || getDefaultRoomState(room);

    const nextEpisodeIndex = Math.max(
      0,
      Math.min(Number(payload.episodeIndex ?? prev.episodeIndex ?? 0), Math.max(0, episodes.length - 1)),
    );

    const nextCurrentTime = clampCurrentTime(payload.currentTime ?? prev.currentTime);
    const nextPlaybackRate = clampPlaybackRate(payload.playbackRate ?? prev.playbackRate);
    const nextIsPlaying = typeof payload.isPlaying === 'boolean' ? payload.isPlaying : prev.isPlaying;
    const action = (payload.action || '').trim();
    const countdownSeconds = Number(payload.countdownSeconds);
    const countdownToEpisode = Number(payload.countdownToEpisode);
    const prevEpisodeIndex = Math.max(
      0,
      Math.min(Number(prev.episodeIndex || 0), Math.max(0, episodes.length - 1)),
    );

    let watchedDelta = 0;
    if (prev.episodeIndex === nextEpisodeIndex) {
      const delta = nextCurrentTime - Number(prev.currentTime || 0);
      if (delta > 0 && delta <= 15 && action !== 'seek' && action !== 'episode-switch') {
        watchedDelta = delta;
      }
    }

    const selectedEpisode = episodes[nextEpisodeIndex] || null;
    if (room.room_mode === 'local_file') {
      const isEpisodeSwitch = action === 'episode-switch' && nextEpisodeIndex !== prevEpisodeIndex;
      const gateEpisodeIndex = isEpisodeSwitch ? prevEpisodeIndex : nextEpisodeIndex;
      const gateEpisode = episodes[gateEpisodeIndex] || null;
      const gateHash = normalizeHash(gateEpisode?.contentHash || '');

      if (!gateHash || !isRoomEpisodeVerified(roomId, socket.data.userId, gateEpisodeIndex, gateHash)) {
        const requiredPayload = buildLocalFileRequiredPayload(roomId, {
          ...prev,
          episodeIndex: gateEpisodeIndex,
        });
        if (requiredPayload) {
          socket.emit('local-file-required', requiredPayload);
        }
        socket.emit('playback-denied', {
          reason: 'local-file-unverified',
          requiredEpisodeIndex: gateEpisodeIndex,
          requestedEpisodeIndex: nextEpisodeIndex,
          contentHash: gateHash,
          title: gateEpisode?.title || '',
        });
        return;
      }
    }

    const persisted = updateRoomPlaybackState({
      roomId,
      episodeIndex: nextEpisodeIndex,
      currentTime: nextCurrentTime,
      playbackRate: nextPlaybackRate,
      isPlaying: nextIsPlaying,
      updatedAt: nowIso(),
      watchedDelta,
      videoId: selectedEpisode ? selectedEpisode.videoId : '',
      maxPosition: nextCurrentTime,
      durationSeconds: Number(payload.duration || 0),
    });

    const nextState = {
      action,
      currentTime: nextCurrentTime,
      isPlaying: nextIsPlaying,
      playbackRate: nextPlaybackRate,
      episodeIndex: nextEpisodeIndex,
      totalWatchedSeconds: Number(persisted?.totalWatchedSeconds || prev.totalWatchedSeconds || 0),
      by: socket.data.username || '匿名用户',
      updatedAt: persisted?.updatedAt || nowIso(),
    };

    if (action === 'autoplay-countdown') {
      nextState.countdownSeconds = Number.isFinite(countdownSeconds)
        ? Math.max(1, Math.min(30, Math.floor(countdownSeconds)))
        : autoplayCountdownSeconds;
      nextState.countdownToEpisode = Number.isFinite(countdownToEpisode)
        ? Math.max(0, Math.min(Math.floor(countdownToEpisode), Math.max(0, episodes.length - 1)))
        : Math.min(nextEpisodeIndex + 1, Math.max(0, episodes.length - 1));
    }

    roomPlayback.set(roomId, nextState);
    socket.to(roomId).emit('playback-update', nextState);
    if (room.room_mode === 'local_file' && Number(prev.episodeIndex || 0) !== nextEpisodeIndex) {
      const requiredPayload = buildLocalFileRequiredPayload(roomId, nextState);
      if (requiredPayload) {
        io.to(roomId).emit('local-file-required', requiredPayload);
      }
    }
  });

  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    io.to(targetId).emit('webrtc-offer', {
      fromId: socket.id,
      sdp,
      name: socket.data.username,
    });
  });

  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    io.to(targetId).emit('webrtc-answer', {
      fromId: socket.id,
      sdp,
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-candidate', {
      fromId: socket.id,
      candidate,
    });
  });

  socket.on('leave-room', () => {
    removeSocketFromRoom(socket);
  });

  socket.on('disconnect', () => {
    removeSocketFromRoom(socket);
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err?.message) {
    res.status(400).json({ error: err.message });
    return;
  }

  res.status(500).json({ error: 'Unexpected server error' });
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Watch-party server running at http://localhost:${port}`);
});
