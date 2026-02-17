const {
  apiFetch,
  formatDate,
  formatSeconds,
  formatBytes,
  shortenHash,
} = window.WatchPartyCommon;
const { mountAuthedPage } = window.WatchPartyVue;

const videoId = window.location.pathname.split('/').filter(Boolean).pop();

mountAuthedPage({
  data() {
    return {
      video: null,
      videoError: '',
      roomName: '',
      roomStatus: '',
      locationOrigin: window.location.origin,
    };
  },
  methods: {
    formatDate,
    formatSeconds,
    formatBytes,
    shortenHash,
    canDeleteRoom(room) {
      if (!this.currentUser) {
        return false;
      }
      return this.currentUser.role === 'root' || room.createdByUserId === this.currentUser.id;
    },
    async loadVideo() {
      const data = await apiFetch(`/api/videos/${videoId}`);
      this.video = data.video || null;
    },
    async createRoom() {
      this.roomStatus = '创建中...';
      try {
        const result = await apiFetch(`/api/videos/${videoId}/rooms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName: this.roomName || '' }),
        });
        window.location.href = `/rooms/${result.room.id}`;
      } catch (err) {
        this.roomStatus = `创建失败: ${err.message}`;
      }
    },
    async deleteRoom(room) {
      if (!window.confirm(`确认删除放映室「${room.name}」？`)) {
        return;
      }
      try {
        await apiFetch(`/api/rooms/${room.id}`, { method: 'DELETE' });
        await this.loadVideo();
      } catch (err) {
        alert(err.message);
      }
    },
  },
  async onReady() {
    try {
      await this.loadVideo();
    } catch (err) {
      this.video = null;
      this.videoError = err.message;
    }
  },
});
