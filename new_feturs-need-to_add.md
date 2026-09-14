# Linus — Features Needed

This is what's missing relative to what the app's own docs (`docs/PRODUCT.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`) commit to, plus a couple of practical gaps found while reading the code. Grouped by priority. (Bugs in already-built features are covered separately in `problems.md` — this file is about things that don't exist yet.)

---

## Priority 1 — Finish what's already half-built

These have UI scaffolding in `templates/index.html` and/or state fields in `linus_state.json`, but no working logic behind them. Cheapest wins first.

1. **Playlist CRUD**
   - Wire up `#new-playlist` to actually create an entry in `state.playlists`.
   - Add rename, delete, reorder, and "add track to playlist" actions (from the track row context menu / long-press, per `PRODUCT.md`).
   - Add a `renderPlaylists()` function that populates `#playlist-list`, and a playlist detail view for viewing/playing a single playlist's tracks.
   - Guard against duplicate track membership within a playlist.

2. **Favorites page**
   - Render `state.favorites` into `#favorite-list` (the data is already tracked correctly — it just needs to be displayed on its own tab).

3. **Fix Import Folder, then build on it**
   - Once the `path`/`folder` key mismatch is fixed, add a visible list of currently-imported library folders (with a "remove folder" action) in Settings — right now there's no way to see or undo what's been imported.
   - Add folder-picker-style validation feedback (e.g., show the resolved path before committing).

4. **Auto-refresh after downloads**
   - Fix the SSE "done" event and `pollDownloadsStatus` payload key so the UI updates automatically the moment a download finishes, without requiring a manual rescan.

---

## Priority 2 — Explicitly promised in the docs, not started

Straight from `PRODUCT.md`'s feature list and `ROADMAP.md` milestones:

5. **Real metadata reading (not just filename parsing)**
   - Read embedded ID3/MP4 tags (title, artist, album, embedded artwork) on scan instead of guessing from the filename. The downloader already writes these tags (`FFmpegMetadata`, `EmbedThumbnail`) — the scanner should read them back.
   - Show real album art in the now-playing view, library rows, and continue-listening rail, with a generated placeholder (per `docs/DESIGN.md`) when no artwork exists.

6. **Missing-file and unsupported-file reporting**
   - When a scanned folder's file disappears (moved/deleted outside the app), keep the track visible in playlists/favorites but flag it as "missing" rather than silently vanishing from the library.
   - Report files with unsupported extensions found during a scan (e.g., a friendly "N files skipped — unsupported format" summary) instead of silently ignoring them.

7. **Resume position + listening history detail**
   - `state.history` currently only stores track IDs for the "Continue Listening" rail. Add saved playback position per track so resuming a long track/podcast picks up where you left off, as `PRODUCT.md` / `ROADMAP.md` (Milestone 2) call for.

8. **Duplicate-download detection**
   - Before starting a job in `/api/download`, check whether the same URL (or a very similar title) already exists in the library/job history, and warn or offer to skip.

9. **Download cancellation**
   - Add a `/api/download/cancel/<job_id>` endpoint plus a cancel button per in-progress job in the Downloads view. Requires giving the background worker thread a cancellation flag it checks between yt-dlp progress callbacks.

10. **Provider-based lyrics states**
    - Current `/api/lyrics` only returns found/not-found. Docs call for distinct offline, rate-limited, and provider-attribution states, plus a manual "type your own lyrics" fallback that's stored locally (`state.lyrics` already exists for this but isn't hooked up to an editor UI).

11. **Search scope**
    - Search currently only filters the in-memory audio track list already loaded into the page. Confirm it also covers videos, and consider extending it to match against categories/playlists as the library grows.

---

## Priority 3 — Practical additions worth considering (not in the docs, but natural next steps)

12. **Basic auth / access control for the local server**
    - Even for a localhost-only app, a simple shared secret or OS-level check before exposing `/api/import-folder` and `/api/download` would close the "any local process can drive this" gap described in `problems.md` §2.1–2.3.

13. **Restrict `import-folder` to a safer default**
    - At minimum, warn or require confirmation before importing a folder outside the user's home directory, and consider excluding system directories outright.

14. **Domain allow-list (or at least a warning) for downloads**
    - `yt-dlp` supports a huge number of sites; consider a configurable allow-list or at least surfacing which extractor matched before starting a job, so users know what's about to run.

15. **Bundle a real `ffmpeg` or detect its absence up front**
    - The shipped `ffmpeg` file is empty (0 bytes). Either bundle a real static build or detect a missing/broken ffmpeg at startup and show a clear setup instruction instead of letting downloads fail deep inside a postprocessing step.

16. **Packaging cleanup**
    - Add a `.gitignore`/build step that excludes `__pycache__/` and the sample files under `downloads/` from distribution, and document how a fresh checkout should populate `downloads/` (or ship it empty with a `.gitkeep`).

17. **`linus_state.json` schema versioning**
    - Add a `schema_version` field now, before the planned SQLite migration (`docs/ARCHITECTURE.md`), so a future migration script can detect and upgrade older state files safely.
