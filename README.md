# 一起看服务（仅本地文件模式）

一个多人同步观看服务：
- 服务端只保存视频元数据（标题、hash、封面等）
- 不保存视频源文件
- 所有成员使用各自本地文件播放，通过 hash 匹配同一剧集

## 当前功能

- 用户体系
- 注册 / 登录 / 登出
- 首个注册用户自动成为 `root`
- 全站业务页面需登录

- 视频登记
- 前端计算文件 SHA-256
- 服务端登记视频信息与可选封面
- 相同 hash 自动复用已有视频

- 视频列表（多集）
- 按顺序创建多集列表
- 可从视频或视频列表创建放映室

- 放映室同步
- 播放 / 暂停 / 拖拽 / 倍速 / 切集同步
- 进度持久化（第几集、时间、倍速、总观看时长）
- 自动下一集倒计时与取消
- 漂移校正与新成员入房对齐

- 入房门禁
- 加入前需校验“该房间全部剧集”的本地文件 hash
- 未通过校验不能加入房间

- 实时互动
- WebRTC 摄像头/麦克风（默认关闭）
- 聊天
- 成员列表与加入/离开状态

- 管理能力（root）
- 删除任意放映室
- 删除视频
- 删除视频列表

## 技术栈

- Backend: `Node.js` + `Express` + `Socket.IO`
- DB: `SQLite` (`better-sqlite3`)
- Frontend: `Vue 3` + 原生页面路由
- RTC: WebRTC P2P（STUN: `stun.l.google.com:19302`）

## 本地运行

```bash
npm install
cp .env.example .env
npm start
```

访问地址：
- [http://localhost:3000](http://localhost:3000)

一键部署：

```bash
bash scripts/deploy.sh
```

脚本参数：
- 启动服务（默认）：`bash scripts/deploy.sh` 或 `bash scripts/deploy.sh start`
- 关闭服务：`bash scripts/deploy.sh stop`
- 关闭并清空所有运行数据（`data/`、`covers/`、`logs/`）：`bash scripts/deploy.sh reset --yes`

## 页面路由

- `/` 登录/注册
- `/upload` 上传（登记）视频
- `/videos` 所有视频
- `/videos/:videoId` 视频详情
- `/playlists` 所有视频列表
- `/playlists/create` 创建视频列表
- `/rooms` 所有放映室
- `/rooms/:roomId` 放映室
- `/admin` Root 管理台

## HTTP API

认证：
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

视频：
- `GET /api/supported-formats`
- `POST /api/videos`
- `GET /api/videos`
- `GET /api/videos/:videoId`
- `GET /api/videos/:videoId/rooms`
- `POST /api/videos/:videoId/rooms`

视频列表：
- `POST /api/playlists`
- `GET /api/playlists`
- `GET /api/playlists/:playlistId`
- `POST /api/playlists/:playlistId/rooms`

放映室：
- `GET /api/rooms`
- `GET /api/rooms/:roomId`
- `DELETE /api/rooms/:roomId`

Root：
- `GET /api/admin/rooms`
- `DELETE /api/admin/rooms/:roomId`
- `DELETE /api/admin/videos/:videoId`
- `DELETE /api/admin/playlists/:playlistId`

## Socket 事件

客户端 -> 服务端：
- `join-room`（携带 `verifiedEpisodeHashes`）
- `leave-room`
- `playback-update`
- `chat-message`
- `webrtc-offer`
- `webrtc-answer`
- `webrtc-ice-candidate`

服务端 -> 客户端：
- `existing-participants`
- `participant-joined`
- `participant-left`
- `chat-history`
- `chat-message`
- `playback-state`
- `playback-update`
- `webrtc-offer`
- `webrtc-answer`
- `webrtc-ice-candidate`
- `room-closed`

## 环境变量

- `PORT` 默认 `3000`
- `HOST` 默认 `0.0.0.0`（监听所有网卡）
- `JWT_SECRET` JWT 签名密钥
- `COVERS_DIR` 封面目录
- `SYNC_DRIFT_SOFT_THRESHOLD_MS` 漂移软阈值（毫秒）
- `SYNC_DRIFT_HARD_THRESHOLD_MS` 漂移硬阈值（毫秒）
- `AUTOPLAY_COUNTDOWN_SECONDS` 自动下一集倒计时秒数
