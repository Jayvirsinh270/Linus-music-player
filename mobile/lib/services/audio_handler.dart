import 'dart:async';
import 'package:audio_service/audio_service.dart';
import 'package:just_audio/just_audio.dart';
import '../models/track.dart';
import 'youtube_service.dart';

class LinusAudioHandler extends BaseAudioHandler with SeekHandler {
  final AudioPlayer _player = AudioPlayer();
  final YouTubeService _ytService;

  static const Map<String, String> _ytHeaders = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.youtube.com/',
  };

  Track? _currentTrack;
  Track? get currentTrack => _currentTrack;

  // Custom callbacks
  void Function()? onTrackCompleted;
  void Function()? onSkipNext;
  void Function()? onSkipPrevious;
  void Function(Track track, String message)? onPlaybackError;

  LinusAudioHandler(this._ytService) {
    _initStreams();
  }

  void _initStreams() {
    // Pipe just_audio state to audio_service PlaybackState
    _player.playbackEventStream.listen((PlaybackEvent event) {
      final playing = _player.playing;
      final processingState = _mapProcessingState(_player.processingState);

      playbackState.add(
        playbackState.value.copyWith(
          controls: [
            MediaControl.skipToPrevious,
            if (playing) MediaControl.pause else MediaControl.play,
            MediaControl.skipToNext,
            MediaControl.stop,
          ],
          systemActions: const {
            MediaAction.seek,
            MediaAction.seekForward,
            MediaAction.seekBackward,
          },
          androidCompactActionIndices: const [0, 1, 2],
          processingState: processingState,
          playing: playing,
          updatePosition: _player.position,
          bufferedPosition: _player.bufferedPosition,
          speed: _player.speed,
          queueIndex: 0,
        ),
      );
    });

    // Listen for completion to trigger next song or autoplay
    _player.playerStateStream.listen((state) {
      if (state.processingState == ProcessingState.completed) {
        onTrackCompleted?.call();
      }
    });
  }

  AudioProcessingState _mapProcessingState(ProcessingState state) {
    switch (state) {
      case ProcessingState.idle:
        return AudioProcessingState.idle;
      case ProcessingState.loading:
        return AudioProcessingState.loading;
      case ProcessingState.buffering:
        return AudioProcessingState.buffering;
      case ProcessingState.ready:
        return AudioProcessingState.ready;
      case ProcessingState.completed:
        return AudioProcessingState.completed;
    }
  }

  Stream<Duration> get positionStream => _player.positionStream;
  Stream<Duration?> get durationStream => _player.durationStream;
  Stream<PlayerState> get playerStateStream => _player.playerStateStream;
  Stream<double> get volumeStream => _player.volumeStream;
  double get volume => _player.volume;
  Future<void> setVolume(double vol) => _player.setVolume(vol);

  Future<void> playTrack(Track track) async {
    _currentTrack = track;
    mediaItem.add(track.toMediaItem());

    // Signal loading state immediately
    playbackState.add(playbackState.value.copyWith(
      processingState: AudioProcessingState.loading,
    ));

    // 1. Resolve direct audio stream URL
    String? streamUrl = track.streamUrl;
    if (streamUrl == null || streamUrl.isEmpty) {
      try {
        streamUrl = await _ytService
            .getAudioStreamUrl(track.id)
            .timeout(const Duration(seconds: 12));
        track.streamUrl = streamUrl;
      } catch (e) {
        streamUrl = null;
      }
    }

    if (streamUrl == null) {
      playbackState.add(playbackState.value.copyWith(
        processingState: AudioProcessingState.idle,
      ));
      onPlaybackError?.call(track, 'Unable to get audio stream from YouTube.');
      return;
    }

    // 2. Load and play stream with required browser headers to prevent 403 Forbidden
    try {
      await _player.stop();
      await _player.setAudioSource(
        AudioSource.uri(
          Uri.parse(streamUrl),
          headers: _ytHeaders,
        ),
      );
      await _player.play();
    } catch (firstError) {
      // Stream may have expired or blocked; invalidate cache and retry once with fresh URL
      _ytService.invalidateCache(track.id);

      try {
        final freshUrl = await _ytService
            .getAudioStreamUrl(track.id, forceRefresh: true)
            .timeout(const Duration(seconds: 12));

        if (freshUrl != null) {
          track.streamUrl = freshUrl;
          await _player.stop();
          await _player.setAudioSource(
            AudioSource.uri(
              Uri.parse(freshUrl),
              headers: _ytHeaders,
            ),
          );
          await _player.play();
          return;
        }
      } catch (_) {
        // Retry failed
      }

      playbackState.add(playbackState.value.copyWith(
        processingState: AudioProcessingState.idle,
      ));
      onPlaybackError?.call(track, 'Stream playback error: ${firstError.toString()}');
    }
  }

  @override
  Future<void> play() => _player.play();

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration position) => _player.seek(position);

  @override
  Future<void> skipToNext() async {
    onSkipNext?.call();
  }

  @override
  Future<void> skipToPrevious() async {
    onSkipPrevious?.call();
  }

  @override
  Future<void> stop() async {
    await _player.stop();
    return super.stop();
  }

  Future<void> disposePlayer() async {
    await _player.dispose();
  }
}
