// ============================================================
// Linus — app.js (v2 Aesthetic)
// ============================================================

// ---- Dual-Deck Audio Architecture (Deck A + Deck B for Seamless Auto-DJ) ----
const _audioA = document.querySelector('#audio');
const _audioB = document.querySelector('#audio-deck-b');
let activeDeck = 'A'; // 'A' | 'B'

function getActiveAudio() {
  return (activeDeck === 'B' && _audioB) ? _audioB : _audioA;
}

function getStandbyAudio() {
  return (activeDeck === 'B') ? _audioA : (_audioB || _audioA);
}

// Proxied audio interface so all existing code references to `audio` dynamically
// operate on whichever deck is currently active!
const _audioRegisteredListeners = new Map();

const audio = new Proxy(_audioA, {
  get(target, prop, receiver) {
    const active = getActiveAudio();
    if (prop === 'addEventListener') {
      return function(type, listener, options) {
        if (!_audioRegisteredListeners.has(type)) {
          _audioRegisteredListeners.set(type, new Set());
        }
        _audioRegisteredListeners.get(type).add(listener);

        _audioA.addEventListener(type, function(e) {
          if (activeDeck === 'A' || e.__forceCrossfade) {
            listener.call(_audioA, e);
          }
        }, options);

        if (_audioB) {
          _audioB.addEventListener(type, function(e) {
            if (activeDeck === 'B' || e.__forceCrossfade) {
              listener.call(_audioB, e);
            }
          }, options);
        }
      };
    }
    if (prop === 'removeEventListener') {
      return function(type, listener, options) {
        _audioA.removeEventListener(type, listener, options);
        if (_audioB) _audioB.removeEventListener(type, listener, options);
        if (_audioRegisteredListeners.has(type)) {
          _audioRegisteredListeners.get(type).delete(listener);
        }
      };
    }
    const val = Reflect.get(active, prop, active);
    if (typeof val === 'function') {
      return val.bind(active);
    }
    return val;
  },
  set(target, prop, value, receiver) {
    const active = getActiveAudio();
    return Reflect.set(active, prop, value, active);
  }
});

const state = {
  tracks: [],
  playlists: {},
  favorites: [],
  history: [],
  positions: {},
  lyrics: {},
  track_categories: {},
  categories: [],
  library_folders: [],
};
window.state = state;

let queue = [];
let currentIndex = -1;
let shuffleOn = false;
let repeatMode = 'none'; // 'none' | 'one' | 'all'
let toastTimer;
let currentVideoTrack = null;
let activeJobId = null;
let progressSSE = null;
let activeCategory = '';

const $ = sel => document.querySelector(sel);
const escapeHtml = v => String(v).replace(/[&<>'"]/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

async function api(url, options = {}) {
  const res = await fetch(url, { headers: {'Content-Type':'application/json'}, ...options });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function notify(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function formatTime(s) {
  if (!Number.isFinite(s)) return '0:00';
  return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
}

// ---- Hydrate & Persistent State -----------------------------
async function saveState() {
  try {
    await api('/api/state', {
      method: 'POST',
      body: JSON.stringify({
        playlists: state.playlists,
        favorites: state.favorites,
        history: state.history,
        last_played_track_id: state.last_played_track_id,
        last_played_position: state.last_played_position,
        lyrics: state.lyrics,
        track_categories: state.track_categories,
        library_folders: state.library_folders
      })
    });
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

let _saveStateTimer = null;
function debouncedSaveState(delay = 1000) {
  clearTimeout(_saveStateTimer);
  _saveStateTimer = setTimeout(saveState, delay);
}

function restoreLastPlaybackSession(trackId, position) {
  const track = trackById(trackId);
  if (!track || track.missing || track.media_type === 'video') return;

  currentIndex = queue.findIndex(t => t.id === trackId);
  if (currentIndex < 0) {
    currentIndex = 0;
  }

  audio.src = track.url;
  audio.currentTime = position || 0;

  $('#now-title').textContent = track.title;
  $('#now-artist').textContent = track.artist;
  if (track.has_artwork && track.artwork_url) {
    $('#now-art').innerHTML = `<img src="${track.artwork_url}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    $('#album-art-box').innerHTML = `<img src="${track.artwork_url}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:50%;box-shadow:0 0 20px rgba(0,0,0,0.6);">`;
  } else {
    $('#now-art').innerHTML = `<i class="ph-fill ph-music-notes"></i>`;
    $('#album-art-box').innerHTML = `<i class="ph-fill ph-music-notes-simple"></i>`;
  }

  $('#hero-title').innerHTML = `${escapeHtml(track.title)}<br><em>ready to play.</em>`;
  $('#hero-artist').textContent = `${track.artist} · ${track.album}`;
  const durStr = track.duration ? ` · ${formatTime(track.duration)}` : '';
  $('#hero-format').textContent = `${track.extension.toUpperCase()} · ${track.quality || 'Standard'}${durStr}`;
  
  $('#current-time').textContent = formatTime(position || 0);
  if (track.duration) {
    $('#total-time').textContent = formatTime(track.duration);
    $('#progress').value = (position / track.duration) * 100;
  }

  applyChameleonPalette(track);
  updateFullscreenUI(track);
  syncNowPlayingFavorite(track.id);
  loadLyricsInline(track);
  updateMediaSessionMetadata(track);
}

function hydrate(data) {
  state.tracks = data.tracks || [];
  state.categories = data.categories || [];
  const saved = data.state || {};
  state.playlists = saved.playlists || {};
  try {
    state.online_tracks_cache = JSON.parse(localStorage.getItem('linus_online_tracks_cache') || '{}');
  } catch (e) {
    state.online_tracks_cache = {};
  }
  state.favorites = saved.favorites || [];
  state.history = saved.history || [];
  state.last_played_track_id = saved.last_played_track_id || null;
  state.last_played_position = saved.last_played_position || 0;
  state.lyrics = saved.lyrics || {};
  state.track_categories = saved.track_categories || {};
  state.library_folders = saved.library_folders || [];

  const audioTracks = state.tracks.filter(t => t.media_type !== 'video');
  queue = [...audioTracks];

  renderCategoryBar();
  renderTracks(audioTracks);
  renderQueue();
  renderContinueRail();
  renderVideos();
  renderFavorites();
  renderPlaylists();

  // Load full Spotify/YouTube Music-style recommendation dashboard
  loadDashboardRecommendations();
  renderDashboardUpNext();
  initHeroWaveformVisualizer();

  const count = audioTracks.length;
  $('#library-status').textContent = `${count} audio file${count === 1 ? '' : 's'} available`;

  const meta = data.metadata || {};
  const trackCount = meta.track_count !== undefined ? ` · ${meta.track_count} indexed` : '';
  $('#database-status').textContent = meta.connected
    ? `SQLite: Ready${trackCount}`
    : 'SQLite: Unavailable';

  // Restore last active session if available (but don't interrupt a YouTube stream)
  if (state.last_played_track_id && !_ytCurrentStreamId) {
    restoreLastPlaybackSession(state.last_played_track_id, state.last_played_position);
  }
}

// ---- Animated Sidebar & Edge Trigger Architecture -----------
let isSidebarPinned = localStorage.getItem('linus_sidebar_pinned') === 'true';
let sidebarIntroTimer = null;
let hasSidebarIntroPlayed = false;

function applySidebarPinnedState() {
  if (isSidebarPinned) {
    document.body.classList.add('sidebar-is-pinned');
    $('#sidebar')?.classList.add('sidebar-open');
    $('#sidebar-pin-btn')?.classList.add('pinned');
    $('#sidebar-pin-btn')?.setAttribute('title', 'Unpin sidebar (auto-hide mode)');
  } else {
    document.body.classList.remove('sidebar-is-pinned');
    $('#sidebar-pin-btn')?.classList.remove('pinned');
    $('#sidebar-pin-btn')?.setAttribute('title', 'Pin sidebar visible');
  }
}

function openSidebar() {
  if (sidebarIntroTimer) {
    clearTimeout(sidebarIntroTimer);
    sidebarIntroTimer = null;
  }
  $('#sidebar')?.classList.remove('sidebar-intro-rollout');
  document.body.classList.remove('sidebar-intro-active');

  $('#sidebar')?.classList.add('sidebar-open', 'mobile-open');
  $('#sidebar-backdrop')?.classList.add('active');
  document.body.classList.add('sidebar-is-open');
}

function closeSidebar() {
  if (isSidebarPinned && window.innerWidth > 860) return; // Keep pinned on desktop if preferred
  if (sidebarIntroTimer) {
    clearTimeout(sidebarIntroTimer);
    sidebarIntroTimer = null;
  }
  $('#sidebar')?.classList.remove('sidebar-intro-rollout', 'sidebar-open', 'mobile-open');
  $('#sidebar-backdrop')?.classList.remove('active');
  document.body.classList.remove('sidebar-is-open', 'sidebar-intro-active');
}

function toggleSidebar() {
  const isOpen = $('#sidebar')?.classList.contains('sidebar-open') || $('#sidebar')?.classList.contains('mobile-open');
  if (isOpen) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

function toggleSidebarPin() {
  isSidebarPinned = !isSidebarPinned;
  localStorage.setItem('linus_sidebar_pinned', isSidebarPinned ? 'true' : 'false');
  applySidebarPinnedState();
  if (isSidebarPinned) {
    openSidebar();
    showToast('Sidebar pinned to screen', 'info');
  } else {
    showToast('Sidebar unpinned (Touch edge to open)', 'info');
  }
}

// Backward compatibility helper
function closeMobileSidebar() { closeSidebar(); }
function openMobileSidebar() { openSidebar(); }

// Trigger handlers
$('#mobile-menu-btn')?.addEventListener('click', toggleSidebar);
$('#sidebar-close-btn')?.addEventListener('click', closeSidebar);
$('#sidebar-backdrop')?.addEventListener('click', closeSidebar);
$('#sidebar-pin-btn')?.addEventListener('click', toggleSidebarPin);

// Floating edge trigger handle (touch or click)
const edgeTrigger = $('#sidebar-edge-trigger');
if (edgeTrigger) {
  edgeTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openSidebar();
  });
  edgeTrigger.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    openSidebar();
  }, { passive: true });
}


// Initial greeting roll-out animation when website opens
function initSidebarRolloutIntro() {
  if (hasSidebarIntroPlayed) return;
  hasSidebarIntroPlayed = true;

  applySidebarPinnedState();
  if (isSidebarPinned) return; // Already docked, skip retraction

  const sidebar = $('#sidebar');
  if (!sidebar) return;

  // Add intro animation classes so user watches the sidebar roll out smoothly
  document.body.classList.add('sidebar-intro-active');
  sidebar.classList.add('sidebar-intro-rollout');

  // Cancel retraction if user hovers or interacts with sidebar during the intro rollout
  const cancelIntroAutoClose = () => {
    if (sidebarIntroTimer) {
      clearTimeout(sidebarIntroTimer);
      sidebarIntroTimer = null;
    }
    sidebar.classList.remove('sidebar-intro-rollout');
    openSidebar();
    sidebar.removeEventListener('pointerenter', cancelIntroAutoClose);
    sidebar.removeEventListener('touchstart', cancelIntroAutoClose);
  };
  sidebar.addEventListener('pointerenter', cancelIntroAutoClose, { once: true });
  sidebar.addEventListener('touchstart', cancelIntroAutoClose, { once: true, passive: true });

  // Let the sidebar display and then smoothly glide back into the edge
  sidebarIntroTimer = setTimeout(() => {
    sidebar.classList.remove('sidebar-intro-rollout');
    document.body.classList.remove('sidebar-intro-active');
    sidebarIntroTimer = null;
  }, 2800);
}

// ---- Views --------------------------------------------------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    $(`#${btn.dataset.view}-view`).classList.remove('hidden');
    
    closeMobileSidebar();
    
    if (btn.dataset.view === 'favorites') renderFavorites();
    if (btn.dataset.view === 'playlists') renderPlaylists();
    if (btn.dataset.view === 'downloads') renderDownloadsView();
    if (btn.dataset.view === 'library') renderTracks(state.tracks.filter(t => t.media_type !== 'video'));
    if (btn.dataset.view === 'lyrics') {
      const activeT = getActivePlaybackTrack();
      if (activeT) loadLyricsInline(activeT);
    }
    if (btn.dataset.view === 'explore') {
      const resultsContainer = $('#explore-results');
      if (resultsContainer && !resultsContainer.children.length && !_ytSearchQuery) {
        $('#explore-input').value = 'Trending English Pop Hits 2024';
        searchYouTube('Trending English Pop Hits 2024');
      }
    }
    if (btn.dataset.view === 'dj-studio') {
      // Pause standard player if playing
      if (!audio.paused) {
        audio.pause();
        $('#play').innerHTML = '<i class="ph-fill ph-play"></i>';
        $('#vinyl-record')?.classList.remove('playing');
      }
      if (!window.djStudio) {
        window.djStudio = new DJStudioUI();
      }
      window.djStudio.init();
      notify('🎧 DJ Remix Studio Activated — Load tracks to Deck A & B');
    }
  });
});

// ---- Renderers ----------------------------------------------
function renderCategoryBar() {
  const bar = $('#category-bar');
  if (!state.categories.length) { bar.innerHTML = ''; return; }
  const all = `<button class="cat-pill ${activeCategory===''?'active':''}" data-cat="">All</button>`;
  const pills = state.categories.map(c =>
    `<button class="cat-pill ${activeCategory===c?'active':''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
  ).join('');
  bar.innerHTML = all + pills;
  bar.querySelectorAll('.cat-pill').forEach(btn =>
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat;
      renderCategoryBar();
      renderTracks(state.tracks.filter(t => t.media_type !== 'video'));
    })
  );
}

function renderTracks(audioTracks) {
  const query = $('#search').value.trim().toLowerCase();
  let filtered = audioTracks;
  if (activeCategory) filtered = filtered.filter(t => t.category === activeCategory);
  if (query) {
    const qWords = query.split(/\s+/).filter(Boolean);
    filtered = filtered.filter(t => {
      const haystack = `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.category || ''} ${t.genre || ''} ${t.quality || ''} ${t.extension || ''}`.toLowerCase();
      return qWords.every(w => haystack.includes(w));
    });
  }
  
  const list = $('#track-list');
  $('#empty-state').classList.toggle('hidden', filtered.length > 0 || state.tracks.length > 0);
  
  const currentPlayingId = queue[currentIndex]?.id;

  list.innerHTML = filtered.map((t, i) => {
    const isPlaying = t.id === currentPlayingId;
    const waveBadge = isPlaying ? `
      <span class="track-soundwave" title="Currently Playing">
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
      </span>` : '';

    return `
    <div class="track-row ${isPlaying ? 'row-playing' : ''}" data-id="${escapeHtml(t.id)}">
      <span class="track-num">${isPlaying ? waveBadge : String(i+1).padStart(2,'0')}</span>
      <div class="track-thumb">
        ${t.has_artwork && t.artwork_url
          ? `<img src="${t.artwork_url}" alt="" loading="lazy" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">`
          : `<span style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:rgba(255,255,255,0.07);"><i class="ph ph-music-note" style="color:#888;font-size:16px;"></i></span>`}
      </div>
      <div class="track-title-cell">
        <span class="track-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
      </div>
      <span class="track-artist" title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</span>
      <span class="track-album" title="${escapeHtml(t.album)}">${escapeHtml(t.album)}</span>
      <div class="track-cat">
        ${t.category ? `<span class="track-cat-tag">${escapeHtml(t.category)}</span>` : ''}
      </div>
      <div class="track-actions-cell" style="display:flex;align-items:center;gap:6px;">
        <button class="track-action start-radio-btn" data-id="${escapeHtml(t.id)}" title="Start Radio from this track">
          <i class="ph-bold ph-radio"></i>
        </button>
        <button class="track-action preview-track-btn" data-id="${escapeHtml(t.id)}" title="Quick 20s Preview">
          <i class="ph-bold ph-speaker-simple-high"></i>
        </button>
        <button class="track-action play-next-btn" data-id="${escapeHtml(t.id)}" title="Play Next">
          <i class="ph ph-queue"></i>
        </button>
        <button class="track-action queue-add-btn" data-id="${escapeHtml(t.id)}" title="Add to Queue">
          <i class="ph ph-list-plus"></i>
        </button>
        <button class="track-action playlist-add-btn" data-id="${escapeHtml(t.id)}" title="Add to Playlist">
          <i class="ph ph-plus-circle"></i>
        </button>
        <button class="track-action edit-track-btn" data-id="${escapeHtml(t.id)}" title="Edit Tags & Artwork">
          <i class="ph ph-pencil-simple"></i>
        </button>
        <button class="track-action fav-btn ${state.favorites.includes(t.id) ? 'active-fav' : ''}" data-id="${escapeHtml(t.id)}" title="Favorite">
          <i class="ph${state.favorites.includes(t.id) ? '-fill' : ''} ph-star"></i>
        </button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('dblclick', () => playById(row.dataset.id));
    
    row.querySelector('.start-radio-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      startTrackRadio(row.dataset.id);
    });

    row.querySelector('.preview-track-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      toggleTrackAudioPreview(row, e.currentTarget);
    });

    row.querySelector('.play-next-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      playNext(row.dataset.id);
    });

    row.querySelector('.queue-add-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      addToQueue(row.dataset.id);
    });

    row.querySelector('.playlist-add-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openAddToPlaylistModal(row.dataset.id);
    });

    const editBtn = row.querySelector('.edit-track-btn');
    if (editBtn) {
      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        openEditTrackModal(row.dataset.id);
      });
    }
    row.querySelector('.fav-btn').addEventListener('click', e => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      toggleFavorite(row.dataset.id, rect.left + rect.width / 2, rect.top);
    });
  });
}

function playNext(trackId) {
  const t = trackById(trackId);
  if (!t) return;
  if (queue.length === 0) {
    playById(trackId);
    return;
  }
  const existingIdx = queue.findIndex(x => x.id === trackId);
  if (existingIdx > currentIndex) {
    queue.splice(existingIdx, 1);
  }
  queue.splice(currentIndex + 1, 0, t);
  renderQueue();
  notify(`⏭️ "${t.title}" will play next!`);
}

function addToQueue(trackId) {
  const t = trackById(trackId);
  if (!t) return;
  queue.push(t);
  renderQueue();
  notify(`➕ "${t.title}" added to queue!`);
}

function renderFavorites() {
  const query = $('#search').value.trim().toLowerCase();
  let favTracks = state.favorites.map(trackById).filter(Boolean);
  if (query) {
    const qWords = query.split(/\s+/).filter(Boolean);
    favTracks = favTracks.filter(t => {
      const haystack = `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.category || ''} ${t.genre || ''} ${t.quality || ''}`.toLowerCase();
      return qWords.every(w => haystack.includes(w));
    });
  }
  const list = $('#favorite-list');
  if (!list) return;

  if (!favTracks.length) {
    list.innerHTML = `
      <div class="empty-state" style="padding: 60px 20px;">
        <i class="ph-fill ph-star empty-icon" style="color:var(--accent);font-size:44px;"></i>
        <h3>No favorite tracks yet.</h3>
        <p>Star any song in your library to add it to your loved collection.</p>
      </div>
    `;
    return;
  }

  const currentPlayingId = queue[currentIndex]?.id;

  list.innerHTML = favTracks.map((t, i) => {
    const isPlaying = t.id === currentPlayingId;
    const waveBadge = isPlaying ? `
      <span class="track-soundwave" title="Currently Playing">
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
      </span>` : '';

    return `
    <div class="track-row ${isPlaying ? 'row-playing' : ''}" data-id="${escapeHtml(t.id)}">
      <span class="track-num">${isPlaying ? waveBadge : String(i+1).padStart(2,'0')}</span>
      <div class="track-thumb">
        ${t.has_artwork && t.artwork_url
          ? `<img src="${t.artwork_url}" alt="" loading="lazy" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">`
          : `<span style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:rgba(255,255,255,0.07);"><i class="ph ph-music-note" style="color:#888;font-size:16px;"></i></span>`}
      </div>
      <div class="track-title-cell">
        <span class="track-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
      </div>
      <span class="track-artist" title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</span>
      <span class="track-album" title="${escapeHtml(t.album)}">${escapeHtml(t.album)}</span>
      <div class="track-cat">
        ${t.category ? `<span class="track-cat-tag">${escapeHtml(t.category)}</span>` : ''}
      </div>
      <div class="track-actions-cell" style="display:flex;align-items:center;gap:6px;">
        <button class="track-action start-radio-btn" data-id="${escapeHtml(t.id)}" title="Start Radio from this track">
          <i class="ph-bold ph-radio"></i>
        </button>
        <button class="track-action preview-track-btn" data-id="${escapeHtml(t.id)}" title="Quick 20s Preview">
          <i class="ph-bold ph-speaker-simple-high"></i>
        </button>
        <button class="track-action playlist-add-btn" data-id="${escapeHtml(t.id)}" title="Add to Playlist">
          <i class="ph ph-plus-circle"></i>
        </button>
        <button class="track-action edit-track-btn" data-id="${escapeHtml(t.id)}" title="Edit Tags & Artwork">
          <i class="ph ph-pencil-simple"></i>
        </button>
        <button class="track-action fav-btn active-fav" data-id="${escapeHtml(t.id)}" title="Remove Favorite">
          <i class="ph-fill ph-star"></i>
        </button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('dblclick', () => playById(row.dataset.id));
    
    row.querySelector('.start-radio-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      startTrackRadio(row.dataset.id);
    });

    row.querySelector('.preview-track-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      toggleTrackAudioPreview(row, e.currentTarget);
    });

    row.querySelector('.playlist-add-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openAddToPlaylistModal(row.dataset.id);
    });

    row.querySelector('.edit-track-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openEditTrackModal(row.dataset.id);
    });

    row.querySelector('.fav-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      toggleFavorite(row.dataset.id, rect.left + rect.width / 2, rect.top);
      renderFavorites();
    });
  });
}

let currentOpenPlaylistName = null;

function renderPlaylists() {
  const container = $('#playlist-list');
  if (!container) return;
  const pKeys = Object.keys(state.playlists || {});

  // Extract distinct folder playlists from imported library folders
  const folderPlaylists = {};
  state.tracks.forEach(t => {
    if (t.folder_name && t.media_type !== 'video') {
      if (!folderPlaylists[t.folder_name]) folderPlaylists[t.folder_name] = [];
      folderPlaylists[t.folder_name].push(t.id);
    }
  });

  const folderNames = Object.keys(folderPlaylists);

  // Show overview and hide details
  $('#playlists-overview')?.classList.remove('hidden');
  $('#playlist-detail-view')?.classList.add('hidden');
  currentOpenPlaylistName = null;

  if (!pKeys.length && !folderNames.length) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; padding: 60px 20px;">
        <i class="ph-fill ph-list-plus empty-icon" style="color:var(--accent);font-size:44px;"></i>
        <h3>No playlists or folders yet.</h3>
        <p>Curate custom mixes or import a local music folder.</p>
        <button class="btn-primary" id="empty-create-playlist-btn" style="margin:14px auto 0;"><i class="ph ph-plus"></i> Create Playlist</button>
      </div>
    `;
    $('#empty-create-playlist-btn')?.addEventListener('click', () => {
      $('#playlist-name-input').value = '';
      $('#playlist-create-sheet').showModal();
    });
    return;
  }

  // Palette of distinct gradients for folder playlists
  const FOLDER_GRADIENTS = [
    'linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(14, 165, 233, 0.1))',
    'linear-gradient(135deg, rgba(52, 211, 153, 0.25), rgba(16, 185, 129, 0.1))',
    'linear-gradient(135deg, rgba(217, 70, 239, 0.25), rgba(168, 85, 247, 0.1))',
    'linear-gradient(135deg, rgba(251, 146, 60, 0.25), rgba(245, 158, 11, 0.1))',
    'linear-gradient(135deg, rgba(244, 63, 94, 0.25), rgba(225, 29, 72, 0.1))'
  ];

  // 1. Render Folder-based Playlists first
  const folderCardsHtml = folderNames.map((folderName, idx) => {
    const trackIds = folderPlaylists[folderName];
    const count = trackIds.length;
    const grad = FOLDER_GRADIENTS[idx % FOLDER_GRADIENTS.length];

    return `
      <div class="playlist-card folder-playlist-card" data-folder-playlist="${escapeHtml(folderName)}" style="border-left: 3px solid #38bdf8;">
        <span class="folder-playlist-badge"><i class="ph-fill ph-folder"></i> Folder Library</span>
        <div class="playlist-cover-art" style="background: ${grad};">
          <i class="ph-fill ph-folder-notch-open" style="color:#38bdf8;font-size:48px;"></i>
        </div>
        <div class="playlist-info">
          <strong>📁 ${escapeHtml(folderName)}</strong>
          <span style="color:#38bdf8;font-weight:500;">${count} local track${count === 1 ? '' : 's'}</span>
        </div>
        <div class="playlist-actions-row">
          <button class="playlist-play-btn folder-play-btn" data-folder="${escapeHtml(folderName)}" title="Play Folder">
            <i class="ph-fill ph-play"></i> Play Folder
          </button>
        </div>
      </div>
    `;
  }).join('');

  // 2. Render Custom User-Created Playlists
  const customCardsHtml = pKeys.map(name => {
    const trackIds = state.playlists[name] || [];
    const count = trackIds.length;
    const firstTrack = trackById(trackIds[0]);
    const coverHtml = firstTrack && firstTrack.has_artwork && firstTrack.artwork_url
      ? `<img src="${firstTrack.artwork_url}" alt="Cover">`
      : `<i class="ph-fill ph-playlist"></i>`;

    return `
      <div class="playlist-card" data-name="${escapeHtml(name)}">
        <div class="playlist-cover-art">
          ${coverHtml}
        </div>
        <div class="playlist-info">
          <strong>${escapeHtml(name)}</strong>
          <span>${count} track${count === 1 ? '' : 's'}</span>
        </div>
        <div class="playlist-actions-row">
          <button class="playlist-play-btn" data-name="${escapeHtml(name)}" title="Play Playlist">
            <i class="ph-fill ph-play"></i> Play
          </button>
          <button class="playlist-del-btn" data-name="${escapeHtml(name)}" title="Delete Playlist">
            <i class="ph ph-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = folderCardsHtml + customCardsHtml;

  // Folder Playlists Event Handlers
  container.querySelectorAll('.folder-playlist-card').forEach(card => {
    const folderName = card.dataset.folderPlaylist;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.folder-play-btn')) return;
      openFolderPlaylistDetail(folderName, folderPlaylists[folderName]);
    });

    card.querySelector('.folder-play-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      playFolderPlaylist(folderName, folderPlaylists[folderName]);
    });
  });

  // Custom Playlists Event Handlers
  container.querySelectorAll('.playlist-card:not(.folder-playlist-card)').forEach(card => {
    const name = card.dataset.name;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.playlist-del-btn') || e.target.closest('.playlist-play-btn')) return;
      openPlaylistDetail(name);
    });

    card.querySelector('.playlist-play-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      playPlaylist(name);
    });

    card.querySelector('.playlist-del-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePlaylist(name);
    });
  });
}

function openFolderPlaylistDetail(folderName, trackIds) {
  currentOpenPlaylistName = `folder:${folderName}`;
  const query = $('#search').value.trim().toLowerCase();
  let pTracks = (trackIds || []).map(trackById).filter(Boolean);
  if (query) {
    pTracks = pTracks.filter(t => `${t.title} ${t.artist} ${t.category}`.toLowerCase().includes(query));
  }

  $('#playlists-overview')?.classList.add('hidden');
  $('#playlist-detail-view')?.classList.remove('hidden');

  $('#playlist-detail-title').textContent = `📁 Folder: ${folderName}`;
  $('#playlist-detail-stats').textContent = `${pTracks.length} tracks · Imported Local Library`;
  $('#playlist-detail-cover').innerHTML = `<i class="ph-fill ph-folder-open" style="color:#38bdf8;font-size:44px;"></i>`;
  $('#playlist-detail-delete').classList.add('hidden'); // Folder playlists cannot be deleted as custom playlists

  const list = $('#playlist-track-list');
  $('#playlist-detail-empty').classList.toggle('hidden', pTracks.length > 0);

  list.innerHTML = pTracks.map((t, i) => `
    <div class="track-row" data-id="${escapeHtml(t.id)}">
      <span class="track-num">${String(i + 1).padStart(2, '0')}</span>
      <div class="track-thumb">
        ${t.has_artwork && t.artwork_url
          ? `<img src="${t.artwork_url}" alt="" loading="lazy" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">`
          : `<span style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:rgba(255,255,255,0.07);"><i class="ph ph-music-note" style="color:#888;font-size:16px;"></i></span>`}
      </div>
      <div class="track-title-cell">
        <span class="track-title">${escapeHtml(t.title)}</span>
      </div>
      <span class="track-artist">${escapeHtml(t.artist)}</span>
      <span class="track-album">${escapeHtml(t.album || 'Local Folder')}</span>
      <div class="track-cat">
        ${t.category ? `<span class="track-cat-tag">${escapeHtml(t.category)}</span>` : ''}
      </div>
      <div class="track-actions-cell" style="display:flex;align-items:center;gap:6px;">
        <button class="track-action start-radio-btn" data-id="${escapeHtml(t.id)}" title="Start Radio from this track">
          <i class="ph-bold ph-radio"></i>
        </button>
        <button class="track-action preview-track-btn" data-id="${escapeHtml(t.id)}" title="Quick 20s Preview">
          <i class="ph-bold ph-speaker-simple-high"></i>
        </button>
        <button class="track-action fav-btn ${state.favorites.includes(t.id) ? 'active-fav' : ''}" data-id="${escapeHtml(t.id)}">
          <i class="ph${state.favorites.includes(t.id) ? '-fill' : ''} ph-star"></i>
        </button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('dblclick', () => playById(row.dataset.id));
    row.addEventListener('click', (e) => {
      if (e.target.closest('.track-action')) return;
      playById(row.dataset.id);
    });

    row.querySelector('.start-radio-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      startTrackRadio(row.dataset.id);
    });

    row.querySelector('.preview-track-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      toggleTrackAudioPreview(row, e.currentTarget);
    });
  });

  $('#playlist-detail-play').onclick = () => {
    if (pTracks.length) {
      queue = [...pTracks];
      currentIndex = 0;
      playById(queue[0].id);
    }
  };

  $('#playlist-detail-shuffle').onclick = () => {
    if (pTracks.length) {
      queue = smartShuffle(pTracks);
      currentIndex = 0;
      playById(queue[0].id);
      renderQueue();
    }
  };
}

function playFolderPlaylist(folderName, trackIds) {
  const pTracks = (trackIds || []).map(trackById).filter(Boolean);
  if (!pTracks.length) return notify('Folder is empty.');
  queue = [...pTracks];
  currentIndex = 0;
  playById(queue[0].id);
  notify(`▶️ Playing folder: ${folderName}`);
}

function openPlaylistDetail(name) {
  currentOpenPlaylistName = name;
  const query = $('#search').value.trim().toLowerCase();
  const trackIds = state.playlists[name] || [];
  let pTracks = trackIds.map(trackById).filter(Boolean);
  if (query) {
    pTracks = pTracks.filter(t => `${t.title} ${t.artist} ${t.category}`.toLowerCase().includes(query));
  }

  $('#playlists-overview')?.classList.add('hidden');
  $('#playlist-detail-view')?.classList.remove('hidden');

  $('#playlist-detail-title').textContent = name;
  
  // Calculate total duration
  const totalSecs = pTracks.reduce((acc, t) => acc + (t.duration || 0), 0);
  const durStr = totalSecs > 0 ? ` · ${Math.round(totalSecs / 60)} min` : '';
  $('#playlist-detail-stats').textContent = `${pTracks.length} track${pTracks.length === 1 ? '' : 's'}${durStr}`;

  // Cover Art
  const firstTrack = pTracks.find(t => t.has_artwork && t.artwork_url);
  $('#playlist-detail-cover').innerHTML = firstTrack
    ? `<img src="${firstTrack.artwork_url}" alt="Cover">`
    : `<i class="ph-fill ph-playlist"></i>`;

  const trackListEl = $('#playlist-track-list');
  const emptyEl = $('#playlist-detail-empty');

  if (!pTracks.length) {
    trackListEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const currentPlayingId = queue[currentIndex]?.id;

  trackListEl.innerHTML = pTracks.map((t, i) => {
    const isPlaying = t.id === currentPlayingId;
    const waveBadge = isPlaying ? `
      <span class="track-soundwave" title="Currently Playing">
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
        <span class="wave-bar-mini"></span>
      </span>` : '';

    return `
    <div class="track-row ${isPlaying ? 'row-playing' : ''}" data-id="${escapeHtml(t.id)}">
      <span class="track-num">${isPlaying ? waveBadge : String(i+1).padStart(2,'0')}</span>
      <div class="track-thumb">
        ${t.has_artwork && t.artwork_url
          ? `<img src="${t.artwork_url}" alt="" loading="lazy" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">`
          : `<span style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:rgba(255,255,255,0.07);"><i class="ph ph-music-note" style="color:#888;font-size:16px;"></i></span>`}
      </div>
      <div class="track-title-cell">
        <span class="track-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
      </div>
      <span class="track-artist" title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</span>
      <span class="track-album" title="${escapeHtml(t.album)}">${escapeHtml(t.album)}</span>
      <div class="track-cat">
        ${t.category ? `<span class="track-cat-tag">${escapeHtml(t.category)}</span>` : ''}
      </div>
      <div class="track-actions-cell" style="display:flex;align-items:center;gap:6px;">
        <button class="track-action preview-track-btn" data-id="${escapeHtml(t.id)}" title="Quick 20s Preview">
          <i class="ph-bold ph-speaker-simple-high"></i>
        </button>
        <button class="track-action playlist-remove-track-btn" data-id="${escapeHtml(t.id)}" title="Remove from this playlist">
          <i class="ph ph-trash"></i>
        </button>
        <button class="track-action edit-track-btn" data-id="${escapeHtml(t.id)}" title="Edit Tags & Artwork">
          <i class="ph ph-pencil-simple"></i>
        </button>
        <button class="track-action fav-btn ${state.favorites.includes(t.id) ? 'active-fav' : ''}" data-id="${escapeHtml(t.id)}" title="Favorite">
          <i class="ph${state.favorites.includes(t.id) ? '-fill' : ''} ph-star"></i>
        </button>
      </div>
    </div>`;
  }).join('');

  trackListEl.querySelectorAll('.track-row').forEach(row => {
    row.addEventListener('dblclick', () => {
      queue = [...pTracks];
      currentIndex = pTracks.findIndex(t => t.id === row.dataset.id);
      if (currentIndex === -1) currentIndex = 0;
      playById(queue[currentIndex].id);
      renderQueue();
    });

    row.querySelector('.preview-track-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      toggleTrackAudioPreview(row, e.currentTarget);
    });

    row.querySelector('.playlist-remove-track-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      removeTrackFromPlaylist(name, row.dataset.id);
    });

    row.querySelector('.edit-track-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openEditTrackModal(row.dataset.id);
    });

    row.querySelector('.fav-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      toggleFavorite(row.dataset.id, rect.left + rect.width / 2, rect.top);
      openPlaylistDetail(name);
    });
  });
}

function removeTrackFromPlaylist(playlistName, trackId) {
  if (!state.playlists[playlistName]) return;
  state.playlists[playlistName] = state.playlists[playlistName].filter(id => id !== trackId);
  saveState();
  openPlaylistDetail(playlistName);
  notify(`Removed track from "${playlistName}".`);
}

$('#playlist-back-btn')?.addEventListener('click', () => {
  renderPlaylists();
});

$('#playlist-detail-play')?.addEventListener('click', () => {
  if (!currentOpenPlaylistName) return;
  if (currentOpenPlaylistName.startsWith('folder:')) {
    // Folder playlist — gather tracks from state
    const folderName = currentOpenPlaylistName.slice(7);
    const folderTracks = state.tracks.filter(t => t.folder_name === folderName && t.media_type !== 'video');
    if (!folderTracks.length) return notify('Folder has no tracks.');
    queue = [...folderTracks];
    currentIndex = 0;
    playById(queue[0].id);
    renderQueue();
  } else {
    playPlaylist(currentOpenPlaylistName);
  }
});

$('#playlist-detail-shuffle')?.addEventListener('click', () => {
  if (!currentOpenPlaylistName) return;
  let pTracks;
  if (currentOpenPlaylistName.startsWith('folder:')) {
    const folderName = currentOpenPlaylistName.slice(7);
    pTracks = state.tracks.filter(t => t.folder_name === folderName && t.media_type !== 'video');
  } else {
    const trackIds = state.playlists[currentOpenPlaylistName] || [];
    pTracks = trackIds.map(trackById).filter(Boolean);
  }
  if (!pTracks.length) return notify('Playlist is empty.');

  // Smart-shuffle tracks with artist dispersion
  const shuffled = smartShuffle(pTracks);
  queue = shuffled;
  currentIndex = 0;
  playById(queue[0].id);
  renderQueue();
  notify(`🔀 Smart Shuffling: ${currentOpenPlaylistName.startsWith('folder:') ? currentOpenPlaylistName.slice(7) : currentOpenPlaylistName}`);
});

$('#playlist-detail-delete')?.addEventListener('click', () => {
  if (currentOpenPlaylistName && !currentOpenPlaylistName.startsWith('folder:')) {
    deletePlaylist(currentOpenPlaylistName);
  }
});

function playPlaylist(name) {
  const trackIds = state.playlists[name] || [];
  if (!trackIds.length) {
    return notify(`Playlist "${name}" is empty. Add songs first!`);
  }
  const pTracks = trackIds.map(trackById).filter(Boolean);
  if (!pTracks.length) return notify('No valid tracks found in playlist.');

  queue = [...pTracks];
  currentIndex = 0;
  playById(queue[0].id);
  renderQueue();
  notify(`▶ Playing playlist: ${name}`);
}

function deletePlaylist(name) {
  if (!confirm(`Are you sure you want to delete playlist "${name}"?`)) return;
  delete state.playlists[name];
  saveState();
  renderPlaylists();
  notify(`Deleted playlist "${name}".`);
}

// Create Playlist Sheet Triggers
$('#new-playlist')?.addEventListener('click', () => {
  $('#playlist-name-input').value = '';
  $('#playlist-create-sheet').showModal();
});
$('#playlist-create-close')?.addEventListener('click', () => $('#playlist-create-sheet').close());
$('#playlist-create-cancel')?.addEventListener('click', () => $('#playlist-create-sheet').close());

$('#playlist-create-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#playlist-name-input').value.trim();
  if (!name) return notify('Please enter a playlist name.');
  if (state.playlists[name]) return notify('A playlist with this name already exists.');

  state.playlists[name] = [];
  saveState();
  $('#playlist-create-sheet').close();
  renderPlaylists();
  notify(`✨ Created playlist "${name}"!`);
});

// ---- YouTube Playlist Importer Modal Handlers ----
let _currentFetchedPlaylist = null;

const importYtPlaylistBtn = $('#import-yt-playlist-btn');
const ytPlaylistModal = $('#yt-playlist-import-modal');
const ytPlaylistModalClose = $('#yt-playlist-modal-close');
const ytPlaylistFetchBtn = $('#yt-playlist-fetch-btn');
const ytPlaylistUrlInput = $('#yt-playlist-url-input');
const ytPlFetchLoading = $('#yt-pl-fetch-loading');
const ytPlStepUrl = $('#yt-pl-step-url');
const ytPlStepPreview = $('#yt-pl-step-preview');
const ytPlBackBtn = $('#yt-pl-back-btn');
const ytPlImportStreamBtn = $('#yt-pl-import-stream-btn');

function resetYtPlaylistModal() {
  _currentFetchedPlaylist = null;
  if (ytPlaylistUrlInput) ytPlaylistUrlInput.value = '';
  if (ytPlStepUrl) ytPlStepUrl.classList.remove('hidden');
  if (ytPlStepPreview) ytPlStepPreview.classList.add('hidden');
  if (ytPlFetchLoading) ytPlFetchLoading.classList.add('hidden');
  if (ytPlaylistFetchBtn) ytPlaylistFetchBtn.disabled = false;
}

if (importYtPlaylistBtn && ytPlaylistModal) {
  importYtPlaylistBtn.addEventListener('click', () => {
    resetYtPlaylistModal();
    ytPlaylistModal.showModal();
  });

  ytPlaylistModalClose?.addEventListener('click', () => {
    ytPlaylistModal.close();
  });

  ytPlBackBtn?.addEventListener('click', () => {
    ytPlStepPreview?.classList.add('hidden');
    ytPlStepUrl?.classList.remove('hidden');
  });

  ytPlaylistFetchBtn?.addEventListener('click', async () => {
    const url = (ytPlaylistUrlInput?.value || '').trim();
    if (!url) {
      notify('Please enter a YouTube playlist URL.');
      return;
    }

    ytPlFetchLoading?.classList.remove('hidden');
    ytPlaylistFetchBtn.disabled = true;

    try {
      const res = await api('/api/youtube/playlist-info', {
        method: 'POST',
        body: JSON.stringify({ url })
      });

      ytPlFetchLoading?.classList.add('hidden');
      ytPlaylistFetchBtn.disabled = false;

      if (!res || res.status !== 'success' || !res.playlist) {
        notify(res?.error || 'Could not fetch playlist. Please check the URL.');
        return;
      }

      _currentFetchedPlaylist = res.playlist;
      renderYtPlaylistPreview(res.playlist);
    } catch (err) {
      console.error('Playlist fetch error:', err);
      ytPlFetchLoading?.classList.add('hidden');
      ytPlaylistFetchBtn.disabled = false;
      notify('Failed to connect to server. Check URL.');
    }
  });

  ytPlImportStreamBtn?.addEventListener('click', async () => {
    if (!_currentFetchedPlaylist || !_currentFetchedPlaylist.tracks || !_currentFetchedPlaylist.tracks.length) {
      notify('No playlist tracks available to import.');
      return;
    }

    const customName = ($('#yt-pl-name-input')?.value || _currentFetchedPlaylist.title || 'Imported Playlist').trim();
    if (!customName) {
      notify('Please enter a playlist name.');
      return;
    }

    ytPlImportStreamBtn.disabled = true;
    ytPlImportStreamBtn.innerHTML = '<i class="ph-bold ph-spinner"></i> Importing...';

    try {
      const res = await api('/api/youtube/playlist-import', {
        method: 'POST',
        body: JSON.stringify({
          name: customName,
          tracks: _currentFetchedPlaylist.tracks,
          action: 'stream'
        })
      });

      if (res && res.status === 'success') {
        // Cache tracks locally so trackById resolves them
        if (!state.online_tracks_cache) state.online_tracks_cache = {};
        _currentFetchedPlaylist.tracks.forEach(t => {
          state.online_tracks_cache[t.id] = t;
        });
        try {
          localStorage.setItem('linus_online_tracks_cache', JSON.stringify(state.online_tracks_cache));
        } catch (e) {}

        if (!state.playlists) state.playlists = {};
        state.playlists[customName] = _currentFetchedPlaylist.tracks.map(t => t.id);

        ytPlaylistModal.close();
        notify(`✨ Successfully imported "${customName}" (${res.track_count} tracks)!`);
        renderPlaylists();
        openPlaylistDetail(customName);
      } else {
        notify(res?.error || 'Import failed.');
      }
    } catch (err) {
      console.error('Playlist import error:', err);
      notify('Import failed. Please try again.');
    } finally {
      ytPlImportStreamBtn.disabled = false;
      ytPlImportStreamBtn.innerHTML = '<i class="ph-bold ph-lightning"></i> Import & Stream Now';
    }
  });
}

function renderYtPlaylistPreview(playlist) {
  if (!playlist) return;
  ytPlStepUrl?.classList.add('hidden');
  ytPlStepPreview?.classList.remove('hidden');

  const nameInput = $('#yt-pl-name-input');
  if (nameInput) nameInput.value = playlist.title || 'YouTube Playlist';

  const thumbImg = $('#yt-pl-preview-thumb');
  if (thumbImg) thumbImg.src = playlist.thumbnail || (playlist.tracks[0]?.artwork_url || '');

  const uploaderLabel = $('#yt-pl-uploader-label');
  if (uploaderLabel) uploaderLabel.textContent = playlist.uploader || 'YouTube';

  const countBadge = $('#yt-pl-count-badge');
  if (countBadge) countBadge.textContent = `${playlist.count} tracks`;

  const totalSecs = playlist.tracks.reduce((acc, t) => acc + (t.duration || 0), 0);
  const durLabel = $('#yt-pl-preview-duration');
  if (durLabel) durLabel.textContent = totalSecs > 0 ? `${Math.round(totalSecs / 60)} min` : `${playlist.count} songs`;

  const listContainer = $('#yt-pl-tracks-preview-list');
  if (listContainer) {
    listContainer.innerHTML = playlist.tracks.map((t, idx) => `
      <div class="yt-pl-preview-row">
        <span style="font-size:11px;width:18px;color:var(--text-muted);text-align:center;">${idx + 1}</span>
        <img src="${escapeHtml(t.artwork_url || '')}" alt="" loading="lazy">
        <div class="yt-pl-row-meta">
          <strong title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</strong>
          <span>${escapeHtml(t.artist)}</span>
        </div>
        <span class="yt-pl-row-dur">${t.duration > 0 ? formatTime(t.duration) : ''}</span>
      </div>
    `).join('');
  }
}

// Add to Playlist modal
let trackToAddId = null;
function openAddToPlaylistModal(trackId) {
  const track = trackById(trackId);
  if (!track) return;
  trackToAddId = trackId;
  $('#add-to-playlist-track-name').textContent = `Add "${track.title}" to:`;
  
  const list = $('#playlist-select-list');
  const pKeys = Object.keys(state.playlists || {});
  
  if (!pKeys.length) {
    list.innerHTML = `<p class="muted" style="font-size:13px;padding:10px 0;">No playlists yet. Create one below!</p>`;
  } else {
    list.innerHTML = pKeys.map(name => {
      const alreadyIn = (state.playlists[name] || []).includes(trackId);
      return `
        <button class="playlist-select-item" data-name="${escapeHtml(name)}">
          <strong>${escapeHtml(name)}</strong>
          <span>${alreadyIn ? '<i class="ph-fill ph-check" style="color:var(--accent);margin-right:4px;"></i> Added' : '+ Add'}</span>
        </button>
      `;
    }).join('');

    list.querySelectorAll('.playlist-select-item').forEach(item => {
      item.addEventListener('click', () => {
        const pName = item.dataset.name;
        if (!state.playlists[pName]) state.playlists[pName] = [];
        if (!state.playlists[pName].includes(trackToAddId)) {
          state.playlists[pName].push(trackToAddId);
          saveState();
          notify(`Added "${track.title}" to "${pName}"!`);
        } else {
          notify(`"${track.title}" is already in "${pName}".`);
        }
        $('#add-to-playlist-sheet').close();
      });
    });
  }

  $('#add-to-playlist-sheet').showModal();
}

$('#add-to-playlist-close')?.addEventListener('click', () => $('#add-to-playlist-sheet').close());
$('#add-to-playlist-cancel')?.addEventListener('click', () => $('#add-to-playlist-sheet').close());
$('#open-new-from-add-btn')?.addEventListener('click', () => {
  $('#add-to-playlist-sheet').close();
  $('#playlist-name-input').value = '';
  $('#playlist-create-sheet').showModal();
});

// ---- renderContinueRail: kept as no-op for backwards compat (superseded by rec-dashboard) ----
function renderContinueRail() {
  // The old rail is now replaced by the full recommendation dashboard.
  // Kept here to avoid any lingering references breaking.
}

// ============================================================
// Recommendation Dashboard — Spotify / YouTube Music Style
// Loads from /api/recommend/dashboard, renders all shelves.
// ============================================================

let _recDashboardLoaded = false;
let _recDashboardLoading = false;
let _recCurrentlyPlayingId = null;

/** Returns time-of-day greeting string */
function getRecGreeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good Morning';
  if (h >= 12 && h < 17) return 'Good Afternoon';
  if (h >= 17 && h < 22) return 'Good Evening';
  return 'Good Night';
}

/** Deterministic gradient index from a string (for cards without artwork) */
function recGradIndex(str) {
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 10;
}

/**
 * Builds a single recommendation card DOM element.
 * @param {Object} track   - Track data object
 * @param {boolean} wide   - If true, renders a wide landscape card (for Trending)
 */
function renderRecCard(track, wide = false) {
  const isYT = !!(track.is_online || (track.id && track.id.startsWith('yt:')));
  const vid = track.video_id || (track.id || '').replace('yt:', '');
  const thumb = track.artwork_url || (isYT && vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '');
  const gradIdx = recGradIndex((track.id || '') + (track.title || ''));
  const gradClass = `rec-card-grad-${gradIdx}`;
  const resumePos = track._resume_pos;
  const dur = track.duration || 0;
  const isPlaying = _recCurrentlyPlayingId && track.id === _recCurrentlyPlayingId;

  // First letter of title for gradient fallback
  const letter = (track.title || '?').trim().charAt(0).toUpperCase();

  const thumbClass = wide ? 'rec-card-thumb rec-card-thumb-wide' : 'rec-card-thumb';

  const thumbInner = thumb
    ? `<img src="${escapeHtml(thumb)}" alt="Art" loading="lazy" onerror="this.parentNode.innerHTML='<div class=\\'rec-card-thumb-fallback ${gradClass}\\'><span class=\\'rec-card-fallback-letter\\'>${escapeHtml(letter)}</span></div>'">`
    : `<div class="rec-card-thumb-fallback ${gradClass}"><span class="rec-card-fallback-letter">${escapeHtml(letter)}</span></div>`;

  const srcBadge = isYT
    ? `<span class="rec-card-src-badge rec-card-src-yt">YT</span>`
    : `<span class="rec-card-src-badge rec-card-src-local">Local</span>`;

  const resumeHtml = (resumePos && dur > 30)
    ? `<span class="rec-card-resume">▶ ${formatTime(resumePos)}</span>` : '';

  const div = document.createElement('div');
  div.className = `rec-card${wide ? ' rec-card-wide' : ''}${isPlaying ? ' now-playing' : ''}`;
  div.dataset.id = track.id;
  div.dataset.isYt = isYT ? '1' : '0';
  div.dataset.vid = vid || '';
  div.dataset.title = track.title || '';
  div.dataset.artist = track.artist || '';
  div.dataset.thumb = thumb || '';
  div.dataset.dur = dur || '';

  const pillHtml = isYT
    ? `<span class="rec-card-pill yt"><i class="ph-fill ph-youtube-logo"></i> YT</span>`
    : `<span class="rec-card-pill local">Local</span>`;

  if (wide) {
    // Landscape card — Thumbnail left, info middle with pill tag
    div.innerHTML = `
      <div class="${thumbClass}">
        ${thumbInner}
        <button class="rec-card-preview-btn" title="Quick 20s Preview" aria-label="20s Preview"><i class="ph-bold ph-speaker-simple-high"></i></button>
        <div class="rec-card-play-btn"><i class="ph-fill ph-play"></i></div>
        <button class="rec-card-radio-btn" title="Start Radio from this track" aria-label="Start Radio"><i class="ph-bold ph-radio"></i></button>
        <button class="rec-card-dislike-btn" title="Not interested in this song" aria-label="Not interested"><i class="ph ph-thumbs-down"></i></button>
      </div>
      <div class="rec-card-info">
        <span class="rec-card-title" title="${escapeHtml(track.title || '')}">${escapeHtml(track.title || 'Unknown')}</span>
        <span class="rec-card-artist">${escapeHtml(track.artist || '')}</span>
        ${pillHtml}
      </div>
    `;
  } else {
    // Square card — Mockup layout: Art with centered gold play circle, Title, Artist, Pill tag
    div.innerHTML = `
      <div class="${thumbClass}">
        ${thumbInner}
        <button class="rec-card-preview-btn" title="Quick 20s Preview" aria-label="20s Preview"><i class="ph-bold ph-speaker-simple-high"></i></button>
        <div class="rec-card-play-btn"><i class="ph-fill ph-play"></i></div>
        <button class="rec-card-radio-btn" title="Start Radio from this track" aria-label="Start Radio"><i class="ph-bold ph-radio"></i></button>
        <button class="rec-card-dislike-btn" title="Not interested in this song" aria-label="Not interested"><i class="ph ph-thumbs-down"></i></button>
      </div>
      <div class="rec-card-info">
        <span class="rec-card-title" title="${escapeHtml(track.title || '')}">${escapeHtml(track.title || 'Unknown')}</span>
        <span class="rec-card-artist">${escapeHtml(track.artist || '')}</span>
        ${pillHtml}
      </div>
    `;
  }

  const previewBtn = div.querySelector('.rec-card-preview-btn');
  if (previewBtn) {
    previewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleTrackAudioPreview(div, previewBtn);
    });
  }

  const radioBtn = div.querySelector('.rec-card-radio-btn');
  if (radioBtn) {
    radioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startTrackRadio(track);
    });
  }

  const dislikeBtn = div.querySelector('.rec-card-dislike-btn');
  if (dislikeBtn) {
    dislikeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      div.style.transition = 'all 0.3s ease';
      div.style.opacity = '0';
      div.style.transform = 'scale(0.8)';
      setTimeout(() => div.remove(), 300);
      notify(`Removed "${(track.title || 'Track').slice(0, 25)}" from recommendations`);
      try {
        await api('/api/recommend/dislike', {
          method: 'POST',
          body: JSON.stringify({ track_id: track.id, session_id: typeof _userSessionId !== 'undefined' ? _userSessionId : '', context_source: 'dashboard' })
        });
      } catch (err) {}
    });
  }

  div.addEventListener('click', (e) => {
    if (e.target.closest('button, .rec-card-preview-btn, .rec-card-radio-btn, .rec-card-dislike-btn')) return;
    if (isYT && vid) {
      streamYouTubeAudio(vid, track.title, track.artist, thumb, dur);
    } else if (track.id) {
      playById(track.id);
    }
    document.querySelectorAll('.rec-card').forEach(c => c.classList.remove('now-playing'));
    div.classList.add('now-playing');
    _recCurrentlyPlayingId = track.id;
  });

  return div;
}

/**
 * Renders a single recommendation shelf.
 * Uses wide cards for the "trending" shelf (YouTube-style landscape layout).
 */
function renderRecShelf(section) {
  if (section.id === 'capsules') return; // Handled by renderDailyCapsules
  const shelfEl = document.getElementById(`shelf-${section.id}`);
  const cardsEl = document.getElementById(`cards-${section.id}`);
  if (!shelfEl || !cardsEl) return;

  if (!section.tracks || section.tracks.length === 0) {
    cardsEl.innerHTML = '';
    shelfEl.style.display = 'none';
    return;
  }

  // Trending uses wide landscape cards
  const useWide = section.id === 'trending';

  cardsEl.innerHTML = '';
  section.tracks.forEach(track => {
    if (!track) return;
    cardsEl.appendChild(renderRecCard(track, useWide));
  });

  // Only show if cards were actually added AND matches current mood filter
  if (cardsEl.children.length > 0) {
    const activeChip = document.querySelector('.mood-chip.active');
    const activeMood = activeChip ? (activeChip.dataset.mood || 'all') : 'all';
    const shelfMoods = (shelfEl.dataset.moods || 'all').split(',');

    if (activeMood === 'all' || shelfMoods.includes(activeMood)) {
      shelfEl.style.display = 'block';
    } else {
      shelfEl.style.display = 'none';
    }
  } else {
    shelfEl.style.display = 'none';
  }
}



/** Renders the 6-item Quick Launchpad directly below greeting */
function renderQuickLaunchGrid(items) {
  const container = document.getElementById('rec-quick-grid');
  if (!container) return;

  if (!items || items.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = items.map(item => {
    const artHtml = item.artwork_url
      ? `<img src="${escapeHtml(item.artwork_url)}" alt="Art" loading="lazy" onerror="this.style.display='none';this.parentNode.innerHTML='<i class=\\'${item.icon || 'ph-fill ph-music-note'}\\'></i>'">`
      : `<i class="${item.icon || 'ph-fill ph-music-note'}"></i>`;

    const bgGradient = item.gradient || 'linear-gradient(135deg, rgba(229, 169, 93, 0.4), rgba(0,0,0,0.6))';

    return `
      <div class="quick-card" data-id="${escapeHtml(item.id)}" data-type="${escapeHtml(item.type)}" data-title="${escapeHtml(item.title)}" data-artist="${escapeHtml(item.artist || '')}">
        <div class="quick-card-art" style="background:${bgGradient}">
          ${artHtml}
        </div>
        <div class="quick-card-info">
          <span class="quick-card-title">${escapeHtml(item.title)}</span>
          <span class="quick-card-sub">${escapeHtml(item.subtitle || '')}</span>
        </div>
        <button class="quick-play-btn" title="Play ${escapeHtml(item.title)}" aria-label="Play">
          <i class="ph-fill ph-play"></i>
        </button>
      </div>
    `;
  }).join('');

  // Wire click events
  container.querySelectorAll('.quick-card').forEach((card, idx) => {
    const item = items[idx];
    card.addEventListener('click', async () => {
      if (item.tracks && item.tracks.length > 0) {
        queue = [...item.tracks];
        currentIndex = 0;
        const first = queue[0];
        if (first.is_online || (first.id && first.id.startsWith('yt:'))) {
          const vid = first.video_id || first.id.replace('yt:', '');
          streamYouTubeAudio(vid, first.title, first.artist, first.artwork_url, first.duration || 0);
        } else {
          playById(first.id);
        }
        renderQueue();
        notify(`▶ Playing ${item.title}`);
      } else if (item.type === 'artist_radio' && item.artist) {
        notify(`⚡ Starting ${item.artist} Radio...`);
        try {
          const res = await api('/api/recommend/batch', {
            method: 'POST',
            body: JSON.stringify({ mode: 'online', artist: item.artist, title: item.title, count: 25 })
          });
          if (res.tracks && res.tracks.length > 0) {
            queue = [...res.tracks];
            currentIndex = 0;
            const first = queue[0];
            const vid = first.video_id || (first.id || '').replace('yt:', '');
            streamYouTubeAudio(vid, first.title, first.artist, first.artwork_url, first.duration || 0);
            renderQueue();
          }
        } catch (e) {
          notify(`Failed to start ${item.artist} Radio`);
        }
      } else if (item.type === 'mood' || item.type === 'trending') {
        const moodSection = document.getElementById('shelf-mood') || document.getElementById('shelf-trending');
        if (moodSection) {
          moodSection.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  });
}

/** Renders the Daily Mix Capsules */
function renderDailyCapsules(capsules) {
  const container = document.getElementById('cards-capsules');
  const shelf = document.getElementById('shelf-capsules');
  if (!container || !shelf) return;

  if (!capsules || capsules.length === 0) {
    shelf.style.display = 'none';
    return;
  }

  container.innerHTML = capsules.map(cap => {
    return `
      <div class="capsule-card" data-id="${escapeHtml(cap.id)}" data-mood="${escapeHtml(cap.mood_tag || 'all')}">
        <div class="capsule-card-banner" style="background:${cap.gradient}">
          <span class="capsule-badge-pill">${escapeHtml(cap.vibe || 'Daily Mix')}</span>
          <h4 class="capsule-banner-title">${escapeHtml(cap.title)}</h4>
          <i class="${cap.icon || 'ph-fill ph-sparkle'} capsule-banner-icon"></i>
        </div>
        <div class="capsule-card-bottom">
          <div class="capsule-card-meta">
            <span class="capsule-card-title">${escapeHtml(cap.title)}</span>
            <span class="capsule-card-sub">${escapeHtml(cap.subtitle || '')}</span>
          </div>
          <button class="capsule-play-circle" title="Play ${escapeHtml(cap.title)}" aria-label="Play">
            <i class="ph-fill ph-play"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.capsule-card').forEach((card, idx) => {
    const cap = capsules[idx];
    card.addEventListener('click', () => {
      if (cap.tracks && cap.tracks.length > 0) {
        queue = [...cap.tracks];
        currentIndex = 0;
        const first = queue[0];
        if (first.is_online || (first.id && first.id.startsWith('yt:'))) {
          const vid = first.video_id || first.id.replace('yt:', '');
          streamYouTubeAudio(vid, first.title, first.artist, first.artwork_url, first.duration || 0);
        } else {
          playById(first.id);
        }
        renderQueue();
        notify(`✨ Playing ${cap.title} (${cap.vibe})`);
      }
    });
  });

  shelf.style.display = 'block';
}

/** Renders the Sonic DNA Profile card */
function renderSonicDnaCard(tasteSummary, topArtist) {
  const container = document.getElementById('sonic-dna-card');
  const shelf = document.getElementById('shelf-sonic-dna');
  if (!container || !shelf) return;

  if (!tasteSummary) {
    shelf.style.display = 'none';
    return;
  }

  const streak = tasteSummary.listening_streak_days || 1;
  const hours = tasteSummary.total_listen_hours || 0.0;
  const vibe = tasteSummary.sonic_vibe_badge || '✨ Serene Music Voyager';
  const genres = tasteSummary.top_genres_breakdown || [];

  // New analytics
  const weeklyPlays = tasteSummary.weekly_plays || 0;
  const peakHour = tasteSummary.peak_hour_label || '';
  const avgSession = tasteSummary.avg_session_minutes || 0;
  const discoveryScore = tasteSummary.discovery_score || 0;
  const skipRate = tasteSummary.skip_rate_overall || 0;
  const artistsDetail = tasteSummary.top_artists_detail || [];

  const streakValEl = document.getElementById('streak-days-val');
  if (streakValEl) streakValEl.textContent = streak;

  const genresHtml = genres.length > 0
    ? genres.map(g => `
        <div class="sonic-meter-row">
          <div class="sonic-meter-meta">
            <span class="sonic-meter-name">${escapeHtml(g.name)}</span>
            <span class="sonic-meter-percent">${g.percent}%</span>
          </div>
          <div class="sonic-meter-track">
            <div class="sonic-meter-fill" style="width:${Math.max(8, g.percent)}%"></div>
          </div>
        </div>
      `).join('')
    : `
      <div class="sonic-meter-row">
        <div class="sonic-meter-meta">
          <span class="sonic-meter-name">Discovery &amp; Chill</span>
          <span class="sonic-meter-percent">100%</span>
        </div>
        <div class="sonic-meter-track">
          <div class="sonic-meter-fill" style="width:100%"></div>
        </div>
      </div>
    `;

  // Top Artists Detail panel
  const artistDetailHtml = artistsDetail.length > 0 ? `
    <div class="sonic-artists-detail">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.45);font-weight:600;margin-bottom:8px;">Your Top Artists</div>
      ${artistsDetail.map((a, i) => `
        <div class="sonic-artist-row">
          <span class="sonic-artist-rank">#${i + 1}</span>
          <span class="sonic-artist-name" title="${escapeHtml(a.name)}">${escapeHtml((a.name || '').slice(0, 20))}</span>
          <span class="sonic-artist-plays">${a.play_count} plays</span>
          <span class="sonic-artist-comp" title="Avg completion">${a.completion_rate}%</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  // Listening Insights row
  const insightsHtml = `
    <div class="sonic-insights-row">
      ${weeklyPlays > 0 ? `<div class="sonic-insight-chip">📅 ${weeklyPlays} plays this week</div>` : ''}
      ${peakHour ? `<div class="sonic-insight-chip">🕐 Peak: ${escapeHtml(peakHour)}</div>` : ''}
      ${avgSession > 0 ? `<div class="sonic-insight-chip">⏱ ${avgSession}min sessions</div>` : ''}
      ${discoveryScore > 0 ? `<div class="sonic-insight-chip">🔭 ${discoveryScore}% explored</div>` : ''}
      ${skipRate > 0 ? `<div class="sonic-insight-chip ${skipRate < 20 ? 'chip-good' : skipRate < 50 ? 'chip-mid' : 'chip-warn'}">⏭ ${skipRate}% skip rate</div>` : ''}
    </div>
  `;

  container.innerHTML = `
    <div class="sonic-dna-left">
      <span class="sonic-dna-vibe-pill">
        <i class="ph-fill ph-sparkle"></i> ${escapeHtml(vibe)}
      </span>
      <h3 class="sonic-dna-title">Your Sonic Identity</h3>
      <div class="sonic-dna-stats-row">
        <div class="sonic-stat-item">
          <span class="sonic-stat-val">🔥 ${streak}</span>
          <span class="sonic-stat-label">Day Streak</span>
        </div>
        <div class="sonic-stat-item">
          <span class="sonic-stat-val">⏳ ${hours}h</span>
          <span class="sonic-stat-label">Total Listened</span>
        </div>
        ${topArtist ? `
        <div class="sonic-stat-item">
          <span class="sonic-stat-val" title="${escapeHtml(topArtist)}">${escapeHtml(topArtist.slice(0, 12))}</span>
          <span class="sonic-stat-label">Top Artist</span>
        </div>` : ''}
      </div>
      ${insightsHtml}
      ${artistDetailHtml}
    </div>
    <div class="sonic-dna-right">
      <div style="font-size:11.5px;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.45);font-weight:600;margin-bottom:4px;">Top Soundscapes</div>
      ${genresHtml}
    </div>
  `;

  shelf.style.display = 'block';
}

// ============================================================================
// 📅 Feature 6: Weekly Sound Rewind & Persona Summary Engine
// ============================================================================
let _lastRewindData = null;

async function openWeeklyRewindModal() {
  const modal = document.getElementById('weekly-rewind-modal');
  if (!modal) return;

  const spinner = document.getElementById('rewind-loading-spinner');
  const container = document.getElementById('rewind-loaded-container');
  if (spinner) spinner.style.display = 'flex';
  if (container) container.classList.add('hidden');

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }

  try {
    const res = await api('/api/rewind/weekly');
    if (!res || res.status !== 'success') throw new Error(res?.error || 'Failed to fetch rewind data');

    _lastRewindData = res;
    renderWeeklyRewindModal(res);

    if (spinner) spinner.style.display = 'none';
    if (container) container.classList.remove('hidden');
  } catch (err) {
    console.error('Weekly rewind fetch error:', err);
    notify('⚠️ Unable to load weekly sound rewind.');
    if (spinner) spinner.innerHTML = `<p style="color:#ff6b6b;margin-top:12px;">Failed to load rewind stats.</p>`;
  }
}

function closeWeeklyRewindModal() {
  const modal = document.getElementById('weekly-rewind-modal');
  if (!modal) return;
  if (typeof modal.close === 'function') {
    modal.close();
  } else {
    modal.removeAttribute('open');
  }
}

function renderWeeklyRewindModal(data) {
  const timeframeEl = document.getElementById('rewind-modal-timeframe');
  if (timeframeEl) timeframeEl.textContent = `Weekly Sound Rewind (${data.timeframe || 'Last 7 Days'})`;

  // 1. Persona
  const persona = data.persona || {};
  const emojiEl = document.getElementById('rewind-persona-emoji');
  const titleEl = document.getElementById('rewind-persona-title');
  const mottoEl = document.getElementById('rewind-persona-motto');
  const traitsEl = document.getElementById('rewind-persona-traits');
  const cardEl = document.getElementById('rewind-persona-card');
  const glowEl = document.getElementById('rewind-persona-glow');

  if (emojiEl) emojiEl.textContent = persona.emoji || '✨';
  if (titleEl) titleEl.textContent = persona.title || 'The Melodic Soul';
  if (mottoEl) mottoEl.textContent = persona.motto || 'Curating moments with perfect rhythm and harmony.';

  if (cardEl && persona.color) {
    cardEl.style.borderColor = persona.color;
  }
  if (glowEl && persona.glow) {
    glowEl.style.background = `radial-gradient(circle, ${persona.glow} 0%, transparent 70%)`;
  }

  if (traitsEl && Array.isArray(persona.traits)) {
    traitsEl.innerHTML = persona.traits.map(t => `<span class="rewind-trait-chip">${escapeHtml(t)}</span>`).join('');
  }

  // 2. Stats
  const timeEl = document.getElementById('rewind-stat-time');
  const playsEl = document.getElementById('rewind-stat-plays');
  const daysEl = document.getElementById('rewind-stat-days');
  const peakEl = document.getElementById('rewind-stat-peak');

  if (timeEl) timeEl.textContent = data.total_time_formatted || `${data.total_minutes || 0}m`;
  if (playsEl) playsEl.textContent = data.completed_plays || 0;
  if (daysEl) daysEl.textContent = `${data.active_days || 1} / 7 Days`;
  if (peakEl) peakEl.textContent = `${data.peak_day || 'Weekend'} · ${data.peak_hour || 'Evening'}`;

  // 3. Top Genre & Tracks
  const genreSubEl = document.getElementById('rewind-genre-sub');
  if (genreSubEl) genreSubEl.textContent = `Top Soundscape: ${data.top_genre || 'Pop'}`;

  const listEl = document.getElementById('rewind-tracks-list');
  if (listEl) {
    const tracks = data.top_tracks || [];
    if (tracks.length === 0) {
      listEl.innerHTML = `<p style="font-size:12px;color:var(--text-muted);text-align:center;padding:12px;">No tracks recorded this week yet. Start playing music!</p>`;
    } else {
      listEl.innerHTML = tracks.map((t, idx) => {
        const thumb = t.artwork_url || '';
        const thumbHtml = thumb
          ? `<img src="${escapeHtml(thumb)}" alt="Art" class="rewind-track-thumb" onerror="this.style.display='none'">`
          : `<div class="rewind-track-thumb" style="display:grid;place-items:center;color:#e5a95d;"><i class="ph-fill ph-music-note"></i></div>`;

        return `
          <div class="rewind-track-row" data-id="${escapeHtml(t.id)}" data-idx="${idx}">
            <span class="rewind-track-rank">#${idx + 1}</span>
            ${thumbHtml}
            <div class="rewind-track-meta">
              <span class="rewind-track-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
              <span class="rewind-track-artist">${escapeHtml(t.artist)}</span>
            </div>
            <span class="rewind-track-badge">${t.play_count} plays</span>
            <button class="rewind-track-play-btn" title="Play track"><i class="ph-fill ph-play"></i></button>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.rewind-track-row').forEach(row => {
        row.addEventListener('click', () => {
          const tid = row.dataset.id;
          if (tid) {
            playById(tid);
            closeWeeklyRewindModal();
            notify(`▶ Playing #${parseInt(row.dataset.idx) + 1} from your Weekly Rewind`);
          }
        });
      });
    }
  }
}

function initWeeklyRewind() {
  const openBtn = document.getElementById('open-weekly-rewind-btn');
  if (openBtn) {
    openBtn.addEventListener('click', openWeeklyRewindModal);
  }

  const closeBtn = document.getElementById('rewind-modal-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeWeeklyRewindModal);
  }

  const modal = document.getElementById('weekly-rewind-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeWeeklyRewindModal();
    });
  }

  // Play Weekly Mix
  const playMixBtn = document.getElementById('rewind-play-mix-btn');
  if (playMixBtn) {
    playMixBtn.addEventListener('click', () => {
      if (!_lastRewindData || !_lastRewindData.top_tracks || !_lastRewindData.top_tracks.length) {
        notify('No tracks found in Weekly Rewind.');
        return;
      }
      const topTracks = _lastRewindData.top_tracks;
      queue = [...topTracks];
      currentIndex = 0;
      renderQueue();
      playById(topTracks[0].id);
      closeWeeklyRewindModal();
      notify(`▶ Streaming your Weekly Top ${topTracks.length} Mix!`);
    });
  }

  // Share Summary (Copy to clipboard)
  const copyBtn = document.getElementById('rewind-copy-summary-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!_lastRewindData) return;
      const d = _lastRewindData;
      const persona = d.persona || {};
      const topSong = d.top_tracks && d.top_tracks[0] ? `${d.top_tracks[0].title} — ${d.top_tracks[0].artist}` : 'None';

      const text = [
        `🎵 My Linus Weekly Sound Rewind (${d.timeframe || 'This Week'})`,
        `✨ Musical Persona: ${persona.emoji || '✨'} ${persona.title || 'The Melodic Soul'}`,
        `💬 "${persona.motto || ''}"`,
        `🎧 ${d.total_time_formatted || (d.total_minutes + ' mins')} across ${d.completed_plays || 0} tracks`,
        `🏆 Top Song: ${topSong}`,
        `⏰ Peak Listening: ${d.peak_day || 'Friday'} · ${d.peak_hour || 'Evening'}`
      ].join('\n');

      try {
        await navigator.clipboard.writeText(text);
        notify('📋 Weekly Sound Rewind copied to clipboard!');
      } catch (err) {
        notify('⚠️ Could not copy to clipboard.');
      }
    });
  }
}

// ============================================================================
// 🔥 Feature 8: Daily Listening Streak & Music Calendar Heatmap Engine
// ============================================================================
let _lastHeatmapData = null;
let _heatmapTooltipEl = null;

function ensureHeatmapTooltip() {
  if (!_heatmapTooltipEl) {
    _heatmapTooltipEl = document.createElement('div');
    _heatmapTooltipEl.className = 'heatmap-tooltip';
    _heatmapTooltipEl.id = 'heatmap-interactive-tooltip';
    document.body.appendChild(_heatmapTooltipEl);
  }
  return _heatmapTooltipEl;
}

async function loadStreakHeatmap(forceRefresh = false) {
  const container = document.getElementById('streak-heatmap-card');
  const shelf = document.getElementById('shelf-streak-heatmap');
  if (!container || !shelf) return;

  try {
    const res = await api('/api/user/streak-heatmap');
    if (!res || res.status !== 'success') {
      console.warn('[StreakHeatmap] Failed to fetch streak heatmap data:', res);
      return;
    }
    _lastHeatmapData = res;
    renderStreakHeatmap(res);
  } catch (err) {
    console.error('[StreakHeatmap] Error loading streak heatmap:', err);
  }
}

function renderStreakHeatmap(data) {
  const container = document.getElementById('streak-heatmap-card');
  const shelf = document.getElementById('shelf-streak-heatmap');
  if (!container || !shelf || !data) return;

  const currentStreak = data.current_streak || 0;
  const longestStreak = data.longest_streak || 0;
  const streakStatus = data.streak_status || 'inactive';
  const streakMsg = data.streak_message || 'Play a track today to ignite your streak!';
  const activeDays = data.total_active_days || 0;
  const totalHours = data.total_hours || 0.0;
  const totalPlays = data.total_plays || 0;
  const milestone = data.milestone || { name: '3-Day Spark', target: 3, progress_percent: 0, days_left: 3 };

  // Sync with top hero streak counter badge
  const streakValEl = document.getElementById('streak-days-val');
  if (streakValEl) streakValEl.textContent = currentStreak;

  // Header status pill
  const headerPill = document.getElementById('streak-header-pill');
  const headerPillText = document.getElementById('streak-header-pill-text');
  if (headerPill && headerPillText) {
    headerPill.className = `streak-header-pill status-${streakStatus}`;
    if (streakStatus === 'active_today') {
      headerPillText.textContent = `${currentStreak} Day Streak · Active Today`;
    } else if (streakStatus === 'at_risk') {
      headerPillText.textContent = `${currentStreak} Day Streak · At Risk`;
    } else {
      headerPillText.textContent = `Streak Inactive · Ready to Ignite`;
    }
  }

  // Build Month Labels HTML
  const monthLabels = data.month_labels || [];
  let monthsHtml = '';
  monthLabels.forEach(m => {
    const leftPx = (m.col_index * 18);
    monthsHtml += `<span class="heatmap-month-tag" style="left:${leftPx}px">${escapeHtml(m.name)}</span>`;
  });

  // Build Weeks & Days Grid
  const weeks = data.weeks || [];
  let weeksHtml = '';
  weeks.forEach(col => {
    let daysHtml = '';
    col.forEach(day => {
      const isFuture = day.is_future;
      const level = day.level;
      const levelClass = isFuture ? 'level-future' : `level-${level}`;
      const todayClass = day.is_today ? 'is-today' : '';
      daysHtml += `
        <div class="heatmap-cell ${levelClass} ${todayClass}"
             data-date="${escapeHtml(day.date)}"
             data-formatted-date="${escapeHtml(day.formatted_date)}"
             data-minutes="${day.minutes}"
             data-plays="${day.play_count}"
             data-level="${level}"
             data-future="${isFuture ? '1' : '0'}"
             data-today="${day.is_today ? '1' : '0'}">
        </div>
      `;
    });
    weeksHtml += `<div class="heatmap-week-column">${daysHtml}</div>`;
  });

  // Status icon
  let bannerIcon = 'ph-sparkle';
  if (streakStatus === 'active_today') bannerIcon = 'ph-fire';
  else if (streakStatus === 'at_risk') bannerIcon = 'ph-warning-circle';

  container.innerHTML = `
    <!-- Top Metrics Row -->
    <div class="streak-metrics-grid">
      <div class="streak-metric-box streak-metric-hero">
        <span class="streak-metric-label"><i class="ph-fill ph-fire streak-fire-icon"></i> Current Streak</span>
        <span class="streak-metric-value">${currentStreak} <span style="font-size:16px;font-weight:500;">Days</span></span>
        <span class="streak-metric-sub">${streakStatus === 'active_today' ? '🔥 Safe for today' : streakStatus === 'at_risk' ? '⚠️ Ends tonight' : '✨ Start fresh'}</span>
      </div>
      <div class="streak-metric-box">
        <span class="streak-metric-label"><i class="ph-fill ph-trophy"></i> Best Record</span>
        <span class="streak-metric-value">${longestStreak} <span style="font-size:16px;font-weight:500;">Days</span></span>
        <span class="streak-metric-sub">Personal All-Time High</span>
      </div>
      <div class="streak-metric-box">
        <span class="streak-metric-label"><i class="ph-fill ph-calendar-check"></i> Active Days</span>
        <span class="streak-metric-value">${activeDays} <span style="font-size:14px;color:rgba(255,255,255,0.4);">/ 84</span></span>
        <span class="streak-metric-sub">Last 12 Weeks</span>
      </div>
      <div class="streak-metric-box">
        <span class="streak-metric-label"><i class="ph-fill ph-clock"></i> Listening Time</span>
        <span class="streak-metric-value">${totalHours}h</span>
        <span class="streak-metric-sub">${totalPlays} tracks played</span>
      </div>
    </div>

    <!-- Motivational Callout & Milestone Progress -->
    <div class="streak-banner-row">
      <div class="streak-banner-left">
        <div class="streak-banner-icon-circle">
          <i class="ph-fill ${bannerIcon}"></i>
        </div>
        <div class="streak-banner-text">
          <div class="streak-banner-title">${escapeHtml(streakMsg)}</div>
          <div class="streak-banner-desc">Playing at least 1 song per day keeps your flame burning.</div>
        </div>
      </div>
      <div class="streak-milestone-wrap">
        <div class="streak-milestone-head">
          <span>${milestone.icon || '⚡'} Next: ${escapeHtml(milestone.name)}</span>
          <span>${milestone.days_left > 0 ? `${milestone.days_left}d left` : 'Completed!'}</span>
        </div>
        <div class="streak-milestone-track">
          <div class="streak-milestone-fill" style="width:${Math.max(4, milestone.progress_percent || 0)}%;"></div>
        </div>
      </div>
    </div>

    <!-- 12-Week Heatmap Calendar Section -->
    <div class="heatmap-section">
      <div class="heatmap-scroll-container">
        <div class="heatmap-table-wrap">
          <!-- Month labels -->
          <div class="heatmap-months-row">
            ${monthsHtml}
          </div>

          <!-- Heatmap body with Weekdays and 12-Week Matrix -->
          <div class="heatmap-grid-body">
            <div class="heatmap-weekdays-col">
              <span class="heatmap-weekday-label">Mon</span>
              <span class="heatmap-weekday-label">Wed</span>
              <span class="heatmap-weekday-label">Fri</span>
              <span class="heatmap-weekday-label">Sun</span>
            </div>
            <div class="heatmap-weeks-track">
              ${weeksHtml}
            </div>
          </div>
        </div>
      </div>

      <!-- Legend & Tip Footer -->
      <div class="heatmap-footer-row">
        <span><i class="ph-bold ph-info" style="color:var(--accent);"></i> Hover or tap any day to inspect detailed listening telemetry</span>
        <div class="heatmap-legend-group">
          <span>Less</span>
          <span class="heatmap-legend-cell level-0" title="0 minutes"></span>
          <span class="heatmap-legend-cell level-1" title="1-15 minutes"></span>
          <span class="heatmap-legend-cell level-2" title="16-45 minutes"></span>
          <span class="heatmap-legend-cell level-3" title="46-90 minutes"></span>
          <span class="heatmap-legend-cell level-4" title="90+ minutes"></span>
          <span>More</span>
        </div>
      </div>
    </div>
  `;

  shelf.style.display = 'block';

  // Attach interactive tooltip handlers to cells
  const tooltip = ensureHeatmapTooltip();
  const cells = container.querySelectorAll('.heatmap-cell');

  cells.forEach(cell => {
    if (cell.dataset.future === '1') return;

    function showTooltip(e) {
      const formattedDate = cell.dataset.formattedDate || cell.dataset.date;
      const minutes = parseInt(cell.dataset.minutes || '0', 10);
      const plays = parseInt(cell.dataset.plays || '0', 10);
      const isToday = cell.dataset.today === '1';

      let timeText = '';
      if (minutes >= 60) {
        const hrs = Math.floor(minutes / 60);
        const mins = minutes % 60;
        timeText = `${hrs}h ${mins}m`;
      } else {
        timeText = `${minutes} min${minutes === 1 ? '' : 's'}`;
      }

      let tierText = 'No activity';
      if (minutes > 90) tierText = '🔥 Supercharged Day';
      else if (minutes > 45) tierText = '⚡ High Energy Session';
      else if (minutes > 15) tierText = '☕ Focused Flow';
      else if (plays > 0) tierText = '✨ Light Spark';

      tooltip.innerHTML = `
        <div class="heatmap-tooltip-date">${escapeHtml(formattedDate)} ${isToday ? '(Today)' : ''}</div>
        <div class="heatmap-tooltip-meta">
          <i class="ph-fill ${plays > 0 ? 'ph-headphones' : 'ph-moon'}"></i>
          <span>${plays > 0 ? `${timeText} · ${plays} track${plays === 1 ? '' : 's'}` : 'Quiet day'}</span>
        </div>
        <div class="heatmap-tooltip-tier">${tierText}</div>
      `;

      const rect = cell.getBoundingClientRect();
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
      tooltip.style.top = `${rect.top}px`;
      tooltip.classList.add('visible');
    }

    function hideTooltip() {
      tooltip.classList.remove('visible');
    }

    cell.addEventListener('mouseenter', showTooltip);
    cell.addEventListener('mouseleave', hideTooltip);
    cell.addEventListener('touchstart', showTooltip, { passive: true });
  });
}

function initStreakHeatmap() {
  // Click on top hero streak badge smoothly scrolls to heatmap
  const streakBadge = document.getElementById('rec-streak-badge');
  if (streakBadge && !streakBadge._boundHeatmap) {
    streakBadge._boundHeatmap = true;
    streakBadge.addEventListener('click', () => {
      const heatmapShelf = document.getElementById('shelf-streak-heatmap');
      if (heatmapShelf) {
        heatmapShelf.style.display = 'block';
        heatmapShelf.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const card = document.getElementById('streak-heatmap-card');
        if (card) {
          card.classList.add('heatmap-highlight-pulse');
          setTimeout(() => card.classList.remove('heatmap-highlight-pulse'), 1800);
        }
      }
    });
  }

  // Initial load
  loadStreakHeatmap();
}

// ============================================================================
// 🧭 Feature 9: 2D Vibe Compass / Mood Dial Engine
// ============================================================================
let _vibeTargetX = 0.0;
let _vibeTargetY = 0.0;
let _activeVibeTitle = "Sunburst & Euphoric";
let _isDraggingVibePuck = false;

function setVibeCoordinates(x, y, animate = false) {
  _vibeTargetX = Math.max(-1.0, Math.min(1.0, parseFloat(x) || 0.0));
  _vibeTargetY = Math.max(-1.0, Math.min(1.0, parseFloat(y) || 0.0));

  const puck = document.getElementById('vibe-puck');
  const coordXEl = document.getElementById('vibe-coord-x');
  const coordYEl = document.getElementById('vibe-coord-y');
  const badge = document.getElementById('vibe-compass-badge');
  const icon = document.getElementById('vibe-compass-icon');
  const title = document.getElementById('vibe-compass-title');

  // Convert (-1..1) to percentage on pad (Y=+1 is top=0%)
  const pctX = ((_vibeTargetX + 1.0) / 2.0) * 100.0;
  const pctY = ((1.0 - _vibeTargetY) / 2.0) * 100.0;

  if (puck) {
    if (animate) puck.style.transition = 'left 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';
    else puck.style.transition = 'none';

    puck.style.left = `${pctX}%`;
    puck.style.top = `${pctY}%`;
  }

  if (coordXEl) coordXEl.textContent = `V: ${_vibeTargetX >= 0 ? '+' : ''}${_vibeTargetX.toFixed(2)}`;
  if (coordYEl) coordYEl.textContent = `E: ${_vibeTargetY >= 0 ? '+' : ''}${_vibeTargetY.toFixed(2)}`;

  // Evaluate quadrant
  let qName = 'Sunburst & Euphoric';
  let qIcon = 'ph-sun';
  let qColor = '#f59e0b';

  if (_vibeTargetX >= 0.0 && _vibeTargetY >= 0.0) {
    qName = 'Sunburst & Euphoric';
    qIcon = 'ph-sun';
    qColor = '#f59e0b';
  } else if (_vibeTargetX < 0.0 && _vibeTargetY >= 0.0) {
    qName = 'Storm & Dark Voltage';
    qIcon = 'ph-lightning';
    qColor = '#a855f7';
  } else if (_vibeTargetX < 0.0 && _vibeTargetY < 0.0) {
    qName = 'Midnight & Nocturnal';
    qIcon = 'ph-moon-stars';
    qColor = '#3b82f6';
  } else {
    qName = 'Sunset & Cozy Serene';
    qIcon = 'ph-coffee';
    qColor = '#10b981';
  }

  _activeVibeTitle = qName;

  if (title) title.textContent = qName;
  if (icon) icon.className = `ph-fill ${qIcon}`;
  if (badge) {
    badge.style.borderColor = `${qColor}88`;
    badge.style.boxShadow = `0 2px 10px ${qColor}33`;
  }
  if (puck) {
    puck.style.setProperty('--vibe-glow', qColor);
  }

  // Update active preset chip
  document.querySelectorAll('.vibe-preset-chip').forEach(chip => {
    const cx = parseFloat(chip.dataset.x);
    const cy = parseFloat(chip.dataset.y);
    const dist = Math.hypot(cx - _vibeTargetX, cy - _vibeTargetY);
    if (dist < 0.15) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

function initVibeCompass() {
  const pad = document.getElementById('vibe-radar-pad');
  const tabQueue = document.getElementById('tab-up-next-queue');
  const tabVibe = document.getElementById('tab-up-next-vibe');
  const listQueue = document.getElementById('hero-up-next-list');
  const viewVibe = document.getElementById('hero-vibe-compass-view');

  if (!pad) return;

  // Segmented Tabs Switcher
  if (tabQueue && tabVibe && listQueue && viewVibe) {
    tabQueue.addEventListener('click', () => {
      tabQueue.classList.add('active');
      tabVibe.classList.remove('active');
      listQueue.classList.remove('hidden');
      viewVibe.classList.add('hidden');
    });

    tabVibe.addEventListener('click', () => {
      tabVibe.classList.add('active');
      tabQueue.classList.remove('active');
      listQueue.classList.add('hidden');
      viewVibe.classList.remove('hidden');
      setVibeCoordinates(_vibeTargetX, _vibeTargetY, false);
    });
  }

  // Queue drawer "Vibe" button
  const drawerVibeBtn = document.getElementById('queue-vibe-compass-btn');
  if (drawerVibeBtn) {
    drawerVibeBtn.addEventListener('click', () => {
      const drawer = document.getElementById('queue-drawer');
      if (drawer) drawer.classList.remove('open');
      if (tabVibe) tabVibe.click();
      const card = document.getElementById('hero-up-next-card');
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('heatmap-highlight-pulse');
        setTimeout(() => card.classList.remove('heatmap-highlight-pulse'), 1500);
      }
    });
  }

  // Drag & Pointer handling on Pad
  function onPointerMove(e) {
    if (!_isDraggingVibePuck && e.type !== 'click') return;
    const rect = pad.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const rawX = (clientX - rect.left) / rect.width;
    const rawY = (clientY - rect.top) / rect.height;

    const clampedX = Math.max(0, Math.min(1, rawX));
    const clampedY = Math.max(0, Math.min(1, rawY));

    const x = parseFloat(((clampedX * 2.0) - 1.0).toFixed(2));
    const y = parseFloat((1.0 - (clampedY * 2.0)).toFixed(2));

    setVibeCoordinates(x, y, false);
  }

  pad.addEventListener('pointerdown', (e) => {
    _isDraggingVibePuck = true;
    pad.setPointerCapture(e.pointerId);
    onPointerMove(e);
  });

  pad.addEventListener('pointermove', onPointerMove);

  pad.addEventListener('pointerup', (e) => {
    _isDraggingVibePuck = false;
    try { pad.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  pad.addEventListener('pointercancel', () => {
    _isDraggingVibePuck = false;
  });

  // Presets Bar
  document.querySelectorAll('.vibe-preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const x = parseFloat(chip.dataset.x);
      const y = parseFloat(chip.dataset.y);
      setVibeCoordinates(x, y, true);
    });
  });

  // Morph Upcoming Queue Button
  const morphBtn = document.getElementById('vibe-morph-queue-btn');
  if (morphBtn) {
    morphBtn.addEventListener('click', async () => {
      const upcoming = (queue || []).slice(currentIndex + 1);
      if (!upcoming.length) {
        notify('⚠️ Upcoming queue is empty. Add songs or click "Play Vibe Mix"!');
        return;
      }

      try {
        const res = await api('/api/vibe/sort-queue', {
          method: 'POST',
          body: JSON.stringify({
            x: _vibeTargetX,
            y: _vibeTargetY,
            tracks: upcoming
          })
        });

        if (res && res.status === 'success' && res.tracks) {
          queue = [...queue.slice(0, currentIndex + 1), ...res.tracks];
          renderQueue();
          renderDashboardUpNext();
          notify(`🧭 Upcoming queue morphed to ${_activeVibeTitle}!`);
        } else {
          notify('⚠️ Could not sort queue by vibe.');
        }
      } catch (err) {
        console.error('Error morphing queue by vibe:', err);
      }
    });
  }

  // Instant Vibe Mix Button
  const mixBtn = document.getElementById('vibe-instant-mix-btn');
  if (mixBtn) {
    mixBtn.addEventListener('click', async () => {
      mixBtn.disabled = true;
      mixBtn.innerHTML = '<i class="ph ph-spinner-gap spinning"></i> <span>Curating...</span>';
      try {
        const res = await api(`/api/vibe/tracks?x=${_vibeTargetX}&y=${_vibeTargetY}&limit=15`);
        if (res && res.status === 'success' && res.tracks && res.tracks.length > 0) {
          queue = [...res.tracks];
          currentIndex = 0;
          renderQueue();
          renderDashboardUpNext();
          playById(res.tracks[0].id);
          notify(`▶ Streaming 15-Track Vibe Mix: ${_activeVibeTitle}!`);
        } else {
          notify('⚠️ No tracks found for this mood.');
        }
      } catch (err) {
        console.error('Error fetching vibe tracks:', err);
        notify('⚠️ Error generating vibe mix.');
      } finally {
        mixBtn.disabled = false;
        mixBtn.innerHTML = '<i class="ph-fill ph-play"></i> <span>Play Vibe Mix</span>';
      }
    });
  }

  // Initial Coordinates
  setVibeCoordinates(0.0, 0.0, false);
}

/** Handles interactive Mood Filter Chips */
function initMoodFilterChips() {
  const chips = document.querySelectorAll('.mood-chip');
  if (!chips.length) return;

  chips.forEach(chip => {
    if (chip._moodBound) return;
    chip._moodBound = true;

    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      const selectedMood = chip.dataset.mood || 'all';

      // Filter all recommendation shelves
      document.querySelectorAll('.rec-shelf').forEach(shelf => {
        // Strict guard: never display a shelf that has no rendered cards/content
        const scrollContainer = shelf.querySelector('.rec-shelf-scroll, .rec-capsules-grid, .sonic-dna-card, .streak-heatmap-card');
        const hasContent = scrollContainer && scrollContainer.children.length > 0;
        if (!hasContent) {
          shelf.style.display = 'none';
          return;
        }

        const shelfMoods = (shelf.dataset.moods || 'all').split(',');
        if (selectedMood === 'all' || shelfMoods.includes(selectedMood)) {
          shelf.style.display = 'block';
          shelf.style.opacity = '0';
          shelf.style.transform = 'translateY(8px)';
          setTimeout(() => {
            shelf.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            shelf.style.opacity = '1';
            shelf.style.transform = 'translateY(0)';
          }, 20);
        } else {
          shelf.style.display = 'none';
        }
      });

      notify(`Filtering: ${chip.textContent.trim()}`);
    });
  });
}

/**
 * Main dashboard loader. Fetches /api/recommend/dashboard and renders all shelves.
 * @param {boolean} forceRefresh — bypasses the 5-minute server-side cache
 */
async function loadDashboardRecommendations(forceRefresh = false) {
  if (_recDashboardLoading) return;
  _recDashboardLoading = true;

  // Update greeting
  const greetingEl = document.getElementById('rec-greeting');
  if (greetingEl) greetingEl.textContent = getRecGreeting();

  // Show skeleton only if dashboard hasn't been loaded yet
  const skeleton = document.getElementById('rec-skeleton');
  const emptyState = document.getElementById('rec-empty');
  if (!_recDashboardLoaded) {
    if (skeleton) skeleton.style.display = 'flex';
    if (emptyState) emptyState.style.display = 'none';
    document.querySelectorAll('.rec-shelf').forEach(s => s.style.display = 'none');
  }

  // Spinner on refresh button
  const refreshBtn = document.getElementById('rec-refresh-btn');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  try {
    const url = forceRefresh
      ? '/api/recommend/dashboard?force_refresh=1'
      : '/api/recommend/dashboard?fast=1';
    const data = await api(url);

    if (skeleton) skeleton.style.display = 'none';

    // Render Quick Launch Grid & Daily Capsules
    if (data.quick_grid && data.quick_grid.length > 0) {
      renderQuickLaunchGrid(data.quick_grid);
    }
    if (data.daily_capsules && data.daily_capsules.length > 0) {
      renderDailyCapsules(data.daily_capsules);
    }

    // Update taste profile banner & Sonic DNA
    if (data && data.taste_summary) {
      const greetingSub = document.getElementById('rec-greeting-sub');
      const mood = data.taste_summary.mood_vibe || 'Personalized';
      const topArt = data.top_artist;
      if (greetingSub) {
        if (topArt) {
          greetingSub.innerHTML = `Vibe: <strong>${escapeHtml(mood)}</strong> · Top artist: <strong>${escapeHtml(topArt)}</strong> · Inspired by your listening habits`;
        } else {
          greetingSub.textContent = `Vibe: ${mood} · Curated for you`;
        }
      }

      renderSonicDnaCard(data.taste_summary, data.top_artist);
      loadStreakHeatmap();
    }

    let renderedAnyShelf = false;

    // Render each section
    if (data.sections && data.sections.length > 0) {
      data.sections.forEach(section => {
        if (section.id === 'capsules') return;
        renderRecShelf(section);
        if (section.tracks && section.tracks.length > 0) {
          renderedAnyShelf = true;
        }

        // Update dynamic titles
        if (section.id === 'because' && section.title) {
          const titleEl = document.getElementById('shelf-because-title');
          if (titleEl) titleEl.textContent = section.title;
        }
        if (section.id === 'mood' && section.title) {
          const titleEl = document.getElementById('shelf-mood-title');
          if (titleEl) titleEl.textContent = section.title;
        }
        if (section.id === 'rediscover' && section.title) {
          const titleEl = document.getElementById('shelf-rediscover-title');
          if (titleEl) titleEl.textContent = section.title;
        }
        if (section.id === 'markov_next' && section.title) {
          const titleEl = document.getElementById('shelf-markov-title');
          if (titleEl) titleEl.textContent = section.title;
        }
      });
    }

    const hasContent = renderedAnyShelf ||
      (data.quick_grid && data.quick_grid.length > 0) ||
      (data.daily_capsules && data.daily_capsules.length > 0) ||
      (data.taste_summary && ((data.taste_summary.total_listen_hours || 0) > 0 || (data.taste_summary.listening_streak_days || 0) > 0));

    if (!hasContent) {
      if (emptyState) emptyState.style.display = 'flex';
    } else {
      if (emptyState) emptyState.style.display = 'none';
      _recDashboardLoaded = true;
    }

    renderDashboardUpNext();
    initMoodFilterChips();

    // Background enrichment: if any YouTube shelf is missing or empty, fetch full online tier
    const onlineShelves = ['because', 'mood', 'trending', 'rediscover'];
    const presentOnline = (data.sections || [])
      .filter(s => s.source === 'youtube' && s.tracks && s.tracks.length > 0)
      .map(s => s.id);
    const hasMissingOnline = onlineShelves.some(id => !presentOnline.includes(id));

    if (!forceRefresh && hasMissingOnline) {
      setTimeout(() => {
        api('/api/recommend/dashboard').then(fullData => {
          if (fullData && fullData.sections) {
            if (fullData.quick_grid && fullData.quick_grid.length > 0) renderQuickLaunchGrid(fullData.quick_grid);
            if (fullData.daily_capsules && fullData.daily_capsules.length > 0) renderDailyCapsules(fullData.daily_capsules);
            if (fullData.taste_summary) renderSonicDnaCard(fullData.taste_summary, fullData.top_artist);

            fullData.sections.forEach(sec => {
              if (sec.id === 'capsules') return;
              renderRecShelf(sec);
              if (sec.id === 'because' && sec.title) {
                const titleEl = document.getElementById('shelf-because-title');
                if (titleEl) titleEl.textContent = sec.title;
              }
              if (sec.id === 'mood' && sec.title) {
                const titleEl = document.getElementById('shelf-mood-title');
                if (titleEl) titleEl.textContent = sec.title;
              }
              if (sec.id === 'rediscover' && sec.title) {
                const titleEl = document.getElementById('shelf-rediscover-title');
                if (titleEl) titleEl.textContent = sec.title;
              }
              if (sec.id === 'markov_next' && sec.title) {
                const titleEl = document.getElementById('shelf-markov-title');
                if (titleEl) titleEl.textContent = sec.title;
              }
            });

            if (emptyState) emptyState.style.display = 'none';
            _recDashboardLoaded = true;
          }
        }).catch(() => {});
      }, 1500);
    }

  } catch (err) {
    console.error('[RecDashboard] Load error:', err);
    if (skeleton) skeleton.style.display = 'none';
    if (!_recDashboardLoaded && emptyState) emptyState.style.display = 'flex';
  } finally {
    _recDashboardLoading = false;
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

// Refresh button click handler
document.getElementById('rec-refresh-btn')?.addEventListener('click', () => {
  loadDashboardRecommendations(true);
});

// Update "now playing" highlight on rec cards when track changes
function updateRecDashboardPlayingState(trackId) {
  _recCurrentlyPlayingId = trackId;
  document.querySelectorAll('.rec-card').forEach(card => {
    if (card.dataset.id === trackId) {
      card.classList.add('now-playing');
    } else {
      card.classList.remove('now-playing');
    }
  });
}

// ── Dashboard "Up Next" Mini Queue Widget ──
function renderDashboardUpNext() {
  const container = document.getElementById('hero-up-next-list');
  if (!container) return;

  // Next 3 tracks after current track from queue
  let nextTracks = (queue || []).slice(currentIndex + 1, currentIndex + 4);
  if (!nextTracks.length && state && state.tracks) {
    const curId = queue[currentIndex]?.id;
    nextTracks = state.tracks.filter(t => t.id !== curId && t.media_type !== 'video').slice(0, 3);
  }

  if (!nextTracks.length) {
    container.innerHTML = `
      <div class="up-next-empty">
        <i class="ph ph-music-note"></i>
        <span>Queue is empty</span>
      </div>
    `;
    return;
  }

  container.innerHTML = nextTracks.map((t, idx) => {
    const isYT = !!(t.is_online || (t.id && t.id.startsWith('yt:')));
    const vid = t.video_id || (t.id || '').replace('yt:', '');
    const thumb = t.artwork_url || (isYT && vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '');
    const thumbHtml = thumb
      ? `<img src="${escapeHtml(thumb)}" alt="Art" loading="lazy" onerror="this.parentNode.innerHTML='<i class=\\'ph-fill ph-music-note\\'></i>'">`
      : `<i class="ph-fill ph-music-note"></i>`;

    return `
      <div class="up-next-item" data-id="${escapeHtml(t.id)}" data-is-yt="${isYT ? '1' : '0'}" data-vid="${escapeHtml(vid)}" data-title="${escapeHtml(t.title || '')}" data-artist="${escapeHtml(t.artist || '')}" data-thumb="${escapeHtml(thumb || '')}" data-dur="${t.duration || 0}">
        <div class="up-next-art">
          ${thumbHtml}
        </div>
        <div class="up-next-info">
          <span class="up-next-title" title="${escapeHtml(t.title || '')}">${escapeHtml(t.title || 'Unknown')}</span>
          <span class="up-next-artist">${escapeHtml(t.artist || '')}</span>
        </div>
        <div class="up-next-more">
          <i class="ph-fill ph-play-circle"></i>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.up-next-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.dataset.isYt === '1' && item.dataset.vid) {
        streamYouTubeAudio(item.dataset.vid, item.dataset.title, item.dataset.artist, item.dataset.thumb, parseFloat(item.dataset.dur) || 0);
      } else if (item.dataset.id) {
        playById(item.dataset.id);
      }
    });
  });
}

// ── Animated Golden Waveform Visualizer Canvas on Now Playing Card ──
let _heroWaveformRaf = null;

function initHeroWaveformVisualizer() {
  const canvas = document.getElementById('hero-waveform-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const barCount = 42;
  const barSpacing = 4;

  function drawWaveform() {
    _heroWaveformRaf = requestAnimationFrame(drawWaveform);
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const isPlaying = !audio.paused && audio.currentTime > 0;
    let freqData = null;
    if (isPlaying && analyser && audioDataArray) {
      try {
        analyser.getByteFrequencyData(audioDataArray);
        freqData = audioDataArray;
      } catch (e) {}
    }

    const totalBarWidth = (width - (barCount - 1) * barSpacing) / barCount;
    const centerY = height / 2;

    for (let i = 0; i < barCount; i++) {
      let normHeight = 0.2;
      if (isPlaying && freqData && freqData.length > 0) {
        const binIndex = Math.floor((i / barCount) * Math.min(freqData.length, 32));
        const val = freqData[binIndex] || 0;
        normHeight = 0.18 + (val / 255) * 0.76;
      } else {
        // Aesthetic resting sine wave like the mockup
        const sine = Math.sin((i / barCount) * Math.PI);
        normHeight = 0.15 + sine * 0.35;
      }

      const barH = Math.max(4, height * normHeight);
      const x = i * (totalBarWidth + barSpacing);
      const y = centerY - barH / 2;

      // Warm Golden Amber Gradient matching mockup
      const grad = ctx.createLinearGradient(0, y, 0, y + barH);
      grad.addColorStop(0, '#f2ca8a');
      grad.addColorStop(0.5, '#e5a95d');
      grad.addColorStop(1, '#b87c35');

      ctx.fillStyle = grad;
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, totalBarWidth, barH, 2);
      } else {
        ctx.rect(x, y, totalBarWidth, barH);
      }
      ctx.fill();
    }
  }

  if (!_heroWaveformRaf) drawWaveform();
}

// ── Shelf Navigation Arrow Scrolling Handler (< > buttons) ──
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.rec-shelf-arrow');
  if (!btn) return;
  const targetId = btn.dataset.target;
  const dir = parseInt(btn.dataset.dir, 10) || 1;
  const scrollContainer = document.getElementById(targetId);
  if (scrollContainer) {
    scrollContainer.scrollBy({ left: dir * 360, behavior: 'smooth' });
  }
});

// ── Wire Hero Deck Secondary Actions ──
$('#hero-prev')?.addEventListener('click', () => $('#prev')?.click());
$('#hero-next')?.addEventListener('click', () => $('#next')?.click());
$('#hero-open-queue')?.addEventListener('click', () => {
  const playlistsBtn = document.querySelector('[data-view="playlists"]');
  if (playlistsBtn) playlistsBtn.click();
});

function renderVideos() {
  const query = $('#search').value.trim().toLowerCase();
  let videos = state.tracks.filter(t => t.media_type === 'video');
  if (query) {
    videos = videos.filter(t => `${t.title} ${t.artist} ${t.category}`.toLowerCase().includes(query));
  }
  const grid = $('#video-grid');
  $('#videos-status').textContent = `${videos.length} video${videos.length===1?'':'s'}`;
  $('#empty-videos-state').classList.toggle('hidden', videos.length > 0);

  grid.innerHTML = videos.map((v, i) => `
    <div class="video-card" data-id="${escapeHtml(v.id)}">
      <div class="video-thumb"><i class="ph-fill ph-play-circle"></i></div>
      <div class="video-info">
        <strong>${escapeHtml(v.title)}</strong>
        <span>${escapeHtml(v.artist)}</span>
        ${v.category ? `<span class="track-cat-tag" style="align-self:flex-start;margin-top:4px;">${escapeHtml(v.category)}</span>` : ''}
      </div>
    </div>
  `).join('');
  
  grid.querySelectorAll('.video-card').forEach(card =>
    card.addEventListener('click', () => openVideoPlayer(card.dataset.id))
  );
}

// ---- Search (Ultra-Smooth 120ms Debounced) -------------------
let _localSearchTimer = null;
$('#search').addEventListener('input', () => {
  clearTimeout(_localSearchTimer);
  _localSearchTimer = setTimeout(() => {
    renderTracks(state.tracks.filter(t => t.media_type !== 'video'));
    renderVideos();
    renderFavorites();
    if (currentOpenPlaylistName) {
      openPlaylistDetail(currentOpenPlaylistName);
    }
  }, 120);
});

// ---- Playback -----------------------------------------------
function trackById(id) { 
  if (id && id.startsWith('yt:')) {
    const fromQueue = queue.find(t => t.id === id);
    if (fromQueue) return fromQueue;
    const fromOnlineCache = state.online_tracks_cache && state.online_tracks_cache[id];
    if (fromOnlineCache) return fromOnlineCache;
    const fromTracks = state.tracks.find(t => t.id === id);
    if (fromTracks) return fromTracks;
    const vid = id.replace('yt:', '');
    return {
      id,
      video_id: vid,
      title: "YouTube Stream",
      artist: "YouTube",
      album: "YouTube",
      duration: 0,
      has_artwork: true,
      artwork_url: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      media_type: 'audio',
      is_online: true
    };
  }
  return state.tracks.find(t => t.id === id) || { id, title: "Missing Track", artist: "File not found", album: "", duration: 0, missing: true, category: '' }; 
}

let transitionTimeout1, transitionTimeout2;

// ---- 🎧 Feature 10: Auto-DJ Engine Core Functions ------------

function syncNowPlayingUI(track) {
  if (!track) return;
  const id = track.id;
  $('#now-title').textContent = track.title || 'Unknown Title';
  $('#now-artist').textContent = track.artist || 'Unknown Artist';
  if (track.has_artwork && track.artwork_url) {
    $('#now-art').innerHTML = `<img src="${escapeHtml(track.artwork_url)}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    $('#album-art-box').innerHTML = `<img src="${escapeHtml(track.artwork_url)}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:50%;box-shadow:0 0 20px rgba(0,0,0,0.6);">`;
  } else {
    $('#now-art').innerHTML = `<i class="ph-fill ph-music-notes"></i>`;
    $('#album-art-box').innerHTML = `<i class="ph-fill ph-music-notes-simple"></i>`;
  }

  $('#hero-title').innerHTML = `${escapeHtml(track.title || 'Unknown')}<br><em>is playing.</em>`;
  $('#hero-artist').textContent = `${track.artist || 'Unknown'} · ${track.album || 'Unknown'}`;
  const durStr = track.duration ? ` · ${formatTime(track.duration)}` : '';
  $('#hero-format').textContent = `${(track.extension || 'MP3').toUpperCase()} · ${track.quality || 'Standard'}${durStr}`;

  $('#current-time').textContent = '0:00';
  if (track.duration > 0) {
    $('#total-time').textContent = formatTime(track.duration);
    $('#progress').value = 0;
  }

  const colors = [
    ['#1a1a2e', '#0f3460'], ['#2d4059', '#ea5455'], 
    ['#111113', '#2a2a35'], ['#2c3e50', '#3498db'],
    ['#0b0b0c', '#d4b07a'], ['#1C1C21', '#8FA998']
  ];
  const [c1, c2] = colors[Math.floor(Math.random() * colors.length)];
  const vinylRecord = $('#vinyl-record');
  if (vinylRecord) {
    vinylRecord.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
    vinylRecord.classList.add('playing');
  }
  $('#hero-now-playing-card')?.classList.add('playing');
  const npBar = $('#hero-np-bar');
  if (npBar) npBar.style.width = '0%';
  $('#play').innerHTML = '<i class="ph-fill ph-pause"></i>';
  $('#fs-play').innerHTML = '<i class="ph-fill ph-pause"></i>';

  if (id) {
    state.history = [id, ...state.history.filter(k => k !== id)].slice(0, 100);
    saveState();
  }
  renderQueue();
  loadLyricsInline(track);
  updateMediaSessionMetadata(track);
  applyChameleonPalette(track);
  updateFullscreenUI(track);
  if (id) {
    syncNowPlayingFavorite(id);
    updateRecDashboardPlayingState(id);
  }
}

function estimateTrackBPM(track) {
  if (track && track.bpm && Number(track.bpm) > 0) return Number(track.bpm);
  const title = (track?.title || '').toLowerCase();
  const artist = (track?.artist || '').toLowerCase();
  const genre = (track?.genre || track?.category || '').toLowerCase();
  const text = `${title} ${artist} ${genre}`;

  let base = 118.0;
  if (/edm|house|techno|electro|dance/.test(text)) base = 126.0;
  else if (/punjabi|bhangra|club|remix/.test(text)) base = 124.0;
  else if (/pop|disco|funk|upbeat|summer/.test(text)) base = 120.0;
  else if (/rock|metal|grunge|punk|alternative/.test(text)) base = 116.0;
  else if (/hip-hop|hip hop|rap|trap|r&b/.test(text)) base = 92.0;
  else if (/lofi|lo-fi|chill|relax|coffee/.test(text)) base = 82.0;
  else if (/acoustic|ambient|classical|piano|sleep|slow/.test(text)) base = 74.0;

  // Deterministic scatter +-3.5 BPM based on title & artist
  let h = 0;
  const key = `${track?.title || ''}_${track?.artist || ''}`;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0xffff;
  const scatter = ((h % 70) / 10.0) - 3.5;
  return Math.round((base + scatter) * 10) / 10;
}

let _autoDJPillTimer = null;

function showAutoDJBlendingPill(bpmA, bpmB, duration) {
  const pill = $('#autodj-blending-pill');
  const txt = $('#autodj-blending-text');
  const quickBtn = $('#autodj-quick-btn');
  const fsBtn = $('#fs-autodj-btn');
  if (quickBtn) quickBtn.classList.add('blending');
  if (fsBtn) fsBtn.classList.add('blending');
  if (pill && txt) {
    txt.textContent = `Auto-DJ Blending • ${bpmA} → ${bpmB} BPM (${duration}s)`;
    pill.classList.add('show');
  }
  clearTimeout(_autoDJPillTimer);
  _autoDJPillTimer = setTimeout(() => {
    hideAutoDJBlendingPill();
  }, (duration + 0.5) * 1000);
}

function hideAutoDJBlendingPill() {
  clearTimeout(_autoDJPillTimer);
  const pill = $('#autodj-blending-pill');
  const quickBtn = $('#autodj-quick-btn');
  const fsBtn = $('#fs-autodj-btn');
  if (quickBtn) quickBtn.classList.remove('blending');
  if (fsBtn) fsBtn.classList.remove('blending');
  if (pill) pill.classList.remove('show');
}

function smoothlyRestoreTempo(audioEl, fromRate, toRate, durationMs = 3000) {
  if (!audioEl || Math.abs(fromRate - toRate) < 0.005) {
    if (audioEl) audioEl.playbackRate = toRate;
    return;
  }
  const startTime = performance.now();
  const step = (now) => {
    const progress = Math.min(1.0, (now - startTime) / durationMs);
    const ease = 0.5 * (1 - Math.cos(progress * Math.PI));
    audioEl.playbackRate = fromRate + (toRate - fromRate) * ease;
    if (progress < 1.0) {
      requestAnimationFrame(step);
    } else {
      audioEl.playbackRate = toRate;
    }
  };
  requestAnimationFrame(step);
}

let isCrossfading = false;

async function startAutoDJCrossfade(nextTrack, customDuration = null) {
  if (isCrossfading || !nextTrack) return false;
  if (!isAutoDJEnabled && customDuration === null) return false;

  const duration = (customDuration !== null) ? customDuration : autoDJDuration;
  if (duration <= 0) return false;

  const outgoingAudio = getActiveAudio();
  const incomingAudio = getStandbyAudio();
  if (!outgoingAudio || !incomingAudio) return false;

  initAudioContext();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  isCrossfading = true;

  const currentTrack = (queue && queue[currentIndex]) || {};
  const currentBpm = estimateTrackBPM(currentTrack);
  const targetBpm = estimateTrackBPM(nextTrack);
  showAutoDJBlendingPill(currentBpm, targetBpm, duration);

  const incomingUrl = nextTrack.is_online && nextTrack.video_id 
    ? `/api/youtube/stream/${encodeURIComponent(nextTrack.video_id)}`
    : (nextTrack.url || '');

  if (!incomingUrl) {
    isCrossfading = false;
    hideAutoDJBlendingPill();
    return false;
  }

  // Setup standby audio element
  incomingAudio.src = incomingUrl;
  incomingAudio.currentTime = 0;
  incomingAudio.preservesPitch = true;

  // Beat-Match Tempo Sync (±6% musical pitch bend limit)
  const tempoRatio = Math.max(0.94, Math.min(1.06, currentBpm / targetBpm));
  incomingAudio.playbackRate = tempoRatio;

  const outgoingDeck = activeDeck;
  const incomingDeck = activeDeck === 'A' ? 'B' : 'A';
  const outGain = outgoingDeck === 'A' ? deckAGain : deckBGain;
  const inGain = incomingDeck === 'A' ? deckAGain : deckBGain;

  if (audioCtx && inGain) {
    inGain.gain.setValueAtTime(0, audioCtx.currentTime);
  } else {
    incomingAudio.volume = 0;
  }

  try {
    await incomingAudio.play();
  } catch (err) {
    console.warn('AutoDJ incoming play error:', err);
    isCrossfading = false;
    hideAutoDJBlendingPill();
    return false;
  }

  // Equal-power crossfade curve math (cos/sin preserve total acoustic power)
  const steps = 64;
  const outCurve = new Float32Array(steps);
  const inCurve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    outCurve[i] = Math.cos(t * 0.5 * Math.PI);
    inCurve[i] = Math.sin(t * 0.5 * Math.PI);
  }

  if (audioCtx && outGain && inGain) {
    const now = audioCtx.currentTime;
    outGain.gain.cancelScheduledValues(now);
    inGain.gain.cancelScheduledValues(now);
    outGain.gain.setValueCurveAtTime(outCurve, now, duration);
    inGain.gain.setValueCurveAtTime(inCurve, now, duration);
  } else {
    const startTime = performance.now();
    const interval = setInterval(() => {
      const elapsed = (performance.now() - startTime) / 1000;
      const progress = Math.min(1.0, elapsed / duration);
      outgoingAudio.volume = Math.cos(progress * 0.5 * Math.PI);
      incomingAudio.volume = Math.sin(progress * 0.5 * Math.PI);
      if (progress >= 1.0) clearInterval(interval);
    }, 40);
  }

  // Update track index and UI immediately so the user sees the incoming track
  const existingIdx = queue.findIndex(t => t.id === nextTrack.id);
  if (existingIdx >= 0) {
    currentIndex = existingIdx;
  } else {
    queue.splice(currentIndex + 1, 0, nextTrack);
    currentIndex++;
  }

  activeDeck = incomingDeck;
  syncNowPlayingUI(nextTrack);
  state.last_played_track_id = nextTrack.id;
  state.last_played_position = 0;
  startTrackingTrackPlayback(nextTrack, nextTrack.is_online ? 'youtube_stream' : 'library');

  // Complete crossfade after duration
  setTimeout(() => {
    outgoingAudio.pause();
    outgoingAudio.src = '';
    outgoingAudio.playbackRate = 1.0;
    outgoingAudio.volume = 1.0;
    if (audioCtx && outGain) {
      outGain.gain.cancelScheduledValues(audioCtx.currentTime);
      outGain.gain.value = 1.0; // Ready for next use
    }

    // Smoothly restore incoming deck's tempo to 1.0
    smoothlyRestoreTempo(incomingAudio, tempoRatio, 1.0, 3000);

    isCrossfading = false;
    hideAutoDJBlendingPill();
  }, duration * 1000);

  return true;
}

function playById(id) {
  stopHoverPreview();
  if (id && id.startsWith('yt:')) {
    const vid = id.replace('yt:', '');
    const t = trackById(id);
    streamYouTubeAudio(t.video_id || vid, t.title, t.artist, t.artwork_url, t.duration);
    return;
  }

  const track = trackById(id);
  if (!track || track.missing) return notify('Track is missing from disk.');
  if (track.media_type === 'video') { openVideoPlayer(id); return; }

  currentIndex = queue.findIndex(t => t.id === id);
  if (currentIndex < 0) {
    queue = [...state.tracks.filter(t=>t.media_type!=='video')];
    currentIndex = queue.findIndex(t => t.id === id);
  }

  // Precompute queue in background for local tracks
  populate25SongQueue();

  const player = $('#hero-now-playing-card') || $('.hero-player'); // new card, fallback to old
  clearTimeout(transitionTimeout1);

  clearTimeout(transitionTimeout2);

  // The function to actually swap data and play
  const doChange = () => {
    _lastPrewarmedTrackId = null;
    startTrackingTrackPlayback(track, 'library');
    initAudioContext();
    audio.src = track.url;
    audio.currentTime = 0; // Always play from the beginning when user selects any song
    audio.play().catch(() => notify('Playback failed.'));
    
    state.last_played_track_id = id;
    state.last_played_position = 0;
    
    syncNowPlayingUI(track);
    const fsDiskContainer = $('#fs-disk-container');
    if (fsDiskContainer) fsDiskContainer.classList.remove('changing');

    // Trigger visual slide-in
    player.classList.remove('anim-out');
    player.classList.add('anim-in');
    
    transitionTimeout2 = setTimeout(() => {
      player.classList.remove('anim-in');
    }, 500); // Wait for the 0.5s CSS animation to finish
  };

  // Immediate Zero-Delay Song Transition
  const targetVol = parseFloat($('#volume').value) || 1;
  audio.volume = targetVol;
  doChange();
}

$('#play').addEventListener('click', () => {
  if (!audio.src) { 
    const first = state.tracks.find(t=>t.media_type!=='video');
    if (first) playById(first.id); 
    return; 
  }
  if (audio.paused) { 
    audio.play(); 
    $('#play').innerHTML = '<i class="ph-fill ph-pause"></i>'; 
    if ($('#hero-play')) $('#hero-play').innerHTML = '<i class="ph-fill ph-pause-circle"></i>';
    $('#vinyl-record').classList.add('playing');
    $('#hero-now-playing-card')?.classList.add('playing');
  } else { 
    audio.pause(); 
    $('#play').innerHTML = '<i class="ph-fill ph-play"></i>';
    if ($('#hero-play')) $('#hero-play').innerHTML = '<i class="ph-fill ph-play-circle"></i>';
    $('#vinyl-record').classList.remove('playing');
    $('#hero-now-playing-card')?.classList.remove('playing');
    saveState();
  }
});

$('#hero-play').addEventListener('click', () => $('#play').click());

// ============================================================
// Linus CMI v6.0 Centralized Telemetry & Tracking Engine
// ============================================================
let radioMode = localStorage.getItem('linus_radio_mode') || 'online'; // 'online' or 'offline'
let previousTrackId = null;
let consecutiveSkipCount = 0;
let isFetchingRadioBatch = false;
let _lastPrewarmedTrackId = null;

let _telemetryCurrentTrack = null;
let _telemetryPlayStartTime = 0;
let _telemetryMaxTimePlayed = 0;
let _userSessionId = 'sess_' + Math.random().toString(36).slice(2, 10);

function flushCurrentTrackPlayback(reason = 'change', isExplicitSkip = false) {
  if (!_telemetryCurrentTrack || !_telemetryCurrentTrack.id) return;

  const currentTrack = _telemetryCurrentTrack;
  const durPlayed = Math.max(audio.currentTime || 0, _telemetryMaxTimePlayed || 0);
  const totalDur = audio.duration || currentTrack.duration || durPlayed || 0;
  
  const isSkip = isExplicitSkip || (reason === 'skip') || (reason === 'change' && durPlayed < 20 && totalDur > 45);

  const payload = {
    track_id: currentTrack.id,
    duration_played: durPlayed,
    total_duration: totalDur,
    skipped: isSkip,
    prev_track_id: previousTrackId || '',
    title: currentTrack.title || '',
    artist: currentTrack.artist || '',
    album: currentTrack.album || '',
    artwork_url: currentTrack.artwork_url || '',
    is_online: !!(currentTrack.is_online || (currentTrack.id && currentTrack.id.startsWith('yt:'))),
    context_source: reason,
    session_id: _userSessionId
  };

  previousTrackId = currentTrack.id;

  if (reason === 'unload' && navigator.sendBeacon) {
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/api/recommend/record-event', blob);
      return;
    } catch (e) {}
  }

  api('/api/recommend/record-event', {
    method: 'POST',
    body: JSON.stringify(payload)
  }).then(() => {
    loadStreakHeatmap();
  }).catch(() => {});

  _telemetryCurrentTrack = null;
  _telemetryMaxTimePlayed = 0;
}

function startTrackingTrackPlayback(newTrack, context = 'library') {
  if (!newTrack || !newTrack.id) return;
  if (_telemetryCurrentTrack && _telemetryCurrentTrack.id !== newTrack.id) {
    flushCurrentTrackPlayback(context, false);
  }
  _telemetryCurrentTrack = { ...newTrack };
  _telemetryPlayStartTime = Date.now();
  _telemetryMaxTimePlayed = 0;
}

function updateRadioModeUI() {
  const btn = $('#radio-mode-toggle-btn');
  const icon = $('#radio-mode-icon');
  const text = $('#radio-mode-text');
  if (!btn) return;

  if (radioMode === 'online') {
    btn.className = 'cozy-quick-btn radio-mode-toggle-btn online';
    if (icon) icon.className = 'ph-fill ph-globe';
    if (text) text.textContent = 'Online Radio';
    btn.title = 'Current Mode: Online Radio (YouTube infinite discovery). Click to switch to Offline Library.';
  } else {
    btn.className = 'cozy-quick-btn radio-mode-toggle-btn offline';
    if (icon) icon.className = 'ph-fill ph-hard-drives';
    if (text) text.textContent = 'Offline Radio';
    btn.title = 'Current Mode: Offline Radio (Local Library similarity). Click to switch to Online YouTube.';
  }
}

$('#radio-mode-toggle-btn')?.addEventListener('click', () => {
  radioMode = radioMode === 'online' ? 'offline' : 'online';
  localStorage.setItem('linus_radio_mode', radioMode);
  updateRadioModeUI();
  // Clear upcoming auto-generated songs so new mode immediately populates
  if (queue.length > currentIndex + 1) {
    queue = queue.slice(0, currentIndex + 1);
  }
  populate25SongQueue();
  notify(radioMode === 'online' ? '🌐 Switched to Online Radio (Infinite YouTube Discovery)' : '💾 Switched to Offline Radio (Local Library)');
});

// ---- 1-Click Infinite Radio Station Engine ----
let _activeRadioSeed = null;

async function startTrackRadio(seedTrackOrId = null) {
  let seed = null;
  if (typeof seedTrackOrId === 'object' && seedTrackOrId !== null) {
    seed = seedTrackOrId;
  } else if (typeof seedTrackOrId === 'string' && seedTrackOrId) {
    seed = trackById(seedTrackOrId);
  } else {
    seed = queue[currentIndex] || (state.tracks && state.tracks.length ? state.tracks[0] : null);
  }

  if (!seed || (!seed.id && !seed.video_id)) {
    notify('Select or play a song first to start a radio station.');
    return;
  }

  const title = seed.title || 'Selected Track';
  const artist = seed.artist || 'Unknown Artist';
  _activeRadioSeed = { ...seed, title, artist };

  notify(`🪄 Starting Infinite Radio from "${title}"...`);

  // 1. Play seed track immediately
  const isOnline = Boolean(seed.is_online || (seed.id && seed.id.startsWith('yt:')) || seed.video_id);
  const cleanVid = seed.video_id || (seed.id && seed.id.startsWith('yt:') ? seed.id.replace('yt:', '') : '');

  if (isOnline && cleanVid) {
    streamYouTubeAudio(cleanVid, title, artist, seed.artwork_url || seed.thumbnail || '', seed.duration || 0);
  } else if (seed.id) {
    playById(seed.id);
  }

  // 2. Set queue starting from seed track
  queue = [seed];
  currentIndex = 0;
  renderQueue();

  // 3. Fetch 25 acoustically matched songs
  isFetchingRadioBatch = true;
  try {
    const res = await api('/api/recommend/batch', {
      method: 'POST',
      body: JSON.stringify({
        mode: radioMode === 'offline' && !isOnline ? 'offline' : 'online',
        track_id: seed.id || (cleanVid ? `yt:${cleanVid}` : ''),
        title: title,
        artist: artist,
        category: seed.category || '',
        count: 25,
        consecutive_skips: 0,
        history: (state.history || []).slice(0, 15)
      })
    });

    if (res && res.status === 'success' && res.tracks && res.tracks.length > 0) {
      const seedKey = (seed.id || cleanVid).toLowerCase();
      const peers = res.tracks.filter(t => {
        if (!t) return false;
        const tid = (t.id || t.video_id || '').toLowerCase();
        return tid && tid !== seedKey;
      });
      queue = [seed, ...peers];
      renderQueue();
      notify(`📻 Infinite Radio ready: ${peers.length} matching songs queued for "${title}"`);
    } else {
      notify(`📻 Radio station playing "${title}"`);
    }
  } catch (err) {
    console.error('Start radio error:', err);
    notify(`📻 Radio station playing "${title}"`);
  } finally {
    isFetchingRadioBatch = false;
  }
}

// Populates a 25-song cohesive precomputed queue in the background
async function populate25SongQueue(forceReset = false) {
  if (isFetchingRadioBatch) return;
  const currentTrack = queue[currentIndex] || {};
  const currentId = currentTrack.id || '';
  const title = currentTrack.title || '';
  const artist = currentTrack.artist || '';

  // Only replenish if remaining songs in queue < 6 or forceReset
  const remaining = queue.length - (currentIndex + 1);
  if (!forceReset && remaining >= 6) return;

  isFetchingRadioBatch = true;
  try {
    const res = await api('/api/recommend/batch', {
      method: 'POST',
      body: JSON.stringify({
        mode: radioMode,
        track_id: currentId,
        title: title,
        artist: artist,
        category: currentTrack.category || '',
        count: 25,
        consecutive_skips: consecutiveSkipCount,
        history: (state.history || []).slice(0, 15)
      })
    });

    if (res && res.status === 'success' && res.tracks && res.tracks.length > 0) {
      const newTracks = res.tracks.filter(t => t && t.id && t.id !== currentId);
      if (forceReset) {
        queue = [currentTrack, ...newTracks];
        currentIndex = 0;
      } else {
        // Append unique upcoming songs
        const existingIds = new Set(queue.map(t => t.id));
        const toAdd = newTracks.filter(t => !existingIds.has(t.id));
        queue.push(...toAdd);
        // Cap maximum queue length to 35 to guarantee zero memory bloat
        if (queue.length > 35) {
          queue = queue.slice(Math.max(0, currentIndex - 3), currentIndex + 26);
          currentIndex = queue.findIndex(t => t.id === currentId);
          if (currentIndex < 0) currentIndex = 0;
        }
      }
      renderQueue();
    }
  } catch (err) {
    console.error('Queue batch error:', err);
  } finally {
    isFetchingRadioBatch = false;
  }
}

// When a user quickly skips a song, remove 4-5 matching songs from the same artist/type from queue
function pruneSkippedAffinitiesFromQueue(skippedTrack) {
  if (!skippedTrack) return;
  const skipArtist = (skippedTrack.artist || '').toLowerCase().trim();
  const skipTitle = (skippedTrack.title || '').toLowerCase().trim();
  if (!skipArtist && !skipTitle) return;

  let removedCount = 0;
  const maxToRemove = 4; // Remove 4-5 matching songs

  const preservedBefore = queue.slice(0, currentIndex + 1);
  const upcoming = queue.slice(currentIndex + 1);

  const filteredUpcoming = upcoming.filter(t => {
    if (removedCount >= maxToRemove) return true;
    const tArtist = (t.artist || '').toLowerCase().trim();
    if (skipArtist && (tArtist === skipArtist || tArtist.includes(skipArtist) || skipArtist.includes(tArtist))) {
      removedCount++;
      return false;
    }
    return true;
  });

  queue = [...preservedBefore, ...filteredUpcoming];
  renderQueue();
  // If upcoming pool is depleted, fetch fresh variety batch immediately
  if (queue.length - (currentIndex + 1) < 5) {
    populate25SongQueue();
  }
}

async function playNextRecommendedSong() {
  // If queue has upcoming precomputed songs, play immediately with zero delay
  if (currentIndex + 1 < queue.length) {
    currentIndex++;
    const nextTrack = queue[currentIndex];
    if (nextTrack.is_online && nextTrack.video_id) {
      streamYouTubeAudio(nextTrack.video_id, nextTrack.title, nextTrack.artist, nextTrack.artwork_url, nextTrack.duration);
    } else {
      playById(nextTrack.id);
    }
    populate25SongQueue();
    return;
  }

  // If queue is empty, fetch and play
  notify(`📻 ${radioMode === 'online' ? 'Discovering next song from YouTube...' : 'Finding best matching local song...'}`);

  try {
    const res = await api('/api/recommend/next', {
      method: 'POST',
      body: JSON.stringify({
        mode: radioMode,
        track_id: queue[currentIndex]?.id || '',
        title: queue[currentIndex]?.title || '',
        artist: queue[currentIndex]?.artist || '',
        category: queue[currentIndex]?.category || '',
        consecutive_skips: consecutiveSkipCount,
        history: (state.history || []).slice(0, 15)
      })
    });

    if (res && res.status === 'success' && res.track) {
      const nextTrack = res.track;
      if (nextTrack.is_online && nextTrack.video_id) {
        streamYouTubeAudio(nextTrack.video_id, nextTrack.title, nextTrack.artist, nextTrack.artwork_url, nextTrack.duration);
      } else if (nextTrack.id) {
        playById(nextTrack.id);
      }
      populate25SongQueue();
      return;
    }
  } catch (err) {
    console.error('Recommendation autoplay error:', err);
  }

  if (queue.length) {
    currentIndex = 0;
    const first = queue[0];
    if (first.is_online && first.video_id) {
      streamYouTubeAudio(first.video_id, first.title, first.artist, first.artwork_url, first.duration);
    } else {
      playById(first.id);
    }
  }
}

// Log playback stats on song end
audio.addEventListener('ended', () => {
  consecutiveSkipCount = 0; // Completed song resets skip count
  flushCurrentTrackPlayback('ended', false);

  if (repeatMode === 'one') {
    audio.currentTime = 0;
    audio.play();
    return;
  }

  playNextRecommendedSong();
});

$('#next').addEventListener('click', () => {
  if (!queue.length) return;
  if (repeatMode === 'one') { audio.currentTime = 0; audio.play(); return; }

  const currentTrack = queue[currentIndex] || {};
  const durPlayed = audio.currentTime;
  const isSkip = durPlayed < 20;

  if (isSkip) {
    consecutiveSkipCount++;
    pruneSkippedAffinitiesFromQueue(currentTrack);
  } else {
    consecutiveSkipCount = 0;
  }

  flushCurrentTrackPlayback('skip', isSkip);

  // If Auto-DJ is enabled and next track is ready in queue, perform snappy 1.8s beat-matched DJ blend!
  if (isAutoDJEnabled && autoDJDuration > 0 && !audio.paused && audio.src && currentIndex + 1 < queue.length) {
    const nextTrack = queue[currentIndex + 1];
    startAutoDJCrossfade(nextTrack, 1.8).then(blended => {
      if (blended) {
        populate25SongQueue();
      } else {
        playNextRecommendedSong();
      }
    });
    return;
  }

  playNextRecommendedSong();
});

$('#previous')?.addEventListener('click', () => {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (currentIndex > 0) {
    flushCurrentTrackPlayback('prev', false);
    currentIndex--;
    const prevTrack = queue[currentIndex];
    if (prevTrack && prevTrack.is_online && prevTrack.video_id) {
      streamYouTubeAudio(prevTrack.video_id, prevTrack.title, prevTrack.artist, prevTrack.artwork_url, prevTrack.duration);
    } else if (prevTrack && prevTrack.id) {
      playById(prevTrack.id);
    }
  }
});

window.addEventListener('beforeunload', () => {
  flushCurrentTrackPlayback('unload', false);
});

$('#progress').addEventListener('input', e => {
  if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
});

let lastUnmutedVolume = 1;
const volIcon = $('#vol-icon');
const volMuteBtn = $('#vol-mute-btn');

function updateVolumeUI(v) {
  const volSlider = $('#volume');
  if (volSlider) volSlider.value = v;
  if (volIcon) {
    if (v === 0 || audio.muted) volIcon.className = 'ph ph-speaker-slash';
    else if (v < 0.5) volIcon.className = 'ph ph-speaker-low';
    else volIcon.className = 'ph ph-speaker-high';
  }
}

function toggleMuteGlobal() {
  const volSlider = $('#volume');
  if (audio.muted || audio.volume === 0) {
    audio.muted = false;
    const restore = lastUnmutedVolume > 0 ? lastUnmutedVolume : 1;
    audio.volume = restore;
    updateVolumeUI(restore);
    notify(`Unmuted (${Math.round(restore * 100)}%)`);
  } else {
    lastUnmutedVolume = audio.volume > 0 ? audio.volume : 1;
    audio.muted = true;
    audio.volume = 0;
    updateVolumeUI(0);
    notify('Muted');
  }
}

$('#volume')?.addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  audio.volume = v;
  audio.muted = (v === 0);
  if (v > 0) lastUnmutedVolume = v;
  updateVolumeUI(v);
});

if (volMuteBtn) {
  volMuteBtn.addEventListener('click', () => {
    toggleMuteGlobal();
  });
}

// Studio FX Popover Launcher
const fxLauncherBtn = $('#fx-launcher-btn');
const fxPopover = $('#studio-fx-popover');

if (fxLauncherBtn && fxPopover) {
  fxLauncherBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isShown = fxPopover.classList.toggle('show');
    fxLauncherBtn.classList.toggle('open', isShown);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.fx-launcher-wrapper')) {
      fxPopover.classList.remove('show');
      fxLauncherBtn.classList.remove('open');
    }
  });

  fxPopover.querySelectorAll('.fx-popover-item').forEach(item => {
    if (item.id === 'norm-toggle-btn' || item.id === 'hover-preview-toggle-btn' || item.id === 'chameleon-toggle-btn' || item.id === 'karaoke-toggle-btn' || item.id === 'autodj-toggle-btn') return; // Keep popover open so user sees ON/OFF toggle state
    item.addEventListener('click', () => {
      fxPopover.classList.remove('show');
      fxLauncherBtn.classList.remove('open');
    });
  });

  const normToggleBtn = $('#norm-toggle-btn');
  if (normToggleBtn) {
    normToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAudioNormalization();
    });
  }

  const hoverPreviewToggleBtn = $('#hover-preview-toggle-btn');
  if (hoverPreviewToggleBtn) {
    hoverPreviewToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHoverPreview();
    });
  }

  const chameleonToggleBtn = $('#chameleon-toggle-btn');
  if (chameleonToggleBtn) {
    chameleonToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChameleonGlow();
    });
  }

  const karaokeToggleBtn = $('#karaoke-toggle-btn');
  if (karaokeToggleBtn) {
    karaokeToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleKaraokeMode();
    });
  }
}

// ---- Linus CMI Smart Shuffle (Taste Affinity & Artist Dispersion) ----
function smartShuffle(tracks, currentTrack = null) {
  if (!tracks || tracks.length <= 1) return [...(tracks || [])];
  if (tracks.length === 2) {
    return Math.random() > 0.5 ? [tracks[1], tracks[0]] : [...tracks];
  }

  const favoritesSet = new Set(state.favorites || []);
  const currentArtist = (currentTrack?.artist || queue[currentIndex]?.artist || '').trim().toLowerCase();

  // 1. Calculate smart weights for each candidate
  const scored = tracks.map(t => {
    let weight = 50.0;
    const isFav = favoritesSet.has(t.id);
    if (isFav) weight += 35.0;

    // Favor tracks with complete artwork or recognized artists
    if (t.has_artwork) weight += 10.0;
    const tArtist = (t.artist || '').trim().toLowerCase();
    if (tArtist && tArtist !== 'unknown' && tArtist !== 'local collection') {
      weight += 10.0;
    }

    // Small bonus if in user playlists
    for (const pName of Object.keys(state.playlists || {})) {
      if ((state.playlists[pName] || []).includes(t.id)) {
        weight += 15.0;
        break;
      }
    }

    // Stochastic temperature noise (+/- 25) so each shuffle click yields a fresh unique journey
    weight += (Math.random() - 0.5) * 50.0;

    return {
      track: t,
      artist: tArtist || 'unknown',
      weight: Math.max(5.0, weight)
    };
  });

  // Sort initially by calculated affinity weight
  scored.sort((a, b) => b.weight - a.weight);

  // 2. Artist Dispersion / Interleaving Constraint:
  // Strictly prevent adjacent tracks from having the same artist
  const result = [];
  const remaining = [...scored];
  let lastArtist = currentArtist;

  while (remaining.length > 0) {
    let pickIdx = remaining.findIndex(item => item.artist && item.artist !== lastArtist && item.artist !== 'unknown');
    if (pickIdx === -1) {
      // Fallback: pick any track if no different artist is available
      pickIdx = 0;
    }
    const chosen = remaining.splice(pickIdx, 1)[0];
    result.push(chosen.track);
    lastArtist = chosen.artist;
  }

  return result;
}

// ---- Shuffle / Repeat (Spotify-Grade Smart Queue Shuffle) ----
$('#shuffle-btn').addEventListener('click', () => {
  shuffleOn = !shuffleOn;
  $('#shuffle-btn').classList.toggle('control-active', shuffleOn);
  if (shuffleOn) {
    if (queue.length > currentIndex + 1) {
      const before = queue.slice(0, currentIndex + 1);
      const upcoming = queue.slice(currentIndex + 1);
      const currentTrack = queue[currentIndex];
      const shuffledUpcoming = smartShuffle(upcoming, currentTrack);
      queue = [...before, ...shuffledUpcoming];
      renderQueue();
    }
    notify('🔀 Smart Shuffle On — Dynamic taste weighting & artist dispersion');
  } else {
    notify('➡️ Shuffle Off — Sequential playback');
  }
});

$('#repeat-btn').addEventListener('click', () => {
  if (repeatMode === 'none') {
    repeatMode = 'all';
    $('#repeat-btn').classList.add('control-active');
    $('#repeat-btn').innerHTML = '<i class="ph-fill ph-repeat"></i>';
  } else if (repeatMode === 'all') {
    repeatMode = 'one';
    $('#repeat-btn').innerHTML = '<i class="ph-fill ph-repeat-once"></i>';
  } else {
    repeatMode = 'none';
    $('#repeat-btn').classList.remove('control-active');
    $('#repeat-btn').innerHTML = '<i class="ph ph-repeat"></i>';
  }
});

// ---- Playback Speed Engine -----------------------------------
const PLAYBACK_SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];
let currentSpeedIdx = 1;

function setPlaybackSpeed(newSpeed) {
  audio.playbackRate = newSpeed;
  audio.preservesPitch = true;
  audio.mozPreservesPitch = true;
  audio.webkitPreservesPitch = true;
  
  const btn = $('#playback-speed-btn');
  if (btn) {
    btn.textContent = `${newSpeed}x`;
    btn.title = `Playback Speed: ${newSpeed}x`;
  }
}

$('#playback-speed-btn')?.addEventListener('click', () => {
  currentSpeedIdx = (currentSpeedIdx + 1) % PLAYBACK_SPEEDS.length;
  const speed = PLAYBACK_SPEEDS[currentSpeedIdx];
  setPlaybackSpeed(speed);
  notify(`⚡ Playback speed: ${speed}x`);
});

// ---- 🎧 Feature 10: Smart Auto-DJ Beat-Matched Crossfader Engine ----
const AUTODJ_MODES = [4, 6, 8, 2, 0]; // seconds (0 = Off)
let autoDJDuration = parseInt(localStorage.getItem('linus_autodj_duration') || '4', 10);
let isAutoDJEnabled = localStorage.getItem('linus_autodj_enabled') !== 'false' && autoDJDuration > 0;

function updateAutoDJUI() {
  const badge = $('#autodj-status-badge');
  const sub = $('#autodj-status-sub');
  const toggleBtn = $('#autodj-toggle-btn');
  const quickBtn = $('#autodj-quick-btn');
  const fsBtn = $('#fs-autodj-btn');

  if (badge) {
    badge.textContent = isAutoDJEnabled ? `${autoDJDuration}s DJ` : 'OFF';
    badge.className = `norm-status-pill ${isAutoDJEnabled ? 'on' : 'off'}`;
  }
  if (sub) {
    sub.textContent = isAutoDJEnabled 
      ? `${autoDJDuration}s beat-matched equal-power blend` 
      : 'Standard instant cuts (no blend)';
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle('active', isAutoDJEnabled);
  }
  if (quickBtn) {
    quickBtn.classList.toggle('active', isAutoDJEnabled);
  }
  if (fsBtn) {
    fsBtn.classList.toggle('active', isAutoDJEnabled);
  }
}

function cycleAutoDJMode() {
  const curIdx = AUTODJ_MODES.indexOf(autoDJDuration);
  const nextIdx = (curIdx + 1) % AUTODJ_MODES.length;
  autoDJDuration = AUTODJ_MODES[nextIdx];
  isAutoDJEnabled = autoDJDuration > 0;
  localStorage.setItem('linus_autodj_duration', String(autoDJDuration));
  localStorage.setItem('linus_autodj_enabled', isAutoDJEnabled ? 'true' : 'false');
  updateAutoDJUI();
  if (isAutoDJEnabled) {
    notify(`🎧 Smart Auto-DJ: ${autoDJDuration}s Beat-Matched Blend`);
  } else {
    notify('🎧 Smart Auto-DJ: OFF (Standard Cuts)');
  }
}

function toggleAutoDJQuick() {
  if (isAutoDJEnabled) {
    isAutoDJEnabled = false;
  } else {
    isAutoDJEnabled = true;
    if (autoDJDuration <= 0) autoDJDuration = 4;
  }
  localStorage.setItem('linus_autodj_enabled', isAutoDJEnabled ? 'true' : 'false');
  localStorage.setItem('linus_autodj_duration', String(autoDJDuration));
  updateAutoDJUI();
  if (isAutoDJEnabled) {
    notify(`🎧 Smart Auto-DJ: ON (${autoDJDuration}s Beat-Matched Crossfader)`);
  } else {
    notify('🎧 Smart Auto-DJ: OFF');
  }
}

$('#autodj-toggle-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  cycleAutoDJMode();
});

$('#autodj-quick-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAutoDJQuick();
});

$('#fs-autodj-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAutoDJQuick();
});

updateAutoDJUI();

// ---- Queue --------------------------------------------------
$('#queue-toggle').addEventListener('click', () => $('#queue-drawer').classList.toggle('open'));
$('#queue-close').addEventListener('click', () => $('#queue-drawer').classList.remove('open'));

$('#queue-shuffle-btn')?.addEventListener('click', () => {
  if (queue.length <= 1) return notify('Queue is too short to shuffle.');
  const current = queue[currentIndex];
  const rest = queue.filter((_, idx) => idx !== currentIndex);
  const shuffledRest = smartShuffle(rest, current);
  queue = current ? [current, ...shuffledRest] : shuffledRest;
  currentIndex = 0;
  renderQueue();
  notify('🔀 Queue Smart-Shuffled (Artist dispersed)');
});

$('#queue-clear-btn')?.addEventListener('click', () => {
  if (queue.length === 0) return;
  const current = queue[currentIndex];
  queue = current ? [current] : [];
  currentIndex = 0;
  renderQueue();
  notify('🗑️ Queue cleared (except active track).');
});

let _draggedQueueIdx = null;

function renderQueue() {
  const list = $('#queue-list');
  if (!list) return;

  const remainingCount = Math.max(0, queue.length - (currentIndex + 1));
  const headerTitle = $('#queue-drawer .queue-header h2');
  if (headerTitle) {
    if (_activeRadioSeed && _activeRadioSeed.title) {
      const shortTitle = _activeRadioSeed.title.length > 20 ? _activeRadioSeed.title.slice(0, 18) + '...' : _activeRadioSeed.title;
      headerTitle.innerHTML = `📻 Radio: ${escapeHtml(shortTitle)} ${remainingCount > 0 ? `<span style="font-size:12px;font-weight:400;color:var(--text-muted);opacity:0.8;">(${remainingCount})</span>` : ''}`;
    } else {
      headerTitle.innerHTML = `Up next ${remainingCount > 0 ? `<span style="font-size:12px;font-weight:400;color:var(--text-muted);opacity:0.8;">(${remainingCount})</span>` : ''}`;
    }
  }

  const slice = queue.slice(currentIndex, currentIndex + 35);
  if (!slice.length) {
    list.innerHTML = '<p class="muted" style="text-align:center;padding:24px 0;">Queue is empty.</p>';
    return;
  }

  list.innerHTML = slice.map((t, i) => {
    const isPlaying = i === 0;
    const realIdx = currentIndex + i;
    const art = t.artwork_url 
      ? `<img src="${escapeHtml(t.artwork_url)}" style="width:34px;height:34px;border-radius:4px;object-fit:cover;">`
      : `<div style="width:34px;height:34px;border-radius:4px;background:rgba(255,255,255,0.06);display:grid;place-items:center;"><i class="ph-fill ph-music-note"></i></div>`;

    const badge = t.is_online
      ? `<span style="font-size:9px;padding:2px 6px;border-radius:10px;background:rgba(56,189,248,0.2);color:#38bdf8;font-weight:600;"><i class="ph-fill ph-globe"></i> YouTube</span>`
      : `<span style="font-size:9px;padding:2px 6px;border-radius:10px;background:rgba(52,211,153,0.2);color:#34d399;font-weight:600;"><i class="ph-fill ph-folder"></i> Local</span>`;

    const actions = !isPlaying ? `
      <div class="q-actions" style="display:flex;align-items:center;gap:4px;opacity:0.7;">
        <button class="q-action-btn q-move-up" data-idx="${realIdx}" title="Move up" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;padding:2px 4px;font-size:13px;border-radius:4px;${i === 1 ? 'visibility:hidden;' : ''}"><i class="ph ph-caret-up"></i></button>
        <button class="q-action-btn q-move-down" data-idx="${realIdx}" title="Move down" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;padding:2px 4px;font-size:13px;border-radius:4px;${i === slice.length - 1 ? 'visibility:hidden;' : ''}"><i class="ph ph-caret-down"></i></button>
        <button class="q-action-btn q-remove-item" data-idx="${realIdx}" title="Remove from queue" style="background:transparent;border:none;color:var(--text-muted);cursor:pointer;padding:2px 4px;font-size:13px;border-radius:4px;"><i class="ph ph-x"></i></button>
      </div>
    ` : '';

    return `
      <div class="queue-item ${isPlaying ? 'active' : ''}" data-id="${escapeHtml(t.id)}" data-idx="${realIdx}" draggable="${!isPlaying}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;transition:background 0.15s ease;">
        <span class="q-idx" style="font-size:12px;width:18px;text-align:center;">${isPlaying ? '<i class="ph-fill ph-speaker-high" style="color:var(--accent)"></i>' : i}</span>
        ${art}
        <div class="q-info" style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;">
          <strong style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.title)}</strong>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t.artist)}</span>
            ${badge}
          </div>
        </div>
        ${actions}
      </div>
    `;
  }).join('');

  // Click to play
  list.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.q-action-btn')) return;
      if (item.dataset.id !== queue[currentIndex]?.id) playById(item.dataset.id);
    });

    // Drag and drop reordering
    if (item.getAttribute('draggable') === 'true') {
      item.addEventListener('dragstart', (e) => {
        _draggedQueueIdx = parseInt(item.dataset.idx, 10);
        e.dataTransfer.effectAllowed = 'move';
        item.style.opacity = '0.4';
      });
      item.addEventListener('dragend', () => {
        item.style.opacity = '1';
        list.querySelectorAll('.queue-item').forEach(el => el.style.borderTop = '');
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.style.borderTop = '2px solid var(--accent)';
      });
      item.addEventListener('dragleave', () => {
        item.style.borderTop = '';
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.style.borderTop = '';
        const targetIdx = parseInt(item.dataset.idx, 10);
        if (_draggedQueueIdx !== null && _draggedQueueIdx !== targetIdx && targetIdx > currentIndex && _draggedQueueIdx > currentIndex) {
          const [moved] = queue.splice(_draggedQueueIdx, 1);
          queue.splice(targetIdx, 0, moved);
          renderQueue();
        }
      });
    }
  });

  // Remove from queue
  list.querySelectorAll('.q-remove-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      if (!isNaN(idx) && idx > currentIndex && idx < queue.length) {
        queue.splice(idx, 1);
        renderQueue();
        notify('Removed track from queue.');
      }
    });
  });

  // Move up
  list.querySelectorAll('.q-move-up').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      if (!isNaN(idx) && idx > currentIndex + 1 && idx < queue.length) {
        [queue[idx], queue[idx - 1]] = [queue[idx - 1], queue[idx]];
        renderQueue();
      }
    });
  });

  // Move down
  list.querySelectorAll('.q-move-down').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      if (!isNaN(idx) && idx > currentIndex && idx < queue.length - 1) {
        [queue[idx], queue[idx + 1]] = [queue[idx + 1], queue[idx]];
        renderQueue();
      }
    });
  });

  renderDashboardUpNext();
}

// ---- Favorites & Ecstatic Particle Burst -------------------
function syncNowPlayingFavorite(trackId) {
  if (!trackId && queue[currentIndex]) trackId = queue[currentIndex].id;
  if (!trackId) return;
  const isFav = state.favorites.includes(trackId);

  const heroFav = $('#hero-fav-btn');
  if (heroFav) {
    heroFav.innerHTML = `<i class="ph${isFav ? '-fill' : ''} ph-star" style="${isFav ? 'color:var(--accent);' : ''}"></i>`;
    heroFav.classList.toggle('active-fav', isFav);
  }

  const nowFav = $('#now-fav-btn');
  if (nowFav) {
    nowFav.innerHTML = `<i class="ph${isFav ? '-fill' : ''} ph-star" style="${isFav ? 'color:var(--accent);' : ''}"></i>`;
    nowFav.classList.toggle('active-fav', isFav);
  }

  const fsLike = $('#fs-like');
  if (fsLike) {
    fsLike.innerHTML = `<i class="ph${isFav ? '-fill' : ''} ph-star" style="${isFav ? 'color:var(--accent);' : ''}"></i>`;
    fsLike.classList.toggle('active-fav', isFav);
  }
}

function toggleFavorite(id, clickX, clickY) {
  const isFav = state.favorites.includes(id);
  if (isFav) {
    state.favorites = state.favorites.filter(k => k !== id);
    notify('Removed from Favorites');
  } else {
    state.favorites.push(id);
    notify('💖 Added to Favorites!');
    if (clickX && clickY) {
      spawnConfettiParticles(clickX, clickY);
    }
  }
  syncNowPlayingFavorite(id);
  saveState();
  renderTracks(state.tracks.filter(t => t.media_type !== 'video'));
}

// Add Currently Playing Track -> To Playlist
$('#hero-add-playlist')?.addEventListener('click', () => {
  const current = queue[currentIndex];
  if (!current) return notify('Play a song first to add it to a playlist.');
  openAddToPlaylistModal(current.id);
});

$('#now-add-playlist')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const current = queue[currentIndex];
  if (!current) return notify('Play a song first to add it to a playlist.');
  openAddToPlaylistModal(current.id);
});

$('#now-start-radio-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  startTrackRadio();
});

$('#fs-add-playlist')?.addEventListener('click', () => {
  const current = queue[currentIndex];
  if (!current) return notify('Play a song first to add it to a playlist.');
  openAddToPlaylistModal(current.id);
});

// Currently Playing Track -> Toggle Favorite
$('#hero-fav-btn')?.addEventListener('click', (e) => {
  const current = queue[currentIndex];
  if (!current) return notify('Play a song first to favorite.');
  const rect = e.currentTarget.getBoundingClientRect();
  toggleFavorite(current.id, rect.left + rect.width / 2, rect.top);
});

$('#now-fav-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const current = queue[currentIndex];
  if (!current) return notify('Play a song first to favorite.');
  const rect = e.currentTarget.getBoundingClientRect();
  toggleFavorite(current.id, rect.left + rect.width / 2, rect.top);
});

$('#fs-like')?.addEventListener('click', (e) => {
  const current = queue[currentIndex];
  if (!current) return notify('Play a song first to favorite.');
  const rect = e.currentTarget.getBoundingClientRect();
  toggleFavorite(current.id, rect.left + rect.width / 2, rect.top);
});

function spawnConfettiParticles(x, y) {
  const container = $('#vibe-confetti-container');
  if (!container) return;
  const count = 16;
  const icons = ['✨', '💖', '⭐', '💫', '🌸', '☕'];
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-particle';
    p.textContent = icons[Math.floor(Math.random() * icons.length)];
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
    const dist = 60 + Math.random() * 90;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist - 40;
    const tr = Math.floor(Math.random() * 80 - 40);
    p.style.setProperty('--tx', `${tx}px`);
    p.style.setProperty('--ty', `${ty}px`);
    p.style.setProperty('--tr', `${tr}deg`);
    p.style.fontSize = `${14 + Math.random() * 12}px`;
    container.appendChild(p);
    setTimeout(() => p.remove(), 1400);
  }
}
window.spawnConfettiParticles = spawnConfettiParticles;

// ---- Video Player -------------------------------------------
const vModal = $('#video-modal');
const vPlayer = $('#video-player');

function openVideoPlayer(id) {
  const t = trackById(id);
  if (!t) return;
  currentVideoTrack = t;
  audio.pause();
  $('#play').innerHTML = '<i class="ph-fill ph-play"></i>';
  $('#vinyl-record').classList.remove('playing');

  $('#video-modal-title').textContent = t.title;
  $('#video-modal-artist').textContent = t.artist;

  const ytPlayer = $('#youtube-video-player');
  if (ytPlayer) { ytPlayer.src = ''; ytPlayer.classList.add('hidden'); }
  vPlayer.classList.remove('hidden');
  vPlayer.src = t.url;
  vModal.classList.remove('hidden');
  vPlayer.play().catch(console.error);
}

function closeVideoModal() {
  if (vPlayer) { vPlayer.pause(); vPlayer.src = ''; }
  const ytPlayer = $('#youtube-video-player');
  if (ytPlayer) { ytPlayer.src = ''; ytPlayer.classList.add('hidden'); }
  vModal.classList.add('hidden');

  if (_ytCurrentStreamType === 'video') {
    _ytCurrentStreamId = '';
    _ytCurrentStreamType = '';
    _updateStreamButtonStates('idle');
    document.querySelectorAll('.explore-card').forEach(c => c.classList.remove('now-streaming'));
  }
  currentVideoTrack = null;
}

$('#video-modal-close').addEventListener('click', closeVideoModal);
$('#video-modal-backdrop').addEventListener('click', closeVideoModal);

// ---- Downloads ----------------------------------------------
$('#download-button').addEventListener('click', () => {
  closeSidebar();
  $('#download-sheet').showModal();
});
$('[value="cancel"]').addEventListener('click', (e) => {
  e.preventDefault(); $('#download-sheet').close();
});

$('#type-audio').addEventListener('click', () => {
  $('#type-audio').classList.add('active');
  $('#type-video').classList.remove('active');
  $('#audio-options').classList.remove('hidden');
  $('#video-options').classList.add('hidden');
});
$('#type-video').addEventListener('click', () => {
  $('#type-video').classList.add('active');
  $('#type-audio').classList.remove('active');
  $('#video-options').classList.remove('hidden');
  $('#audio-options').classList.add('hidden');
});

$('#download-form').addEventListener('submit', async e => {
  e.preventDefault();
  const submit  = $('#download-submit');
  const cancelBtn = $('#download-cancel');
  const note    = $('#download-note');
  const wrap    = $('#dl-progress-wrap');
  const isVideo = $('#type-video').classList.contains('active');

  submit.classList.add('hidden');
  cancelBtn.classList.remove('hidden');
  wrap.classList.remove('hidden');
  $('#dl-progress-fill').style.width = '2%';
  note.textContent = 'Fetching metadata...';

  const payload = {
    url:        $('#download-url').value.trim(),
    media_type: isVideo ? 'video' : 'audio',
    category:   $('#download-category').value.trim(),
  };

  if (isVideo) {
    payload.format  = $('#download-video-format').value;
    payload.quality = $('#download-video-quality').value;
  } else {
    payload.format  = $('#download-format').value;
    payload.quality = $('#download-quality').value;
  }

  try {
    const data = await api('/api/download', { method: 'POST', body: JSON.stringify(payload) });
    activeJobId = data.job_id;
    startProgressSSE(activeJobId);
  } catch (err) {
    note.textContent = `Error: ${err.message}`;
    submit.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
  }
});

$('#download-cancel').addEventListener('click', async () => {
  if (activeJobId) {
    try {
      await api(`/api/download/cancel/${activeJobId}`, { method: 'POST' });
      notify('Download cancelled.');
      if (progressSSE) progressSSE.close();
      $('#download-submit').classList.remove('hidden');
      $('#download-cancel').classList.add('hidden');
      $('#dl-progress-wrap').classList.add('hidden');
      $('#download-note').textContent = 'Saved to downloads folder.';
    } catch (err) { notify('Failed to cancel.'); }
  }
});

function startProgressSSE(jobId) {
  if (progressSSE) progressSSE.close();
  progressSSE = new EventSource(`/api/download/progress/${jobId}`);

  progressSSE.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.status === 'queued') return;

    if (d.status === 'error') {
      $('#dl-progress-label').textContent = 'Error: ' + (d.error || 'Download failed');
      $('#download-submit').classList.remove('hidden');
      $('#download-cancel').classList.add('hidden');
      progressSSE.close();
      return;
    }

    $('#dl-progress-fill').style.width = d.percent + '%';
    if (d.status === 'downloading') {
      $('#dl-progress-label').textContent = `${d.title ? d.title.substring(0,30)+'...' : 'Downloading'} - ${d.percent}% (${d.speed} - ETA ${d.eta})`;
    } else if (d.status === 'processing') {
      $('#dl-progress-label').textContent = `Processing and extracting metadata...`;
    }
  };

  // Named 'done' event — auto-refresh library
  progressSSE.addEventListener('done', () => {
    $('#dl-progress-label').textContent = 'Complete!';
    progressSSE.close();
    setTimeout(() => {
      $('#download-sheet').close();
      $('#download-submit').classList.remove('hidden');
      $('#download-cancel').classList.add('hidden');
      $('#dl-progress-wrap').classList.add('hidden');
      $('#download-url').value = '';
      pollDownloadsStatus(jobId);
    }, 1500);
  });

  // Named 'cancelled' event — reset UI immediately
  progressSSE.addEventListener('cancelled', () => {
    progressSSE.close();
    $('#dl-progress-label').textContent = 'Download cancelled.';
    $('#download-submit').classList.remove('hidden');
    $('#download-cancel').classList.add('hidden');
    $('#dl-progress-wrap').classList.add('hidden');
  });

  // Network error fallback
  progressSSE.onerror = () => {
    progressSSE.close();
    $('#dl-progress-label').textContent = 'Connection lost. Check Downloads tab for status.';
    $('#download-submit').classList.remove('hidden');
    $('#download-cancel').classList.add('hidden');
  };
}

async function pollDownloadsStatus(jobId) {
  try {
    const data = await api(`/api/download/status/${jobId}`);
    if (data.status === 'done') {
      notify('Download complete!');
      hydrate(data); // data has {tracks, state, categories} at top level
    } else {
      setTimeout(() => pollDownloadsStatus(jobId), 1000);
    }
  } catch (e) {
    notify('Finished but failed to refresh library.');
  }
}

async function renderDownloadsView() {
  const list = $('#downloads-list');
  try {
    const data = await api('/api/downloads');
    const jobs = data.jobs || [];
    $('#downloads-count').textContent = `${jobs.length} task${jobs.length===1?'':'s'}`;
    list.innerHTML = jobs.reverse().map(j => `
      <div class="dl-job-row">
        <div class="dl-job-top">
          <strong title="${escapeHtml(j.url)}">${escapeHtml(j.title || j.id)}</strong>
          <span class="dl-status" style="color:${j.status==='done'?'#8de0c0':j.status==='error'?'#ff6b5f':'var(--accent)'}">${j.status}</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);display:flex;gap:12px;">
          <span>${j.media_type.toUpperCase()} / ${j.format.toUpperCase()}</span>
          ${j.category ? `<span>CAT: ${escapeHtml(j.category)}</span>` : ''}
          ${j.status === 'downloading' ? `<span>${j.percent}% · ${j.speed} · ETA ${j.eta}</span>` : ''}
          ${j.status === 'error' ? `<span style="color:#ff6b5f">${escapeHtml(j.error)}</span>` : ''}
        </div>
        ${j.status !== 'error' && j.status !== 'done' ? `
          <div class="dl-progress-bar"><div class="dl-progress-fill" style="width:${j.percent}%"></div></div>
        ` : ''}
      </div>
    `).join('');
  } catch (e) { list.innerHTML = '<p class="muted">Failed to load history.</p>'; }
}

$('#refresh-downloads').addEventListener('click', renderDownloadsView);

// ---- YouTube Explore & Instant 1-Click Download + Stream -----

// Pagination state
let _ytSearchQuery = '';
let _ytSearchOffset = 0;
const _YT_PAGE_SIZE = 12;
let _ytCurrentStreamId = '';
let _ytCurrentStreamType = '';
let _ytCurrentStreamTrack = null;

function getActivePlaybackTrack() {
  if (_ytCurrentStreamId && _ytCurrentStreamTrack) {
    return _ytCurrentStreamTrack;
  }
  return queue[currentIndex] || null;
}

function _buildExploreCardHTML(item) {
  const isStreaming = item.id && item.id === _ytCurrentStreamId;
  const isAudioPlaying = isStreaming && _ytCurrentStreamType === 'audio';
  const isVideoPlaying = isStreaming && _ytCurrentStreamType === 'video';

  return `
    <div class="explore-card${isStreaming ? ' now-streaming' : ''}" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title)}" data-vid="${escapeHtml(item.id)}">
      <div class="explore-card-thumb">
        <img src="${escapeHtml(item.thumbnail)}" alt="Thumbnail" loading="lazy">
        ${item.duration_string ? `<span class="explore-dur-badge">${escapeHtml(item.duration_string)}</span>` : ''}
      </div>
      <div class="explore-card-body">
        <div class="explore-card-info">
          <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
          <span><i class="ph ph-youtube-logo" style="color:#ff4444;margin-right:4px;"></i>${escapeHtml(item.artist)}</span>
        </div>
        <div class="explore-card-quick">
          <button class="explore-stream-btn${isAudioPlaying ? ' is-playing' : ''}" data-vid="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" data-artist="${escapeHtml(item.artist)}" data-thumb="${escapeHtml(item.thumbnail)}" data-dur="${item.duration || 0}" title="Stream Audio">
            <i class="ph-fill ${isAudioPlaying ? 'ph-pause' : 'ph-play'}"></i>
          </button>
          <button class="explore-preview-btn" data-vid="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" data-artist="${escapeHtml(item.artist)}" data-thumb="${escapeHtml(item.thumbnail)}" data-dur="${item.duration || 0}" title="Quick 20s Preview">
            <i class="ph-bold ph-speaker-simple-high"></i>
          </button>
          <button class="explore-radio-btn" data-vid="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" data-artist="${escapeHtml(item.artist)}" data-thumb="${escapeHtml(item.thumbnail)}" data-dur="${item.duration || 0}" title="Start Radio from this track">
            <i class="ph-bold ph-radio"></i>
          </button>
          <button class="explore-video-stream-btn${isVideoPlaying ? ' is-playing' : ''}" data-vid="${escapeHtml(item.id)}" data-title="${escapeHtml(item.title)}" data-artist="${escapeHtml(item.artist)}" data-thumb="${escapeHtml(item.thumbnail)}" data-dur="${item.duration || 0}" title="Stream Video">
            <i class="ph-fill ph-monitor-play"></i>
            <span>Video</span>
          </button>
          <button class="explore-expand-btn" title="Download options">
            <i class="ph ph-download-simple"></i>
          </button>
        </div>
        <div class="explore-card-expand hidden">
          <div class="explore-expand-label"><i class="ph ph-download-simple"></i> Download Options</div>
          <div class="explore-expand-actions">
            <button class="explore-dl-btn dl-mp3-btn" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title)}">
              <i class="ph ph-music-notes"></i> MP3
            </button>
            <button class="explore-dl-btn dl-mp4-btn" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title)}">
              <i class="ph ph-video-camera"></i> MP4
            </button>
            <button class="explore-dl-btn btn-custom dl-custom-btn" data-url="${escapeHtml(item.url)}" title="Custom Quality / Format">
              <i class="ph ph-gear"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function _attachExploreCardHandlers(container) {
  // Clicking anywhere on card (except buttons) toggles the download options
  container.querySelectorAll('.explore-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const expandSection = card.querySelector('.explore-card-expand');
      const expandBtn = card.querySelector('.explore-expand-btn');
      const isOpen = !expandSection.classList.contains('hidden');

      container.querySelectorAll('.explore-card-expand').forEach(sec => sec.classList.add('hidden'));
      container.querySelectorAll('.explore-expand-btn').forEach(btn => btn.classList.remove('active'));

      if (!isOpen) {
        expandSection.classList.remove('hidden');
        if (expandBtn) expandBtn.classList.add('active');
      }
    });
  });

  // Stream Audio buttons
  container.querySelectorAll('.explore-stream-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = btn.dataset.vid;
      if (_ytCurrentStreamId === vid && _ytCurrentStreamType === 'audio') {
        togglePlayGlobal();
        return;
      }
      streamYouTubeAudio(vid, btn.dataset.title, btn.dataset.artist, btn.dataset.thumb, parseFloat(btn.dataset.dur) || 0);
    });
  });

  // Stream Video buttons
  container.querySelectorAll('.explore-video-stream-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const vid = btn.dataset.vid;
      streamYouTubeVideo(vid, btn.dataset.title, btn.dataset.artist, btn.dataset.thumb, parseFloat(btn.dataset.dur) || 0);
    });
  });

  // 20s Quick Preview buttons
  container.querySelectorAll('.explore-preview-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const card = btn.closest('.explore-card');
      if (card) {
        toggleTrackAudioPreview(card, btn);
      }
    });
  });

  // Start Radio buttons
  container.querySelectorAll('.explore-radio-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ytItem = {
        id: `yt:${btn.dataset.vid}`,
        video_id: btn.dataset.vid,
        title: btn.dataset.title,
        artist: btn.dataset.artist,
        artwork_url: btn.dataset.thumb,
        duration: parseFloat(btn.dataset.dur) || 0,
        is_online: true
      };
      startTrackRadio(ytItem);
    });
  });

  // Expand / Download toggle button
  container.querySelectorAll('.explore-expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.explore-card');
      const expandSection = card.querySelector('.explore-card-expand');
      const isOpen = !expandSection.classList.contains('hidden');

      container.querySelectorAll('.explore-card-expand').forEach(sec => sec.classList.add('hidden'));
      container.querySelectorAll('.explore-expand-btn').forEach(b => b.classList.remove('active'));

      if (!isOpen) {
        expandSection.classList.remove('hidden');
        btn.classList.add('active');
      }
    });
  });

  // MP3 download buttons
  container.querySelectorAll('.dl-mp3-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerInstantDownload(btn.dataset.url, 'audio', 'mp3', '320', btn.dataset.title);
    });
  });

  // MP4 download buttons
  container.querySelectorAll('.dl-mp4-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerInstantDownload(btn.dataset.url, 'video', 'mp4', '720', btn.dataset.title);
    });
  });

  // Custom download buttons
  container.querySelectorAll('.dl-custom-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      $('#download-url').value = btn.dataset.url;
      $('#download-sheet').showModal();
    });
  });
}

async function searchYouTube(query, append = false) {
  if (!query || !query.trim()) return;
  const q = query.trim();
  const loading = $('#explore-loading');
  const resultsContainer = $('#explore-results');
  const loadMoreContainer = $('#explore-load-more');

  if (!append) {
    _ytSearchQuery = q;
    _ytSearchOffset = 0;
    loading.classList.remove('hidden');
    resultsContainer.innerHTML = '';
    loadMoreContainer.classList.add('hidden');
  }

  try {
    const data = await api(`/api/youtube/search?q=${encodeURIComponent(q)}&limit=${_YT_PAGE_SIZE}&offset=${_ytSearchOffset}`);
    loading.classList.add('hidden');
    const results = data.results || [];

    if (results.length === 0 && !append) {
      resultsContainer.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;"><i class="ph ph-magnifying-glass empty-icon"></i><h3>No results found</h3><p>Try searching for a different song, artist or genre name.</p></div>`;
      loadMoreContainer.classList.add('hidden');
      return;
    }

    const newCardsHTML = results.map(item => _buildExploreCardHTML(item)).join('');

    if (append) {
      const temp = document.createElement('div');
      temp.innerHTML = newCardsHTML;
      const newCards = Array.from(temp.children);
      newCards.forEach(card => resultsContainer.appendChild(card));
      _attachExploreCardHandlers(resultsContainer);
    } else {
      resultsContainer.innerHTML = newCardsHTML;
      _attachExploreCardHandlers(resultsContainer);
    }

    _ytSearchOffset += results.length;
    if (results.length >= _YT_PAGE_SIZE) {
      loadMoreContainer.classList.remove('hidden');
    } else {
      loadMoreContainer.classList.add('hidden');
    }
  } catch (e) {
    console.error('YouTube search error:', e);
    loading.classList.add('hidden');
    notify('Failed to search YouTube.');
  }
}

async function streamYouTubeAudio(videoId, title, artist, thumbnail, duration) {
  stopHoverPreview();
  if (!videoId) return;

  const vp = $('#video-player');
  if (vp) { vp.pause(); vp.src = ''; }
  const ytPlayer = $('#youtube-video-player');
  if (ytPlayer) { ytPlayer.src = ''; ytPlayer.classList.add('hidden'); }
  $('#video-modal')?.classList.add('hidden');

  _ytCurrentStreamId = videoId;
  _ytCurrentStreamType = 'audio';
  _updateStreamButtonStates('buffering');

  document.querySelectorAll('.explore-card').forEach(c => c.classList.remove('now-streaming'));
  const activeCard = document.querySelector(`.explore-card[data-vid="${videoId}"]`);
  if (activeCard) activeCard.classList.add('now-streaming');

  const ytTrack = {
    id: `yt:${videoId}`,
    title: title || 'YouTube Stream',
    artist: artist || 'YouTube',
    album: 'YouTube',
    extension: 'stream',
    duration: duration || 0,
    has_artwork: !!thumbnail,
    artwork_url: thumbnail || '',
    media_type: 'audio',
    is_online: true,
    _isYouTubeStream: true,
  };
  _lastPrewarmedTrackId = null;
  startTrackingTrackPlayback(ytTrack, 'youtube_stream');
  // Check if this song is already in the upcoming precomputed queue
  const existingIdx = queue.findIndex(t => t.id === ytTrack.id);
  if (existingIdx >= 0) {
    currentIndex = existingIdx;
    queue[currentIndex] = { ...queue[currentIndex], ...ytTrack };
    renderQueue();
    populate25SongQueue(false);
  } else {
    // Starting a fresh track from search/explore: initialize new 25-song radio queue
    queue = [ytTrack];
    currentIndex = 0;
    renderQueue();
    populate25SongQueue(true);
  }

  // Immediately load & stream synchronized lyrics for this YouTube song
  loadLyricsInline(ytTrack);

  $('#now-title').textContent = ytTrack.title;
  $('#now-artist').textContent = ytTrack.artist;
  if (thumbnail) {
    $('#now-art').innerHTML = `<img src="${escapeHtml(thumbnail)}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    $('#album-art-box').innerHTML = `<img src="${escapeHtml(thumbnail)}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:50%;box-shadow:0 0 20px rgba(0,0,0,0.6);">`;
  } else {
    $('#now-art').innerHTML = `<i class="ph-fill ph-music-notes"></i>`;
    $('#album-art-box').innerHTML = `<i class="ph-fill ph-music-notes-simple"></i>`;
  }

  $('#hero-title').innerHTML = `${escapeHtml(ytTrack.title)}<br><em>is streaming.</em>`;
  $('#hero-artist').textContent = `${ytTrack.artist} · YouTube`;
  const durStr = duration ? ` · ${formatTime(duration)}` : '';
  $('#hero-format').textContent = `STREAM · Best Quality${durStr}`;

  $('#current-time').textContent = '0:00';
  if (duration > 0) {
    $('#total-time').textContent = formatTime(duration);
    $('#progress').value = 0;
  }

  const colors = [
    ['#1a1a2e', '#0f3460'], ['#2d4059', '#ea5455'],
    ['#111113', '#2a2a35'], ['#2c3e50', '#3498db'],
    ['#0b0b0c', '#d4b07a'], ['#1C1C21', '#8FA998']
  ];
  const [c1, c2] = colors[Math.floor(Math.random() * colors.length)];
  $('#vinyl-record').style.background = `linear-gradient(135deg, ${c1}, ${c2})`;

  notify(`▶ Streaming "${(title || '').slice(0, 30)}..."`);

  try {
    initAudioContext();
    audio.pause();
    audio.src = `/api/youtube/stream/${encodeURIComponent(videoId)}`;
    audio.load();

    const playPromise = audio.play();
    if (playPromise) {
      playPromise.then(() => {
        _updateStreamButtonStates('playing');
        $('#vinyl-record').classList.add('playing');
        $('#hero-now-playing-card')?.classList.add('playing');
        const npBar = $('#hero-np-bar');
        if (npBar) npBar.style.width = '0%';
        $('#play').innerHTML = '<i class="ph-fill ph-pause"></i>';
        if ($('#hero-play')) $('#hero-play').innerHTML = '<i class="ph-fill ph-pause-circle"></i>';
        $('#fs-play').innerHTML = '<i class="ph-fill ph-pause"></i>';
        applyChameleonPalette(ytTrack);
        updateFullscreenUI(ytTrack);
        updateRecDashboardPlayingState(ytTrack.id); // highlight rec-card
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: ytTrack.title,
            artist: ytTrack.artist,
            artwork: thumbnail ? [{ src: thumbnail, sizes: '512x512', type: 'image/jpeg' }] : [],
          });
        }
      }).catch(err => {
        console.warn('Stream autoplay blocked:', err);
        _updateStreamButtonStates('paused');
      });
    }

    const onError = () => {
      if (_ytCurrentStreamId === videoId) {
        notify('⚠️ Playback failed. If YouTube blocked the track, add cookies.txt.');
        _ytCurrentStreamId = '';
        _ytCurrentStreamType = '';
        _ytCurrentStreamTrack = null;
        _updateStreamButtonStates('idle');
        $('#vinyl-record')?.classList.remove('playing');
        $('#hero-now-playing-card')?.classList.remove('playing');
        if ($('#play')) $('#play').innerHTML = '<i class="ph-fill ph-play"></i>';
      }
      audio.removeEventListener('error', onError);
    };
    audio.addEventListener('error', onError, { once: true });

    const onEnded = () => {
      _ytCurrentStreamId = '';
      _ytCurrentStreamType = '';
      _ytCurrentStreamTrack = null;
      _updateStreamButtonStates('idle');
      document.querySelectorAll('.explore-card').forEach(c => c.classList.remove('now-streaming'));
      if (audio.paused) {
        $('#vinyl-record').classList.remove('playing');
        $('#hero-now-playing-card')?.classList.remove('playing');
        if ($('#hero-play')) $('#hero-play').innerHTML = '<i class="ph-fill ph-play-circle"></i>';
      }
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
    audio.addEventListener('ended', onEnded);

  } catch (err) {
    notify('Could not stream audio. Try again.');
    _ytCurrentStreamId = '';
    _ytCurrentStreamType = '';
    _ytCurrentStreamTrack = null;
    _updateStreamButtonStates('idle');
  }
}

async function streamYouTubeVideo(videoId, title, artist, thumbnail = '', duration = 0) {
  if (!videoId) return;

  // Pause audio playback
  audio.pause();
  $('#play').innerHTML = '<i class="ph-fill ph-play"></i>';
  $('#vinyl-record').classList.remove('playing');

  _ytCurrentStreamId = videoId;
  _ytCurrentStreamType = 'video';
  _updateStreamButtonStates('playing');

  document.querySelectorAll('.explore-card').forEach(c => c.classList.remove('now-streaming'));
  const activeCard = document.querySelector(`.explore-card[data-vid="${videoId}"]`);
  if (activeCard) activeCard.classList.add('now-streaming');

  notify(`🎬 Playing video "${(title || '').slice(0, 30)}..."`);

  const vModal = $('#video-modal');
  const vPlayer = $('#video-player');
  const ytPlayer = $('#youtube-video-player');

  $('#video-modal-title').textContent = title || 'YouTube Video';
  $('#video-modal-artist').textContent = artist || 'YouTube';

  // Watch on YouTube button link
  const ytLink = $('#video-modal-yt-link');
  if (ytLink) ytLink.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  // Stream Audio fallback button
  const audioBtn = $('#video-modal-stream-audio');
  if (audioBtn) {
    audioBtn.onclick = () => {
      closeVideoModal();
      streamYouTubeAudio(videoId, title, artist, thumbnail, duration);
    };
  }

  // Hide native video player, show YouTube iframe
  if (vPlayer) { vPlayer.pause(); vPlayer.src = ''; vPlayer.classList.add('hidden'); }
  if (ytPlayer) {
    ytPlayer.classList.remove('hidden');
    ytPlayer.src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;
  }

  vModal.classList.remove('hidden');
}

function _updateStreamButtonStates(mode) {
  document.querySelectorAll('.explore-stream-btn, .explore-video-stream-btn').forEach(btn => {
    const vid = btn.dataset.vid;
    const icon = btn.querySelector('i');
    const isAudioBtn = btn.classList.contains('explore-stream-btn');
    const isVideoBtn = btn.classList.contains('explore-video-stream-btn');

    btn.classList.remove('is-buffering', 'is-playing');

    if (vid === _ytCurrentStreamId) {
      if (isAudioBtn && _ytCurrentStreamType === 'audio') {
        if (mode === 'buffering') {
          btn.classList.add('is-buffering');
          if (icon) icon.className = 'ph ph-spinner-gap';
        } else if (mode === 'playing') {
          btn.classList.add('is-playing');
          if (icon) icon.className = 'ph-fill ph-pause';
        } else if (mode === 'paused') {
          btn.classList.add('is-playing');
          if (icon) icon.className = 'ph-fill ph-play';
        } else {
          if (icon) icon.className = 'ph-fill ph-play';
        }
      } else if (isVideoBtn && _ytCurrentStreamType === 'video') {
        if (mode === 'buffering') {
          btn.classList.add('is-buffering');
          if (icon) icon.className = 'ph ph-spinner-gap';
        } else if (mode === 'playing' || mode === 'paused') {
          btn.classList.add('is-playing');
          if (icon) icon.className = 'ph-fill ph-monitor-play';
        } else {
          if (icon) icon.className = 'ph-fill ph-monitor-play';
        }
      } else {
        if (isAudioBtn && icon) icon.className = 'ph-fill ph-play';
        if (isVideoBtn && icon) icon.className = 'ph-fill ph-monitor-play';
      }
    } else {
      if (isAudioBtn && icon) icon.className = 'ph-fill ph-play';
      if (isVideoBtn && icon) icon.className = 'ph-fill ph-monitor-play';
    }
  });
}

// Keep stream button states in sync with audio play/pause
(function() {
  const audio = document.querySelector('audio');
  if (audio) {
    audio.addEventListener('play', () => {
      if (_ytCurrentStreamId) _updateStreamButtonStates('playing');
    });
    audio.addEventListener('pause', () => {
      if (_ytCurrentStreamId) _updateStreamButtonStates('paused');
    });
  }
})();


async function triggerInstantDownload(url, mediaType, format, quality, title) {
  notify(`Starting download for "${title.slice(0, 24)}..."`);
  try {
    const res = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        url: url,
        media_type: mediaType,
        format: format,
        quality: quality,
        category: 'YouTube Explore'
      })
    });

    if (res.job_id) {
      notify(`Download started in background! (${mediaType.toUpperCase()} ${quality})`);
      trackBackgroundDownload(res.job_id, title);
    }
  } catch (err) {
    notify('Could not start download.');
  }
}

function trackBackgroundDownload(jobId, title) {
  const sse = new EventSource(`/api/download/progress/${jobId}`);
  sse.addEventListener('done', () => {
    sse.close();
    notify(`🎉 Finished downloading "${title.slice(0, 28)}"!`);
    pollDownloadsStatus(jobId); // Refresh library automatically
  });
  sse.addEventListener('cancelled', () => {
    sse.close();
    notify(`Download cancelled: "${title.slice(0, 28)}"`);
  });
  sse.addEventListener('error_event', (e) => {
    sse.close();
    notify(`Download error: ${e.data || 'Unknown error'}`);
  });
  sse.onerror = () => {
    sse.close();
    // Silently close — background downloads don't need to alert on network issues
  };
}

// Explore Search Bindings
$('#explore-submit-btn').addEventListener('click', () => {
  searchYouTube($('#explore-input').value);
});
$('#explore-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchYouTube($('#explore-input').value);
  }
});
document.querySelectorAll('.explore-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    $('#explore-input').value = tag.dataset.q;
    searchYouTube(tag.dataset.q);
  });
});

// Load More button binding
$('#explore-load-more-btn').addEventListener('click', () => {
  const btn = $('#explore-load-more-btn');
  btn.classList.add('is-loading');
  btn.querySelector('i').className = 'ph ph-spinner-gap';
  btn.querySelector('span').textContent = 'Loading...';
  searchYouTube(_ytSearchQuery, true).finally(() => {
    btn.classList.remove('is-loading');
    btn.querySelector('i').className = 'ph ph-arrow-down';
    btn.querySelector('span').textContent = 'Load More';
  });
});

// Topbar Search Enter binding
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = $('#search').value.trim();
    if (q) {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-view="explore"]').classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
      $('#explore-view').classList.remove('hidden');
      $('#explore-input').value = q;
      searchYouTube(q);
    }
  }
});

// ---- Synchronized Karaoke Lyrics Engine ----------------------
let currentLyricsData = { found: false, synced: false, lines: [], plain: '' };
let lastActiveLyricIdx = -1;

$('#hero-lyrics').addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="lyrics"]')?.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('#lyrics-view')?.classList.remove('hidden');
  const t = getActivePlaybackTrack();
  if (t) loadLyricsInline(t);
});

$('#lyrics-tab-karaoke').addEventListener('click', () => {
  $('#lyrics-tab-karaoke').classList.add('active');
  $('#lyrics-tab-editor').classList.remove('active');
  $('#karaoke-live-stage').classList.remove('hidden');
  $('#lyrics-editor-wrap').classList.add('hidden');
});

$('#lyrics-tab-editor').addEventListener('click', () => {
  $('#lyrics-tab-editor').classList.add('active');
  $('#lyrics-tab-karaoke').classList.remove('active');
  $('#lyrics-editor-wrap').classList.remove('hidden');
  $('#karaoke-live-stage').classList.add('hidden');
});

function updateLyricsBadge(source, synced) {
  const badge = $('#lyrics-source-badge');
  if (!badge) return;
  if (!source || source === 'none') {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');
  let label = source.toUpperCase();
  if (source === 'lrclib') label = synced ? 'LRCLIB (Synced)' : 'LRCLIB (Plain)';
  else if (source === 'netease') label = 'NetEase (Synced)';
  else if (source === 'local') label = 'Local .LRC';
  else if (source === 'local_cache') label = synced ? 'Disk Cache (Synced)' : 'Disk Cache (Plain)';
  else if (source === 'custom') label = 'Custom Saved';
  else if (source === 'lyrics.ovh') label = 'Lyrics.ovh (Plain)';
  badge.innerHTML = `<i class="ph${synced ? '-fill ph-lightning' : ' ph-file-text'}"></i> ${label}`;
}

async function loadLyricsInline(track) {
  if (!track) return;
  $('#lyrics-title').textContent = track.title;
  $('#lyrics-artist').textContent = track.artist;
  $('#lyrics-editor').value = state.lyrics[track.id] || '';
  lastActiveLyricIdx = -1;
  currentLyricsData = { found: false, synced: false, lines: [], plain: '' };

  const stageContainers = [$('#karaoke-lines-container'), $('#fs-karaoke-stream'), $('#stage-lyrics-stream')].filter(Boolean);
  stageContainers.forEach(c => {
    c.innerHTML = '<p class="karaoke-empty">Streaming synchronized lyrics...</p>';
  });

  // If user saved custom lyrics for this track, show it immediately
  if (state.lyrics[track.id]) {
    const isSynced = state.lyrics[track.id].includes('[') && state.lyrics[track.id].includes(']');
    updateLyricsBadge('custom', isSynced);
    renderKaraokeLines({ found: true, synced: isSynced, plain: state.lyrics[track.id], lines: [] });
  } else {
    updateLyricsBadge('none', false);
  }

  try {
    const data = await api(`/api/lyrics?artist=${encodeURIComponent(track.artist)}&title=${encodeURIComponent(track.title)}&file_path=${encodeURIComponent(track.id)}`);
    currentLyricsData = data;
    if (data.found) {
      updateLyricsBadge(data.source, data.synced);
      renderKaraokeLines(data);
      if (!state.lyrics[track.id] && data.plain) {
        $('#lyrics-editor').value = data.plain;
      }
    } else if (!state.lyrics[track.id]) {
      updateLyricsBadge('none', false);
      stageContainers.forEach(c => {
        c.innerHTML = '<p class="karaoke-empty">No lyrics found automatically. Click "Search Lyrics" to find manually.</p>';
      });
    }
  } catch (e) {
    if (!state.lyrics[track.id]) {
      updateLyricsBadge('none', false);
      stageContainers.forEach(c => {
        c.innerHTML = '<p class="karaoke-empty">Could not load lyrics. Try searching manually.</p>';
      });
    }
  }
}

function renderKaraokeLines(data) {
  const stageContainers = [$('#karaoke-lines-container'), $('#fs-karaoke-stream'), $('#stage-lyrics-stream')].filter(Boolean);
  if (data.synced && data.lines && data.lines.length > 0) {
    const html = data.lines.map((l, i) => `
      <div class="karaoke-line future-line" data-idx="${i}" data-time="${l.time}">
        ${escapeHtml(l.text || '♪')}
      </div>
    `).join('');
    stageContainers.forEach(c => {
      c.innerHTML = html;
      c.querySelectorAll('.karaoke-line').forEach(el => {
        el.addEventListener('click', () => {
          const t = parseFloat(el.getAttribute('data-time'));
          if (Number.isFinite(t)) {
            audio.currentTime = t;
            if (audio.paused) togglePlayGlobal();
          }
        });
      });
    });
    updateKaraokeHighlight(audio.currentTime);
  } else if (data.plain) {
    const plainLines = data.plain.split('\n').filter(l => l.trim().length > 0);
    const html = plainLines.map(l => `<div class="karaoke-line past-line">${escapeHtml(l)}</div>`).join('');
    stageContainers.forEach(c => { c.innerHTML = html; });
  }
}

function updateKaraokeHighlight(currentTime) {
  if (!currentLyricsData || !currentLyricsData.synced || !currentLyricsData.lines || currentLyricsData.lines.length === 0) return;
  const lines = currentLyricsData.lines;
  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (currentTime >= lines[i].time) {
      activeIdx = i;
    } else {
      break;
    }
  }

  if (activeIdx === lastActiveLyricIdx) return;
  lastActiveLyricIdx = activeIdx;

  const stageContainers = [$('#karaoke-lines-container'), $('#fs-karaoke-stream'), $('#stage-lyrics-stream')].filter(Boolean);
  stageContainers.forEach(c => {
    const domLines = c.querySelectorAll('.karaoke-line');
    domLines.forEach((el, idx) => {
      if (idx === activeIdx) {
        el.className = 'karaoke-line active-line';
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (idx < activeIdx) {
        el.className = 'karaoke-line past-line';
      } else {
        el.className = 'karaoke-line future-line';
      }
    });
  });
}

$('#save-lyrics').addEventListener('click', async () => {
  const t = getActivePlaybackTrack();
  if (!t) return notify('Play a song first.');
  const text = $('#lyrics-editor').value;
  try {
    const res = await api('/api/lyrics/save', {
      method: 'POST',
      body: JSON.stringify({
        track_id: t.id,
        artist: t.artist,
        title: t.title,
        content: text
      })
    });
    state.lyrics[t.id] = text;
    notify('Lyrics saved to disk & library.');
    if (res.lyrics) {
      currentLyricsData = res.lyrics;
      updateLyricsBadge('custom', res.lyrics.synced);
      renderKaraokeLines(res.lyrics);
    }
  } catch (err) {
    state.lyrics[t.id] = text;
    saveState();
    notify('Lyrics saved locally.');
  }
});

$('#fetch-lyrics-btn').addEventListener('click', async () => {
  const t = getActivePlaybackTrack();
  if (!t) return notify('Play a song first.');
  notify('Fetching lyrics from all providers...');
  try {
    const data = await api(`/api/lyrics?artist=${encodeURIComponent(t.artist)}&title=${encodeURIComponent(t.title)}&file_path=${encodeURIComponent(t.id)}`);
    currentLyricsData = data;
    if (data.found) {
      updateLyricsBadge(data.source, data.synced);
      renderKaraokeLines(data);
      if (data.plain) $('#lyrics-editor').value = data.plain;
      notify(`Lyrics found via ${data.source.toUpperCase()}!`);
    } else {
      notify('No lyrics found automatically. Use Search Lyrics.');
    }
  } catch (e) { notify('Error fetching lyrics.'); }
});

// ---- Manual Lyrics Search & Switcher ------------------------
async function executeLyricsSearch(query) {
  const q = (query || '').trim();
  if (!q) return;
  const loading = $('#lyrics-search-loading');
  const resultsContainer = $('#lyrics-search-results');
  
  loading.classList.remove('hidden');
  resultsContainer.innerHTML = '';

  try {
    const data = await api(`/api/lyrics/search?q=${encodeURIComponent(q)}`);
    loading.classList.add('hidden');
    const candidates = data.candidates || [];

    if (candidates.length === 0) {
      resultsContainer.innerHTML = `
        <div style="text-align:center; padding: 24px 0; color: var(--text-muted);">
          <i class="ph ph-magnifying-glass" style="font-size: 24px; margin-bottom: 8px;"></i>
          <p>No lyric matches found for "${escapeHtml(q)}". Try different keywords or artist name.</p>
        </div>`;
      return;
    }

    resultsContainer.innerHTML = candidates.map(c => {
      const syncBadge = c.synced 
        ? `<span class="lyrics-badge-tag lyrics-badge-synced"><i class="ph-fill ph-lightning"></i> Synced</span>`
        : `<span class="lyrics-badge-tag lyrics-badge-plain"><i class="ph ph-file-text"></i> Plain</span>`;

      return `
        <div class="lyrics-candidate-card" data-id="${escapeHtml(c.id)}">
          <div class="lyrics-candidate-info">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="lyrics-candidate-title">${escapeHtml(c.title)}</span>
              ${syncBadge}
              <span style="font-size:10px;color:var(--accent);font-weight:600;text-transform:uppercase;">${escapeHtml(c.source)}</span>
            </div>
            <div class="lyrics-candidate-meta">${escapeHtml(c.artist)}${c.album ? ` · ${escapeHtml(c.album)}` : ''}</div>
            <div class="lyrics-candidate-preview">"${escapeHtml(c.preview)}"</div>
          </div>
          <button class="btn-primary lyrics-apply-btn" style="padding:6px 14px;font-size:12px;white-space:nowrap;" data-raw="${encodeURIComponent(c.raw_lrc || c.plain)}">
            <i class="ph ph-check-circle"></i> Apply
          </button>
        </div>
      `;
    }).join('');

    resultsContainer.querySelectorAll('.lyrics-apply-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rawContent = decodeURIComponent(btn.dataset.raw || '');
        const currentTrack = getActivePlaybackTrack();
        if (!currentTrack) return notify('Play a song first.');

        btn.disabled = true;
        btn.innerHTML = '<i class="ph ph-spinner-gap spinning"></i> Applying...';

        try {
          const res = await api('/api/lyrics/apply', {
            method: 'POST',
            body: JSON.stringify({
              track_id: currentTrack.id,
              artist: currentTrack.artist,
              title: currentTrack.title,
              content: rawContent
            })
          });

          state.lyrics[currentTrack.id] = rawContent;
          $('#lyrics-editor').value = rawContent;
          if (res.lyrics) {
            currentLyricsData = res.lyrics;
            updateLyricsBadge(res.lyrics.source, res.lyrics.synced);
            renderKaraokeLines(res.lyrics);
          }
          $('#lyrics-search-sheet').close();
          notify('Lyrics applied and saved permanently!');
        } catch (err) {
          notify('Failed to apply lyrics.');
          btn.disabled = false;
          btn.innerHTML = '<i class="ph ph-check-circle"></i> Apply';
        }
      });
    });

  } catch (err) {
    loading.classList.add('hidden');
    resultsContainer.innerHTML = `<p class="muted" style="text-align:center;padding:20px 0;">Failed to search lyrics providers.</p>`;
  }
}

function openLyricsSearchModal() {
  const t = getActivePlaybackTrack();
  const modal = $('#lyrics-search-sheet');
  if (!modal) return;
  
  if (t) {
    $('#lyrics-search-target').innerHTML = `Target: <strong>${escapeHtml(t.title)}</strong> · <span class="muted">${escapeHtml(t.artist)}</span>`;
    $('#lyrics-search-input').value = `${t.title} ${t.artist !== 'Local collection' && t.artist !== 'YouTube' ? t.artist : ''}`.trim();
  } else {
    $('#lyrics-search-target').innerHTML = `Target: <span class="muted">No active song</span>`;
    $('#lyrics-search-input').value = '';
  }

  modal.showModal();
  if ($('#lyrics-search-input').value) {
    executeLyricsSearch($('#lyrics-search-input').value);
  }
}

$('#open-lyrics-search-btn')?.addEventListener('click', openLyricsSearchModal);
$('#search-lyrics-btn-edit')?.addEventListener('click', openLyricsSearchModal);

$('#lyrics-search-close')?.addEventListener('click', () => $('#lyrics-search-sheet')?.close());
$('#lyrics-search-cancel-btn')?.addEventListener('click', () => $('#lyrics-search-sheet')?.close());

$('#lyrics-search-submit-btn')?.addEventListener('click', () => {
  executeLyricsSearch($('#lyrics-search-input').value);
});

$('#lyrics-search-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    executeLyricsSearch($('#lyrics-search-input').value);
  }
});

$('#video-modal-lyrics')?.addEventListener('click', () => {
  const t = getActivePlaybackTrack() || currentVideoTrack;
  closeVideoModal();
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="lyrics"]')?.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $('#lyrics-view')?.classList.remove('hidden');
  if (t) loadLyricsInline(t);
});

// ---- Theme Engine -------------------------------------------
const themes = [
  { name: 'Warm Sand', color: '#d4b07a' },
  { name: 'Muted Sage', color: '#97a996' },
  { name: 'Dusty Rose', color: '#ba9497' },
  { name: 'Slate Blue', color: '#889eb8' }
];
let currentTheme = 0;

$('#theme-button').addEventListener('click', () => {
  currentTheme = (currentTheme + 1) % themes.length;
  document.documentElement.style.setProperty('--accent', themes[currentTheme].color);
  notify(`Theme set to ${themes[currentTheme].name}`);
});

$('#rescan').addEventListener('click', async () => {
  notify('Rescanning library folders...');
  try {
    const data = await api('/api/rescan', { method: 'POST' });
    hydrate(data);
    notify(`Library refreshed! Found ${data.count || state.tracks.length} tracks.`);
  } catch (e) { notify('Error refreshing library.'); }
});

function renderFoldersList() {
  const list = $('#folders-list');
  if (!state.library_folders || state.library_folders.length === 0) {
    list.innerHTML = '<p class="muted">No folders imported.</p>';
    return;
  }
  list.innerHTML = state.library_folders.map(f => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.1);">
      <span style="font-family:monospace;font-size:12px;color:#ccc;word-break:break-all;">${escapeHtml(f)}</span>
      <button class="round-action folder-remove-btn" data-folder="${escapeHtml(f)}" style="margin-left:10px;"><i class="ph ph-trash"></i></button>
    </div>
  `).join('');
  
  list.querySelectorAll('.folder-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const f = btn.dataset.folder;
      state.library_folders = state.library_folders.filter(x => x !== f);
      await saveState();
      renderFoldersList();
      notify('Folder removed. Rescan to clear tracks.');
    });
  });
}

$('#manage-folders').addEventListener('click', () => {
  closeSidebar();
  renderFoldersList();
  $('#folders-sheet').showModal();
});

$('#folders-close').addEventListener('click', () => $('#folders-sheet').close());

$('#add-folder-btn').addEventListener('click', async () => {
  const p = $('#new-folder-path').value.trim();
  if (!p) return;
  notify('Importing...');
  try {
    const data = await api('/api/import-folder', { method: 'POST', body: JSON.stringify({ folder: p }) });
    hydrate(data);
    $('#new-folder-path').value = '';
    renderFoldersList();
    notify('Import successful!');
  } catch (err) { 
    notify(err.message || 'Import failed.'); 
  }
});

// ---- Init ---------------------------------------------------
(async function init() {
  try {
    const data = await api('/api/library');
    hydrate(data);
  } catch (e) {
    notify('Failed to load library data.');
  }
})();

// ---- Full-Screen Player -------------------------------------
const fsPlayer = $('#fs-player');
let activeFsBg = 1;

// ---- Fullscreen Visualizer Modes Catalog (10 Curated Organic Modes) ----
const FS_MODES = [
  { id: 'stage', name: 'Modern Split Stage', icon: 'ph-bold ph-columns' },
  { id: 'vinyl', name: 'Vinyl Turntable', icon: 'ph-fill ph-vinyl-record' },
  { id: 'retro90s', name: '90s Retro', icon: 'ph-bold ph-cassette-tape' },
  { id: 'halo', name: 'Celestial Halo', icon: 'ph-bold ph-circle-dashed' },
  { id: 'modern', name: 'Modern Glass Card', icon: 'ph-bold ph-square' },
  { id: 'lyrics', name: 'Karaoke Lyrics', icon: 'ph-bold ph-quotes' },
  { id: 'wave', name: 'Ambient Waveform', icon: 'ph-bold ph-waveform' },
  { id: 'aura', name: 'Living Aura', icon: 'ph-bold ph-aperture' },
  { id: 'radio', name: 'Retro Cassette', icon: 'ph-bold ph-radio' },
  { id: 'clean', name: 'Clean Canvas', icon: 'ph-bold ph-image' }
];

let currentFsMode = localStorage.getItem('linus_fullscreen_mode') || 'stage';

// Cinema Auto-Hide HUD & Immersive Screen Lock Engine
let fsIdleTimer = null;
let isFsHudLocked = false;

function toggleFsHudLock(forceState) {
  if (!fsPlayer || !fsPlayer.classList.contains('open')) return;
  const nextState = forceState !== undefined ? !!forceState : !isFsHudLocked;
  isFsHudLocked = nextState;
  
  const lockBtn = $('#fs-lock-hud-btn');
  if (isFsHudLocked) {
    if (fsIdleTimer) clearTimeout(fsIdleTimer);
    fsPlayer.classList.add('fs-locked', 'fs-idle');
    if (lockBtn) {
      lockBtn.innerHTML = '<i class="ph-fill ph-lock-key"></i>';
      lockBtn.title = 'Unlock HUD (Double-Click Screen or Ctrl+Shift+Y)';
      lockBtn.classList.add('active');
    }
    notify('🔒 Cinema HUD Locked — Double-click screen or press Ctrl+Shift+Y to unlock');
  } else {
    fsPlayer.classList.remove('fs-locked', 'fs-idle');
    if (lockBtn) {
      lockBtn.innerHTML = '<i class="ph-bold ph-lock-key-open"></i>';
      lockBtn.title = 'Lock Immersive HUD (Double-Click Screen or Ctrl+Shift+Y to Lock/Unlock)';
      lockBtn.classList.remove('active');
    }
    notify('🔓 Cinema HUD Unlocked');
    resetFsIdleTimer();
  }
}

function resetFsIdleTimer() {
  if (!fsPlayer || !fsPlayer.classList.contains('open')) return;
  if (isFsHudLocked) {
    // Keep HUD strictly locked & hidden regardless of mouse movement, clicking or keyboard navigation
    fsPlayer.classList.add('fs-locked', 'fs-idle');
    return;
  }
  fsPlayer.classList.remove('fs-idle');
  if (fsIdleTimer) clearTimeout(fsIdleTimer);

  const vizPanel = $('#fs-visualizer-panel');
  const themeStudio = $('#fs-theme-studio');
  if ((vizPanel && !vizPanel.classList.contains('hidden')) || 
      (themeStudio && !themeStudio.classList.contains('hidden'))) {
    return;
  }

  fsIdleTimer = setTimeout(() => {
    if (fsPlayer && fsPlayer.classList.contains('open') && !isFsHudLocked) {
      fsPlayer.classList.add('fs-idle');
    }
  }, 3500);
}

function setupFsIdleTimer() {
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'pointermove'].forEach(evt => {
    window.addEventListener(evt, resetFsIdleTimer, { passive: true });
  });

  // Double-click on screen locks/unlocks the HUD
  fsPlayer?.addEventListener('dblclick', (e) => {
    if (!fsPlayer.classList.contains('open')) return;
    // When unlocked, ignore double-clicks on buttons or editable controls so standard clicks aren't hijacked
    if (!isFsHudLocked && e.target.closest('input, textarea, select, button, .fs-viz-card, .karaoke-line')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    toggleFsHudLock();
  });

  // Dedicated Lock HUD button in header action cluster
  $('#fs-lock-hud-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFsHudLock();
  });
}
setupFsIdleTimer();

function setFullscreenMode(modeId) {
  if (!FS_MODES.some(m => m.id === modeId)) {
    modeId = 'stage';
  }
  currentFsMode = modeId;
  try {
    localStorage.setItem('linus_fullscreen_mode', modeId);
  } catch {}
  if (fsPlayer) fsPlayer.setAttribute('data-mode', modeId);

  // Update quick mode bar pills
  document.querySelectorAll('.mode-bar-pill').forEach(pill => {
    const isActive = pill.getAttribute('data-mode') === modeId;
    pill.classList.toggle('active', isActive);
    pill.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // Update capsule UI if present
  const modeObj = FS_MODES.find(m => m.id === modeId);
  const capsuleIcon = $('#mode-capsule-icon');
  const capsuleName = $('#mode-capsule-name');
  if (capsuleIcon && modeObj) capsuleIcon.innerHTML = `<i class="${modeObj.icon}"></i>`;
  if (capsuleName && modeObj) capsuleName.textContent = modeObj.name;

  // Update active states in studio panel cards
  document.querySelectorAll('.fs-viz-card').forEach(card => {
    card.classList.toggle('active', card.getAttribute('data-mode') === modeId);
  });

  // Re-trigger visual updates based on current progress if audio has duration
  if (typeof audio !== 'undefined' && audio && audio.duration && typeof updateFullscreenRing === 'function') {
    updateFullscreenRing(audio.currentTime, audio.duration);
  }

  // Ensure canvases are properly resized only when the player is open
  if (typeof resizeVisualizerCanvases === 'function' && fsPlayer && fsPlayer.classList.contains('open')) {
    resizeVisualizerCanvases();
  }
  if (modeId === 'retro90s' && typeof initWinampEngine === 'function') {
    initWinampEngine();
  }
}

function toggleVisualizerPanel(forceState) {
  const panel = $('#fs-visualizer-panel');
  const capsule = $('#fs-mode-capsule');
  if (!panel) return;
  const isHidden = forceState !== undefined ? !forceState : !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', isHidden);
  if (capsule) capsule.classList.toggle('panel-open', !isHidden);
}

function closeVisualizerPanel() {
  toggleVisualizerPanel(false);
}

function cycleFullscreenMode(direction = 1) {
  const currentIndex = FS_MODES.findIndex(m => m.id === currentFsMode);
  const safeIdx = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIdx + direction + FS_MODES.length) % FS_MODES.length;
  setFullscreenMode(FS_MODES[nextIndex].id);
}

// Mode Capsule Trigger (Opens/Closes the Visualizer Studio Hub)
$('#mode-capsule-trigger')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleVisualizerPanel();
});

// Arrow buttons on capsule
$('#mode-capsule-prev')?.addEventListener('click', (e) => {
  e.stopPropagation();
  cycleFullscreenMode(-1);
});
$('#mode-capsule-next')?.addEventListener('click', (e) => {
  e.stopPropagation();
  cycleFullscreenMode(1);
});

// Close button on Visualizer Studio Panel
$('#fs-viz-panel-close')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeVisualizerPanel();
});

// Quick Mode Bar Pills Selection
document.querySelectorAll('.mode-bar-pill').forEach(pill => {
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    const mode = pill.getAttribute('data-mode');
    if (mode) {
      setFullscreenMode(mode);
    }
  });
});

// Studio Panel Cards Selection
document.querySelectorAll('.fs-viz-card').forEach(card => {
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    const mode = card.getAttribute('data-mode');
    if (mode) {
      setFullscreenMode(mode);
      closeVisualizerPanel();
    }
  });
});

// Close visualizer panel when clicking outside
document.addEventListener('click', (e) => {
  const panel = $('#fs-visualizer-panel');
  const capsule = $('#fs-mode-capsule');
  if (panel && !panel.classList.contains('hidden')) {
    if (!panel.contains(e.target) && !capsule?.contains(e.target)) {
      closeVisualizerPanel();
    }
  }
});

// Initialize mode capsule on startup
setFullscreenMode(currentFsMode);

// Walkman Tactile Hardware Buttons
$('#btn-walkman-megabass')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = $('#btn-walkman-megabass');
  const badge = $('#lcd-badge-bass');
  const isActive = btn.classList.toggle('active');
  badge?.classList.toggle('active', isActive);
  notify(isActive ? 'MEGA BASS: ON (+6dB Low Shelf)' : 'MEGA BASS: OFF');
});

$('#btn-walkman-esp')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = $('#btn-walkman-esp');
  const badge = $('#lcd-badge-esp');
  const isActive = btn.classList.toggle('active');
  badge?.classList.toggle('active', isActive);
  notify(isActive ? 'ESP: 45 SECONDS ELECTRONIC SHOCK PROTECTION ACTIVE' : 'ESP: BYPASS');
});

$('#btn-walkman-avls')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = $('#btn-walkman-avls');
  const badge = $('#lcd-badge-avls');
  const isActive = btn.classList.toggle('active');
  badge?.classList.toggle('active', isActive);
  notify(isActive ? 'AVLS: AUTOMATIC VOLUME LIMITER SYSTEM ACTIVE' : 'AVLS: LIMITER OFF');
});

// Stage Mode 3D Jewel Case Mouse Parallax Tilt
const stageCaseWrap = $('#stage-case-wrap');
const stageJewelCase = $('#stage-jewel-case');
if (stageCaseWrap && stageJewelCase) {
  stageCaseWrap.addEventListener('mousemove', (e) => {
    const rect = stageCaseWrap.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    const rotY = (x / (rect.width / 2)) * 12;
    const rotX = -(y / (rect.height / 2)) * 12;
    stageJewelCase.style.transform = `perspective(900px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale3d(1.02, 1.02, 1.02)`;
  });
  stageCaseWrap.addEventListener('mouseleave', () => {
    stageJewelCase.style.transform = '';
  });
}

// ---- True Browser Fullscreen API Engine ----
function isTrueFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
}

function requestTrueFullscreen() {
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) {
      return el.requestFullscreen().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      return el.webkitRequestFullscreen();
    } else if (el.mozRequestFullScreen) {
      return el.mozRequestFullScreen();
    } else if (el.msRequestFullscreen) {
      return el.msRequestFullscreen();
    }
  } catch (err) {
    console.warn('Native fullscreen request error:', err);
  }
  return Promise.resolve();
}

function exitTrueFullscreen() {
  if (isTrueFullscreen()) {
    try {
      if (document.exitFullscreen) {
        return document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        return document.webkitExitFullscreen();
      } else if (document.mozCancelFullScreen) {
        return document.mozCancelFullScreen();
      } else if (document.msExitFullscreen) {
        return document.msExitFullscreen();
      }
    } catch (err) {
      console.warn('Native fullscreen exit error:', err);
    }
  }
  return Promise.resolve();
}

function toggleTrueFullscreen() {
  if (isTrueFullscreen()) {
    exitTrueFullscreen();
    notify('Exited True Fullscreen');
  } else {
    requestTrueFullscreen();
    notify('Entered True Fullscreen — Browser tabs & address bar hidden!');
  }
  setTimeout(updateTrueFullscreenUI, 100);
}

function updateTrueFullscreenUI() {
  const isFs = isTrueFullscreen();
  const btn = $('#fs-native-fullscreen-btn');
  if (btn) {
    btn.innerHTML = isFs ? '<i class="ph-bold ph-corners-in"></i>' : '<i class="ph-bold ph-corners-out"></i>';
    btn.title = isFs ? 'Exit True Fullscreen (Show Browser Tabs & Window)' : 'True Fullscreen (Hide Browser Tabs & Address Bar for Full Artwork)';
    btn.classList.toggle('active', isFs);
  }
  const toggleBtn = $('#fs-native-toggle-btn');
  if (toggleBtn) {
    toggleBtn.innerHTML = isFs ? '<i class="ph-bold ph-corners-in"></i> Exit Fullscreen' : '<i class="ph-bold ph-corners-out"></i> Toggle Now';
  }
}

document.addEventListener('fullscreenchange', updateTrueFullscreenUI);
document.addEventListener('webkitfullscreenchange', updateTrueFullscreenUI);
document.addEventListener('mozfullscreenchange', updateTrueFullscreenUI);
document.addEventListener('MSFullscreenChange', updateTrueFullscreenUI);

// Open/Close Fullscreen Player
function openFullscreenPlayer(triggerNative = true) {
  if (!audio.src) {
    const first = (typeof state !== 'undefined' && state.tracks) ? state.tracks.find(t => t.media_type !== 'video') : ((typeof queue !== 'undefined' && queue) ? queue[0] : null);
    if (first && typeof playById === 'function') {
      playById(first.id);
    } else {
      notify('Play a song to enter full screen.');
      return;
    }
  }
  isFsHudLocked = false;
  fsPlayer.classList.remove('fs-locked');
  const lockBtn = $('#fs-lock-hud-btn');
  if (lockBtn) {
    lockBtn.innerHTML = '<i class="ph-bold ph-lock-key-open"></i>';
    lockBtn.classList.remove('active');
  }
  fsPlayer.classList.add('open');
  resetFsIdleTimer();
  if (typeof updateFullscreenRing === 'function') {
    updateFullscreenRing(audio.currentTime, audio.duration);
  }
  if (triggerNative && (!fsTheme || fsTheme.autoNativeFullscreen !== false)) {
    requestTrueFullscreen();
  }
  updateTrueFullscreenUI();
  if (typeof resizeVisualizerCanvases === 'function') {
    setTimeout(resizeVisualizerCanvases, 60);
  }
}

function closeFullscreenPlayer() {
  if (isFsHudLocked) {
    toggleFsHudLock(false);
  }
  fsPlayer.classList.remove('open');
  fsPlayer.classList.remove('fs-idle', 'fs-locked');
  if (fsIdleTimer) clearTimeout(fsIdleTimer);
  if (isTrueFullscreen()) {
    exitTrueFullscreen();
  }
  updateTrueFullscreenUI();
}

$('.now-playing').addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target.closest('input')) return;
  openFullscreenPlayer();
});

$('#fs-close').addEventListener('click', () => closeFullscreenPlayer());

// Expand Button
$('#fs-expand-btn').addEventListener('click', () => {
  openFullscreenPlayer();
});

// Dedicated True Fullscreen Toggle button in fs-header
$('#fs-native-fullscreen-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleTrueFullscreen();
});

// Helper for deterministic colors
function getTrackColors(str) {
  const palettes = [
    ['#1a1a2e', '#0f3460'], ['#2d4059', '#ea5455'], 
    ['#111113', '#2a2a35'], ['#2c3e50', '#3498db'],
    ['#0b0b0c', '#d4b07a'], ['#1C1C21', '#8FA998'],
    ['#4b134f', '#c94b4b'], ['#1e130c', '#9a8478']
  ];
  let hash = 0;
  for(let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return palettes[Math.abs(hash) % palettes.length];
}

// Background crossfade & UI update
function updateFullscreenUI(track) {
  const c = getTrackColors((track.id || '') + (track.title || ''));
  let bgStyle = `linear-gradient(135deg, ${c[0]}, ${c[1]})`;
  if (_isChameleonGlowEnabled && _currentChameleonPalette) {
    const [r1, g1, b1] = _currentChameleonPalette.primary;
    const [r2, g2, b2] = _currentChameleonPalette.secondary;
    bgStyle = `linear-gradient(135deg, rgb(${r1}, ${g1}, ${b1}), rgb(${r2}, ${g2}, ${b2}))`;
  }
  
  const oldBg = $('#fs-bg-' + activeFsBg);
  activeFsBg = activeFsBg === 1 ? 2 : 1;
  const newBg = $('#fs-bg-' + activeFsBg);
  
  newBg.style.background = bgStyle;
  newBg.style.opacity = '1';
  oldBg.style.opacity = '0';

  $('#fs-title').textContent = track.title;
  $('#fs-artist').textContent = track.artist;
  
  // Vinyl Mode
  if (track.has_artwork && track.artwork_url) {
    $('#fs-disk-art').innerHTML = `<img src="${track.artwork_url}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    $('#fs-disk-art').style.background = 'none';
  } else {
    $('#fs-disk-art').innerHTML = `<span id="fs-disk-letter" style="font-size: 72px; font-weight: bold; color: rgba(255,255,255,0.2);">${track.title.slice(0,1).toUpperCase()}</span>`;
    $('#fs-disk-art').style.background = bgStyle;
  }
  
  // Modern Mode
  if (track.has_artwork && track.artwork_url) {
    $('#fs-modern-art').innerHTML = `<img src="${track.artwork_url}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:24px;">`;
    $('#fs-modern-art').style.background = 'none';
  } else {
    $('#fs-modern-art').innerHTML = `<span id="fs-modern-letter" style="font-size: 96px; font-weight: bold; color: rgba(255,255,255,0.3);">${track.title.slice(0,1).toUpperCase()}</span>`;
    $('#fs-modern-art').style.background = bgStyle;
  }

  // Stage Mode (3D CD Jewel Case & Metadata)
  const stageArt = $('#stage-album-art');
  const stageLetter = $('#stage-art-letter');
  if (stageArt) {
    if (track.has_artwork && track.artwork_url) {
      stageArt.src = track.artwork_url;
      stageArt.classList.remove('hidden');
      if (stageLetter) stageLetter.classList.add('hidden');
    } else {
      stageArt.classList.add('hidden');
      if (stageLetter) {
        stageLetter.textContent = track.title.slice(0, 1).toUpperCase();
        stageLetter.classList.remove('hidden');
      }
    }
  }

  // Peeking CD Disc Label Sync
  const stageDiscArt = $('#stage-disc-art');
  const stageDiscLetter = $('#stage-disc-letter');
  if (stageDiscArt) {
    if (track.has_artwork && track.artwork_url) {
      stageDiscArt.src = track.artwork_url;
      stageDiscArt.classList.remove('hidden');
      if (stageDiscLetter) stageDiscLetter.classList.add('hidden');
    } else {
      stageDiscArt.classList.add('hidden');
      if (stageDiscLetter) {
        stageDiscLetter.textContent = track.title.slice(0, 1).toUpperCase();
        stageDiscLetter.classList.remove('hidden');
      }
    }
  }

  const stageTitle = $('#stage-track-title');
  if (stageTitle) stageTitle.textContent = track.title;
  const stageArtist = $('#stage-track-artist');
  if (stageArtist) stageArtist.textContent = track.artist;

  // 90s Walkman LCD Deck Sync
  const walkmanTrack = $('#walkman-track-no');
  if (walkmanTrack) {
    const trackNum = (typeof currentIndex === 'number' && currentIndex >= 0) ? currentIndex + 1 : 1;
    walkmanTrack.textContent = String(trackNum).padStart(2, '0');
  }
  const walkmanTicker = $('#walkman-ticker-txt');
  if (walkmanTicker) {
    const tName = (track.title || 'UNKNOWN TRACK').toUpperCase();
    const aName = (track.artist || 'UNKNOWN ARTIST').toUpperCase();
    walkmanTicker.textContent = `${tName} • ${aName} • SONY DISCMAN D-E305 • 1-BIT DAC DIGITAL AUDIO • 45-SEC ESP`;
  }
  $('#lcd-badge-shuffle')?.classList.toggle('active', !!shuffleOn);
  $('#lcd-badge-repeat')?.classList.toggle('active', repeatMode !== 'none');

  // Mini Rolling Disk Artwork (Bottom-Left Dock)
  const miniArt = $('#fs-mini-art');
  if (miniArt) {
    if (track.has_artwork && track.artwork_url) {
      miniArt.innerHTML = `<img src="${track.artwork_url}" alt="Artwork" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
      miniArt.innerHTML = `<span style="font-size:16px;font-weight:bold;color:#fff;">${track.title.slice(0,1).toUpperCase()}</span>`;
    }
  }

  // Sync dock states
  const isFav = state?.favorites?.includes(track.id);
  const fsLikeBtn = $('#fs-like');
  if (fsLikeBtn) {
    fsLikeBtn.innerHTML = `<i class="ph${isFav ? '-fill' : ''} ph-star" style="${isFav ? 'color:var(--accent);' : ''}"></i>`;
    fsLikeBtn.classList.toggle('active-fav', !!isFav);
  }
  $('#fs-shuffle')?.classList.toggle('active', !!shuffleOn);
  $('#fs-repeat')?.classList.toggle('active', repeatMode !== 'none');
  $('#fs-autodj-btn')?.classList.toggle('active', !!isAutoDJEnabled);

  // Aura Mode Orbs & Core
  const auraCore = $('#fs-aura-core');
  if (auraCore) auraCore.style.background = bgStyle;
  document.querySelectorAll('.orb').forEach(orb => orb.style.background = bgStyle);
  
  if (audio.paused) fsPlayer.classList.remove('playing');
  else fsPlayer.classList.add('playing');
}

// Sync Audio Controls
function togglePlayGlobal() {
  if (!audio.src) return;
  initAudioContext();
  if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  if (audio.paused) { 
    audio.play().catch(err => console.warn('Playback resume error:', err)); 
    $('#play').innerHTML = '<i class="ph-fill ph-pause"></i>'; 
    $('#fs-play').innerHTML = '<i class="ph-fill ph-pause"></i>';
    if ($('#hero-play')) $('#hero-play').innerHTML = '<i class="ph-fill ph-pause-circle"></i>';
    $('#vinyl-record').classList.add('playing');
    $('#hero-now-playing-card')?.classList.add('playing');
    fsPlayer.classList.add('playing');
  } else { 
    audio.pause(); 
    $('#play').innerHTML = '<i class="ph-fill ph-play"></i>';
    $('#fs-play').innerHTML = '<i class="ph-fill ph-play"></i>';
    if ($('#hero-play')) $('#hero-play').innerHTML = '<i class="ph-fill ph-play-circle"></i>';
    $('#vinyl-record').classList.remove('playing');
    $('#hero-now-playing-card')?.classList.remove('playing');
    fsPlayer.classList.remove('playing');
    debouncedSaveState(1200);
  }
}

// Override original #play click
$('#play').replaceWith($('#play').cloneNode(true));
$('#play').addEventListener('click', () => {
  if (!audio.src) { 
    const first = state.tracks.find(t=>t.media_type!=='video');
    if (first) playById(first.id); 
    return; 
  }
  togglePlayGlobal();
});

$('#fs-play').addEventListener('click', (e) => {
  e.stopPropagation();
  togglePlayGlobal();
});
$('#fs-next').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#next').click();
});
$('#fs-prev').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#previous').click();
});
$('#fs-shuffle').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#shuffle-btn').click();
  $('#fs-shuffle').classList.toggle('active', shuffleOn);
});
$('#fs-repeat').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#repeat-btn').click();
  $('#fs-repeat').classList.toggle('active', repeatMode !== 'none');
});
$('#fs-like').addEventListener('click', (e) => {
  e.stopPropagation();
  const cur = queue[currentIndex];
  if (cur) toggleFavorite(cur.id);
});
$('#fs-radio-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  startTrackRadio();
});
$('#fs-autodj-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (typeof toggleAutoDJ === 'function') {
    toggleAutoDJ();
    $('#fs-autodj-btn')?.classList.toggle('active', !!isAutoDJEnabled);
  }
});

// Interactive Progress Ring (Vinyl) & Linear Bar
const diskContainer = $('#fs-disk-container');
const linearProgress = $('#fs-progress-bar-wrapper');
let isDraggingSeek = false;

// Vinyl Ring Seeking
diskContainer.addEventListener('pointerdown', (e) => {
  if (!audio.src) return;
  isDraggingSeek = true;
  diskContainer.classList.add('seeking');
  updateRingSeek(e);
  diskContainer.setPointerCapture(e.pointerId);
});
diskContainer.addEventListener('pointermove', (e) => {
  if (!isDraggingSeek) return;
  updateRingSeek(e);
});
diskContainer.addEventListener('pointerup', (e) => {
  if (!isDraggingSeek) return;
  isDraggingSeek = false;
  diskContainer.classList.remove('seeking');
  diskContainer.releasePointerCapture(e.pointerId);
});
function updateRingSeek(e) {
  const rect = diskContainer.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  let angle = Math.atan2(dy, dx) + Math.PI / 2;
  if (angle < 0) angle += 2 * Math.PI;
  const pct = Math.max(0, Math.min(1, angle / (2 * Math.PI)));
  if (audio.duration) audio.currentTime = pct * audio.duration;
  updateFullscreenRing(audio.currentTime, audio.duration);
}

// Linear Bar Seeking
linearProgress.addEventListener('pointerdown', (e) => {
  if (!audio.src) return;
  isDraggingSeek = true;
  updateLinearSeek(e);
  linearProgress.setPointerCapture(e.pointerId);
});
linearProgress.addEventListener('pointermove', (e) => {
  if (!isDraggingSeek) return;
  updateLinearSeek(e);
});
linearProgress.addEventListener('pointerup', (e) => {
  if (!isDraggingSeek) return;
  isDraggingSeek = false;
  linearProgress.releasePointerCapture(e.pointerId);
});
function updateLinearSeek(e) {
  const rect = linearProgress.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (audio.duration) audio.currentTime = pct * audio.duration;
  updateFullscreenRing(audio.currentTime, audio.duration);
}

function updateFullscreenRing(currentTime, duration) {
  if (!duration) return;
  const pct = currentTime / duration;
  
  // Update Vinyl Ring
  const circ = 942.477;
  const ringFill = $('#fs-ring-fill');
  if (ringFill) ringFill.style.strokeDashoffset = circ - (pct * circ);
  
  // Update Linear Bar
  const progFill = $('#fs-progress-bar-fill');
  if (progFill) progFill.style.width = (pct * 100) + '%';
  const curTime = $('#fs-time-current');
  if (curTime) curTime.textContent = formatTime(currentTime);
  const totTime = $('#fs-time-total');
  if (totTime) totTime.textContent = formatTime(duration);

  // Update Walkman LCD Timecode & ESP Ring Fill
  const walkmanTime = $('#walkman-time-code');
  if (walkmanTime) {
    const m = Math.floor(currentTime / 60);
    const s = Math.floor(currentTime % 60);
    walkmanTime.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  const espFill = $('#walkman-esp-fill');
  if (espFill) {
    const espCirc = 113.1;
    espFill.style.strokeDashoffset = espCirc - (pct * espCirc);
  }
}

// Hook into audio timeupdate to update main bottom player timeline and fullscreen player
audio.addEventListener('timeupdate', () => {
  const cur = audio.currentTime || 0;
  const dur = audio.duration || queue[currentIndex]?.duration || 0;
  if (typeof _telemetryMaxTimePlayed !== 'undefined') {
    _telemetryMaxTimePlayed = Math.max(_telemetryMaxTimePlayed, cur);
  }

  const curTimeEl = $('#current-time');
  const totalTimeEl = $('#total-time');
  const progressEl = $('#progress');

  if (curTimeEl) curTimeEl.textContent = formatTime(cur);
  if (totalTimeEl && dur > 0) totalTimeEl.textContent = formatTime(dur);

  if (progressEl && dur > 0 && !progressEl.matches(':active')) {
    progressEl.value = (cur / dur) * 100;
  }

  const heroNpBar = $('#hero-np-bar');
  if (heroNpBar && dur > 0) {
    heroNpBar.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
  }

  if (!isDraggingSeek) updateFullscreenRing(cur, dur);
  updateKaraokeHighlight(cur);

  // Smart Auto-DJ Beat-Matched Crossfader Trigger:
  // When track is within autoDJDuration of its end, trigger equal-power blend to next track
  if (isAutoDJEnabled && autoDJDuration > 0 && !isCrossfading && dur > 15) {
    const timeLeft = dur - cur;
    if (timeLeft <= autoDJDuration && timeLeft > 0.4) {
      const nextTrack = queue[currentIndex + 1];
      if (nextTrack) {
        startAutoDJCrossfade(nextTrack, autoDJDuration);
      }
    }
  }

  // Lookahead Pre-warming: When current song is >= 80% or within 15 seconds of ending
  if (dur > 20 && (cur / dur >= 0.8 || (dur - cur) <= 15)) {
    const nextTrack = queue[currentIndex + 1];
    if (nextTrack && nextTrack.id !== _lastPrewarmedTrackId) {
      _lastPrewarmedTrackId = nextTrack.id;
      if (nextTrack.is_online && nextTrack.video_id) {
        api(`/api/youtube/prewarm/${encodeURIComponent(nextTrack.video_id)}`, { method: 'POST' }).catch(() => {});
      }
    }
  }
});

audio.addEventListener('loadedmetadata', () => {
  const dur = audio.duration || queue[currentIndex]?.duration || 0;
  const totalTimeEl = $('#total-time');
  if (totalTimeEl && dur > 0) {
    totalTimeEl.textContent = formatTime(dur);
  }
});

audio.addEventListener('durationchange', () => {
  const dur = audio.duration || queue[currentIndex]?.duration || 0;
  const totalTimeEl = $('#total-time');
  if (totalTimeEl && dur > 0) {
    totalTimeEl.textContent = formatTime(dur);
  }
});

audio.addEventListener('ended', () => {
  updateFullscreenRing(audio.duration, audio.duration);
  fsPlayer.classList.remove('playing');
});

// ---- 10-Band Audiophile EQ, Bass Boost & 8D Spatial Audio DSP Engine ----
const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_LABELS = ['32Hz', '64Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz', '8kHz', '16kHz'];

const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5.5, 4, 1.5, 0, 0, 0, 1, 2, 2.5],
  cyberpunk: [4, 3, 1, -1, -2, 1, 3.5, 4, 5.5, 6],
  vocal: [-2, -1, 0, 1, 2.5, 4, 4.5, 3, 1.5, 1],
  acoustic: [3, 2.5, 1.5, 0.5, 1, 2, 3, 3.5, 4, 4],
  nightcore: [-1, 0, 1, 2, 2.5, 3.5, 5, 6, 6.5, 5],
  immersion: [5, 4.5, 3, 1.5, 0.5, 1, 2, 3.5, 4.5, 5]
};

let eqFilters = [];
let bassBoostFilter = null;
let spatialPanner = null;
let spatialRaf = null;
let is8DActive = false;
let spatialSpeed = 0.25;
let spatialAngle = 0;
let currentEqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
let currentBassBoost = 0;

let audioCtx = null;
let analyser = null;
let sourceA = null;
let sourceB = null;
let deckAGain = null;
let deckBGain = null;
let audioDataArray = null;
let visualizerRaf = null;
let compressorNode = null;
let makeupGainNode = null;
let isAudioNormEnabled = localStorage.getItem('linus_audio_normalization') !== 'false';
let isKaraokeEnabled = localStorage.getItem('linus_karaoke_enabled') === 'true';
let karaokeInput = null;
let karaokeDryGain = null;
let karaokeWetGain = null;
let karaokeBassFilter = null;
let karaokeVocalHighpass = null;
let karaokeSplitter = null;
let karaokeInvertNode = null;
let karaokeDiffNode = null;
let karaokeDiffMerger = null;
let karaokeOutput = null;

function initAudioContext() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64; // 32 frequency buckets
    analyser.smoothingTimeConstant = 0.8;
    audioDataArray = new Uint8Array(analyser.frequencyBinCount);

    if (!sourceA && _audioA) {
      sourceA = audioCtx.createMediaElementSource(_audioA);
      deckAGain = audioCtx.createGain();
      deckAGain.gain.value = activeDeck === 'A' ? 1.0 : 0.0;
      sourceA.connect(deckAGain);
    }
    if (!sourceB && _audioB) {
      sourceB = audioCtx.createMediaElementSource(_audioB);
      deckBGain = audioCtx.createGain();
      deckBGain.gain.value = activeDeck === 'B' ? 1.0 : 0.0;
      sourceB.connect(deckBGain);
    }

    // 1. Build 10-Band BiquadFilterNodes
    eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
      const filter = audioCtx.createBiquadFilter();
      if (idx === 0) {
        filter.type = 'lowshelf';
      } else if (idx === EQ_FREQUENCIES.length - 1) {
        filter.type = 'highshelf';
      } else {
        filter.type = 'peaking';
        filter.Q.value = 1.4;
      }
      filter.frequency.value = freq;
      filter.gain.value = currentEqGains[idx] || 0;
      return filter;
    });

    // 2. Bass Booster LowShelf filter @ 75Hz
    bassBoostFilter = audioCtx.createBiquadFilter();
    bassBoostFilter.type = 'lowshelf';
    bassBoostFilter.frequency.value = 75;
    bassBoostFilter.gain.value = currentBassBoost;

    // 3. 8D Spatial Audio Stereo Panner Node
    if (audioCtx.createStereoPanner) {
      spatialPanner = audioCtx.createStereoPanner();
    }

    // 4. Karaoke Mid-Side Vocal Remover DSP
    karaokeInput = audioCtx.createGain();
    karaokeDryGain = audioCtx.createGain();
    karaokeDryGain.gain.value = isKaraokeEnabled ? 0.0 : 1.0;

    karaokeWetGain = audioCtx.createGain();
    karaokeWetGain.gain.value = isKaraokeEnabled ? 1.25 : 0.0;

    karaokeOutput = audioCtx.createGain();

    // 4a. Dry Passthrough
    karaokeInput.connect(karaokeDryGain);
    karaokeDryGain.connect(karaokeOutput);

    // 4b. Low-End Rhythm & Bass Preservation (< 200 Hz)
    karaokeBassFilter = audioCtx.createBiquadFilter();
    karaokeBassFilter.type = 'lowpass';
    karaokeBassFilter.frequency.value = 200;
    karaokeBassFilter.Q.value = 0.707;
    karaokeInput.connect(karaokeBassFilter);
    karaokeBassFilter.connect(karaokeWetGain);

    // 4c. Vocal Cancellation via Mid-Side Inversion (> 200 Hz)
    karaokeVocalHighpass = audioCtx.createBiquadFilter();
    karaokeVocalHighpass.type = 'highpass';
    karaokeVocalHighpass.frequency.value = 200;
    karaokeVocalHighpass.Q.value = 0.707;
    karaokeInput.connect(karaokeVocalHighpass);

    karaokeSplitter = audioCtx.createChannelSplitter(2);
    karaokeVocalHighpass.connect(karaokeSplitter);

    karaokeInvertNode = audioCtx.createGain();
    karaokeInvertNode.gain.value = -1.0;
    karaokeSplitter.connect(karaokeInvertNode, 1); // Splitter output 1 (Right) -> Invert (-R)

    karaokeDiffNode = audioCtx.createGain();
    karaokeDiffNode.gain.value = 1.0;
    karaokeSplitter.connect(karaokeDiffNode, 0);   // Splitter output 0 (Left) -> Diff (+L)
    karaokeInvertNode.connect(karaokeDiffNode);     // Inverted Right -> Diff (-R), resulting in (L - R)

    karaokeDiffMerger = audioCtx.createChannelMerger(2);
    karaokeDiffNode.connect(karaokeDiffMerger, 0, 0); // (L - R) -> Left out
    karaokeDiffNode.connect(karaokeDiffMerger, 0, 1); // (L - R) -> Right out
    karaokeDiffMerger.connect(karaokeWetGain);

    karaokeWetGain.connect(karaokeOutput);

    // 5. Smart Gain Dynamics Compressor & Makeup Gain
    compressorNode = audioCtx.createDynamicsCompressor();
    compressorNode.threshold.value = isAudioNormEnabled ? -24 : 0;
    compressorNode.knee.value = 30;
    compressorNode.ratio.value = isAudioNormEnabled ? 12 : 1;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.25;

    makeupGainNode = audioCtx.createGain();
    makeupGainNode.gain.value = isAudioNormEnabled ? 1.68 : 1.0;

    // Connect Dual-Deck Inputs to DSP Chain:
    // [deckAGain + deckBGain] -> eqFilters[0..9] -> bassBoostFilter -> [spatialPanner] -> karaokeInput -> karaokeOutput -> compressorNode -> makeupGainNode -> analyser -> destination
    if (deckAGain && eqFilters[0]) {
      deckAGain.connect(eqFilters[0]);
    }
    if (deckBGain && eqFilters[0]) {
      deckBGain.connect(eqFilters[0]);
    }

    let lastNode = eqFilters[0];
    for (let i = 1; i < eqFilters.length; i++) {
      lastNode.connect(eqFilters[i]);
      lastNode = eqFilters[i];
    }
    lastNode.connect(bassBoostFilter);
    lastNode = bassBoostFilter;

    if (spatialPanner) {
      lastNode.connect(spatialPanner);
      lastNode = spatialPanner;
    }

    lastNode.connect(karaokeInput);
    lastNode = karaokeOutput;

    lastNode.connect(compressorNode);
    compressorNode.connect(makeupGainNode);
    lastNode = makeupGainNode;

    lastNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    console.warn('Web Audio API setup error:', e);
  }
}

function toggleAudioNormalization(forceState = null) {
  initAudioContext();
  if (typeof forceState === 'boolean') {
    isAudioNormEnabled = forceState;
  } else {
    isAudioNormEnabled = !isAudioNormEnabled;
  }
  localStorage.setItem('linus_audio_normalization', isAudioNormEnabled ? 'true' : 'false');

  if (audioCtx && compressorNode && makeupGainNode) {
    const now = audioCtx.currentTime;
    if (isAudioNormEnabled) {
      compressorNode.threshold.setTargetAtTime(-24, now, 0.05);
      compressorNode.ratio.setTargetAtTime(12, now, 0.05);
      makeupGainNode.gain.setTargetAtTime(1.68, now, 0.05);
    } else {
      compressorNode.threshold.setTargetAtTime(0, now, 0.05);
      compressorNode.ratio.setTargetAtTime(1, now, 0.05);
      makeupGainNode.gain.setTargetAtTime(1.0, now, 0.05);
    }
  }

  updateAudioNormUI();

  if (isAudioNormEnabled) {
    notify('🎧 Smart Gain: ON (Automatic Loudness Leveling)');
  } else {
    notify('🎧 Smart Gain: OFF (Raw Dynamic Range)');
  }
}

function updateAudioNormUI() {
  const badge = $('#norm-status-badge');
  const sub = $('#norm-status-sub');
  const btn = $('#norm-toggle-btn');
  if (badge) {
    badge.textContent = isAudioNormEnabled ? 'ON' : 'OFF';
    badge.className = `norm-status-pill ${isAudioNormEnabled ? 'on' : 'off'}`;
  }
  if (sub) {
    sub.textContent = isAudioNormEnabled ? 'Consistent loudness across tracks' : 'Raw dynamic range (unprocessed)';
  }
  if (btn) {
    btn.classList.toggle('active', isAudioNormEnabled);
  }
}

// ============================================================================
// 🎤 Instant Vocal Remover / Karaoke DSP Engine (Mid-Side Phase Inversion)
// ============================================================================
function toggleKaraokeMode(forceState = null) {
  initAudioContext();
  if (typeof forceState === 'boolean') {
    isKaraokeEnabled = forceState;
  } else {
    isKaraokeEnabled = !isKaraokeEnabled;
  }
  localStorage.setItem('linus_karaoke_enabled', isKaraokeEnabled ? 'true' : 'false');

  if (audioCtx && karaokeDryGain && karaokeWetGain) {
    const now = audioCtx.currentTime;
    if (isKaraokeEnabled) {
      karaokeDryGain.gain.setTargetAtTime(0.0, now, 0.05);
      karaokeWetGain.gain.setTargetAtTime(1.25, now, 0.05);
    } else {
      karaokeDryGain.gain.setTargetAtTime(1.0, now, 0.05);
      karaokeWetGain.gain.setTargetAtTime(0.0, now, 0.05);
    }
  }

  updateKaraokeUI();

  if (isKaraokeEnabled) {
    notify('🎤 Karaoke Mode: ON (Vocal Suppressed)');
  } else {
    notify('🎤 Karaoke Mode: OFF (Full Vocal Mix)');
  }
}

function updateKaraokeUI() {
  const badge = $('#karaoke-status-badge');
  const sub = $('#karaoke-status-sub');
  const btn = $('#karaoke-toggle-btn');
  const fsBtn = $('#fs-karaoke-btn');
  if (badge) {
    badge.textContent = isKaraokeEnabled ? 'ON' : 'OFF';
    badge.className = `norm-status-pill ${isKaraokeEnabled ? 'on' : 'off'}`;
  }
  if (sub) {
    sub.textContent = isKaraokeEnabled ? 'Vocal suppressed (sing-along mode)' : 'Real-time vocal suppression for singing';
  }
  if (btn) {
    btn.classList.toggle('active', isKaraokeEnabled);
  }
  if (fsBtn) {
    fsBtn.classList.toggle('active', isKaraokeEnabled);
  }
}

// ============================================================================
// 🔊 20-Second Audio Hover Preview Engine
// ============================================================================
let _isHoverPreviewEnabled = localStorage.getItem('linus_hover_preview_enabled') !== 'false';
let _previewAudio = new Audio();
_previewAudio.preload = 'auto';
let _hoverPreviewDebounceTimer = null;
let _hoverPreview20sTimer = null;
let _hoverPreviewTarget = null;
let _isMainAudioDucked = false;
let _preDuckVolume = 1.0;
let _previewFadeInterval = null;

function updateHoverPreviewUI() {
  const badge = $('#hover-preview-status-badge');
  const sub = $('#hover-preview-status-sub');
  const btn = $('#hover-preview-toggle-btn');
  if (badge) {
    badge.textContent = _isHoverPreviewEnabled ? 'ON' : 'OFF';
    badge.className = `norm-status-pill ${_isHoverPreviewEnabled ? 'on' : 'off'}`;
  }
  if (sub) {
    sub.textContent = _isHoverPreviewEnabled ? 'Dedicated 20s preview buttons on songs' : '20s audio previews disabled';
  }
  if (btn) {
    btn.classList.toggle('active', _isHoverPreviewEnabled);
  }
}

function toggleHoverPreview() {
  _isHoverPreviewEnabled = !_isHoverPreviewEnabled;
  localStorage.setItem('linus_hover_preview_enabled', _isHoverPreviewEnabled ? 'true' : 'false');
  updateHoverPreviewUI();
  if (!_isHoverPreviewEnabled) {
    stopHoverPreview();
    notify('🔇 20s Audio Preview disabled');
  } else {
    notify('🔊 20s Audio Preview enabled');
  }
}

function duckMainAudio() {
  if (_isMainAudioDucked) return;
  if (!audio || audio.paused || audio.volume <= 0.05) return;
  _preDuckVolume = audio.volume;
  _isMainAudioDucked = true;

  const targetVol = Math.max(0.08, _preDuckVolume * 0.35);
  const step = (_preDuckVolume - targetVol) / 8;
  let count = 0;
  const duckTimer = setInterval(() => {
    count++;
    if (!_isMainAudioDucked || !audio) {
      clearInterval(duckTimer);
      return;
    }
    audio.volume = Math.max(targetVol, audio.volume - step);
    if (count >= 8 || audio.volume <= targetVol) {
      audio.volume = targetVol;
      clearInterval(duckTimer);
    }
  }, 20);
}

function restoreMainAudio() {
  if (!_isMainAudioDucked) return;
  _isMainAudioDucked = false;
  if (!audio) return;

  const targetVol = _preDuckVolume;
  const startVol = audio.volume;
  const step = (targetVol - startVol) / 8;
  let count = 0;
  const restoreTimer = setInterval(() => {
    count++;
    if (_isMainAudioDucked || !audio) {
      clearInterval(restoreTimer);
      return;
    }
    audio.volume = Math.min(targetVol, audio.volume + step);
    if (count >= 8 || audio.volume >= targetVol) {
      audio.volume = targetVol;
      clearInterval(restoreTimer);
    }
  }, 20);
}

function resolveHoverTrackInfo(el) {
  if (!el) return null;

  // 1. Recommendation card (.rec-card)
  if (el.classList.contains('rec-card')) {
    const id = el.dataset.id || '';
    const isYt = el.dataset.isYt === '1' || id.startsWith('yt:');
    const vid = el.dataset.vid || (isYt ? id.replace('yt:', '') : '');
    const dur = parseFloat(el.dataset.dur || '0');
    const title = el.dataset.title || 'Track';

    let url = '';
    if (isYt && vid) {
      url = `/api/youtube/stream/${encodeURIComponent(vid)}`;
    } else if (id) {
      const t = trackById(id);
      url = t?.url || '';
    }
    return { id, isYt, vid, dur, title, url };
  }

  // 2. Explore card (.explore-card)
  if (el.classList.contains('explore-card')) {
    const vid = el.dataset.vid || '';
    const title = el.dataset.title || 'Track';
    const streamBtn = el.querySelector('.explore-stream-btn');
    const dur = streamBtn ? parseFloat(streamBtn.dataset.dur || '0') : 0;
    const url = vid ? `/api/youtube/stream/${encodeURIComponent(vid)}` : '';
    return { id: `yt:${vid}`, isYt: true, vid, dur, title, url };
  }

  // 3. Track row (.track-row)
  if (el.classList.contains('track-row')) {
    const id = el.dataset.id || '';
    if (!id) return null;
    const t = trackById(id);
    if (!t) return null;
    const isYt = !!(t.is_online || id.startsWith('yt:'));
    const vid = t.video_id || (isYt ? id.replace('yt:', '') : '');
    let url = '';
    if (isYt && vid) {
      url = `/api/youtube/stream/${encodeURIComponent(vid)}`;
    } else {
      url = t.url || '';
    }
    return { id, isYt, vid, dur: t.duration || 0, title: t.title || 'Track', url };
  }

  return null;
}

function toggleTrackAudioPreview(el, triggerBtn = null) {
  if (!_isHoverPreviewEnabled) {
    notify('🔊 Enable 20s Audio Preview in the FX menu first');
    return;
  }
  if (_hoverPreviewTarget === el) {
    stopHoverPreview();
    return;
  }
  startHoverPreview(el, triggerBtn);
}

function startHoverPreview(el, triggerBtn = null) {
  if (!_isHoverPreviewEnabled) return;
  const info = resolveHoverTrackInfo(el);
  if (!info || !info.url) return;

  // Don't preview if track is currently playing in main player
  if (audio && !audio.paused) {
    if (info.id && queue[currentIndex]?.id === info.id) return;
    if (info.vid && typeof _ytCurrentStreamId !== 'undefined' && _ytCurrentStreamId === info.vid) return;
  }

  // Stop previous preview cleanly
  stopHoverPreview();
  _hoverPreviewTarget = el;

  // Set active previewing state on trigger button
  const btn = triggerBtn || el.querySelector('.rec-card-preview-btn, .explore-preview-btn, .preview-track-btn');
  if (btn) {
    btn.classList.add('previewing');
    btn.setAttribute('title', 'Stop 20s Preview');
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'ph-bold ph-stop';
  }

  // Mount visual indicators on target immediately
  el.classList.add('hover-preview-active');
  el.querySelectorAll('.preview-badge-pill, .preview-progress-bar-wrap').forEach(n => n.remove());

  const badge = document.createElement('span');
  badge.className = 'preview-badge-pill';
  badge.innerHTML = `<span class="preview-wave-anim"><span class="preview-wave-bar"></span><span class="preview-wave-bar"></span><span class="preview-wave-bar"></span><span class="preview-wave-bar"></span></span> 20s Preview`;

  const barWrap = document.createElement('div');
  barWrap.className = 'preview-progress-bar-wrap';
  barWrap.innerHTML = `<div class="preview-progress-bar-fill"></div>`;

  const thumbEl = el.querySelector('.rec-card-thumb, .explore-card-thumb');
  if (thumbEl) {
    thumbEl.appendChild(badge);
    thumbEl.appendChild(barWrap);
  } else {
    el.appendChild(badge);
    el.appendChild(barWrap);
  }

  // Configure audio playback - start at 0 so container/demuxer headers are read cleanly
  _previewAudio.pause();
  _previewAudio.currentTime = 0;
  _previewAudio.src = info.url;
  _previewAudio.volume = Math.min(1.0, (audio && audio.volume > 0.1 ? audio.volume : 0.85));

  // Error listener
  _previewAudio.onerror = () => {
    console.warn('Preview audio load error for:', info.url);
    notify('Could not load audio preview.');
    stopHoverPreview();
  };

  const playPromise = _previewAudio.play();
  if (playPromise) {
    playPromise.then(() => {
      if (_hoverPreviewTarget !== el) {
        _previewAudio.pause();
        return;
      }

      // Duck main player audio smoothly so preview stands out
      duckMainAudio();

      // Strict 20-second stop timeout
      clearTimeout(_hoverPreview20sTimer);
      _hoverPreview20sTimer = setTimeout(() => {
        stopHoverPreview(true);
      }, 20000);
    }).catch(err => {
      console.warn('Hover preview play prevented:', err);
      stopHoverPreview();
    });
  }
}

function stopHoverPreview(timedOut = false) {
  clearTimeout(_hoverPreviewDebounceTimer);
  _hoverPreviewDebounceTimer = null;
  clearTimeout(_hoverPreview20sTimer);
  _hoverPreview20sTimer = null;
  clearInterval(_previewFadeInterval);

  // Restore all preview buttons back to normal
  document.querySelectorAll('.rec-card-preview-btn.previewing, .explore-preview-btn.previewing, .preview-track-btn.previewing').forEach(btn => {
    btn.classList.remove('previewing');
    btn.setAttribute('title', 'Quick 20s Preview');
    const icon = btn.querySelector('i');
    if (icon) icon.className = 'ph-bold ph-speaker-simple-high';
  });

  if (_hoverPreviewTarget) {
    _hoverPreviewTarget.classList.remove('hover-preview-active');
    _hoverPreviewTarget.querySelectorAll('.preview-badge-pill, .preview-progress-bar-wrap').forEach(n => n.remove());
    _hoverPreviewTarget = null;
  }

  if (_previewAudio) {
    _previewAudio.onerror = null;
    _previewAudio.pause();
    _previewAudio.removeAttribute('src');
    _previewAudio.load();
  }

  restoreMainAudio();
}

function initHoverPreview() {
  updateHoverPreviewUI();

  // 1-Click Dedicated 20s Preview Button Handler via Event Delegation
  document.addEventListener('click', (e) => {
    const previewBtn = e.target.closest('.rec-card-preview-btn, .explore-preview-btn, .preview-track-btn');
    if (previewBtn) {
      e.stopPropagation();
      e.preventDefault();
      const card = previewBtn.closest('.rec-card, .explore-card, .track-row');
      if (card) {
        toggleTrackAudioPreview(card, previewBtn);
      }
      return;
    }

    // Clicking to play a full track stops any running preview immediately
    const playTrigger = e.target.closest('.rec-card-play-btn, .explore-stream-btn, .ctrl-play, #play, .track-title-cell, .track-thumb');
    if (playTrigger) {
      stopHoverPreview();
    }
  });

  window.addEventListener('blur', () => {
    stopHoverPreview();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopHoverPreview();
    }
  });
}

// ============================================================================
// 🌈 Dynamic Artwork Color Extraction (Chameleon Glow) Engine
// ============================================================================
let _isChameleonGlowEnabled = localStorage.getItem('linus_chameleon_glow_enabled') !== 'false';
let _currentChameleonPalette = null;
let _currentChameleonTrackId = null;
const _chameleonPaletteCache = new Map();

function updateChameleonUI() {
  const badge = $('#chameleon-status-badge');
  const sub = $('#chameleon-status-sub');
  const btn = $('#chameleon-toggle-btn');
  if (badge) {
    badge.textContent = _isChameleonGlowEnabled ? 'ON' : 'OFF';
    badge.className = `norm-status-pill ${_isChameleonGlowEnabled ? 'on' : 'off'}`;
  }
  if (sub) {
    sub.textContent = _isChameleonGlowEnabled ? 'Dynamic UI glow from album art' : 'Static theme colors (classic)';
  }
  if (btn) {
    btn.classList.toggle('active', _isChameleonGlowEnabled);
  }
}

function toggleChameleonGlow(forceState = null) {
  if (typeof forceState === 'boolean') {
    _isChameleonGlowEnabled = forceState;
  } else {
    _isChameleonGlowEnabled = !_isChameleonGlowEnabled;
  }
  localStorage.setItem('linus_chameleon_glow_enabled', _isChameleonGlowEnabled ? 'true' : 'false');
  updateChameleonUI();

  if (!_isChameleonGlowEnabled) {
    document.body.classList.remove('chameleon-active');
    document.documentElement.style.removeProperty('--chameleon-primary');
    document.documentElement.style.removeProperty('--chameleon-secondary');
    document.documentElement.style.removeProperty('--chameleon-glow');
    document.documentElement.style.removeProperty('--chameleon-glow-subtle');
    document.documentElement.style.removeProperty('--chameleon-gradient');
    document.documentElement.style.removeProperty('--chameleon-surface');
    notify('🎨 Chameleon Glow: OFF (Classic Theme)');
  } else {
    notify('🌈 Chameleon Glow: ON (Artwork Adaptive)');
    const curTrack = (currentIndex >= 0 && queue[currentIndex]) ? queue[currentIndex] : (state.last_played_track_id ? trackById(state.last_played_track_id) : null);
    if (curTrack) {
      applyChameleonPalette(curTrack);
    }
  }
}

/**
 * Extracts dominant and accent colors from an image URL using a 48x48 HTML5 canvas.
 * Executes in under 3ms.
 */
function extractArtworkPalette(imgUrl) {
  return new Promise((resolve) => {
    if (!imgUrl) return resolve(null);
    if (_chameleonPaletteCache.has(imgUrl)) {
      return resolve(_chameleonPaletteCache.get(imgUrl));
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 48;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);

        ctx.drawImage(img, 0, 0, 48, 48);
        const data = ctx.getImageData(0, 0, 48, 48).data;

        const colorBuckets = {};

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 128) continue; // Ignore transparent pixels

          const sum = r + g + b;
          // Filter out near-black / mud (< 50) and washed-out pure whites (> 720)
          if (sum < 50 || sum > 720) continue;

          // Filter low saturation (greys)
          const maxVal = Math.max(r, g, b);
          const minVal = Math.min(r, g, b);
          const delta = maxVal - minVal;
          if (delta < 18 && sum > 100) continue;

          // Quantize to 24-step buckets
          const qr = Math.floor(r / 24) * 24;
          const qg = Math.floor(g / 24) * 24;
          const qb = Math.floor(b / 24) * 24;
          const key = `${qr},${qg},${qb}`;

          // Weight by saturation / vibrancy
          const weight = 1.0 + (delta / 255.0) * 1.5;

          if (!colorBuckets[key]) {
            colorBuckets[key] = { r: qr, g: qg, b: qb, count: 0, weight: 0 };
          }
          colorBuckets[key].count++;
          colorBuckets[key].weight += weight;
        }

        const sorted = Object.values(colorBuckets).sort((a, b) => b.weight - a.weight);

        if (sorted.length === 0) {
          const fallback = {
            primary: [229, 169, 93],
            secondary: [200, 136, 62],
            isFallback: true
          };
          _chameleonPaletteCache.set(imgUrl, fallback);
          return resolve(fallback);
        }

        const p1 = sorted[0];
        let p2 = sorted[1] || p1;

        for (let i = 1; i < sorted.length; i++) {
          const cand = sorted[i];
          const dist = Math.sqrt(
            Math.pow(cand.r - p1.r, 2) +
            Math.pow(cand.g - p1.g, 2) +
            Math.pow(cand.b - p1.b, 2)
          );
          if (dist > 70) {
            p2 = cand;
            break;
          }
        }

        // Boost brightness slightly if primary is too dark
        const boostR = Math.min(255, Math.floor(p1.r * 1.15 + 10));
        const boostG = Math.min(255, Math.floor(p1.g * 1.15 + 10));
        const boostB = Math.min(255, Math.floor(p1.b * 1.15 + 10));

        const palette = {
          primary: [boostR, boostG, boostB],
          secondary: [p2.r, p2.g, p2.b],
          isFallback: false
        };

        _chameleonPaletteCache.set(imgUrl, palette);
        resolve(palette);
      } catch (err) {
        console.warn('Artwork canvas extraction failed (CORS fallback):', err);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imgUrl;
  });
}

/**
 * Applies extracted Chameleon Palette across Linus UI:
 * Player bar, Hero Vinyl card, Fullscreen background, CSS tokens.
 */
async function applyChameleonPalette(track) {
  if (!track) return;
  _currentChameleonTrackId = track.id;

  if (!_isChameleonGlowEnabled) {
    document.body.classList.remove('chameleon-active');
    return;
  }

  const artUrl = track.artwork_url || (track.is_online && track.video_id ? `https://i.ytimg.com/vi/${track.video_id}/hqdefault.jpg` : null);

  if (!artUrl) {
    document.body.classList.remove('chameleon-active');
    return;
  }

  const palette = await extractArtworkPalette(artUrl);
  if (!palette || _currentChameleonTrackId !== track.id) return;
  if (!_isChameleonGlowEnabled) return;

  _currentChameleonPalette = palette;
  const [r1, g1, b1] = palette.primary;
  const [r2, g2, b2] = palette.secondary;

  const root = document.documentElement;
  root.style.setProperty('--chameleon-primary', `rgb(${r1}, ${g1}, ${b1})`);
  root.style.setProperty('--chameleon-secondary', `rgb(${r2}, ${g2}, ${b2})`);
  root.style.setProperty('--chameleon-glow', `rgba(${r1}, ${g1}, ${b1}, 0.5)`);
  root.style.setProperty('--chameleon-glow-subtle', `rgba(${r1}, ${g1}, ${b1}, 0.22)`);
  root.style.setProperty('--chameleon-gradient', `linear-gradient(135deg, rgb(${r1}, ${g1}, ${b1}), rgb(${r2}, ${g2}, ${b2}))`);
  root.style.setProperty('--chameleon-surface', `rgba(${Math.floor(r1 * 0.12)}, ${Math.floor(g1 * 0.12)}, ${Math.floor(b1 * 0.12)}, 0.82)`);

  document.body.classList.add('chameleon-active');

  // Smoothly sync Fullscreen Player background
  const chameleonBg = `linear-gradient(135deg, rgb(${r1}, ${g1}, ${b1}), rgb(${r2}, ${g2}, ${b2}))`;
  const currBg = $('#fs-bg-' + activeFsBg);
  if (currBg) {
    currBg.style.background = chameleonBg;
  }
}

function run8DSpatialLoop() {
  if (document.hidden || !is8DActive || !spatialPanner || audio.paused) {
    if (spatialPanner && !is8DActive) spatialPanner.pan.value = 0;
    if (spatialRaf) cancelAnimationFrame(spatialRaf);
    spatialRaf = null;
    return;
  }
  spatialAngle += spatialSpeed * 0.04;
  const panVal = Math.sin(spatialAngle) * 0.96;
  spatialPanner.pan.value = panVal;

  const sat = $('#orbit-satellite');
  if (sat) {
    sat.style.transform = `rotate(${spatialAngle * 57.2958}deg)`;
  }

  spatialRaf = requestAnimationFrame(run8DSpatialLoop);
}

// Build Equalizer UI
function renderEqualizerUI() {
  const stage = $('#eq-sliders-stage');
  if (!stage) return;

  stage.innerHTML = EQ_FREQUENCIES.map((freq, idx) => `
    <div class="eq-col">
      <span class="eq-col-gain" id="eq-gain-${idx}">${currentEqGains[idx] > 0 ? '+' : ''}${currentEqGains[idx]}dB</span>
      <div class="eq-slider-wrap">
        <input type="range" class="eq-v-slider" id="eq-slider-${idx}" min="-12" max="12" step="0.5" value="${currentEqGains[idx]}" data-idx="${idx}">
      </div>
      <span class="eq-col-label">${EQ_LABELS[idx]}</span>
    </div>
  `).join('');

  stage.querySelectorAll('.eq-v-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      initAudioContext();
      const idx = parseInt(e.target.dataset.idx);
      const val = parseFloat(e.target.value);
      currentEqGains[idx] = val;
      if (eqFilters[idx]) eqFilters[idx].gain.value = val;
      const gainLabel = $(`#eq-gain-${idx}`);
      if (gainLabel) gainLabel.textContent = `${val > 0 ? '+' : ''}${val}dB`;
      // Remove active from presets since manual tweak made
      document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'));
    });
  });
}

function applyPreset(presetKey) {
  const gains = EQ_PRESETS[presetKey];
  if (!gains) return;
  initAudioContext();
  currentEqGains = [...gains];

  currentEqGains.forEach((val, idx) => {
    if (eqFilters[idx]) eqFilters[idx].gain.value = val;
    const slider = $(`#eq-slider-${idx}`);
    if (slider) slider.value = val;
    const gainLabel = $(`#eq-gain-${idx}`);
    if (gainLabel) gainLabel.textContent = `${val > 0 ? '+' : ''}${val}dB`;
  });

  document.querySelectorAll('.eq-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === presetKey);
  });

  state.eq_preset = presetKey;
  state.eq_gains = currentEqGains;
  saveState();
}

// Preset Buttons
document.querySelectorAll('.eq-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

// Bass Booster Knob/Slider
$('#bass-boost-slider').addEventListener('input', (e) => {
  initAudioContext();
  const val = parseFloat(e.target.value);
  currentBassBoost = val;
  if (bassBoostFilter) bassBoostFilter.gain.value = val;
  $('#bass-boost-val').textContent = `+${val} dB`;
});

// 8D Spatial Audio Toggle
$('#spatial-toggle').addEventListener('change', (e) => {
  initAudioContext();
  is8DActive = e.target.checked;
  const sat = $('#orbit-satellite');
  if (is8DActive) {
    if (sat) sat.parentElement.classList.add('orbit-anim');
    run8DSpatialLoop();
    notify('🎧 8D Spatial Audio ON — Best with headphones!');
  } else {
    if (sat) sat.parentElement.classList.remove('orbit-anim');
    if (spatialPanner) spatialPanner.pan.value = 0;
    notify('8D Spatial Audio OFF');
  }
});

$('#spatial-speed-slider').addEventListener('input', (e) => {
  spatialSpeed = parseFloat(e.target.value);
});

// Reset EQ
$('#eq-reset-btn').addEventListener('click', () => {
  applyPreset('flat');
  $('#bass-boost-slider').value = 0;
  currentBassBoost = 0;
  if (bassBoostFilter) bassBoostFilter.gain.value = 0;
  $('#bass-boost-val').textContent = '+0 dB';
  notify('Equalizer reset to Flat.');
});

// Equalizer Dialog Open / Close
$('#eq-toggle-btn').addEventListener('click', () => {
  initAudioContext();
  renderEqualizerUI();
  $('#eq-sheet').showModal();
});
$('#fs-eq-btn').addEventListener('click', () => {
  initAudioContext();
  renderEqualizerUI();
  $('#eq-sheet').showModal();
});
$('#fs-karaoke-btn')?.addEventListener('click', () => {
  toggleKaraokeMode();
});
$('#eq-close').addEventListener('click', () => $('#eq-sheet').close());

renderEqualizerUI();

// ---- 3D Holographic Audio-Reactive Galaxy Particle Engine ----
const galaxyCanvas = document.getElementById('fs-galaxy-canvas');
let galaxyCtx = null;
let galaxyParticles = [];
const NUM_GALAXY_STARS = 950;
let galaxyRotation = 0;
let mouseTiltX = 0, mouseTiltY = 0;
let targetTiltX = 0, targetTiltY = 0;

function initGalaxyEngine() {
  if (!galaxyCanvas) return;
  galaxyCtx = galaxyCanvas.getContext('2d');
  
  const size = 600;
  galaxyCanvas.width = size;
  galaxyCanvas.height = size;

  galaxyParticles = [];
  const arms = 3;
  for (let i = 0; i < NUM_GALAXY_STARS; i++) {
    const armIndex = i % arms;
    const distance = Math.pow(Math.random(), 1.6) * 230 + 10;
    const angle = (armIndex * (Math.PI * 2 / arms)) + (distance * 0.022) + (Math.random() * 0.45);
    const z = (Math.random() - 0.5) * 80;
    const size = Math.random() * 2 + 0.8;
    const colorMix = Math.random();

    galaxyParticles.push({
      distance,
      baseAngle: angle,
      angle: angle,
      z: z,
      baseZ: z,
      size: size,
      colorMix: colorMix,
      speed: (1 / (distance + 20)) * 1.2
    });
  }
}

if (galaxyCanvas) {
  galaxyCanvas.addEventListener('mousemove', (e) => {
    const rect = galaxyCanvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    targetTiltX = ny * 0.9;
    targetTiltY = -nx * 0.9;
  });
  galaxyCanvas.addEventListener('mouseleave', () => {
    targetTiltX = 0; targetTiltY = 0;
  });
}

function renderGalaxyFrame(bass, mid, treble) {
  if (!galaxyCtx || !galaxyCanvas) return;
  const w = galaxyCanvas.width;
  const h = galaxyCanvas.height;
  const cx = w / 2;
  const cy = h / 2;

  mouseTiltX += (targetTiltX - mouseTiltX) * 0.08;
  mouseTiltY += (targetTiltY - mouseTiltY) * 0.08;

  galaxyCtx.fillStyle = 'rgba(6, 6, 10, 0.28)';
  galaxyCtx.fillRect(0, 0, w, h);

  galaxyRotation += 0.008 + mid * 0.035;

  const fov = 340;
  const shockwave = 1 + bass * 0.38;

  // Central supermassive core
  const coreGrad = galaxyCtx.createRadialGradient(cx, cy, 0, cx, cy, 32 + bass * 40);
  coreGrad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  coreGrad.addColorStop(0.3, 'rgba(212, 176, 122, 0.75)');
  coreGrad.addColorStop(0.7, 'rgba(180, 100, 255, 0.35)');
  coreGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  galaxyCtx.fillStyle = coreGrad;
  galaxyCtx.beginPath();
  galaxyCtx.arc(cx, cy, 38 + bass * 45, 0, Math.PI * 2);
  galaxyCtx.fill();

  // Draw 3D projected galaxy stars
  for (let i = 0; i < galaxyParticles.length; i++) {
    const p = galaxyParticles[i];
    p.angle += p.speed + mid * 0.006;
    const curDist = p.distance * shockwave;

    let px = Math.cos(p.angle + galaxyRotation) * curDist;
    let py = Math.sin(p.angle + galaxyRotation) * curDist * 0.45;
    let pz = p.baseZ + Math.sin(p.angle * 3) * (15 + bass * 25);

    const cosX = Math.cos(mouseTiltX);
    const sinX = Math.sin(mouseTiltX);
    const py1 = py * cosX - pz * sinX;
    const pz1 = py * sinX + pz * cosX;

    const cosY = Math.cos(mouseTiltY);
    const sinY = Math.sin(mouseTiltY);
    const px1 = px * cosY + pz1 * sinY;
    const pz2 = -px * sinY + pz1 * cosY;

    const scale = fov / (fov + pz2 + 120);
    const x2d = cx + px1 * scale;
    const y2d = cy + py1 * scale;

    if (x2d < 0 || x2d > w || y2d < 0 || y2d > h) continue;

    const pSize = Math.max(0.8, p.size * scale * (1 + bass * 0.8 + (p.colorMix > 0.7 ? treble * 1.5 : 0)));
    const alpha = Math.min(1, Math.max(0.15, (0.4 + p.colorMix * 0.5 + treble * 0.4) * scale));

    galaxyCtx.beginPath();
    galaxyCtx.arc(x2d, y2d, pSize, 0, Math.PI * 2);

    if (p.colorMix < 0.35) {
      galaxyCtx.fillStyle = `rgba(212, 176, 122, ${alpha})`;
    } else if (p.colorMix < 0.7) {
      galaxyCtx.fillStyle = `rgba(140, 200, 255, ${alpha})`;
    } else {
      galaxyCtx.fillStyle = `rgba(240, 140, 255, ${alpha})`;
    }
    galaxyCtx.fill();
  }
}

initGalaxyEngine();

// ---- Celestial Halo Visualizer Engine (Translucent Sound Ring) ----
let haloCanvas = null;
let haloCtx = null;
let haloAngle = 0;
let haloParticles = [];

function initCelestialHaloEngine() {
  haloCanvas = document.getElementById('fs-halo-canvas');
  if (!haloCanvas) return;
  haloCtx = haloCanvas.getContext('2d');
  const size = Math.min(640, window.innerWidth * 0.8, window.innerHeight * 0.7);
  haloCanvas.width = size;
  haloCanvas.height = size;

  haloParticles = [];
  for (let i = 0; i < 48; i++) {
    haloParticles.push({
      angle: (i / 48) * Math.PI * 2,
      radiusOffset: (Math.random() - 0.5) * 24,
      size: Math.random() * 2.5 + 1.2,
      speed: (Math.random() * 0.008 + 0.003) * (i % 2 === 0 ? 1 : -1),
      alpha: Math.random() * 0.6 + 0.3
    });
  }
}

function renderCelestialHaloFrame(bass, mid, treble, audioData) {
  if (!haloCtx || !haloCanvas) {
    initCelestialHaloEngine();
    if (!haloCtx || !haloCanvas) return;
  }
  const w = haloCanvas.width;
  const h = haloCanvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const baseR = Math.min(cx, cy) * 0.62;

  haloAngle += 0.008 + mid * 0.015;

  // Clear transparently - NEVER obscure background wallpaper!
  haloCtx.clearRect(0, 0, w, h);

  haloCtx.save();
  haloCtx.translate(cx, cy);

  // 1. Ethereal Inner Breathing Harmonic Circle
  const pulseR = baseR + bass * 24;
  haloCtx.beginPath();
  haloCtx.arc(0, 0, pulseR, 0, Math.PI * 2);
  haloCtx.strokeStyle = `rgba(255, 255, 255, ${0.15 + bass * 0.25})`;
  haloCtx.lineWidth = 1.5;
  haloCtx.stroke();

  // 2. Radial Frequency Soundwave Rays
  if (audioData && audioData.length) {
    const numPoints = 64;
    const step = (Math.PI * 2) / numPoints;
    haloCtx.beginPath();

    for (let i = 0; i < numPoints; i++) {
      const binIdx = Math.floor((i / numPoints) * (audioData.length / 2));
      const val = (audioData[binIdx] || 0) / 255;
      const angle = i * step + haloAngle;
      const len = Math.max(2, val * (32 + bass * 30));

      const x1 = Math.cos(angle) * (pulseR - 4);
      const y1 = Math.sin(angle) * (pulseR - 4);
      const x2 = Math.cos(angle) * (pulseR + len);
      const y2 = Math.sin(angle) * (pulseR + len);

      haloCtx.moveTo(x1, y1);
      haloCtx.lineTo(x2, y2);
    }
    haloCtx.strokeStyle = `rgba(229, 169, 93, ${0.5 + treble * 0.4})`;
    haloCtx.lineWidth = 2;
    haloCtx.lineCap = 'round';
    haloCtx.stroke();
  }

  // 3. Orbiting Celestial Dust Motes
  haloParticles.forEach(p => {
    p.angle += p.speed + mid * 0.01;
    const r = pulseR + p.radiusOffset + (bass * 15);
    const px = Math.cos(p.angle) * r;
    const py = Math.sin(p.angle) * r;

    haloCtx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, p.alpha + treble * 0.35)})`;
    haloCtx.beginPath();
    haloCtx.arc(px, py, p.size * (1 + treble * 0.4), 0, Math.PI * 2);
    haloCtx.fill();
  });

  haloCtx.restore();
}

// ---- Winamp 2.x Audio Engine (16-Band LED Spectrum & Green Phosphor Oscilloscope) ----
let winampCanvas = null;
let winampCtx = null;
let winampMode = 'spectrum'; // 'spectrum' | 'osc'
const WINAMP_BANDS_COUNT = 16;
const winampBandHeights = new Float32Array(WINAMP_BANDS_COUNT);
const winampPeakCaps = new Float32Array(WINAMP_BANDS_COUNT);
const winampPeakVelocities = new Float32Array(WINAMP_BANDS_COUNT);
const winampPeakHolds = new Int32Array(WINAMP_BANDS_COUNT);

function initWinampEngine() {
  winampCanvas = document.getElementById('winamp-canvas');
  if (!winampCanvas) return;
  winampCtx = winampCanvas.getContext('2d');
  
  if (winampCanvas.clientWidth > 0) {
    winampCanvas.width = winampCanvas.clientWidth;
  } else if (winampCanvas.width !== 560) {
    winampCanvas.width = 560;
  }
  if (winampCanvas.height !== 200) {
    winampCanvas.height = 200;
  }

  const btnSpec = document.getElementById('winamp-mode-spec');
  const btnOsc = document.getElementById('winamp-mode-osc');

  if (btnSpec && !btnSpec._bound) {
    btnSpec._bound = true;
    btnSpec.addEventListener('click', (e) => {
      e.stopPropagation();
      winampMode = 'spectrum';
      btnSpec.classList.add('active');
      btnOsc?.classList.remove('active');
    });
  }

  if (btnOsc && !btnOsc._bound) {
    btnOsc._bound = true;
    btnOsc.addEventListener('click', (e) => {
      e.stopPropagation();
      winampMode = 'osc';
      btnOsc.classList.add('active');
      btnSpec?.classList.remove('active');
    });
  }
}

function renderWinampFrame(bass, mid, treble, audioData) {
  if (!winampCtx || !winampCanvas) {
    initWinampEngine();
    if (!winampCtx || !winampCanvas) return;
  }

  const w = winampCanvas.width;
  const h = winampCanvas.height;

  if (winampMode === 'osc') {
    // Oscilloscope: Phosphor fade trail
    winampCtx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    winampCtx.fillRect(0, 0, w, h);

    // CRT grid line in center
    winampCtx.strokeStyle = 'rgba(0, 55, 0, 0.4)';
    winampCtx.lineWidth = 1;
    winampCtx.beginPath();
    winampCtx.moveTo(0, h / 2);
    winampCtx.lineTo(w, h / 2);
    winampCtx.stroke();

    // Waveform line
    winampCtx.strokeStyle = '#00ff41';
    winampCtx.shadowColor = '#00ff41';
    winampCtx.shadowBlur = 8;
    winampCtx.lineWidth = 2.2;
    winampCtx.beginPath();

    const sliceWidth = w / (audioData ? audioData.length : 64);
    let x = 0;
    for (let i = 0; i < (audioData ? audioData.length : 64); i++) {
      const v = (audioData ? audioData[i] : 128) / 128.0;
      const y = (v * (h / 2.6)) + (h * 0.22);
      if (i === 0) {
        winampCtx.moveTo(x, y);
      } else {
        winampCtx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    winampCtx.stroke();
    winampCtx.shadowBlur = 0;
  } else {
    // Spectrum Analyzer Mode
    winampCtx.fillStyle = '#000000';
    winampCtx.fillRect(0, 0, w, h);

    // Subtle green background grid lines
    winampCtx.strokeStyle = 'rgba(0, 60, 0, 0.35)';
    winampCtx.lineWidth = 1;
    for (let y = 10; y < h; y += 20) {
      winampCtx.beginPath();
      winampCtx.moveTo(0, y);
      winampCtx.lineTo(w, y);
      winampCtx.stroke();
    }

    const padLeft = 14;
    const padRight = 14;
    const availW = w - padLeft - padRight;
    const bandGap = 6;
    const bandW = Math.max(8, Math.floor((availW - (bandGap * (WINAMP_BANDS_COUNT - 1))) / WINAMP_BANDS_COUNT));
    const maxBarH = h - 22;

    const segH = 3;
    const segGap = 1;
    const totalSegH = segH + segGap;

    for (let i = 0; i < WINAMP_BANDS_COUNT; i++) {
      // Exponential bin mapping for authentic EQ sensitivity
      const binIdx = Math.min(
        (audioData ? audioData.length : 32) - 1,
        Math.floor(Math.pow(i / WINAMP_BANDS_COUNT, 1.8) * ((audioData ? audioData.length : 32) - 1))
      );
      const rawVal = audioData ? (audioData[binIdx] || 0) : 0;
      const targetNorm = rawVal / 255.0;

      // Smooth bar rise and decay
      if (targetNorm > winampBandHeights[i]) {
        winampBandHeights[i] = targetNorm;
      } else {
        winampBandHeights[i] = Math.max(0, winampBandHeights[i] - 0.045);
      }

      const barH = Math.floor(winampBandHeights[i] * maxBarH);
      const bx = padLeft + i * (bandW + bandGap);
      const byBottom = h - 10;

      // Draw discrete LED Segments
      const numSegs = Math.floor(barH / totalSegH);
      for (let s = 0; s < numSegs; s++) {
        const sy = byBottom - ((s + 1) * totalSegH);
        const segPct = s / (maxBarH / totalSegH);

        if (segPct > 0.82) {
          winampCtx.fillStyle = '#ff1a40'; // Peak red
        } else if (segPct > 0.58) {
          winampCtx.fillStyle = '#ffb300'; // Amber yellow
        } else {
          winampCtx.fillStyle = '#00ff41'; // Green phosphor
        }
        winampCtx.fillRect(bx, sy, bandW, segH);
      }

      // Physics-driven White Peak Caps (Falling with gravity)
      const currentBarTopY = byBottom - barH;
      if (currentBarTopY < winampPeakCaps[i] || winampPeakCaps[i] === 0) {
        winampPeakCaps[i] = currentBarTopY;
        winampPeakHolds[i] = 10; // Hold for 10 frames (~160ms)
        winampPeakVelocities[i] = 0;
      } else {
        if (winampPeakHolds[i] > 0) {
          winampPeakHolds[i]--;
        } else {
          winampPeakVelocities[i] += 0.45; // Gravity
          winampPeakCaps[i] += winampPeakVelocities[i];
          if (winampPeakCaps[i] > byBottom) {
            winampPeakCaps[i] = byBottom;
            winampPeakVelocities[i] = 0;
          }
        }
      }

      // Draw peak cap
      if (winampPeakCaps[i] < byBottom - 2) {
        winampCtx.fillStyle = '#ffffff';
        winampCtx.shadowColor = '#ffffff';
        winampCtx.shadowBlur = 4;
        winampCtx.fillRect(bx, winampPeakCaps[i], bandW, 2);
        winampCtx.shadowBlur = 0;
      }
    }
  }
}

function resizeVisualizerCanvases() {
  const haloC = haloCanvas || document.getElementById('fs-halo-canvas');
  if (haloC && haloC.clientWidth > 0) {
    const size = Math.min(640, Math.max(300, haloC.clientWidth));
    if (haloC.width !== size || haloC.height !== size) {
      haloC.width = size;
      haloC.height = size;
    }
  }
  const winampC = winampCanvas || document.getElementById('winamp-canvas');
  if (winampC && winampC.clientWidth > 0) {
    const targetW = winampC.clientWidth;
    if (winampC.width !== targetW) {
      winampC.width = targetW;
    }
  }
}

initCelestialHaloEngine();
initWinampEngine();
window.addEventListener('resize', resizeVisualizerCanvases);

function startAudioVisualizer() {
  initAudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (visualizerRaf) cancelAnimationFrame(visualizerRaf);

  const waveBars = document.querySelectorAll('#mode-wave .wave-bar');
  const auraCore = $('#fs-aura-core');
  const auraWaves = document.querySelectorAll('.aura-wave-circle');
  const modernArt = $('#fs-modern-art');

  function renderFrame() {
    if (document.hidden || audio.paused || !analyser) {
      waveBars.forEach(b => { b.style.height = '16px'; b.style.opacity = '0.35'; b.style.boxShadow = 'none'; });
      if (auraCore) auraCore.style.transform = 'scale(1)';
      if (haloCtx && haloCanvas) {
        haloCtx.clearRect(0, 0, haloCanvas.width, haloCanvas.height);
      }
      if (winampCtx && winampCanvas) {
        winampCtx.clearRect(0, 0, winampCanvas.width, winampCanvas.height);
      }
      visualizerRaf = null;
      return;
    }

    visualizerRaf = requestAnimationFrame(renderFrame);
    analyser.getByteFrequencyData(audioDataArray);

    const mode = fsPlayer.getAttribute('data-mode') || 'stage';

    // 1. Frequency Band Extraction
    const bass = ((audioDataArray[0] + audioDataArray[1] + audioDataArray[2] + audioDataArray[3]) / 4) / 255;
    const mid = ((audioDataArray[8] + audioDataArray[10] + audioDataArray[12]) / 3) / 255;
    const treble = ((audioDataArray[20] + audioDataArray[24] + audioDataArray[28]) / 3) / 255;

    // 2. Celestial Halo Mode (Orbital Translucent Soundring)
    if (mode === 'halo') {
      renderCelestialHaloFrame(bass, mid, treble, audioDataArray);
    }

    // 3. 90s Retro Mode (Winamp 2.x Spectrum / CRT Phosphor Oscilloscope)
    if (mode === 'retro90s') {
      renderWinampFrame(bass, mid, treble, audioDataArray);
    }

    // 7. Equalizer Wave Bars Mode
    if (mode === 'wave' && waveBars.length > 0) {
      const step = Math.max(1, Math.floor(audioDataArray.length / waveBars.length));
      waveBars.forEach((bar, idx) => {
        const bin = Math.min(idx * step, audioDataArray.length - 1);
        const val = audioDataArray[bin] || 0;
        const norm = val / 255;
        const h = Math.max(16, norm * 135);
        bar.style.height = `${h}px`;
        bar.style.opacity = `${Math.max(0.35, norm * 1.15)}`;
        bar.style.boxShadow = norm > 0.55 ? `0 0 ${norm * 22}px var(--accent, #d4b07a)` : 'none';
      });
    }

    // 8. Aura Mode Reactive Beat
    if (mode === 'aura' && auraCore) {
      const scale = 1 + bass * 0.32;
      auraCore.style.transform = `scale(${scale})`;
      auraCore.style.boxShadow = `0 0 ${35 + bass * 55}px var(--accent, #d4b07a), inset 0 0 ${15 + bass * 20}px rgba(255,255,255,0.9)`;
      auraWaves.forEach(ring => {
        ring.style.borderColor = `rgba(212,176,122, ${Math.min(0.85, 0.2 + bass * 0.65)})`;
      });
    }

    // 9. Modern Card Reactive Shadow
    if (mode === 'modern' && modernArt) {
      modernArt.style.boxShadow = `0 ${20 + bass * 28}px ${50 + bass * 40}px rgba(0,0,0,0.8), 0 0 ${bass * 30}px rgba(212,176,122,0.35)`;
    }
  }

  visualizerRaf = requestAnimationFrame(renderFrame);
}

audio.addEventListener('play', () => {
  startAudioVisualizer();
  if (is8DActive) run8DSpatialLoop();
});
audio.addEventListener('pause', () => {
  if (visualizerRaf) cancelAnimationFrame(visualizerRaf);
  if (spatialRaf) { cancelAnimationFrame(spatialRaf); spatialRaf = null; }
});

// ---- Media Session & Lockscreen Controls ---------------------
function updateMediaSessionMetadata(track) {
  if (!('mediaSession' in navigator) || !track) return;

  const artworkList = [];
  if (track.artwork_url) {
    const fullUrl = track.artwork_url.startsWith('http')
      ? track.artwork_url
      : (window.location.origin + track.artwork_url);
    artworkList.push(
      { src: fullUrl, sizes: '96x96', type: 'image/jpeg' },
      { src: fullUrl, sizes: '128x128', type: 'image/jpeg' },
      { src: fullUrl, sizes: '256x256', type: 'image/jpeg' },
      { src: fullUrl, sizes: '512x512', type: 'image/jpeg' }
    );
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album || 'Linus Collection',
    artwork: artworkList
  });
}

function updateMediaSessionPosition() {
  if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
  if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime, audio.duration)
      });
    } catch (e) {}
  }
}

function initMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;

  const handlers = [
    ['play', () => { if (audio.paused) togglePlayGlobal(); }],
    ['pause', () => { if (!audio.paused) togglePlayGlobal(); }],
    ['previoustrack', () => $('#previous').click()],
    ['nexttrack', () => $('#next').click()],
    ['stop', () => { audio.pause(); audio.currentTime = 0; }],
    ['seekto', (details) => {
      if (details.seekTime !== undefined && details.seekTime !== null) {
        audio.currentTime = details.seekTime;
        updateMediaSessionPosition();
      }
    }],
    ['seekforward', (details) => {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (details.seekOffset || 10));
      updateMediaSessionPosition();
    }],
    ['seekbackward', (details) => {
      audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10));
      updateMediaSessionPosition();
    }]
  ];

  handlers.forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (e) {}
  });
}

initMediaSessionHandlers();

// Sync playback state to mediaSession
audio.addEventListener('play', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});
audio.addEventListener('timeupdate', updateMediaSessionPosition);

// ---- Global Keyboard Shortcuts (Unified & Conflict-Free) -----
document.addEventListener('keydown', (e) => {
  // Ignore when user is typing in input fields, textareas, selects, or editable areas
  const activeEl = document.activeElement;
  const activeTag = activeEl ? activeEl.tagName.toLowerCase() : '';
  const isTyping = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || (activeEl && activeEl.isContentEditable);

  if (isTyping) {
    if (e.key === 'Escape') activeEl.blur();
    return;
  }

  // If a native dialog is open, let Escape close it and bypass media shortcuts
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog && e.key !== 'Escape') return;

  const key = e.key;
  const code = e.code;
  const lowerKey = key ? key.toLowerCase() : '';

  // 0. Cinema HUD Lock / Unlock (Ctrl + Shift + Y)
  if (e.ctrlKey && e.shiftKey && (lowerKey === 'y' || code === 'KeyY')) {
    e.preventDefault();
    if (typeof fsPlayer !== 'undefined' && fsPlayer && fsPlayer.classList.contains('open')) {
      toggleFsHudLock();
    }
    return;
  }

  // 1. Play / Pause (Space)
  if (key === ' ' || code === 'Space') {
    e.preventDefault();
    if (!audio.src) {
      const first = (queue && queue[0]) || (state.tracks && state.tracks.find(t => t.media_type !== 'video'));
      if (first) playById(first.id);
      return;
    }
    togglePlayGlobal();
    return;
  }

  // 2. Mute / Unmute (M)
  if (lowerKey === 'm' || code === 'KeyM') {
    e.preventDefault();
    toggleMuteGlobal();
    return;
  }

  // 3. Navigation: Previous / Seek Backward
  if (code === 'ArrowLeft' || key === 'ArrowLeft') {
    e.preventDefault();
    if (e.shiftKey) {
      $('#previous')?.click();
    } else {
      if (audio.duration) {
        audio.currentTime = Math.max(0, audio.currentTime - 5);
        notify(`-5s (${formatTime(audio.currentTime)})`);
      }
    }
    return;
  }

  // 4. Navigation: Next / Seek Forward
  if (code === 'ArrowRight' || key === 'ArrowRight') {
    e.preventDefault();
    if (e.shiftKey) {
      $('#next')?.click();
    } else {
      if (audio.duration) {
        audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
        notify(`+5s (${formatTime(audio.currentTime)})`);
      }
    }
    return;
  }

  // 5. Volume Up (ArrowUp)
  if (code === 'ArrowUp' || key === 'ArrowUp') {
    e.preventDefault();
    const newVol = Math.min(1, Math.round((audio.volume + 0.05) * 100) / 100);
    audio.volume = newVol;
    audio.muted = false;
    lastUnmutedVolume = newVol;
    updateVolumeUI(newVol);
    notify(`Volume: ${Math.round(newVol * 100)}%`);
    return;
  }

  // 6. Volume Down (ArrowDown)
  if (code === 'ArrowDown' || key === 'ArrowDown') {
    e.preventDefault();
    const newVol = Math.max(0, Math.round((audio.volume - 0.05) * 100) / 100);
    audio.volume = newVol;
    audio.muted = (newVol === 0);
    if (newVol > 0) lastUnmutedVolume = newVol;
    updateVolumeUI(newVol);
    notify(`Volume: ${Math.round(newVol * 100)}%`);
    return;
  }

  // 7. Track Navigation Keys (N for Next, P for Prev)
  if ((lowerKey === 'n' && !e.ctrlKey && !e.metaKey) || (lowerKey === 'k' && e.shiftKey)) {
    e.preventDefault();
    $('#next')?.click();
    return;
  }
  if ((lowerKey === 'p' && !e.ctrlKey && !e.metaKey && !e.shiftKey) || (lowerKey === 'j' && e.shiftKey)) {
    e.preventDefault();
    $('#previous')?.click();
    return;
  }

  // 8. Shuffle Toggle (S)
  if (lowerKey === 's' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    $('#shuffle-btn')?.click();
    return;
  }

  // 9. Repeat Mode Toggle (R)
  if (lowerKey === 'r' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    $('#repeat-btn')?.click();
    return;
  }

  // 10. Lyrics Toggle (L)
  if (lowerKey === 'l' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    $('#hero-lyrics')?.click();
    return;
  }

  // 11. Favorite Current Track (F) or Toggle True Fullscreen when Fullscreen player is open
  if (lowerKey === 'f' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (typeof fsPlayer !== 'undefined' && fsPlayer && fsPlayer.classList.contains('open')) {
      toggleTrueFullscreen();
      return;
    }
    const activeTrack = getActivePlaybackTrack() || (queue && queue[currentIndex]);
    if (activeTrack) {
      toggleFavorite(activeTrack.id);
    }
    return;
  }

  // 12. Karaoke Mode Toggle (K)
  if (lowerKey === 'k' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleKaraokeMode();
    return;
  }

  // 13. Auto-DJ Beat-Matched Crossfader Toggle (D)
  if (lowerKey === 'd' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    toggleAutoDJQuick();
    return;
  }

  // 14. Visualizer Mode Cycle (V)
  if (lowerKey === 'v' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    cycleFullscreenMode(1);
    const modeObj = FS_MODES.find(m => m.id === currentFsMode);
    if (modeObj) notify(`Visualizer: ${modeObj.name}`);
    return;
  }

  // 15. Quick Mode Direct Jump (1-5) when Fullscreen Player is open
  if (typeof fsPlayer !== 'undefined' && fsPlayer && fsPlayer.classList.contains('open') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const quickModeMap = { '1': 'stage', '2': 'vinyl', '3': 'retro90s', '4': 'halo', '5': 'clean' };
    if (quickModeMap[key]) {
      e.preventDefault();
      setFullscreenMode(quickModeMap[key]);
      const modeObj = FS_MODES.find(m => m.id === quickModeMap[key]);
      if (modeObj) notify(`Mode: ${modeObj.name}`);
      return;
    }
  }

  // 16. Escape: Dismiss Modals, Fullscreen Player, or Sidebar
  if (key === 'Escape') {
    if (openDialog) {
      openDialog.close();
      return;
    }
    const videoModal = $('#video-modal');
    if (videoModal && !videoModal.classList.contains('hidden')) {
      $('#video-modal-close')?.click();
      return;
    }
    const vizPanel = $('#fs-visualizer-panel');
    if (vizPanel && !vizPanel.classList.contains('hidden')) {
      closeVisualizerPanel();
      return;
    }
    if (typeof fsPlayer !== 'undefined' && fsPlayer && fsPlayer.classList.contains('open')) {
      if (isFsHudLocked) {
        toggleFsHudLock(false);
        return;
      }
      $('#fs-close')?.click() || fsPlayer.classList.remove('open');
      return;
    }
    if (typeof closeSidebar === 'function') {
      const isSidebarOpen = $('#sidebar')?.classList.contains('sidebar-open') || $('#sidebar')?.classList.contains('mobile-open');
      if (isSidebarOpen && !isSidebarPinned) {
        closeSidebar();
      }
    }
    return;
  }
});

// ---- Ambient Soundscapes & Sleep Timer Engine ----------------
class AmbientSoundscapeEngine {
  constructor() {
    this.ctx = null;
    this.layers = {
      rain: { gainNode: null, source: null, vol: 0 },
      fire: { gainNode: null, source: null, vol: 0 },
      ocean: { gainNode: null, source: null, vol: 0 },
      wind: { gainNode: null, source: null, vol: 0 }
    };
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  createNoiseBuffer(type = 'pink') {
    const ctx = this.ensureContext();
    const bufferSize = ctx.sampleRate * 4;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let lastOut = 0.0;

    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      if (type === 'pink') {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      } else if (type === 'brown') {
        lastOut = (lastOut + (0.02 * white)) / 1.02;
        data[i] = lastOut * 3.5;
      } else {
        data[i] = white * 0.2;
      }
    }
    return buffer;
  }

  setVolume(layerKey, vol) {
    this.ensureContext();
    const layer = this.layers[layerKey];
    if (!layer) return;
    layer.vol = vol;

    if (vol > 0 && !layer.source) {
      this.startLayer(layerKey);
    }
    if (layer.gainNode) {
      layer.gainNode.gain.setTargetAtTime(vol * 0.35, this.ctx.currentTime, 0.05);
    }
  }

  startLayer(key) {
    const ctx = this.ensureContext();
    const layer = this.layers[key];
    if (layer.source) return;

    const noiseBuffer = this.createNoiseBuffer(key === 'ocean' || key === 'fire' ? 'brown' : 'pink');
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(layer.vol * 0.35, ctx.currentTime);

    if (key === 'rain') {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1200;
      src.connect(filter);
      filter.connect(gain);
    } else if (key === 'fire') {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 450;
      filter.Q.value = 1.2;
      src.connect(filter);
      filter.connect(gain);
    } else if (key === 'ocean') {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 350;

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.12;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.15;
      lfo.connect(lfoGain.gain);
      lfo.start();

      src.connect(filter);
      filter.connect(gain);
    } else if (key === 'wind') {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 280;
      filter.Q.value = 2.0;

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.08;
      lfo.connect(filter.frequency);
      lfo.start();

      src.connect(filter);
      filter.connect(gain);
    }

    gain.connect(ctx.destination);
    src.start(0);

    layer.source = src;
    layer.gainNode = gain;
  }

  muteAll() {
    ['rain', 'fire', 'ocean', 'wind'].forEach(k => {
      this.setVolume(k, 0);
      const slider = $(`#ambient-${k}-slider`);
      if (slider) slider.value = 0;
      const valLabel = $(`#vol-${k}-val`);
      if (valLabel) valLabel.textContent = '0%';
      const card = $(`#card-${k}`);
      if (card) card.classList.remove('active');
    });
  }
}

const ambientEngine = new AmbientSoundscapeEngine();

// Hook Ambient Sliders
['rain', 'fire', 'ocean', 'wind'].forEach(key => {
  const slider = $(`#ambient-${key}-slider`);
  if (!slider) return;
  slider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    ambientEngine.setVolume(key, val);
    $(`#vol-${key}-val`).textContent = `${Math.round(val * 100)}%`;
    $(`#card-${key}`).classList.toggle('active', val > 0);
  });
});

$('#ambient-mute-all-btn').addEventListener('click', () => {
  ambientEngine.muteAll();
  notify('Atmosphere muted.');
});

// Sleep Timer Logic
let sleepTimerInterval = null;
let sleepTimeRemaining = 0;

function startSleepTimer(minutes) {
  if (sleepTimerInterval) clearInterval(sleepTimerInterval);
  sleepTimeRemaining = minutes * 60;

  const badge = $('#sleep-timer-badge');
  const cancelBtn = $('#sleep-cancel-btn');
  badge.classList.add('running');
  cancelBtn.classList.remove('hidden');

  document.querySelectorAll('.sleep-preset-btn:not(#sleep-cancel-btn)').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.minutes) === minutes);
  });

  notify(`🌙 Sleep timer set for ${minutes} minutes.`);
  updateSleepTimerDisplay();

  sleepTimerInterval = setInterval(() => {
    sleepTimeRemaining--;

    // Final 45 seconds: Gentle Volume Fade-Out
    if (sleepTimeRemaining <= 45 && sleepTimeRemaining > 0) {
      const fadeFraction = sleepTimeRemaining / 45;
      const userVol = parseFloat($('#volume').value) || 1;
      audio.volume = Math.max(0, fadeFraction * userVol);
    }

    if (sleepTimeRemaining <= 0) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
      audio.pause();
      ambientEngine.muteAll();
      badge.textContent = 'Off';
      badge.classList.remove('running');
      cancelBtn.classList.add('hidden');
      document.querySelectorAll('.sleep-preset-btn').forEach(b => b.classList.remove('active'));
      notify('💤 Sleep timer finished. Goodnight!');
      return;
    }

    updateSleepTimerDisplay();
  }, 1000);
}

function updateSleepTimerDisplay() {
  const badge = $('#sleep-timer-badge');
  const mins = Math.floor(sleepTimeRemaining / 60);
  const secs = sleepTimeRemaining % 60;
  badge.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function cancelSleepTimer() {
  if (sleepTimerInterval) clearInterval(sleepTimerInterval);
  sleepTimerInterval = null;
  sleepTimeRemaining = 0;
  const badge = $('#sleep-timer-badge');
  badge.textContent = 'Off';
  badge.classList.remove('running');
  $('#sleep-cancel-btn').classList.add('hidden');
  document.querySelectorAll('.sleep-preset-btn').forEach(b => b.classList.remove('active'));
  notify('Sleep timer cancelled.');
}

document.querySelectorAll('.sleep-preset-btn:not(#sleep-cancel-btn)').forEach(btn => {
  btn.addEventListener('click', () => {
    startSleepTimer(parseInt(btn.dataset.minutes));
  });
});
$('#sleep-cancel-btn').addEventListener('click', cancelSleepTimer);

// Dialog Open / Close
$('#ambient-toggle-btn').addEventListener('click', () => {
  ambientEngine.ensureContext();
  $('#ambient-sheet').showModal();
});
$('#ambient-close').addEventListener('click', () => $('#ambient-sheet').close());

// ---- Floating Picture-in-Picture Mini Player Engine ----------
let pipWindow = null;
let pipCanvas = null;
let pipVideo = null;
let pipCanvasCtx = null;

async function togglePictureInPicture() {
  if (!audio.src) {
    return notify('Play a song first to open the Mini Player.');
  }

  // 1. Modern Document Picture-in-Picture API (Interactive Window on top of all desktop apps)
  if ('documentPictureInPicture' in window) {
    try {
      if (pipWindow) {
        pipWindow.close();
        pipWindow = null;
        return;
      }

      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 380,
        height: 220
      });

      const pipDoc = pipWindow.document;
      pipDoc.title = 'Linus Mini Player';
      
      const style = pipDoc.createElement('style');
      style.textContent = `
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; user-select: none; }
        body {
          background: #09090b; color: #fff; height: 100vh; display: flex; flex-direction: column;
          justify-content: space-between; padding: 18px; overflow: hidden;
        }
        .pip-body { display: flex; align-items: center; gap: 14px; }
        .pip-disc {
          width: 64px; height: 64px; border-radius: 50%; background: #18181b;
          display: grid; place-items: center; overflow: hidden; position: relative;
          box-shadow: 0 4px 16px rgba(0,0,0,0.6); flex-shrink: 0;
          animation: spin 16s linear infinite; animation-play-state: paused;
        }
        .pip-disc.playing { animation-play-state: running; }
        .pip-disc img { width: 100%; height: 100%; object-fit: cover; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .pip-info { display: flex; flex-direction: column; gap: 4px; overflow: hidden; }
        .pip-title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pip-artist { font-size: 12px; color: rgba(255,255,255,0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pip-progress-track {
          width: 100%; height: 4px; background: rgba(255,255,255,0.15); border-radius: 2px;
          margin: 10px 0; overflow: hidden; cursor: pointer;
        }
        .pip-progress-fill { width: 0%; height: 100%; background: #d4b07a; }
        .pip-controls { display: flex; align-items: center; justify-content: center; gap: 16px; }
        .pip-btn {
          background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12);
          color: #fff; border-radius: 50%; width: 36px; height: 36px;
          display: grid; place-items: center; cursor: pointer; transition: 0.2s; font-size: 15px;
        }
        .pip-btn:hover { background: rgba(255,255,255,0.2); transform: scale(1.08); }
        .pip-btn-play {
          width: 44px; height: 44px; background: #fff; color: #000; font-size: 20px;
        }
      `;
      pipDoc.head.appendChild(style);

      pipDoc.body.innerHTML = `
        <div class="pip-body">
          <div class="pip-disc" id="p-disc">
            <div id="p-art" style="font-size:24px;">🎵</div>
          </div>
          <div class="pip-info">
            <div class="pip-title" id="p-title">Playing Track</div>
            <div class="pip-artist" id="p-artist">Artist</div>
          </div>
        </div>
        <div>
          <div class="pip-progress-track" id="p-track">
            <div class="pip-progress-fill" id="p-fill"></div>
          </div>
          <div class="pip-controls">
            <button class="pip-btn" id="p-prev">⏮</button>
            <button class="pip-btn pip-btn-play" id="p-play">⏸</button>
            <button class="pip-btn" id="p-next">⏭</button>
          </div>
        </div>
      `;

      const updatePipDom = () => {
        const curTrack = queue[currentIndex];
        if (!curTrack || !pipWindow) return;
        pipDoc.getElementById('p-title').textContent = curTrack.title;
        pipDoc.getElementById('p-artist').textContent = curTrack.artist;
        const disc = pipDoc.getElementById('p-disc');
        if (disc) disc.classList.toggle('playing', !audio.paused);
        
        const artBox = pipDoc.getElementById('p-art');
        if (artBox) {
          if (curTrack.has_artwork && curTrack.artwork_url) {
            artBox.innerHTML = `<img src="${window.location.origin + curTrack.artwork_url}">`;
          } else {
            artBox.innerHTML = `🎵`;
          }
        }
        pipDoc.getElementById('p-play').textContent = audio.paused ? '▶' : '⏸';
      };

      updatePipDom();

      pipDoc.getElementById('p-play').addEventListener('click', () => togglePlayGlobal());
      pipDoc.getElementById('p-prev').addEventListener('click', () => $('#previous').click());
      pipDoc.getElementById('p-next').addEventListener('click', () => $('#next').click());
      pipDoc.getElementById('p-track').addEventListener('click', (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        if (audio.duration) audio.currentTime = pct * audio.duration;
      });

      const pipProgressInterval = setInterval(() => {
        if (!pipWindow || pipWindow.closed) {
          clearInterval(pipProgressInterval);
          pipWindow = null;
          return;
        }
        if (audio.duration) {
          const pct = (audio.currentTime / audio.duration) * 100;
          const fill = pipDoc.getElementById('p-fill');
          if (fill) fill.style.width = `${pct}%`;
        }
        const playBtn = pipDoc.getElementById('p-play');
        if (playBtn) playBtn.textContent = audio.paused ? '▶' : '⏸';
        const disc = pipDoc.getElementById('p-disc');
        if (disc) disc.classList.toggle('playing', !audio.paused);
      }, 250);

      pipWindow.addEventListener('pagehide', () => {
        pipWindow = null;
      });

      notify('🪟 Mini Player opened (Always-on-Top)!');
      return;
    } catch (err) {
      console.warn('Document PiP fallback:', err);
    }
  }

  // 2. HTML5 Video Picture-in-Picture Fallback (Canvas stream)
  try {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
      return;
    }
    if (!pipCanvas) {
      pipCanvas = document.createElement('canvas');
      pipCanvas.width = 480;
      pipCanvas.height = 270;
      pipCanvasCtx = pipCanvas.getContext('2d');
      pipVideo = document.createElement('video');
      pipVideo.muted = true;
      pipVideo.srcObject = pipCanvas.captureStream(30);
      pipVideo.play();
    }

    const curTrack = queue[currentIndex] || { title: 'Linus Audio', artist: 'Playing' };
    pipCanvasCtx.fillStyle = '#0a0a0f';
    pipCanvasCtx.fillRect(0, 0, 480, 270);
    pipCanvasCtx.fillStyle = '#ffffff';
    pipCanvasCtx.font = 'bold 22px sans-serif';
    pipCanvasCtx.fillText(curTrack.title.slice(0, 30), 30, 120);
    pipCanvasCtx.fillStyle = 'rgba(255,255,255,0.6)';
    pipCanvasCtx.font = '16px sans-serif';
    pipCanvasCtx.fillText(curTrack.artist, 30, 155);

    await pipVideo.requestPictureInPicture();
    notify('🪟 Picture-in-Picture Mini Player active!');
  } catch (e) {
    notify('Picture-in-Picture not supported on this browser.');
  }
}

$('#pip-btn').addEventListener('click', togglePictureInPicture);
$('#fs-pip-btn').addEventListener('click', togglePictureInPicture);

// ---- In-App ID3 Tag Editor & Custom Artwork Uploader ----------
let currentEditArtworkBase64 = null;

function openEditTrackModal(trackId) {
  const track = trackById(trackId);
  if (!track) return;

  $('#edit-track-id').value = track.id;
  $('#edit-track-title').value = track.title || '';
  $('#edit-track-artist').value = track.artist || '';
  $('#edit-track-album').value = track.album || '';
  $('#edit-track-category').value = track.category || '';
  currentEditArtworkBase64 = null;

  const previewImg = $('#edit-art-img');
  const icon = $('#edit-art-icon');

  if (track.has_artwork && track.artwork_url) {
    previewImg.src = track.artwork_url;
    previewImg.classList.remove('hidden');
    icon.classList.add('hidden');
  } else {
    previewImg.src = '';
    previewImg.classList.add('hidden');
    icon.classList.remove('hidden');
  }

  $('#edit-track-sheet').showModal();
}

$('#edit-track-close').addEventListener('click', () => $('#edit-track-sheet').close());
$('#edit-track-cancel-btn').addEventListener('click', () => $('#edit-track-sheet').close());

$('#edit-art-preview').addEventListener('click', () => {
  $('#edit-art-input').click();
});

$('#edit-art-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    currentEditArtworkBase64 = ev.target.result;
    const previewImg = $('#edit-art-img');
    const icon = $('#edit-art-icon');
    previewImg.src = currentEditArtworkBase64;
    previewImg.classList.remove('hidden');
    icon.classList.add('hidden');
  };
  reader.readAsDataURL(file);
});

$('#edit-track-save-btn').addEventListener('click', async () => {
  const trackId = $('#edit-track-id').value;
  const title = $('#edit-track-title').value.trim();
  const artist = $('#edit-track-artist').value.trim();
  const album = $('#edit-track-album').value.trim();
  const category = $('#edit-track-category').value.trim();

  if (!title) {
    return notify('Title cannot be empty.');
  }

  const saveBtn = $('#edit-track-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const res = await api('/api/track/edit', {
      method: 'POST',
      body: JSON.stringify({
        track_id: trackId,
        title,
        artist,
        album,
        category,
        artwork: currentEditArtworkBase64
      })
    });

    if (res.success && res.tracks) {
      state.tracks = res.tracks;
      state.categories = res.categories || [];
      saveState();

      if (queue[currentIndex]?.id === trackId) {
        $('#hero-title').innerHTML = `${escapeHtml(title)}<br><em>is playing.</em>`;
        $('#hero-artist').textContent = `${artist} · ${album}`;
        $('#fs-title').textContent = title;
        $('#fs-artist').textContent = artist;
        if (currentEditArtworkBase64) {
          $('#album-art-box').innerHTML = `<img src="${currentEditArtworkBase64}">`;
        }
      }

      renderCategoryBar();
      renderTracks(state.tracks.filter(t => t.media_type !== 'video'));
      renderContinueRail();

      $('#edit-track-sheet').close();
      notify('✨ Track tags and artwork updated successfully!');
    }
  } catch (err) {
    notify('Failed to save track tags: ' + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="ph ph-floppy-disk"></i> Save Changes';
  }
});

// ---- Atmospheric Vibe & Living Aura Canvas Engine ------------
const VIBE_COLOR_PALETTES = {
  cozy: ['#e5a95d', '#b45309', '#78350f', '#f59e0b'],
  ecstatic: ['#d946ef', '#6366f1', '#a855f7', '#06b6d4'],
  sakura: ['#fb7185', '#db2777', '#f43f5e', '#fda4af'],
  emerald: ['#34d399', '#059669', '#10b981', '#6ee7b7'],
  ocean: ['#38bdf8', '#2563eb', '#0284c7', '#3b82f6'],
  noir: ['#ffffff', '#a1a1aa', '#71717a', '#52525b']
};

let currentVibe = localStorage.getItem('linus_vibe') || 'cozy';

function applyVibe(vibeKey, save = true) {
  if (!VIBE_COLOR_PALETTES[vibeKey]) vibeKey = 'cozy';
  currentVibe = vibeKey;
  document.body.dataset.vibe = vibeKey;
  if (save) localStorage.setItem('linus_vibe', vibeKey);

  document.querySelectorAll('.vibe-preset-card').forEach(card => {
    card.classList.toggle('active', card.dataset.vibe === vibeKey);
  });

  if (vibeKey === 'cozy') {
    $('#cozy-mode-quick-btn')?.classList.add('active');
  } else {
    $('#cozy-mode-quick-btn')?.classList.remove('active');
  }

  updateLivingAuraColors();
}

// Living Fluid Aura Canvas Engine
const livingCanvas = document.getElementById('living-aura-canvas');
let livingCtx = null;
let livingOrbs = [];

let livingRaf = null;

function renderLivingFrame() {
  if (document.hidden || !livingCanvas || livingCanvas.classList.contains('hidden')) {
    livingRaf = null;
    return;
  }
  livingRaf = requestAnimationFrame(renderLivingFrame);
  if (!livingCtx) return;

  const w = livingCanvas.width;
  const h = livingCanvas.height;
  livingCtx.clearRect(0, 0, w, h);

  let bassBoost = 0;
  if (!audio.paused && analyser && audioDataArray) {
    bassBoost = (audioDataArray[0] + audioDataArray[1] + audioDataArray[2]) / (3 * 255);
  }

  livingOrbs.forEach(orb => {
    orb.x += orb.vx;
    orb.y += orb.vy;
    orb.phase += 0.008;

    if (orb.x < -orb.radius) orb.x = w + orb.radius;
    if (orb.x > w + orb.radius) orb.x = -orb.radius;
    if (orb.y < -orb.radius) orb.y = h + orb.radius;
    if (orb.y > h + orb.radius) orb.y = -orb.radius;

    const dynamicRadius = orb.radius * (1 + Math.sin(orb.phase) * 0.1 + bassBoost * 0.22);

    const grad = livingCtx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, dynamicRadius);
    grad.addColorStop(0, orb.color);
    grad.addColorStop(1, 'transparent');

    livingCtx.fillStyle = grad;
    livingCtx.beginPath();
    livingCtx.arc(orb.x, orb.y, dynamicRadius, 0, Math.PI * 2);
    livingCtx.fill();
  });
}

function resumeLivingAura() {
  if (!livingRaf && livingCanvas && !livingCanvas.classList.contains('hidden') && !document.hidden) {
    renderLivingFrame();
  }
}

function initLivingAuraEngine() {
  if (!livingCanvas) return;
  livingCtx = livingCanvas.getContext('2d');

  function resizeLiving() {
    livingCanvas.width = window.innerWidth;
    livingCanvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeLiving);
  resizeLiving();

  const orbCount = 6;
  livingOrbs = [];
  const palette = VIBE_COLOR_PALETTES[currentVibe] || VIBE_COLOR_PALETTES.cozy;

  for (let i = 0; i < orbCount; i++) {
    livingOrbs.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      radius: Math.random() * 260 + 200,
      color: palette[i % palette.length],
      phase: Math.random() * Math.PI * 2
    });
  }

  resumeLivingAura();
}

function updateLivingAuraColors() {
  const palette = VIBE_COLOR_PALETTES[currentVibe] || VIBE_COLOR_PALETTES.cozy;
  livingOrbs.forEach((orb, i) => {
    orb.color = palette[i % palette.length];
  });
}

// Vibe Popover Trigger
const themeBtn = $('#theme-button');
const vibePopover = $('#vibe-popover');

if (themeBtn && vibePopover) {
  themeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    vibePopover.classList.toggle('show');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.vibe-switcher-wrapper')) {
      vibePopover.classList.remove('show');
    }
  });

  document.querySelectorAll('.vibe-preset-card').forEach(card => {
    card.addEventListener('click', () => {
      applyVibe(card.dataset.vibe);
      vibePopover.classList.remove('show');
      notify(`✨ Switched vibe to ${card.querySelector('strong').textContent}`);
    });
  });
}

// 1-Click Cozy Mode Toggle
let isCozyModeActive = false;
const cozyQuickBtn = $('#cozy-mode-quick-btn');

if (cozyQuickBtn) {
  cozyQuickBtn.addEventListener('click', () => {
    isCozyModeActive = !isCozyModeActive;
    if (isCozyModeActive) {
      applyVibe('cozy');
      ambientEngine.ensureContext();
      ambientEngine.setVolume('rain', 0.16);
      ambientEngine.setVolume('fire', 0.14);
      $('#vol-rain-val').textContent = '16%';
      $('#vol-fire-val').textContent = '14%';
      $('#ambient-rain-slider').value = 0.16;
      $('#ambient-fire-slider').value = 0.14;
      $('#card-rain').classList.add('active');
      $('#card-fire').classList.add('active');
      cozyQuickBtn.classList.add('active');
      notify('☕ Cozy Listening Mode Activated (Rain + Fireplace)');
    } else {
      ambientEngine.setVolume('rain', 0);
      ambientEngine.setVolume('fire', 0);
      $('#vol-rain-val').textContent = '0%';
      $('#vol-fire-val').textContent = '0%';
      $('#ambient-rain-slider').value = 0;
      $('#ambient-fire-slider').value = 0;
      $('#card-rain').classList.remove('active');
      $('#card-fire').classList.remove('active');
      cozyQuickBtn.classList.remove('active');
      notify('Cozy Mode Deactivated');
    }
  });
}

// Initialize Vibe and Living Aura on startup
// ============================================================
// Procedural Live Motion Canvas Engine (100% Reliable Client-Side Rendering)
// ============================================================
let motionCanvas = null;
let motionCtx = null;
let fsMotionCanvas = null;
let fsMotionCtx = null;
let motionAnimId = null;
let motionParticles = [];
let motionPreset = 'aura';
let motionTime = 0;

function initProceduralLiveMotion() {
  motionCanvas = $('#live-motion-canvas');
  if (motionCanvas) motionCtx = motionCanvas.getContext('2d');
  fsMotionCanvas = $('#fs-live-motion-canvas');
  if (fsMotionCanvas) fsMotionCtx = fsMotionCanvas.getContext('2d');

  function resizeMotionCanvases() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (motionCanvas) { motionCanvas.width = w; motionCanvas.height = h; }
    if (fsMotionCanvas) { fsMotionCanvas.width = w; fsMotionCanvas.height = h; }
    spawnParticlesForPreset(motionPreset);
  }

  window.addEventListener('resize', resizeMotionCanvases);
  resizeMotionCanvases();
  startMotionAnimationLoop();
}

function spawnParticlesForPreset(preset) {
  motionPreset = preset;
  motionParticles = [];
  const w = window.innerWidth;
  const h = window.innerHeight;

  if (preset === 'lofi' || preset === 'tokyo_night') {
    // Raindrops on dark window pane
    for (let i = 0; i < 140; i++) {
      motionParticles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        length: Math.random() * 26 + 14,
        speed: Math.random() * 14 + 10,
        opacity: Math.random() * 0.45 + 0.25,
        wind: -2.5 + Math.random() * 1.0,
        width: Math.random() * 1.5 + 0.8
      });
    }
  } else if (preset === 'fireplace') {
    // Rising warm fiery embers & sparks
    for (let i = 0; i < 110; i++) {
      motionParticles.push({
        x: w * 0.5 + (Math.random() - 0.5) * (w * 0.6),
        y: h + Math.random() * 100,
        size: Math.random() * 5 + 2,
        speedY: Math.random() * 3.5 + 1.8,
        speedX: (Math.random() - 0.5) * 2.2,
        life: Math.random() * 1,
        maxLife: Math.random() * 0.8 + 0.4,
        hue: 15 + Math.random() * 35 // Yellow/Orange/Red fire colors
      });
    }
  } else if (preset === 'cyber' || preset === 'sunset_drive' || preset === 'neon_tunnel') {
    // Neon Cyber Grid & Speed Streaks
    for (let i = 0; i < 90; i++) {
      motionParticles.push({
        x: (Math.random() - 0.5) * w * 2,
        y: (Math.random() - 0.5) * h * 2,
        z: Math.random() * 1000 + 10,
        color: i % 2 === 0 ? '#d946ef' : '#38bdf8'
      });
    }
  } else if (preset === 'space') {
    // Infinite twinkling space stars & cosmic dust
    for (let i = 0; i < 180; i++) {
      motionParticles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        radius: Math.random() * 2.2 + 0.5,
        alpha: Math.random() * 0.9 + 0.1,
        twinkleSpeed: Math.random() * 0.04 + 0.01,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        color: ['#ffffff', '#a5b4fc', '#e0e7ff', '#fbcfe8'][Math.floor(Math.random() * 4)]
      });
    }
  } else if (preset === 'ocean') {
    // Ambient oceanic sine waves
    for (let i = 0; i < 6; i++) {
      motionParticles.push({
        yOffset: h * 0.5 + i * 45,
        amplitude: 24 + i * 8,
        frequency: 0.003 + i * 0.0008,
        speed: 0.015 + i * 0.006,
        alpha: 0.18 + i * 0.07,
        color: i % 2 === 0 ? 'rgba(56, 189, 248,' : 'rgba(14, 165, 233,'
      });
    }
  } else if (preset === 'aurora_borealis') {
    // Flowing emerald and violet aurora ribbons
    for (let i = 0; i < 5; i++) {
      motionParticles.push({
        phase: Math.random() * Math.PI * 2,
        speed: 0.008 + i * 0.004,
        color: i % 2 === 0 ? '#34d399' : '#818cf8',
        y: h * (0.2 + i * 0.12)
      });
    }
  } else if (preset === 'mountain_clouds' || preset === 'cozy_coffee') {
    // Drifting atmospheric clouds & steam
    for (let i = 0; i < 28; i++) {
      motionParticles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        radius: Math.random() * 180 + 80,
        vx: Math.random() * 0.6 + 0.2,
        alpha: Math.random() * 0.18 + 0.06
      });
    }
  }
}

function renderMotionToContext(ctx, w, h, isFullscreen = false) {
  if (!ctx) return;
  motionTime += 0.018;

  // Background clear with dark aesthetic backdrop
  if (motionPreset === 'fireplace') {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#0c0705');
    bgGrad.addColorStop(1, '#240d04');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Render embers
    motionParticles.forEach(p => {
      p.y -= p.speedY;
      p.x += Math.sin(motionTime * 2 + p.speedX) * 1.5 + p.speedX * 0.4;
      p.life += 0.012;
      if (p.y < 0 || p.life > p.maxLife) {
        p.y = h + Math.random() * 40;
        p.x = w * 0.5 + (Math.random() - 0.5) * (w * 0.7);
        p.life = 0;
      }
      const alpha = Math.max(0, 1 - (p.life / p.maxLife));
      ctx.fillStyle = `hsla(${p.hue}, 100%, 65%, ${alpha})`;
      ctx.shadowColor = `hsl(${p.hue}, 100%, 50%)`;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.shadowBlur = 0;

  } else if (motionPreset === 'lofi' || motionPreset === 'tokyo_night') {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, motionPreset === 'tokyo_night' ? '#090514' : '#080c14');
    bgGrad.addColorStop(1, motionPreset === 'tokyo_night' ? '#1c0a2a' : '#101726');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Neon blur reflection lights
    ctx.fillStyle = motionPreset === 'tokyo_night' ? 'rgba(217, 70, 239, 0.15)' : 'rgba(56, 189, 248, 0.12)';
    ctx.beginPath();
    ctx.arc(w * 0.75, h * 0.3, 200, 0, Math.PI * 2);
    ctx.fill();

    // Render Rain
    ctx.strokeStyle = 'rgba(200, 225, 255, 0.6)';
    ctx.lineWidth = 1.2;
    motionParticles.forEach(p => {
      p.y += p.speed;
      p.x += p.wind;
      if (p.y > h) { p.y = -p.length; p.x = Math.random() * w; }
      ctx.strokeStyle = `rgba(180, 215, 255, ${p.opacity})`;
      ctx.lineWidth = p.width;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.wind * 2, p.y + p.length);
      ctx.stroke();
    });

  } else if (motionPreset === 'cyber' || motionPreset === 'sunset_drive' || motionPreset === 'neon_tunnel') {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#0a0212');
    bgGrad.addColorStop(0.65, '#20072b');
    bgGrad.addColorStop(1, '#05010a');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Synthwave Sun in center
    const sunGrad = ctx.createLinearGradient(w * 0.5, h * 0.2, w * 0.5, h * 0.65);
    sunGrad.addColorStop(0, '#ffed4a');
    sunGrad.addColorStop(0.5, '#f43f5e');
    sunGrad.addColorStop(1, '#a855f7');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.45, Math.min(w, h) * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // 3D Warp streaks
    const cx = w * 0.5;
    const cy = h * 0.5;
    motionParticles.forEach(p => {
      p.z -= 8;
      if (p.z <= 0) p.z = 1000;
      const k = 280 / p.z;
      const px = p.x * k + cx;
      const py = p.y * k + cy;
      if (px >= 0 && px <= w && py >= 0 && py <= h) {
        const size = Math.max(1.2, (1 - p.z / 1000) * 4);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fill();
      }
    });

  } else if (motionPreset === 'space') {
    ctx.fillStyle = '#05050c';
    ctx.fillRect(0, 0, w, h);

    // Cosmic Nebula Glow
    const nebGrad = ctx.createRadialGradient(w * 0.4, h * 0.5, 50, w * 0.4, h * 0.5, 380);
    nebGrad.addColorStop(0, 'rgba(147, 51, 234, 0.18)');
    nebGrad.addColorStop(0.5, 'rgba(59, 130, 246, 0.1)');
    nebGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = nebGrad;
    ctx.fillRect(0, 0, w, h);

    // Stars
    motionParticles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
      const twinkle = p.alpha * (0.6 + 0.4 * Math.sin(motionTime * 10 * p.twinkleSpeed));
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0.1, Math.min(1, twinkle));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;

  } else if (motionPreset === 'ocean') {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#040d1a');
    bgGrad.addColorStop(0.5, '#071d33');
    bgGrad.addColorStop(1, '#020912');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Golden Sunset Glow on water
    const sunGrad = ctx.createRadialGradient(w * 0.5, h * 0.35, 10, w * 0.5, h * 0.35, 240);
    sunGrad.addColorStop(0, 'rgba(251, 146, 60, 0.35)');
    sunGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = sunGrad;
    ctx.fillRect(0, 0, w, h);

    // Sine Waves
    motionParticles.forEach(wave => {
      ctx.fillStyle = `${wave.color} ${wave.alpha})`;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 15) {
        const y = wave.yOffset + Math.sin(x * wave.frequency + motionTime * 2 * wave.speed) * wave.amplitude;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    });

  } else if (motionPreset === 'aurora_borealis') {
    ctx.fillStyle = '#03080e';
    ctx.fillRect(0, 0, w, h);

    motionParticles.forEach(aurora => {
      const grad = ctx.createLinearGradient(0, aurora.y - 120, 0, aurora.y + 120);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(0.5, aurora.color);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.22;

      ctx.beginPath();
      ctx.moveTo(0, aurora.y);
      for (let x = 0; x <= w; x += 20) {
        const y = aurora.y + Math.sin(x * 0.004 + motionTime * aurora.speed + aurora.phase) * 60 +
                           Math.cos(x * 0.008 + motionTime * 0.5) * 30;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;

  } else if (motionPreset === 'mountain_clouds' || motionPreset === 'cozy_coffee') {
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#10111a');
    bgGrad.addColorStop(1, '#08080d');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    motionParticles.forEach(p => {
      p.x += p.vx;
      if (p.x - p.radius > w) p.x = -p.radius;
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius);
      grad.addColorStop(0, `rgba(210, 220, 240, ${p.alpha})`);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function startMotionAnimationLoop() {
  if (motionAnimId) cancelAnimationFrame(motionAnimId);
  motionAnimId = null;

  if (document.hidden) return;

  function frame() {
    if (document.hidden) {
      motionAnimId = null;
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;

    // Render on dashboard motion canvas if visible
    if (motionCanvas && !motionCanvas.classList.contains('hidden')) {
      renderMotionToContext(motionCtx, w, h, false);
    }

    // Render on fullscreen motion canvas if visible
    if (fsMotionCanvas && !fsMotionCanvas.classList.contains('hidden')) {
      renderMotionToContext(fsMotionCtx, w, h, true);
    }

    motionAnimId = requestAnimationFrame(frame);
  }

  motionAnimId = requestAnimationFrame(frame);
}

// Global Tab Visibility Performance Controller
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (!audio.paused) {
      startAudioVisualizer();
      if (is8DActive) run8DSpatialLoop();
    }
    startMotionAnimationLoop();
    if (typeof resumeLivingAura === 'function') resumeLivingAura();
  }
});

// ============================================================
// Personalization Studio & Live Atmosphere Engine
// ============================================================

const DEFAULT_USER_THEME = {
  accent: '#e5a95d',
  bg: '#0d0a08',
  surface: '#17120e',
  text: '#fdf6ec',
  fontFamily: 'serif',
  wallpaperType: 'aura',
  customImageSrc: '',
  customVideoSrc: '',
  wallpaperDim: 40,
  wallpaperBlur: 0,
  glassOpacity: 75,
  glowIntensity: 40,
  beatPulse: true,
  customVinylSticker: '',
  welcomeQuote: true,
  welcomeQuoteFrequency: 'always'
};

const VIDEO_WALLPAPER_URLS = {
  lofi: 'https://assets.mixkit.co/videos/preview/mixkit-rain-drops-on-a-window-at-night-42218-large.mp4',
  fireplace: 'https://assets.mixkit.co/videos/preview/mixkit-wood-burning-in-a-campfire-43050-large.mp4',
  cyber: 'https://assets.mixkit.co/videos/preview/mixkit-aerial-view-of-city-traffic-at-night-42095-large.mp4',
  space: 'https://assets.mixkit.co/videos/preview/mixkit-starry-sky-and-stars-moving-at-night-42358-large.mp4',
  ocean: 'https://assets.mixkit.co/videos/preview/mixkit-calm-waves-on-a-rocky-beach-at-sunset-41712-large.mp4',
  sunset_drive: 'https://assets.mixkit.co/videos/preview/mixkit-driving-down-a-highway-at-sunset-41743-large.mp4',
  tokyo_night: 'https://assets.mixkit.co/videos/preview/mixkit-crowded-street-in-tokyo-at-night-41584-large.mp4',
  mountain_clouds: 'https://assets.mixkit.co/videos/preview/mixkit-mountain-landscape-with-fog-and-clouds-42220-large.mp4',
  aurora_borealis: 'https://assets.mixkit.co/videos/preview/mixkit-northern-lights-over-the-ocean-at-night-42360-large.mp4',
  cozy_coffee: 'https://assets.mixkit.co/videos/preview/mixkit-steam-rising-from-a-cup-of-coffee-43048-large.mp4',
  neon_tunnel: 'https://assets.mixkit.co/videos/preview/mixkit-tunnel-of-futuristic-neon-lights-42999-large.mp4'
};

const STATIC_WALLPAPERS_CATALOG = [
  // --- Category: Anime & Cyberpunk ---
  { id: 'art_anime_sunset', title: 'Anime Twilight Sky', desc: 'Pastel sunset clouds & stars', cat: 'anime', url: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=400&q=80', featured: true },
  { id: 'art_cyberpunk_alley', title: 'Cyberpunk Neon Alley', desc: 'Dystopian futuristic city glow', cat: 'anime', url: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=400&q=80', featured: true },
  { id: 'art_tokyo_street', title: 'Shinjuku Cyber Street', desc: 'Neon rain Tokyo alleyway', cat: 'anime', url: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?w=400&q=80', featured: true },
  { id: 'art_neon_synth', title: 'Synthwave Horizon', desc: 'Retro grid sunset aesthetic', cat: 'anime', url: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1508739773434-c26b3d09e071?w=400&q=80', featured: true },
  { id: 'art_cyber_car', title: 'Midnight Cyber Cruise', desc: 'Sleek supercar night lights', cat: 'anime', url: 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=400&q=80', featured: true },
  { id: 'art_cyber_skyline', title: 'Neo Tokyo Skyline', desc: 'Futuristic metropolis skyscrapers', cat: 'anime', url: 'https://images.unsplash.com/photo-1514565131-fce0801e5785?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1514565131-fce0801e5785?w=400&q=80' },
  { id: 'art_anime_cherry_train', title: 'Sakura Train Crossing', desc: 'Spring anime railroad blossom', cat: 'anime', url: 'https://images.unsplash.com/photo-1528164344705-475426879c0d?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1528164344705-475426879c0d?w=400&q=80' },
  { id: 'art_neon_arcade', title: 'Akihabara Arcade Glow', desc: 'Retro arcade neon game signs', cat: 'anime', url: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?w=400&q=80' },
  { id: 'art_cyber_matrix', title: 'Digital Matrix Rain', desc: 'Glowing green cyberspace code', cat: 'anime', url: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=400&q=80' },
  { id: 'art_anime_rooftop', title: 'Anime Sunset Rooftop', desc: 'Overlooking golden hour cityscape', cat: 'anime', url: 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1519501025264-65ba15a82390?w=400&q=80' },

  // --- Category: Nature & Scenic ---
  { id: 'art_misty_forest', title: 'Misty Pine Forest', desc: 'Deep cinematic foggy evergreens', cat: 'nature', url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=400&q=80', featured: true },
  { id: 'art_fuji_sakura', title: 'Mount Fuji & Sakura', desc: 'Japanese cherry blossom spring', cat: 'nature', url: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=400&q=80', featured: true },
  { id: 'art_autumn_lake', title: 'Golden Autumn Forest', desc: 'Warm autumn morning sunlight', cat: 'nature', url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=400&q=80', featured: true },
  { id: 'art_desert_dunes', title: 'Sunset Desert Dunes', desc: 'Warm minimalist desert sand', cat: 'nature', url: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?w=400&q=80', featured: true },
  { id: 'art_nordic_aurora', title: 'Nordic Emerald Aurora', desc: 'Vibrant polar night sky', cat: 'nature', url: 'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1531366936337-7c912a4589a7?w=400&q=80', featured: true },
  { id: 'art_alpine_peaks', title: 'Swiss Alpine Peaks', desc: 'Snowy summit sun reflection', cat: 'nature', url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=400&q=80' },
  { id: 'art_tropical_coast', title: 'Emerald Tropical Coast', desc: 'Crystal turquoise ocean cove', cat: 'nature', url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&q=80' },
  { id: 'art_bamboo_grove', title: 'Kyoto Bamboo Grove', desc: 'Serene sunlit green stalks', cat: 'nature', url: 'https://images.unsplash.com/photo-1476820865390-c52aeebb9891?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1476820865390-c52aeebb9891?w=400&q=80' },
  { id: 'art_iceland_waterfall', title: 'Icelandic Canyon Fall', desc: 'Misty glacial river cascades', cat: 'nature', url: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1433086966358-54859d0ed716?w=400&q=80' },
  { id: 'art_lavender_field', title: 'Provence Lavender Fields', desc: 'Purple bloom sunset horizon', cat: 'nature', url: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=400&q=80' },
  { id: 'art_redwood_rays', title: 'Sunlit Redwood Canopy', desc: 'Golden rays piercing ancient trees', cat: 'nature', url: 'https://images.unsplash.com/photo-1511497584788-87676104235f?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1511497584788-87676104235f?w=400&q=80' },

  // --- Category: Space & Sci-Fi ---
  { id: 'art_cosmic_space', title: 'Celestial Galaxy Dust', desc: 'Deep space nebula & starlight', cat: 'space', url: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400&q=80', featured: true },
  { id: 'art_deep_nebula', title: 'Deep Violet Nebula', desc: 'Cosmic purple interstellar cloud', cat: 'space', url: 'https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?w=400&q=80' },
  { id: 'art_saturn_rings', title: 'Orbital Planet Horizon', desc: 'Celestial ring world perspective', cat: 'space', url: 'https://images.unsplash.com/photo-1614728894747-a83421e2b9c9?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1614728894747-a83421e2b9c9?w=400&q=80' },
  { id: 'art_milky_way_dunes', title: 'Milky Way Over Desert', desc: 'Glittering starry galactic core', cat: 'space', url: 'https://images.unsplash.com/photo-1509773896068-7fd415d91e2e?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1509773896068-7fd415d91e2e?w=400&q=80' },
  { id: 'art_moon_eclipse', title: 'Blood Moon Total Eclipse', desc: 'Dramatic cosmic lunar alignment', cat: 'space', url: 'https://images.unsplash.com/photo-1532693322450-2cb5c511067d?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1532693322450-2cb5c511067d?w=400&q=80' },
  { id: 'art_space_station', title: 'Earth from Space Orbit', desc: 'Atmospheric blue glow from ISS', cat: 'space', url: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=400&q=80' },
  { id: 'art_james_webb', title: 'Stellar Deep Field Nursery', desc: 'Infrared star cluster nursery', cat: 'space', url: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=400&q=80' },
  { id: 'art_supernova_burst', title: 'Supernova Cosmic Shock', desc: 'Blazing explosion of cosmic light', cat: 'space', url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=400&q=80' },

  // --- Category: Minimalist & Abstract ---
  { id: 'art_minimal_waves', title: 'The Great Wave', desc: 'Minimalist classic Great Wave', cat: 'minimal', url: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=400&q=80', featured: true },
  { id: 'art_dreamy_cloudscape', title: 'Dreamy Cotton Clouds', desc: 'Serene blue daylight skies', cat: 'minimal', url: 'https://images.unsplash.com/photo-1513002749550-c59d786b8e6c?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1513002749550-c59d786b8e6c?w=400&q=80', featured: true },
  { id: 'art_dark_glass', title: 'Obsidian Liquid Glass', desc: 'Smooth black iridescent curvature', cat: 'minimal', url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&q=80' },
  { id: 'art_pastel_gradient', title: 'Ethereal Sunset Gradient', desc: 'Gentle peach & violet blur', cat: 'minimal', url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=400&q=80' },
  { id: 'art_geometric_arch', title: 'Minimalist Bauhaus Arch', desc: 'Clean architectural geometry', cat: 'minimal', url: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?w=400&q=80' },
  { id: 'art_smoke_waves', title: 'Silk Ribbon Motion', desc: 'Monochrome flowing satin waves', cat: 'minimal', url: 'https://images.unsplash.com/photo-1507908708918-778587c9e563?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1507908708918-778587c9e563?w=400&q=80' },
  { id: 'art_sand_ripples', title: 'Zen Sand Ripples', desc: 'Textured golden wave pattern', cat: 'minimal', url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&q=80' },
  { id: 'art_monochrome_fog', title: 'Monochrome Lake Fog', desc: 'Minimalist misty lake reflection', cat: 'minimal', url: 'https://images.unsplash.com/photo-1483728642387-6c3bdd6c93e5?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1483728642387-6c3bdd6c93e5?w=400&q=80' },

  // --- Category: Cozy & Aesthetic ---
  { id: 'art_cozy_night_library', title: 'Midnight Cozy Library', desc: 'Warm vintage study books', cat: 'cozy', url: 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=400&q=80', featured: true },
  { id: 'art_rainy_cafe_window', title: 'Rainy Cafe Window', desc: 'Steaming espresso & streetlights', cat: 'cozy', url: 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=400&q=80' },
  { id: 'art_vinyl_turntable', title: 'Vintage Record Player', desc: 'Analog vinyl turntable warm glow', cat: 'cozy', url: 'https://images.unsplash.com/photo-1539185441755-769473a23570?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1539185441755-769473a23570?w=400&q=80' },
  { id: 'art_candle_hearth', title: 'Candlelight Warmth', desc: 'Warm candle flames and books', cat: 'cozy', url: 'https://images.unsplash.com/photo-1517411032315-54ef2cb783bb?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1517411032315-54ef2cb783bb?w=400&q=80' },
  { id: 'art_plant_sunroom', title: 'Botanical Plant Sunroom', desc: 'Lush potted greenery sunlit room', cat: 'cozy', url: 'https://images.unsplash.com/photo-1463936575829-25148e1db1b8?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1463936575829-25148e1db1b8?w=400&q=80' },
  { id: 'art_tea_ceramics', title: 'Japanese Tea Ceremony', desc: 'Artisanal matcha and ceramic bowl', cat: 'cozy', url: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=400&q=80' },
  { id: 'art_fairy_lights', title: 'Golden Fairy Lights', desc: 'Warm twinkling bedroom bokeh', cat: 'cozy', url: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1513151233558-d860c5398176?w=400&q=80' },
  { id: 'art_fireplace_blanket', title: 'Rustic Cabin Fireplace', desc: 'Cozy wool knit and crackling fire', cat: 'cozy', url: 'https://images.unsplash.com/photo-1542332213-31f87348057f?w=1920&q=85', thumb: 'https://images.unsplash.com/photo-1542332213-31f87348057f?w=400&q=80' }
];

// Quick lookup map for fast rendering
const STATIC_WALLPAPER_URLS = {};
STATIC_WALLPAPERS_CATALOG.forEach(item => {
  STATIC_WALLPAPER_URLS[item.id] = item.url;
});

// Wallpaper Usage Frequency Tracker (LocalStorage)
let wallpaperUsageHistory = JSON.parse(localStorage.getItem('linus_wallpaper_history') || '{}');

function recordWallpaperUsage(wallpaperId) {
  if (!wallpaperId || !STATIC_WALLPAPER_URLS[wallpaperId]) return;
  wallpaperUsageHistory[wallpaperId] = (wallpaperUsageHistory[wallpaperId] || 0) + 1;
  localStorage.setItem('linus_wallpaper_history', JSON.stringify(wallpaperUsageHistory));
  renderFeaturedWallpapersTray();
}

function getSortedWallpapersByUsage() {
  return [...STATIC_WALLPAPERS_CATALOG].sort((a, b) => {
    const scoreA = (wallpaperUsageHistory[a.id] || 0) * 10 + (a.featured ? 5 : 0);
    const scoreB = (wallpaperUsageHistory[b.id] || 0) * 10 + (b.featured ? 5 : 0);
    return scoreB - scoreA;
  });
}

let userTheme = JSON.parse(localStorage.getItem('linus_custom_theme') || 'null') || { ...DEFAULT_USER_THEME };

function hexToRgba(hex, alpha = 1) {
  if (!hex || hex[0] !== '#') return `rgba(229, 169, 93, ${alpha})`;
  let c = hex.substring(1);
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const num = parseInt(c, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function adjustHexBrightness(hex, percent) {
  try {
    let num = parseInt(hex.replace('#', ''), 16);
    let amt = Math.round(2.55 * percent);
    let r = (num >> 16) + amt;
    let g = (num >> 8 & 0x00FF) + amt;
    let b = (num & 0x0000FF) + amt;
    return '#' + (0x1000000 + (r < 255 ? r < 0 ? 0 : r : 255) * 0x10000 +
      (g < 255 ? g < 0 ? 0 : g : 255) * 0x100 +
      (b < 255 ? b < 0 ? 0 : b : 255)).toString(16).slice(1);
  } catch(e) {
    return hex;
  }
}

function applyUserTheme(theme, save = true) {
  userTheme = { ...DEFAULT_USER_THEME, ...theme };
  const root = document.documentElement;

  // Colors
  root.style.setProperty('--accent', userTheme.accent);
  root.style.setProperty('--accent-glow', hexToRgba(userTheme.accent, (userTheme.glowIntensity / 100) * 0.7));
  root.style.setProperty('--bg', userTheme.bg);
  root.style.setProperty('--surface', userTheme.surface);
  root.style.setProperty('--surface-hover', adjustHexBrightness(userTheme.surface, 15));
  root.style.setProperty('--surface-glass', hexToRgba(userTheme.surface, userTheme.glassOpacity / 100));
  root.style.setProperty('--text', userTheme.text);
  root.style.setProperty('--text-muted', hexToRgba(userTheme.text, 0.6));
  root.style.setProperty('--wallpaper-dim', `${userTheme.wallpaperDim / 100}`);
  root.style.setProperty('--wallpaper-blur', `${userTheme.wallpaperBlur}px`);

  // Typography
  if (userTheme.fontFamily === 'serif') {
    root.style.setProperty('--font-serif', "'Instrument Serif', serif");
    root.style.setProperty('--font-sans', "'Outfit', sans-serif");
  } else if (userTheme.fontFamily === 'sans') {
    root.style.setProperty('--font-serif', "'Outfit', sans-serif");
    root.style.setProperty('--font-sans', "'Outfit', sans-serif");
  } else if (userTheme.fontFamily === 'mono') {
    root.style.setProperty('--font-serif', "monospace");
    root.style.setProperty('--font-sans', "monospace");
  } else if (userTheme.fontFamily === 'cursive') {
    root.style.setProperty('--font-serif', "'Playfair Display', Georgia, serif");
    root.style.setProperty('--font-sans', "'Outfit', sans-serif");
  }

  // Live Wallpapers & Video Engine
  const auraCanvas = $('#living-aura-canvas');
  const motionCanvasEl = $('#live-motion-canvas');
  const videoEl = $('#live-wallpaper-video');
  const customImgBg = $('#custom-wallpaper-bg');
  const fsMotionCanvasEl = $('#fs-live-motion-canvas');
  const fsVideoEl = $('#fs-live-wallpaper-video');
  const fsCustomImgBg = $('#fs-custom-wallpaper-bg');

  // Hide all backdrops initially
  auraCanvas?.classList.add('hidden');
  motionCanvasEl?.classList.add('hidden');
  fsMotionCanvasEl?.classList.add('hidden');
  videoEl?.classList.add('hidden');
  fsVideoEl?.classList.add('hidden');
  customImgBg?.classList.add('hidden');
  fsCustomImgBg?.classList.add('hidden');

  // Dynamic Dimming & Blur Overlay (Main Player)
  const dimVal = (userTheme.wallpaperDim ?? 40) / 100;
  const dimOverlay = $('#wallpaper-dim-overlay');
  if (dimOverlay) dimOverlay.style.backgroundColor = `rgba(0, 0, 0, ${dimVal})`;

  const blurVal = userTheme.wallpaperBlur ?? 0;
  const blurFilter = blurVal > 0 ? `blur(${blurVal}px)` : 'none';
  [customImgBg, videoEl].forEach(el => {
    if (el) el.style.filter = blurFilter;
  });

  if (userTheme.wallpaperType === 'aura') {
    auraCanvas?.classList.remove('hidden');
    resumeLivingAura();
  } else if (STATIC_WALLPAPER_URLS[userTheme.wallpaperType]) {
    const imgUrl = STATIC_WALLPAPER_URLS[userTheme.wallpaperType];
    if (customImgBg) {
      customImgBg.style.backgroundImage = `url('${imgUrl}')`;
      customImgBg.classList.remove('hidden');
    }
    if (fsCustomImgBg) {
      fsCustomImgBg.style.backgroundImage = `url('${imgUrl}')`;
      fsCustomImgBg.classList.remove('hidden');
    }
  } else if (userTheme.wallpaperType === 'custom-image') {
    if (customImgBg && userTheme.customImageSrc) {
      customImgBg.style.backgroundImage = `url('${userTheme.customImageSrc}')`;
      customImgBg.classList.remove('hidden');
    }
    if (fsCustomImgBg && userTheme.customImageSrc) {
      fsCustomImgBg.style.backgroundImage = `url('${userTheme.customImageSrc}')`;
      fsCustomImgBg.classList.remove('hidden');
    }
  } else if (userTheme.wallpaperType === 'custom-video') {
    if (userTheme.customVideoSrc) {
      if (videoEl) {
        if (videoEl.src !== userTheme.customVideoSrc) {
          videoEl.src = userTheme.customVideoSrc;
          videoEl.load();
        }
        videoEl.play().catch(() => {});
        videoEl.classList.remove('hidden');
      }
      if (fsVideoEl) {
        if (fsVideoEl.src !== userTheme.customVideoSrc) {
          fsVideoEl.src = userTheme.customVideoSrc;
          fsVideoEl.load();
        }
        fsVideoEl.play().catch(() => {});
        fsVideoEl.classList.remove('hidden');
      }
    }
  } else if (VIDEO_WALLPAPER_URLS[userTheme.wallpaperType]) {
    const videoUrl = VIDEO_WALLPAPER_URLS[userTheme.wallpaperType];

    if (videoEl) {
      if (videoEl.src !== videoUrl) {
        videoEl.src = videoUrl;
        videoEl.load();
      }
      videoEl.play().catch(() => {
        // Fallback gracefully on network / autoplay issue
        videoEl.classList.add('hidden');
        spawnParticlesForPreset(userTheme.wallpaperType);
        motionCanvasEl?.classList.remove('hidden');
      });
      videoEl.classList.remove('hidden');
    }

    if (fsVideoEl) {
      if (fsVideoEl.src !== videoUrl) {
        fsVideoEl.src = videoUrl;
        fsVideoEl.load();
      }
      fsVideoEl.play().catch(() => {});
      fsVideoEl.classList.remove('hidden');
    }

    // Layer atmospheric particles on top of video for rich ambient depth
    spawnParticlesForPreset(userTheme.wallpaperType);
    motionCanvasEl?.classList.remove('hidden');
    fsMotionCanvasEl?.classList.remove('hidden');
    startMotionAnimationLoop();
  } else {
    // Curated Procedural Live Atmosphere
    spawnParticlesForPreset(userTheme.wallpaperType);
    motionCanvasEl?.classList.remove('hidden');
    fsMotionCanvasEl?.classList.remove('hidden');
    startMotionAnimationLoop();
  }

  // Custom Vinyl Sticker
  if (userTheme.customVinylSticker) {
    const fsArt = $('#fs-disk-art');
    if (fsArt) {
      fsArt.style.backgroundImage = `url('${userTheme.customVinylSticker}')`;
      fsArt.style.backgroundSize = 'cover';
      fsArt.style.backgroundPosition = 'center';
    }
    const fsLetter = $('#fs-disk-letter');
    if (fsLetter) fsLetter.textContent = '';
  }

  // Sync Studio UI Controls
  syncStudioUI();

  if (save) {
    localStorage.setItem('linus_custom_theme', JSON.stringify(userTheme));
    state.custom_theme = userTheme;
    saveState();
  }
}

function syncStudioUI() {
  if (!$('#picker-accent')) return;
  $('#picker-accent').value = userTheme.accent;
  $('#val-accent').textContent = userTheme.accent;
  $('#picker-bg').value = userTheme.bg;
  $('#val-bg').textContent = userTheme.bg;
  $('#picker-surface').value = userTheme.surface;
  $('#val-surface').textContent = userTheme.surface;
  $('#picker-text').value = userTheme.text;
  $('#val-text').textContent = userTheme.text;

  $('#slider-wallpaper-dim').value = userTheme.wallpaperDim;
  $('#val-wallpaper-dim').textContent = `${userTheme.wallpaperDim}%`;
  $('#slider-wallpaper-blur').value = userTheme.wallpaperBlur;
  $('#val-wallpaper-blur').textContent = `${userTheme.wallpaperBlur}px`;
  $('#slider-glass-opacity').value = userTheme.glassOpacity;
  $('#val-glass-opacity').textContent = `${userTheme.glassOpacity}%`;
  $('#slider-glow-intensity').value = userTheme.glowIntensity;
  $('#val-glow-intensity').textContent = `${userTheme.glowIntensity}%`;
  $('#toggle-beat-pulse').checked = userTheme.beatPulse;
  if ($('#toggle-welcome-quote')) {
    $('#toggle-welcome-quote').checked = userTheme.welcomeQuote !== false;
  }
  if ($('#welcome-quote-frequency')) {
    $('#welcome-quote-frequency').value = userTheme.welcomeQuoteFrequency || 'always';
  }

  // Font presets
  document.querySelectorAll('.font-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.font === userTheme.fontFamily);
  });

  // Wallpaper cards
  document.querySelectorAll('.wallpaper-card').forEach(card => {
    card.classList.toggle('active', card.dataset.wp === userTheme.wallpaperType);
  });

  // Custom media boxes
  const mediaBox = $('#custom-media-box');
  const imgGroup = $('#custom-img-group');
  const vidGroup = $('#custom-vid-group');
  if (userTheme.wallpaperType === 'custom-image') {
    mediaBox?.classList.remove('hidden');
    imgGroup?.classList.remove('hidden');
    vidGroup?.classList.add('hidden');
  } else if (userTheme.wallpaperType === 'custom-video') {
    mediaBox?.classList.remove('hidden');
    imgGroup?.classList.add('hidden');
    vidGroup?.classList.remove('hidden');
  } else {
    mediaBox?.classList.add('hidden');
  }
}

// Studio Modal Triggers
function openStudioCustomizer() {
  syncStudioUI();
  $('#theme-studio-sheet')?.showModal();
}

$('#open-studio-customizer-btn')?.addEventListener('click', () => {
  $('#vibe-popover')?.classList.remove('show');
  openStudioCustomizer();
});

$('#sidebar-studio-btn')?.addEventListener('click', () => {
  closeMobileSidebar();
  openStudioCustomizer();
});

$('#theme-studio-close')?.addEventListener('click', () => $('#theme-studio-sheet').close());
$('#studio-done-btn')?.addEventListener('click', () => {
  $('#theme-studio-sheet').close();
  notify('✨ Personalization and atmosphere applied!');
});

// Studio Tab Switching
document.querySelectorAll('.studio-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.studio-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.studio-tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`)?.classList.remove('hidden');
  });
});

// Real-time Color Pickers
$('#picker-accent')?.addEventListener('input', (e) => {
  userTheme.accent = e.target.value;
  $('#val-accent').textContent = e.target.value;
  applyUserTheme(userTheme);
});
$('#picker-bg')?.addEventListener('input', (e) => {
  userTheme.bg = e.target.value;
  $('#val-bg').textContent = e.target.value;
  applyUserTheme(userTheme);
});
$('#picker-surface')?.addEventListener('input', (e) => {
  userTheme.surface = e.target.value;
  $('#val-surface').textContent = e.target.value;
  applyUserTheme(userTheme);
});
$('#picker-text')?.addEventListener('input', (e) => {
  userTheme.text = e.target.value;
  $('#val-text').textContent = e.target.value;
  applyUserTheme(userTheme);
});

// Reset Colors
$('#reset-colors-btn')?.addEventListener('click', () => {
  userTheme.accent = DEFAULT_USER_THEME.accent;
  userTheme.bg = DEFAULT_USER_THEME.bg;
  userTheme.surface = DEFAULT_USER_THEME.surface;
  userTheme.text = DEFAULT_USER_THEME.text;
  applyUserTheme(userTheme);
  notify('Reset colors to default.');
});

// Font Presets
document.querySelectorAll('.font-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    userTheme.fontFamily = btn.dataset.font;
    applyUserTheme(userTheme);
  });
});

// Wallpaper Card Selection
// Subfolder Pill Switching for Dashboard Theme Studio
document.querySelectorAll('.subfolder-pill-btn:not(.fs-subfolder-pill-btn)').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subfolder-pill-btn:not(.fs-subfolder-pill-btn)').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.subfolder-view:not(.fs-subfolder-view)').forEach(v => v.classList.add('hidden'));
    btn.classList.add('active');
    $(`#subfolder-${btn.dataset.subfolder}`)?.classList.remove('hidden');
  });
});

// Subfolder Pill Switching for Fullscreen Studio
document.querySelectorAll('.fs-subfolder-pill-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fs-subfolder-pill-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.fs-subfolder-view').forEach(v => v.classList.add('hidden'));
    btn.classList.add('active');
    $(`#fs-subfolder-${btn.dataset.fssubfolder}`)?.classList.remove('hidden');
  });
});

document.querySelectorAll('.wallpaper-card').forEach(card => {
  card.addEventListener('click', () => {
    userTheme.wallpaperType = card.dataset.wp;
    applyUserTheme(userTheme);
    notify(`🎥 Background: ${card.querySelector('strong').textContent}`);
  });
});

// Custom Wallpaper Uploads
$('#custom-wallpaper-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await storeWallpaperBlob('fs_custom_image', file);
  const blobUrl = URL.createObjectURL(file);
  userTheme.customImageSrc = blobUrl;
  userTheme.wallpaperType = 'custom-image';
  applyUserTheme(userTheme);

  fsTheme.customImageSrc = blobUrl;
  fsTheme.wallpaperType = 'custom-image';
  if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
  fsTheme.wallpaperVignette = 0;
  applyFullscreenTheme(fsTheme);
  notify('🖼️ Custom wallpaper photo applied in uncompressed high resolution!');
});

$('#custom-wallpaper-url')?.addEventListener('change', async (e) => {
  const url = e.target.value.trim();
  if (!url) return;
  await ingestWallpaperUrl(url);
});

$('#custom-video-file')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const blobUrl = URL.createObjectURL(file);
  userTheme.customVideoSrc = blobUrl;
  userTheme.wallpaperType = 'custom-video';
  applyUserTheme(userTheme);
  notify('🎬 Custom live video wallpaper applied!');
});

$('#custom-video-url')?.addEventListener('change', (e) => {
  const url = e.target.value.trim();
  if (!url) return;
  userTheme.customVideoSrc = url;
  userTheme.wallpaperType = 'custom-video';
  applyUserTheme(userTheme);
  notify('🎬 Custom live video wallpaper applied from URL!');
});

// Sliders
$('#slider-wallpaper-dim')?.addEventListener('input', (e) => {
  userTheme.wallpaperDim = parseInt(e.target.value);
  $('#val-wallpaper-dim').textContent = `${userTheme.wallpaperDim}%`;
  applyUserTheme(userTheme);
});

$('#slider-wallpaper-blur')?.addEventListener('input', (e) => {
  userTheme.wallpaperBlur = parseInt(e.target.value);
  $('#val-wallpaper-blur').textContent = `${userTheme.wallpaperBlur}px`;
  applyUserTheme(userTheme);
});

$('#slider-glass-opacity')?.addEventListener('input', (e) => {
  userTheme.glassOpacity = parseInt(e.target.value);
  $('#val-glass-opacity').textContent = `${userTheme.glassOpacity}%`;
  applyUserTheme(userTheme);
});

$('#slider-glow-intensity')?.addEventListener('input', (e) => {
  userTheme.glowIntensity = parseInt(e.target.value);
  $('#val-glow-intensity').textContent = `${userTheme.glowIntensity}%`;
  applyUserTheme(userTheme);
});

$('#toggle-beat-pulse')?.addEventListener('change', (e) => {
  userTheme.beatPulse = e.target.checked;
  applyUserTheme(userTheme);
});

// Custom Vinyl Disc Sticker
$('#upload-disc-sticker-btn')?.addEventListener('click', () => {
  $('#custom-disc-sticker-file').click();
});

$('#custom-disc-sticker-file')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    userTheme.customVinylSticker = ev.target.result;
    applyUserTheme(userTheme);
    notify('🏷️ Custom vinyl disc center photo applied!');
  };
  reader.readAsDataURL(file);
});

$('#reset-disc-sticker-btn')?.addEventListener('click', () => {
  userTheme.customVinylSticker = '';
  const fsArt = $('#fs-disk-art');
  if (fsArt) fsArt.style.backgroundImage = 'none';
  applyUserTheme(userTheme);
  notify('Reset vinyl center label to default.');
});

$('#toggle-welcome-quote')?.addEventListener('change', (e) => {
  userTheme.welcomeQuote = e.target.checked;
  localStorage.setItem('linus_welcome_quote', e.target.checked ? 'true' : 'false');
  applyUserTheme(userTheme);
  notify(e.target.checked ? '💬 Welcome Quote Splash enabled.' : '💬 Welcome Quote Splash disabled.');
});

$('#welcome-quote-frequency')?.addEventListener('change', (e) => {
  userTheme.welcomeQuoteFrequency = e.target.value;
  localStorage.setItem('linus_welcome_quote_freq', e.target.value);
  applyUserTheme(userTheme);
  notify(`⏱️ Quote frequency set to: ${e.target.value === 'daily' ? 'Once a Day' : 'Every Launch'}`);
});

$('#studio-reset-all-btn')?.addEventListener('click', () => {
  if (!confirm('Reset all custom colors, wallpapers and effects to default?')) return;
  userTheme = { ...DEFAULT_USER_THEME };
  applyUserTheme(userTheme);
  notify('✨ Reset all customizations to default.');
});

// Apply custom user theme on boot
applyUserTheme(userTheme, false);

// ============================================================
// Full-Screen Dedicated Customizer & Lyrics Atmosphere Engine
// ============================================================

// IndexedDB High-Capacity Wallpaper Store (Supports 4K/8K uncompressed uploads)
const WP_DB_NAME = 'LinusWallpaperDB';
const WP_STORE_NAME = 'wallpapers';

function openWallpaperDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    const req = indexedDB.open(WP_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(WP_STORE_NAME)) {
        db.createObjectStore(WP_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function storeWallpaperBlob(key, blob) {
  const db = await openWallpaperDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(WP_STORE_NAME, 'readwrite');
      tx.objectStore(WP_STORE_NAME).put(blob, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function loadWallpaperBlob(key) {
  const db = await openWallpaperDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(WP_STORE_NAME, 'readonly');
      const req = tx.objectStore(WP_STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Smart URL Master-Resolution Cleaner (Strips thumbnail downscales & extracts full-res original)
function cleanMasterImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  let url = rawUrl.trim();

  try {
    // 1. Twitter / X Images: replace name=small/medium/900x900/large with name=orig
    if (url.includes('pbs.twimg.com/media/')) {
      const u = new URL(url);
      u.searchParams.set('name', 'orig');
      return u.toString();
    }

    // 2. Pinterest: replace /236x/, /474x/, /564x/, /736x/ with /originals/
    if (url.includes('pinimg.com/')) {
      return url.replace(/\/(236x|474x|564x|736x)\//, '/originals/');
    }

    // 3. Discord CDN: strip resizing/compressing query parameters and proxy domain
    if (url.includes('cdn.discordapp.com/attachments/') || url.includes('media.discordapp.net/attachments/')) {
      url = url.replace('media.discordapp.net', 'cdn.discordapp.com');
      const u = new URL(url);
      u.searchParams.delete('width');
      u.searchParams.delete('height');
      u.searchParams.delete('format');
      return u.toString();
    }

    // 4. Imgur thumbnails: remove s, m, l, t, h suffix before extension (e.g. abcd123m.jpg -> abcd123.jpg)
    const imgurMatch = url.match(/^(https?:\/\/i\.imgur\.com\/[a-zA-Z0-9]{5,8})[smlth](\.(jpg|jpeg|png|webp|gif))$/i);
    if (imgurMatch) {
      return imgurMatch[1] + imgurMatch[2];
    }

    // 5. Unsplash: maximize quality and remove width restrictions
    if (url.includes('images.unsplash.com/')) {
      const u = new URL(url);
      u.searchParams.set('q', '100');
      u.searchParams.delete('w');
      u.searchParams.delete('fit');
      return u.toString();
    }

    // 6. Reddit: replace preview.redd.it with i.redd.it and strip auto=webp query
    if (url.includes('preview.redd.it/')) {
      const u = new URL(url);
      return `https://i.redd.it${u.pathname}`;
    }

    // 7. Zerochan / Image boards: convert preview paths to full
    if (url.includes('zerochan.net') && (url.includes('s1.') || url.includes('s2.') || url.includes('static.'))) {
      return url.replace(/\/240\//, '/full/').replace(/\/600\//, '/full/');
    }
  } catch {
    // If URL parsing fails, return unmodified URL
  }

  return url;
}

// Background Ingestion: Fetches raw uncompressed binary with backend proxy fallback
async function fetchWallpaperBlob(rawUrl) {
  const cleanUrl = cleanMasterImageUrl(rawUrl);

  // 1. Direct fetch with no-referrer
  try {
    const directResp = await fetch(cleanUrl, {
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.9'
      }
    });
    if (directResp.ok) {
      const blob = await directResp.blob();
      if (blob && blob.size > 1000 && blob.type.startsWith('image/')) {
        return blob;
      }
    }
  } catch (e) {
    // Direct CORS blocked, proceed to backend fallback
  }

  // 2. Local Python Server proxy fallback (bypasses CORS and anti-hotlinking)
  try {
    const proxyUrl = `/api/wallpaper/fetch-url?url=${encodeURIComponent(cleanUrl)}`;
    const proxyResp = await fetch(proxyUrl);
    if (proxyResp.ok) {
      const blob = await proxyResp.blob();
      if (blob && blob.size > 1000) {
        return blob;
      }
    }
  } catch (err) {
    console.warn('Backend proxy fetch failed:', err);
  }

  return null;
}

// Unified Ingest Engine: Ingests URL, saves uncompressed blob to IndexedDB, applies to players
async function ingestWallpaperUrl(rawUrl) {
  const url = rawUrl.trim();
  if (!url) return false;

  notify('⏳ Ingesting uncompressed master image from link...');
  const blob = await fetchWallpaperBlob(url);

  if (blob) {
    // Store in IndexedDB for uncompressed persistence
    await storeWallpaperBlob('fs_custom_image', blob);
    const blobUrl = URL.createObjectURL(blob);

    // Verify natural dimensions and notify
    const probe = new Image();
    probe.src = blobUrl;
    probe.onload = () => {
      const w = probe.naturalWidth || 0;
      const h = probe.naturalHeight || 0;
      if (w > 0 && w < 1280) {
        notify(`⚠️ Image is ${w}×${h} (thumbnail). For 4K clarity, paste a direct link to the original master.`, 6000);
      } else {
        notify(`✨ Master-quality artwork loaded in uncompressed clarity! (${w}×${h})`);
      }
    };

    // Apply to Fullscreen Theme
    fsTheme.sourceUrl = cleanMasterImageUrl(url);
    fsTheme.customImageSrc = blobUrl;
    fsTheme.wallpaperType = 'custom-image';
    if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
    fsTheme.wallpaperVignette = 0;
    applyFullscreenTheme(fsTheme);

    // Also sync to Main Player Theme
    userTheme.sourceUrl = cleanMasterImageUrl(url);
    userTheme.customImageSrc = blobUrl;
    userTheme.wallpaperType = 'custom-image';
    applyUserTheme(userTheme);
    return true;
  } else {
    // Fallback if network blocked
    fsTheme.sourceUrl = cleanMasterImageUrl(url);
    fsTheme.customImageSrc = url;
    fsTheme.wallpaperType = 'custom-image';
    if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
    fsTheme.wallpaperVignette = 0;
    applyFullscreenTheme(fsTheme);

    userTheme.sourceUrl = cleanMasterImageUrl(url);
    userTheme.customImageSrc = url;
    userTheme.wallpaperType = 'custom-image';
    applyUserTheme(userTheme);
    notify('🖼️ Custom wallpaper URL applied!');
    return false;
  }
}

const DEFAULT_FS_THEME = {
  wallpaperType: 'match-main', // 'match-main', 'lofi', 'fireplace', 'cyber', 'space', 'ocean', 'custom-image', 'custom-video'
  customImageSrc: '',
  sourceUrl: '',
  customVideoSrc: '',
  wallpaperDim: 0,
  wallpaperBlur: 0,
  wallpaperVignette: 0,
  wallpaperBrightness: 100,
  wallpaperContrast: 100,
  wallpaperSaturation: 100,
  wallpaperFit: 'cover', // 'cover' or 'contain'
  wallpaperPos: 15, // vertical focus percentage (15% keeps halo and head visible)
  autoNativeFullscreen: true, // True monitor fullscreen (hides browser tabs & address bar)
  lyricsActiveColor: '#ffffff',
  lyricsActiveGlow: '#e5a95d',
  lyricsInactiveColor: '#ffffff',
  lyricsShadowColor: '#000000',
  lyricsPillOpacity: 15,
  lyricsGlowStrength: 60
};

let fsTheme = JSON.parse(localStorage.getItem('linus_fs_theme') || 'null') || { ...DEFAULT_FS_THEME };
// Migrate legacy 45% default dimming and ensure all quality properties exist
if (fsTheme && fsTheme.wallpaperDim === 45 && !localStorage.getItem('linus_fs_dim_customized')) {
  fsTheme.wallpaperDim = 0;
}
if (fsTheme && fsTheme.wallpaperVignette === undefined) {
  fsTheme.wallpaperVignette = (fsTheme.wallpaperType === 'match-main' ? 70 : 0);
}
if (fsTheme && fsTheme.wallpaperBrightness === undefined) fsTheme.wallpaperBrightness = 100;
if (fsTheme && fsTheme.wallpaperContrast === undefined) fsTheme.wallpaperContrast = 100;
if (fsTheme && fsTheme.wallpaperSaturation === undefined) fsTheme.wallpaperSaturation = 100;
if (fsTheme && fsTheme.wallpaperFit === undefined) fsTheme.wallpaperFit = 'cover';
if (fsTheme && fsTheme.wallpaperPos === undefined) fsTheme.wallpaperPos = 15;
if (fsTheme && fsTheme.autoNativeFullscreen === undefined) fsTheme.autoNativeFullscreen = true;

function applyFullscreenTheme(theme, save = true) {
  fsTheme = { ...DEFAULT_FS_THEME, ...theme };
  const root = document.documentElement;

  // Full Screen Lyrics & Glow Variables
  root.style.setProperty('--fs-lyrics-active', fsTheme.lyricsActiveColor);
  root.style.setProperty('--fs-lyrics-glow', hexToRgba(fsTheme.lyricsActiveGlow, (fsTheme.lyricsGlowStrength / 100)));
  root.style.setProperty('--fs-lyrics-inactive', hexToRgba(fsTheme.lyricsInactiveColor, 0.45));
  root.style.setProperty('--fs-lyrics-shadow', hexToRgba(fsTheme.lyricsShadowColor, 0.85));
  root.style.setProperty('--fs-lyrics-pill-opacity', `${fsTheme.lyricsPillOpacity / 100}`);

  // Clear any conflicting inline background-color on dim overlay
  const fsDimOverlay = $('#fs-wallpaper-dim-overlay');
  if (fsDimOverlay) fsDimOverlay.style.backgroundColor = '';

  // Full Screen Dimming & Blur
  const dimVal = (fsTheme.wallpaperDim ?? 0) / 100;
  const blurPx = fsTheme.wallpaperBlur ?? 0;
  root.style.setProperty('--fs-wallpaper-dim', `${dimVal}`);
  root.style.setProperty('--fs-wallpaper-blur', `${blurPx}px`);

  // Zero-overhead layer optimization: If dim and blur are 0, completely disable dim overlay
  if (dimVal === 0 && blurPx === 0) {
    fsDimOverlay?.classList.add('dim-disabled');
  } else {
    fsDimOverlay?.classList.remove('dim-disabled');
  }

  // Full Screen Dynamic Vignette (Edge Darkness)
  let vignetteVal = 0;
  if (fsTheme.wallpaperType === 'match-main') {
    vignetteVal = (fsTheme.wallpaperVignette !== undefined ? fsTheme.wallpaperVignette : 70) / 100;
  } else {
    vignetteVal = (fsTheme.wallpaperVignette ?? 0) / 100;
  }
  root.style.setProperty('--fs-wallpaper-vignette', `${vignetteVal}`);

  // Zero-overhead layer optimization: If vignette is 0, completely disable vignette overlay
  const fsBgOverlayEl = $('.fs-bg-overlay');
  if (vignetteVal === 0 && fsTheme.wallpaperType !== 'match-main') {
    fsBgOverlayEl?.classList.add('vignette-disabled');
  } else {
    fsBgOverlayEl?.classList.remove('vignette-disabled');
  }

  // Full Screen Live Video & Custom Wallpaper Elements
  const fsMotionCanvasEl = $('#fs-live-motion-canvas');
  const fsVideoEl = $('#fs-live-wallpaper-video');
  const fsWallpaperWrap = $('#fs-wallpaper-wrap');
  const fsAmbientBlur = $('#fs-wallpaper-ambient-blur');
  const fsCustomImg = $('#fs-custom-wallpaper-img');
  const fsCustomImgBg = $('#fs-custom-wallpaper-bg');
  const fsBg1 = $('#fs-bg-1');
  const fsBg2 = $('#fs-bg-2');

  // Fullscreen Wallpaper Image Filters (Blur, Brightness, Contrast, Saturation)
  const brightnessVal = (fsTheme.wallpaperBrightness ?? 100) / 100;
  const contrastVal = (fsTheme.wallpaperContrast ?? 100) / 100;
  const saturationVal = (fsTheme.wallpaperSaturation ?? 100) / 100;

  const filters = [];
  if (blurPx > 0) filters.push(`blur(${blurPx}px)`);
  if (brightnessVal !== 1) filters.push(`brightness(${brightnessVal})`);
  if (contrastVal !== 1) filters.push(`contrast(${contrastVal})`);
  if (saturationVal !== 1) filters.push(`saturate(${saturationVal})`);
  const filterStr = filters.length > 0 ? filters.join(' ') : 'none';

  if (fsCustomImg) fsCustomImg.style.filter = filterStr;
  if (fsCustomImgBg) fsCustomImgBg.style.filter = filterStr;
  if (fsVideoEl) fsVideoEl.style.filter = filterStr;

  // Framing & Scaling Properties
  const fitMode = fsTheme.wallpaperFit || 'cover';
  const posVal = fsTheme.wallpaperPos ?? 15;
  root.style.setProperty('--fs-wallpaper-fit', fitMode);
  root.style.setProperty('--fs-wallpaper-pos', `center ${posVal}%`);

  // Hide all full-screen layers first
  fsMotionCanvasEl?.classList.add('hidden');
  fsVideoEl?.classList.add('hidden');
  if (fsVideoEl && fsTheme.wallpaperType !== 'custom-video' && !STATIC_WALLPAPER_URLS[fsTheme.wallpaperType]) fsVideoEl.src = '';
  fsWallpaperWrap?.classList.add('hidden');
  fsCustomImgBg?.classList.add('hidden');
  if (fsBg1) fsBg1.style.display = 'none';
  if (fsBg2) fsBg2.style.display = 'none';

  if (fsTheme.wallpaperType === 'match-main') {
    // Dynamic Aurora (default)
    if (fsBg1) fsBg1.style.display = 'block';
    if (fsBg2) fsBg2.style.display = 'block';
  } else if (STATIC_WALLPAPER_URLS[fsTheme.wallpaperType] || fsTheme.wallpaperType === 'custom-image') {
    // Hardware-decoded High-Res Image Pipeline
    const imgUrl = STATIC_WALLPAPER_URLS[fsTheme.wallpaperType] || fsTheme.customImageSrc;
    if (imgUrl) {
      if (fsCustomImg) {
        if (fsCustomImg.src !== imgUrl) fsCustomImg.src = imgUrl;
      }
      if (fsAmbientBlur) {
        if (fitMode === 'contain') {
          fsAmbientBlur.style.backgroundImage = `url('${imgUrl}')`;
          fsAmbientBlur.classList.remove('hidden');
        } else {
          fsAmbientBlur.classList.add('hidden');
        }
      }
      fsWallpaperWrap?.classList.remove('hidden');
    }
  } else if (fsTheme.wallpaperType === 'custom-video') {
    // Custom Uploaded Video
    if (fsVideoEl && fsTheme.customVideoSrc) {
      if (fsVideoEl.src !== fsTheme.customVideoSrc) {
        fsVideoEl.src = fsTheme.customVideoSrc;
        fsVideoEl.load();
        fsVideoEl.play().catch(() => {});
      }
      fsVideoEl.classList.remove('hidden');
    }
  } else {
    // Procedural Live Atmosphere in Fullscreen
    spawnParticlesForPreset(fsTheme.wallpaperType);
    fsMotionCanvasEl?.classList.remove('hidden');
  }

  syncFullscreenStudioUI();

  if (save) {
    try {
      localStorage.setItem('linus_fs_theme', JSON.stringify(fsTheme));
    } catch (e) {
      console.warn('Could not save fsTheme to localStorage:', e);
    }
    state.fs_theme = fsTheme;
    saveState();
  }
}

function syncFullscreenStudioUI() {
  if (!$('#picker-fs-lyrics-active')) return;
  $('#picker-fs-lyrics-active').value = fsTheme.lyricsActiveColor;
  $('#val-fs-lyrics-active').textContent = fsTheme.lyricsActiveColor;
  $('#picker-fs-lyrics-glow').value = fsTheme.lyricsActiveGlow;
  $('#val-fs-lyrics-glow').textContent = fsTheme.lyricsActiveGlow;
  $('#picker-fs-lyrics-inactive').value = fsTheme.lyricsInactiveColor;
  $('#val-fs-lyrics-inactive').textContent = fsTheme.lyricsInactiveColor;
  $('#picker-fs-lyrics-shadow').value = fsTheme.lyricsShadowColor;
  $('#val-fs-lyrics-shadow').textContent = fsTheme.lyricsShadowColor;

  $('#slider-fs-lyrics-pill-opacity').value = fsTheme.lyricsPillOpacity;
  $('#val-fs-lyrics-pill-opacity').textContent = `${fsTheme.lyricsPillOpacity}%`;
  $('#slider-fs-lyrics-glow-strength').value = fsTheme.lyricsGlowStrength;
  $('#val-fs-lyrics-glow-strength').textContent = `${fsTheme.lyricsGlowStrength}%`;

  $('#slider-fs-wallpaper-dim').value = fsTheme.wallpaperDim ?? 0;
  $('#val-fs-wallpaper-dim').textContent = `${fsTheme.wallpaperDim ?? 0}%`;
  $('#slider-fs-wallpaper-blur').value = fsTheme.wallpaperBlur ?? 0;
  $('#val-fs-wallpaper-blur').textContent = `${fsTheme.wallpaperBlur ?? 0}px`;

  const vigSlider = $('#slider-fs-wallpaper-vignette');
  const vigVal = fsTheme.wallpaperType === 'match-main' && fsTheme.wallpaperVignette === undefined ? 70 : (fsTheme.wallpaperVignette ?? 0);
  if (vigSlider) vigSlider.value = vigVal;
  const vigLabel = $('#val-fs-wallpaper-vignette');
  if (vigLabel) vigLabel.textContent = `${vigVal}%`;

  const brightSlider = $('#slider-fs-wallpaper-brightness');
  const brightVal = fsTheme.wallpaperBrightness ?? 100;
  if (brightSlider) brightSlider.value = brightVal;
  const brightLabel = $('#val-fs-wallpaper-brightness');
  if (brightLabel) brightLabel.textContent = `${brightVal}%`;

  const contrastSlider = $('#slider-fs-wallpaper-contrast');
  const contrastVal = fsTheme.wallpaperContrast ?? 100;
  if (contrastSlider) contrastSlider.value = contrastVal;
  const contrastLabel = $('#val-fs-wallpaper-contrast');
  if (contrastLabel) contrastLabel.textContent = `${contrastVal}%`;

  const satSlider = $('#slider-fs-wallpaper-saturation');
  const satVal = fsTheme.wallpaperSaturation ?? 100;
  if (satSlider) satSlider.value = satVal;
  const satLabel = $('#val-fs-wallpaper-saturation');
  if (satLabel) satLabel.textContent = `${satVal}%`;

  const posSlider = $('#slider-fs-wallpaper-pos');
  const posVal = fsTheme.wallpaperPos ?? 15;
  if (posSlider) posSlider.value = posVal;
  const posLabel = $('#val-fs-wallpaper-pos');
  if (posLabel) {
    if (posVal <= 20) posLabel.textContent = `Top (${posVal}%)`;
    else if (posVal >= 80) posLabel.textContent = `Bottom (${posVal}%)`;
    else posLabel.textContent = `Center (${posVal}%)`;
  }

  // Framing button active states
  const fitMode = fsTheme.wallpaperFit || 'cover';
  document.querySelectorAll('.fs-fit-btn').forEach(btn => {
    const bFit = btn.dataset.fit;
    if (fitMode === 'contain' && bFit === 'contain') btn.classList.add('active');
    else if (fitMode === 'cover' && bFit === 'cover-top' && posVal <= 25) btn.classList.add('active');
    else if (fitMode === 'cover' && bFit === 'cover-center' && posVal > 25) btn.classList.add('active');
    else btn.classList.remove('active');
  });

  // Sync wallpaper cards
  document.querySelectorAll('.fs-wallpaper-card').forEach(card => {
    card.classList.toggle('active', card.dataset.fswp === fsTheme.wallpaperType);
  });

  // Custom media input container visibility
  const mediaBox = $('#fs-custom-media-box');
  const imgGroup = $('#fs-custom-img-group');
  const vidGroup = $('#fs-custom-vid-group');
  if (fsTheme.wallpaperType === 'custom-image') {
    mediaBox?.classList.remove('hidden');
    imgGroup?.classList.remove('hidden');
    vidGroup?.classList.add('hidden');
  } else if (fsTheme.wallpaperType === 'custom-video') {
    mediaBox?.classList.remove('hidden');
    imgGroup?.classList.add('hidden');
    vidGroup?.classList.remove('hidden');
  } else {
    mediaBox?.classList.add('hidden');
  }

  const autoFsCheck = $('#check-fs-auto-native-fullscreen');
  if (autoFsCheck) {
    autoFsCheck.checked = fsTheme.autoNativeFullscreen !== false;
  }
  updateTrueFullscreenUI();
}

// Fullscreen Studio Dialog Open/Close
$('#fs-studio-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  syncFullscreenStudioUI();
  $('#fs-theme-studio-sheet')?.showModal();
});

$('#fs-theme-studio-close')?.addEventListener('click', () => $('#fs-theme-studio-sheet')?.close());
$('#fs-studio-done-btn')?.addEventListener('click', () => {
  $('#fs-theme-studio-sheet')?.close();
  notify('✨ Full Screen atmosphere applied!');
});

// Fullscreen Studio Tab Switching
document.querySelectorAll('.fs-studio-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fs-studio-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.fs-tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    $(`#fs-tab-${btn.dataset.fstab}`)?.classList.remove('hidden');
  });
});

// Fullscreen Wallpaper Selection
document.querySelectorAll('.fs-wallpaper-card').forEach(card => {
  card.addEventListener('click', () => {
    fsTheme.wallpaperType = card.dataset.fswp;
    if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
    if (fsTheme.wallpaperVignette === undefined) fsTheme.wallpaperVignette = 0;
    applyFullscreenTheme(fsTheme);
    notify(`🎥 Full Screen: ${card.querySelector('strong').textContent}`);
  });
});

// Fullscreen Custom Photo / Video Uploads (with IndexedDB for uncompressed quality)
$('#fs-custom-wallpaper-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  // Store full uncompressed blob in IndexedDB (bypasses 5MB localStorage limit)
  await storeWallpaperBlob('fs_custom_image', file);
  const blobUrl = URL.createObjectURL(file);
  fsTheme.customImageSrc = blobUrl;
  fsTheme.wallpaperType = 'custom-image';
  if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
  fsTheme.wallpaperVignette = 0;
  applyFullscreenTheme(fsTheme);
  notify('🖼️ Full Screen custom photo loaded in uncompressed high resolution!');
});

$('#fs-custom-wallpaper-url')?.addEventListener('change', async (e) => {
  const url = e.target.value.trim();
  if (!url) return;
  await ingestWallpaperUrl(url);
});

$('#fs-custom-video-file')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const blobUrl = URL.createObjectURL(file);
  fsTheme.customVideoSrc = blobUrl;
  fsTheme.wallpaperType = 'custom-video';
  if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
  fsTheme.wallpaperVignette = 0;
  applyFullscreenTheme(fsTheme);
  notify('🎬 Full Screen live video applied!');
});

$('#fs-custom-video-url')?.addEventListener('change', (e) => {
  const url = e.target.value.trim();
  if (!url) return;
  fsTheme.customVideoSrc = url;
  fsTheme.wallpaperType = 'custom-video';
  if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
  fsTheme.wallpaperVignette = 0;
  applyFullscreenTheme(fsTheme);
  notify('🎬 Full Screen live video applied from URL!');
});

// Restore uncompressed custom image from IndexedDB on boot (with sourceUrl fallback)
loadWallpaperBlob('fs_custom_image').then(blob => {
  if (blob && fsTheme.wallpaperType === 'custom-image') {
    fsTheme.customImageSrc = URL.createObjectURL(blob);
    applyFullscreenTheme(fsTheme, false);
  } else if (fsTheme.wallpaperType === 'custom-image' && fsTheme.sourceUrl) {
    fsTheme.customImageSrc = fsTheme.sourceUrl;
    applyFullscreenTheme(fsTheme, false);
  }
}).catch(() => {
  if (fsTheme.wallpaperType === 'custom-image' && fsTheme.sourceUrl) {
    fsTheme.customImageSrc = fsTheme.sourceUrl;
    applyFullscreenTheme(fsTheme, false);
  }
});

// Framing & Fit Buttons
$('#fs-fit-cover-top')?.addEventListener('click', () => {
  fsTheme.wallpaperFit = 'cover';
  fsTheme.wallpaperPos = 15;
  applyFullscreenTheme(fsTheme);
  notify('🖼️ Top Focus applied — Head and Halo fully preserved!');
});

$('#fs-fit-cover-center')?.addEventListener('click', () => {
  fsTheme.wallpaperFit = 'cover';
  fsTheme.wallpaperPos = 50;
  applyFullscreenTheme(fsTheme);
  notify('🖼️ Center Focus applied!');
});

$('#fs-fit-contain')?.addEventListener('click', () => {
  fsTheme.wallpaperFit = 'contain';
  fsTheme.wallpaperPos = 50;
  applyFullscreenTheme(fsTheme);
  notify('🖼️ Fit Full Artwork applied — 100% of original image visible with ambient sides!');
});

// Vertical Framing / Camera Pan Slider
$('#slider-fs-wallpaper-pos')?.addEventListener('input', (e) => {
  fsTheme.wallpaperPos = parseInt(e.target.value);
  applyFullscreenTheme(fsTheme);
});

// Contrast Slider
$('#slider-fs-wallpaper-contrast')?.addEventListener('input', (e) => {
  fsTheme.wallpaperContrast = parseInt(e.target.value);
  $('#val-fs-wallpaper-contrast').textContent = `${fsTheme.wallpaperContrast}%`;
  applyFullscreenTheme(fsTheme);
});

// Vivid Art Boost Preset Button
$('#fs-vivid-boost-btn')?.addEventListener('click', () => {
  fsTheme.wallpaperContrast = 108;
  fsTheme.wallpaperSaturation = 115;
  fsTheme.wallpaperBrightness = 100;
  fsTheme.wallpaperDim = 0;
  fsTheme.wallpaperVignette = 0;
  applyFullscreenTheme(fsTheme);
  notify('🎨 Vivid Art Boost applied! Rich contrast & deep color saturation.');
});

// Pure Original Quality Mode Preset Button
$('#fs-pure-quality-btn')?.addEventListener('click', () => {
  fsTheme.wallpaperDim = 0;
  fsTheme.wallpaperVignette = 0;
  fsTheme.wallpaperBlur = 0;
  fsTheme.wallpaperBrightness = 100;
  fsTheme.wallpaperContrast = 100;
  fsTheme.wallpaperSaturation = 100;
  localStorage.setItem('linus_fs_dim_customized', 'true');
  applyFullscreenTheme(fsTheme);
  notify('✨ Pure 1:1 Passthrough applied! (Raw uncompressed quality)');
});

// Fullscreen Lyrics Color Pickers
$('#picker-fs-lyrics-active')?.addEventListener('input', (e) => {
  fsTheme.lyricsActiveColor = e.target.value;
  $('#val-fs-lyrics-active').textContent = e.target.value;
  applyFullscreenTheme(fsTheme);
});

$('#picker-fs-lyrics-glow')?.addEventListener('input', (e) => {
  fsTheme.lyricsActiveGlow = e.target.value;
  $('#val-fs-lyrics-glow').textContent = e.target.value;
  applyFullscreenTheme(fsTheme);
});

$('#picker-fs-lyrics-inactive')?.addEventListener('input', (e) => {
  fsTheme.lyricsInactiveColor = e.target.value;
  $('#val-fs-lyrics-inactive').textContent = e.target.value;
  applyFullscreenTheme(fsTheme);
});

$('#picker-fs-lyrics-shadow')?.addEventListener('input', (e) => {
  fsTheme.lyricsShadowColor = e.target.value;
  $('#val-fs-lyrics-shadow').textContent = e.target.value;
  applyFullscreenTheme(fsTheme);
});

$('#slider-fs-lyrics-pill-opacity')?.addEventListener('input', (e) => {
  fsTheme.lyricsPillOpacity = parseInt(e.target.value);
  $('#val-fs-lyrics-pill-opacity').textContent = `${fsTheme.lyricsPillOpacity}%`;
  applyFullscreenTheme(fsTheme);
});

$('#slider-fs-lyrics-glow-strength')?.addEventListener('input', (e) => {
  fsTheme.lyricsGlowStrength = parseInt(e.target.value);
  $('#val-fs-lyrics-glow-strength').textContent = `${fsTheme.lyricsGlowStrength}%`;
  applyFullscreenTheme(fsTheme);
});

// Fullscreen Atmosphere Sliders
$('#slider-fs-wallpaper-dim')?.addEventListener('input', (e) => {
  fsTheme.wallpaperDim = parseInt(e.target.value);
  $('#val-fs-wallpaper-dim').textContent = `${fsTheme.wallpaperDim}%`;
  localStorage.setItem('linus_fs_dim_customized', 'true');
  applyFullscreenTheme(fsTheme);
});

$('#slider-fs-wallpaper-vignette')?.addEventListener('input', (e) => {
  fsTheme.wallpaperVignette = parseInt(e.target.value);
  $('#val-fs-wallpaper-vignette').textContent = `${fsTheme.wallpaperVignette}%`;
  applyFullscreenTheme(fsTheme);
});

$('#slider-fs-wallpaper-brightness')?.addEventListener('input', (e) => {
  fsTheme.wallpaperBrightness = parseInt(e.target.value);
  $('#val-fs-wallpaper-brightness').textContent = `${fsTheme.wallpaperBrightness}%`;
  applyFullscreenTheme(fsTheme);
});

$('#slider-fs-wallpaper-saturation')?.addEventListener('input', (e) => {
  fsTheme.wallpaperSaturation = parseInt(e.target.value);
  $('#val-fs-wallpaper-saturation').textContent = `${fsTheme.wallpaperSaturation}%`;
  applyFullscreenTheme(fsTheme);
});

$('#slider-fs-wallpaper-blur')?.addEventListener('input', (e) => {
  fsTheme.wallpaperBlur = parseInt(e.target.value);
  $('#val-fs-wallpaper-blur').textContent = `${fsTheme.wallpaperBlur}px`;
  applyFullscreenTheme(fsTheme);
});

// Auto-enter true fullscreen preference
$('#check-fs-auto-native-fullscreen')?.addEventListener('change', (e) => {
  fsTheme.autoNativeFullscreen = e.target.checked;
  applyFullscreenTheme(fsTheme);
  notify(e.target.checked ? '🖥️ Auto True Fullscreen enabled (Tabs & URL bar will hide)' : '🖥️ Auto True Fullscreen disabled');
});

// Toggle Native Fullscreen Button in Studio
$('#fs-native-toggle-btn')?.addEventListener('click', () => {
  toggleTrueFullscreen();
});

// Fullscreen Lyrics Reset
$('#fs-reset-lyrics-colors-btn')?.addEventListener('click', () => {
  fsTheme.lyricsActiveColor = DEFAULT_FS_THEME.lyricsActiveColor;
  fsTheme.lyricsActiveGlow = DEFAULT_FS_THEME.lyricsActiveGlow;
  fsTheme.lyricsInactiveColor = DEFAULT_FS_THEME.lyricsInactiveColor;
  fsTheme.lyricsShadowColor = DEFAULT_FS_THEME.lyricsShadowColor;
  fsTheme.lyricsPillOpacity = DEFAULT_FS_THEME.lyricsPillOpacity;
  fsTheme.lyricsGlowStrength = DEFAULT_FS_THEME.lyricsGlowStrength;
  applyFullscreenTheme(fsTheme);
  notify('Reset Full Screen lyrics styling to default.');
});

// Fullscreen Reset All Defaults
$('#fs-studio-reset-all-btn')?.addEventListener('click', () => {
  fsTheme = { ...DEFAULT_FS_THEME };
  localStorage.removeItem('linus_fs_dim_customized');
  applyFullscreenTheme(fsTheme);
  notify('Reset Full Screen visual atmosphere to original defaults.');
});

// ============================================================
// 50+ Wallpaper Gallery Explorer & Most Used Tray Engine
// ============================================================

let currentGalleryTarget = 'main'; // 'main' or 'fullscreen'
let selectedGalleryCategory = 'all';

function renderFeaturedWallpapersTray() {
  const mainGrid = $('#featured-wallpapers-grid');
  const fsGrid = $('#fs-featured-wallpapers-grid');
  const sorted = getSortedWallpapersByUsage();
  const topFeatured = sorted.slice(0, 8); // Top 8 most used / popular on front page

  if (mainGrid) {
    mainGrid.innerHTML = topFeatured.map(wp => `
      <button class="wallpaper-card ${userTheme.wallpaperType === wp.id ? 'active' : ''}" data-wp="${wp.id}">
        <div class="wp-card-header">
          <div class="wallpaper-thumb-preview" style="background-image:url('${wp.thumb}')"></div>
          ${wallpaperUsageHistory[wp.id] ? `<span class="wp-card-badge"><i class="ph-fill ph-fire"></i> Most Used</span>` : ''}
        </div>
        <strong>${wp.title}</strong>
        <span>${wp.desc}</span>
      </button>
    `).join('');

    mainGrid.querySelectorAll('.wallpaper-card').forEach(card => {
      card.addEventListener('click', () => {
        userTheme.wallpaperType = card.dataset.wp;
        recordWallpaperUsage(card.dataset.wp);
        applyUserTheme(userTheme);
        notify(`🖼️ Wallpaper: ${card.querySelector('strong').textContent}`);
      });
    });
  }

  if (fsGrid) {
    fsGrid.innerHTML = topFeatured.map(wp => `
      <div class="wallpaper-card fs-wallpaper-card ${fsTheme.wallpaperType === wp.id ? 'active' : ''}" data-fswp="${wp.id}">
        <div class="wp-card-header">
          <div class="wallpaper-thumb-preview" style="background-image:url('${wp.thumb}')"></div>
          ${wallpaperUsageHistory[wp.id] ? `<span class="wp-card-badge"><i class="ph-fill ph-fire"></i> Most Used</span>` : ''}
        </div>
        <strong>${wp.title}</strong>
        <span>${wp.desc}</span>
      </div>
    `).join('');

    fsGrid.querySelectorAll('.fs-wallpaper-card').forEach(card => {
      card.addEventListener('click', () => {
        fsTheme.wallpaperType = card.dataset.fswp;
        recordWallpaperUsage(card.dataset.fswp);
        if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
        if (fsTheme.wallpaperVignette === undefined) fsTheme.wallpaperVignette = 0;
        applyFullscreenTheme(fsTheme);
        notify(`🖼️ Fullscreen Wallpaper: ${card.querySelector('strong').textContent}`);
      });
    });
  }
}

function renderFullWallpaperGallery(category = 'all') {
  selectedGalleryCategory = category;
  const grid = $('#full-gallery-grid');
  if (!grid) return;

  const filtered = category === 'all' 
    ? STATIC_WALLPAPERS_CATALOG 
    : STATIC_WALLPAPERS_CATALOG.filter(w => w.cat === category);

  grid.innerHTML = filtered.map(wp => {
    const isSelected = currentGalleryTarget === 'fullscreen' 
      ? fsTheme.wallpaperType === wp.id 
      : userTheme.wallpaperType === wp.id;

    return `
      <button class="wallpaper-card ${isSelected ? 'active' : ''}" data-gallery-id="${wp.id}">
        <div class="wp-card-header">
          <div class="wallpaper-thumb-preview" style="background-image:url('${wp.thumb}')"></div>
          ${wallpaperUsageHistory[wp.id] ? `<span class="wp-card-badge"><i class="ph-fill ph-star"></i> Top Pick</span>` : ''}
        </div>
        <strong>${wp.title}</strong>
        <span>${wp.desc}</span>
      </button>
    `;
  }).join('');

  grid.querySelectorAll('.wallpaper-card').forEach(card => {
    card.addEventListener('click', () => {
      const wpId = card.dataset.galleryId;
      recordWallpaperUsage(wpId);
      if (currentGalleryTarget === 'fullscreen') {
        fsTheme.wallpaperType = wpId;
        if (fsTheme.wallpaperDim === 45) fsTheme.wallpaperDim = 0;
        if (fsTheme.wallpaperVignette === undefined) fsTheme.wallpaperVignette = 0;
        applyFullscreenTheme(fsTheme);
        notify(`🖼️ Fullscreen: ${card.querySelector('strong').textContent}`);
      } else {
        userTheme.wallpaperType = wpId;
        applyUserTheme(userTheme);
        notify(`🖼️ Background: ${card.querySelector('strong').textContent}`);
      }
      renderFullWallpaperGallery(selectedGalleryCategory);
      $('#wallpaper-gallery-sheet')?.close();
    });
  });
}

function openWallpaperGallery(target = 'main') {
  currentGalleryTarget = target;
  renderFullWallpaperGallery(selectedGalleryCategory);
  $('#wallpaper-gallery-sheet')?.showModal();
}

// Category filter chip event listeners
document.querySelectorAll('#gallery-category-chips .cat-chip-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#gallery-category-chips .cat-chip-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderFullWallpaperGallery(btn.dataset.cat);
  });
});

// Open Gallery Triggers
$('#open-wallpaper-gallery-btn')?.addEventListener('click', () => openWallpaperGallery('main'));
$('#see-more-banner-btn')?.addEventListener('click', () => openWallpaperGallery('main'));
$('#fs-open-wallpaper-gallery-btn')?.addEventListener('click', () => openWallpaperGallery('fullscreen'));
$('#fs-see-more-banner-btn')?.addEventListener('click', () => openWallpaperGallery('fullscreen'));

$('#wallpaper-gallery-close')?.addEventListener('click', () => $('#wallpaper-gallery-sheet')?.close());
$('#wallpaper-gallery-done-btn')?.addEventListener('click', () => $('#wallpaper-gallery-sheet')?.close());

// ============================================================
// Click-Outside Auto-Dismiss & Auto-Save for All Modals / Dialogs
// ============================================================
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', (e) => {
    // When clicking directly on the dialog element (the backdrop area outside the inner container)
    const rect = dialog.getBoundingClientRect();
    const isInDialog = (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    );

    // If click occurred on the backdrop area outside the content box
    if (!isInDialog || e.target === dialog) {
      dialog.close();
      if (dialog.id === 'theme-studio-sheet' || dialog.id === 'fs-theme-studio-sheet') {
        notify('✨ Changes saved and applied!');
      }
    }
  });
});

// Video Modal Backdrop Click-Outside
$('#video-modal-backdrop')?.addEventListener('click', () => {
  $('#video-modal')?.classList.add('hidden');
  const vp = $('#video-player');
  if (vp) vp.pause();
  const ytp = $('#youtube-video-player');
  if (ytp) ytp.src = '';
});

// ============================================================
// Real-Time Live Slider Dragging Peek Transparency
// ============================================================
function initSliderPeekTransparency() {
  document.querySelectorAll('input[type="range"]').forEach(slider => {
    const dialog = slider.closest('dialog');
    if (!dialog) return;

    const startPeek = () => {
      dialog.classList.add('slider-peek-active');
    };

    const stopPeek = () => {
      dialog.classList.remove('slider-peek-active');
    };

    slider.addEventListener('pointerdown', startPeek);
    slider.addEventListener('mousedown', startPeek);
    slider.addEventListener('touchstart', startPeek, { passive: true });

    slider.addEventListener('pointerup', stopPeek);
    slider.addEventListener('mouseup', stopPeek);
    slider.addEventListener('touchend', stopPeek);
    slider.addEventListener('change', stopPeek);
    slider.addEventListener('blur', stopPeek);
  });

  // Global safety release if dragged and released outside slider bounds
  window.addEventListener('pointerup', () => {
    document.querySelectorAll('dialog.slider-peek-active').forEach(d => d.classList.remove('slider-peek-active'));
  });
  window.addEventListener('mouseup', () => {
    document.querySelectorAll('dialog.slider-peek-active').forEach(d => d.classList.remove('slider-peek-active'));
  });
  window.addEventListener('touchend', () => {
    document.querySelectorAll('dialog.slider-peek-active').forEach(d => d.classList.remove('slider-peek-active'));
  });
}

// Initialize Full Screen theme & Wallpapers on boot
renderFeaturedWallpapersTray();
initProceduralLiveMotion();
initSliderPeekTransparency();
updateRadioModeUI();
updateAudioNormUI();
updateKaraokeUI();
updateChameleonUI();
initHoverPreview();
initWeeklyRewind();
initStreakHeatmap();
initVibeCompass();
applyFullscreenTheme(fsTheme, false);

// Launch smooth introductory sidebar roll-out animation & check pinned state
initSidebarRolloutIntro();

// ============================================================
// Welcome Quote Splash Engine (Offline-First & Zero-Latency)
// ============================================================

const BUNDLED_INSPIRATIONAL_QUOTES = [
  { text: "Knowing yourself is the beginning of all wisdom.", author: "Aristotle", tag: "Wisdom" },
  { text: "You have power over your mind - not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius", tag: "Philosophy" },
  { text: "We suffer more often in imagination than in reality.", author: "Seneca", tag: "Stoicism" },
  { text: "The journey of a thousand miles begins with a single step.", author: "Lao Tzu", tag: "Wisdom" },
  { text: "In the depth of winter, I finally learned that within me there lay an invincible summer.", author: "Albert Camus", tag: "Resilience" },
  { text: "Smile, breathe, and go slowly.", author: "Thich Nhat Hanh", tag: "Mindfulness" },
  { text: "Muddy water is best cleared by leaving it alone.", author: "Alan Watts", tag: "Peace" },
  { text: "Your time is limited, so don't waste it living someone else's life.", author: "Steve Jobs", tag: "Purpose" },
  { text: "Be like water making its way through cracks. Do not be assertive, but adjust to the object.", author: "Bruce Lee", tag: "Courage" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela", tag: "Resilience" },
  { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci", tag: "Design" },
  { text: "Creativity is intelligence having fun.", author: "Albert Einstein", tag: "Creativity" },
  { text: "Adopt the pace of nature: her secret is patience.", author: "Ralph Waldo Emerson", tag: "Nature" },
  { text: "Somewhere, something incredible is waiting to be known.", author: "Carl Sagan", tag: "Wonder" },
  { text: "Dwell on the beauty of life. Watch the stars, and see yourself running with them.", author: "Marcus Aurelius", tag: "Wonder" },
  { text: "Look up at the stars and not down at your feet. Try to make sense of what you see.", author: "Stephen Hawking", tag: "Curiosity" },
  { text: "Twenty years from now you will be more disappointed by the things that you didn't do than by the ones you did do.", author: "Mark Twain", tag: "Life" },
  { text: "Beauty will save the world.", author: "Fyodor Dostoevsky", tag: "Humanity" },
  { text: "The wound is the place where the Light enters you.", author: "Rumi", tag: "Spiritual" },
  { text: "Music is the silence between the notes.", author: "Claude Debussy", tag: "Acoustics" },
  { text: "Where words fail, music speaks.", author: "Hans Christian Andersen", tag: "Music" },
  { text: "There is nothing more musical than a sunset.", author: "Claude Debussy", tag: "Atmosphere" },
  { text: "Everything in the universe has a rhythm, everything dances.", author: "Maya Angelou", tag: "Rhythm" },
  { text: "Live in the sunshine, swim the sea, drink the wild air.", author: "Ralph Waldo Emerson", tag: "Life" },
  { text: "Silence is an answer too.", author: "Rumi", tag: "Peace" }
];

let quoteSplashIsDismissed = false;

function getRandomLocalQuote() {
  return BUNDLED_INSPIRATIONAL_QUOTES[Math.floor(Math.random() * BUNDLED_INSPIRATIONAL_QUOTES.length)];
}

function dismissQuoteSplash() {
  if (quoteSplashIsDismissed) return;
  quoteSplashIsDismissed = true;

  const overlay = $('#quote-splash-overlay');
  if (!overlay) return;

  overlay.classList.add('dissolve');

  // Mark today's date so "daily" frequency knows it was shown today
  const todayStr = new Date().toISOString().slice(0, 10);
  localStorage.setItem('linus_last_quote_date', todayStr);

  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
  }, 580);
}

function renderSplashQuote(quote, animate = false) {
  const textEl = $('#quote-splash-text');
  const authorEl = $('#quote-splash-author');
  const tagEl = $('#quote-splash-tag');
  if (!textEl || !authorEl) return;

  if (animate) {
    textEl.classList.add('quote-fade-out');
    $('#quote-splash-meta')?.classList.add('quote-fade-out');
    setTimeout(() => {
      textEl.textContent = `“${quote.text.replace(/^[“"]|[”"]$/g, '')}”`;
      authorEl.textContent = quote.author || 'Anonymous';
      if (tagEl) tagEl.textContent = quote.tag ? quote.tag.toUpperCase() : 'INSPIRATION';
      textEl.classList.remove('quote-fade-out');
      $('#quote-splash-meta')?.classList.remove('quote-fade-out');
    }, 220);
  } else {
    textEl.textContent = `“${quote.text.replace(/^[“"]|[”"]$/g, '')}”`;
    authorEl.textContent = quote.author || 'Anonymous';
    if (tagEl) tagEl.textContent = quote.tag ? quote.tag.toUpperCase() : 'INSPIRATION';
  }
}

function initQuoteSplash() {
  const overlay = $('#quote-splash-overlay');
  if (!overlay) return;

  // Check user settings
  const isEnabled = (localStorage.getItem('linus_welcome_quote') !== 'false') && (userTheme.welcomeQuote !== false);
  if (!isEnabled) {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
    return;
  }

  const frequency = localStorage.getItem('linus_welcome_quote_freq') || userTheme.welcomeQuoteFrequency || 'always';
  const todayStr = new Date().toISOString().slice(0, 10);
  const lastShownDate = localStorage.getItem('linus_last_quote_date');

  if (frequency === 'daily' && lastShownDate === todayStr) {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
    return;
  }

  // 1. Instant 0ms render from offline bundle
  const initialQuote = getRandomLocalQuote();
  renderSplashQuote(initialQuote, false);

  // 2. Fetch fresh quote from backend in parallel if online
  fetch('/api/quote/random')
    .then(r => r.ok ? r.json() : null)
    .then(q => {
      if (q && q.text && !quoteSplashIsDismissed) {
        renderSplashQuote(q, false);
      }
    })
    .catch(() => {}); // Gracefully fallback to bundled quote

  // 3. Dismiss on screen touch or click anywhere
  const handleDismissInteraction = (e) => {
    // If user tapped/clicked shuffle button or its children, don't dismiss!
    if (e.target.closest('#quote-splash-shuffle-btn')) return;
    dismissQuoteSplash();
  };

  overlay.addEventListener('click', handleDismissInteraction);
  overlay.addEventListener('pointerup', (e) => {
    if (e.target.closest('#quote-splash-shuffle-btn')) return;
    dismissQuoteSplash();
  });

  $('#quote-splash-enter-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissQuoteSplash();
  });

  $('#quote-splash-corner-skip')?.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissQuoteSplash();
  });

  // 4. Shuffle button interaction
  $('#quote-splash-shuffle-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const res = await fetch('/api/quote/random');
      if (res.ok) {
        const q = await res.json();
        renderSplashQuote(q, true);
      } else {
        renderSplashQuote(getRandomLocalQuote(), true);
      }
    } catch {
      renderSplashQuote(getRandomLocalQuote(), true);
    }
  });

  // 5. Global Keyboard Shortcuts for instant entry (Space, Enter, Escape)
  const onQuoteKeydown = (e) => {
    if (quoteSplashIsDismissed) {
      window.removeEventListener('keydown', onQuoteKeydown);
      return;
    }
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      dismissQuoteSplash();
      window.removeEventListener('keydown', onQuoteKeydown);
    }
  };
  window.addEventListener('keydown', onQuoteKeydown);
}

function initExploreQuoteCard() {
  const quoteText = $('#explore-quote-text');
  const quoteAuthor = $('#explore-quote-author');
  const refreshBtn = $('#explore-quote-refresh-btn');
  if (!quoteText || !quoteAuthor) return;

  const updateCard = (quote, animate = true) => {
    if (animate) {
      quoteText.style.opacity = '0';
      quoteAuthor.style.opacity = '0';
      setTimeout(() => {
        quoteText.textContent = `“${quote.text.replace(/^[“"]|[”"]$/g, '')}”`;
        quoteAuthor.textContent = `— ${quote.author || 'Anonymous'}`;
        quoteText.style.opacity = '1';
        quoteAuthor.style.opacity = '1';
      }, 200);
    } else {
      quoteText.textContent = `“${quote.text.replace(/^[“"]|[”"]$/g, '')}”`;
      quoteAuthor.textContent = `— ${quote.author || 'Anonymous'}`;
    }
  };

  // Initial load: try daily quote
  fetch('/api/quote/daily')
    .then(r => r.ok ? r.json() : null)
    .then(q => {
      if (q && q.text) updateCard(q, false);
      else updateCard(getRandomLocalQuote(), false);
    })
    .catch(() => {
      updateCard(getRandomLocalQuote(), false);
    });

  // Refresh button
  refreshBtn?.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/quote/random');
      if (r.ok) {
        const q = await r.json();
        updateCard(q, true);
      } else {
        updateCard(getRandomLocalQuote(), true);
      }
    } catch {
      updateCard(getRandomLocalQuote(), true);
    }
  });
}

// Launch Welcome Quote Splash & Explore Quote card
initQuoteSplash();
initExploreQuoteCard();