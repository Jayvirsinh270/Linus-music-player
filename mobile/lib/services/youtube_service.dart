import 'dart:async';
import 'package:youtube_explode_dart/youtube_explode_dart.dart';
import '../models/track.dart';

class YouTubeService {
  final YoutubeExplode _yt = YoutubeExplode();
  final Map<String, (String url, DateTime expiry)> _streamCache = {};

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

  Future<String?> getAudioStreamUrl(String videoId) async {
    // Check if cache has non-expired stream URL (valid for ~4 hours)
    final cached = _streamCache[videoId];
    if (cached != null && DateTime.now().isBefore(cached.$2)) {
      return cached.$1;
    }

    try {
      final manifest = await _yt.videos.streamsClient.getManifest(videoId);
      final audioStreams = manifest.audioOnly;
      if (audioStreams.isEmpty) return null;

      // Select highest bitrate audio-only stream
      final bestAudio = audioStreams.withHighestBitrate();
      final streamUrl = bestAudio.url.toString();

      _streamCache[videoId] = (
        streamUrl,
        DateTime.now().add(const Duration(hours: 3)),
      );

      return streamUrl;
    } catch (e) {
      return null;
    }
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
