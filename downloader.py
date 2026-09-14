"""
downloader.py — Linus Download Manager (v2)
Uses yt_dlp to download audio/video from YouTube and other supported sites.

Supported audio formats : mp3, m4a, ogg, flac, wav, opus
Supported audio qualities: 32, 64, 128, 192, 256, 320 kbps
Supported video formats  : mp4, webm, mkv
Supported video qualities: 144p, 240p, 360p, 480p, 720p, 1080p, 1440p, 2160p (4K), best

Downloads run in background threads; progress is tracked per job.
"""

import json
import threading
import time
import uuid
from pathlib import Path
import db_store as db

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ROOT_DIR = Path(__file__).resolve().parent
DOWNLOADS_DIR = ROOT_DIR / "downloads"
STREAM_CACHE_DIR = ROOT_DIR / "stream_cache"

AUDIO_FORMATS  = {"mp3", "m4a", "ogg", "flac", "wav", "opus"}
AUDIO_QUALITIES = {"32", "64", "128", "192", "256", "320"}

VIDEO_FORMATS   = {"mp4", "webm", "mkv"}
VIDEO_HEIGHTS   = {"144", "240", "360", "480", "720", "1080", "1440", "2160", "best"}


def find_cookie_file() -> Path | None:
    """
    Search for a valid YouTube cookies.txt file in standard locations:
    1. Environment variable YOUTUBE_COOKIE_FILE
    2. Project root cookies.txt or youtube_cookies.txt
    3. downloads/cookies.txt
    """
    import os
    env_path = os.environ.get("YOUTUBE_COOKIE_FILE")
    if env_path and Path(env_path).is_file():
        return Path(env_path)
    for candidate in [ROOT_DIR / "cookies.txt", ROOT_DIR / "youtube_cookies.txt", DOWNLOADS_DIR / "cookies.txt"]:
        if candidate.is_file():
            return candidate
    return None


def get_youtube_base_opts(clients: list[str] | None = None) -> dict:
    """
    Common options for all yt-dlp YouTube interactions to bypass bot-detection:
    - Node.js JS runtime for JS challenge solving
    - EJS component for signature deciphering
    - extractor_args with resilient player_client fallback order
    - Automatic cookie file detection (cookies.txt)
    """
    import os
    cookie_path = find_cookie_file()

    # If cookies are provided, web client is safest & delivers highest bitrate.
    # If no cookies, mobile clients (android, ios) bypass bot-check restrictions.
    if clients is None:
        if cookie_path:
            clients = ["web", "android", "ios"]
        else:
            clients = ["android", "ios", "web"]

    opts = {
        "js_runtimes": {"node": {}},
        "remote_components": ["ejs:github"],
        "extractor_args": {
            "youtube": {
                "player_client": clients,
                "player_skip": ["configs"],
            }
        },
    }

    if cookie_path:
        opts["cookiefile"] = str(cookie_path)
    elif os.environ.get("YOUTUBE_COOKIES_BROWSER"):
        opts["cookiesfrombrowser"] = (os.environ["YOUTUBE_COOKIES_BROWSER"].strip(),)

    return opts

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------

_jobs: dict = {}   # job_id -> dict
_lock = threading.Lock()


def _new_job(url: str, opts: dict) -> str:
    job_id = str(uuid.uuid4())[:8]   # short ID for display
    with _lock:
        _jobs[job_id] = {
            "id":         job_id,
            "url":        url,
            "status":     "queued",   # queued | downloading | processing | done | error
            "percent":    0.0,
            "speed":      "",
            "eta":        "",
            "title":      "",
            "filename":   "",
            "error":      "",
            # user-supplied metadata
            "media_type":    opts.get("media_type", "audio"),
            "format":        opts.get("format", "mp3"),
            "quality":       opts.get("quality", "192"),
            "category":      opts.get("category", "").strip(),
            "started_at":    time.time(),
            "finished_at":   None,
        }
    return job_id


