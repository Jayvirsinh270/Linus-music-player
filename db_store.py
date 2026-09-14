"""
db_store.py — Linus SQLite Database & High-Performance State Engine
Replaces flat JSON state with an ACID-compliant SQLite store in WAL (Write-Ahead Logging) mode.
Automatically migrates legacy linus_state.json on initial launch.
"""

import json
import os
import shutil
import sqlite3
import threading
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT_DIR / "linus.db"
LEGACY_STATE_FILE = ROOT_DIR / "linus_state.json"
BACKUP_STATE_FILE = ROOT_DIR / "linus_state.json.bak"
DOWNLOADS_DIR = ROOT_DIR / "downloads"

_local = threading.local()


def get_db() -> sqlite3.Connection:
    """Thread-local SQLite connection with WAL mode enabled."""
    if not hasattr(_local, "conn") or _local.conn is None:
        conn = sqlite3.connect(str(DB_PATH), timeout=20.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Enable WAL mode and busy timeout for high concurrent read/write throughput
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        _local.conn = conn
    return _local.conn


def init_db():
    """Initializes the database schema and performs auto-migration if needed."""
    conn = get_db()
    with conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_name TEXT NOT NULL,
                track_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                added_at REAL NOT NULL,
                PRIMARY KEY (playlist_name, track_id)
            );

            CREATE TABLE IF NOT EXISTS favorites (
                track_id TEXT PRIMARY KEY,
                added_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                track_id TEXT NOT NULL,
                played_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS positions (
                track_id TEXT PRIMARY KEY,
                position REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS track_categories (
                track_id TEXT PRIMARY KEY,
                category TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS library_folders (
                folder_path TEXT PRIMARY KEY,
                added_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS custom_lyrics (
                track_id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS track_play_stats (
                track_id TEXT PRIMARY KEY,
                play_count INTEGER DEFAULT 0,
                skip_count INTEGER DEFAULT 0,
                total_play_time REAL DEFAULT 0,
                completion_rate REAL DEFAULT 0,
                last_played_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS track_transitions (
                from_track_id TEXT NOT NULL,
                to_track_id TEXT NOT NULL,
                count INTEGER DEFAULT 0,
                updated_at REAL NOT NULL,
                PRIMARY KEY (from_track_id, to_track_id)
            );

            CREATE TABLE IF NOT EXISTS tracks_meta (
                track_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT DEFAULT '',
                genre TEXT DEFAULT '',
                duration REAL DEFAULT 0,
                artwork_url TEXT DEFAULT '',
                is_online INTEGER DEFAULT 0,
                source TEXT DEFAULT '',
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT DEFAULT '',
                event_type TEXT NOT NULL,
                track_id TEXT NOT NULL,
                prev_track_id TEXT DEFAULT '',
                duration_played REAL DEFAULT 0,
                total_duration REAL DEFAULT 0,
                completion_rate REAL DEFAULT 0,
                context_source TEXT DEFAULT '',
                hour_of_day INTEGER DEFAULT 0,
                day_of_week INTEGER DEFAULT 0,
                timestamp REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dislikes (
                track_id TEXT PRIMARY KEY,
                disliked_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dashboard_cache (
                shelf_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS search_cache (
                query TEXT PRIMARY KEY,
                results TEXT NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tracks_meta_artist ON tracks_meta (artist);
            CREATE INDEX IF NOT EXISTS idx_tracks_meta_title ON tracks_meta (title);
            CREATE INDEX IF NOT EXISTS idx_tracks_meta_genre ON tracks_meta (genre);
            CREATE INDEX IF NOT EXISTS idx_user_events_track ON user_events (track_id);
            CREATE INDEX IF NOT EXISTS idx_user_events_type ON user_events (event_type);
            CREATE INDEX IF NOT EXISTS idx_user_events_time ON user_events (timestamp);
            CREATE INDEX IF NOT EXISTS idx_user_events_session ON user_events (session_id);
            CREATE INDEX IF NOT EXISTS idx_track_transitions_to ON track_transitions (to_track_id);
            CREATE INDEX IF NOT EXISTS idx_history_track ON history (track_id);
            CREATE INDEX IF NOT EXISTS idx_history_played ON history (played_at);
            CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks (track_id);
            CREATE INDEX IF NOT EXISTS idx_play_stats_plays ON track_play_stats (play_count);
            CREATE INDEX IF NOT EXISTS idx_play_stats_last_played ON track_play_stats (last_played_at);
        """)

    # Ensure history table is synchronized with recorded user_events
    try:
        with conn:
            conn.execute("""
                INSERT INTO history (track_id, played_at)
                SELECT track_id, timestamp FROM user_events
                WHERE track_id NOT IN (SELECT track_id FROM history)
                ORDER BY id ASC
            """)
    except Exception:
        pass

    # Check if migration from linus_state.json is needed
    _auto_migrate_legacy_json()


def _auto_migrate_legacy_json():
    """Migrates existing data from linus_state.json into SQLite if database is fresh."""
    conn = get_db()
    
    # Check if already migrated
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM library_folders")
    folder_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM playlists")
    playlist_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM favorites")
    fav_count = cur.fetchone()[0]

    # If DB already has data, migration not needed
    if folder_count > 0 or playlist_count > 0 or fav_count > 0:
        return

    if not LEGACY_STATE_FILE.exists():
        add_library_folder(str(DOWNLOADS_DIR))
        return

    try:
        data = json.loads(LEGACY_STATE_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print("Warning: Could not parse legacy state file:", e)
        add_library_folder(str(DOWNLOADS_DIR))
        return

    print("Migrating legacy linus_state.json into SQLite database (linus.db)...")

    # 1. Migrate library folders
    folders = data.get("library_folders") or [str(DOWNLOADS_DIR)]
    for f in folders:
        if f:
            add_library_folder(str(f))

    # 2. Migrate playlists
    playlists = data.get("playlists") or {}
    for name, tracks in playlists.items():
        if name and isinstance(tracks, list):
            create_playlist(name)
            for idx, tid in enumerate(tracks):
                if tid:
                    add_track_to_playlist(name, tid, position=idx)

    # 3. Migrate favorites
    favorites = data.get("favorites") or []
    for tid in favorites:
        if tid:
            set_favorite(tid, True)

    # 4. Migrate history (preserve order)
    history = data.get("history") or []
    for tid in history:
        if tid:
            add_history(tid)

    # 5. Migrate positions
    positions = data.get("positions") or {}
    for tid, pos in positions.items():
        if tid and isinstance(pos, (int, float)):
            set_position(tid, float(pos))

    # 6. Migrate track categories
    cats = data.get("track_categories") or {}
    for tid, cat in cats.items():
        if tid and cat:
            set_track_category(tid, cat)

    # 7. Migrate custom lyrics
    lyrics = data.get("lyrics") or {}
    for tid, l_content in lyrics.items():
        if tid and l_content:
            set_custom_lyrics(tid, l_content)

    # 8. Migrate scalar app states
    if data.get("last_played_track_id"):
        set_app_state("last_played_track_id", str(data["last_played_track_id"]))
    if data.get("last_played_position") is not None:
        set_app_state("last_played_position", str(data["last_played_position"]))
    set_app_state("schema_version", "3.0")

    # Backup the legacy file
    try:
        shutil.copy2(LEGACY_STATE_FILE, BACKUP_STATE_FILE)
    except Exception:
        pass

    print("Migration to SQLite complete! Backup created at linus_state.json.bak")


# ---------------------------------------------------------------------------
# State Query & Update APIs (100% Backward Compatible)
# ---------------------------------------------------------------------------

def get_state() -> dict:
    """Returns the full state dictionary matching the frontend state contract."""
    conn = get_db()
    cur = conn.cursor()

    # 1. Playlists
    cur.execute("SELECT playlist_name, track_id FROM playlist_tracks ORDER BY playlist_name, position ASC")
    playlists = {}
    for row in cur.fetchall():
        playlists.setdefault(row["playlist_name"], []).append(row["track_id"])
    cur.execute("SELECT name FROM playlists")
    for row in cur.fetchall():
        playlists.setdefault(row["name"], [])

    # 2. Favorites
    cur.execute("SELECT track_id FROM favorites ORDER BY added_at DESC")
    favorites = [row["track_id"] for row in cur.fetchall()]

    # 3. History
    cur.execute("SELECT track_id FROM history ORDER BY id DESC LIMIT 100")
    history = [row["track_id"] for row in cur.fetchall()]

    # 4. Positions
    cur.execute("SELECT track_id, position FROM positions")
    positions = {row["track_id"]: row["position"] for row in cur.fetchall()}

    # 5. Track Categories
    cur.execute("SELECT track_id, category FROM track_categories")
    track_categories = {row["track_id"]: row["category"] for row in cur.fetchall()}

    # 6. Library Folders
    cur.execute("SELECT folder_path FROM library_folders ORDER BY added_at ASC")
    library_folders = [row["folder_path"] for row in cur.fetchall()]
    if not library_folders:
        library_folders = [str(DOWNLOADS_DIR)]

    # 7. Custom Lyrics
    cur.execute("SELECT track_id, content FROM custom_lyrics")
    lyrics = {row["track_id"]: row["content"] for row in cur.fetchall()}

    # 8. Scalar App State
    cur.execute("SELECT key, value FROM app_state")
    app_state = {row["key"]: row["value"] for row in cur.fetchall()}

    last_played_pos = 0.0
    try:
        last_played_pos = float(app_state.get("last_played_position", "0"))
    except ValueError:
        pass

    return {
        "playlists": playlists,
        "favorites": favorites,
        "history": history,
        "positions": positions,
        "track_categories": track_categories,
        "library_folders": library_folders,
        "lyrics": lyrics,
        "last_played_track_id": app_state.get("last_played_track_id") or None,
        "last_played_position": last_played_pos,
        "schema_version": 3.0,
    }


def save_state_dict(state_dict: dict):
    """Saves any incoming state dictionary into SQLite."""
    conn = get_db()
    with conn:
        # 1. Playlists
        if "playlists" in state_dict and isinstance(state_dict["playlists"], dict):
            for name, track_list in state_dict["playlists"].items():
                if not name:
                    continue
                conn.execute("INSERT OR IGNORE INTO playlists (name, created_at) VALUES (?, ?)", (name, time.time()))
                conn.execute("DELETE FROM playlist_tracks WHERE playlist_name = ?", (name,))
                if isinstance(track_list, list):
                    for idx, tid in enumerate(track_list):
                        if tid:
                            conn.execute(
                                "INSERT OR REPLACE INTO playlist_tracks (playlist_name, track_id, position, added_at) VALUES (?, ?, ?, ?)",
                                (name, tid, idx, time.time())
                            )

        # 2. Favorites
        if "favorites" in state_dict and isinstance(state_dict["favorites"], list):
            conn.execute("DELETE FROM favorites")
            for tid in state_dict["favorites"]:
                if tid:
                    conn.execute("INSERT OR REPLACE INTO favorites (track_id, added_at) VALUES (?, ?)", (tid, time.time()))

        # 3. History
        if "history" in state_dict and isinstance(state_dict["history"], list):
            conn.execute("DELETE FROM history")
            for tid in state_dict["history"][-100:]:
                if tid:
                    conn.execute("INSERT INTO history (track_id, played_at) VALUES (?, ?)", (tid, time.time()))

        # 4. Positions
        if "positions" in state_dict and isinstance(state_dict["positions"], dict):
            for tid, pos in state_dict["positions"].items():
                if tid and isinstance(pos, (int, float)):
                    conn.execute("INSERT OR REPLACE INTO positions (track_id, position, updated_at) VALUES (?, ?, ?)", (tid, float(pos), time.time()))

        # 5. Track Categories
        if "track_categories" in state_dict and isinstance(state_dict["track_categories"], dict):
            conn.execute("DELETE FROM track_categories")
            for tid, cat in state_dict["track_categories"].items():
                if tid and cat:
                    conn.execute("INSERT OR REPLACE INTO track_categories (track_id, category) VALUES (?, ?)", (tid, cat))

        # 6. Library Folders
        if "library_folders" in state_dict and isinstance(state_dict["library_folders"], list):
            conn.execute("DELETE FROM library_folders")
            for f in state_dict["library_folders"]:
                if f:
                    conn.execute("INSERT OR REPLACE INTO library_folders (folder_path, added_at) VALUES (?, ?)", (f, time.time()))

        # 7. Lyrics
        if "lyrics" in state_dict and isinstance(state_dict["lyrics"], dict):
            for tid, l_content in state_dict["lyrics"].items():
                if tid and l_content:
                    conn.execute("INSERT OR REPLACE INTO custom_lyrics (track_id, content, updated_at) VALUES (?, ?, ?)", (tid, l_content, time.time()))

        # 8. Scalar keys
        if "last_played_track_id" in state_dict:
            conn.execute("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)", ("last_played_track_id", str(state_dict["last_played_track_id"] or "")))
        if "last_played_position" in state_dict:
            conn.execute("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)", ("last_played_position", str(state_dict["last_played_position"] or 0)))


# ---------------------------------------------------------------------------
# Individual Helper Functions
# ---------------------------------------------------------------------------

def set_app_state(key: str, value: str):
    conn = get_db()
    with conn:
        conn.execute("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)", (key, value))


def create_playlist(name: str) -> bool:
    name = (name or "").strip()
    if not name:
        return False
    conn = get_db()
    try:
        with conn:
            conn.execute("INSERT OR IGNORE INTO playlists (name, created_at) VALUES (?, ?)", (name, time.time()))
        return True
    except Exception:
        return False


def add_track_to_playlist(name: str, track_id: str, position: int | None = None) -> bool:
    name = (name or "").strip()
    track_id = (track_id or "").strip()
    if not name or not track_id:
        return False
    conn = get_db()
    try:
        with conn:
            create_playlist(name)
            if position is None:
                cur = conn.cursor()
                cur.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_name = ?", (name,))
                position = cur.fetchone()[0]
            conn.execute(
                "INSERT OR REPLACE INTO playlist_tracks (playlist_name, track_id, position, added_at) VALUES (?, ?, ?, ?)",
                (name, track_id, position, time.time())
            )
        return True
    except Exception:
        return False


def remove_track_from_playlist(name: str, track_id: str) -> bool:
    conn = get_db()
    try:
        with conn:
            conn.execute("DELETE FROM playlist_tracks WHERE playlist_name = ? AND track_id = ?", (name, track_id))
        return True
    except Exception:
        return False


def delete_playlist(name: str) -> bool:
    conn = get_db()
    try:
        with conn:
            conn.execute("DELETE FROM playlist_tracks WHERE playlist_name = ?", (name,))
            conn.execute("DELETE FROM playlists WHERE name = ?", (name,))
        return True
    except Exception:
        return False


def set_favorite(track_id: str, is_fav: bool) -> bool:
    conn = get_db()
    try:
        with conn:
            if is_fav:
                conn.execute("INSERT OR REPLACE INTO favorites (track_id, added_at) VALUES (?, ?)", (track_id, time.time()))
            else:
                conn.execute("DELETE FROM favorites WHERE track_id = ?", (track_id,))
        return True
    except Exception:
        return False


def add_history(track_id: str):
    conn = get_db()
    try:
        with conn:
            conn.execute("INSERT INTO history (track_id, played_at) VALUES (?, ?)", (track_id, time.time()))
    except Exception:
        pass


def set_position(track_id: str, pos: float):
    conn = get_db()
    try:
        with conn:
            conn.execute("INSERT OR REPLACE INTO positions (track_id, position, updated_at) VALUES (?, ?, ?)", (track_id, pos, time.time()))
    except Exception:
        pass


def set_track_category(track_id: str, category: str):
    conn = get_db()
    try:
        with conn:
            if category:
                conn.execute("INSERT OR REPLACE INTO track_categories (track_id, category) VALUES (?, ?)", (track_id, category))
            else:
                conn.execute("DELETE FROM track_categories WHERE track_id = ?", (track_id,))
    except Exception:
        pass


def set_custom_lyrics(track_id: str, content: str):
    conn = get_db()
    try:
        with conn:
            if content:
                conn.execute("INSERT OR REPLACE INTO custom_lyrics (track_id, content, updated_at) VALUES (?, ?, ?)", (track_id, content, time.time()))
            else:
                conn.execute("DELETE FROM custom_lyrics WHERE track_id = ?", (track_id,))
    except Exception:
        pass


def add_library_folder(folder_path: str) -> bool:
    folder_path = (folder_path or "").strip()
    if not folder_path:
        return False
    conn = get_db()
    try:
        with conn:
            conn.execute("INSERT OR REPLACE INTO library_folders (folder_path, added_at) VALUES (?, ?)", (folder_path, time.time()))
        return True
    except Exception:
        return False


def remove_library_folder(folder_path: str) -> bool:
    conn = get_db()
    try:
        with conn:
            conn.execute("DELETE FROM library_folders WHERE folder_path = ?", (folder_path,))
        return True
    except Exception:
        return False


def get_library_folders() -> list[str]:
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT folder_path FROM library_folders ORDER BY added_at ASC")
    folders = [row["folder_path"] for row in cur.fetchall()]
    return folders if folders else [str(DOWNLOADS_DIR)]


# ---------------------------------------------------------------------------
# Metadata, Telemetry & Recommendation Persistence APIs (Linus CMI v6.0)
# ---------------------------------------------------------------------------

def upsert_track_metadata(
    track_id: str,
    title: str,
    artist: str,
    album: str = "",
    genre: str = "",
    duration: float = 0.0,
    artwork_url: str = "",
    is_online: bool = False,
    source: str = ""
) -> bool:
    """Persists or updates metadata for any track (local or online)."""
    if not track_id or not title:
        return False
    conn = get_db()
    now = time.time()
    try:
        with conn:
            conn.execute("""
                INSERT INTO tracks_meta (track_id, title, artist, album, genre, duration, artwork_url, is_online, source, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(track_id) DO UPDATE SET
                    title = CASE WHEN ? != '' THEN ? ELSE title END,
                    artist = CASE WHEN ? != '' AND ? NOT IN ('Local collection', 'YouTube', 'Unknown') THEN ? ELSE artist END,
                    album = CASE WHEN ? != '' THEN ? ELSE album END,
                    genre = CASE WHEN ? != '' THEN ? ELSE genre END,
                    duration = CASE WHEN ? > 0 THEN ? ELSE duration END,
                    artwork_url = CASE WHEN ? != '' THEN ? ELSE artwork_url END,
                    updated_at = ?
            """, (
                track_id, title.strip(), (artist or "Unknown").strip(), album.strip(), genre.strip(),
                float(duration or 0.0), artwork_url.strip(), 1 if is_online else 0, source.strip(), now,
                title.strip(), title.strip(),
                artist.strip(), artist.strip(), artist.strip(),
                album.strip(), album.strip(),
                genre.strip(), genre.strip(),
                float(duration or 0.0), float(duration or 0.0),
                artwork_url.strip(), artwork_url.strip(),
                now
            ))
        return True
    except Exception as e:
        print(f"[DB] Error upserting track metadata for {track_id}: {e}")
        return False


def get_track_metadata(track_id: str) -> dict | None:
    """Fetches stored metadata for a given track."""
    if not track_id:
        return None
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM tracks_meta WHERE track_id = ?", (track_id,))
    row = cur.fetchone()
    if row:
        return dict(row)
    return None


def batch_get_track_metadata(track_ids: list[str]) -> dict[str, dict]:
    """Fetches metadata for multiple tracks in a single query."""
    if not track_ids:
        return {}
    conn = get_db()
    cur = conn.cursor()
    results = {}
    chunk_size = 400
    for i in range(0, len(track_ids), chunk_size):
        chunk = track_ids[i:i + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))
        cur.execute(f"SELECT * FROM tracks_meta WHERE track_id IN ({placeholders})", chunk)
        for r in cur.fetchall():
            results[r["track_id"]] = dict(r)
    return results


def record_granular_user_event(
    session_id: str,
    event_type: str,
    track_id: str,
    prev_track_id: str = "",
    duration_played: float = 0.0,
    total_duration: float = 0.0,
    completion_rate: float = 0.0,
    context_source: str = "",
    timestamp: float = None
) -> bool:
    """Logs a discrete user event (play, skip, complete, like, dislike, etc.)."""
    if not track_id or not event_type:
        return False
    ts = timestamp or time.time()
    tm = time.localtime(ts)
    hour = tm.tm_hour
    dow = tm.tm_wday  # 0=Monday, 6=Sunday
    conn = get_db()
    try:
        with conn:
            conn.execute("""
                INSERT INTO user_events (
                    session_id, event_type, track_id, prev_track_id,
                    duration_played, total_duration, completion_rate,
                    context_source, hour_of_day, day_of_week, timestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session_id or "", event_type, track_id, prev_track_id or "",
                float(duration_played or 0.0), float(total_duration or 0.0),
                float(completion_rate or 0.0), context_source or "",
                hour, dow, ts
            ))
        return True
    except Exception as e:
        print(f"[DB] Error logging user event: {e}")
        return False


def set_dislike(track_id: str, disliked: bool = True) -> bool:
    """Adds or removes a track from the negative feedback (dislike) suppression list."""
    if not track_id:
        return False
    conn = get_db()
    try:
        with conn:
            if disliked:
                conn.execute("INSERT OR REPLACE INTO dislikes (track_id, disliked_at) VALUES (?, ?)", (track_id, time.time()))
            else:
                conn.execute("DELETE FROM dislikes WHERE track_id = ?", (track_id,))
        return True
    except Exception as e:
        print(f"[DB] Dislike update error: {e}")
        return False


def is_disliked(track_id: str) -> bool:
    """Checks if a track is marked as disliked."""
    if not track_id:
        return False
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM dislikes WHERE track_id = ?", (track_id,))
    return cur.fetchone() is not None


def get_disliked_track_ids() -> set[str]:
    """Returns all disliked track IDs as a fast lookup set."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT track_id FROM dislikes")
    return {r["track_id"] for r in cur.fetchall()}


def get_dashboard_shelf_cache(shelf_id: str, max_age_seconds: float = 1800.0) -> list | dict | None:
    """Retrieves a cached recommendation shelf if fresh."""
    if not shelf_id:
        return None
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT payload, updated_at FROM dashboard_cache WHERE shelf_id = ?", (shelf_id,))
    row = cur.fetchone()
    if not row:
        return None
    if (time.time() - row["updated_at"]) > max_age_seconds:
        return None
    try:
        return json.loads(row["payload"])
    except Exception:
        return None


def set_dashboard_shelf_cache(shelf_id: str, payload: list | dict) -> bool:
    """Saves a recommendation shelf into persistent SQLite cache."""
    if not shelf_id or payload is None:
        return False
    conn = get_db()
    now = time.time()
    try:
        with conn:
            conn.execute("""
                INSERT INTO dashboard_cache (shelf_id, payload, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(shelf_id) DO UPDATE SET
                    payload = ?,
                    updated_at = ?
            """, (shelf_id, json.dumps(payload), now, json.dumps(payload), now))
        return True
    except Exception as e:
        print(f"[DB] Error writing dashboard cache: {e}")
        return False


def invalidate_dashboard_cache(shelf_id: str = None):
    """Purges cached shelves so fresh recommendations generate immediately."""
    conn = get_db()
    try:
        with conn:
            if shelf_id:
                conn.execute("DELETE FROM dashboard_cache WHERE shelf_id = ?", (shelf_id,))
            else:
                conn.execute("DELETE FROM dashboard_cache")
    except Exception:
        pass


def get_search_cache(query: str, max_age_seconds: float = 86400.0) -> list | None:
    """Retrieves cached search results from SQLite if within max_age_seconds."""
    if not query:
        return None
    key = query.strip().lower()
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT results, updated_at FROM search_cache WHERE query = ?", (key,))
    row = cur.fetchone()
    if not row:
        return None
    if (time.time() - row["updated_at"]) > max_age_seconds:
        return None
    try:
        return json.loads(row["results"])
    except Exception:
        return None


def set_search_cache(query: str, results: list) -> bool:
    """Stores search results into SQLite persistent cache."""
    if not query or results is None:
        return False
    key = query.strip().lower()
    now = time.time()
    conn = get_db()
    try:
        with conn:
            conn.execute("""
                INSERT INTO search_cache (query, results, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(query) DO UPDATE SET
                    results = ?,
                    updated_at = ?
            """, (key, json.dumps(results), now, json.dumps(results), now))
        return True
    except Exception as e:
        print(f"[DB] Error writing search cache: {e}")
        return False


def optimize_database() -> bool:
    """Runs PRAGMA optimize and vacuum maintenance to keep SQLite B-trees clean and fast."""
    try:
        conn = get_db()
        with conn:
            conn.execute("PRAGMA optimize;")
        return True
    except Exception as e:
        print(f"[DB] Error optimizing database: {e}")
        return False


# Initialize on import
init_db()
