# 一起看服务（Remote Watching Sync）

可部署的多人一起看系统，支持：

1. 视频上传支持两种模式：
   - `cloud`：上传文件，异步处理（hash / 原样入池 / OSS）
   - `local_file`：前端基于所选文件计算 `contentHash`（SHA-256）后仅提交 hash，不上传源文件
2. 双播放模式放映室：`cloud` 与 `local_file`
3. 房间内同步播放（播放/暂停/进度/倍速/切集）
4. WebRTC 语音视频 + 聊天
5. 视频列表（多集）与自动连播倒计时
6. 房间续播持久化（当前集、时间、倍速、每集进度）
7. 播放池 LRU + 可选阿里云 OSS 回源
8. 统一用户体系（注册/登录/角色），首个注册用户自动 Root

## 快速启动

```bash
npm install
cp .env.example .env
npm start
```

一键部署：

```bash
bash scripts/deploy.sh
```

访问：
- 主页：[http://localhost:3000](http://localhost:3000)
- 管理页（Root）：[http://localhost:3000/admin](http://localhost:3000/admin)

## 认证与权限

- 全站业务 API 需要登录。
- 首个注册用户自动成为 `root`。
- 普通用户为 `user`。
- 放映室删除权限：创建者或 Root。
- `created_by_user_id` 为空的 legacy 房间仅 Root 可删。

## 双播放模式

创建房间必须传 `roomMode`：
- `cloud`：常规云端托管播放。
- `local_file`：当前集本地文件校验门禁。

### local_file 规则
- 服务端下发当前集 `contentHash`（SHA-256）。
- 客户端选择本地文件并计算 SHA-256。
- hash 匹配后上报 `local-file-verified`，解锁播放控制。
- 仅校验当前集；切集后需重新校验新当前集。
- 未校验用户仍可聊天/语音，但播放操作会被拒绝。

## 存储与格式

- 支持上传格式：`.mp4 .webm .ogg .ogv .m4v .mov .mkv .avi .ts`。
- 不做转码压缩，上传什么格式就按原样存储。
- 本地播放池默认无容量上限（可通过 `PLAY_POOL_MAX_BYTES` 手动设置限制）；设置限制时才会按 LRU 淘汰（跳过正在播放/读取文件）。
- 可配置阿里云 OSS：上传后后台入 OSS，本地缺文件时自动回源并 hash 校验。

## 主要环境变量

详见 `/Users/yinyongqi/yqy/remote-watching-sync/.env.example`。

基础：
- `PORT`
- `JWT_SECRET`

播放池：
- `PLAY_POOL_DIR`
- `PLAY_POOL_MAX_BYTES`（`0` 表示无上限）
- `TEMP_UPLOAD_DIR`

同步体验：
- `SYNC_DRIFT_SOFT_THRESHOLD_MS`
- `SYNC_DRIFT_HARD_THRESHOLD_MS`
- `AUTOPLAY_COUNTDOWN_SECONDS`

阿里云 OSS（可选）：
- `OSS_REGION`
- `OSS_BUCKET`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`
- `OSS_ENDPOINT`
- `OSS_STS_TOKEN`
- `OSS_PREFIX`

## API 概览

认证：
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

媒体与房间：
- `GET /api/supported-formats`
- `GET /api/storage`
- `POST /api/videos`（`uploadMode=cloud` 需文件；`uploadMode=local_file` 需 `contentHash`）
- `GET /api/video-jobs/:jobId`
- `GET /api/videos`
- `GET /api/videos/:videoId`
- `GET /media/:videoId`（Range 缓冲）
- `POST /api/videos/:videoId/rooms`（`roomMode` 必填）
- `POST /api/playlists`
- `GET /api/playlists`
- `GET /api/playlists/:playlistId`
- `POST /api/playlists/:playlistId/rooms`（`roomMode` 必填）
- `GET /api/rooms`
- `GET /api/rooms/:roomId`
- `DELETE /api/rooms/:roomId`

Root 管理：
- `GET /api/admin/storage`
- `GET /api/admin/video-jobs`
- `DELETE /api/admin/video-jobs?olderThanDays=30`
- `GET /api/admin/rooms`
- `DELETE /api/admin/rooms/:roomId`

## Socket 事件（核心）

客户端 -> 服务端：
- `join-room`
- `leave-room`
- `playback-update`
- `chat-message`
- `local-file-verified`
- `webrtc-offer / webrtc-answer / webrtc-ice-candidate`

服务端 -> 客户端：
- `playback-state`
- `playback-update`
- `playback-denied`
- `local-file-required`
- `chat-history / chat-message`
- `participant-joined / participant-left / existing-participants`

## 部署建议

1. 优先使用 `bash scripts/deploy.sh`。
2. 生产环境建议反向代理 + HTTPS（WebRTC 体验更稳定）。
3. `data/`、`playback_pool/`、`uploads_tmp/` 目录放在持久化磁盘。
4. 如需限制本地存储，可手动设置 `PLAY_POOL_MAX_BYTES`。