def get_job(job_id: str) -> dict | None:
    with _lock:
        return dict(_jobs[job_id]) if job_id in _jobs else None


def list_jobs() -> list:
    with _lock:
        return [dict(j) for j in _jobs.values()]


# ---------------------------------------------------------------------------
# Windows filename safety
# ---------------------------------------------------------------------------

# Characters Windows forbids in filenames (plus full-width Unicode equivalents
# that yt-dlp sometimes copies verbatim from video titles on YouTube).
_WIN_ILLEGAL = str.maketrans({
    # Standard illegal chars
    '<': '(', '>': ')', ':': '-', '"': "'", '/': '-',
    '\\': '-', '|': '-', '?': '', '*': '',
    # Full-width variants used in Japanese / Korean video titles
    '\uff02': "'",   # ＂ FULLWIDTH QUOTATION MARK
    '\uff1c': '(',  # ＜ FULLWIDTH LESS-THAN SIGN
    '\uff1e': ')',  # ＞ FULLWIDTH GREATER-THAN SIGN
    '\uff1a': '-',  # ： FULLWIDTH COLON
    '\uff0f': '-',  # ／ FULLWIDTH SOLIDUS
    '\uff3c': '-',  # ＼ FULLWIDTH REVERSE SOLIDUS
    '\uff5c': '-',  # ｜ FULLWIDTH VERTICAL LINE
    '\uff1f': '',   # ？ FULLWIDTH QUESTION MARK
    '\uff0a': '',   # ＊ FULLWIDTH ASTERISK
})


def _safe_title_hook(job_id: str):
    """
    Post-processing hook: rename the downloaded file if its title contains
    Windows-illegal characters that yt-dlp didn't sanitize.
    This runs after the file is already written so no rename race occurs.
    """
    import os, re

    def hook(d):
        if d["status"] != "finished":
            return
        filepath = d.get("filename", "")
        if not filepath:
            return
        directory = os.path.dirname(filepath)
        basename  = os.path.basename(filepath)
        safe_name = basename.translate(_WIN_ILLEGAL)
        # Collapse multiple spaces / dashes
        safe_name = re.sub(r'[\s\-]{2,}', ' ', safe_name).strip()
        safe_path = os.path.join(directory, safe_name)
        if safe_path != filepath and os.path.exists(filepath):
            try:
                os.rename(filepath, safe_path)
                with _lock:
                    job = _jobs.get(job_id)
                    if job:
                        job["filename"] = safe_path
            except OSError:
                pass   # file was already renamed by yt-dlp itself

    return hook


# ---------------------------------------------------------------------------
# yt-dlp progress hook
# ---------------------------------------------------------------------------

def _make_progress_hook(job_id: str):
    def hook(d):
        with _lock:
            job = _jobs.get(job_id)
            if not job:
                return

            if job.get("cancel_flag"):
                raise Exception("Download cancelled by user.")

            if d["status"] == "downloading":
                raw_pct = d.get("_percent_str", "0%").replace("%", "").strip()
                try:
                    pct = float(raw_pct)
                except ValueError:
                    pct = 0.0
                job["status"]   = "downloading"
                job["percent"]  = pct
                job["speed"]    = d.get("_speed_str", "").strip()
                job["eta"]      = d.get("_eta_str", "").strip()
                job["filename"] = str(d.get("filename", ""))
                info = d.get("info_dict") or {}
                if info.get("title"):
                    job["title"] = info["title"]

            elif d["status"] == "finished":
                job["status"]   = "processing"
                job["percent"]  = 99.0
                job["filename"] = str(d.get("filename", ""))
                info = d.get("info_dict") or {}
                if info.get("title"):
                    job["title"] = info["title"]

    return hook


# ---------------------------------------------------------------------------
# yt-dlp option builders
# ---------------------------------------------------------------------------

