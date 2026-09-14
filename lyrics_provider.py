"""
lyrics_provider.py — Linus Universal Multi-Tier Lyrics Engine (v4)
Fetches synchronized (.lrc) and plain lyrics from multiple global providers:
  1. Local Media Directory (.lrc adjacent to audio file)
  2. Persistent Disk Cache (lyrics_cache/*.lrc and *.txt)
  3. LRCLIB API (High-precision synchronized & plain lyrics)
  4. NetEase Cloud Music API (Massive synchronized library for International, Bollywood, Punjabi, Asian & Anime music)
  5. lyrics.ovh API (Clean plain-text lyrics fallback)
Includes multi-provider search candidate aggregation for manual UI lyric picking and persistent custom caching.
"""

import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Directories & Caching
ROOT_DIR = Path(__file__).resolve().parent
LYRICS_CACHE_DIR = ROOT_DIR / "lyrics_cache"
LYRICS_CACHE_DIR.mkdir(exist_ok=True)

_memory_cache: dict[str, dict] = {}
CACHE_TTL_SECONDS = 3600 * 24 * 30  # 30 days

LABEL_CHANNELS = {
    't-series', 'tseries', 'zee music company', 'sony music india', 'sonymusicindiavevo',
    'yrf', 'saregama music', 'saregama', 'tips official', 'tips music', 'speed records',
    'white hill music', 'aditya music', 'lahari music', 'eros now music', 'times music',
    'desi music factory', 'vyrl originals', 'universal music india', 'vibe music', '7clouds',
    'taj tracks', 'lofi fruits music', 'hollywoodrecordsvevo', 'vevo', 'warner music india',
    'geetha arts', 't-series apna punjab', 'jjust music', 'drj records', 'single track studios',
    'queen official', 't-series bhakti sagar', 'sonymusic', 'warnermusic', 'universalmusic',
    'geffen', 'def jam', 'atlantic records', 'columbia records', 'interscope'
}


def _is_label_channel(artist: str) -> bool:
    c = (artist or "").lower().strip()
    if not c or c in ('local collection', 'youtube', 'unknown', 'various artists', 'various', 'artist'):
        return True
    if c in LABEL_CHANNELS:
        return True
    return any(k in c for k in (
        'music company', 'records', 'vevo', 'channel', 'official', 'series',
        'films', 'studios', 'music india', 'music label', 'entertainment'
    ))


def _clean_track_title(title: str) -> str:
    """Strip noisy metadata strings added by YouTube, uploaders, filenames, track numbers, and record labels."""
    if not title:
        return ""
    t = title.replace('_', ' ').strip()
    # Strip leading track numbers like '01 - ', '02. ', '03 ', '04_', '12 - '
    t = re.sub(r'^\d{1,3}\s*[-–—._\s]\s*', '', t)
    # Strip bitrate / file quality tags
    t = re.sub(
        r'\b(128kbps|192kbps|256kbps|320kbps|320\s*kbps|flac|mp3|m4a|wav|aac|cd\s*rip|web-dl|dvdrip|kbps|lossless|24bit|16bit)\b',
        '',
        t,
        flags=re.IGNORECASE
    )
    # Strip bracketed descriptors (official, video, hd, 4k, audio, etc.)
    t = re.sub(
        r'[\(\[\{].*?(?:official|video|lyrics|audio|lyric|hd|4k|remix|full|medley|ringtone|song|visualizer|feat|ft|lyrical|hindi|tamil|telugu|punjabi|version|slowed|reverb|teaser|promo|trailer|remastered|ost).*?[\)\]\}]',
        '',
        t,
        flags=re.IGNORECASE
    )
    # Strip common standalone noise phrases
    t = re.sub(
        r'\b(full song|full video|lyrical video|official audio|official video|official lyrical video|video song|audio song|with lyrics|original track|slowed reverb|slowed and reverb|slowed \+ reverb|status video|fullscreen status|4k 60fps|remastered \d{4})\b',
        '',
        t,
        flags=re.IGNORECASE
    )
    # Strip ft. / feat.
    t = re.sub(r'\b(ft\.?|feat\.?|featuring)\b.*', '', t, flags=re.IGNORECASE)
    # Strip multi delimiters
    t = re.sub(r'[\s\-_\/\|]{2,}', ' ', t)
    return t.strip() or title.strip()


