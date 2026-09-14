import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/track.dart';
import '../services/audio_handler.dart';
import '../services/recommendation_engine.dart';

enum RepeatMode { off, all, one }

class PlayerProvider extends ChangeNotifier {
  final LinusAudioHandler _audioHandler;
  final RecommendationEngine _recEngine;

  Track? _currentTrack;
  final List<Track> _queue = [];
  final List<Track> _history = [];
  final List<Track> _favorites = [];

  bool _isPlaying = false;
  bool _isBuffering = false;
  Duration _position = Duration.zero;
  Duration _duration = Duration.zero;

  bool _isShuffle = false;
  RepeatMode _repeatMode = RepeatMode.off;

  DateTime? _trackStartTime;
  Duration _accumulatedPlayed = Duration.zero;

  PlayerProvider(this._audioHandler, this._recEngine) {
    _initListeners();
    _loadFavorites();
  }

  Track? get currentTrack => _currentTrack;
  List<Track> get queue => List.unmodifiable(_queue);
  List<Track> get favorites => List.unmodifiable(_favorites);
  bool get isPlaying => _isPlaying;
  bool get isBuffering => _isBuffering;
  Duration get position => _position;
  Duration get duration => _duration;
  bool get isShuffle => _isShuffle;
  RepeatMode get repeatMode => _repeatMode;

  bool isFavorite(String trackId) => _favorites.any((t) => t.id == trackId);

  void _initListeners() {
    // Audio handler completion hook
    _audioHandler.onTrackCompleted = () {
      _handleTrackEnd();
    };

    // Position updates
    _audioHandler.positionStream.listen((pos) {
      _position = pos;
      notifyListeners();
    });

    // Duration updates
    _audioHandler.durationStream.listen((dur) {
      if (dur != null) {
        _duration = dur;
        notifyListeners();
      }
    });

    // Player state updates (play/pause/buffer)
    _audioHandler.playerStateStream.listen((state) {
      _isPlaying = state.playing;
      _isBuffering = state.processingState == ProcessingState.buffering ||
          state.processingState == ProcessingState.loading;
      notifyListeners();
    });
  }

  Future<void> _loadFavorites() async {
    final prefs = await SharedPreferences.getInstance();
    final favList = prefs.getStringList('linus_favorites') ?? [];
    for (final item in favList) {
      try {
        _favorites.add(Track.fromJson(jsonDecode(item)));
      } catch (_) {}
    }
    notifyListeners();
  }

  Future<void> toggleFavorite(Track track) async {
    final exists = _favorites.any((t) => t.id == track.id);
    if (exists) {
      _favorites.removeWhere((t) => t.id == track.id);
    } else {
      _favorites.insert(0, track);
    }
    notifyListeners();

    final prefs = await SharedPreferences.getInstance();
    final favStrings = _favorites.map((t) => jsonEncode(t.toJson())).toList();
    await prefs.setStringList('linus_favorites', favStrings);
  }

  void _recordListeningMetric() {
    if (_currentTrack != null && _trackStartTime != null) {
      final played = DateTime.now().difference(_trackStartTime!) + _accumulatedPlayed;
      _recEngine.recordPlay(
        track: _currentTrack!,
        playedDuration: played,
        totalDuration: _duration,
      );
    }
    _accumulatedPlayed = Duration.zero;
    _trackStartTime = DateTime.now();
  }

  Future<void> playTrack(Track track, {List<Track>? newQueue}) async {
    _recordListeningMetric();

    _currentTrack = track;
    if (newQueue != null) {
      _queue.clear();
      _queue.addAll(newQueue.where((t) => t.id != track.id));
      if (_isShuffle) {
        _queue.shuffle();
      }
    }

    _trackStartTime = DateTime.now();
    notifyListeners();

    await _audioHandler.playTrack(track);
  }

  void playNext(Track track) {
    _queue.removeWhere((t) => t.id == track.id);
    _queue.insert(0, track);
    notifyListeners();
  }

  void addToQueue(Track track) {
    _queue.removeWhere((t) => t.id == track.id);
    _queue.add(track);
    notifyListeners();
  }

  void removeFromQueue(int index) {
    if (index >= 0 && index < _queue.length) {
      _queue.removeAt(index);
      notifyListeners();
    }
  }

  void reorderQueue(int oldIndex, int newIndex) {
    if (oldIndex < newIndex) {
      newIndex -= 1;
    }
    final item = _queue.removeAt(oldIndex);
    _queue.insert(newIndex, item);
    notifyListeners();
  }

  Future<void> skipNext() async {
    if (_currentTrack != null) {
      _history.insert(0, _currentTrack!);
    }

    if (_queue.isNotEmpty) {
      final nextTrack = _queue.removeAt(0);
      await playTrack(nextTrack);
    } else if (_currentTrack != null) {
      // Smart Autoplay / Radio continuation
      final nextAutoplay = await _recEngine.getNextAutoplayTrack(
        _currentTrack!,
        {..._history.map((t) => t.id), _currentTrack!.id},
      );
      if (nextAutoplay != null) {
        await playTrack(nextAutoplay);
      }
    }
  }

  Future<void> skipPrevious() async {
    if (_position.inSeconds > 3) {
      // Seek back to start if already played more than 3 seconds
      await seek(Duration.zero);
      return;
    }

    if (_history.isNotEmpty) {
      final prevTrack = _history.removeAt(0);
      if (_currentTrack != null) {
        _queue.insert(0, _currentTrack!);
      }
      await playTrack(prevTrack);
    }
  }

  Future<void> _handleTrackEnd() async {
    if (_repeatMode == RepeatMode.one && _currentTrack != null) {
      await seek(Duration.zero);
      await _audioHandler.play();
    } else {
      await skipNext();
    }
  }

  Future<void> togglePlayPause() async {
    if (_isPlaying) {
      await _audioHandler.pause();
    } else {
      await _audioHandler.play();
    }
  }

  Future<void> seek(Duration position) async {
    await _audioHandler.seek(position);
  }

  void toggleShuffle() {
    _isShuffle = !_isShuffle;
    if (_isShuffle) {
      _queue.shuffle();
    }
    notifyListeners();
  }

  void toggleRepeat() {
    if (_repeatMode == RepeatMode.off) {
      _repeatMode = RepeatMode.all;
    } else if (_repeatMode == RepeatMode.all) {
      _repeatMode = RepeatMode.one;
    } else {
      _repeatMode = RepeatMode.off;
    }
    notifyListeners();
  }
}
