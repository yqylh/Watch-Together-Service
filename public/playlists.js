const {
  apiFetch,
  formatDate,
} = window.WatchPartyCommon;

const { mountAuthedPage } = window.WatchPartyVue;

mountAuthedPage({
  data() {
    return {
      playlists: [],
      keyword: '',
      roomNameByPlaylist: {},
      startEpisodeByPlaylist: {},
      roomStatusByPlaylist: {},
    };
  },
  computed: {
    filteredPlaylists() {
      return this.filterByKeyword(this.playlists, this.keyword, [
        (playlist) => playlist.name,
        (playlist) => playlist.description,
      ]);
    },
  },
  methods: {
    formatDate,
    normalizeStartEpisode(playlist) {
      if (!playlist.episodes.length) {
        return 0;
      }
      const current = Number(this.startEpisodeByPlaylist[playlist.id]);
      if (Number.isFinite(current) && current >= 0) {
        return current;
      }
      return Number(playlist.episodes[0].episodeIndex || 0);
    },
    async loadPlaylists() {
      const data = await apiFetch('/api/playlists');
      const list = Array.isArray(data.playlists) ? data.playlists : [];
      this.playlists = list;

      const startMap = { ...this.startEpisodeByPlaylist };
      list.forEach((playlist) => {
        if (playlist.episodes.length && startMap[playlist.id] == null) {
          startMap[playlist.id] = Number(playlist.episodes[0].episodeIndex || 0);
        }
      });
      this.startEpisodeByPlaylist = startMap;
    },
    async createRoomFromPlaylist(playlist) {
      const roomName = String(this.roomNameByPlaylist[playlist.id] || '').trim();
      const startEpisodeIndex = this.normalizeStartEpisode(playlist);
      this.roomStatusByPlaylist = {
        ...this.roomStatusByPlaylist,
        [playlist.id]: '创建中...',
      };
      try {
        const result = await apiFetch(`/api/playlists/${playlist.id}/rooms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName, startEpisodeIndex }),
        });
        window.location.href = `/rooms/${result.room.id}`;
      } catch (err) {
        this.roomStatusByPlaylist = {
          ...this.roomStatusByPlaylist,
          [playlist.id]: `创建失败: ${err.message}`,
        };
      }
    },
  },
  async onReady() {
    await this.loadPlaylists();
  },
});