def _get_cache_filename(artist: str, title: str, file_path: str = "") -> Path:
    """Generate deterministic file path in disk cache."""
    key = f"{artist.lower().strip()}_{title.lower().strip()}_{file_path.strip()}"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
    safe_name = re.sub(r'[^a-zA-Z0-9_\-]', '_', f"{artist}_{title}")[:40].strip('_')
    return LYRICS_CACHE_DIR / f"{safe_name}_{digest}"


def _parse_lrc(lrc_text: str) -> list[dict]:
    """
    Parses standard LRC format: '[mm:ss.xx] Lyric line'
    Returns sorted list of dicts: [{'time': float_seconds, 'text': str}, ...]
    """
    lines = []
    pattern = re.compile(r'\[(\d{1,3}):(\d{2}(?:\.\d+)?)\](.*)')
    for raw_line in (lrc_text or "").splitlines():
        match = pattern.match(raw_line.strip())
        if match:
            minutes = int(match.group(1))
            seconds = float(match.group(2))
            text = match.group(3).strip()
            total_seconds = round(minutes * 60 + seconds, 2)
            lines.append({"time": total_seconds, "text": text})

    return sorted(lines, key=lambda x: x["time"])


def _extract_query_candidates(artist: str, title: str) -> list[dict]:
    """
    Generates an ordered list of search candidate dicts:
    [{'artist': '...', 'title': '...', 'query': '...'}, ...]
    """
    candidates = []
    raw_title = title or ""
    raw_artist = artist or ""
    is_label = _is_label_channel(raw_artist)

    # 1. Pipe split (Bollywood & Asian format: Song | Movie | Singer)
    pipe_parts = [p.strip() for p in re.split(r'\s*\|\s*', raw_title) if p.strip()]
    if len(pipe_parts) >= 2:
        first_seg = pipe_parts[0]
        cleaned_first = _clean_track_title(first_seg)
        if ':' in first_seg:
            c_artist, c_title = first_seg.split(':', 1)
            ca = _clean_track_title(c_artist)
            ct = _clean_track_title(c_title)
            if ct:
                candidates.append({'artist': ca, 'title': ct, 'query': f"{ca} {ct}".strip()})
                candidates.append({'artist': '', 'title': ct, 'query': ct})
        elif re.search(r'\s+[-–—]\s+', first_seg):
            sub_parts = re.split(r'\s+[-–—]\s+', first_seg, maxsplit=1)
            st0 = _clean_track_title(sub_parts[0])
            st1 = _clean_track_title(sub_parts[1])
            candidates.append({'artist': '', 'title': st0, 'query': f"{st0} {st1}".strip()})
            candidates.append({'artist': '', 'title': st0, 'query': st0})
        else:
            if cleaned_first:
                candidates.append({'artist': '', 'title': cleaned_first, 'query': cleaned_first})
                second_seg = _clean_track_title(pipe_parts[1])
                if second_seg:
                    candidates.append({'artist': '', 'title': cleaned_first, 'query': f"{cleaned_first} {second_seg}"})

    # 2. Dash / Hyphen split (Artist - Title or Title - Artist)
    dash_parts = [p.strip() for p in re.split(r'\s+[-–—]\s+', raw_title) if p.strip()]
    if len(dash_parts) == 2:
        d0 = _clean_track_title(dash_parts[0])
        d1 = _clean_track_title(dash_parts[1])
        if d0 and d1:
            candidates.append({'artist': d0, 'title': d1, 'query': f"{d0} {d1}"})
            candidates.append({'artist': d1, 'title': d0, 'query': f"{d1} {d0}"})
            candidates.append({'artist': '', 'title': d1, 'query': d1})
            candidates.append({'artist': '', 'title': d0, 'query': d0})

    # 3. Cleaned title with given artist
    cleaned_all = _clean_track_title(raw_title)
    if not is_label and raw_artist:
        candidates.append({'artist': raw_artist, 'title': cleaned_all, 'query': f"{raw_artist} {cleaned_all}".strip()})

    # 4. Cleaned title alone
    if cleaned_all:
        candidates.append({'artist': '', 'title': cleaned_all, 'query': cleaned_all})

    # 5. Raw title alone as last resort
    if raw_title and raw_title != cleaned_all:
        candidates.append({'artist': '', 'title': raw_title, 'query': raw_title})

    seen = set()
    unique = []
    for c in candidates:
        q_key = (c['query'] or '').lower().strip()
        if q_key and q_key not in seen:
            seen.add(q_key)
            unique.append(c)

    return unique


