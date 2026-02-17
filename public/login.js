const { createApp } = Vue;

const {
  apiFetch,
  setAuthToken,
} = window.WatchPartyCommon;

createApp({
  data() {
    return {
      authStatus: '请登录或注册',
      currentUser: null,
      loginForm: {
        username: '',
        password: '',
      },
      registerForm: {
        username: '',
        password: '',
      },
    };
  },
  methods: {
    async checkAuth() {
      try {
        const result = await apiFetch('/api/auth/me');
        this.currentUser = result.user || null;
        this.authStatus = this.currentUser ? '登录状态有效' : '请登录或注册';
      } catch (_err) {
        this.currentUser = null;
        this.authStatus = '请登录或注册';
      }
    },
    async submitLogin() {
      this.authStatus = '登录中...';
      try {
        const result = await apiFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: this.loginForm.username,
            password: this.loginForm.password,
          }),
        });
        setAuthToken(result.token);
        this.currentUser = result.user || null;
        this.authStatus = '登录成功，正在进入视频页...';
        window.location.href = '/videos';
      } catch (err) {
        this.authStatus = `登录失败: ${err.message}`;
      }
    },
    async submitRegister() {
      this.authStatus = '注册中...';
      try {
        const result = await apiFetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: this.registerForm.username,
            password: this.registerForm.password,
          }),
        });
        setAuthToken(result.token);
        this.currentUser = result.user || null;
        this.authStatus = '注册成功，正在进入视频页...';
        window.location.href = '/videos';
      } catch (err) {
        this.authStatus = `注册失败: ${err.message}`;
      }
    },
    async logout() {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch (_err) {
        // ignore
      }
      setAuthToken('');
      this.currentUser = null;
      this.authStatus = '已退出登录';
    },
  },
  mounted() {
    this.checkAuth();
  },
}).mount('#app');
