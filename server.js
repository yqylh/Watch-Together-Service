require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require('crypto');
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
  deleteVideo,
  updateVideoCover,
  listVideos,
  createPlaylist,
  getPlaylist,
  deletePlaylist,
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
const host = process.env.HOST || '0.0.0.0';
const jwtSecret = process.env.JWT_SECRET || 'replace-this-secret';
const authTokenCookieName = 'auth_token';

const tempDir = path.join(os.tmpdir(), 'remote-watching-sync-cover-upload');
const coversDir = path.join(__dirname, process.env.COVERS_DIR || 'covers');
const syncDriftSoftThresholdMs = Math.max(50, Number(process.env.SYNC_DRIFT_SOFT_THRESHOLD_MS || 200));
const syncDriftHardThresholdMs = Math.max(syncDriftSoftThresholdMs, Number(process.env.SYNC_DRIFT_HARD_THRESHOLD_MS || 1200));
const autoplayCountdownSeconds = Math.max(3, Math.min(30, Number(process.env.AUTOPLAY_COUNTDOWN_SECONDS || 8)));

for (const dir of [tempDir, coversDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

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
const SUPPORTED_COVER_MIME_SET = new Set(['image/jpeg', 'image/png', 'image/webp']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tempDir),
  filename: (_req, file, cb) => {
    const ext = getExtension(file.originalname) || '.mp4';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const coverUpload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || '').toLowerCase();
    if (!SUPPORTED_COVER_MIME_SET.has(mime)) {
      cb(new Error('封面仅支持 jpeg/png/webp'));
      return;
    }
    cb(null, true);
  },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use('/covers', express.static(coversDir));

const roomMembers = new Map();
const roomPlayback = new Map();
const roomMessages = new Map();
const roomEpisodes = new Map();

function nowIso() {
  return new Date().toISOString();
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

function serializeRoom(room) {
  const members = roomMembers.get(room.id);
  return {
    id: room.id,
    videoId: room.video_id,
    playlistId: room.playlist_id || null,
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
  const rooms = listRoomsLinkedToVideo(video.id).map(serializeRoom);
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    originalName: video.original_name,
    mimeType: video.mime_type,
    size: video.size,
    contentHash: video.hash || '',
    createdAt: video.created_at,
    watchUrl: `/videos/${video.id}`,
    coverUrl: video.cover_filename ? `/covers/${video.cover_filename}` : null,
    rooms,
  };
}

function listRoomsLinkedToVideo(videoId) {
  const roomMap = new Map();

  listRoomsByVideo(videoId).forEach((room) => {
    roomMap.set(room.id, room);
  });

  const playlists = listPlaylists();
  playlists.forEach((playlist) => {
    const episodes = listPlaylistEpisodes(playlist.id);
    const includesVideo = episodes.some((item) => String(item.video_id || '') === String(videoId || ''));
    if (!includesVideo) {
      return;
    }
    listRoomsByPlaylist(playlist.id).forEach((room) => {
      roomMap.set(room.id, room);
    });
  });

  return [...roomMap.values()];
}

function serializePlaylistEpisode(item) {
  const title = item.title_override && item.title_override.trim()
    ? item.title_override.trim()
    : item.video_title;

  return {
    id: item.id,
    playlistId: item.playlist_id,
    videoId: item.video_id,
    episodeIndex: item.episode_index,
    title,
    originalTitle: item.video_title,
    watchUrl: `/videos/${item.video_id}`,
    mimeType: item.video_mime_type,
    size: item.video_size,
    contentHash: item.video_hash || '',
    coverUrl: item.video_cover_filename ? `/covers/${item.video_cover_filename}` : null,
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
      watchUrl: `/videos/${video.id}`,
      mimeType: video.mime_type,
      size: video.size,
      contentHash: video.hash || '',
      coverUrl: video.cover_filename ? `/covers/${video.cover_filename}` : null,
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
    members.delete(socket.id);
    socket.to(roomId).emit('participant-left', {
      id: socket.id,
      name: socket.data.username,
    });

    if (members.size === 0) {
      roomMembers.delete(roomId);
      roomMessages.delete(roomId);
      roomPlayback.delete(roomId);
      roomEpisodes.delete(roomId);
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
  return deleteRoom(roomId);
}

async function removeFileIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (_err) {
    // ignore
  }
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

function buildLocalHashPlaceholderName(contentHash) {
  const prefix = String(contentHash || '').slice(0, 12) || uuidv4();
  return `local-hash-${prefix}.mp4`;
}

async function persistCoverFile(file, contentHash = '') {
  if (!file?.path || !file?.filename) {
    return { coverFilename: '', coverMimeType: '' };
  }

  const mime = String(file.mimetype || '').toLowerCase();
  const ext = getExtension(file.originalname)
    || (mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg');
  const prefix = String(contentHash || '').slice(0, 12) || uuidv4().slice(0, 12);
  const filename = `${prefix}-${uuidv4()}${ext}`;
  const targetPath = path.join(coversDir, filename);

  await moveFileSafely(file.path, targetPath);

  return {
    coverFilename: filename,
    coverMimeType: mime,
  };
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
    formats: SUPPORTED_VIDEO_FORMATS,
    coverFormats: ['image/jpeg', 'image/png', 'image/webp'],
    sync: {
      driftSoftThresholdMs: syncDriftSoftThresholdMs,
      driftHardThresholdMs: syncDriftHardThresholdMs,
      autoplayCountdownSeconds,
    },
    note: '视频源文件不上传到服务端，仅提交前端计算出的 SHA-256 与可选封面。',
  });
});

app.post('/api/videos', authRequired, coverUpload.single('cover'), async (req, res, next) => {
  let uploadedCoverPath = '';
  let savedCoverFilename = '';
  try {
    const contentHash = validateRequiredHash(req.body?.contentHash, 'contentHash');
    const localFileName = String(req.body?.localFileName || '').trim();
    const localMimeType = String(req.body?.localMimeType || '').trim().toLowerCase();
    const parsedLocalSize = Number(req.body?.localFileSize || 0);
    const localFileSize = Number.isFinite(parsedLocalSize) && parsedLocalSize > 0
      ? Math.floor(parsedLocalSize)
      : 0;

    const originalName = localFileName || buildLocalHashPlaceholderName(contentHash);
    const inferredMime = inferMimeFromExt(getExtension(originalName)) || '';
    const mimeType = localMimeType || inferredMime || 'video/mp4';

    if (!isSupportedFormat(originalName, mimeType)) {
      res.status(400).json({ error: '不支持该视频格式，请查看 /api/supported-formats' });
      return;
    }

    let coverFilename = '';
    let coverMimeType = '';
    if (req.file) {
      uploadedCoverPath = req.file.path;
      const cover = await persistCoverFile(req.file, contentHash);
      coverFilename = cover.coverFilename;
      coverMimeType = cover.coverMimeType;
      savedCoverFilename = coverFilename;
      uploadedCoverPath = '';
    }

    const existing = getVideoByHash(contentHash);
    if (existing) {
      let updated = existing;
      if (coverFilename) {
        if (existing.cover_filename) {
          await removeFileIfExists(path.join(coversDir, existing.cover_filename));
        }
        updated = updateVideoCover(existing.id, coverFilename, coverMimeType) || existing;
        savedCoverFilename = '';
      }
      res.json({ video: serializeVideo(updated), reused: true });
      return;
    }

    const createdAt = nowIso();
    const video = createVideo({
      id: uuidv4(),
      title: (req.body?.title || '').trim() || `本地模式视频 ${contentHash.slice(0, 8)}`,
      description: (req.body?.description || '').trim(),
      filename: buildLocalHashPlaceholderName(contentHash),
      originalName,
      mimeType,
      size: localFileSize,
      hash: contentHash,
      coverFilename,
      coverMimeType,
      createdAt,
    });
    savedCoverFilename = '';

    res.status(201).json({ video: serializeVideo(video), reused: false });
  } catch (err) {
    if (uploadedCoverPath) {
      await removeFileIfExists(uploadedCoverPath);
    }
    if (savedCoverFilename) {
      await removeFileIfExists(path.join(coversDir, savedCoverFilename));
    }
    next(err);
  }
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

app.get('/api/videos/:videoId/rooms', authRequired, (req, res) => {
  const video = getVideo(req.params.videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
    return;
  }

  const rooms = listRoomsLinkedToVideo(video.id).map(serializeRoom);
  res.json({ rooms });
});

app.post('/api/videos/:videoId/rooms', authRequired, (req, res) => {
  const video = getVideo(req.params.videoId);
  if (!video) {
    res.status(404).json({ error: 'Video not found' });
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
    createdByUserId: req.authUser.id,
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

  const roomName = (req.body.roomName || '').trim() || `${playlist.name} - 放映室`;
  const startEpisodeIndex = Math.max(0, Math.min(Number(req.body.startEpisodeIndex || 0), episodes.length - 1));

  const room = createRoom({
    id: uuidv4(),
    videoId: episodes[0].video_id,
    playlistId: playlist.id,
    startEpisodeIndex,
    name: roomName,
    creatorName: req.authUser.username,
    createdByUserId: req.authUser.id,
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

app.delete('/api/admin/videos/:videoId', authRequired, authRootRequired, async (req, res, next) => {
  try {
    const video = getVideo(req.params.videoId);
    if (!video) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    const roomIds = [...new Set(listRoomsByVideo(video.id).map((room) => room.id).filter(Boolean))];
    let closedRoomCount = 0;
    roomIds.forEach((roomId) => {
      if (closeRoom(roomId, 'video-deleted-by-root')) {
        closedRoomCount += 1;
      }
    });

    const ok = deleteVideo(video.id);
    if (!ok) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    if (video.cover_filename) {
      await removeFileIfExists(path.join(coversDir, video.cover_filename));
    }

    res.json({
      ok: true,
      videoId: video.id,
      closedRooms: closedRoomCount,
    });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/admin/playlists/:playlistId', authRequired, authRootRequired, (req, res) => {
  const playlist = getPlaylist(req.params.playlistId);
  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }

  const roomIds = [...new Set(listRoomsByPlaylist(playlist.id).map((room) => room.id).filter(Boolean))];
  let closedRoomCount = 0;
  roomIds.forEach((roomId) => {
    if (closeRoom(roomId, 'playlist-deleted-by-root')) {
      closedRoomCount += 1;
    }
  });

  const ok = deletePlaylist(playlist.id);
  if (!ok) {
    res.status(404).json({ error: 'Playlist not found' });
    return;
  }

  res.json({
    ok: true,
    playlistId: playlist.id,
    closedRooms: closedRoomCount,
  });
});

app.get('/videos/:videoId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

app.get('/videos', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'videos.html'));
});

app.get('/rooms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rooms.html'));
});

app.get('/playlists', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'playlists.html'));
});

app.get('/playlists/create', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'playlist-create.html'));
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

    const episodes = getRoomEpisodes(roomId, room);
    if (!episodes.length) {
      callback?.({ ok: false, error: 'Room has no episodes' });
      return;
    }

    const verifiedPayload = payload.verifiedEpisodeHashes && typeof payload.verifiedEpisodeHashes === 'object'
      ? payload.verifiedEpisodeHashes
      : null;
    if (!verifiedPayload) {
      callback?.({ ok: false, error: '请先校验全部剧集文件后再加入' });
      return;
    }

    for (let idx = 0; idx < episodes.length; idx += 1) {
      const expectedHash = normalizeHash(episodes[idx]?.contentHash || '');
      const providedHash = normalizeHash(
        verifiedPayload[idx]
          ?? verifiedPayload[String(idx)]
          ?? '',
      );
      if (!expectedHash || providedHash !== expectedHash) {
        callback?.({ ok: false, error: `第 ${idx + 1} 集文件未校验通过` });
        return;
      }
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

    socket.to(roomId).emit('participant-joined', {
      id: socket.id,
      name,
    });

    callback?.({ ok: true, participants: existingParticipants });
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

    let watchedDelta = 0;
    if (prev.episodeIndex === nextEpisodeIndex) {
      const delta = nextCurrentTime - Number(prev.currentTime || 0);
      if (delta > 0 && delta <= 15 && action !== 'seek' && action !== 'episode-switch') {
        watchedDelta = delta;
      }
    }

    const selectedEpisode = episodes[nextEpisodeIndex] || null;

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

server.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  // eslint-disable-next-line no-console
  console.log(`Watch-party server running at http://${displayHost}:${port} (bind ${host})`);
});
