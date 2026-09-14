import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/track.dart';
import '../providers/player_provider.dart';
import '../widgets/track_tile.dart';

class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key});

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  double? _dragValue;

  String _formatDuration(Duration duration) {
    final minutes = duration.inMinutes;
    final seconds = duration.inSeconds % 60;
    return '$minutes:${seconds.toString().padLeft(2, '0')}';
  }

  void _showQueueSheet(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: const Color(0xFF1E2430),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) {
        return Consumer<PlayerProvider>(
          builder: (context, player, child) {
            return SafeArea(
              child: Column(
                children: [
                  const SizedBox(height: 12),
                  Container(
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: Colors.grey.shade600,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Row(
                      children: [
                        const Text(
                          'Up Next Queue',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        const Spacer(),
                        Text(
                          '${player.queue.length} tracks',
                          style: TextStyle(color: Colors.grey.shade400),
                        ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: player.queue.isEmpty
                        ? Center(
                            child: Text(
                              'Queue is empty.\nAutoplay suggestions will kick in!',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: Colors.grey.shade400),
                            ),
                          )
                        : ReorderableListView.builder(
                            itemCount: player.queue.length,
                            onReorder: (oldIndex, newIndex) =>
                                player.reorderQueue(oldIndex, newIndex),
                            itemBuilder: (context, index) {
                              final track = player.queue[index];
                              return Dismissible(
                                key: ValueKey(track.id + index.toString()),
                                direction: DismissDirection.endToStart,
                                background: Container(
                                  color: Colors.redAccent,
                                  alignment: Alignment.centerRight,
                                  padding: const EdgeInsets.only(right: 20),
                                  child: const Icon(Icons.delete, color: Colors.white),
                                ),
                                onDismissed: (_) => player.removeFromQueue(index),
                                child: TrackTile(
                                  track: track,
                                  onTap: () => player.playTrack(track),
                                ),
                              );
                            },
                          ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();
    final track = player.currentTrack;

    if (track == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: Text('No track playing')),
      );
    }

    final isFav = player.isFavorite(track.id);
    final totalDuration = player.duration.inMilliseconds.toDouble();
    final currentPos = (_dragValue ?? player.position.inMilliseconds.toDouble())
        .clamp(0.0, totalDuration > 0 ? totalDuration : 1.0);

    return Scaffold(
      backgroundColor: const Color(0xFF10141D),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 36, color: Colors.white),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: const Text(
          'NOW PLAYING',
          style: TextStyle(
            fontSize: 13,
            letterSpacing: 1.5,
            fontWeight: FontWeight.w600,
            color: Colors.grey,
          ),
        ),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.queue_music_rounded, color: Colors.white),
            onPressed: () => _showQueueSheet(context),
          ),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Column(
            children: [
              const Spacer(),
              // Album Artwork
              Center(
                child: Hero(
                  tag: 'artwork_${track.id}',
                  child: Container(
                    width: MediaQuery.of(context).size.width * 0.78,
                    height: MediaQuery.of(context).size.width * 0.78,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(20),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withOpacity(0.6),
                          blurRadius: 25,
                          offset: const Offset(0, 10),
                        ),
                      ],
                    ),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(20),
                      child: track.thumbnailUrl.isNotEmpty
                          ? CachedNetworkImage(
                              imageUrl: track.thumbnailUrl,
                              fit: BoxFit.cover,
                              errorWidget: (_, __, ___) => const Icon(
                                Icons.music_note,
                                size: 80,
                                color: Colors.white24,
                              ),
                            )
                          : const Icon(
                              Icons.music_note,
                              size: 80,
                              color: Colors.white24,
                            ),
                    ),
                  ),
                ),
              ),
              const Spacer(),
              // Title & Artist & Favorite
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          track.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          track.artist,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 15,
                            color: Colors.grey.shade400,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: Icon(
                      isFav ? Icons.favorite_rounded : Icons.favorite_border_rounded,
                      color: isFav ? Colors.redAccent : Colors.grey,
                      size: 28,
                    ),
                    onPressed: () => player.toggleFavorite(track),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              // Scrub Slider
              SliderTheme(
                data: SliderTheme.of(context).copyWith(
                  trackHeight: 4,
                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                  overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
                  activeTrackColor: Theme.of(context).colorScheme.primary,
                  inactiveTrackColor: Colors.white12,
                  thumbColor: Colors.white,
                ),
                child: Slider(
                  min: 0.0,
                  max: totalDuration > 0 ? totalDuration : 1.0,
                  value: currentPos,
                  onChanged: (val) {
                    setState(() {
                      _dragValue = val;
                    });
                  },
                  onChangeEnd: (val) {
                    player.seek(Duration(milliseconds: val.toInt()));
                    setState(() {
                      _dragValue = null;
                    });
                  },
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      _formatDuration(Duration(milliseconds: currentPos.toInt())),
                      style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
                    ),
                    Text(
                      _formatDuration(player.duration),
                      style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              // Playback Controls
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  IconButton(
                    icon: Icon(
                      Icons.shuffle_rounded,
                      color: player.isShuffle
                          ? Theme.of(context).colorScheme.primary
                          : Colors.grey,
                      size: 24,
                    ),
                    onPressed: () => player.toggleShuffle(),
                  ),
                  IconButton(
                    icon: const Icon(
                      Icons.skip_previous_rounded,
                      color: Colors.white,
                      size: 38,
                    ),
                    onPressed: () => player.skipPrevious(),
                  ),
                  Container(
                    width: 68,
                    height: 68,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: Theme.of(context).colorScheme.primary,
                      boxShadow: [
                        BoxShadow(
                          color: Theme.of(context).colorScheme.primary.withOpacity(0.4),
                          blurRadius: 15,
                          offset: const Offset(0, 4),
                        ),
                      ],
                    ),
                    child: player.isBuffering
                        ? const Padding(
                            padding: EdgeInsets.all(20),
                            child: CircularProgressIndicator(
                              color: Colors.black,
                              strokeWidth: 3,
                            ),
                          )
                        : IconButton(
                            icon: Icon(
                              player.isPlaying
                                  ? Icons.pause_rounded
                                  : Icons.play_arrow_rounded,
                              size: 38,
                              color: Colors.black,
                            ),
                            onPressed: () => player.togglePlayPause(),
                          ),
                  ),
                  IconButton(
                    icon: const Icon(
                      Icons.skip_next_rounded,
                      color: Colors.white,
                      size: 38,
                    ),
                    onPressed: () => player.skipNext(),
                  ),
                  IconButton(
                    icon: Icon(
                      player.repeatMode == RepeatMode.one
                          ? Icons.repeat_one_rounded
                          : Icons.repeat_rounded,
                      color: player.repeatMode != RepeatMode.off
                          ? Theme.of(context).colorScheme.primary
                          : Colors.grey,
                      size: 24,
                    ),
                    onPressed: () => player.toggleRepeat(),
                  ),
                ],
              ),
              const Spacer(),
            ],
          ),
        ),
      ),
    );
  }
}