def _build_audio_opts(job_id: str, fmt: str, quality: str) -> dict:
    """
    Build yt-dlp options for audio extraction.
    fmt     : one of AUDIO_FORMATS
    quality : kbps string, one of AUDIO_QUALITIES
    """
    DOWNLOADS_DIR.mkdir(exist_ok=True)

    postprocessors = [
        {
            "key":              "FFmpegExtractAudio",
            "preferredcodec":   fmt,
            "preferredquality": quality,
        }
    ]

    # embed thumbnail as cover art for mp3 / m4a
    if fmt in {"mp3", "m4a"}:
        postprocessors.append({"key": "EmbedThumbnail"})
        postprocessors.append({"key": "FFmpegMetadata", "add_metadata": True})

    opts = get_youtube_base_opts()
    opts.update({
        "format":               "bestaudio/best",
        "outtmpl":              str(DOWNLOADS_DIR / "%(title)s.%(ext)s"),
        "writethumbnail":       fmt in {"mp3", "m4a"},
        "postprocessors":       postprocessors,
        "progress_hooks":       [_make_progress_hook(job_id)],
        "postprocessor_hooks":  [_safe_title_hook(job_id)],
        "quiet":                True,
        "no_warnings":          True,
        "ignoreerrors":         False,
        "noplaylist":           True,
        # ── Windows filename safety ──────────────────────────────────────────
        "windowsfilenames":     True,
        "retries":              10,
        "file_access_retries":  10,
    })
    return opts


def _build_video_opts(job_id: str, fmt: str, height: str) -> dict:
    """
    Build yt-dlp options for video download.
    fmt    : one of VIDEO_FORMATS
    height : pixel height string, e.g. "720", or "best"
    """
    DOWNLOADS_DIR.mkdir(exist_ok=True)

    if height == "best":
        fmt_selector = f"bestvideo[ext={fmt}]+bestaudio/bestvideo+bestaudio/best"
    else:
        fmt_selector = (
            f"bestvideo[height<={height}][ext={fmt}]+bestaudio"
            f"/bestvideo[height<={height}]+bestaudio"
            f"/best[height<={height}]"
            f"/best"
        )

    opts = get_youtube_base_opts()
    opts.update({
        "format":               fmt_selector,
        "outtmpl":              str(DOWNLOADS_DIR / "%(title)s.%(ext)s"),
        "merge_output_format":  fmt,
        "postprocessors":       [{"key": "FFmpegMetadata", "add_metadata": True}],
        "progress_hooks":       [_make_progress_hook(job_id)],
        "postprocessor_hooks":  [_safe_title_hook(job_id)],
        "quiet":                True,
        "no_warnings":          True,
        "ignoreerrors":         False,
        "noplaylist":           True,
        # ── Windows filename safety ──────────────────────────────────────────
        "windowsfilenames":     True,
        "retries":              10,
        "file_access_retries":  10,
    })
    return opts


# ---------------------------------------------------------------------------
# Worker thread
# ---------------------------------------------------------------------------

def _worker(job_id: str, url: str, ydl_opts: dict):
    try:
        import yt_dlp
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            # Grab title from info if hook didn't catch it
            with _lock:
                job = _jobs.get(job_id)
                if job and not job["title"] and info:
                    job["title"] = info.get("title", "")

        with _lock:
            job = _jobs.get(job_id)
            if job:
                job["status"]      = "done"
                job["percent"]     = 100.0
                job["finished_at"] = time.time()

    except Exception as exc:
        with _lock:
            job = _jobs.get(job_id)
            if job:
                job["status"]      = "error"
                job["error"]       = str(exc)
                job["finished_at"] = time.time()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def cancel_download(job_id: str) -> bool:
    with _lock:
        job = _jobs.get(job_id)
        if job and job["status"] in ("queued", "downloading", "processing"):
            job["cancel_flag"] = True
            job["status"] = "cancelled"
            job["finished_at"] = time.time()
            return True
    return False