# ---------------------------------------------------------------------------
# Provider 1: LRCLIB (Direct & Search)
# ---------------------------------------------------------------------------

def _try_lrclib_direct(artist: str, title: str, timeout: int = 4) -> dict | None:
    if not title:
        return None
    try:
        params = {"track_name": title}
        if artist and not _is_label_channel(artist):
            params["artist_name"] = artist
        url = f"https://lrclib.net/api/get?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Linus/2.0 (Personal Music Player)"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
            synced = data.get("syncedLyrics")
            plain = data.get("plainLyrics")
            if synced:
                lines = _parse_lrc(synced)
                return {
                    "found": True,
                    "synced": True,
                    "lines": lines,
                    "plain": plain or "\n".join(l["text"] for l in lines),
                    "source": "lrclib",
                    "raw_lrc": synced
                }
            elif plain:
                return {
                    "found": True,
                    "synced": False,
                    "lines": [],
                    "plain": plain.strip(),
                    "source": "lrclib",
                    "raw_lrc": ""
                }
    except Exception:
        pass
    return None


def _try_lrclib_search(query: str, timeout: int = 4) -> dict | None:
    if not query:
        return None
    try:
        url = f"https://lrclib.net/api/search?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={"User-Agent": "Linus/2.0 (Personal Music Player)"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            results = json.loads(response.read().decode("utf-8"))
            if isinstance(results, list) and len(results) > 0:
                best = next((r for r in results if r.get("syncedLyrics")), results[0])
                synced = best.get("syncedLyrics")
                plain = best.get("plainLyrics")
                if synced:
                    lines = _parse_lrc(synced)
                    return {
                        "found": True,
                        "synced": True,
                        "lines": lines,
                        "plain": plain or "\n".join(l["text"] for l in lines),
                        "source": "lrclib",
                        "raw_lrc": synced
                    }
                elif plain:
                    return {
                        "found": True,
                        "synced": False,
                        "lines": [],
                        "plain": plain.strip(),
                        "source": "lrclib",
                        "raw_lrc": ""
                    }
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Provider 2: NetEase Cloud Music (Synchronized LRC)
# ---------------------------------------------------------------------------

