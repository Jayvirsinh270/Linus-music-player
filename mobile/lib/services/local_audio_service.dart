import 'dart:io';
import 'package:on_audio_query/on_audio_query.dart';
import 'package:permission_handler/permission_handler.dart';
import '../models/track.dart';

enum TrackSortType { title, artist, dateAdded, duration }

class LocalAudioService {
  final OnAudioQuery _audioQuery = OnAudioQuery();
  List<Track> _cachedTracks = [];

  List<Track> get cachedTracks => List.unmodifiable(_cachedTracks);

  // Check and request Android runtime permissions for audio/storage
  Future<bool> requestPermissions() async {
    try {
      // 1. First attempt with on_audio_query internal permission handler
      final hasPermission = await _audioQuery.checkAndRequest(retryRequest: true);
      if (hasPermission) return true;

      // 2. Fallback with permission_handler plugin
      if (Platform.isAndroid) {
        final audioStatus = await Permission.audio.request();
        if (audioStatus.isGranted) return true;

        final storageStatus = await Permission.storage.request();
        if (storageStatus.isGranted) return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  // Query all audio tracks from MediaStore and common storage folders
  Future<List<Track>> loadTracks({TrackSortType sortType = TrackSortType.dateAdded}) async {
    final hasPermission = await requestPermissions();
    if (!hasPermission) {
      _cachedTracks = [];
      return [];
    }

    final tracksMap = <String, Track>{};

    // 1. Query Android MediaStore via on_audio_query
    try {
      final songModels = await _audioQuery.querySongs(
        sortType: null, // We sort in Dart
        orderType: OrderType.ASC_OR_SMALLER,
        uriType: UriType.EXTERNAL,
        ignoreCase: true,
      );

      for (final song in songModels) {
        // Exclude notification sounds and tiny audio clips (< 10 seconds)
        final durationMs = song.duration ?? 0;
        if (durationMs < 10000) continue;

        final filePath = song.data;
        if (filePath.isEmpty) continue;

        String title = (song.title).trim();
        if (title.isEmpty) {
          title = song.displayNameWOExt;
        }

        String artist = (song.artist ?? '').trim();
        if (artist.isEmpty || artist == '<unknown>') {
          artist = 'Unknown Artist';
        }

        String album = (song.album ?? '').trim();
        if (album.isEmpty || album == '<unknown>') {
          album = 'Unknown Album';
        }

        final track = Track(
          id: song.id.toString(),
          title: title,
          artist: artist,
          album: album,
          duration: Duration(milliseconds: durationMs),
          filePath: filePath,
          audioId: song.id,
          dateAdded: song.dateAdded,
        );

        tracksMap[filePath.toLowerCase()] = track;
      }
    } catch (_) {
      // MediaStore query error fallback
    }

    // 2. Fallback filesystem scan for common download and music folders
    // Ensures newly downloaded files are found even if MediaStore has not indexed them yet
    try {
      final commonDirs = [
        '/storage/emulated/0/Music',
        '/storage/emulated/0/Download',
        '/storage/emulated/0/YMusic',
        '/storage/emulated/0/Snaptube/download/audio',
        '/storage/emulated/0/Vidmate/download',
        '/storage/emulated/0/Audio',
      ];

      final audioExtensions = {'.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus'};

      for (final dirPath in commonDirs) {
        final dir = Directory(dirPath);
        if (await dir.exists()) {
          final entities = dir.listSync(recursive: true, followLinks: false);
          for (final entity in entities) {
            if (entity is File) {
              final lowerPath = entity.path.toLowerCase();
              final isAudio = audioExtensions.any((ext) => lowerPath.endsWith(ext));
              if (isAudio && !tracksMap.containsKey(lowerPath)) {
                final fileName = entity.uri.pathSegments.last;
                final nameWithoutExt = fileName.contains('.')
                    ? fileName.substring(0, fileName.lastIndexOf('.'))
                    : fileName;

                String artist = 'Unknown Artist';
                String title = nameWithoutExt;

                // Extract artist from "Artist - Title" filename format
                if (title.contains(' - ')) {
                  final parts = title.split(' - ');
                  if (parts.length == 2) {
                    artist = parts[0].trim();
                    title = parts[1].trim();
                  }
                }

                tracksMap[lowerPath] = Track(
                  id: entity.path,
                  title: title.isEmpty ? fileName : title,
                  artist: artist,
                  album: 'Device Files',
                  duration: const Duration(minutes: 3), // Default placeholder if duration unavailable
                  filePath: entity.path,
                  dateAdded: entity.lastModifiedSync().millisecondsSinceEpoch ~/ 1000,
                );
              }
            }
          }
        }
      }
    } catch (_) {
      // Filesystem scan fallback handled
    }

    final list = tracksMap.values.toList();
    _sortTracks(list, sortType);
    _cachedTracks = list;
    return list;
  }

  void _sortTracks(List<Track> tracks, TrackSortType sortType) {
    switch (sortType) {
      case TrackSortType.title:
        tracks.sort((a, b) => a.title.toLowerCase().compareTo(b.title.toLowerCase()));
        break;
      case TrackSortType.artist:
        tracks.sort((a, b) => a.artist.toLowerCase().compareTo(b.artist.toLowerCase()));
        break;
      case TrackSortType.duration:
        tracks.sort((a, b) => b.duration.compareTo(a.duration));
        break;
      case TrackSortType.dateAdded:
        tracks.sort((a, b) => (b.dateAdded ?? 0).compareTo(a.dateAdded ?? 0));
        break;
    }
  }

  // Instant local search filter
  List<Track> searchTracks(List<Track> tracks, String query) {
    if (query.trim().isEmpty) return tracks;
    final q = query.toLowerCase().trim();
    return tracks.where((t) {
      return t.title.toLowerCase().contains(q) ||
          t.artist.toLowerCase().contains(q) ||
          t.album.toLowerCase().contains(q);
    }).toList();
  }

  List<Track> search(String query) => searchTracks(_cachedTracks, query);

  // Group tracks by Artist
  Map<String, List<Track>> getTracksByArtist() {
    final map = <String, List<Track>>{};
    for (final track in _cachedTracks) {
      map.putIfAbsent(track.artist, () => []).add(track);
    }
    return map;
  }

  // Group tracks by Album
  Map<String, List<Track>> getTracksByAlbum() {
    final map = <String, List<Track>>{};
    for (final track in _cachedTracks) {
      map.putIfAbsent(track.album, () => []).add(track);
    }
    return map;
  }
}
