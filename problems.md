# Linus — Problems Found (Code Review)

Scope: `web_app.py`, `downloader.py`, `metadata_store.py`, `lyrics_provider.py`, `main.py`, `static/app.js`, `templates/index.html`, and the project docs (`docs/*.md`) for context on intended behavior.

Linus is a local Flask web app that scans folders for audio/video, plays them in the browser, and can pull new files down from YouTube-style URLs via `yt-dlp`. The docs (`PRODUCT.md`, `ROADMAP.md`) describe a much bigger feature set than what's actually wired up in `static/app.js` / `templates/index.html`. Below is everything that's broken, mismatched, or missing safeguards, from most to least severe.

---

## 1. Breaking bugs (feature doesn't work at all)

### 1.1 "Create Playlist" does nothing
`templates/index.html` has a full Playlists view (`#playlists-view`, `#playlist-list`, `#new-playlist` button), and `linus_state.json` / `state.playlists` already exist to hold the data. But `static/app.js` has **zero** event listener for `#new-playlist` and no `renderPlaylists()` function anywhere. Clicking "Create Playlist" is a dead button, and the Playlists tab is permanently an empty page.

### 1.2 Favorites page is always empty
There's a dedicated `#favorite-list` container in `templates/index.html`, and favoriting a track (the star icon) does correctly push the track id into `state.favorites` and persist it via `saveState()`. But nothing ever renders `state.favorites` into `#favorite-list` — the Favorites tab shows a blank page even after you've starred songs. The only place favorites are visible is the star icon staying lit on the main library rows.

### 1.3 Import Folder always fails
Frontend (`static/app.js` line ~635):
```js
await api('/api/import-folder', { method: 'POST', body: JSON.stringify({ path: p }) });
```
Backend (`web_app.py`):
```python
folder = (request.get_json(silent=True) or {}).get("folder", "").strip()
```
The frontend sends the key `path`, the backend reads the key `folder`. `folder` is always `""`, which always fails the `Path(folder).is_dir()` check, so every import attempt returns `400 Choose an existing folder.` — this feature has never worked, even with a valid path typed in.

### 1.4 Download completion never updates the UI automatically
Two separate bugs compound here:
- **SSE "done" event never fires.** The backend's `/api/download/progress/<job_id>` (`web_app.py`) only ever emits plain, unnamed SSE messages: `yield f"data: {json.dumps(...)}\n\n"`. It never sends a named `event: done` line. The frontend listens with `progressSSE.addEventListener('done', ...)`, which only responds to a named `done` event — so that handler **never runs**, meaning the "Complete!" label, closing the download sheet, and the follow-up library refresh never happen on their own.
- **`data.library` is undefined.** As a fallback, `pollDownloadsStatus()` calls `hydrate(data.library)`, but `/api/download/status/<job_id>` puts the refreshed data directly on the response object (`response["tracks"]`, `response["state"]`, etc.) — there is no `library` key. `hydrate(undefined)` throws, which is swallowed by the catch block and surfaces only as a generic "Finished but failed to refresh library." toast.

Net effect: after a download finishes, the user has to manually click "Rescan" to actually see the new track — the whole point of the progress UI (auto-refresh) doesn't work.

---

## 2. Security / robustness gaps

### 2.1 `import-folder` has no path restriction
`/api/import-folder` accepts any absolute path on the machine and adds it to `library_folders` with no allow-list, no confirmation, and no limit on depth. Once added, `scan_library()` will walk that entire tree and expose every audio/video file under it through `/media/<hex-encoded-path>` — effectively turning any folder on the computer that Linus can read into something servable over HTTP. Since the app also has no authentication, anything that can reach `127.0.0.1:5000` (any other local process, a malicious browser tab, a browser extension) can add folders and pull files.

### 2.2 No authentication or CSRF protection on any endpoint
Every route (`/api/download`, `/api/import-folder`, `/api/state`, `/media/...`) is open to any request that reaches the port. The app currently binds to `127.0.0.1` only, which limits exposure to the local machine, but it's still one bad default (or one WSL/Docker networking quirk, or one `host="0.0.0.0"` change) away from being wide open. There's no CSRF token, so if the JSON `Content-Type` requirement is ever relaxed, cross-site requests from a malicious page could trigger downloads or folder imports without the user's knowledge.

### 2.3 `/api/download` is an unrestricted server-side downloader
`url` is only checked with `re.match(r"^https?://", url)` — any HTTP(S) URL is accepted and handed to `yt_dlp.extract_info(..., download=True)`. There's no domain allow-list, no rate limiting, and no cap on concurrent jobs. Combined with 2.2, this is effectively an open download proxy running on the user's machine.

