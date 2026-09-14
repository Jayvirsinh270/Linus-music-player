import 'dart:async';
import 'package:youtube_explode_dart/youtube_explode_dart.dart';
import '../models/track.dart';

class _CachedAudio {
  final String url;
  final DateTime expiry;
  _CachedAudio(this.url, this.expiry);
}

class YouTubeService {
  final YoutubeExplode _yt = YoutubeExplode();
  final Map<String, _CachedAudio> _streamCache = {};

  Future<List<Track>> searchTracks(String query) async {
    try {
      final searchList = await _yt.search.search(query);
      final tracks = <Track>[];

      for (final video in searchList.take(25)) {
        tracks.add(_videoToTrack(video));
      }
      return tracks;
    } catch (e) {
      // Fallback: return empty list on network/parsing failure
      return [];
    }
  }

  void invalidateCache(String videoId) {
    _streamCache.remove(videoId);
  }

  Future<String?> getAudioStreamUrl(String videoId, {bool forceRefresh = false}) async {
    if (!forceRefresh) {
      final cached = _streamCache[videoId];
      if (cached != null && DateTime.now().isBefore(cached.expiry)) {
        return cached.url;
      }
    }

    try {
      final manifest = await _yt.videos.streamsClient.getManifest(videoId);
      final audioStreams = manifest.audioOnly;

      StreamInfo? selectedStream;

      if (audioStreams.isNotEmpty) {
        // Priority 1: M4A / AAC audio-only streams (highest compatibility with Android ExoPlayer)
        final m4aStreams = audioStreams.where((s) =>
            s.container.name.toLowerCase() == 'mp4' ||
            s.codec.mimeType.toLowerCase().contains('mp4') ||
            s.codec.mimeType.toLowerCase().contains('aac') ||
            s.tag == 140);

        if (m4aStreams.isNotEmpty) {
          selectedStream = m4aStreams.withHighestBitrate();
        } else {
          // Priority 2: Opus / WebM highest bitrate
          selectedStream = audioStreams.withHighestBitrate();
        }
      }

      // Priority 3: Fallback to muxed stream if audioOnly is empty
      if (selectedStream == null && manifest.muxed.isNotEmpty) {
        selectedStream = manifest.muxed.withHighestBitrate();
      }

      if (selectedStream == null) return null;

      final streamUrl = selectedStream.url.toString();

      // Cache for 45 minutes (safe margin before YouTube URL expiry)
      _streamCache[videoId] = _CachedAudio(
        streamUrl,
        DateTime.now().add(const Duration(minutes: 45)),
      );

      return streamUrl;
    } catch (e) {
      return null;
    }
  }

  Future<List<Track>> getTrendingTracks() async {
    final queries = [
      'Top Music Hits',
      'Trending Global Songs',
      'Billboard Hot 100',
    ];
    for (final q in queries) {
      final tracks = await searchTracks(q);
      if (tracks.isNotEmpty) {
        return tracks;
      }
    }
    return [];
  }

  Future<List<Track>> getRelatedTracks(String videoId) async {
    try {
      final video = await _yt.videos.get(videoId);
      final related = await _yt.videos.getRelatedVideos(video);
      if (related == null) return [];

      return related
          .take(15)
          .map((v) => _videoToTrack(v))
          .toList();
    } catch (e) {
      return [];
    }
  }

  Track _videoToTrack(Video video) {
    String title = video.title;
    String artist = video.author;

    // Check if title is in "Artist - Title" format
    if (title.contains(' - ')) {
      final parts = title.split(' - ');
      if (parts.length == 2) {
        artist = parts[0].trim();
        title = parts[1].trim();
      }
    }

    // Clean common junk like (Official Video), [Official Audio], etc.
    title = title
        .replaceAll(RegExp(r'\s*[\(\[](official\s*(music\s*)?video|audio|lyrics|hd|4k|mv)[\)\]]', caseSensitive: false), '')
        .trim();

    return Track(
      id: video.id.value,
      title: title.isEmpty ? video.title : title,
      artist: artist,
      duration: video.duration ?? const Duration(minutes: 3),
      thumbnailUrl: video.thumbnails.mediumResUrl,
    );
  }

  void dispose() {
    _yt.close();
  }
}
