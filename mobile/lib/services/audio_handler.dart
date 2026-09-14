import 'dart:async';
import 'package:audio_service/audio_service.dart';
import 'package:just_audio/just_audio.dart';
import '../models/track.dart';

class LinusAudioHandler extends BaseAudioHandler with SeekHandler {
  final AudioPlayer _player = AudioPlayer();

  Track? _currentTrack;
  Track? get currentTrack => _currentTrack;

  // Custom callbacks
  void Function()? onTrackCompleted;
  void Function()? onSkipNext;
  void Function()? onSkipPrevious;
  void Function(Track track, String message)? onPlaybackError;

  LinusAudioHandler() {
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

    // Signal loading state
    playbackState.add(playbackState.value.copyWith(
      processingState: AudioProcessingState.loading,
    ));

    try {
      await _player.stop();
      if (track.filePath.startsWith('content://')) {
        await _player.setAudioSource(AudioSource.uri(Uri.parse(track.filePath)));
      } else {
        await _player.setFilePath(track.filePath);
      }
      await _player.play();
    } catch (e) {
      playbackState.add(playbackState.value.copyWith(
        processingState: AudioProcessingState.idle,
      ));
      onPlaybackError?.call(track, 'Unable to play local file: ${e.toString()}');
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
