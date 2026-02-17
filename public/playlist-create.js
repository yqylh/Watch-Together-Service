const {
  apiFetch,
  formatBytes,
  shortenHash,
} = window.WatchPartyCommon;

const { mountAuthedPage } = window.WatchPartyVue;

mountAuthedPage({
  data() {
    return {
      videos: [],
      libraryKeyword: '',
      selectedEpisodeVideoIds: [],
      form: {
        name: '',
        description: '',
      },
      submitStatus: '',
    };
  },
  computed: {
    filteredLibrary() {
      return this.filterByKeyword(this.videos, this.libraryKeyword, [
        (video) => video.title,
        (video) => video.originalName,
        (video) => video.contentHash,
      ]);
    },
  },
  methods: {
    formatBytes,
    shortenHash,
    findVideo(videoId) {
      return this.videos.find((item) => item.id === videoId) || null;
    },
    addEpisode(videoId) {
      this.selectedEpisodeVideoIds.push(videoId);
    },
    moveEpisode(fromIndex, toIndex) {
      if (toIndex < 0 || toIndex >= this.selectedEpisodeVideoIds.length) {
        return;
      }
      const next = [...this.selectedEpisodeVideoIds];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      this.selectedEpisodeVideoIds = next;
    },
    removeEpisode(index) {
      this.selectedEpisodeVideoIds = this.selectedEpisodeVideoIds.filter((_item, idx) => idx !== index);
    },
    async loadVideos() {
      const data = await apiFetch('/api/videos');
      this.videos = Array.isArray(data.videos) ? data.videos : [];
    },
    async submitPlaylist() {
      if (!this.selectedEpisodeVideoIds.length) {
        this.submitStatus = '请先加入至少 1 集';
        return;
      }
      this.submitStatus = '创建中...';
      try {
        await apiFetch('/api/playlists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: this.form.name,
            description: this.form.description,
            episodeVideoIds: this.selectedEpisodeVideoIds,
          }),
        });
        this.submitStatus = '创建成功，正在跳转列表页...';
        window.location.href = '/playlists';
      } catch (err) {
        this.submitStatus = `创建失败: ${err.message}`;
      }
    },
  },
  async onReady() {
    await this.loadVideos();
  },
});
