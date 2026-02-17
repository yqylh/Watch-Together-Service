# 一起看服务（Remote Watching Sync）

一个可部署到服务器的“一起看”应用，支持：

1. 本地上传视频、远程文件导入（服务器路径 / URL）
2. 房间内视频同步播放（播放/暂停/进度/倍速/切集）
3. 房间内语音视频（WebRTC）与聊天
4. 多集列表放映室（同一时间只播放一集，支持自动连播）
5. 放映室进度持久化（无人在线不删房，随时回来续播）
6. 房间仅创建者或 Root 可删除
7. 视频播放池（本地缓存）+ LRU 淘汰
8. 可选阿里云 OSS 作为扩展存储，缺本地文件时自动回源
9. 统一压缩转码（MP4 H264/AAC），支持硬件编码参数
10. 上传/导入任务状态跟踪（上传中、压缩中、OSS 传输中）

## 快速启动

```bash
npm install
cp .env.example .env
npm start
```

一键部署（推荐）：

```bash
bash scripts/deploy.sh
```

访问：

- 主页：[http://localhost:3000](http://localhost:3000)
- Root 管理页：[http://localhost:3000/admin](http://localhost:3000/admin)

## 核心行为

- 放映室不再因空房自动删除，进度跟房间走。
- 进度会持久化：`当前集数 + 当前时间点 + 倍速 + 累计观看秒数 + 每集进度`。
- 播放池满时按 LRU 淘汰，但会跳过“正在播放/正在读取”的文件。
- 若所有候选都不能删，会返回明确错误提醒你扩容或稍后重试。
- 新用户进入房间会自动对齐当前进度；播放中会做漂移校正（阈值 200ms）。
- 自动下一集为倒计时模式，可取消。
- 如果配置了 OSS：
  - 新上传视频会尝试推送到 OSS
  - 播放时本地缺文件会从 OSS 拉回播放池

## 环境变量

参考 `/Users/yinyongqi/yqy/remote-watching-sync/.env.example`。

基础：

- `PORT`
- `JWT_SECRET`
- `ROOT_USERNAME` / `ROOT_PASSWORD`
- `MAX_UPLOAD_SIZE_BYTES`
- `REMOTE_SOURCE_ROOT`

播放池：

- `PLAY_POOL_DIR`：本地播放池目录
- `PLAY_POOL_MAX_BYTES`：播放池最大容量（字节）
- `TEMP_UPLOAD_DIR`：上传/转码临时目录

转码：

- `ENABLE_TRANSCODE`
- `FFMPEG_PATH`
- `TRANSCODE_VIDEO_CODEC`（`libx264` / `h264_nvenc` / `h264_qsv` / `h264_videotoolbox`）
- `TRANSCODE_AUDIO_CODEC`
- `TRANSCODE_PRESET`
- `TRANSCODE_VIDEO_BITRATE`（留空则按 CRF）
- `TRANSCODE_AUDIO_BITRATE`
- `TRANSCODE_CRF`
- `TRANSCODE_MAX_WIDTH`
- `TRANSCODE_HWACCEL`（`cuda` / `qsv` / `videotoolbox`）
- `TRANSCODE_FALLBACK_CPU`

同步体验：

- `SYNC_DRIFT_SOFT_THRESHOLD_MS`
- `SYNC_DRIFT_HARD_THRESHOLD_MS`
- `AUTOPLAY_COUNTDOWN_SECONDS`

阿里云 OSS（可选）：

- `OSS_REGION`
- `OSS_BUCKET`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`
- `OSS_ENDPOINT`（可选）
- `OSS_STS_TOKEN`（可选）
- `OSS_PREFIX`

## 支持格式

通过 `GET /api/supported-formats` 查看。
默认容器扩展名：

- `.mp4` `.webm` `.ogg` `.ogv` `.m4v` `.mov` `.mkv` `.avi` `.ts`

## 主要接口

- `GET /api/supported-formats`
- `GET /api/storage`
- `GET /api/admin/storage`（Root）
- `POST /api/videos`（返回异步 job）
- `POST /api/videos/import-remote`（返回异步 job）
- `GET /api/video-jobs/:jobId`
- `GET /api/admin/video-jobs`（Root，任务分页）
- `DELETE /api/admin/video-jobs?olderThanDays=30`（Root，清理历史完成/失败任务）
- `GET /api/videos`
- `GET /api/videos/:videoId`
- `GET /media/:videoId`（支持 HTTP Range 缓冲）
- `POST /api/videos/:videoId/rooms`
- `POST /api/playlists`
- `GET /api/playlists`
- `GET /api/playlists/:playlistId`
- `POST /api/playlists/:playlistId/rooms`
- `GET /api/rooms`
- `GET /api/rooms/:roomId`
- `DELETE /api/rooms/:roomId`
- `POST /api/auth/root/login`
- `GET /api/admin/rooms`
- `DELETE /api/admin/rooms/:roomId`

## 前端能力（房间页）

- 全屏按钮
- 视频音量和语音音量独立调节
- 视频静音、语音静音
- 倍速同步跟随放映室
- 自动连播下一集（倒计时 + 取消）
- 加入追帧（进房自动对齐）与漂移纠偏

## 部署建议

1. 直接执行 `bash scripts/deploy.sh`（脚本会优先使用 `pm2`，否则回退 `nohup`）
2. Nginx/Caddy 反向代理 + HTTPS（WebRTC 推荐）
3. `playback_pool/`、`uploads_tmp/`、`data/` 放持久化磁盘
4. 配置 TURN 提升 WebRTC 连通性
5. 大规模并发建议启用转码并配置硬件编码