def start_download(url: str, opts: dict) -> str:
    """
    Start a download in a background thread.
    Returns job_id immediately.

    opts keys (all optional with defaults):
        media_type : "audio" | "video"  (default "audio")
        format     : audio format or video container
        quality    : kbps for audio | pixel height for video (or "best")
        category   : free-text tag
    """
    job_id     = _new_job(url, opts)
    media_type = opts.get("media_type", "audio")
    fmt        = opts.get("format", "mp3").lower()
    quality    = str(opts.get("quality", "192"))

    if media_type == "video":
        fmt      = fmt if fmt in VIDEO_FORMATS else "mp4"
        height   = quality if quality in VIDEO_HEIGHTS else "720"
        ydl_opts = _build_video_opts(job_id, fmt, height)
    else:
        fmt      = fmt if fmt in AUDIO_FORMATS else "mp3"
        quality  = quality if quality in AUDIO_QUALITIES else "192"
        ydl_opts = _build_audio_opts(job_id, fmt, quality)

    thread = threading.Thread(
        target=_worker, args=(job_id, url, ydl_opts), daemon=True
    )
    thread.start()
    return job_id


def validate_options(media_type: str, fmt: str, quality: str) -> str | None:
    """
    Returns an error message string if invalid, else None.
    """
    if media_type not in {"audio", "video"}:
        return "media_type must be 'audio' or 'video'."
    if media_type == "audio":
        if fmt not in AUDIO_FORMATS:
            return f"Unsupported audio format '{fmt}'. Choose: {', '.join(sorted(AUDIO_FORMATS))}."
        if quality not in AUDIO_QUALITIES:
            return f"Unsupported quality '{quality}'. Choose: {', '.join(sorted(AUDIO_QUALITIES, key=int))} kbps."
    else:
        if fmt not in VIDEO_FORMATS:
            return f"Unsupported video format '{fmt}'. Choose: {', '.join(sorted(VIDEO_FORMATS))}."
        if quality not in VIDEO_HEIGHTS:
            return f"Unsupported video quality '{quality}'. Choose: {', '.join(sorted(VIDEO_HEIGHTS, key=lambda x: 0 if x=='best' else int(x)))}."
    return None


# ---------------------------------------------------------------------------
# YouTube Search with pagination cache
# ---------------------------------------------------------------------------

_search_cache: dict = {}   # query_lower -> {"results": [...], "_time": float}
_search_cache_lock = threading.Lock()
_SEARCH_CACHE_TTL = 300    # 5 minutes in memory

_search_ydl = None
_search_ydl_lock = threading.Lock()


def _get_search_ydl():
    global _search_ydl
    with _search_ydl_lock:
        if _search_ydl is None:
            import yt_dlp
            ydl_opts = get_youtube_base_opts()
            ydl_opts.update({
                "extract_flat": True,
                "skip_download": True,
                "quiet": True,
                "no_warnings": True,
                "socket_timeout": 5,
            })
            _search_ydl = yt_dlp.YoutubeDL(ydl_opts)
        return _search_ydl


