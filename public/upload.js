const {
  apiFetch,
  normalizeHash,
  computeFileSha256Hex,
} = window.WatchPartyCommon;

const { mountAuthedPage } = window.WatchPartyVue;

function loadVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    video.onloadedmetadata = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ video, cleanup });
    };

    video.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error('无法读取视频元数据'));
    };

    video.src = objectUrl;
  });
}

function seekVideo(video, timeSec) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      reject(new Error('视频寻帧超时'));
    }, 15000);

    const onSeeked = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      resolve();
    };

    const onError = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      reject(new Error('视频寻帧失败'));
    };

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = Math.max(0, Number(timeSec || 0));
  });
}

function canvasToJpegBlob(canvas, quality = 0.88) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('封面导出失败'));
        return;
      }
      resolve(blob);
    }, 'image/jpeg', quality);
  });
}

async function extractCoverBlob(file) {
  const { video, cleanup } = await loadVideoMetadata(file);
  try {
    const duration = Number(video.duration || 0);
    const target = Number.isFinite(duration) && duration > 0
      ? duration * (0.35 + Math.random() * 0.3)
      : 0;
    await seekVideo(video, target);

    const rawWidth = Math.max(1, Number(video.videoWidth || 0));
    const rawHeight = Math.max(1, Number(video.videoHeight || 0));
    const maxWidth = 960;
    const width = rawWidth > maxWidth ? maxWidth : rawWidth;
    const height = Math.max(1, Math.round((rawHeight * width) / rawWidth));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('浏览器不支持 Canvas 2D');
    }
    ctx.drawImage(video, 0, 0, width, height);
    return await canvasToJpegBlob(canvas);
  } finally {
    cleanup();
  }
}

mountAuthedPage({
  data() {
    return {
      hintText: '仅本地模式：前端计算 SHA-256，服务端登记 hash 与可选封面，不上传视频源文件。',
      supportedFormatsHtml: '',
      uploadStatus: '',
      form: {
        title: '',
        description: '',
      },
    };
  },
  methods: {
    async loadSupportedFormats() {
      const data = await apiFetch('/api/supported-formats');
      const formats = Array.isArray(data.formats) ? data.formats : [];
      const lines = formats
        .map((fmt) => `${fmt.extension}: ${fmt.mimeTypes.join(', ')}`)
        .join('<br/>');
      this.supportedFormatsHtml = `${lines}<br/><br/>${data.note || ''}`;
    },
    async submitUpload() {
      this.uploadStatus = '准备中...';
      try {
        const input = this.$refs.videoFileInput;
        const selectedFile = input && input.files ? input.files[0] : null;
        if (!(selectedFile instanceof File) || !selectedFile.name) {
          throw new Error('请选择本地视频文件');
        }

        const contentHash = normalizeHash(await computeFileSha256Hex(selectedFile, {
          onProgress: (loaded, total) => {
            const pct = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
            this.uploadStatus = `前端计算 SHA-256 中... ${pct}%`;
          },
        }));
        if (!/^[a-f0-9]{64}$/.test(contentHash)) {
          throw new Error('本地 hash 计算失败');
        }

        this.uploadStatus = '抽取封面帧中...';
        let coverBlob = null;
        try {
          coverBlob = await extractCoverBlob(selectedFile);
        } catch (_err) {
          coverBlob = null;
        }

        const payload = new FormData();
        payload.set('title', this.form.title || '');
        payload.set('description', this.form.description || '');
        payload.set('contentHash', contentHash);
        payload.set('localFileName', selectedFile.name || '');
        payload.set('localFileSize', String(Number(selectedFile.size || 0)));
        payload.set('localMimeType', String(selectedFile.type || ''));
        if (coverBlob) {
          payload.append('cover', coverBlob, `${contentHash.slice(0, 12)}.jpg`);
        }

        this.uploadStatus = '提交登记到服务器...';
        const result = await apiFetch('/api/videos', {
          method: 'POST',
          body: payload,
        });
        const reusedHint = result.reused ? '（复用已存在 hash）' : '';
        this.uploadStatus = `登记成功${reusedHint}: ${result.video?.title || result.video?.id || '完成'}`;
        this.form.title = '';
        this.form.description = '';
        if (input) {
          input.value = '';
        }
      } catch (err) {
        this.uploadStatus = `登记失败: ${err.message}`;
      }
    },
  },
  async onReady() {
    await this.loadSupportedFormats();
  },
});
