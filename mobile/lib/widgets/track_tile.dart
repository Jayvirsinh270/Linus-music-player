import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:on_audio_query/on_audio_query.dart';
import 'package:provider/provider.dart';
import '../models/track.dart';
import '../providers/player_provider.dart';

class TrackTile extends StatelessWidget {
  final Track track;
  final VoidCallback? onTap;
  final bool isCurrent;

  const TrackTile({
    super.key,
    required this.track,
    this.onTap,
    this.isCurrent = false,
  });

  String _formatDuration(Duration duration) {
    final minutes = duration.inMinutes;
    final seconds = duration.inSeconds % 60;
    return '$minutes:${seconds.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();
    final isFav = player.isFavorite(track.id);
    final isPlayingThis = isCurrent && player.isPlaying;
    final isBufferingThis = isCurrent && player.isBuffering;

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
      decoration: BoxDecoration(
        color: isCurrent
            ? Theme.of(context).colorScheme.primary.withOpacity(0.1)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        border: isCurrent
            ? Border.all(
                color: Theme.of(context).colorScheme.primary.withOpacity(0.3),
                width: 1,
              )
            : null,
      ),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        onTap: onTap ?? () => player.playTrack(track),
        leading: ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 50,
            height: 50,
            child: Stack(
              fit: StackFit.expand,
              children: [
                track.audioId != null
                    ? QueryArtworkWidget(
                        id: track.audioId!,
                        type: ArtworkType.AUDIO,
                        artworkWidth: 50,
                        artworkHeight: 50,
                        artworkFit: BoxFit.cover,
                        nullArtworkWidget: Container(
                          color: Colors.grey.shade900,
                          child: const Icon(Icons.music_note, color: Colors.grey),
                        ),
                      )
                    : track.thumbnailUrl.isNotEmpty
                        ? CachedNetworkImage(
                            imageUrl: track.thumbnailUrl,
                            fit: BoxFit.cover,
                            placeholder: (_, __) => Container(
                              color: Colors.grey.shade900,
                              child: const Icon(Icons.music_note, color: Colors.grey),
                            ),
                            errorWidget: (_, __, ___) => Container(
                              color: Colors.grey.shade900,
                              child: const Icon(Icons.music_note, color: Colors.grey),
                            ),
                          )
                        : Container(
                            color: Colors.grey.shade900,
                            child: const Icon(Icons.music_note, color: Colors.grey),
                          ),
                if (isBufferingThis)
                  Container(
                    color: Colors.black54,
                    child: Center(
                      child: SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2.2,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                    ),
                  )
                else if (isPlayingThis)
                  Container(
                    color: Colors.black45,
                    child: const Center(
                      child: _MiniEqualizer(),
                    ),
                  )
                else if (isCurrent)
                  Container(
                    color: Colors.black45,
                    child: const Center(
                      child: Icon(Icons.pause_rounded, color: Colors.white, size: 22),
                    ),
                  ),
              ],
            ),
          ),
        ),
      title: Text(
        track.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontWeight: isCurrent ? FontWeight.bold : FontWeight.w500,
          color: isCurrent ? Theme.of(context).colorScheme.primary : Colors.white,
        ),
      ),
      subtitle: Row(
        children: [
          Expanded(
            child: Text(
              track.artist,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: Colors.grey.shade400,
                fontSize: 13,
              ),
            ),
          ),
          if (track.duration > Duration.zero)
            Text(
              _formatDuration(track.duration),
              style: TextStyle(
                color: Colors.grey.shade500,
                fontSize: 12,
              ),
            ),
        ],
      ),
      trailing: PopupMenuButton<String>(
        icon: const Icon(Icons.more_vert, color: Colors.grey),
        onSelected: (value) {
          switch (value) {
            case 'play_now':
              player.playTrack(track);
              break;
            case 'play_next':
              player.playNext(track);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Playing next')),
              );
              break;
            case 'add_queue':
              player.addToQueue(track);
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Added to queue')),
              );
              break;
            case 'favorite':
              player.toggleFavorite(track);
              break;
          }
        },
        itemBuilder: (context) => [
          const PopupMenuItem(
            value: 'play_now',
            child: Row(
              children: [
                Icon(Icons.play_arrow, size: 20),
                SizedBox(width: 8),
                Text('Play Now'),
              ],
            ),
          ),
          const PopupMenuItem(
            value: 'play_next',
            child: Row(
              children: [
                Icon(Icons.playlist_play, size: 20),
                SizedBox(width: 8),
                Text('Play Next'),
              ],
            ),
          ),
          const PopupMenuItem(
            value: 'add_queue',
            child: Row(
              children: [
                Icon(Icons.queue_music, size: 20),
                SizedBox(width: 8),
                Text('Add to Queue'),
              ],
            ),
          ),
          PopupMenuItem(
            value: 'favorite',
            child: Row(
              children: [
                Icon(
                  isFav ? Icons.favorite : Icons.favorite_border,
                  size: 20,
                  color: isFav ? Colors.redAccent : null,
                ),
                const SizedBox(width: 8),
                Text(isFav ? 'Remove Favorite' : 'Favorite'),
              ],
            ),
          ),
        ],
      ),
      ),
    );
  }
}

class _MiniEqualizer extends StatefulWidget {
  const _MiniEqualizer();

  @override
  State<_MiniEqualizer> createState() => _MiniEqualizerState();
}

class _MiniEqualizerState extends State<_MiniEqualizer>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 650),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            _bar(8 + _controller.value * 12),
            const SizedBox(width: 2.5),
            _bar(18 - _controller.value * 10),
            const SizedBox(width: 2.5),
            _bar(10 + _controller.value * 11),
          ],
        );
      },
    );
  }

  Widget _bar(double height) {
    return Container(
      width: 3.5,
      height: height.clamp(4.0, 22.0),
      decoration: BoxDecoration(
        color: const Color(0xFF2DD4BF),
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}
