# 一起看服务（本地模式）

本项目已收敛为单一播放形态：
- 仅支持 `local_file` 模式。
- 服务端不保存视频源文件，不提供云端托管播放。
- 前端对本地文件计算 SHA-256，服务端仅登记视频元数据（hash、文件信息、封面）。

## 功能

- 用户体系：注册/登录/角色（首个注册用户自动 Root）
- 视频登记：前端计算 hash，上传可选封面
- 视频列表（多集）与放映室
- 放映室同步：播放/暂停/拖拽/倍速/切集
- 本地文件门禁：当前集 hash 校验通过后才可控制播放
- WebRTC 语音视频 + 聊天
- Root 管理：查看/删除所有放映室、删除视频、删除视频列表

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
- [http://localhost:3000](http://localhost:3000)
- [http://localhost:3000/admin](http://localhost:3000/admin)

## 核心接口

认证：
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

视频与房间：
- `GET /api/supported-formats`
- `POST /api/videos`（`contentHash` 必填，`cover` 可选）
- `GET /api/videos`
- `GET /api/videos/:videoId`
- `POST /api/videos/:videoId/rooms`
- `POST /api/playlists`
- `GET /api/playlists`
- `GET /api/playlists/:playlistId`
- `POST /api/playlists/:playlistId/rooms`
- `GET /api/rooms`
- `GET /api/rooms/:roomId`
- `DELETE /api/rooms/:roomId`

Root 管理：
- `GET /api/admin/rooms`
- `DELETE /api/admin/rooms/:roomId`
- `DELETE /api/admin/videos/:videoId`
- `DELETE /api/admin/playlists/:playlistId`

说明：
- `GET /media/:videoId` 已废弃，固定返回 `410`。

## 环境变量

- `PORT`
- `JWT_SECRET`
- `TEMP_UPLOAD_DIR`
- `COVERS_DIR`
- `SYNC_DRIFT_SOFT_THRESHOLD_MS`
- `SYNC_DRIFT_HARD_THRESHOLD_MS`
- `AUTOPLAY_COUNTDOWN_SECONDS`

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
