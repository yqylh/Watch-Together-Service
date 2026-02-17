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

  async function computeFileSha256Hex(file) {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(digest);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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
    computeFileSha256Hex,
  };
})();
