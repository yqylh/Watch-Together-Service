const authStatusEl = document.getElementById('authStatus');
const currentUserEl = document.getElementById('currentUser');
const logoutBtn = document.getElementById('logoutBtn');

const uploadForm = document.getElementById('uploadForm');
const uploadStatus = document.getElementById('uploadStatus');
const uploadModeEl = document.getElementById('uploadMode');
const videoFileEl = document.getElementById('videoFile');
const videoFileLabelEl = document.getElementById('videoFileLabel');
const uploadModeHintEl = document.getElementById('uploadModeHint');

const storageInfoEl = document.getElementById('storageInfo');
const supportedFormatsEl = document.getElementById('supportedFormats');

const {
  apiFetch,
  setAuthToken,
  formatBytes,
  normalizeHash,
  computeFileSha256Hex,
} = window.WatchPartyCommon;

let currentUser = null;

function mapJobStage(stage) {
  const dict = {
    upload_received: '上传完成，等待处理',
    hashing: '校验 hash',
    registering_local_hash: '登记本地模式 hash',
    compressing: '压缩转码',
    deduplicating: '重复文件复用',
    storing_local: '写入播放池',
    uploading_oss: '后台传输到 OSS',
    completed: '已完成',
    failed: '失败',
  };
  return dict[stage] || stage || '处理中';
}

function mapJobStatus(status) {
  if (status === 'completed') {
    return '完成';
  }
  if (status === 'failed') {
    return '失败';
  }
  return '处理中';
}

function syncUploadModeUI() {
  const mode = String(uploadModeEl.value || 'cloud').trim();
  const isLocalMode = mode === 'local_file';

  videoFileEl.required = true;
  if (isLocalMode) {
    videoFileLabelEl.textContent = '本地文件（仅用于计算 hash）';
    uploadModeHintEl.textContent = '本地模式不会上传文件本体，前端会计算 SHA-256 后仅提交 hash。';
    return;
  }

  videoFileLabelEl.textContent = '视频文件';
  uploadModeHintEl.textContent = '';
}

async function pollVideoJob(jobId, onUpdate) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const data = await apiFetch(`/api/video-jobs/${jobId}`);
    const job = data.job;
    onUpdate(job);
    if (job.status === 'completed') {
      return job;
    }
    if (job.status === 'failed') {
      throw new Error(job.error || job.message || '任务失败');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('任务超时，请稍后查看状态');
}

async function loadSupportedFormats() {
  const data = await apiFetch('/api/supported-formats');
  const lines = data.formats
    .map((fmt) => `${fmt.extension}: ${fmt.mimeTypes.join(', ')}`)
    .join('<br/>');
  supportedFormatsEl.innerHTML = `${lines}<br/><br/>${data.note || ''}`;
}

async function loadStorageInfo() {
  const data = await apiFetch('/api/storage');
  const pool = data.pool || {};
  const disk = data.disk || null;
  const lines = [];
  const poolLimitLabel = pool.isUnlimited ? '无上限' : formatBytes(pool.maxBytes);
  const poolAvailableLabel = pool.isUnlimited ? '不限制' : formatBytes(pool.availableBytes);
  lines.push(`播放池: 已用 ${formatBytes(pool.usageBytes)} / 上限 ${poolLimitLabel} (可用 ${poolAvailableLabel})`);
  lines.push(`池中文件数: ${Number(pool.fileCount || 0)}`);
  if (disk) {
    lines.push(`所在磁盘: 剩余 ${formatBytes(disk.freeBytes)} / 总计 ${formatBytes(disk.totalBytes)}`);
  } else {
    lines.push('所在磁盘: 当前环境不支持读取');
  }

  storageInfoEl.innerHTML = lines.join('<br/>');
}

uploadModeEl.addEventListener('change', syncUploadModeUI);

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  uploadStatus.textContent = '上传中（浏览器 -> 服务器）...';

  try {
    const formData = new FormData(uploadForm);
    const uploadMode = String(formData.get('uploadMode') || 'cloud').trim();
    if (!['cloud', 'local_file'].includes(uploadMode)) {
      throw new Error('上传模式无效');
    }

    const selectedFile = formData.get('video');
    if (!(selectedFile instanceof File) || !selectedFile.name) {
      throw new Error('请选择本地视频文件');
    }

    if (uploadMode === 'local_file') {
      const contentHash = normalizeHash(await computeFileSha256Hex(selectedFile, {
        onProgress: (loaded, total) => {
          const pct = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
          uploadStatus.textContent = `本地模式：正在前端计算 SHA-256... ${pct}%`;
        },
      }));
      if (!/^[a-f0-9]{64}$/.test(contentHash)) {
        throw new Error('本地模式 hash 计算失败');
      }
      formData.set('contentHash', contentHash);
      formData.set('localFileName', selectedFile.name || '');
      formData.delete('video');
    }

    const submitResult = await apiFetch('/api/videos', {
      method: 'POST',
      body: formData,
    });

    const jobId = submitResult.job?.id;
    if (!jobId) {
      throw new Error('上传任务创建失败');
    }

    const doneJob = await pollVideoJob(jobId, (job) => {
      const pct = Math.max(0, Math.min(100, Math.round(Number(job.progress || 0) * 100)));
      uploadStatus.textContent = `状态: ${mapJobStatus(job.status)} | 阶段: ${mapJobStage(job.stage)} | ${pct}% | ${job.message || ''}`;
    });

    uploadStatus.textContent = `上传成功: ${doneJob.video?.title || doneJob.videoId || '已入库'}`;
    uploadForm.reset();
    syncUploadModeUI();
    await loadStorageInfo();
  } catch (err) {
    uploadStatus.textContent = `上传失败: ${err.message}`;
  }
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

async function checkAuth() {
  try {
    const result = await apiFetch('/api/auth/me');
    currentUser = result.user;
    currentUserEl.textContent = `${currentUser.username} (${currentUser.role})`;
    authStatusEl.textContent = '登录状态有效';
    return true;
  } catch (_err) {
    currentUser = null;
    setAuthToken('');
    authStatusEl.textContent = '请先登录，正在跳转...';
    window.location.href = '/';
    return false;
  }
}

(async function init() {
  syncUploadModeUI();
  const authed = await checkAuth();
  if (!authed) {
    return;
  }
  await Promise.all([loadStorageInfo(), loadSupportedFormats()]);
})();