def _try_netease_search(query: str, timeout: int = 4) -> dict | None:
    """Searches NetEase Cloud Music and fetches synchronized LRC lyrics."""
    if not query or len(query) < 2:
        return None
    try:
        search_url = f"https://music.163.com/api/cloudsearch/pc?s={urllib.parse.quote(query)}&type=1&offset=0&limit=3"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Referer": "https://music.163.com"
        }
        req = urllib.request.Request(search_url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8", errors="ignore"))
            songs = data.get("result", {}).get("songs", [])
            if not songs:
                return None

            song = songs[0]
            song_id = song.get("id")
            if not song_id:
                return None

            lyric_url = f"https://music.163.com/api/song/lyric?os=pc&id={song_id}&lv=-1&kv=-1&tv=-1"
            req_l = urllib.request.Request(lyric_url, headers=headers)
            with urllib.request.urlopen(req_l, timeout=timeout) as l_resp:
                ldata = json.loads(l_resp.read().decode("utf-8", errors="ignore"))
                raw_lrc = ldata.get("lrc", {}).get("lyric", "")
                if raw_lrc and "[" in raw_lrc and "]" in raw_lrc:
                    lines = _parse_lrc(raw_lrc)
                    valid_lines = [l for l in lines if l["text"] and not l["text"].startswith("by:")]
                    if valid_lines:
                        return {
                            "found": True,
                            "synced": True,
                            "lines": valid_lines,
                            "plain": "\n".join(l["text"] for l in valid_lines if l["text"]),
                            "source": "netease",
                            "raw_lrc": raw_lrc
                        }
                elif raw_lrc and len(raw_lrc.strip()) > 20:
                    return {
                        "found": True,
                        "synced": False,
                        "lines": [],
                        "plain": raw_lrc.strip(),
                        "source": "netease",
                        "raw_lrc": ""
                    }
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Provider 3: lyrics.ovh (Plain text fallback)
# ---------------------------------------------------------------------------

def _try_lyrics_ovh(artist: str, title: str, timeout: int = 4) -> str:
    if not artist or not title or _is_label_channel(artist):
        return ""
    try:
        encoded_artist = urllib.parse.quote(artist, safe="")
        encoded_title = urllib.parse.quote(title, safe="")
        url = f"https://api.lyrics.ovh/v1/{encoded_artist}/{encoded_title}"
        req = urllib.request.Request(url, headers={"User-Agent": "Linus/2.0"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data.get("lyrics", "").strip()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Disk Caching & Custom Lyrics Helpers
# ---------------------------------------------------------------------------

def _save_to_disk_cache(cache_prefix: Path, result: dict):
    """Persists fetched lyrics into lyrics_cache directory."""
    try:
        if result.get("synced") and result.get("raw_lrc"):
            lrc_file = cache_prefix.with_suffix(".lrc")
            lrc_file.write_text(result["raw_lrc"], encoding="utf-8")
        elif result.get("plain"):
            txt_file = cache_prefix.with_suffix(".txt")
            txt_file.write_text(result["plain"], encoding="utf-8")
    except Exception:
        pass


def _read_from_disk_cache(cache_prefix: Path) -> dict | None:
    """Reads previously cached .lrc or .txt file from disk."""
    try:
        lrc_file = cache_prefix.with_suffix(".lrc")
        if lrc_file.exists():
            content = lrc_file.read_text(encoding="utf-8", errors="ignore")
            lines = _parse_lrc(content)
            if lines:
                return {
                    "found": True,
                    "synced": True,
                    "lines": lines,
                    "plain": "\n".join(l["text"] for l in lines if l["text"]),
                    "source": "local_cache",
                    "raw_lrc": content,
                    "fetched_at": time.time(),
                }
        txt_file = cache_prefix.with_suffix(".txt")
        if txt_file.exists():
            content = txt_file.read_text(encoding="utf-8", errors="ignore")
            if content.strip():
                return {
                    "found": True,
                    "synced": False,
                    "lines": [],
                    "plain": content.strip(),
                    "source": "local_cache",
                    "raw_lrc": "",
                    "fetched_at": time.time(),
                }
    except Exception:
        pass
    return None


def save_custom_lyrics(track_id: str, artist: str, title: str, content: str) -> dict:
    """Explicitly save user-edited or custom lyrics to disk cache and memory."""
    content = (content or "").strip()
    cache_prefix = _get_cache_filename(artist, title, track_id)
    
    is_synced = "[" in content and "]" in content
    if is_synced:
        lines = _parse_lrc(content)
        res = {
            "found": True,
            "synced": True,
            "lines": lines,
            "plain": "\n".join(l["text"] for l in lines if l["text"]),
            "source": "custom",
            "raw_lrc": content,
            "fetched_at": time.time(),
        }
        lrc_file = cache_prefix.with_suffix(".lrc")
        lrc_file.write_text(content, encoding="utf-8")
        txt_file = cache_prefix.with_suffix(".txt")
        if txt_file.exists():
            try: txt_file.unlink()
            except Exception: pass
    else:
        res = {
            "found": True,
            "synced": False,
            "lines": [],
            "plain": content,
            "source": "custom",
            "raw_lrc": "",
            "fetched_at": time.time(),
        }
        txt_file = cache_prefix.with_suffix(".txt")
        txt_file.write_text(content, encoding="utf-8")

    cache_key = f"{artist.lower()}___{title.lower()}"
    _memory_cache[cache_key] = res
    return res


# ---------------------------------------------------------------------------
# Public Fetch API
# ---------------------------------------------------------------------------

def fetch_lyrics(artist: str, title: str, file_path: str = "", timeout: int = 4) -> dict:
    """
    Universal API to retrieve synchronized or plain lyrics using multi-tier fallback.
    Returns:
      {
        "found": bool,
        "synced": bool,
        "lines": [{"time": 12.34, "text": "..."}],
        "plain": "...",
        "source": "lrclib" | "netease" | "lyrics.ovh" | "local" | "local_cache" | "custom" | "none"
      }
    """
    artist = (artist or "").strip()
    title = (title or "").strip()
    cleaned_title = _clean_track_title(title)

    cache_key = f"{artist.lower()}___{cleaned_title.lower()}"
    if cache_key in _memory_cache:
        cached = _memory_cache[cache_key]
        if (time.time() - cached.get("fetched_at", 0)) < CACHE_TTL_SECONDS:
            return cached

    # 1. Try local .lrc file in same directory as media file
    if file_path and not file_path.startswith("yt:"):
        local_lrc = Path(file_path).with_suffix(".lrc")
        if local_lrc.exists():
            try:
                content = local_lrc.read_text(encoding="utf-8", errors="ignore")
                parsed = _parse_lrc(content)
                if parsed:
                    res = {
                        "found": True,
                        "synced": True,
                        "lines": parsed,
                        "plain": "\n".join(l["text"] for l in parsed if l["text"]),
                        "source": "local",
                        "raw_lrc": content,
                        "fetched_at": time.time(),
                    }
                    _memory_cache[cache_key] = res
                    return res
            except Exception:
                pass

    # 2. Try disk cache (lyrics_cache/)
    cache_prefix = _get_cache_filename(artist, title, file_path)
    disk_cached = _read_from_disk_cache(cache_prefix)
    if disk_cached:
        _memory_cache[cache_key] = disk_cached
        return disk_cached

    # 3. Extract multi-stage candidates
    candidates = _extract_query_candidates(artist, title)

    # 4. Try LRCLIB (Direct match first)
    for cand in candidates:
        if cand.get('artist') and cand.get('title'):
            res = _try_lrclib_direct(cand['artist'], cand['title'], timeout)
            if res and res.get("found"):
                res["fetched_at"] = time.time()
                _save_to_disk_cache(cache_prefix, res)
                _memory_cache[cache_key] = res
                return res

    # 5. Try LRCLIB Search
    for cand in candidates:
        q = cand.get('query', '').strip()
        if q and len(q) >= 3:
            res = _try_lrclib_search(q, timeout)
            if res and res.get("found"):
                res["fetched_at"] = time.time()
                _save_to_disk_cache(cache_prefix, res)
                _memory_cache[cache_key] = res
                return res

    # 6. Try NetEase Cloud Music (Synced LRC API)
    for cand in candidates:
        q = cand.get('query', '').strip()
        if q and len(q) >= 2:
            res = _try_netease_search(q, timeout)
            if res and res.get("found"):
                res["fetched_at"] = time.time()
                _save_to_disk_cache(cache_prefix, res)
                _memory_cache[cache_key] = res
                return res

    # 7. Fallback to lyrics.ovh (Plain text)
    for cand in candidates:
        if cand.get('artist') and cand.get('title'):
            plain = _try_lyrics_ovh(cand['artist'], cand['title'], timeout)
            if plain:
                res = {
                    "found": True,
                    "synced": False,
                    "lines": [],
                    "plain": plain,
                    "source": "lyrics.ovh",
                    "raw_lrc": "",
                    "fetched_at": time.time(),
                }
                _save_to_disk_cache(cache_prefix, res)
                _memory_cache[cache_key] = res
                return res

    # Not found
    empty_res = {
        "found": False,
        "synced": False,
        "lines": [],
        "plain": "",
        "source": "none",
        "raw_lrc": "",
        "fetched_at": time.time(),
    }
    _memory_cache[cache_key] = empty_res
    return empty_res


# ---------------------------------------------------------------------------
# Multi-Provider Search for Manual UI Selection
# ---------------------------------------------------------------------------

def search_lyrics_candidates(query: str, limit: int = 8) -> list[dict]:
    """
    Searches LRCLIB and NetEase simultaneously for manual user selection.
    Returns a unified list of candidate matches:
    [
      {
        "id": "...",
        "title": "...",
        "artist": "...",
        "album": "...",
        "source": "lrclib" | "netease",
        "synced": bool,
        "preview": "...",
        "raw_lrc": "...",
        "plain": "..."
      }, ...
    ]
    """
    query = (query or "").strip()
    if not query:
        return []

    results = []

    def _search_lrclib():
        lrclib_res = []
        try:
            url = f"https://lrclib.net/api/search?q={urllib.parse.quote(query)}"
            req = urllib.request.Request(url, headers={"User-Agent": "Linus/2.0"})
            with urllib.request.urlopen(req, timeout=4) as response:
                data = json.loads(response.read().decode("utf-8"))
                if isinstance(data, list):
                    for item in data[:limit]:
                        synced = item.get("syncedLyrics")
                        plain = item.get("plainLyrics") or ""
                        preview = ""
                        if synced:
                            parsed = _parse_lrc(synced)
                            preview = " / ".join(l["text"] for l in parsed[:3] if l["text"])
                        elif plain:
                            preview = " / ".join(p.strip() for p in plain.splitlines()[:3] if p.strip())

                        lrclib_res.append({
                            "id": f"lrclib_{item.get('id', '')}",
                            "title": item.get("trackName") or item.get("name") or "Unknown Title",
                            "artist": item.get("artistName") or "Unknown Artist",
                            "album": item.get("albumName") or "",
                            "source": "LRCLIB",
                            "synced": bool(synced),
                            "preview": preview or "Lyrics available",
                            "raw_lrc": synced or "",
                            "plain": plain or (synced or "")
                        })
        except Exception:
            pass
        return lrclib_res

    def _search_netease():
        netease_res = []
        try:
            url = f"https://music.163.com/api/cloudsearch/pc?s={urllib.parse.quote(query)}&type=1&offset=0&limit={limit}"
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Referer": "https://music.163.com"
            }
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=4) as response:
                data = json.loads(response.read().decode("utf-8", errors="ignore"))
                songs = data.get("result", {}).get("songs", [])
                for s in songs:
                    s_id = s.get("id")
                    title = s.get("name") or "Unknown"
                    artist = ", ".join(a.get("name", "") for a in s.get("ar", [])) or "Unknown"
                    album = s.get("al", {}).get("name") or ""
                    
                    lyric_url = f"https://music.163.com/api/song/lyric?os=pc&id={s_id}&lv=-1&kv=-1&tv=-1"
                    req_l = urllib.request.Request(lyric_url, headers=headers)
                    with urllib.request.urlopen(req_l, timeout=3) as l_resp:
                        ldata = json.loads(l_resp.read().decode("utf-8", errors="ignore"))
                        raw_lrc = ldata.get("lrc", {}).get("lyric", "")
                        if raw_lrc:
                            parsed = _parse_lrc(raw_lrc)
                            preview = " / ".join(l["text"] for l in parsed[:3] if l["text"])
                            netease_res.append({
                                "id": f"netease_{s_id}",
                                "title": title,
                                "artist": artist,
                                "album": album,
                                "source": "NetEase",
                                "synced": bool(parsed),
                                "preview": preview or "Synchronized LRC available",
                                "raw_lrc": raw_lrc,
                                "plain": "\n".join(l["text"] for l in parsed if l["text"]) if parsed else raw_lrc
                            })
        except Exception:
            pass
        return netease_res

    with ThreadPoolExecutor(max_workers=2) as executor:
        f_lrclib = executor.submit(_search_lrclib)
        f_netease = executor.submit(_search_netease)
        for f in as_completed([f_lrclib, f_netease]):
            results.extend(f.result())

    # Prioritize synchronized results
    results.sort(key=lambda x: not x["synced"])
    return results[:limit]


