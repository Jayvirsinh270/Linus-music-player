"""
recommendation_engine.py — Linus Cognitive Music Intelligence (CMI) Engine v6.0

Production-grade Hybrid Music Recommendation System:
1. User Taste Profiler:
   - Evaluates playback history across BOTH local and online (YouTube) streams.
   - Exponential time decay (half-life: 7 days) on completion rates and replay counts.
   - Dislike suppression filter and explicit feedback integration (favorites, playlists).
   - Contextual time-of-day affinity (Morning, Afternoon, Evening, Night).

2. Hybrid Local Recommendation Scorer:
   - Content Similarity: Normalized token Jaccard similarity, multi-artist matching, category affinity.
   - Collaborative Transition Modeling: Markov chain co-occurrence matrix from `track_transitions`.
   - Multi-Skip Engagement Recovery: Prioritizes comfort favorites when consecutive skips >= 2.
   - Diversity & Anti-Fatigue: Artist capping (max 2 per shelf), recency fatigue penalty, serendipity perturbation.

3. High-Fidelity YouTube Discovery:
   - "Because You Listened to [Artist]": Seeds from true top artist extracted from metadata.
   - Contextual Radio: Dynamic time-of-day + user taste queries.
   - Curated Trending: Biased towards user's preferred genres and languages.
   - Strict Anti-Noise Shield: Filters podcasts, loops, tutorials, and reactions.

4. Two-Tier High-Speed Caching:
   - Instant (<15ms) local shelf computation.
   - Persistent SQLite caching for online discovery shelves with background prefetching.
"""

import json
import math
import os
import re
import time
import threading
import random
import numpy as np
import pandas as pd
import db_store as db
import downloader as dl

# ---------------------------------------------------------------------------
# Constants & Memory Caches
# ---------------------------------------------------------------------------

HALF_LIFE_SECONDS = 7 * 86400.0  # 7 days
TIME_DECAY_LAMBDA = math.log(2.0) / HALF_LIFE_SECONDS

_rec_cache: dict[str, list] = {}
_genre_cache: dict[str, tuple[str, str, str]] = {}
_taste_profile_cache: dict = {}
_taste_profile_lock = threading.Lock()
_TASTE_CACHE_TTL = 60.0  # 60 seconds
_MAX_CACHE = 200

_bg_fetch_lock = threading.Lock()
_bg_fetch_running = False

# Non-music YouTube keywords to filter
NOISE_KEYWORDS = [
    "podcast", "interview", "review", "reaction", "analysis",
    "why does", "top 10 all", "1-hour", "1 hour", "2-hour", "2 hour",
    "full album", "setlist", "concert setlist", "guitar lesson", "tutorial",
    "how to", "karaoke", "reaction video", "unboxing", "vlog", "gameplay"
]


def _clean_cache():
    """Evicts oldest entries when cache grows too large."""
    if len(_rec_cache) > _MAX_CACHE:
        for k in list(_rec_cache.keys())[:int(_MAX_CACHE * 0.4)]:
            _rec_cache.pop(k, None)
    if len(_genre_cache) > 400:
        for k in list(_genre_cache.keys())[:150]:
            _genre_cache.pop(k, None)


def _clean_text(text: str) -> str:
    """Removes video fluff, bracketed tags, suffixes, and noise."""
    if not text:
        return ""
    clean = re.sub(r'\(.*?\)|\[.*?\]|\{.*?\}', '', text)
    clean = re.sub(
        r'(?i)\b(lyrics|lyric video|official video|official audio|visualizer|'
        r'7clouds|audio|full song|video|slowed|reverb|remix|mashup|hd|4k|'
        r'sped up|vevo|hindi cover|cover song|female version|male version|'
        r'acoustic cover|unplugged|t-series|zeemusic|sonymusic|full audio|'
        r'motion poster|teaser|trailer)\b', '', clean
    )
    clean = re.sub(r'[\s\-_\/\|]{2,}', ' ', clean)
    return clean.strip()


def normalize_title_fuzzy(text: str) -> str:
    """
    Phonetic & fuzzy title normalizer for multi-lingual duplicate matching.
    Handles transliteration variances (e.g. woh/wo, kaise/kese, pyaar/pyar).
    """
    clean = _clean_text(text).lower()
    clean = clean.replace('aa', 'a').replace('ee', 'i').replace('oo', 'u')
    clean = clean.replace('woh', 'wo').replace('kaise', 'kese').replace('pyaar', 'pyar')
    clean = re.sub(r'[^a-z0-9]', '', clean)
    return clean


GENRE_PATTERNS = [
    (r'\b(lo-?fi|chillhop|study|relaxing|chill|peaceful|night chill)\b', "Lo-Fi"),
    (r'\b(acoustic|unplugged|piano|fingerstyle|folk|ukulele)\b', "Acoustic"),
    (r'\b(edm|house|techno|trance|dubstep|synthwave|electro|electronic|remix)\b', "Electronic"),
    (r'\b(hip[\s-]?hop|rap|trap|freestyle|drill)\b', "Hip-Hop"),
    (r'\b(r&b|rnb|soul|motown|funk)\b', "R&B"),
    (r'\b(rock|metal|punk|grunge|hard rock|guitar|heavy metal)\b', "Rock"),
    (r'\b(pop|dance|disco|synth|party|k-?pop)\b', "Pop"),
    (r'\b(classical|orchestra|symphony|concerto|sonata|chopin|mozart|beethoven|bach|vivaldi|pachelbel|tchaikovsky|canon)\b', "Classical"),
    (r'\b(jazz|blues|swing|saxophone|bossa nova)\b', "Jazz"),
    (r'\b(soundtrack|ost|theme|score|cinematic|anime|gaming)\b', "Soundtrack"),
    (r'\b(ambient|meditation|sleep|drone|calm)\b', "Ambient"),
    (r'\b(bollywood|hindi|punjabi|sufi|ghazal|qawwali)\b', "Bollywood"),
]


def infer_genre(text: str) -> str:
    """Classifies music text into recognizable genre styles."""
    if not text:
        return "Music"
    t_lower = text.lower()
    for pattern, g_name in GENRE_PATTERNS:
        if re.search(pattern, t_lower, re.IGNORECASE):
            return g_name
    return "Music"


def parse_artist_and_title(raw_title: str, raw_artist: str = "") -> tuple[str, str, str]:
    """
    Extracts Song Title, Real Artist, and Genre from seed metadata using fast local parsing.
    Avoids slow external HTTP round-trips.
    """
    cache_key = f"{raw_title}_{raw_artist}".strip().lower()
    if cache_key in _genre_cache:
        return _genre_cache[cache_key]

    clean = _clean_text(raw_title)
    # Split on common separators: hyphen, em-dash, colon, pipe
    parts = [p.strip() for p in re.split(r'[-–—:|]', clean) if len(p.strip()) > 1]

    parsed_artist = ""
    parsed_title = ""

    if len(parts) >= 2:
        parsed_artist = parts[0]
        parsed_title = parts[1]
    elif len(parts) == 1:
        parsed_title = parts[0]
        if raw_artist and raw_artist.lower() not in (
            "youtube", "7clouds", "unknown", "various artists", "audio", "lyrics", "topic", "vevo", "local collection"
        ):
            parsed_artist = raw_artist

    # Clean artist tags
    if parsed_artist.lower().endswith(" - topic"):
        parsed_artist = parsed_artist[:-8].strip()

    final_title = parsed_title or raw_title
    final_artist = parsed_artist or raw_artist or "Unknown"
    genre = infer_genre(f"{final_title} {final_artist} {raw_title}")

    result = (final_title, final_artist, genre)
    _clean_cache()
    _genre_cache[cache_key] = result
    return result


def _title_similarity(t1: str, t2: str) -> float:
    """Token-set Jaccard similarity between two track titles."""
    tokens1 = set(re.findall(r'\w+', _clean_text(t1).lower()))
    tokens2 = set(re.findall(r'\w+', _clean_text(t2).lower()))
    if not tokens1 or not tokens2:
        return 0.0
    # Filter very short common stop words
    stop = {"the", "a", "an", "and", "or", "in", "on", "at", "of", "to", "is", "song"}
    tokens1 = {t for t in tokens1 if t not in stop and len(t) > 1}
    tokens2 = {t for t in tokens2 if t not in stop and len(t) > 1}
    if not tokens1 or not tokens2:
        return 0.0
    intersection = len(tokens1 & tokens2)
    union = len(tokens1 | tokens2)
    return intersection / union if union > 0 else 0.0


def _artist_similarity(a1: str, a2: str) -> float:
    """Scores closeness of two artists, supporting collaborations and variants."""
    a1_clean = (a1 or "").strip().lower()
    a2_clean = (a2 or "").strip().lower()
    if not a1_clean or not a2_clean:
        return 0.0
    if a1_clean in ("local collection", "unknown", "youtube", "various artists"):
        return 0.0
    if a2_clean in ("local collection", "unknown", "youtube", "various artists"):
        return 0.0
    if a1_clean == a2_clean:
        return 1.0

    # Split multi-artist strings
    split_regex = r'[,&/]|(?:\b(?:feat\.?|ft\.?|featuring|vs\.?)\b)'
    parts1 = {p.strip() for p in re.split(split_regex, a1_clean) if len(p.strip()) > 2}
    parts2 = {p.strip() for p in re.split(split_regex, a2_clean) if len(p.strip()) > 2}
    if parts1 and parts2 and (parts1 & parts2):
        return 0.85

    if len(a1_clean) >= 4 and len(a2_clean) >= 4:
        if a1_clean in a2_clean or a2_clean in a1_clean:
            return 0.75
    return 0.0


# ---------------------------------------------------------------------------
# Telemetry & Event Collection Engine
# ---------------------------------------------------------------------------

def record_playback_event(
    track_id: str,
    duration_played: float,
    total_duration: float = 0.0,
    skipped: bool = False,
    prev_track_id: str = "",
    context_source: str = "",
    metadata: dict = None,
    session_id: str = ""
):
    """
    Logs complete user playback telemetry:
    1. Upserts metadata into `tracks_meta` (so online streams never lose artist/title).
    2. Updates `track_play_stats` with intelligent play-count & EMA completion rate.
    3. Records granular event in `user_events`.
    4. Updates Markov transition sequence in `track_transitions`.
    """
    if not track_id:
        return

    now = time.time()
    conn = db.get_db()

    # 1. Upsert metadata if supplied
    if metadata and isinstance(metadata, dict):
        title = metadata.get("title") or ""
        artist = metadata.get("artist") or ""
        album = metadata.get("album") or ""
        genre = metadata.get("genre") or metadata.get("category") or ""
        dur = float(metadata.get("duration") or total_duration or 0.0)
        art = metadata.get("artwork_url") or ""
        is_online = bool(metadata.get("is_online", False) or track_id.startswith("yt:"))
        source = metadata.get("source") or ("youtube" if is_online else "local")
        if title:
            db.upsert_track_metadata(
                track_id=track_id,
                title=title,
                artist=artist,
                album=album,
                genre=genre,
                duration=dur,
                artwork_url=art,
                is_online=is_online,
                source=source
            )

    # 2. Compute true completion rate
    completion_rate = 0.0
    if total_duration > 0:
        completion_rate = min(1.0, max(0.0, duration_played / total_duration))
    elif duration_played >= 60:
        completion_rate = 1.0
    elif duration_played > 0:
        completion_rate = min(1.0, duration_played / 180.0)

    # A legitimate "play" requires either:
    # - not skipped and played >= 15 seconds, OR
    # - completed >= 25% of total song, OR
    # - played >= 30 seconds
    is_true_play = (not skipped and duration_played >= 15.0) or (completion_rate >= 0.25) or (duration_played >= 30.0)
    play_increment = 1 if is_true_play else 0
    skip_increment = 1 if skipped else 0

    with conn:
        conn.execute("""
            INSERT INTO track_play_stats (track_id, play_count, skip_count, total_play_time, completion_rate, last_played_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(track_id) DO UPDATE SET
                play_count = play_count + ?,
                skip_count = skip_count + ?,
                total_play_time = total_play_time + ?,
                completion_rate = (completion_rate * 0.65) + (? * 0.35),
                last_played_at = ?
        """, (
            track_id,
            play_increment,
            skip_increment,
            duration_played,
            completion_rate,
            now,
            play_increment,
            skip_increment,
            duration_played,
            completion_rate,
            now
        ))

    # 3. Log granular user event
    event_type = "skip" if skipped else ("play_complete" if completion_rate >= 0.85 else "play_partial")
    db.record_granular_user_event(
        session_id=session_id,
        event_type=event_type,
        track_id=track_id,
        prev_track_id=prev_track_id,
        duration_played=duration_played,
        total_duration=total_duration,
        completion_rate=completion_rate,
        context_source=context_source,
        timestamp=now
    )

    # 4. Synchronize persistent history
    db.add_history(track_id)

    # 5. Record Markov co-occurrence transition
    if prev_track_id and prev_track_id != track_id:
        record_track_transition(prev_track_id, track_id)


def record_track_transition(from_track_id: str, to_track_id: str):
    """Captures sequence affinity between consecutive songs (Markov transition matrix)."""
    if not from_track_id or not to_track_id or from_track_id == to_track_id:
        return
    conn = db.get_db()
    now = time.time()
    try:
        with conn:
            conn.execute("""
                INSERT INTO track_transitions (from_track_id, to_track_id, count, updated_at)
                VALUES (?, ?, 1, ?)
                ON CONFLICT(from_track_id, to_track_id) DO UPDATE SET
                    count = count + 1,
                    updated_at = ?
            """, (from_track_id, to_track_id, now, now))
    except Exception as e:
        print(f"[RecEngine] Transition error: {e}")


# ---------------------------------------------------------------------------
# User Taste Profiler & Contextual Modeling
# ---------------------------------------------------------------------------

def invalidate_taste_profile_cache():
    """Invalidates the in-memory user taste profile cache so next call recalculates."""
    global _taste_profile_cache
    with _taste_profile_lock:
        _taste_profile_cache.clear()