### 2.4 Inconsistent HTML escaping — stored XSS risk
Most render functions correctly wrap dynamic text in `escapeHtml()`, but a few don't, e.g. in `renderTracks()`:
```js
<button class="track-action fav-btn ..." data-id="${t.id}">
```
`t.id` here is unescaped. `t.id` is derived from the file's resolved path, and filenames are populated automatically from **downloaded video titles** (see `downloader.py`'s `_build_audio_opts` output template `%(title)s.%(ext)s`). A video with a crafted title (e.g., containing a `"` and an `onload=` attribute) could, in principle, break out of the `data-id` attribute. This should be treated as attacker-influenced input and escaped everywhere it's interpolated into HTML, not just in most places.

### 2.5 MySQL calls run synchronously on every library scan
`scan_library()` calls `save_tracks()` (in `metadata_store.py`) on **every** `/api/library` request, `/api/import-folder` request, and after **every** download. Each of those attempts a fresh `pymysql.connect()` with a 2-second timeout. If XAMPP MySQL is stopped (which `MYSQL.md` explicitly says is a supported "local fallback" scenario), every single one of those requests pays up to a ~2 second penalty, serially, inside the request thread — this will make the whole app feel sluggish or hang whenever the DB is off, which per the docs is expected to be a common state.

### 2.6 Default DB credentials are `root` / empty password
`metadata_store.py` defaults to `root` with an empty password against `127.0.0.1:3306`. That matches a stock XAMPP install, but it means `ensure_schema()` will also happily try to `CREATE DATABASE` using root credentials read from environment variables with no validation — fine for a single-user local dev box, worth flagging before this code goes anywhere more shared.

---

## 3. Data / logic inconsistencies

### 3.1 Category auto-assignment on download is fragile
In `web_app.py`'s `/api/download/status/<job_id>`, once a job is done, the code tries to match the job's title to a scanned track title using **substring containment in either direction**:
```python
if track["title"].lower() in job["title"].lower() or job["title"].lower() in track["title"].lower():
```
Because `_safe_title_hook` in `downloader.py` renames files by stripping/replacing punctuation, and `title_artist()` in `web_app.py` further reformats the filename (splitting on `" - "`, replacing underscores), the two title strings can diverge just enough that the match silently fails — or, worse, over-matches to the wrong track if one title is a substring of an unrelated one (e.g., a short generic title like "Intro").

### 3.2 `title_artist()` guesses artist/title from filenames only
`web_app.py`'s `title_artist()` never reads embedded ID3/metadata tags — even though the downloader explicitly writes them (`FFmpegMetadata`, `EmbedThumbnail` in `downloader.py`). All the library ever displays is a filename split on `" - "` with underscores turned into spaces, and defaults to `"Local collection"` as the artist. Embedded artwork is also never read back or shown (`#now-art` always renders a static music-note icon instead of real album art) — the metadata your own downloader writes never gets used.

### 3.3 SSE progress stream has a hard 5-minute cap
`download_progress_sse()` loops a fixed `range(600)` at `0.5s` per iteration (~5 minutes) and then just stops yielding, regardless of job state. A long 4K video download or a slow connection that exceeds 5 minutes will silently stop receiving progress updates mid-download, even though the job itself keeps running in the background thread. The UI has no way to know the stream simply timed out vs. the job actually finishing.

### 3.4 No duplicate-download detection
Nothing checks whether a URL (or the resulting title) has already been downloaded before starting a new job, despite `PRODUCT.md` explicitly listing "duplicate detection" as a required part of the download/import flow. Downloading the same link twice just creates two files and two library entries.

### 3.5 No download cancellation
`ROADMAP.md`/`PRODUCT.md` call for cancellable downloads, but `downloader.py`'s worker thread has no cancellation hook, and there's no `/api/download/cancel/<job_id>` route or matching UI control.

---

## 4. Minor / cleanup items

- The zip ships committed `__pycache__/*.pyc` files and two real, fairly large downloaded media files (`downloads/*.mp3`, `*.mp4`, ~13 MB total) — these look like local test artifacts that shouldn't be part of a distributed package or repo.
- `ffmpeg` is present in the project root as a 0-byte file — it's not a real, working ffmpeg binary, so any `ffmpeg`-dependent postprocessing (`FFmpegExtractAudio`, `FFmpegMetadata`, `EmbedThumbnail`, `merge_output_format`) will fail unless a real ffmpeg is separately available on `PATH`, contradicting what looks like an attempt to bundle it.
- `docs/STATUS.md` and `docs/DECISIONS.md` are dated `2026-08-22` (today), which is either a placeholder that never got filled in with the real decision date, or an auto-generated timestamp — worth double-checking before anyone treats these as a historical decision log.
- `linus_state.json` is a flat, unstructured JSON blob with no versioning/migration story, even though `ARCHITECTURE.md` explicitly anticipates a future schema migration to SQLite — there's currently no `schema_version` field or similar to make that migration safe.
