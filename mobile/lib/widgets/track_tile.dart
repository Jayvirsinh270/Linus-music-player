import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
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

    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      onTap: onTap ?? () => player.playTrack(track),
      leading: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: SizedBox(
          width: 50,
          height: 50,
          child: track.thumbnailUrl.isNotEmpty
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
    );
  }
}
