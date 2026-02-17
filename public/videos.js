const {
  formatDate,
  formatBytes,
  shortenHash,
  apiFetch,
} = window.WatchPartyCommon;

const { mountAuthedPage } = window.WatchPartyVue;

mountAuthedPage({
  data() {
    return {
      videos: [],
      keyword: '',
      roomNameByVideo: {},
      roomStatusByVideo: {},
    };
  },
  computed: {
    filteredVideos() {
      return this.filterByKeyword(this.videos, this.keyword, [
        (video) => video.title,
        (video) => video.originalName,
        (video) => video.contentHash,
      ]);
    },
  },
  methods: {
    formatDate,
    formatBytes,
    shortenHash,
    async loadVideos() {
      const data = await apiFetch('/api/videos');
      this.videos = Array.isArray(data.videos) ? data.videos : [];
    },
    async createRoom(video) {
      const roomName = String(this.roomNameByVideo[video.id] || '').trim();
      this.roomStatusByVideo = {
        ...this.roomStatusByVideo,
        [video.id]: '创建中...',
      };
      try {
        const result = await apiFetch(`/api/videos/${video.id}/rooms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName }),
        });
        window.location.href = `/rooms/${result.room.id}`;
      } catch (err) {
        this.roomStatusByVideo = {
          ...this.roomStatusByVideo,
          [video.id]: `创建失败: ${err.message}`,
        };
      }
    },
  },
  async onReady() {
    await this.loadVideos();
  },
});
