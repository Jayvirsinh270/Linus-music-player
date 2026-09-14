import 'package:audio_service/audio_service.dart';

class Track {
  final String id;
  final String title;
  final String artist;
  final Duration duration;
  final String thumbnailUrl;
  String? streamUrl;

  Track({
    required this.id,
    required this.title,
    required this.artist,
    required this.duration,
    required this.thumbnailUrl,
    this.streamUrl,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'artist': artist,
        'durationMs': duration.inMilliseconds,
        'thumbnailUrl': thumbnailUrl,
        'streamUrl': streamUrl,
      };

  factory Track.fromJson(Map<String, dynamic> json) => Track(
        id: json['id'] as String,
        title: json['title'] as String,
        artist: json['artist'] as String,
        duration: Duration(milliseconds: json['durationMs'] as int? ?? 0),
        thumbnailUrl: json['thumbnailUrl'] as String? ?? '',
        streamUrl: json['streamUrl'] as String?,
      );

  MediaItem toMediaItem() => MediaItem(
        id: id,
        album: 'Linus Music',
        title: title,
        artist: artist,
        duration: duration,
        artUri: thumbnailUrl.isNotEmpty ? Uri.tryParse(thumbnailUrl) : null,
        extras: {
          'streamUrl': streamUrl,
        },
      );

  factory Track.fromMediaItem(MediaItem item) => Track(
        id: item.id,
        title: item.title,
        artist: item.artist ?? 'Unknown Artist',
        duration: item.duration ?? Duration.zero,
        thumbnailUrl: item.artUri?.toString() ?? '',
        streamUrl: item.extras?['streamUrl'] as String?,
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Track && runtimeType == other.runtimeType && id == other.id;

  @override
  int get hashCode => id.hashCode;
}
