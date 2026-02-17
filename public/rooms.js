const {
  apiFetch,
  formatDate,
  formatSeconds,
} = window.WatchPartyCommon;

const { mountAuthedPage } = window.WatchPartyVue;

mountAuthedPage({
  data() {
    return {
      rooms: [],
      keyword: '',
    };
  },
  computed: {
    filteredRooms() {
      return this.filterByKeyword(this.rooms, this.keyword, [
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
    canDeleteRoom(room) {
      if (!this.currentUser) {
        return false;
      }
      return this.currentUser.role === 'root' || room.createdByUserId === this.currentUser.id;
    },
    async loadRooms() {
      const data = await apiFetch('/api/rooms');
      this.rooms = Array.isArray(data.rooms) ? data.rooms : [];
    },
    async deleteRoom(room) {
      if (!window.confirm(`确认删除放映室「${room.name}」？`)) {
        return;
      }
      try {
        await apiFetch(`/api/rooms/${room.id}`, { method: 'DELETE' });
        await this.loadRooms();
      } catch (err) {
        alert(err.message);
      }
    },
  },
  async onReady() {
    await this.loadRooms();
  },
});
