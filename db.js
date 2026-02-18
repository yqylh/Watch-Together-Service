const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'watch-party.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name);
}

function ensureColumn(tableName, columnName, columnDef) {
  const cols = tableColumns(tableName);
  if (cols.includes(columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT DEFAULT '',
  cover_filename TEXT DEFAULT '',
  cover_mime_type TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  episode_index INTEGER NOT NULL,
  title_override TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  playlist_id TEXT DEFAULT NULL,
  start_episode_index INTEGER DEFAULT 0,
  last_episode_index INTEGER DEFAULT 0,
  last_current_time REAL DEFAULT 0,
  last_playback_rate REAL DEFAULT 1,
  last_is_playing INTEGER DEFAULT 0,
  last_updated_at TEXT DEFAULT '',
  total_watched_seconds REAL DEFAULT 0,
  name TEXT NOT NULL,
  creator_name TEXT DEFAULT '',
  created_by_user_id TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE SET NULL,
  FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS room_episode_progress (
  room_id TEXT NOT NULL,
  episode_index INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  last_position_seconds REAL NOT NULL DEFAULT 0,
  max_position_seconds REAL NOT NULL DEFAULT 0,
  last_duration_seconds REAL NOT NULL DEFAULT 0,
  watched_seconds REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(room_id, episode_index),
  FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(hash);
CREATE INDEX IF NOT EXISTS idx_videos_filename ON videos(filename);
CREATE INDEX IF NOT EXISTS idx_rooms_video_id ON rooms(video_id);
CREATE INDEX IF NOT EXISTS idx_rooms_playlist_id ON rooms(playlist_id);
CREATE INDEX IF NOT EXISTS idx_rooms_created_by_user_id ON rooms(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items(playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_video_id ON playlist_items(video_id);
CREATE INDEX IF NOT EXISTS idx_room_episode_progress_video_id ON room_episode_progress(video_id);
`);

// 兼容历史数据库（保留必要迁移，不保留历史逻辑）
ensureColumn('videos', 'hash', "TEXT DEFAULT ''");
ensureColumn('videos', 'cover_filename', "TEXT DEFAULT ''");
ensureColumn('videos', 'cover_mime_type', "TEXT DEFAULT ''");

ensureColumn('rooms', 'playlist_id', 'TEXT DEFAULT NULL');
ensureColumn('rooms', 'start_episode_index', 'INTEGER DEFAULT 0');
ensureColumn('rooms', 'last_episode_index', 'INTEGER DEFAULT 0');
ensureColumn('rooms', 'last_current_time', 'REAL DEFAULT 0');
ensureColumn('rooms', 'last_playback_rate', 'REAL DEFAULT 1');
ensureColumn('rooms', 'last_is_playing', 'INTEGER DEFAULT 0');
ensureColumn('rooms', 'last_updated_at', "TEXT DEFAULT ''");
ensureColumn('rooms', 'total_watched_seconds', 'REAL DEFAULT 0');
ensureColumn('rooms', 'created_by_user_id', 'TEXT DEFAULT NULL');
ensureColumn('rooms', 'creator_name', "TEXT DEFAULT ''");

const roomColumns = new Set(tableColumns('rooms'));
const hasRoomCreatorToken = roomColumns.has('creator_token');
const hasRoomCreatorName = roomColumns.has('creator_name');
const hasRoomCreatedByUserId = roomColumns.has('created_by_user_id');

const insertUserStmt = db.prepare(`
  INSERT INTO users (
    id,
    username,
    password_hash,
    role,
    created_at,
    updated_at,
    last_login_at
  ) VALUES (
    @id,
    @username,
    @passwordHash,
    @role,
    @createdAt,
    @updatedAt,
    @lastLoginAt
  )
`);

const getUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const getUserByUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
const countUsersStmt = db.prepare('SELECT COUNT(1) AS total FROM users');
const updateUserLastLoginStmt = db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?');

const insertVideoStmt = db.prepare(`
  INSERT INTO videos (
    id,
    title,
    description,
    filename,
    original_name,
    mime_type,
    size,
    hash,
    cover_filename,
    cover_mime_type,
    created_at
  ) VALUES (
    @id,
    @title,
    @description,
    @filename,
    @originalName,
    @mimeType,
    @size,
    @hash,
    @coverFilename,
    @coverMimeType,
    @createdAt
  )
`);

const getVideoStmt = db.prepare('SELECT * FROM videos WHERE id = ?');
const getVideoByHashStmt = db.prepare('SELECT * FROM videos WHERE hash = ? ORDER BY datetime(created_at) ASC LIMIT 1');
const listVideosStmt = db.prepare('SELECT * FROM videos ORDER BY datetime(created_at) DESC');
const deleteVideoStmt = db.prepare('DELETE FROM videos WHERE id = ?');

const updateVideoCoverStmt = db.prepare(`
  UPDATE videos
  SET cover_filename = @coverFilename,
      cover_mime_type = @coverMimeType
  WHERE id = @videoId
`);

const insertPlaylistStmt = db.prepare(`
  INSERT INTO playlists (id, name, description, created_at)
  VALUES (@id, @name, @description, @createdAt)
`);

const insertPlaylistItemStmt = db.prepare(`
  INSERT INTO playlist_items (id, playlist_id, video_id, episode_index, title_override, created_at)
  VALUES (@id, @playlistId, @videoId, @episodeIndex, @titleOverride, @createdAt)
`);

const getPlaylistStmt = db.prepare('SELECT * FROM playlists WHERE id = ?');
const listPlaylistsStmt = db.prepare(`
  SELECT playlists.*, COUNT(playlist_items.id) AS episode_count
  FROM playlists
  LEFT JOIN playlist_items ON playlist_items.playlist_id = playlists.id
  GROUP BY playlists.id
  ORDER BY datetime(playlists.created_at) DESC
`);

const listPlaylistEpisodesStmt = db.prepare(`
  SELECT
    playlist_items.id,
    playlist_items.playlist_id,
    playlist_items.video_id,
    playlist_items.episode_index,
    playlist_items.title_override,
    videos.title AS video_title,
    videos.description AS video_description,
    videos.filename AS video_filename,
    videos.original_name AS video_original_name,
    videos.mime_type AS video_mime_type,
    videos.size AS video_size,
    videos.hash AS video_hash,
    videos.cover_filename AS video_cover_filename,
    videos.cover_mime_type AS video_cover_mime_type,
    videos.created_at AS video_created_at
  FROM playlist_items
  JOIN videos ON videos.id = playlist_items.video_id
  WHERE playlist_items.playlist_id = ?
  ORDER BY playlist_items.episode_index ASC
`);

const deletePlaylistStmt = db.prepare('DELETE FROM playlists WHERE id = ?');

const roomInsertSpecs = [
  { column: 'id', param: 'id' },
  { column: 'video_id', param: 'videoId' },
  { column: 'playlist_id', param: 'playlistId' },
  { column: 'start_episode_index', param: 'startEpisodeIndex' },
  { column: 'last_episode_index', param: 'lastEpisodeIndex' },
  { column: 'last_current_time', param: 'lastCurrentTime' },
  { column: 'last_playback_rate', param: 'lastPlaybackRate' },
  { column: 'last_is_playing', param: 'lastIsPlaying' },
  { column: 'last_updated_at', param: 'lastUpdatedAt' },
  { column: 'total_watched_seconds', param: 'totalWatchedSeconds' },
  { column: 'name', param: 'name' },
];

if (hasRoomCreatorName) {
  roomInsertSpecs.push({ column: 'creator_name', param: 'creatorName' });
}
if (hasRoomCreatorToken) {
  roomInsertSpecs.push({ column: 'creator_token', param: 'creatorToken' });
}
if (hasRoomCreatedByUserId) {
  roomInsertSpecs.push({ column: 'created_by_user_id', param: 'createdByUserId' });
}
roomInsertSpecs.push({ column: 'created_at', param: 'createdAt' });

const insertRoomStmt = db.prepare(`
  INSERT INTO rooms (
    ${roomInsertSpecs.map((item) => item.column).join(',\n    ')}
  ) VALUES (
    ${roomInsertSpecs.map((item) => `@${item.param}`).join(',\n    ')}
  )
`);

const getRoomStmt = db.prepare('SELECT * FROM rooms WHERE id = ?');
const getRoomWithSourceStmt = db.prepare(`
  SELECT
    rooms.*,
    videos.title AS video_title,
    playlists.name AS playlist_name,
    users.username AS creator_username
  FROM rooms
  JOIN videos ON videos.id = rooms.video_id
  LEFT JOIN playlists ON playlists.id = rooms.playlist_id
  LEFT JOIN users ON users.id = rooms.created_by_user_id
  WHERE rooms.id = ?
`);

const deleteRoomStmt = db.prepare('DELETE FROM rooms WHERE id = ?');

const listRoomsByVideoStmt = db.prepare(`
  SELECT
    rooms.*,
    videos.title AS video_title,
    playlists.name AS playlist_name,
    users.username AS creator_username
  FROM rooms
  JOIN videos ON videos.id = rooms.video_id
  LEFT JOIN playlists ON playlists.id = rooms.playlist_id
  LEFT JOIN users ON users.id = rooms.created_by_user_id
  WHERE rooms.video_id = ?
  ORDER BY datetime(rooms.created_at) DESC
`);

const listRoomsByPlaylistStmt = db.prepare(`
  SELECT
    rooms.*,
    videos.title AS video_title,
    playlists.name AS playlist_name,
    users.username AS creator_username
  FROM rooms
  JOIN videos ON videos.id = rooms.video_id
  LEFT JOIN playlists ON playlists.id = rooms.playlist_id
  LEFT JOIN users ON users.id = rooms.created_by_user_id
  WHERE rooms.playlist_id = ?
  ORDER BY datetime(rooms.created_at) DESC
`);

const listAllRoomsStmt = db.prepare(`
  SELECT
    rooms.*,
    videos.title AS video_title,
    playlists.name AS playlist_name,
    users.username AS creator_username
  FROM rooms
  JOIN videos ON videos.id = rooms.video_id
  LEFT JOIN playlists ON playlists.id = rooms.playlist_id
  LEFT JOIN users ON users.id = rooms.created_by_user_id
  ORDER BY datetime(rooms.created_at) DESC
`);

const getRoomPlaybackStateStmt = db.prepare(`
  SELECT
    id,
    start_episode_index,
    last_episode_index,
    last_current_time,
    last_playback_rate,
    last_is_playing,
    last_updated_at,
    total_watched_seconds
  FROM rooms
  WHERE id = ?
`);

const listRoomEpisodeProgressStmt = db.prepare(`
  SELECT
    room_episode_progress.room_id,
    room_episode_progress.episode_index,
    room_episode_progress.video_id,
    room_episode_progress.last_position_seconds,
    room_episode_progress.max_position_seconds,
    room_episode_progress.last_duration_seconds,
    room_episode_progress.watched_seconds,
    room_episode_progress.updated_at,
    videos.title AS video_title
  FROM room_episode_progress
  JOIN videos ON videos.id = room_episode_progress.video_id
  WHERE room_episode_progress.room_id = ?
  ORDER BY room_episode_progress.episode_index ASC
`);

const updateRoomPlaybackStateStmt = db.prepare(`
  UPDATE rooms
  SET
    last_episode_index = @episodeIndex,
    last_current_time = @currentTime,
    last_playback_rate = @playbackRate,
    last_is_playing = @isPlaying,
    last_updated_at = @updatedAt,
    total_watched_seconds = MAX(0, COALESCE(total_watched_seconds, 0) + @watchedDelta)
  WHERE id = @roomId
`);

const upsertRoomEpisodeProgressStmt = db.prepare(`
  INSERT INTO room_episode_progress (
    room_id,
    episode_index,
    video_id,
    last_position_seconds,
    max_position_seconds,
    last_duration_seconds,
    watched_seconds,
    updated_at
  ) VALUES (
    @roomId,
    @episodeIndex,
    @videoId,
    @currentTime,
    @maxPosition,
    @durationSeconds,
    @watchedDelta,
    @updatedAt
  )
  ON CONFLICT(room_id, episode_index) DO UPDATE SET
    video_id = excluded.video_id,
    last_position_seconds = excluded.last_position_seconds,
    max_position_seconds = MAX(room_episode_progress.max_position_seconds, excluded.max_position_seconds),
    last_duration_seconds = MAX(room_episode_progress.last_duration_seconds, excluded.last_duration_seconds),
    watched_seconds = MAX(0, room_episode_progress.watched_seconds + excluded.watched_seconds),
    updated_at = excluded.updated_at
`);

const createPlaylistTx = db.transaction((playlist, episodeItems) => {
  insertPlaylistStmt.run(playlist);
  for (const item of episodeItems) {
    insertPlaylistItemStmt.run(item);
  }
});

const updateRoomProgressTx = db.transaction((payload) => {
  updateRoomPlaybackStateStmt.run(payload);
  if (payload.videoId) {
    upsertRoomEpisodeProgressStmt.run(payload);
  }
});

function countUsers() {
  const row = countUsersStmt.get() || { total: 0 };
  return Number(row.total || 0);
}

function createUser(user) {
  const now = user.createdAt;
  const row = {
    id: user.id,
    username: String(user.username || '').trim(),
    passwordHash: user.passwordHash,
    role: user.role || 'user',
    createdAt: now,
    updatedAt: user.updatedAt || now,
    lastLoginAt: user.lastLoginAt || now,
  };

  insertUserStmt.run(row);
  return getUserById(row.id);
}

function getUserById(id) {
  return getUserByIdStmt.get(id) || null;
}

function getUserByUsername(username) {
  return getUserByUsernameStmt.get(String(username || '').trim()) || null;
}

function touchUserLastLogin(userId, at) {
  updateUserLastLoginStmt.run(at, at, userId);
}

function createVideo(video) {
  const row = {
    id: video.id,
    title: video.title,
    description: video.description || '',
    filename: video.filename,
    originalName: video.originalName,
    mimeType: video.mimeType,
    size: Number(video.size || 0),
    hash: video.hash || '',
    coverFilename: video.coverFilename || '',
    coverMimeType: video.coverMimeType || '',
    createdAt: video.createdAt,
  };

  insertVideoStmt.run(row);
  return getVideo(video.id);
}

function getVideo(id) {
  return getVideoStmt.get(id) || null;
}

function getVideoByHash(hash) {
  if (!hash) {
    return null;
  }
  return getVideoByHashStmt.get(hash) || null;
}

function updateVideoCover(videoId, coverFilename, coverMimeType) {
  updateVideoCoverStmt.run({
    videoId,
    coverFilename: coverFilename || '',
    coverMimeType: coverMimeType || '',
  });
  return getVideo(videoId);
}

function listVideos() {
  return listVideosStmt.all();
}

function deleteVideo(id) {
  return deleteVideoStmt.run(id).changes > 0;
}

function createPlaylist({ playlist, episodeItems }) {
  createPlaylistTx(playlist, episodeItems);
  return getPlaylist(playlist.id);
}

function getPlaylist(id) {
  return getPlaylistStmt.get(id) || null;
}

function listPlaylists() {
  return listPlaylistsStmt.all();
}

function listPlaylistEpisodes(playlistId) {
  return listPlaylistEpisodesStmt.all(playlistId);
}

function deletePlaylist(id) {
  return deletePlaylistStmt.run(id).changes > 0;
}

function createRoom(room) {
  const row = {
    id: room.id,
    videoId: room.videoId,
    playlistId: room.playlistId || null,
    startEpisodeIndex: Number(room.startEpisodeIndex || 0),
    lastEpisodeIndex: Number(room.lastEpisodeIndex ?? room.startEpisodeIndex ?? 0),
    lastCurrentTime: Number(room.lastCurrentTime || 0),
    lastPlaybackRate: Number(room.lastPlaybackRate || 1),
    lastIsPlaying: room.lastIsPlaying ? 1 : 0,
    lastUpdatedAt: room.lastUpdatedAt || room.createdAt,
    totalWatchedSeconds: Number(room.totalWatchedSeconds || 0),
    name: room.name,
    creatorName: room.creatorName || '',
    // 仅兼容历史 schema 中的 NOT NULL 列，业务逻辑不再使用该字段。
    creatorToken: room.creatorToken || `legacy-${room.id}`,
    createdByUserId: room.createdByUserId || null,
    createdAt: room.createdAt,
  };

  insertRoomStmt.run(row);
  return getRoom(row.id);
}

function getRoom(id) {
  return getRoomStmt.get(id) || null;
}

function getRoomWithSource(id) {
  return getRoomWithSourceStmt.get(id) || null;
}

function deleteRoom(id) {
  return deleteRoomStmt.run(id).changes > 0;
}

function listRoomsByVideo(videoId) {
  return listRoomsByVideoStmt.all(videoId);
}

function listRoomsByPlaylist(playlistId) {
  return listRoomsByPlaylistStmt.all(playlistId);
}

function listAllRooms() {
  return listAllRoomsStmt.all();
}

function getRoomPlaybackState(roomId) {
  const row = getRoomPlaybackStateStmt.get(roomId);
  if (!row) {
    return null;
  }

  return {
    episodeIndex: Number(row.last_episode_index ?? row.start_episode_index ?? 0),
    currentTime: Number(row.last_current_time || 0),
    playbackRate: Number(row.last_playback_rate || 1),
    isPlaying: Boolean(row.last_is_playing),
    updatedAt: row.last_updated_at || '',
    totalWatchedSeconds: Number(row.total_watched_seconds || 0),
  };
}

function listRoomEpisodeProgress(roomId) {
  return listRoomEpisodeProgressStmt.all(roomId).map((row) => ({
    roomId: row.room_id,
    episodeIndex: Number(row.episode_index || 0),
    videoId: row.video_id,
    videoTitle: row.video_title,
    lastPositionSeconds: Number(row.last_position_seconds || 0),
    maxPositionSeconds: Number(row.max_position_seconds || 0),
    lastDurationSeconds: Number(row.last_duration_seconds || 0),
    watchedSeconds: Number(row.watched_seconds || 0),
    updatedAt: row.updated_at,
  }));
}

function updateRoomPlaybackState(payload) {
  const safePayload = {
    roomId: payload.roomId,
    episodeIndex: Number(payload.episodeIndex || 0),
    currentTime: Number(payload.currentTime || 0),
    playbackRate: Number(payload.playbackRate || 1),
    isPlaying: payload.isPlaying ? 1 : 0,
    watchedDelta: Number(payload.watchedDelta || 0),
    videoId: payload.videoId || '',
    maxPosition: Number(payload.maxPosition || payload.currentTime || 0),
    durationSeconds: Number(payload.durationSeconds || 0),
    updatedAt: payload.updatedAt,
  };

  updateRoomProgressTx(safePayload);
  return getRoomPlaybackState(payload.roomId);
}

function isRoomOwner(roomId, userId) {
  if (!userId) {
    return false;
  }
  const room = getRoom(roomId);
  if (!room || !room.created_by_user_id) {
    return false;
  }
  return room.created_by_user_id === userId;
}

module.exports = {
  countUsers,
  createUser,
  getUserById,
  getUserByUsername,
  touchUserLastLogin,

  createVideo,
  getVideo,
  getVideoByHash,
  updateVideoCover,
  listVideos,
  deleteVideo,

  createPlaylist,
  getPlaylist,
  listPlaylists,
  listPlaylistEpisodes,
  deletePlaylist,

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
};
