const {
  apiFetch,
  formatDate,
  formatSeconds,
  formatBytes,
  shortenHash,
} = window.WatchPartyCommon;

const { mountAuthedPage } = window.WatchPartyVue;

mountAuthedPage({
  requireRoot: true,
  data() {
    return {
      videos: [],
      playlists: [],
      rooms: [],
      videoKeyword: '',
      playlistKeyword: '',
      roomKeyword: '',
    };
  },
  computed: {
    filteredVideos() {
      return this.filterByKeyword(this.videos, this.videoKeyword, [
        (video) => video.title,
        (video) => video.originalName,
        (video) => video.contentHash,
      ]);
    },
    filteredPlaylists() {
      return this.filterByKeyword(this.playlists, this.playlistKeyword, [
        (playlist) => playlist.name,
        (playlist) => playlist.description,
      ]);
    },
    filteredRooms() {
      return this.filterByKeyword(this.rooms, this.roomKeyword, [
        (room) => room.name,
        (room) => room.creatorName,
        (room) => room.sourceLabel,
        (room) => room.videoTitle,
        (room) => room.playlistName,
      ]);
    },
  },
  methods: {
    formatDate,
    formatSeconds,
    formatBytes,
    shortenHash,
    async loadVideos() {
      const data = await apiFetch('/api/videos');
      this.videos = Array.isArray(data.videos) ? data.videos : [];
    },
    async loadPlaylists() {
      const data = await apiFetch('/api/playlists');
      this.playlists = Array.isArray(data.playlists) ? data.playlists : [];
    },
    async loadRooms() {
      const data = await apiFetch('/api/admin/rooms');
      this.rooms = Array.isArray(data.rooms) ? data.rooms : [];
    },
    async deleteRoom(room) {
      if (!window.confirm(`确认删除放映室「${room.name}」？`)) {
        return;
      }
      try {
        await apiFetch(`/api/admin/rooms/${room.id}`, { method: 'DELETE' });
        await this.loadRooms();
      } catch (err) {
        alert(err.message);
      }
    },
    async deleteVideo(video) {
      if (!window.confirm(`确认删除视频「${video.title}」？\n该视频关联放映室会被关闭。`)) {
        return;
      }
      try {
        const result = await apiFetch(`/api/admin/videos/${video.id}`, { method: 'DELETE' });
        await Promise.all([this.loadVideos(), this.loadPlaylists(), this.loadRooms()]);
        alert(`已删除视频，关闭放映室 ${Number(result.closedRooms || 0)} 个`);
      } catch (err) {
        alert(err.message);
      }
    },
    async deletePlaylist(playlist) {
      if (!window.confirm(`确认删除视频列表「${playlist.name}」？\n关联放映室会被关闭。`)) {
        return;
      }
      try {
        const result = await apiFetch(`/api/admin/playlists/${playlist.id}`, { method: 'DELETE' });
        await Promise.all([this.loadPlaylists(), this.loadRooms()]);
        alert(`已删除视频列表，关闭放映室 ${Number(result.closedRooms || 0)} 个`);
      } catch (err) {
        alert(err.message);
      }
    },
  },
  async onReady() {
    try {
      await Promise.all([this.loadVideos(), this.loadPlaylists(), this.loadRooms()]);
    } catch (err) {
      this.authStatus = `加载管理数据失败: ${err.message}`;
    }
  },
});