def search_youtube(query: str, limit: int = 12, offset: int = 0) -> list[dict]:
    """
    Perform an ultra-fast non-downloading search on YouTube with multi-tier caching:
    - Tier 1: In-memory RAM cache (<1ms)
    - Tier 2: Persistent SQLite search_cache (<5ms)
    - Tier 3: Warm persistent yt-dlp session with bounded socket timeout
    Supports offset-based pagination with result caching.
    """
    if not query or not query.strip():
        return []

    cache_key = query.strip().lower()
    total_needed = offset + limit

    # 1. Try Tier 1: In-memory RAM cache
    with _search_cache_lock:
        cached = _search_cache.get(cache_key)
        if cached and time.time() - cached["_time"] < _SEARCH_CACHE_TTL:
            if total_needed <= len(cached["results"]):
                return cached["results"][offset:total_needed]

    # 2. Try Tier 2: Persistent SQLite cache
    db_cached = db.get_search_cache(cache_key, max_age_seconds=86400.0)
    if db_cached and len(db_cached) >= total_needed:
        with _search_cache_lock:
            _search_cache[cache_key] = {"results": db_cached, "_time": time.time()}
        return db_cached[offset:total_needed]

    # 3. Tier 3: Fetch from YouTube via warm yt-dlp session
    try:
        ydl = _get_search_ydl()
        fetch_count = max(total_needed, 20)  # Prefetch slightly more to power pagination
        info = ydl.extract_info(f"ytsearch{fetch_count}:{query.strip()}", download=False)
        entries = info.get("entries") or []
        results = []
        for e in entries:
            if not e:
                continue
            vid_id = e.get("id") or ""
            url = e.get("url") or (f"https://www.youtube.com/watch?v={vid_id}" if vid_id else "")
            thumbnails = e.get("thumbnails") or []
            thumb_url = e.get("thumbnail") or (thumbnails[-1].get("url") if thumbnails else "")

            dur_sec = e.get("duration") or 0
            dur_str = e.get("duration_string") or (
                f"{int(dur_sec // 60)}:{int(dur_sec % 60):02d}" if dur_sec else ""
            )

            results.append({
                "id": vid_id,
                "url": url,
                "title": e.get("title") or "Unknown Track",
                "artist": e.get("uploader") or e.get("channel") or "YouTube",
                "duration": dur_sec,
                "duration_string": dur_str,
                "thumbnail": thumb_url,
                "view_count": e.get("view_count") or 0,
            })

        # Save to both Tier 1 and Tier 2 caches
        if results:
            with _search_cache_lock:
                _search_cache[cache_key] = {"results": results, "_time": time.time()}
            db.set_search_cache(cache_key, results)

        return results[offset:total_needed]
    except Exception as err:
        print(f"[Downloader] YouTube search error: {err}")
        return []


# ---------------------------------------------------------------------------
# YouTube Audio Stream URL Extraction (for in-browser playback)
# ---------------------------------------------------------------------------

_stream_cache: dict = {}   # video_id -> {url, title, ..., _cached_at}
_stream_cache_lock = threading.Lock()
_STREAM_CACHE_TTL = 300    # 5 minutes (YouTube CDN URLs live ~6 hours)


def get_cached_audio_file(video_id: str) -> tuple[Path, str] | None:
    """
    Checks if an audio stream for video_id is already cached on disk and valid (>50KB).
    Returns (Path, mime_type) if found, otherwise None.
    """
    if not video_id:
        return None
    clean_id = video_id.replace("yt:", "").strip()
    if not STREAM_CACHE_DIR.exists():
        return None

    for p in STREAM_CACHE_DIR.glob(f"{clean_id}.*"):
        if p.name.endswith(".part") or p.name.endswith(".json"):
            continue
        if p.is_file() and p.stat().st_size > 50000:
            meta_path = STREAM_CACHE_DIR / f"{clean_id}.json"
            mime_type = "audio/mp4"
            if meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as mf:
                        data = json.load(mf)
                        mime_type = data.get("mime_type", mime_type)
                except Exception:
                    pass
            else:
                ext = p.suffix.lstrip(".").lower()
                mime_map = {
                    "m4a": "audio/mp4",
                    "mp4": "audio/mp4",
                    "webm": "audio/webm",
                    "ogg": "audio/ogg",
                    "opus": "audio/ogg",
                }
                mime_type = mime_map.get(ext, "audio/mp4")
            return p, mime_type
    return None


def _cleanup_stream_cache(max_size_mb: int = 500):
    """Prunes stream_cache directory if total size exceeds max_size_mb (LRU based on mtime)."""
    try:
        if not STREAM_CACHE_DIR.exists():
            return
        files = [p for p in STREAM_CACHE_DIR.iterdir() if p.is_file() and not p.name.endswith(".part")]
        total_bytes = sum(p.stat().st_size for p in files)
        max_bytes = max_size_mb * 1024 * 1024
        if total_bytes > max_bytes:
            files.sort(key=lambda p: p.stat().st_mtime)
            for f in files:
                if total_bytes <= max_bytes * 0.8:
                    break
                try:
                    sz = f.stat().st_size
                    base = f.stem
                    companion = STREAM_CACHE_DIR / f"{base}.json"
                    if companion.exists() and f != companion:
                        companion.unlink(missing_ok=True)
                    f.unlink(missing_ok=True)
                    total_bytes -= sz
                except Exception:
                    pass
    except Exception:
        pass


