import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/track.dart';
import 'youtube_service.dart';

class RecommendationEngine {
  static const String _historyKey = 'linus_play_history';
  static const String _artistScoresKey = 'linus_artist_scores';

  final YouTubeService _ytService;
  final Map<String, int> _artistScores = {};
  final List<Track> _recentHistory = [];

  RecommendationEngine(this._ytService);

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

    // Determine completion ratio
    final double ratio = totalDuration.inSeconds > 0
        ? playedDuration.inSeconds / totalDuration.inSeconds
        : 0.0;
    final bool skippedEarly = playedDuration.inSeconds < 20 && totalDuration.inSeconds > 40;

    // Update artist affinity score
    final artist = track.artist.toLowerCase().trim();
    int currentScore = _artistScores[artist] ?? 0;

    if (skippedEarly) {
      currentScore -= 2; // User didn't want this track
    } else if (ratio >= 0.6) {
      currentScore += 3; // High affinity completion
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
    // 1. Fetch related tracks from YouTube
    final related = await _ytService.getRelatedTracks(currentTrack.id);
    if (related.isEmpty) return null;

    // 2. Filter out items already in the queue or just played
    final candidates = related.where((t) => !currentQueueIds.contains(t.id)).toList();
    if (candidates.isEmpty) return related.first;

    // 3. Rank candidates based on artist affinity
    candidates.sort((a, b) {
      final scoreA = _artistScores[a.artist.toLowerCase().trim()] ?? 0;
      final scoreB = _artistScores[b.artist.toLowerCase().trim()] ?? 0;
      return scoreB.compareTo(scoreA); // Highest score first
    });

    return candidates.first;
  }

  Future<List<Track>> getSuggestedPicks() async {
    if (_recentHistory.isEmpty) {
      // Default curated starter seeds for new users
      return _ytService.searchTracks('Top Hits Music 2026');
    }

    // Pick a favorite artist or recent track to seed suggestions
    final seedTrack = _recentHistory.first;
    final suggestions = await _ytService.getRelatedTracks(seedTrack.id);
    return suggestions.take(10).toList();
  }
}