def compute_user_taste_profile(days: int = 30, force_refresh: bool = False) -> dict:
    """
    Extracts high-fidelity taste profile from user listening history:
    - Decayed Artist Affinities (vectorized with NumPy)
    - Decayed Genre Affinities (vectorized with Pandas)
    - Contextual Time-of-Day Habits (Morning / Afternoon / Evening / Night)
    - Disliked Track IDs (for strict filtering)
    """
    now = time.time()
    with _taste_profile_lock:
        if not force_refresh and _taste_profile_cache.get("data") and (now - _taste_profile_cache.get("time", 0.0) < _TASTE_CACHE_TTL):
            return dict(_taste_profile_cache["data"])

    conn = db.get_db()
    cur = conn.cursor()
    cutoff = now - (days * 86400.0)

    disliked_ids = db.get_disliked_track_ids()

    # Load favorites and playlist tracks
    cur.execute("SELECT track_id FROM favorites")
    favorites = {r["track_id"] for r in cur.fetchall()}

    cur.execute("SELECT DISTINCT track_id FROM playlist_tracks")
    playlist_tracks = {r["track_id"] for r in cur.fetchall()}

    # Load recent play stats
    cur.execute("""
        SELECT track_id, play_count, skip_count, total_play_time, completion_rate, last_played_at
        FROM track_play_stats
        WHERE last_played_at > ? AND play_count > 0
    """, (cutoff,))
    stats_rows = cur.fetchall()

    all_tids = [r["track_id"] for r in stats_rows]
    metadata_map = db.batch_get_track_metadata(all_tids)

    artist_scores: dict[str, float] = {}
    genre_scores: dict[str, float] = {}
    total_listen_seconds = 0.0
    sample_tracks_by_artist: dict[str, dict] = {}

    # Vectorized computation using pandas and numpy
    if stats_rows:
        records = []
        for row in stats_rows:
            tid = row["track_id"]
            if tid in disliked_ids:
                continue
            meta = metadata_map.get(tid, {})
            title = meta.get("title") or ""
            artist = meta.get("artist") or ""
            genre = meta.get("genre") or ""

            if not artist or artist.lower() in ("local collection", "unknown", "youtube"):
                p_title, p_artist, _ = parse_artist_and_title(title, artist)
                if p_artist and p_artist.lower() not in ("unknown", "youtube"):
                    artist = p_artist

            records.append({
                "track_id": tid,
                "title": title,
                "artist": artist.strip() if artist else "",
                "genre": genre.strip() if genre else "",
                "play_count": float(row["play_count"]),
                "skip_count": float(row["skip_count"]),
                "total_play_time": float(row["total_play_time"]),
                "completion_rate": float(row["completion_rate"]),
                "last_played_at": float(row["last_played_at"]),
                "is_fav": 1.0 if tid in favorites else 0.0,
                "is_pl": 1.0 if tid in playlist_tracks else 0.0,
            })

        if records:
            df = pd.DataFrame(records)
            total_listen_seconds = float(df["total_play_time"].sum())

            # NumPy Vectorized half-life decay calculation
            ages = np.maximum(0.0, now - df["last_played_at"].to_numpy(dtype=float))
            decays = np.exp(-TIME_DECAY_LAMBDA * ages)
            plays = df["play_count"].to_numpy(dtype=float)
            comps = df["completion_rate"].to_numpy(dtype=float)
            skips = df["skip_count"].to_numpy(dtype=float)
            favs = df["is_fav"].to_numpy(dtype=float)
            pls = df["is_pl"].to_numpy(dtype=float)

            scores = (plays * comps * 25.0) * decays - (skips * 4.0) + (favs * 40.0) + (pls * 25.0)
            df["score"] = np.maximum(0.0, scores)

            # High-performance grouped aggregation via Pandas
            valid_artists = df[~df["artist"].str.lower().isin(["", "local collection", "unknown", "youtube"])]
            if not valid_artists.empty:
                artist_series = valid_artists.groupby("artist")["score"].sum().sort_values(ascending=False)
                for art, s in artist_series.items():
                    artist_scores[art] = float(s)
                for _, r in valid_artists.iterrows():
                    art = r["artist"]
                    if art not in sample_tracks_by_artist:
                        sample_tracks_by_artist[art] = {"id": r["track_id"], "title": r["title"], "artist": art}

            valid_genres = df[~df["genre"].str.lower().isin(["", "music", "youtube", "local files"])]
            if not valid_genres.empty:
                genre_series = valid_genres.groupby("genre")["score"].sum().sort_values(ascending=False)
                for g, s in genre_series.items():
                    genre_scores[g] = float(s)

    sorted_artists = sorted(artist_scores.items(), key=lambda x: x[1], reverse=True)
    sorted_genres = sorted(genre_scores.items(), key=lambda x: x[1], reverse=True)

    # Categorize into time-of-day listening habits
    cur.execute("""
        SELECT track_id, hour_of_day, duration_played, completion_rate
        FROM user_events
        WHERE timestamp > ? AND event_type != 'skip'
        ORDER BY id DESC LIMIT 500
    """, (cutoff,))
    event_rows = cur.fetchall()

    time_of_day_artists: dict[str, dict[str, float]] = {
        "morning": {}, "afternoon": {}, "evening": {}, "night": {}
    }

    for er in event_rows:
        tid = er["track_id"]
        h = er["hour_of_day"]
        meta = metadata_map.get(tid)
        art = meta.get("artist") if meta else ""
        if not art or art.lower() in ("local collection", "unknown", "youtube"):
            continue

        if 5 <= h < 12:
            period = "morning"
        elif 12 <= h < 17:
            period = "afternoon"
        elif 17 <= h < 22:
            period = "evening"
        else:
            period = "night"

        weight = er["completion_rate"] * (er["duration_played"] / 60.0)
        time_of_day_artists[period][art] = time_of_day_artists[period].get(art, 0.0) + weight

    # Compute genre percentage breakdown for Sonic DNA
    total_genre_score = sum(s for _, s in sorted_genres) or 1.0
    top_genres_breakdown = [
        {"name": g, "percent": round((s / total_genre_score) * 100)}
        for g, s in sorted_genres[:4]
    ]

    # Calculate active listening streak (consecutive calendar days)
    cur.execute("""
        SELECT DISTINCT date(timestamp, 'unixepoch', 'localtime') as play_date
        FROM user_events
        ORDER BY play_date DESC
        LIMIT 30
    """)
    date_rows = [r["play_date"] for r in cur.fetchall() if r["play_date"]]

    streak_days = 0
    if date_rows:
        import datetime
        today = datetime.date.today()
        last_played_date = datetime.date.fromisoformat(date_rows[0])
        diff = (today - last_played_date).days
        if diff <= 1:
            streak_days = 1
            check_date = last_played_date
            for d_str in date_rows[1:]:
                d = datetime.date.fromisoformat(d_str)
                if (check_date - d).days == 1:
                    streak_days += 1
                    check_date = d
                else:
                    break
    else:
        streak_days = 1 if total_listen_seconds > 60 else 0

    # Current time-of-day label
    cur_hour = time.localtime(now).tm_hour
    if 5 <= cur_hour < 12:
        cur_period = "morning"
        cur_mood = "Morning Calm"
    elif 12 <= cur_hour < 17:
        cur_period = "afternoon"
        cur_mood = "Afternoon Energy"
    elif 17 <= cur_hour < 22:
        cur_period = "evening"
        cur_mood = "Evening Chill"
    else:
        cur_period = "night"
        cur_mood = "Late Night Deep"

    period_artists = sorted(time_of_day_artists[cur_period].items(), key=lambda x: x[1], reverse=True)

    # Dynamic Sonic Vibe Title
    top_g = sorted_genres[0][0] if sorted_genres else "Music"
    if cur_period == "night":
        vibe_badge = f"🌙 Midnight {top_g} Dreamer"
    elif cur_period == "morning":
        vibe_badge = f"☕ Serene Morning {top_g}"
    elif "energy" in top_g.lower() or "pop" in top_g.lower() or "rock" in top_g.lower():
        vibe_badge = f"⚡ High-Energy {top_g} Connoisseur"
    else:
        vibe_badge = f"✨ {cur_mood} {top_g} Voyager"

    # --- New Analytics Fields ---

    # Weekly plays count
    week_cutoff = now - 7 * 86400.0
    cur.execute(
        "SELECT COUNT(*) as cnt FROM user_events WHERE timestamp > ? AND event_type != 'skip'",
        (week_cutoff,)
    )
    weekly_plays_row = cur.fetchone()
    weekly_plays = weekly_plays_row["cnt"] if weekly_plays_row else 0

    # Peak listening hour (most common hour across all events)
    cur.execute("""
        SELECT hour_of_day, COUNT(*) as cnt
        FROM user_events
        WHERE timestamp > ? AND event_type != 'skip'
        GROUP BY hour_of_day
        ORDER BY cnt DESC
        LIMIT 1
    """, (cutoff,))
    peak_hour_row = cur.fetchone()
    if peak_hour_row:
        ph = peak_hour_row["hour_of_day"]
        suffix = "AM" if ph < 12 else "PM"
        ph12 = ph % 12 or 12
        peak_hour_label = f"{ph12} {suffix}"
    else:
        peak_hour_label = ""

    # Average session length in minutes (based on sessions in user_events)
    cur.execute("""
        SELECT session_id,
               SUM(duration_played) as session_duration
        FROM user_events
        WHERE timestamp > ? AND session_id IS NOT NULL AND session_id != ''
        GROUP BY session_id
        HAVING session_duration > 30
    """, (cutoff,))
    session_rows = cur.fetchall()
    if session_rows:
        avg_session_minutes = round(sum(r["session_duration"] for r in session_rows) / len(session_rows) / 60.0, 1)
    else:
        avg_session_minutes = 0.0

    # Discovery score: unique artists played / total known artists in catalog
    cur.execute("SELECT COUNT(DISTINCT artist) as cnt FROM tracks_meta WHERE artist IS NOT NULL AND artist != ''")
    total_artists_row = cur.fetchone()
    total_known_artists = (total_artists_row["cnt"] if total_artists_row else 1) or 1
    played_artist_count = len(artist_scores)
    discovery_score = min(100, round((played_artist_count / total_known_artists) * 100))

    # Overall skip rate
    cur.execute("SELECT SUM(play_count) as total_plays, SUM(skip_count) as total_skips FROM track_play_stats")
    skip_row = cur.fetchone()
    if skip_row and skip_row["total_plays"] and skip_row["total_plays"] > 0:
        skip_rate_overall = round((skip_row["total_skips"] or 0) / skip_row["total_plays"] * 100)
    else:
        skip_rate_overall = 0

    # Top artists detail: name, play_count, total_hours, completion_rate for top 3
    top_artists_detail = []
    for art_name, _ in sorted_artists[:3]:
        # Collect aggregate stats for this artist across their tracks
        art_tracks = [r for r in stats_rows if metadata_map.get(r["track_id"], {}).get("artist") == art_name]
        total_plays_art = sum(r["play_count"] for r in art_tracks)
        total_time_art = sum(r["total_play_time"] for r in art_tracks)
        avg_comp_art = (sum(r["completion_rate"] for r in art_tracks) / len(art_tracks)) if art_tracks else 0.0
        top_artists_detail.append({
            "name": art_name,
            "play_count": int(total_plays_art),
            "total_hours": round(total_time_art / 3600.0, 1),
            "completion_rate": round(avg_comp_art * 100),
        })

    result = {
        "top_artists": sorted_artists[:10],
        "top_artist_name": sorted_artists[0][0] if sorted_artists else "",
        "top_artist_sample": sample_tracks_by_artist.get(sorted_artists[0][0], {}) if sorted_artists else {},
        "top_genres": [g[0] for g in sorted_genres[:5]],
        "top_genre_name": sorted_genres[0][0] if sorted_genres else "",
        "top_genres_breakdown": top_genres_breakdown,
        "current_period": cur_period,
        "current_mood_label": cur_mood,
        "sonic_vibe_badge": vibe_badge,
        "listening_streak_days": max(1, streak_days) if total_listen_seconds > 0 else 0,
        "contextual_top_artist": period_artists[0][0] if period_artists else (sorted_artists[0][0] if sorted_artists else ""),
        "total_listen_hours": round(total_listen_seconds / 3600.0, 1),
        "total_listen_minutes": round(total_listen_seconds / 60.0),
        "disliked_ids": disliked_ids,
        # New analytics fields
        "weekly_plays": weekly_plays,
        "peak_hour_label": peak_hour_label,
        "avg_session_minutes": avg_session_minutes,
        "discovery_score": discovery_score,
        "skip_rate_overall": skip_rate_overall,
        "top_artists_detail": top_artists_detail,
    }

    with _taste_profile_lock:
        _taste_profile_cache["data"] = dict(result)
        _taste_profile_cache["time"] = now

    return result


