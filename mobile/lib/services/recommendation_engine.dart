import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/track.dart';
import 'local_audio_service.dart';

class RecommendationEngine {
  static const String _historyKey = 'linus_play_history';
  static const String _artistScoresKey = 'linus_artist_scores';

  final LocalAudioService _localAudioService;
  final Map<String, int> _artistScores = {};
  final List<Track> _recentHistory = [];

  RecommendationEngine(this._localAudioService);

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();

    // Load artist affinity scores
    final scoresJson = prefs.getString(_artistScoresKey);
    if (scoresJson != null) {
      try {
        final decoded = jsonDecode(scoresJson) as Map<String, dynamic>;
        decoded.forEach((key, val) {
          if (val is num) _artistScores[key] = val.toInt();
        });
      } catch (_) {}
    }

    // Load recent history
    final historyList = prefs.getStringList(_historyKey);
    if (historyList != null) {
      for (final item in historyList) {
        try {
          _recentHistory.add(Track.fromJson(jsonDecode(item)));
        } catch (_) {}
      }
    }
  }

  List<Track> get recentHistory => List.unmodifiable(_recentHistory);

  Future<void> recordPlay({
    required Track track,
    required Duration playedDuration,
    required Duration totalDuration,
  }) async {
    final prefs = await SharedPreferences.getInstance();

    final double ratio = totalDuration.inSeconds > 0
        ? playedDuration.inSeconds / totalDuration.inSeconds
        : 0.0;
    final bool skippedEarly = playedDuration.inSeconds < 20 && totalDuration.inSeconds > 40;

    final artist = track.artist.toLowerCase().trim();
    int currentScore = _artistScores[artist] ?? 0;

    if (skippedEarly) {
      currentScore -= 2;
    } else if (ratio >= 0.6) {
      currentScore += 3;
    } else {
      currentScore += 1;
    }
    _artistScores[artist] = currentScore;

    // Add to recent history (capped at 50 tracks)
    _recentHistory.removeWhere((t) => t.id == track.id);
    _recentHistory.insert(0, track);
    if (_recentHistory.length > 50) {
      _recentHistory.removeLast();
    }

    // Persist
    await prefs.setString(_artistScoresKey, jsonEncode(_artistScores));
    final historyStrings =
        _recentHistory.map((t) => jsonEncode(t.toJson())).toList();
    await prefs.setStringList(_historyKey, historyStrings);
  }

  Future<Track?> getNextAutoplayTrack(Track currentTrack, Set<String> currentQueueIds) async {
    final allTracks = _localAudioService.cachedTracks;
    if (allTracks.isEmpty) return null;

    // Filter out already played or queued songs
    final candidates = allTracks.where((t) => !currentQueueIds.contains(t.id) && t.id != currentTrack.id).toList();
    if (candidates.isEmpty) {
      return allTracks.firstWhere((t) => t.id != currentTrack.id, orElse: () => allTracks.first);
    }

    // 1. Prioritize songs from same artist or same album
    final sameArtist = candidates.where((t) => t.artist.toLowerCase() == currentTrack.artist.toLowerCase()).toList();
    if (sameArtist.isNotEmpty) {
      sameArtist.shuffle();
      return sameArtist.first;
    }

    // 2. Rank candidates based on user's listening habits (artist affinity)
    candidates.sort((a, b) {
      final scoreA = _artistScores[a.artist.toLowerCase().trim()] ?? 0;
      final scoreB = _artistScores[b.artist.toLowerCase().trim()] ?? 0;
      return scoreB.compareTo(scoreA);
    });

    return candidates.first;
  }

  List<Track> getSuggestedPicks() {
    final allTracks = _localAudioService.cachedTracks;
    if (allTracks.isEmpty) return [];

    if (_recentHistory.isEmpty) {
      // Return a smart mix of available device songs
      final list = List<Track>.from(allTracks);
      list.shuffle();
      return list.take(15).toList();
    }

    // Rank local songs matching user's top preferred artists
    final list = List<Track>.from(allTracks);
    list.sort((a, b) {
      final scoreA = _artistScores[a.artist.toLowerCase().trim()] ?? 0;
      final scoreB = _artistScores[b.artist.toLowerCase().trim()] ?? 0;
      return scoreB.compareTo(scoreA);
    });

    return list.take(15).toList();
  }
}
