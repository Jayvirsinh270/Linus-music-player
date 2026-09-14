import 'dart:async';
import 'package:audio_service/audio_service.dart';
import 'package:just_audio/just_audio.dart';
import '../models/track.dart';
import 'youtube_service.dart';

class LinusAudioHandler extends BaseAudioHandler with SeekHandler {
  final AudioPlayer _player = AudioPlayer();
  final YouTubeService _ytService;

  Track? _currentTrack;
  Track? get currentTrack => _currentTrack;

  // Custom callback for when a track ends (for autoplay / queue progression)
  void Function()? onTrackCompleted;

  LinusAudioHandler(this._ytService) {
    _initStreams();
  }

  void _initStreams() {
    // Pipe just_audio state to audio_service PlaybackState
    _player.playbackEventStream.listen((PlaybackEvent event) {
      final playing = _player.playing;
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
          processingState: const {
            ProcessingState.idle: AudioProcessingState.idle,
            ProcessingState.loading: AudioProcessingState.loading,
            ProcessingState.buffering: AudioProcessingState.buffering,
            ProcessingState.ready: AudioProcessingState.ready,
            ProcessingState.completed: AudioProcessingState.completed,
          }[_player.processingState]!,
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

  Stream<Duration> get positionStream => _player.positionStream;
  Stream<Duration?> get durationStream => _player.durationStream;
  Stream<PlayerState> get playerStateStream => _player.playerStateStream;

  Future<void> playTrack(Track track) async {
    _currentTrack = track;
    mediaItem.add(track.toMediaItem());

    // Resolve direct audio stream
    String? streamUrl = track.streamUrl;
    if (streamUrl == null || streamUrl.isEmpty) {
      playbackState.add(playbackState.value.copyWith(
        processingState: AudioProcessingState.loading,
      ));
      streamUrl = await _ytService.getAudioStreamUrl(track.id);
      track.streamUrl = streamUrl;
    }

    if (streamUrl != null) {
      try {
        await _player.stop();
        await _player.setUrl(streamUrl);
        await _player.play();
      } catch (e) {
        playbackState.add(playbackState.value.copyWith(
          processingState: AudioProcessingState.idle,
        ));
      }
    }
  }

  @override
  Future<void> play() => _player.play();

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration position) => _player.seek(position);

  @override
  Future<void> stop() async {
    await _player.stop();
    return super.stop();
  }

  Future<void> disposePlayer() async {
    await _player.dispose();
  }
}