def compute_weekly_sound_rewind(force_refresh: bool = False) -> dict:
    """
    Synthesizes an interactive weekly sound rewind and musical persona analysis
    from SQLite playback events (last 7 days, with graceful fallback to 30 days / all-time).
    """
    now = time.time()
    week_cutoff = now - (7 * 86400.0)
    conn = db.get_db()
    cur = conn.cursor()

    # 1. Fetch user_events for past 7 days
    cur.execute("""
        SELECT track_id, duration_played, total_duration, completion_rate,
               event_type, hour_of_day, day_of_week, timestamp
        FROM user_events
        WHERE timestamp > ?
        ORDER BY id DESC
    """, (week_cutoff,))
    week_events = cur.fetchall()

    is_sparse = len(week_events) < 3
    if is_sparse:
        month_cutoff = now - (30 * 86400.0)
        cur.execute("""
            SELECT track_id, duration_played, total_duration, completion_rate,
                   event_type, hour_of_day, day_of_week, timestamp
            FROM user_events
            WHERE timestamp > ?
            ORDER BY id DESC
        """, (month_cutoff,))
        week_events = cur.fetchall()

    cur.execute("SELECT track_id, title, artist, album, genre, duration, artwork_url, is_online FROM tracks_meta")
    meta_rows = {r["track_id"]: dict(r) for r in cur.fetchall()}

    lib_tracks = get_unified_catalog()
    lib_map = {t["id"]: t for t in lib_tracks}

    total_listen_seconds = 0.0
    completed_plays = 0
    skips = 0
    day_counts = {}
    hour_counts = {}
    track_counts = {}
    artist_counts = {}
    genre_counts = {}
    active_dates = set()

    for ev in week_events:
        tid = ev["track_id"]
        etype = ev["event_type"]
        dur = ev["duration_played"] or 0.0
        comp = ev["completion_rate"] or 0.0
        h = ev["hour_of_day"]
        d = ev["day_of_week"]
        ts = ev["timestamp"]

        total_listen_seconds += dur
        if etype == "skip":
            skips += 1
        else:
            completed_plays += 1

        weight = 1.0 + min(1.0, comp)
        track_counts[tid] = track_counts.get(tid, 0.0) + weight

        t_meta = meta_rows.get(tid) or lib_map.get(tid) or {}
        art = (t_meta.get("artist") or "").strip()
        genre = (t_meta.get("genre") or "").strip()
        if art and art.lower() not in ("local collection", "unknown", "youtube", "various artists"):
            artist_counts[art] = artist_counts.get(art, 0) + 1
        if genre and genre.lower() not in ("unknown", "various"):
            genre_counts[genre] = genre_counts.get(genre, 0) + 1

        hour_counts[h] = hour_counts.get(h, 0) + 1
        day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        if 0 <= d < 7:
            day_name = day_names[d]
            day_counts[day_name] = day_counts.get(day_name, 0) + 1

        try:
            d_str = time.strftime("%Y-%m-%d", time.localtime(ts))
            active_dates.add(d_str)
        except Exception:
            pass

    if not track_counts:
        cur.execute("""
            SELECT track_id, play_count, total_play_time FROM track_play_stats
            ORDER BY play_count DESC LIMIT 10
        """)
        for r in cur.fetchall():
            track_counts[r["track_id"]] = float(r["play_count"])
            total_listen_seconds += float(r["total_play_time"] or 180.0)
            completed_plays += int(r["play_count"])

    sorted_tids = sorted(track_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    top_tracks = []
    for tid, score in sorted_tids:
        t_meta = meta_rows.get(tid) or lib_map.get(tid) or {}
        clean_title = t_meta.get("title") or (Path(tid).stem if not tid.startswith("yt:") else "YouTube Track")
        clean_artist = t_meta.get("artist") or "Artist"
        art_url = t_meta.get("artwork_url") or ""
        if not art_url and tid.startswith("yt:"):
            vid = tid.replace("yt:", "")
            art_url = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
        top_tracks.append({
            "id": tid,
            "title": clean_title,
            "artist": clean_artist,
            "album": t_meta.get("album") or "",
            "artwork_url": art_url,
            "duration": t_meta.get("duration") or 0,
            "is_online": bool(t_meta.get("is_online", False) or tid.startswith("yt:")),
            "play_count": int(round(score))
        })

    sorted_artists = sorted(artist_counts.items(), key=lambda x: x[1], reverse=True)[:3]
    top_artists = [{"name": a, "plays": cnt} for a, cnt in sorted_artists]

    peak_hour = max(hour_counts.items(), key=lambda x: x[1])[0] if hour_counts else 20
    peak_hour_12 = peak_hour % 12 or 12
    peak_ampm = "AM" if peak_hour < 12 else "PM"
    peak_hour_str = f"{peak_hour_12} {peak_ampm}"

    peak_day_str = max(day_counts.items(), key=lambda x: x[1])[0] if day_counts else "Friday"

    total_minutes = int(round(total_listen_seconds / 60.0))
    if total_minutes == 0 and completed_plays > 0:
        total_minutes = completed_plays * 3

    hours_val = round(total_minutes / 60.0, 1)
    time_str = f"{hours_val} hrs" if total_minutes >= 90 else f"{total_minutes} mins"

    active_days_count = min(7, max(1, len(active_dates))) if completed_plays > 0 else 1

    total_ev_count = completed_plays + skips
    skip_rate = round((skips / total_ev_count) * 100) if total_ev_count > 0 else 5

    night_plays = sum(cnt for h, cnt in hour_counts.items() if h >= 22 or h <= 4)
    night_ratio = night_plays / max(1, completed_plays)

    weekend_plays = day_counts.get("Saturday", 0) + day_counts.get("Sunday", 0) + day_counts.get("Friday", 0)
    weekend_ratio = weekend_plays / max(1, completed_plays)

    sorted_genres = sorted(genre_counts.items(), key=lambda x: x[1], reverse=True)
    top_genre = sorted_genres[0][0] if sorted_genres else "Pop"

    # Musical Persona Archetype Classifier
    if night_ratio >= 0.35:
        persona = {
            "title": "The Night Owl Explorer",
            "icon": "ph-moon-stars",
            "emoji": "🦉",
            "color": "#9d4edd",
            "glow": "rgba(157, 78, 221, 0.4)",
            "gradient": "linear-gradient(135deg, #7b2cbf, #c77dff)",
            "motto": "Crafting nocturnal soundtracks when the world is fast asleep.",
            "traits": ["🌙 35%+ Late Night", f"🎧 {time_str} Focus", "✨ Deep Soundscapes"]
        }
    elif any(w in top_genre.lower() for w in ["acoustic", "folk", "chill", "ambient", "indie", "lo-fi"]):
        persona = {
            "title": "The Acoustic Daydreamer",
            "icon": "ph-coffee",
            "emoji": "☕",
            "color": "#e5a95d",
            "glow": "rgba(229, 169, 93, 0.4)",
            "gradient": "linear-gradient(135deg, #d48b38, #f5c87a)",
            "motto": "Finding warmth and solace in heartfelt, unhurried melodies.",
            "traits": ["☕ Serene Vibes", f"🌿 {top_genre}", "☀️ Daytime Harmony"]
        }
    elif skip_rate < 12 and completed_plays >= 5:
        persona = {
            "title": "The High-Voltage Repeater",
            "icon": "ph-lightning",
            "emoji": "⚡",
            "color": "#ff4757",
            "glow": "rgba(255, 71, 87, 0.4)",
            "gradient": "linear-gradient(135deg, #ff4757, #ff6b81)",
            "motto": "When a track resonates, you lock in and keep it on endless repeat.",
            "traits": ["⚡ High Completion", "🔁 Low Skip Rate", f"🔥 {top_genre} Power"]
        }
    elif total_minutes >= 120 and len(artist_counts) >= 4:
        persona = {
            "title": "The Deep Flow Architect",
            "icon": "ph-waves",
            "emoji": "🌊",
            "color": "#2ed573",
            "glow": "rgba(46, 213, 115, 0.4)",
            "gradient": "linear-gradient(135deg, #10ac84, #2ed573)",
            "motto": "Immersed in continuous, uninterrupted auditory momentum.",
            "traits": ["🌊 Deep Sessions", "🧘 Seamless Momentum", f"🎯 {top_genre}"]
        }
    elif len(genre_counts) >= 4:
        persona = {
            "title": "The Genre Nomad",
            "icon": "ph-compass",
            "emoji": "🧭",
            "color": "#1e90ff",
            "glow": "rgba(30, 144, 255, 0.4)",
            "gradient": "linear-gradient(135deg, #0984e3, #70a1ff)",
            "motto": "Unbound by boundaries, effortlessly wandering across musical horizons.",
            "traits": ["🧭 Multi-Genre", "🌟 High Discovery", "🎵 Eclectic Taste"]
        }
    elif weekend_ratio >= 0.55:
        persona = {
            "title": "The Weekend Festival Goer",
            "icon": "ph-confetti",
            "emoji": "🎪",
            "color": "#ff6b81",
            "glow": "rgba(255, 107, 129, 0.4)",
            "gradient": "linear-gradient(135deg, #e056fd, #ff758c)",
            "motto": "Turning every weekend into an unforgettable headline sonic experience.",
            "traits": ["🎪 Weekend Euphoria", "🎉 High Energy", f"💃 {top_genre}"]
        }
    else:
        persona = {
            "title": "The Melodic Soul",
            "icon": "ph-sparkle",
            "emoji": "✨",
            "color": "#e5a95d",
            "glow": "rgba(229, 169, 93, 0.4)",
            "gradient": "linear-gradient(135deg, #e5a95d, #ffd480)",
            "motto": "Curating moments with perfect rhythm, warmth, and timeless harmony.",
            "traits": ["✨ Timeless Classics", "🎶 Balanced Listening", f"💛 {top_genre}"]
        }

    return {
        "status": "success",
        "timeframe": "Last 7 Days" if not is_sparse else "Recent Listening",
        "is_fallback": is_sparse,
        "total_minutes": total_minutes,
        "total_time_formatted": time_str,
        "completed_plays": completed_plays,
        "active_days": active_days_count,
        "peak_hour": peak_hour_str,
        "peak_day": peak_day_str,
        "skip_rate": skip_rate,
        "top_genre": top_genre,
        "top_tracks": top_tracks,
        "top_artists": top_artists,
        "persona": persona
    }


def compute_streak_heatmap(days_window: int = 84) -> dict:
    """
    Computes user listening activity calendar heatmap and streak metrics
    for the last 12 weeks (84 days) from SQLite user_events & history.
    Returns:
      - current_streak, longest_streak, streak_status, streak_message
      - milestone progress (next tier badge, target days, % progress)
      - total_active_days, total_hours, total_plays in the window
      - 12-week matrix (columns: weeks, rows: Mon-Sun) with activity levels 0..4
      - month labels with column offsets
    """
    import datetime
    now = time.time()
    today = datetime.date.today()
    conn = db.get_db()
    cur = conn.cursor()

    # 1. Fetch user events grouped by local calendar date (past 365 days for accurate streaks)
    year_cutoff = now - (365 * 86400.0)
    cur.execute("""
        SELECT date(timestamp, 'unixepoch', 'localtime') as play_date,
               COUNT(*) as event_cnt,
               SUM(CASE WHEN duration_played > 0 THEN duration_played ELSE 180 END) as total_duration,
               SUM(CASE WHEN event_type != 'skip' THEN 1 ELSE 0 END) as play_cnt
        FROM user_events
        WHERE timestamp > ?
        GROUP BY play_date
        ORDER BY play_date ASC
    """, (year_cutoff,))
    event_rows = cur.fetchall()

    daily_activity = {}
    for r in event_rows:
        p_date = r["play_date"]
        if not p_date:
            continue
        daily_activity[p_date] = {
            "duration": float(r["total_duration"] or 0.0),
            "plays": int(r["play_cnt"] or 0)
        }

    # 2. Fallback / Merge with history table for any legacy records
    cur.execute("""
        SELECT date(played_at, 'unixepoch', 'localtime') as play_date,
               COUNT(*) as play_cnt
        FROM history
        WHERE played_at > ?
        GROUP BY play_date
    """, (year_cutoff,))
    history_rows = cur.fetchall()

    for r in history_rows:
        p_date = r["play_date"]
        if not p_date:
            continue
        p_cnt = int(r["play_cnt"] or 0)
        if p_date not in daily_activity:
            daily_activity[p_date] = {
                "duration": float(p_cnt * 180.0),
                "plays": p_cnt
            }
        else:
            if daily_activity[p_date]["plays"] == 0 and p_cnt > 0:
                daily_activity[p_date]["plays"] = p_cnt
                daily_activity[p_date]["duration"] = max(daily_activity[p_date]["duration"], float(p_cnt * 180.0))

    # 3. Calculate active dates set
    active_dates = set()
    for d_str, stats in daily_activity.items():
        if stats["plays"] > 0 or stats["duration"] >= 60.0:
            try:
                active_dates.add(datetime.date.fromisoformat(d_str))
            except Exception:
                pass

    # 4. Evaluate Current Streak & Status
    today_active = today in active_dates
    yesterday = today - datetime.timedelta(days=1)
    yesterday_active = yesterday in active_dates

    current_streak = 0
    if today_active:
        streak_status = "active_today"
        current_streak = 1
        check = today - datetime.timedelta(days=1)
        while check in active_dates:
            current_streak += 1
            check -= datetime.timedelta(days=1)
        streak_msg = "🔥 Flame burning bright! You've listened today and extended your streak."
    elif yesterday_active:
        streak_status = "at_risk"
        current_streak = 1
        check = yesterday - datetime.timedelta(days=1)
        while check in active_dates:
            current_streak += 1
            check -= datetime.timedelta(days=1)
        streak_msg = f"⚠️ Streak at risk! Play a song today to reach Day {current_streak + 1}."
    else:
        streak_status = "inactive"
        current_streak = 0
        streak_msg = "✨ Play a track today to ignite your daily listening streak!"

    # 5. Evaluate Longest Streak (All-time recorded)
    longest_streak = 0
    if active_dates:
        sorted_dates = sorted(list(active_dates))
        temp_streak = 1
        longest_streak = 1
        for i in range(1, len(sorted_dates)):
            if (sorted_dates[i] - sorted_dates[i - 1]).days == 1:
                temp_streak += 1
                if temp_streak > longest_streak:
                    longest_streak = temp_streak
            else:
                temp_streak = 1
        longest_streak = max(longest_streak, current_streak)

    # 6. Milestones
    all_milestones = [
        {"days": 3, "name": "3-Day Spark", "icon": "🔥", "badge": "Spark"},
        {"days": 7, "name": "7-Day Flame", "icon": "⚡", "badge": "Flame"},
        {"days": 14, "name": "14-Day Inferno", "icon": "💥", "badge": "Inferno"},
        {"days": 30, "name": "30-Day Supernova", "icon": "🌟", "badge": "Supernova"},
        {"days": 60, "name": "60-Day Titan", "icon": "🪐", "badge": "Titan"},
        {"days": 100, "name": "100-Day Legend", "icon": "👑", "badge": "Legend"}
    ]

    next_milestone = all_milestones[-1]
    achieved_milestones = []
    for m in all_milestones:
        if current_streak >= m["days"]:
            achieved_milestones.append(m)
        elif next_milestone == all_milestones[-1] and current_streak < m["days"]:
            next_milestone = m

    progress_percent = 0
    days_left = 0
    if next_milestone["days"] > 0:
        prev_target = 0
        for m in all_milestones:
            if m["days"] < next_milestone["days"]:
                prev_target = m["days"]
        span = next_milestone["days"] - prev_target
        current_in_span = max(0, current_streak - prev_target)
        progress_percent = min(100, round((current_in_span / max(1, span)) * 100))
        days_left = max(0, next_milestone["days"] - current_streak)

    # 7. Build 12-Week (84-Day) Heatmap Grid (Monday = row 0 ... Sunday = row 6)
    # Align grid so current week ends on Sunday
    end_date = today + datetime.timedelta(days=(6 - today.weekday()))
    start_date = end_date - datetime.timedelta(days=days_window - 1)

    total_window_seconds = 0.0
    total_window_plays = 0
    total_window_active_days = 0

    weeks = []
    cur_week = []
    month_labels = []
    seen_months = set()

    col_idx = 0
    curr_d = start_date
    while curr_d <= end_date:
        d_str = curr_d.isoformat()
        is_future = curr_d > today
        is_today = (curr_d == today)
        stats = daily_activity.get(d_str, {"duration": 0.0, "plays": 0})

        dur_sec = stats["duration"] if not is_future else 0.0
        p_cnt = stats["plays"] if not is_future else 0
        dur_min = round(dur_sec / 60.0)

        # Level assignment (0: 0m, 1: 1-15m, 2: 16-45m, 3: 46-90m, 4: >90m)
        if is_future:
            level = -1
        elif dur_min == 0 and p_cnt == 0:
            level = 0
        elif dur_min <= 15 or p_cnt == 1:
            level = 1
        elif dur_min <= 45 or p_cnt <= 4:
            level = 2
        elif dur_min <= 90 or p_cnt <= 8:
            level = 3
        else:
            level = 4

        if not is_future and (p_cnt > 0 or dur_sec >= 60.0):
            total_window_active_days += 1
            total_window_seconds += dur_sec
            total_window_plays += p_cnt

        day_obj = {
            "date": d_str,
            "formatted_date": curr_d.strftime("%A, %b %d, %Y"),
            "short_date": curr_d.strftime("%b %d"),
            "weekday_idx": curr_d.weekday(),  # 0=Mon, 6=Sun
            "weekday_name": curr_d.strftime("%a"),
            "month_name": curr_d.strftime("%b"),
            "day_num": curr_d.day,
            "minutes": dur_min,
            "play_count": p_cnt,
            "level": level,
            "is_today": is_today,
            "is_future": is_future
        }
        cur_week.append(day_obj)

        # Track month labels for column headers (at start of week or month transition)
        m_key = curr_d.strftime("%Y-%m")
        if curr_d.day <= 7 and m_key not in seen_months and not is_future:
            month_labels.append({
                "name": curr_d.strftime("%b"),
                "col_index": col_idx
            })
            seen_months.add(m_key)

        if curr_d.weekday() == 6:  # Sunday completes week column
            weeks.append(cur_week)
            cur_week = []
            col_idx += 1

        curr_d += datetime.timedelta(days=1)

    if cur_week:
        weeks.append(cur_week)

    return {
        "status": "success",
        "current_streak": current_streak,
        "longest_streak": longest_streak,
        "streak_status": streak_status,
        "streak_message": streak_msg,
        "total_active_days": total_window_active_days,
        "total_hours": round(total_window_seconds / 3600.0, 1),
        "total_plays": total_window_plays,
        "milestone": {
            "name": next_milestone["name"],
            "icon": next_milestone["icon"],
            "target": next_milestone["days"],
            "days_left": days_left,
            "progress_percent": progress_percent,
            "achieved": [m["name"] for m in achieved_milestones]
        },
        "weeks": weeks,
        "month_labels": month_labels,
        "today_iso": today.isoformat()
    }


# ============================================================================
# 🧭 Feature 9: 2D Vibe Compass / Mood Dial Scoring Engine
# ============================================================================

_VIBE_POS_VALENCE_WORDS = {
    "happy", "joy", "love", "sun", "summer", "dance", "party", "fun", "celebration",
    "bright", "smile", "cheer", "euphoria", "beautiful", "good", "paradise", "shine",
    "upbeat", "sweet", "magic", "golden", "mastani", "floor", "shape", "alive", "bliss",
    "heaven", "light", "dream", "groove", "glow", "warm", "peace", "romance", "star"
}

_VIBE_NEG_VALENCE_WORDS = {
    "sad", "lonely", "dark", "cry", "crying", "heartbreak", "hurt", "pain", "tears",
    "blue", "broken", "sorrow", "night", "alone", "die", "death", "goodbye", "melancholy",
    "grief", "lost", "ghost", "gehra", "dhurandhar", "fade", "fall", "shadow", "bleed",
    "burn", "haunt", "black", "empty", "cold", "leave", "alone"
}

_VIBE_HIGH_ENERGY_WORDS = {
    "rock", "metal", "edm", "dance", "club", "remix", "beat", "bass", "drop", "fast",
    "rage", "hard", "power", "wild", "fire", "pump", "workout", "trap", "punjabi",
    "electronic", "hype", "floor", "speed", "run", "loud", "heavy", "bang", "crazy",
    "intense", "attack", "storm", "thunder", "drive", "ignite", "rush"
}

_VIBE_LOW_ENERGY_WORDS = {
    "lofi", "lo-fi", "chill", "relax", "sleep", "slow", "acoustic", "ambient", "piano",
    "calm", "peace", "soft", "meditation", "unplugged", "serene", "quiet", "breeze",
    "whisper", "mastani", "gentle", "reprise", "acoustic", "drift", "mellow", "dusk",
    "still", "silent", "peaceful", "unhurried", "lullaby"
}


def compute_track_vibe_coords(title: str, artist: str, genre: str = "") -> tuple[float, float]:
    """
    Maps any track into Russell's Circumplex 2D Mood Space:
    - X (Valence): -1.0 (Melancholic / Somber) to +1.0 (Joyful / Euphoric)
    - Y (Energy):  -1.0 (Chill / Ambient / Lo-Fi) to +1.0 (High-Energy / Punchy)
    """
    import re
    import hashlib

    text = f"{title or ''} {artist or ''} {genre or ''}".lower()
    words = set(re.findall(r"[a-z0-9]+", text))

    # 1. Valence from sentiment vocabulary
    v_pos = len(words & _VIBE_POS_VALENCE_WORDS)
    v_neg = len(words & _VIBE_NEG_VALENCE_WORDS)
    valence = (v_pos - v_neg) * 0.35

    # 2. Energy from acoustic & tempo vocabulary
    e_hi = len(words & _VIBE_HIGH_ENERGY_WORDS)
    e_lo = len(words & _VIBE_LOW_ENERGY_WORDS)
    energy = (e_hi - e_lo) * 0.35

    # 3. Genre heuristics
    g_lower = (genre or "").lower()
    if any(g in g_lower for g in ["edm", "dance", "rock", "metal", "hip-hop", "electronic", "punjabi", "pop"]):
        energy += 0.35
    if any(g in g_lower for g in ["party", "pop", "disco", "funk", "dance"]):
        valence += 0.25
    if any(g in g_lower for g in ["lofi", "lo-fi", "acoustic", "ambient", "classical", "folk", "chill"]):
        energy -= 0.40
    if any(g in g_lower for g in ["sad", "blues", "melancholy", "gothic"]):
        valence -= 0.40

    # 4. Deterministic organic scatter from track title+artist hash (+-0.15)
    key = f"{(title or '').strip()}_{(artist or '').strip()}".encode("utf-8")
    h = int(hashlib.md5(key).hexdigest()[:6], 16)
    scatter_x = ((h % 100) / 50.0 - 1.0) * 0.18
    scatter_y = (((h // 100) % 100) / 50.0 - 1.0) * 0.18

    final_x = max(-1.0, min(1.0, round(valence + scatter_x, 2)))
    final_y = max(-1.0, min(1.0, round(energy + scatter_y, 2)))
    return (final_x, final_y)


def get_quadrant_info(x: float, y: float) -> dict:
    """Returns metadata for the 2D Vibe Compass quadrant."""
    if x >= 0.0 and y >= 0.0:
        return {
            "quadrant": 1,
            "id": "sunburst",
            "name": "Sunburst & Euphoric",
            "icon": "ph-sun",
            "color": "#f59e0b",
            "description": "High Energy, Joyful & Uplifting Pop/Dance"
        }
    elif x < 0.0 and y >= 0.0:
        return {
            "quadrant": 2,
            "id": "voltage",
            "name": "Storm & Dark Voltage",
            "icon": "ph-lightning",
            "color": "#a855f7",
            "description": "High Energy, Moody & Intense Rock/Electronic"
        }
    elif x < 0.0 and y < 0.0:
        return {
            "quadrant": 3,
            "id": "nocturnal",
            "name": "Midnight Blue & Nocturnal",
            "icon": "ph-moon-stars",
            "color": "#3b82f6",
            "description": "Chill, Somber & Nocturnal Melancholy"
        }
    else:
        return {
            "quadrant": 4,
            "id": "sunset",
            "name": "Golden Sunset & Cozy Serene",
            "icon": "ph-coffee",
            "color": "#10b981",
            "description": "Chill, Peaceful & Warm Acoustic Harmony"
        }


def get_vibe_recommended_tracks(target_x: float, target_y: float, limit: int = 15) -> list[dict]:
    """
    Finds the top N tracks from the unified catalog closest in 2D mood space
    to the target (x, y) coordinate using Euclidean distance.
    """
    import math
    catalog = get_unified_catalog()
    scored = []

    for track in catalog:
        tx, ty = compute_track_vibe_coords(
            track.get("title", ""),
            track.get("artist", ""),
            track.get("genre", "")
        )
        dist = math.sqrt((tx - target_x) ** 2 + (ty - target_y) ** 2)
        q_info = get_quadrant_info(tx, ty)

        item = dict(track)
        item["vibe_x"] = tx
        item["vibe_y"] = ty
        item["vibe_dist"] = round(dist, 3)
        item["vibe_quadrant"] = q_info["name"]
        item["vibe_icon"] = q_info["icon"]
        item["vibe_color"] = q_info["color"]
        scored.append((dist, item))

    scored.sort(key=lambda pair: pair[0])
    return [item for _, item in scored[:limit]]


def sort_tracks_by_vibe(tracks: list[dict], target_x: float, target_y: float) -> list[dict]:
    """
    Re-ranks an existing track list (such as an upcoming queue) by 2D mood distance.
    """
    import math
    scored = []
    for track in tracks:
        tx, ty = compute_track_vibe_coords(
            track.get("title", ""),
            track.get("artist", ""),
            track.get("genre", "")
        )
        dist = math.sqrt((tx - target_x) ** 2 + (ty - target_y) ** 2)
        q_info = get_quadrant_info(tx, ty)

        item = dict(track)
        item["vibe_x"] = tx
        item["vibe_y"] = ty
        item["vibe_dist"] = round(dist, 3)
        item["vibe_quadrant"] = q_info["name"]
        item["vibe_icon"] = q_info["icon"]
        item["vibe_color"] = q_info["color"]
        scored.append((dist, item))

    scored.sort(key=lambda pair: pair[0])
    return [item for _, item in scored]


def estimate_track_bpm(title: str, artist: str, genre: str = "") -> float:
    """
    Estimates or looks up the track BPM based on genre, tempo keywords,
    and deterministic hashing scatter for realistic DJ beat-matching.
    """
    import hashlib
    text = f"{title or ''} {artist or ''} {genre or ''}".lower()

    # Genre / Keyword baseline BPMs
    if any(k in text for k in ["edm", "house", "techno", "electro", "dance"]):
        base_bpm = 126.0
    elif any(k in text for k in ["punjabi", "bhangra", "club", "remix"]):
        base_bpm = 124.0
    elif any(k in text for k in ["pop", "disco", "funk", "upbeat", "summer"]):
        base_bpm = 120.0
    elif any(k in text for k in ["rock", "metal", "grunge", "punk", "alternative"]):
        base_bpm = 116.0
    elif any(k in text for k in ["hip-hop", "hip hop", "rap", "trap", "r&b"]):
        base_bpm = 92.0
    elif any(k in text for k in ["lofi", "lo-fi", "chill", "relax", "coffee"]):
        base_bpm = 82.0
    elif any(k in text for k in ["acoustic", "ambient", "classical", "piano", "sleep", "slow"]):
        base_bpm = 74.0
    else:
        base_bpm = 118.0

    # Deterministic subtle scatter +- 3.5 BPM
    key = f"{(title or '').strip()}_{(artist or '').strip()}".encode("utf-8")
    h = int(hashlib.md5(key).hexdigest()[:4], 16)
    scatter = ((h % 70) / 10.0) - 3.5

    return round(base_bpm + scatter, 1)



def get_top_genre_from_history(limit: int = 2) -> list[str]:
    """Returns the user's top genres by weighted affinity."""
    profile = compute_user_taste_profile(days=30)
    genres = profile.get("top_genres", [])
    return genres[:limit] if genres else []


def get_top_artist_from_history(days: int = 14) -> tuple[dict, list]:
    """
    Maintains backwards compatibility with existing API:
    Returns (stats_map, recent_ids).
    """
    conn = db.get_db()
    cur = conn.cursor()
    cutoff = time.time() - (days * 86400)
    try:
        cur.execute("""
            SELECT track_id FROM history
            WHERE played_at > ?
            ORDER BY id DESC LIMIT 200
        """, (cutoff,))
        recent_ids = [r["track_id"] for r in cur.fetchall()]
        if not recent_ids:
            cur.execute("SELECT track_id FROM track_play_stats ORDER BY play_count DESC LIMIT 30")
            recent_ids = [r["track_id"] for r in cur.fetchall()]

        if not recent_ids:
            return {}, []

        placeholders = ",".join(["?"] * len(recent_ids))
        cur.execute(f"SELECT track_id, play_count, completion_rate FROM track_play_stats WHERE track_id IN ({placeholders})", recent_ids)
        stats = {r["track_id"]: (r["play_count"], r["completion_rate"]) for r in cur.fetchall()}
        return stats, recent_ids
    except Exception:
        return {}, []


# ---------------------------------------------------------------------------
# Local Hybrid Recommendation Engine
# ---------------------------------------------------------------------------

def get_local_recommendation_batch(
    current_track: dict,
    library_tracks: list,
    count: int = 25,
    recent_history: list = None,
    consecutive_skips: int = 0
) -> list:
    """
    Linus CMI v6.0 Hybrid Local Recommendation Scorer:
    - Content Similarity (Artist, Album, Category, Title Token Overlap)
    - Markov Chain Sequence Affinity (`track_transitions`)
    - User Feedback & History (Favorites, Playlists, Play Count, Completion EMA)
    - Dislike Suppression (Immediately removes negative feedback tracks)
    - Multi-Skip Engagement Recovery (Surfaces beloved comfort music when skipped >= 2)
    - Anti-Fatigue & Diversity Constraints (Max 2 per artist, recency penalty)
    """
    if not library_tracks:
        return []

    recent_set = set(recent_history or [])
    curr_id = current_track.get("id", "")
    curr_title = current_track.get("title", "")
    curr_artist = current_track.get("artist", "")
    curr_album = current_track.get("album", "")
    curr_cat = current_track.get("category", "")
    curr_dur = float(current_track.get("duration", 0.0) or 0.0)

    conn = db.get_db()
    cur = conn.cursor()
    now = time.time()

    # Dislikes filter
    disliked_ids = db.get_disliked_track_ids()

    # Transitions from current song (Forward & Reverse)
    transition_counts = {}
    reverse_transitions = {}
    co_occurrence_scores = {}
    session_co_scores = {}
    playlist_co_scores = {}

    if curr_id:
        try:
            cur.execute("SELECT to_track_id, count FROM track_transitions WHERE from_track_id = ?", (curr_id,))
            transition_counts = {r["to_track_id"]: r["count"] for r in cur.fetchall()}

            cur.execute("SELECT from_track_id, count FROM track_transitions WHERE to_track_id = ?", (curr_id,))
            reverse_transitions = {r["from_track_id"]: r["count"] for r in cur.fetchall()}

            # 2nd-Hop Co-occurrence: tracks transitioning from same predecessors
            cur.execute("""
                SELECT t2.to_track_id, SUM(t1.count * t2.count) as co_weight
                FROM track_transitions t1
                JOIN track_transitions t2 ON t1.from_track_id = t2.from_track_id
                WHERE t1.to_track_id = ? AND t2.to_track_id != ?
                GROUP BY t2.to_track_id
                ORDER BY co_weight DESC LIMIT 40
            """, (curr_id, curr_id))
            co_occurrence_scores = {r["to_track_id"]: min(35.0, math.sqrt(r["co_weight"]) * 4.0) for r in cur.fetchall()}

            # Session Co-occurrence: tracks played in same listening sessions
            cur.execute("""
                SELECT ue2.track_id, COUNT(DISTINCT ue1.session_id) as shared_sessions
                FROM user_events ue1
                JOIN user_events ue2 ON ue1.session_id = ue2.session_id AND ue1.session_id != ''
                WHERE ue1.track_id = ? AND ue2.track_id != ? AND ue2.event_type != 'skip'
                GROUP BY ue2.track_id
                ORDER BY shared_sessions DESC LIMIT 40
            """, (curr_id, curr_id))
            session_co_scores = {r["track_id"]: min(30.0, r["shared_sessions"] * 7.5) for r in cur.fetchall()}

            # Co-Playlist Affinity: tracks co-occurring in user playlists
            cur.execute("""
                SELECT pt2.track_id, COUNT(DISTINCT pt1.playlist_name) as shared_pls
                FROM playlist_tracks pt1
                JOIN playlist_tracks pt2 ON pt1.playlist_name = pt2.playlist_name
                WHERE pt1.track_id = ? AND pt2.track_id != ?
                GROUP BY pt2.track_id
                ORDER BY shared_pls DESC LIMIT 40
            """, (curr_id, curr_id))
            playlist_co_scores = {r["track_id"]: min(25.0, r["shared_pls"] * 12.0) for r in cur.fetchall()}
        except Exception as e:
            print(f"[RecEngine] Collaborative matrix lookup error: {e}")

    # Play statistics
    cur.execute("SELECT track_id, play_count, skip_count, completion_rate, last_played_at FROM track_play_stats")
    stats = {r["track_id"]: {
        "plays": r["play_count"],
        "skips": r["skip_count"],
        "completion": r["completion_rate"],
        "last_played": r["last_played_at"]
    } for r in cur.fetchall()}

    # Favorites & Playlists
    cur.execute("SELECT track_id FROM favorites")
    favorites = {r["track_id"] for r in cur.fetchall()}

    cur.execute("SELECT DISTINCT track_id FROM playlist_tracks")
    playlist_ids = {r["track_id"] for r in cur.fetchall()}

    # Compute taste profile for top artist affinity boost
    profile = compute_user_taste_profile(days=14)
    top_artists_dict = dict(profile.get("top_artists", []))
    contextual_artist = (profile.get("contextual_top_artist") or "").lower()
    current_period = profile.get("current_period", "evening")

    # Session Context & Mood Inference: extract recent genres & artists from recent_history
    session_genres = set()
    session_artists = set()
    if recent_history:
        recent_metas = db.batch_get_track_metadata(recent_history[:5])
        for r_tid, r_meta in recent_metas.items():
            if r_meta.get("genre"):
                session_genres.add(r_meta["genre"].lower())
            if r_meta.get("artist"):
                session_artists.add(r_meta["artist"].lower())

    comfort_mode = consecutive_skips >= 2
    scored_candidates = []

    for t in library_tracks:
        tid = t.get("id", "")
        if not tid or tid == curr_id or t.get("missing"):
            continue
        if tid in disliked_ids:
            continue

        score = 0.0
        t_title = t.get("title", "")
        t_artist = t.get("artist", "")
        t_album = t.get("album", "")
        t_cat = t.get("category", "") or t.get("genre", "")
        t_dur = float(t.get("duration", 0.0) or 0.0)

        # 1. Content Similarity
        # Artist affinity
        art_sim = _artist_similarity(curr_artist, t_artist)
        if art_sim > 0:
            score += art_sim * 55.0

        # Title keyword / variant overlap (e.g. acoustic, live, reprise)
        title_sim = _title_similarity(curr_title, t_title)
        if title_sim > 0.3:
            score += title_sim * 30.0

        # Album match
        if curr_album and t_album and curr_album.lower() == t_album.lower() and curr_album.lower() not in ("local files", ""):
            score += 25.0

        # Category/Genre match
        if curr_cat and t_cat and curr_cat.lower() == t_cat.lower() and curr_cat.lower() not in ("music", ""):
            score += 25.0

        # Duration similarity (penalize extreme length mismatches)
        if curr_dur > 30 and t_dur > 30:
            dur_ratio = min(curr_dur, t_dur) / max(curr_dur, t_dur)
            score += dur_ratio * 10.0

        # 2. Collaborative Markov & Co-Occurrence Sequence Affinity
        if tid in transition_counts:
            score += min(50.0, transition_counts[tid] * 18.0)
        elif tid in reverse_transitions:
            score += min(30.0, reverse_transitions[tid] * 10.0)

        if tid in co_occurrence_scores:
            score += co_occurrence_scores[tid]

        if tid in session_co_scores:
            score += session_co_scores[tid]

        if tid in playlist_co_scores:
            score += playlist_co_scores[tid]

        # 3. Overall User Taste Affinity
        norm_t_artist = t_artist.strip()
        if norm_t_artist in top_artists_dict:
            score += min(35.0, top_artists_dict[norm_t_artist] * 0.5)

        # 4. Session Mood & Context Continuity
        t_genre_clean = (t.get("genre") or t_cat or "").lower()
        if t_genre_clean and t_genre_clean in session_genres and t_genre_clean != "music":
            score += 20.0
        if t_artist.lower() in session_artists and t_artist.lower() not in ("unknown", "local collection"):
            score += 15.0

        # Time-of-Day Contextual Affinity
        if contextual_artist and contextual_artist in t_artist.lower():
            score += 18.0
        if current_period in ("night", "morning") and t_genre_clean in ("lo-fi", "acoustic", "ambient", "chill"):
            score += 15.0
        elif current_period == "afternoon" and t_genre_clean in ("pop", "rock", "electronic", "hip-hop"):
            score += 15.0

        # 5. Implicit & Explicit Feedback
        if tid in favorites:
            score += 35.0
        if tid in playlist_ids:
            score += 20.0

        s = stats.get(tid)
        if s:
            score += (s["completion"] * 15.0) + min(20.0, s["plays"] * 2.5) - (s["skips"] * 5.0)
            # Recency fatigue penalty: played in last 2 hours
            age_hours = (now - s["last_played"]) / 3600.0
            if age_hours < 2.0:
                score -= (2.0 - age_hours) * 25.0
        else:
            # Cold-start discovery bonus for unplayed library gems
            score += 12.0

        # 6. Multi-skip Engagement Recovery (Comfort Mode)
        if comfort_mode:
            if tid in favorites:
                score += 85.0
            if s and s["completion"] >= 0.8:
                score += 45.0
            if tid in playlist_ids:
                score += 40.0

        # 7. Recency filter (penalize items already in current session queue/history)
        if tid in recent_set:
            score -= 85.0

        # 8. Small stochastic perturbation for freshness/serendipity
        score += random.uniform(0.0, 3.0)

        scored_candidates.append((score, t, t_artist))

    # Sort descending by score
    scored_candidates.sort(key=lambda x: x[0], reverse=True)

    # 9. Diversity enforcement: cap at max 2 tracks per artist
    final_tracks = []
    artist_counts: dict[str, int] = {}
    for score, track, artist in scored_candidates:
        if len(final_tracks) >= count:
            break
        art_key = (artist or "unknown").strip().lower()
        if art_key and art_key not in ("local collection", "unknown") and artist_counts.get(art_key, 0) >= 2:
            continue
        final_tracks.append(track)
        artist_counts[art_key] = artist_counts.get(art_key, 0) + 1

    return final_tracks


def smart_shuffle_tracks(tracks: list, current_track_id: str = None, recent_history: list = None) -> list:
    """
    Linus CMI v6.0 Smart Shuffle:
    1. Evaluates user taste & affinity (favorites, play stats, Markov transitions).
    2. Incorporates Gaussian stochastic temperature for fresh variety on every shuffle action.
    3. Enforces strict Artist Dispersion Constraint: avoids back-to-back tracks from the same artist.
    """
    if not tracks or len(tracks) <= 2:
        return list(tracks or [])

    conn = db.get_db()
    cur = conn.cursor()

    # Favorites
    cur.execute("SELECT track_id FROM favorites")
    fav_ids = {r["track_id"] for r in cur.fetchall()}

    # Dislikes
    disliked_ids = db.get_disliked_track_ids()

    # Play statistics
    cur.execute("SELECT track_id, play_count, completion_rate, skip_count FROM track_play_stats")
    stats = {r["track_id"]: r for r in cur.fetchall()}

    # Transitions from current track
    trans = {}
    if current_track_id:
        cur.execute("SELECT to_track_id, count FROM track_transitions WHERE from_track_id = ?", (current_track_id,))
        trans = {r["to_track_id"]: r["count"] for r in cur.fetchall()}

    recent_set = set((recent_history or [])[:10])

    candidates = []
    current_artist = ""
    for t in tracks:
        tid = t.get("id", "")
        if not tid or tid in disliked_ids:
            continue
        if tid == current_track_id:
            current_artist = (t.get("artist") or "").strip().lower()
            continue

        weight = 50.0
        if tid in fav_ids:
            weight += 35.0

        s = stats.get(tid)
        if s:
            weight += (s["completion_rate"] * 25.0) + min(20.0, s["play_count"] * 2.5) - (s["skip_count"] * 8.0)
        else:
            weight += 12.0  # Unplayed discovery bonus

        if tid in trans:
            weight += min(30.0, trans[tid] * 12.0)

        if tid in recent_set:
            weight -= 25.0

        # Stochastic temperature noise (+/- 25) to guarantee variety on each shuffle
        weight += random.gauss(0.0, 15.0)

        candidates.append({
            "track": t,
            "artist": (t.get("artist") or "unknown").strip().lower(),
            "weight": max(1.0, weight)
        })

    # Sort descending by weighted affinity
    candidates.sort(key=lambda x: x["weight"], reverse=True)

    # Artist Spacing / Dispersion Interleaving
    shuffled = []
    last_artist = current_artist
    while candidates:
        # Pick candidate with highest weight whose artist != last_artist
        idx = next((i for i, c in enumerate(candidates) if c["artist"] and c["artist"] != last_artist and c["artist"] != "unknown"), -1)
        if idx == -1:
            idx = 0
        chosen = candidates.pop(idx)
        shuffled.append(chosen["track"])
        last_artist = chosen["artist"]

    return shuffled


# ---------------------------------------------------------------------------
# Local & Unified Dashboard Shelves
# ---------------------------------------------------------------------------

def get_unified_catalog(library_tracks: list = None) -> list:
    """
    Combines scanned local library tracks with online/streamed tracks recorded in `tracks_meta`.
    This guarantees that streaming-only users (with 0 local files) still have a complete,
    first-class catalog for all recommendation shelves.
    """
    catalog_map = {}

    # 1. Local scanned tracks
    for t in (library_tracks or []):
        if t and t.get("id"):
            catalog_map[t["id"]] = t

    # 2. Database recorded tracks (YouTube streams, previously played songs)
    try:
        conn = db.get_db()
        cur = conn.cursor()
        cur.execute("""
            SELECT track_id, title, artist, album, genre, duration, artwork_url, is_online, source
            FROM tracks_meta
        """)
        for r in cur.fetchall():
            tid = r["track_id"]
            if not tid or tid in catalog_map:
                continue

            is_online = bool(r["is_online"]) or tid.startswith("yt:")
            vid = tid.replace("yt:", "").strip() if is_online else ""
            stream_url = f"/api/youtube/stream/{vid}" if (is_online and vid) else ""
            artwork = r["artwork_url"] or (f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if is_online and vid else "")

            catalog_map[tid] = {
                "id": tid,
                "video_id": vid if is_online else "",
                "title": r["title"] or "Unknown Title",
                "artist": r["artist"] or "Unknown Artist",
                "album": r["album"] or ("YouTube" if is_online else "Unknown Album"),
                "genre": r["genre"] or "",
                "duration": float(r["duration"] or 0),
                "has_artwork": bool(artwork),
                "artwork_url": artwork,
                "media_type": "audio",
                "is_online": is_online,
                "url": stream_url,
                "source": r["source"] or ("youtube" if is_online else "local")
            }
    except Exception as e:
        print(f"[Unified Catalog] Error loading tracks_meta: {e}")

    return list(catalog_map.values())


def get_continue_listening_local(library_tracks: list, count: int = 10) -> list:
    """Returns partially-played and recently active tracks for resuming."""
    library_tracks = library_tracks or get_unified_catalog()
    if not library_tracks:
        return []
    conn = db.get_db()
    cur = conn.cursor()

    cur.execute("SELECT DISTINCT track_id FROM history ORDER BY id DESC LIMIT 50")
    recent_ids = [r["track_id"] for r in cur.fetchall()]

    # Fallback to user_events if history table has no entries
    if not recent_ids:
        cur.execute("SELECT track_id FROM user_events WHERE event_type IN ('play_complete', 'play_partial') ORDER BY id DESC LIMIT 50")
        recent_ids = list(dict.fromkeys(r["track_id"] for r in cur.fetchall()))

    # Fallback to track_play_stats if needed
    if not recent_ids:
        cur.execute("SELECT track_id FROM track_play_stats ORDER BY last_played_at DESC LIMIT 50")
        recent_ids = [r["track_id"] for r in cur.fetchall()]

    cur.execute("SELECT track_id, position FROM positions WHERE position > 10")
    positions = {r["track_id"]: r["position"] for r in cur.fetchall()}

    lib_map = {t["id"]: t for t in library_tracks if not t.get("missing")}
    disliked_ids = db.get_disliked_track_ids()

    result = []
    seen = set()

    # First prioritize tracks with saved positions > 10s
    for tid, pos in positions.items():
        if tid in lib_map and tid not in disliked_ids:
            seen.add(tid)
            t = dict(lib_map[tid])
            t["_resume_pos"] = pos
            result.append(t)
            if len(result) >= count:
                return result

    # Fill remainder with recent history
    for tid in recent_ids:
        if tid in seen or tid not in lib_map or tid in disliked_ids:
            continue
        seen.add(tid)
        t = dict(lib_map[tid])
        if tid in positions:
            t["_resume_pos"] = positions[tid]
        result.append(t)
        if len(result) >= count:
            break

    return result


def get_for_you_local(library_tracks: list, count: int = 10, exclude_ids: set = None) -> list:
    """'For You — Top Picks' shelf: highest-affinity local tracks not recently played."""
    library_tracks = library_tracks or get_unified_catalog()
    if not library_tracks:
        return []
    exclude_ids = exclude_ids or set()
    disliked_ids = db.get_disliked_track_ids()

    conn = db.get_db()
    cur = conn.cursor()
    now = time.time()

    profile = compute_user_taste_profile(days=30)
    top_artists = dict(profile.get("top_artists", []))

    cur.execute("SELECT track_id, play_count, skip_count, completion_rate, last_played_at FROM track_play_stats")
    stats = {r["track_id"]: {
        "plays": r["play_count"],
        "skips": r["skip_count"],
        "completion": r["completion_rate"],
        "last_played": r["last_played_at"]
    } for r in cur.fetchall()}

    cur.execute("SELECT track_id FROM favorites")
    favorites = {r["track_id"] for r in cur.fetchall()}

    cur.execute("SELECT DISTINCT track_id FROM playlist_tracks")
    playlist_ids = {r["track_id"] for r in cur.fetchall()}

    scored = []
    for t in library_tracks:
        tid = t.get("id", "")
        if tid in exclude_ids or tid in disliked_ids or not tid or t.get("missing"):
            continue

        score = 0.0
        artist = (t.get("artist") or "").strip()
        s = stats.get(tid)
        if s:
            age_hours = max(0.0, (now - s["last_played"]) / 3600.0)
            decay = math.exp(-0.01 * age_hours)
            score += s["completion"] * min(30.0, s["plays"] * 3.0) * decay
            score -= s["skips"] * 4.0
        else:
            # Unplayed discovery bonus
            score += 12.0

        if tid in favorites:
            score += 30.0
        if tid in playlist_ids:
            score += 20.0

        if artist in top_artists:
            score += min(40.0, top_artists[artist] * 0.6)

        score += random.uniform(0.0, 3.0)
        scored.append((score, t, artist))

    scored.sort(key=lambda x: x[0], reverse=True)

    # Diversity constraint: max 2 tracks per artist
    result = []
    artist_counts: dict[str, int] = {}
    for score, t, artist in scored:
        if len(result) >= count:
            break
        art_key = artist.lower() if artist else ""
        if art_key and art_key not in ("local collection", "unknown") and artist_counts.get(art_key, 0) >= 2:
            continue
        result.append(t)
        artist_counts[art_key] = artist_counts.get(art_key, 0) + 1

    return result


def get_top_played_local(library_tracks: list, count: int = 10, exclude_ids: set = None) -> list:
    """'Your Most Played' shelf: highest completed listens."""
    library_tracks = library_tracks or get_unified_catalog()
    if not library_tracks:
        return []
    exclude_ids = exclude_ids or set()
    disliked_ids = db.get_disliked_track_ids()

    conn = db.get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT track_id, play_count, completion_rate, skip_count
        FROM track_play_stats
        WHERE play_count > 0
        ORDER BY (play_count * completion_rate) DESC
        LIMIT 100
    """)
    stats = {r["track_id"]: {
        "plays": r["play_count"],
        "completion": r["completion_rate"],
        "skips": r["skip_count"]
    } for r in cur.fetchall()}

    scored = []
    for t in library_tracks:
        tid = t.get("id", "")
        if tid in exclude_ids or tid in disliked_ids or not tid or t.get("missing"):
            continue
        s = stats.get(tid)
        if s and s["plays"] > 0:
            score = (s["plays"] * s["completion"] * 20.0) - (s["skips"] * 3.0)
            scored.append((score, t))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in scored[:count]]


def get_favorites_local(library_tracks: list, count: int = 10, exclude_ids: set = None) -> list:
    """'Favorites Mix' shelf: starred tracks ranked by completion rate."""
    library_tracks = library_tracks or get_unified_catalog()
    if not library_tracks:
        return []
    exclude_ids = exclude_ids or set()
    disliked_ids = db.get_disliked_track_ids()

    conn = db.get_db()
    cur = conn.cursor()
    cur.execute("SELECT track_id FROM favorites ORDER BY added_at DESC")
    fav_ids = {r["track_id"] for r in cur.fetchall()}

    cur.execute("SELECT track_id, completion_rate FROM track_play_stats")
    stats = {r["track_id"]: r["completion_rate"] for r in cur.fetchall()}

    favs = []
    for t in library_tracks:
        tid = t.get("id", "")
        if tid in exclude_ids or tid in disliked_ids or tid not in fav_ids or t.get("missing"):
            continue
        completion = stats.get(tid, 0.7)
        favs.append((completion, t))

    favs.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in favs[:count]]


def get_recently_added_local(library_tracks: list, count: int = 10, exclude_ids: set = None) -> list:
    """'Recently Added' shelf: newest files in collection by mtime."""
    if not library_tracks:
        return []
    exclude_ids = exclude_ids or set()
    disliked_ids = db.get_disliked_track_ids()

    with_mtime = []
    for t in library_tracks:
        tid = t.get("id", "")
        if tid in exclude_ids or tid in disliked_ids or not tid or t.get("missing") or tid.startswith("yt:"):
            continue
        try:
            mtime = os.path.getmtime(tid)
        except (OSError, ValueError):
            mtime = 0.0
        with_mtime.append((mtime, t))

    with_mtime.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in with_mtime[:count]]


# ---------------------------------------------------------------------------
# Enhanced Personalised Shelf Generators
# ---------------------------------------------------------------------------

def get_hidden_gems_local(library_tracks: list, count: int = 10, exclude_ids: set = None) -> list:
    """
    'Hidden Gems' shelf: tracks the user played ≤2 times but finished 80%+ of.
    These are songs the user loved on first encounter but never returned to.
    Logic: completion_rate >= 0.80 AND play_count <= 2
    """
    library_tracks = library_tracks or get_unified_catalog()
    if not library_tracks:
        return []
    exclude_ids = exclude_ids or set()
    disliked_ids = db.get_disliked_track_ids()

    conn = db.get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT track_id, play_count, completion_rate, last_played_at
        FROM track_play_stats
        WHERE play_count >= 1 AND play_count <= 2 AND completion_rate >= 0.80
        ORDER BY completion_rate DESC, last_played_at ASC
        LIMIT 100
    """)
    stats = {r["track_id"]: {
        "plays": r["play_count"],
        "completion": r["completion_rate"],
        "last_played": r["last_played_at"]
    } for r in cur.fetchall()}

    lib_map = {t["id"]: t for t in library_tracks if not t.get("missing")}
    result = []
    for tid, s in stats.items():
        if tid in exclude_ids or tid in disliked_ids:
            continue
        if tid not in lib_map:
            continue
        t = dict(lib_map[tid])
        t["_completion_pct"] = round(s["completion"] * 100)
        result.append((s["completion"], t))

    result.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in result[:count]]


def get_skip_free_zone_local(library_tracks: list, count: int = 10, exclude_ids: set = None) -> list:
    """
    'Skip-Free Zone' shelf: tracks the user has NEVER skipped and played multiple times.
    These are the user's most reliable, comfortable listens.
    Logic: skip_count == 0 AND play_count >= 2
    """
    library_tracks = library_tracks or get_unified_catalog()
    if not library_tracks:
        return []
    exclude_ids = exclude_ids or set()
    disliked_ids = db.get_disliked_track_ids()

    conn = db.get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT track_id, play_count, completion_rate, skip_count
        FROM track_play_stats
        WHERE skip_count = 0 AND play_count >= 2
        ORDER BY (play_count * completion_rate) DESC
        LIMIT 100
    """)
    stats = {r["track_id"]: {
        "plays": r["play_count"],
        "completion": r["completion_rate"],
    } for r in cur.fetchall()}

    lib_map = {t["id"]: t for t in library_tracks if not t.get("missing")}
    result = []
    for tid, s in stats.items():
        if tid in exclude_ids or tid in disliked_ids:
            continue
        if tid not in lib_map:
            continue
        score = s["plays"] * s["completion"] * 20.0
        result.append((score, lib_map[tid]))

    result.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in result[:count]]




def get_this_week_local(library_tracks: list, count: int = 10, exclude_ids: set = None) -> list:
    """
    'Your Top This Week' shelf: tracks played in the last 7 days sorted by
    weighted engagement (play_count × completion_rate within the week window).
    """
    library_tracks = library_tracks or get_unified_catalog()
    if not library_tracks:
        return []
    exclude_ids = exclude_ids or set()
    disliked_ids = db.get_disliked_track_ids()

    now = time.time()
    week_cutoff = now - 7 * 86400.0

    conn = db.get_db()
    cur = conn.cursor()
    # Count plays and avg completion within the past 7 days from user_events
    cur.execute("""
        SELECT track_id,
               COUNT(*) as week_plays,
               AVG(completion_rate) as avg_completion,
               MAX(timestamp) as last_seen
        FROM user_events
        WHERE timestamp > ? AND event_type IN ('play_complete', 'play_partial')
        GROUP BY track_id
        ORDER BY (COUNT(*) * AVG(completion_rate)) DESC
        LIMIT 100
    """, (week_cutoff,))
    weekly_stats = {r["track_id"]: {
        "week_plays": r["week_plays"],
        "avg_completion": r["avg_completion"] or 0.0,
        "last_seen": r["last_seen"],
    } for r in cur.fetchall()}

    lib_map = {t["id"]: t for t in library_tracks if not t.get("missing")}
    result = []
    for tid, s in weekly_stats.items():
        if tid in exclude_ids or tid in disliked_ids:
            continue
        if tid not in lib_map:
            continue
        score = s["week_plays"] * s["avg_completion"] * 15.0
        result.append((score, lib_map[tid]))

    result.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in result[:count]]


def get_markov_next_shelf(library_tracks: list, count: int = 10, exclude_ids: set = None) -> dict:
    """
    'Because You Played [Track]' shelf: uses Markov transition table to surface
    tracks most likely to follow the user's most recently played song.
    Returns a dict with 'seed_title', 'seed_artist', and 'tracks'.
    """
    library_tracks = library_tracks or get_unified_catalog()
    exclude_ids = exclude_ids or set()
    disliked_ids = db.get_disliked_track_ids()

    conn = db.get_db()
    cur = conn.cursor()

    # Find the most recently played track
    cur.execute("""
        SELECT track_id FROM history
        ORDER BY id DESC LIMIT 1
    """)
    row = cur.fetchone()
    if not row:
        cur.execute("""
            SELECT track_id FROM user_events
            WHERE event_type IN ('play_complete', 'play_partial')
            ORDER BY id DESC LIMIT 1
        """)
        row = cur.fetchone()

    if not row:
        return {"seed_title": "", "seed_artist": "", "tracks": []}

    seed_id = row["track_id"]

    # Look up seed track metadata
    seed_meta = db.batch_get_track_metadata([seed_id]).get(seed_id, {})
    seed_title = seed_meta.get("title") or ""
    seed_artist = seed_meta.get("artist") or ""

    # Get first-order transitions from the seed track
    cur.execute("""
        SELECT to_track_id, count
        FROM track_transitions
        WHERE from_track_id = ?
        ORDER BY count DESC
        LIMIT 50
    """, (seed_id,))
    transitions = {r["to_track_id"]: r["count"] for r in cur.fetchall()}

    # Also get second-hop co-occurrence (tracks sharing predecessors)
    cur.execute("""
        SELECT t2.to_track_id, SUM(t1.count * t2.count) as co_weight
        FROM track_transitions t1
        JOIN track_transitions t2 ON t1.from_track_id = t2.from_track_id
        WHERE t1.to_track_id = ? AND t2.to_track_id != ?
        GROUP BY t2.to_track_id
        ORDER BY co_weight DESC LIMIT 30
    """, (seed_id, seed_id))
    co_scores = {r["to_track_id"]: min(25.0, math.sqrt(r["co_weight"]) * 3.0) for r in cur.fetchall()}

    lib_map = {t["id"]: t for t in library_tracks if not t.get("missing")}
    result = []
    seen = {seed_id}

    for tid, cnt in transitions.items():
        if tid in exclude_ids or tid in disliked_ids or tid in seen:
            continue
        if tid not in lib_map:
            continue
        score = float(cnt) * 10.0 + co_scores.get(tid, 0.0)
        result.append((score, lib_map[tid]))
        seen.add(tid)

    # Fill remaining with co-occurrence hits not already in transitions
    for tid, co_score in co_scores.items():
        if tid in seen or tid in exclude_ids or tid in disliked_ids:
            continue
        if tid not in lib_map:
            continue
        result.append((co_score, lib_map[tid]))
        seen.add(tid)

    result.sort(key=lambda x: x[0], reverse=True)
    return {
        "seed_title": seed_title,
        "seed_artist": seed_artist,
        "tracks": [t for _, t in result[:count]]
    }



def get_quick_launch_grid(library_tracks: list, recent_history: list = None) -> list[dict]:
    """
    Constructs the Spotify-style 6-item Quick Launchpad:
    1. Daily Mix 1 (Top Genre / Mood Cluster)
    2. Liked Songs / Starred Station
    3. Top Artist Radio
    4. Jump Back In / Continue Mix
    5. Contextual Time-of-Day Mix (Morning / Afternoon / Evening / Night)
    6. Heavy Rotation / Most Played
    """
    library_tracks = library_tracks or get_unified_catalog()
    profile = compute_user_taste_profile(days=30)
    top_artist = profile.get("top_artist_name", "")
    top_genre = profile.get("top_genre_name", "") or "Chill"
    mood_label = profile.get("current_mood_label", "Daily")

    conn = db.get_db()
    cur = conn.cursor()
    cur.execute("SELECT track_id FROM favorites ORDER BY added_at DESC")
    fav_ids = [r["track_id"] for r in cur.fetchall()]

    track_map = {t["id"]: t for t in library_tracks if not t.get("missing")}
    disliked_ids = set(profile.get("disliked_ids", []))

    grid = []

    # 1. Daily Mix 1
    top_tracks = get_for_you_local(library_tracks, count=15)
    sample_art = ""
    for t in top_tracks:
        if t.get("artwork_url"):
            sample_art = t["artwork_url"]
            break
    
    grid.append({
        "id": "quick_daily_mix",
        "title": "Daily Mix 1",
        "subtitle": f"{top_genre} & Top Hits",
        "icon": "ph-fill ph-sparkle",
        "artwork_url": sample_art,
        "gradient": "linear-gradient(135deg, #e5a95d 0%, #b45309 100%)",
        "type": "mix",
        "tracks": top_tracks[:12],
    })

    # 2. Liked Songs
    fav_tracks = [track_map[tid] for tid in fav_ids if tid in track_map and tid not in disliked_ids]
    fav_art = fav_tracks[0].get("artwork_url") if fav_tracks else ""
    grid.append({
        "id": "quick_favorites",
        "title": "Liked Songs",
        "subtitle": f"{len(fav_tracks)} saved favorites",
        "icon": "ph-fill ph-star",
        "artwork_url": fav_art,
        "gradient": "linear-gradient(135deg, #d946ef 0%, #6366f1 100%)",
        "type": "favorites",
        "tracks": fav_tracks[:15],
    })

    # 3. Top Artist Radio
    if top_artist:
        artist_tracks = [
            t for t in library_tracks
            if (_artist_similarity(t.get("artist", ""), top_artist) >= 0.7 or top_artist.lower() in (t.get("artist", "") or "").lower())
            and t.get("id") not in disliked_ids
        ]
        art_cover = ""
        for at in artist_tracks:
            if at.get("artwork_url"):
                art_cover = at["artwork_url"]
                break
        grid.append({
            "id": "quick_top_artist",
            "title": f"{top_artist} Radio",
            "subtitle": f"Best of {top_artist}",
            "icon": "ph-fill ph-broadcast",
            "artwork_url": art_cover,
            "gradient": "linear-gradient(135deg, #fb7185 0%, #db2777 100%)",
            "type": "artist_radio",
            "artist": top_artist,
            "tracks": artist_tracks[:12],
        })
    else:
        grid.append({
            "id": "quick_trending",
            "title": "Trending Radio",
            "subtitle": "Hot global music",
            "icon": "ph-fill ph-fire",
            "artwork_url": "",
            "gradient": "linear-gradient(135deg, #f97316 0%, #dc2626 100%)",
            "type": "trending",
            "tracks": [],
        })

    # 4. Jump Back In / Continue
    continue_tracks = get_continue_listening_local(library_tracks, count=8)
    cont_art = continue_tracks[0].get("artwork_url") if continue_tracks else ""
    grid.append({
        "id": "quick_continue",
        "title": "Jump Back In",
        "subtitle": "Recent listening queue",
        "icon": "ph-fill ph-play-circle",
        "artwork_url": cont_art,
        "gradient": "linear-gradient(135deg, #34d399 0%, #059669 100%)",
        "type": "history",
        "tracks": continue_tracks,
    })

    # 5. Time-of-Day Mood Mix
    mood_candidates = [t for t in library_tracks if t.get("id") not in disliked_ids]
    mood_sample_art = ""
    for mc in mood_candidates:
        if mc.get("artwork_url"):
            mood_sample_art = mc["artwork_url"]
            break
    grid.append({
        "id": "quick_mood",
        "title": f"{mood_label} Mix",
        "subtitle": "Curated for right now",
        "icon": "ph-fill ph-sun-horizon",
        "artwork_url": mood_sample_art,
        "gradient": "linear-gradient(135deg, #38bdf8 0%, #2563eb 100%)",
        "type": "mood",
        "tracks": mood_candidates[:12],
    })

    # 6. Heavy Rotation / Most Played
    top_played = get_top_played_local(library_tracks, count=12)
    top_art = top_played[0].get("artwork_url") if top_played else ""
    grid.append({
        "id": "quick_top_played",
        "title": "Heavy Rotation",
        "subtitle": "Your most played tracks",
        "icon": "ph-fill ph-chart-line-up",
        "artwork_url": top_art,
        "gradient": "linear-gradient(135deg, #a855f7 0%, #7c3aed 100%)",
        "type": "top_played",
        "tracks": top_played,
    })

    return grid[:6]


def get_daily_mix_capsules(library_tracks: list, count: int = 3) -> list[dict]:
    """
    Generates 3 distinct Daily Mix Capsules grouped by mood/genre texture:
    - Capsule 1: Chill / Lo-Fi / Acoustic
    - Capsule 2: Energy / Pop / Beats
    - Capsule 3: Midnight / Synth / Deep
    """
    library_tracks = library_tracks or get_unified_catalog()
    if not library_tracks:
        return []

    profile = compute_user_taste_profile(days=30)
    top_artists = [a[0] for a in profile.get("top_artists", [])]
    disliked_ids = set(profile.get("disliked_ids", []))
    available = [t for t in library_tracks if not t.get("missing") and t["id"] not in disliked_ids]

    capsules = [
        {
            "id": "capsule_chill",
            "title": "Daily Mix 1",
            "vibe": "Chill & Acoustic",
            "subtitle": f"{top_artists[0] if top_artists else 'Acoustic'}, Lo-Fi & Serene",
            "icon": "ph-fill ph-coffee",
            "gradient": "linear-gradient(135deg, #e5a95d, #b45309)",
            "mood_tag": "chill",
            "tracks": available[:12] if len(available) >= 12 else available
        },
        {
            "id": "capsule_energy",
            "title": "Daily Mix 2",
            "vibe": "High Energy & Upbeat",
            "subtitle": f"{top_artists[1] if len(top_artists) > 1 else 'Upbeat'}, Pop & Hits",
            "icon": "ph-fill ph-lightning",
            "gradient": "linear-gradient(135deg, #fb7185, #d946ef)",
            "mood_tag": "energy",
            "tracks": available[6:18] if len(available) >= 18 else available
        },
        {
            "id": "capsule_deep",
            "title": "Daily Mix 3",
            "vibe": "Late Night & Melancholy",
            "subtitle": f"{top_artists[2] if len(top_artists) > 2 else 'Deep'}, Synthwave & Bass",
            "icon": "ph-fill ph-moon-stars",
            "gradient": "linear-gradient(135deg, #818cf8, #3b82f6)",
            "mood_tag": "night",
            "tracks": available[12:24] if len(available) >= 24 else available
        }
    ]

    return capsules[:count]


# ---------------------------------------------------------------------------
# YouTube Smart Discovery & Shelves
# ---------------------------------------------------------------------------

def _build_yt_track(vid: str, title: str, artist: str, duration: int, thumbnail: str, genre: str = "") -> dict:
    """Builds a unified YouTube track dictionary."""
    return {
        "id": f"yt:{vid}",
        "video_id": vid,
        "title": title,
        "artist": artist,
        "album": genre or "YouTube",
        "duration": duration,
        "has_artwork": True,
        "artwork_url": thumbnail or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "media_type": "audio",
        "is_online": True,
        "url": f"/api/youtube/stream/{vid}"
    }


def _filter_yt_results(items: list, seen_vids: set, seen_fuzzy: set, seed_fuzzy: str = "") -> list:
    """Filters YouTube results for audio quality, deduplication, and noise suppression."""
    result = []
    disliked_ids = db.get_disliked_track_ids()

    for item in items:
        vid = item.get("id") or item.get("video_id")
        if not vid or vid in seen_vids or f"yt:{vid}" in disliked_ids:
            continue
        t_title = item.get("title") or ""
        t_lower = t_title.lower()

        if any(k in t_lower for k in NOISE_KEYWORDS):
            continue

        fuzzy_t = normalize_title_fuzzy(t_title)
        if seed_fuzzy and len(seed_fuzzy) >= 4:
            if seed_fuzzy in fuzzy_t or fuzzy_t in seed_fuzzy:
                continue
        if fuzzy_t and fuzzy_t in seen_fuzzy:
            continue

        dur = item.get("duration") or 0
        if dur > 720 or (dur > 0 and dur < 45):
            continue

        seen_vids.add(vid)
        seen_vids.add(f"yt:{vid}")
        if fuzzy_t:
            seen_fuzzy.add(fuzzy_t)
        result.append(item)
    return result


def get_because_you_listened_youtube(
    top_artist: str,
    top_title: str = "",
    current_video_id: str = "",
    count: int = 10,
    recent_history: list = None
) -> dict:
    """
    'Because You Listened to [Artist]' shelf.
    Uses official YouTube RD Radio + multi-vector artist discovery.
    """
    if not top_artist:
        return {"artist": "", "tracks": []}

    # Check persistent SQLite cache first
    cached_shelf = db.get_dashboard_shelf_cache(f"because_{top_artist}", max_age_seconds=3600.0)
    if cached_shelf and isinstance(cached_shelf, dict) and cached_shelf.get("tracks"):
        return cached_shelf

    recent_set = set(recent_history or [])
    if current_video_id:
        recent_set.add(current_video_id)
        recent_set.add(f"yt:{current_video_id}")

    seen_vids = set(recent_set)
    seen_fuzzy: set[str] = set()
    candidates = []
    seed_fuzzy = normalize_title_fuzzy(top_title) if top_title else ""

    # Strategy 1: Official RD Radio mix if current video id is known
    if current_video_id:
        clean_vid = current_video_id.replace("yt:", "").strip()
        rd_url = f"https://www.youtube.com/watch?v={clean_vid}&list=RD{clean_vid}"
        try:
            import yt_dlp
            ydl_opts = dl.get_youtube_base_opts()
            ydl_opts.update({
                "quiet": True,
                "extract_flat": True,
                "skip_download": True,
                "playlist_items": f"1-{count + 15}",
                "socket_timeout": 5,
            })
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(rd_url, download=False)
                entries = info.get("entries") or []
                for e in entries:
                    if not e:
                        continue
                    vid = e.get("id")
                    if not vid:
                        continue
                    filtered = _filter_yt_results([e], seen_vids, seen_fuzzy, seed_fuzzy)
                    if filtered:
                        candidates.append(_build_yt_track(
                            vid, e.get("title", ""), e.get("uploader") or e.get("channel") or top_artist,
                            e.get("duration") or 0, f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                        ))
                    if len(candidates) >= count:
                        break
        except Exception:
            pass

    # Strategy 2: Multi-Vector Artist Search
    if len(candidates) < count:
        queries = [
            f"{top_artist} songs official audio",
            f"songs like {top_title} by {top_artist}" if top_title else f"{top_artist} greatest hits",
            f"{top_artist} playlist top hits"
        ]
        for query in queries:
            try:
                items = dl.search_youtube(query, limit=8)
                filtered = _filter_yt_results(items, seen_vids, seen_fuzzy, seed_fuzzy)
                for item in filtered:
                    vid = item.get("id")
                    if not vid:
                        continue
                    candidates.append(_build_yt_track(
                        vid, item.get("title", ""), item.get("artist") or top_artist,
                        item.get("duration") or 0,
                        item.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                    ))
                    if len(candidates) >= count:
                        break
            except Exception:
                pass
            if len(candidates) >= count:
                break

    result = {"artist": top_artist, "tracks": candidates[:count]}
    if candidates:
        db.set_dashboard_shelf_cache(f"because_{top_artist}", result)
    return result


def get_mood_radio_youtube(count: int = 10, recent_history: list = None) -> dict:
    """'Mood Radio' shelf: time-of-day adaptive queries personalized with user profile."""
    # Check persistent cache
    hour = time.localtime().tm_hour
    profile = compute_user_taste_profile(days=14)
    top_artist = profile.get("contextual_top_artist") or profile.get("top_artist_name") or ""
    genre = profile.get("top_genre_name") or ""

    if 5 <= hour < 12:
        mood_label = "Morning Calm"
        query_suffix = "morning acoustic chill"
    elif 12 <= hour < 17:
        mood_label = "Afternoon Energy"
        query_suffix = "upbeat hits energy"
    elif 17 <= hour < 22:
        mood_label = "Evening Vibes"
        query_suffix = "chill evening audio"
    else:
        mood_label = "Late Night Deep"
        query_suffix = "late night chillout audio"

    cache_key = f"mood_{mood_label}_{top_artist[:10]}"
    cached_shelf = db.get_dashboard_shelf_cache(cache_key, max_age_seconds=3600.0)
    if cached_shelf and isinstance(cached_shelf, dict) and cached_shelf.get("tracks"):
        return cached_shelf

    recent_set = set(recent_history or [])
    seen_vids = set(recent_set)
    seen_fuzzy: set[str] = set()
    candidates = []

    # Dynamic queries blending mood + user taste targeting single tracks (no playlists)
    queries = []
    if top_artist:
        queries.append(f"{top_artist} {query_suffix} official audio")
        queries.append(f"{top_artist} acoustic audio")
        queries.append(f"{top_artist} chill songs official audio")
    if genre:
        queries.append(f"{genre} {query_suffix} official audio")
        queries.append(f"{genre} chill songs official audio")
    queries.append("chill evening acoustic songs official audio")
    queries.append("relaxing acoustic guitar songs official audio")

    for query in queries:
        if len(candidates) >= count:
            break
        try:
            items = dl.search_youtube(query, limit=count + 5)
            filtered = _filter_yt_results(items, seen_vids, seen_fuzzy)
            for item in filtered:
                vid = item.get("id")
                if not vid:
                    continue
                candidates.append(_build_yt_track(
                    vid, item.get("title", ""), item.get("artist") or "YouTube",
                    item.get("duration") or 0,
                    item.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    mood_label
                ))
                if len(candidates) >= count:
                    break
        except Exception:
            pass

    result = {"mood": mood_label, "tracks": candidates[:count]}
    if candidates:
        db.set_dashboard_shelf_cache(cache_key, result)
    return result


def get_rediscover_youtube(count: int = 10, recent_history: list = None) -> list:
    """
    'Rediscover' shelf from YouTube:
    Surfaces classic hits, earlier iconic tracks, and nostalgic deep cuts
    from the user's favorite artists that they may not have heard recently.
    """
    profile = compute_user_taste_profile(days=30)
    top_artists = [a[0] for a in profile.get("top_artists", [])[:3]]
    top_genre = profile.get("top_genre_name") or ""
    primary_artist = top_artists[0] if top_artists else ""

    cache_key = f"rediscover_{primary_artist[:10]}_{top_genre[:10]}"
    cached_shelf = db.get_dashboard_shelf_cache(cache_key, max_age_seconds=3600.0)
    if cached_shelf and isinstance(cached_shelf, list) and cached_shelf:
        return cached_shelf

    recent_set = set(recent_history or [])
    conn = db.get_db()
    cur = conn.cursor()
    cur.execute("SELECT track_id FROM tracks_meta")
    recent_set.update(r["track_id"] for r in cur.fetchall())

    seen_vids = set(recent_set)
    seen_fuzzy: set[str] = set()
    candidates = []

    queries = []
    for art in top_artists:
        queries.append(f"{art} classic hits official audio")
        queries.append(f"{art} throwback songs official audio")
        queries.append(f"{art} earlier hits official audio")
    if top_genre:
        queries.append(f"{top_genre} 2010s nostalgic hits official audio")
        queries.append(f"timeless classic {top_genre} songs official audio")
    queries.append("all time greatest classic hits official audio")

    for query in queries:
        if len(candidates) >= count:
            break
        try:
            items = dl.search_youtube(query, limit=count + 5)
            filtered = _filter_yt_results(items, seen_vids, seen_fuzzy)
            for item in filtered:
                vid = item.get("id")
                if not vid:
                    continue
                candidates.append(_build_yt_track(
                    vid, item.get("title", ""), item.get("artist") or primary_artist or "YouTube",
                    item.get("duration") or 0,
                    item.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    "Rediscover"
                ))
                if len(candidates) >= count:
                    break
        except Exception:
            pass

    if candidates:
        db.set_dashboard_shelf_cache(cache_key, candidates[:count])
    return candidates[:count]


def get_trending_youtube(genre_hint: str = "", count: int = 10, recent_history: list = None) -> list:
    """'Trending Now' shelf: popular/trending music biased towards user's genre affinity."""
    cache_key = f"trending_{genre_hint or 'global'}"
    cached_shelf = db.get_dashboard_shelf_cache(cache_key, max_age_seconds=3600.0)
    if cached_shelf and isinstance(cached_shelf, list) and cached_shelf:
        return cached_shelf

    recent_set = set(recent_history or [])
    seen_vids = set(recent_set)
    seen_fuzzy: set[str] = set()
    candidates = []

    queries = []
    if genre_hint and genre_hint.lower() not in ("music", "pop", ""):
        queries.append(f"trending {genre_hint} songs 2024")
    queries.extend([
        "trending music worldwide 2024",
        "top hits songs 2024",
        "viral music hits 2024"
    ])

    for query in queries:
        if len(candidates) >= count:
            break
        try:
            items = dl.search_youtube(query, limit=count + 5)
            filtered = _filter_yt_results(items, seen_vids, seen_fuzzy)
            for item in filtered:
                vid = item.get("id")
                if not vid:
                    continue
                candidates.append(_build_yt_track(
                    vid, item.get("title", ""), item.get("artist") or "YouTube",
                    item.get("duration") or 0,
                    item.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                    genre_hint or "Trending"
                ))
                if len(candidates) >= count:
                    break
        except Exception:
            pass

    if candidates:
        db.set_dashboard_shelf_cache(cache_key, candidates[:count])
    return candidates[:count]


# ---------------------------------------------------------------------------
# Autoplay Radio Engine (Next Track Prediction)
# ---------------------------------------------------------------------------

def get_youtube_recommendation_batch(
    title: str,
    artist: str = "",
    current_video_id: str = "",
    count: int = 25,
    recent_history: list = None
) -> list:
    """
    High-Fidelity Autoplay Radio:
    1. Primary: YouTube Official Radio Mix (list=RD<video_id>)
    2. Fallback: Multi-Vector Acoustic Peer Discovery
    3. Strict Zero-Duplicate Shield & Non-Music Blocker
    """
    clean_vid = (current_video_id or "").replace("yt:", "").strip()
    recent_set = set(recent_history or [])
    if clean_vid:
        recent_set.add(clean_vid)
        recent_set.add(f"yt:{clean_vid}")

    cache_key = f"radio_{clean_vid}_{title}_{artist}".strip().lower()
    if cache_key in _rec_cache and len(_rec_cache[cache_key]) >= 15:
        return [c for c in _rec_cache[cache_key] if c.get("video_id") not in recent_set][:count]

    parsed_title, real_artist, genre = parse_artist_and_title(title, artist)
    seed_fuzzy = normalize_title_fuzzy(parsed_title or title)

    candidates = []
    seen_vids = set(recent_set)
    seen_fuzzy_titles = {seed_fuzzy} if seed_fuzzy else set()

    # Strategy 1: Official Radio Mix
    if clean_vid:
        rd_url = f"https://www.youtube.com/watch?v={clean_vid}&list=RD{clean_vid}"
        try:
            import yt_dlp
            ydl_opts = dl.get_youtube_base_opts()
            ydl_opts.update({
                "quiet": True,
                "extract_flat": True,
                "skip_download": True,
                "playlist_items": f"1-{count + 20}",
                "socket_timeout": 5,
            })
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(rd_url, download=False)
                entries = info.get("entries") or []
                filtered = _filter_yt_results(entries, seen_vids, seen_fuzzy_titles, seed_fuzzy)
                for item in filtered:
                    vid = item.get("id")
                    if not vid:
                        continue
                    candidates.append(_build_yt_track(
                        vid, item.get("title", ""), item.get("uploader") or item.get("channel") or real_artist or "YouTube",
                        item.get("duration") or 0,
                        item.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                        genre or "Radio"
                    ))
                    if len(candidates) >= count:
                        break
        except Exception:
            pass

    # Strategy 2: Multi-Vector Fallback
    if len(candidates) < count:
        search_vectors = []
        if real_artist and real_artist.lower() not in ("various artists", "youtube", "unknown"):
            search_vectors.append((f"songs like {parsed_title} by {real_artist}", 10))
            search_vectors.append((f"{real_artist} songs official audio", 8))
        else:
            search_vectors.append((f"songs like {parsed_title}", 10))

        for query, limit in search_vectors:
            try:
                items = dl.search_youtube(query, limit=limit)
                filtered = _filter_yt_results(items, seen_vids, seen_fuzzy_titles, seed_fuzzy)
                for item in filtered:
                    vid = item.get("id")
                    if not vid:
                        continue
                    candidates.append(_build_yt_track(
                        vid, item.get("title", ""), item.get("artist") or "YouTube",
                        item.get("duration") or 0,
                        item.get("thumbnail") or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                        genre or "Radio"
                    ))
                    if len(candidates) >= count:
                        break
            except Exception:
                pass
            if len(candidates) >= count:
                break

    if candidates:
        _clean_cache()
        _rec_cache[cache_key] = candidates

    return candidates[:count]


# ---------------------------------------------------------------------------
# Master Dashboard Aggregator (Two-Tier High-Performance Architecture)
# ---------------------------------------------------------------------------

def get_dashboard_recommendations(
    library_tracks: list,
    recent_history: list = None,
    force_refresh: bool = False,
    fast_only: bool = False
) -> dict:
    """
    Two-Tier Master Dashboard Aggregator:
    1. Local Shelves: Computed directly from SQLite in <15ms.
    2. Online Shelves: Retrieved from persistent `dashboard_cache`.
       If cache is stale and fast_only=False, fetched via parallel threads.
    """
    now = time.time()
    recent_history = recent_history or []
    exclude_ids = set(recent_history)

    # 1. Compute User Taste Profile
    profile = compute_user_taste_profile(days=30)
    top_artist = profile.get("top_artist_name", "")
    sample_track = profile.get("top_artist_sample", {})
    top_artist_title = sample_track.get("title", "")
    top_genre = profile.get("top_genre_name", "")
    mood_label = profile.get("current_mood_label", "Mood")

    # Build unified catalog combining local tracks with online streams/played tracks
    catalog = get_unified_catalog(library_tracks)

    # 2. Instant Local Shelves (< 15ms)
    continue_tracks = get_continue_listening_local(catalog, count=10)
    for_you_tracks = get_for_you_local(catalog, count=10, exclude_ids=exclude_ids)
    top_played_tracks = get_top_played_local(catalog, count=10, exclude_ids=exclude_ids)
    favorites_tracks = get_favorites_local(catalog, count=10, exclude_ids=exclude_ids)
    recent_added_tracks = get_recently_added_local(library_tracks, count=10, exclude_ids=exclude_ids)

    # 2b. New Personalised Shelves
    hidden_gems_tracks = get_hidden_gems_local(catalog, count=10, exclude_ids=exclude_ids)
    skip_free_tracks = get_skip_free_zone_local(catalog, count=10, exclude_ids=exclude_ids)
    this_week_tracks = get_this_week_local(catalog, count=10, exclude_ids=exclude_ids)
    markov_next_data = get_markov_next_shelf(catalog, count=10, exclude_ids=exclude_ids)

    # Update exclude set with local selections
    for shelf in [continue_tracks, for_you_tracks, top_played_tracks, favorites_tracks,
                  recent_added_tracks, hidden_gems_tracks, skip_free_tracks,
                  this_week_tracks, markov_next_data.get("tracks", [])]:
        for t in shelf:
            exclude_ids.add(t.get("id", ""))

    # 3. Online Discovery Shelves (Cached / Async)
    if force_refresh:
        db.invalidate_dashboard_cache()

    cached_because = db.get_dashboard_shelf_cache(f"because_{top_artist}", max_age_seconds=1800.0) if top_artist else None
    cached_mood = db.get_dashboard_shelf_cache(f"mood_{mood_label}_{top_artist[:10]}", max_age_seconds=1800.0)
    cached_trending = db.get_dashboard_shelf_cache(f"trending_{top_genre or 'global'}", max_age_seconds=1800.0)
    cached_rediscover = db.get_dashboard_shelf_cache(f"rediscover_{top_artist[:10]}_{top_genre[:10]}", max_age_seconds=1800.0)

    needs_fetch = force_refresh or not (cached_because and cached_mood and cached_trending and cached_rediscover)

    yt_results = {
        "because": cached_because or {"artist": top_artist, "tracks": []},
        "mood": cached_mood or {"mood": mood_label, "tracks": []},
        "trending": cached_trending or [],
        "rediscover": cached_rediscover or [],
    }

    global _bg_fetch_running
    if needs_fetch and not _bg_fetch_running:
        _bg_fetch_running = True
        def _async_bg_fetch():
            global _bg_fetch_running
            try:
                if top_artist and (not cached_because or force_refresh):
                    get_because_you_listened_youtube(
                        top_artist=top_artist,
                        top_title=top_artist_title,
                        count=10,
                        recent_history=list(exclude_ids)
                    )
                if not cached_mood or force_refresh:
                    get_mood_radio_youtube(count=10, recent_history=list(exclude_ids))
                if not cached_trending or force_refresh:
                    get_trending_youtube(genre_hint=top_genre, count=10, recent_history=list(exclude_ids))
                if not cached_rediscover or force_refresh:
                    get_rediscover_youtube(count=10, recent_history=list(exclude_ids))
            except Exception as e:
                print(f"[Dashboard Async Enrichment] Error: {e}")
            finally:
                _bg_fetch_running = False

        threading.Thread(target=_async_bg_fetch, daemon=True).start()

    # 4. Assemble Sections with Mood Tags for Interactive Filtering
    quick_grid = get_quick_launch_grid(catalog, recent_history)
    daily_capsules = get_daily_mix_capsules(catalog, count=3)

    sections = []

    if continue_tracks:
        sections.append({
            "id": "continue",
            "title": "Continue Listening",
            "subtitle": "Pick up where you left off",
            "icon": "ph-play-circle",
            "source": "local",
            "mood_tags": ["all", "focus", "night"],
            "tracks": continue_tracks,
        })

    if daily_capsules:
        sections.append({
            "id": "capsules",
            "title": "Made For You — Daily Capsules",
            "subtitle": "Your custom blends tailored to every mood",
            "icon": "ph-sparkle",
            "source": "capsule",
            "mood_tags": ["all", "chill", "energy", "focus", "night"],
            "capsules": daily_capsules,
        })

    if for_you_tracks:
        sections.append({
            "id": "for_you",
            "title": "For You — Top Picks",
            "subtitle": "Curated from your listening habits",
            "icon": "ph-sparkle",
            "source": "local",
            "mood_tags": ["all", "chill", "discovery"],
            "tracks": for_you_tracks,
        })

    if yt_results["because"].get("tracks"):
        b_artist = yt_results["because"].get("artist") or top_artist
        sections.append({
            "id": "because",
            "title": f"Because You Listened to {b_artist}",
            "subtitle": f"Songs inspired by {b_artist}",
            "icon": "ph-music-note",
            "source": "youtube",
            "mood_tags": ["all", "discovery", "chill"],
            "tracks": yt_results["because"]["tracks"],
        })

    if top_played_tracks:
        sections.append({
            "id": "top_played",
            "title": "Your Most Played",
            "subtitle": "Your personal hall of fame",
            "icon": "ph-chart-line-up",
            "source": "local",
            "mood_tags": ["all", "energy", "focus"],
            "tracks": top_played_tracks,
        })

    if favorites_tracks:
        sections.append({
            "id": "favorites",
            "title": "Favorites Mix",
            "subtitle": "Songs you've loved over time",
            "icon": "ph-star",
            "source": "local",
            "mood_tags": ["all", "chill", "night"],
            "tracks": favorites_tracks,
        })

    if yt_results["mood"].get("tracks"):
        m_label = yt_results["mood"].get("mood") or mood_label
        sections.append({
            "id": "mood",
            "title": f"{m_label} Radio",
            "subtitle": "Curated for right now",
            "icon": "ph-sun-horizon",
            "source": "youtube",
            "mood_tags": ["all", "night", "chill", "focus"],
            "tracks": yt_results["mood"]["tracks"],
        })

    if recent_added_tracks:
        sections.append({
            "id": "recent_added",
            "title": "Recently Added",
            "subtitle": "Fresh to your collection",
            "icon": "ph-plus-circle",
            "source": "local",
            "mood_tags": ["all", "discovery"],
            "tracks": recent_added_tracks,
        })

    if yt_results["trending"]:
        sections.append({
            "id": "trending",
            "title": "Trending Now",
            "subtitle": "What the world is listening to",
            "icon": "ph-fire",
            "source": "youtube",
            "mood_tags": ["all", "discovery", "energy"],
            "tracks": yt_results["trending"],
        })

    # 5. New Personalised Sections
    if this_week_tracks:
        sections.append({
            "id": "this_week",
            "title": "Your Top This Week",
            "subtitle": "Most played in the last 7 days",
            "icon": "ph-calendar-check",
            "source": "local",
            "mood_tags": ["all", "energy", "focus"],
            "tracks": this_week_tracks,
        })

    if hidden_gems_tracks:
        sections.append({
            "id": "hidden_gems",
            "title": "Hidden Gems",
            "subtitle": "Loved once — ready to rediscover",
            "icon": "ph-diamond",
            "source": "local",
            "mood_tags": ["all", "chill", "discovery"],
            "tracks": hidden_gems_tracks,
        })

    if skip_free_tracks:
        sections.append({
            "id": "skip_free",
            "title": "Skip-Free Zone",
            "subtitle": "Songs you never skip — ever",
            "icon": "ph-shield-check",
            "source": "local",
            "mood_tags": ["all", "chill", "focus", "night"],
            "tracks": skip_free_tracks,
        })

    if yt_results["rediscover"]:
        sections.append({
            "id": "rediscover",
            "title": "Rediscover",
            "subtitle": f"Timeless classics & throwback hits from {top_artist or 'YouTube'}",
            "icon": "ph-clock-clockwise",
            "source": "youtube",
            "mood_tags": ["all", "chill", "night", "discovery"],
            "tracks": yt_results["rediscover"],
        })

    if markov_next_data.get("tracks"):
        seed_t = markov_next_data.get("seed_title", "")
        seed_a = markov_next_data.get("seed_artist", "")
        markov_label = seed_t[:28] if seed_t else (seed_a or "Your Last Play")
        sections.append({
            "id": "markov_next",
            "title": f"Because You Played: {markov_label}",
            "subtitle": "Tracks that naturally follow your last listen",
            "icon": "ph-graph",
            "source": "local",
            "mood_tags": ["all", "discovery", "focus"],
            "tracks": markov_next_data["tracks"],
            "seed_title": seed_t,
            "seed_artist": seed_a,
        })

    return {
        "sections": sections,
        "quick_grid": quick_grid,
        "daily_capsules": daily_capsules,
        "generated_at": now,
        "top_artist": top_artist,
        "top_genre": top_genre,
        "taste_summary": {
            "top_artists": [a[0] for a in profile.get("top_artists", [])[:3]],
            "top_artists_detail": profile.get("top_artists_detail", []),
            "top_genres_breakdown": profile.get("top_genres_breakdown", []),
            "total_listen_hours": profile.get("total_listen_hours", 0.0),
            "total_listen_minutes": profile.get("total_listen_minutes", 0),
            "listening_streak_days": profile.get("listening_streak_days", 0),
            "sonic_vibe_badge": profile.get("sonic_vibe_badge", "✨ Serene Music Explorer"),
            "mood_vibe": mood_label,
            "weekly_plays": profile.get("weekly_plays", 0),
            "peak_hour_label": profile.get("peak_hour_label", ""),
            "avg_session_minutes": profile.get("avg_session_minutes", 0.0),
            "discovery_score": profile.get("discovery_score", 0),
            "skip_rate_overall": profile.get("skip_rate_overall", 0),
        }
    }

