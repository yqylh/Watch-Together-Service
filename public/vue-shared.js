(function exposeVueShared() {
  const {
    apiFetch,
    setAuthToken,
  } = window.WatchPartyCommon;

  function toSearchText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function includesKeyword(value, keyword) {
    return toSearchText(value).includes(toSearchText(keyword));
  }

  function filterByKeyword(items, keyword, selectors = []) {
    const key = toSearchText(keyword);
    if (!key) {
      return items;
    }
    return items.filter((item) => selectors.some((select) => includesKeyword(select(item), key)));
  }

  async function logoutAndRedirect(redirectTo = '/') {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_err) {
      // ignore
    }
    setAuthToken('');
    window.location.href = redirectTo;
  }

  async function ensureAuth(ctx, options = {}) {
    const requireRoot = Boolean(options.requireRoot);
    const redirectTo = String(options.redirectTo || '/');
    const onUser = typeof options.onUser === 'function' ? options.onUser : null;

    let user = null;
    try {
      const result = await apiFetch('/api/auth/me');
      user = result.user || null;
    } catch (_err) {
      user = null;
    }

    if (!user) {
      ctx.currentUser = null;
      ctx.authStatus = '未登录，正在跳转...';
      if (Object.prototype.hasOwnProperty.call(ctx, 'accessDenied')) {
        ctx.accessDenied = '';
      }
      setAuthToken('');
      window.location.href = redirectTo;
      return false;
    }

    ctx.currentUser = user;
    if (onUser) {
      onUser(user);
    }

    if (requireRoot && user.role !== 'root') {
      ctx.authStatus = `当前用户 ${user.username} 不是 Root，无权限访问管理台`;
      if (Object.prototype.hasOwnProperty.call(ctx, 'accessDenied')) {
        ctx.accessDenied = ctx.authStatus;
      }
      return false;
    }

    ctx.authStatus = '';
    if (Object.prototype.hasOwnProperty.call(ctx, 'accessDenied')) {
      ctx.accessDenied = '';
    }
    return true;
  }

  function mountAuthedPage(config = {}) {
    const {
      data,
      computed,
      methods,
      requireRoot = false,
      onReady,
      redirectTo = '/',
    } = config;

    return Vue.createApp({
      data() {
        return {
          loading: true,
          authStatus: '鉴权中...',
          currentUser: null,
          accessDenied: '',
          ...(typeof data === 'function' ? data() : {}),
        };
      },
      computed: computed || {},
      methods: {
        toSearchText,
        includesKeyword,
        filterByKeyword(items, keyword, selectors) {
          return filterByKeyword(items, keyword, selectors);
        },
        async checkAuth() {
          return ensureAuth(this, { requireRoot, redirectTo });
        },
        async logout() {
          await logoutAndRedirect(redirectTo);
        },
        ...(methods || {}),
      },
      async mounted() {
        const authed = await this.checkAuth();
        if (!authed) {
          this.loading = false;
          return;
        }
        if (typeof onReady === 'function') {
          await onReady.call(this);
        }
        this.loading = false;
      },
    }).mount('#app');
  }

  window.WatchPartyVue = {
    toSearchText,
    includesKeyword,
    filterByKeyword,
    logoutAndRedirect,
    ensureAuth,
    mountAuthedPage,
  };
})();