_stream_download_lock = threading.Lock()
_active_stream_downloads: dict[str, threading.Event] = {}


def cache_stream_audio(video_id: str, background: bool = True) -> Path | None:
    """
    Downloads and caches the YouTube audio stream locally at full network speed.
    Prevents Googlevideo connection resets (WinError 10054) and enables instant seeking / replay.
    If background=True, runs asynchronously in a daemon thread.
    Returns Path to cached file if already cached or downloaded, else None.
    """
    if not video_id:
        return None
    clean_id = video_id.replace("yt:", "").strip()

    cached = get_cached_audio_file(clean_id)
    if cached:
        return cached[0]

    with _stream_download_lock:
        if clean_id in _active_stream_downloads:
            event = _active_stream_downloads[clean_id]
            if background:
                return None
            event.wait(timeout=25)
            c = get_cached_audio_file(clean_id)
            return c[0] if c else None

        done_event = threading.Event()
        _active_stream_downloads[clean_id] = done_event

    def _worker():
        part_file = None
        try:
            STREAM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            stream_info = extract_stream_url(clean_id)
            if not stream_info or not stream_info.get("url"):
                return

            ext = stream_info.get("ext", "m4a")
            target_file = STREAM_CACHE_DIR / f"{clean_id}.{ext}"
            part_file = STREAM_CACHE_DIR / f"{clean_id}.{ext}.part"
            meta_file = STREAM_CACHE_DIR / f"{clean_id}.json"

            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            }
            if stream_info.get("http_headers"):
                headers.update(stream_info["http_headers"])

            import requests as req
            resp = req.get(stream_info["url"], headers=headers, stream=True, timeout=15)
            if resp.status_code not in (200, 206):
                resp.close()
                return

            with open(part_file, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
            resp.close()

            if part_file.exists() and part_file.stat().st_size > 50000:
                meta = {
                    "mime_type": stream_info.get("mime_type", "audio/mp4"),
                    "ext": ext,
                    "title": stream_info.get("title", ""),
                    "artist": stream_info.get("artist", ""),
                    "duration": stream_info.get("duration", 0),
                    "cached_at": time.time(),
                }
                with open(meta_file, "w", encoding="utf-8") as mf:
                    json.dump(meta, mf)
                part_file.replace(target_file)
                _cleanup_stream_cache()
        except Exception:
            try:
                if part_file and part_file.exists():
                    part_file.unlink(missing_ok=True)
            except Exception:
                pass
        finally:
            with _stream_download_lock:
                _active_stream_downloads.pop(clean_id, None)
            done_event.set()

    if background:
        threading.Thread(target=_worker, daemon=True).start()
        return None
    else:
        _worker()
        c = get_cached_audio_file(clean_id)
        return c[0] if c else None


def prewarm_stream_url(video_id: str):
    """
    Asynchronously extracts and caches the direct audio stream in the background.
    Called lookahead while the previous song is still playing so track-to-track transition is 0ms.
    """
    if not video_id:
        return
    clean_vid = video_id.replace("yt:", "").strip()
    cache_stream_audio(clean_vid, background=True)


def extract_stream_url(video_id: str, force_refresh: bool = False) -> dict | None:
    """
    Extract the best-quality direct audio stream URL for a YouTube video.
    Results are cached for 5 minutes to avoid repeated extraction.
    Uses resilient multi-strategy fallbacks to bypass YouTube bot detection challenges.
    Returns dict with url, http_headers, mime_type, title, artist, thumbnail, duration.
    """
    if not video_id or not video_id.strip():
        return None

    clean_id = video_id.replace("yt:", "").strip()

    # 1. Check cache
    if not force_refresh:
        with _stream_cache_lock:
            cached = _stream_cache.get(clean_id)
            if cached and time.time() - cached.get("_cached_at", 0) < _STREAM_CACHE_TTL:
                return cached

    url = f"https://www.youtube.com/watch?v={clean_id}"

    # Multi-pass strategies to bypass bot checks:
    # Pass 1: Primary options (player_client: android/ios/web, EJS, cookies if present)
    # Pass 2: Android mobile client fallback (bypasses web challenge)
    # Pass 3: Firefox browser session cookies if present
    strategies = [
        # Strategy 1: Standard base options with resilient audio format selector
        lambda: {
            **get_youtube_base_opts(),
            "format": "bestaudio[ext=m4a]/bestaudio/best[acodec!=none]/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
        },
        # Strategy 2: Android client fallback with direct stream format
        lambda: {
            "js_runtimes": {"node": {}},
            "remote_components": ["ejs:github"],
            "extractor_args": {"youtube": {"player_client": ["android", "ios"]}},
            "format": "best[acodec!=none]/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
        },
        # Strategy 3: Try Firefox browser cookies if installed
        lambda: {
            "cookiesfrombrowser": ("firefox",),
            "js_runtimes": {"node": {}},
            "remote_components": ["ejs:github"],
            "format": "bestaudio/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
        },
    ]

    import yt_dlp
    last_err = None

    for strat in strategies:
        try:
            ydl_opts = strat()
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    continue

                stream_url = info.get("url")
                http_headers = info.get("http_headers") or {}
                if not stream_url:
                    formats = info.get("formats") or []
                    playable = [f for f in formats if f.get("url") and f.get("acodec") != "none"]
                    if playable:
                        stream_url = playable[-1]["url"]
                        http_headers = playable[-1].get("http_headers") or http_headers

                if not stream_url:
                    continue

                ext = info.get("ext", "mp4")
                mime_map = {
                    "m4a": "audio/mp4",
                    "mp4": "audio/mp4",
                    "webm": "audio/webm",
                    "ogg": "audio/ogg",
                    "opus": "audio/ogg",
                }
                mime_type = mime_map.get(ext, "audio/mp4")

                result = {
                    "url": stream_url,
                    "http_headers": http_headers,
                    "mime_type": mime_type,
                    "ext": ext,
                    "title": info.get("title", "Unknown"),
                    "artist": info.get("uploader") or info.get("channel") or "YouTube",
                    "thumbnail": info.get("thumbnail", ""),
                    "duration": info.get("duration") or 0,
                    "_cached_at": time.time(),
                }

                with _stream_cache_lock:
                    _stream_cache[clean_id] = result

                return result
        except Exception as exc:
            last_err = exc
            continue

    print(f"[Downloader] Failed to extract audio stream for {clean_id}: {last_err}")
    return None


def extract_video_stream_url(video_id: str, force_refresh: bool = False) -> dict | None:
    """
    Extract the best combined video+audio stream URL for browser playback.
    Prefers mp4 container for widest browser compatibility.
    Cached for 5 minutes.
    """
    if not video_id or not video_id.strip():
        return None

    clean_id = video_id.replace("yt:", "").strip()
    cache_key = f"video:{clean_id}"

    if not force_refresh:
        with _stream_cache_lock:
            cached = _stream_cache.get(cache_key)
            if cached and time.time() - cached.get("_cached_at", 0) < _STREAM_CACHE_TTL:
                return cached

    url = f"https://www.youtube.com/watch?v={clean_id}"

    strategies = [
        lambda: {
            **get_youtube_base_opts(),
            "format": "best[ext=mp4][height<=1080]/best[ext=mp4]/best[height<=1080]/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
        },
        lambda: {
            "js_runtimes": {"node": {}},
            "remote_components": ["ejs:github"],
            "extractor_args": {"youtube": {"player_client": ["android", "ios"]}},
            "format": "best[ext=mp4]/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
        },
        lambda: {
            "cookiesfrombrowser": ("firefox",),
            "js_runtimes": {"node": {}},
            "remote_components": ["ejs:github"],
            "format": "best[ext=mp4]/best",
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
        },
    ]

    import yt_dlp
    last_err = None

    for strat in strategies:
        try:
            ydl_opts = strat()
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    continue

                stream_url = info.get("url")
                if not stream_url:
                    formats = info.get("formats") or []
                    playable = [f for f in formats if f.get("url") and f.get("vcodec") != "none"]
                    if playable:
                        stream_url = playable[-1]["url"]

                if not stream_url:
                    continue

                ext = info.get("ext", "mp4")
                height = info.get("height") or 0
                mime_map = {
                    "mp4": "video/mp4",
                    "webm": "video/webm",
                    "mkv": "video/x-matroska",
                }
                mime_type = mime_map.get(ext, "video/mp4")

                result = {
                    "url": stream_url,
                    "mime_type": mime_type,
                    "ext": ext,
                    "height": height,
                    "title": info.get("title", "Unknown"),
                    "artist": info.get("uploader") or info.get("channel") or "YouTube",
                    "thumbnail": info.get("thumbnail", ""),
                    "duration": info.get("duration") or 0,
                    "_cached_at": time.time(),
                }

                with _stream_cache_lock:
                    _stream_cache[cache_key] = result

                return result
        except Exception as exc:
            last_err = exc
            continue

    print(f"[Downloader] Failed to extract video stream for {clean_id}: {last_err}")
    return None


def extract_playlist_info(url: str, limit: int = 150) -> dict | None:
    """
    Extracts metadata for all tracks in a YouTube playlist without downloading audio.
    Supports YouTube, YouTube Music, and watch URLs with list parameters.
    """
    import yt_dlp
    from recommendation_engine import parse_artist_and_title

    clean_url = (url or "").strip()
    if not clean_url:
        return None

    opts = get_youtube_base_opts()
    opts.update({
        "extract_flat": True,
        "skip_download": True,
        "quiet": True,
        "playlist_items": f"1-{limit}",
        "socket_timeout": 15,
    })

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(clean_url, download=False)
            if not info:
                return None
            entries = info.get("entries") or []
            playlist_title = info.get("title") or "Imported YouTube Playlist"
            uploader = info.get("uploader") or info.get("channel") or "YouTube"

            tracks = []
            seen_ids = set()
            for e in entries:
                if not e:
                    continue
                vid = e.get("id")
                if not vid or vid in seen_ids:
                    continue
                seen_ids.add(vid)

                raw_title = e.get("title") or "Unknown Track"
                raw_uploader = e.get("uploader") or e.get("channel") or uploader
                clean_title, clean_artist, genre = parse_artist_and_title(raw_title, raw_uploader)

                thumb = e.get("thumbnail")
                if not thumb:
                    thumbs = e.get("thumbnails") or []
                    if thumbs:
                        thumb = thumbs[-1].get("url")
                if not thumb:
                    thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"

                duration = float(e.get("duration") or 0.0)

                tracks.append({
                    "id": f"yt:{vid}",
                    "video_id": vid,
                    "title": clean_title or raw_title,
                    "artist": clean_artist or raw_uploader or "YouTube",
                    "album": playlist_title,
                    "duration": duration,
                    "artwork_url": thumb,
                    "has_artwork": True,
                    "is_online": True,
                    "genre": genre or "YouTube",
                    "url": f"/api/youtube/stream/{vid}"
                })

            return {
                "title": playlist_title,
                "uploader": uploader,
                "count": len(tracks),
                "thumbnail": tracks[0]["artwork_url"] if tracks else "",
                "tracks": tracks
            }
    except Exception as exc:
        print(f"[Downloader] Playlist extraction error for {clean_url}: {exc}")
        return None


