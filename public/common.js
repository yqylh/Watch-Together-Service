(function exposeCommon() {
  const AUTH_TOKEN_KEY = 'auth_token';

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

  function formatDate(value) {
    return new Date(value).toLocaleString();
  }

  function formatSeconds(value) {
    const sec = Math.max(0, Math.floor(Number(value) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let idx = 0;
    while (size >= 1024 && idx < units.length - 1) {
      size /= 1024;
      idx += 1;
    }
    if (size >= 100 || idx === 0) {
      return `${Math.round(size)} ${units[idx]}`;
    }
    return `${size.toFixed(1)} ${units[idx]}`;
  }

  function normalizeHash(hash) {
    return String(hash || '').trim().toLowerCase();
  }

  function shortenHash(hash, length = 6) {
    const normalized = normalizeHash(hash);
    if (!normalized) {
      return '-';
    }
    const size = Math.max(1, Number(length) || 6);
    return normalized.slice(0, size);
  }

  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotr(value, shift) {
    return (value >>> shift) | (value << (32 - shift));
  }

  class Sha256Ctx {
    constructor() {
      this.h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
      ]);
      this.block = new Uint8Array(64);
      this.blockLen = 0;
      this.bytesHashed = 0;
      this.w = new Uint32Array(64);
    }

    processBlock() {
      const w = this.w;
      for (let i = 0; i < 16; i += 1) {
        const j = i * 4;
        w[i] = ((this.block[j] << 24) | (this.block[j + 1] << 16) | (this.block[j + 2] << 8) | this.block[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (((w[i - 16] + s0) >>> 0) + ((w[i - 7] + s1) >>> 0)) >>> 0;
      }

      let a = this.h[0];
      let b = this.h[1];
      let c = this.h[2];
      let d = this.h[3];
      let e = this.h[4];
      let f = this.h[5];
      let g = this.h[6];
      let h = this.h[7];

      for (let i = 0; i < 64; i += 1) {
        const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const temp1 = (((((h + S1) >>> 0) + ch) >>> 0) + ((SHA256_K[i] + w[i]) >>> 0)) >>> 0;
        const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const temp2 = (S0 + maj) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      this.h[0] = (this.h[0] + a) >>> 0;
      this.h[1] = (this.h[1] + b) >>> 0;
      this.h[2] = (this.h[2] + c) >>> 0;
      this.h[3] = (this.h[3] + d) >>> 0;
      this.h[4] = (this.h[4] + e) >>> 0;
      this.h[5] = (this.h[5] + f) >>> 0;
      this.h[6] = (this.h[6] + g) >>> 0;
      this.h[7] = (this.h[7] + h) >>> 0;
    }

    update(bytes) {
      let offset = 0;
      this.bytesHashed += bytes.length;

      while (offset < bytes.length) {
        const space = 64 - this.blockLen;
        const inputPartLen = Math.min(space, bytes.length - offset);
        this.block.set(bytes.subarray(offset, offset + inputPartLen), this.blockLen);
        this.blockLen += inputPartLen;
        offset += inputPartLen;

        if (this.blockLen === 64) {
          this.processBlock();
          this.blockLen = 0;
        }
      }
    }

    digestHex() {
      const bitLen = this.bytesHashed * 8;
      this.block[this.blockLen] = 0x80;
      this.blockLen += 1;

      if (this.blockLen > 56) {
        while (this.blockLen < 64) {
          this.block[this.blockLen] = 0;
          this.blockLen += 1;
        }
        this.processBlock();
        this.blockLen = 0;
      }

      while (this.blockLen < 56) {
        this.block[this.blockLen] = 0;
        this.blockLen += 1;
      }

      const hi = Math.floor(bitLen / 0x100000000);
      const lo = bitLen >>> 0;
      this.block[56] = (hi >>> 24) & 0xff;
      this.block[57] = (hi >>> 16) & 0xff;
      this.block[58] = (hi >>> 8) & 0xff;
      this.block[59] = hi & 0xff;
      this.block[60] = (lo >>> 24) & 0xff;
      this.block[61] = (lo >>> 16) & 0xff;
      this.block[62] = (lo >>> 8) & 0xff;
      this.block[63] = lo & 0xff;
      this.processBlock();

      let out = '';
      for (let i = 0; i < 8; i += 1) {
        out += this.h[i].toString(16).padStart(8, '0');
      }
      return out;
    }
  }

  async function computeFileSha256Hex(file, options = {}) {
    const chunkSize = Math.max(1024 * 1024, Number(options.chunkSize || 8 * 1024 * 1024));
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const total = Number(file?.size || 0);
    if (!total) {
      throw new Error('文件为空或不可读');
    }

    const ctx = new Sha256Ctx();
    let offset = 0;

    while (offset < total) {
      const end = Math.min(total, offset + chunkSize);
      let chunkBuffer;
      try {
        chunkBuffer = await file.slice(offset, end).arrayBuffer();
      } catch (err) {
        throw new Error(`读取文件失败（${offset}-${end} 字节）：${err?.message || '未知错误'}`);
      }
      ctx.update(new Uint8Array(chunkBuffer));
      offset = end;
      if (onProgress) {
        onProgress(offset, total);
      }
    }

    return ctx.digestHex();
  }

  window.WatchPartyCommon = {
    AUTH_TOKEN_KEY,
    getAuthToken,
    setAuthToken,
    apiFetch,
    formatDate,
    formatSeconds,
    formatBytes,
    normalizeHash,
    shortenHash,
    computeFileSha256Hex,
  };
})();
