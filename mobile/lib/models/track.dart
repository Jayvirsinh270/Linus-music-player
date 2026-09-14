import 'package:audio_service/audio_service.dart';

class Track {
  final String id;
  final String title;
  final String artist;
  final String album;
  final Duration duration;
  final String filePath;
  final int? audioId; // MediaStore ID for artwork extraction
  final String thumbnailUrl;
  final int? dateAdded;

  Track({
    required this.id,
    required this.title,
    required this.artist,
    this.album = 'Unknown Album',
    required this.duration,
    required this.filePath,
    this.audioId,
    this.thumbnailUrl = '',
    this.dateAdded,
  });

  // Getter for playback URL/path
  String get streamUrl => filePath;

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'artist': artist,
        'album': album,
        'durationMs': duration.inMilliseconds,
        'filePath': filePath,
        'audioId': audioId,
        'thumbnailUrl': thumbnailUrl,
        'dateAdded': dateAdded,
      };

  factory Track.fromJson(Map<String, dynamic> json) => Track(
        id: json['id'] as String? ?? '',
        title: json['title'] as String? ?? 'Unknown Title',
        artist: json['artist'] as String? ?? 'Unknown Artist',
        album: json['album'] as String? ?? 'Unknown Album',
        duration: Duration(milliseconds: json['durationMs'] as int? ?? 0),
        filePath: (json['filePath'] as String?) ?? (json['streamUrl'] as String?) ?? '',
        audioId: json['audioId'] as int?,
        thumbnailUrl: json['thumbnailUrl'] as String? ?? '',
        dateAdded: json['dateAdded'] as int?,
      );

  MediaItem toMediaItem() => MediaItem(
        id: id,
        album: album,
        title: title,
        artist: artist,
        duration: duration,
        artUri: thumbnailUrl.isNotEmpty ? Uri.tryParse(thumbnailUrl) : null,
        extras: {
          'filePath': filePath,
          'audioId': audioId,
        },
      );

  factory Track.fromMediaItem(MediaItem item) => Track(
        id: item.id,
        title: item.title,
        artist: item.artist ?? 'Unknown Artist',
        album: item.album ?? 'Unknown Album',
        duration: item.duration ?? Duration.zero,
        filePath: item.extras?['filePath'] as String? ?? '',
        audioId: item.extras?['audioId'] as int?,
        thumbnailUrl: item.artUri?.toString() ?? '',
      );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Track && runtimeType == other.runtimeType && id == other.id;

  @override
  int get hashCode => id.hashCode;
}
