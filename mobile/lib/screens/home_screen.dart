import 'dart:async';
import 'package:flutter/material.dart';
import 'package:on_audio_query/on_audio_query.dart';
import 'package:provider/provider.dart';
import '../models/track.dart';
import '../providers/player_provider.dart';
import '../services/local_audio_service.dart';
import '../services/recommendation_engine.dart';
import '../widgets/track_tile.dart';

class HomeScreen extends StatefulWidget {
  final LocalAudioService localAudioService;
  final RecommendationEngine recEngine;

  const HomeScreen({
    super.key,
    required this.localAudioService,
    required this.recEngine,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  StreamSubscription<String>? _errorSub;

  @override
  void initState() {
    super.initState();

    WidgetsBinding.instance.addPostFrameCallback((_) {
      final player = context.read<PlayerProvider>();
      _errorSub = player.errorStream.listen((msg) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(msg),
              backgroundColor: const Color(0xFFDC2626),
              behavior: SnackBarBehavior.floating,
              duration: const Duration(seconds: 4),
            ),
          );
        }
      });
    });
  }

  @override
  void dispose() {
    _errorSub?.cancel();
    super.dispose();
  }

  String _sortLabel(TrackSortType sort) {
    switch (sort) {
      case TrackSortType.title:
        return 'Title (A-Z)';
      case TrackSortType.artist:
        return 'Artist (A-Z)';
      case TrackSortType.dateAdded:
        return 'Recently Added';
      case TrackSortType.duration:
        return 'Duration';
    }
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();
    final tracks = player.deviceTracks;
    final history = widget.recEngine.recentHistory;
    final primaryColor = Theme.of(context).colorScheme.primary;

    return Scaffold(
      backgroundColor: const Color(0xFF10141D),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () => player.scanDeviceTracks(),
          color: primaryColor,
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              // Header
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: primaryColor.withOpacity(0.15),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Icon(
                          Icons.library_music_rounded,
                          color: primaryColor,
                          size: 26,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'Linus Music',
                              style: TextStyle(
                                fontSize: 22,
                                fontWeight: FontWeight.bold,
                                color: Colors.white,
                                letterSpacing: -0.5,
                              ),
                            ),
                            Text(
                              player.isLoadingTracks
                                  ? 'Scanning songs...'
                                  : '${tracks.length} local songs',
                              style: TextStyle(
                                fontSize: 12,
                                color: Colors.grey.shade400,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        tooltip: 'Rescan Storage',
                        icon: const Icon(Icons.refresh_rounded, color: Colors.white70),
                        onPressed: player.isLoadingTracks
                            ? null
                            : () => player.scanDeviceTracks(),
                      ),
                      PopupMenuButton<TrackSortType>(
                        tooltip: 'Sort By',
                        icon: const Icon(Icons.sort_rounded, color: Colors.white70),
                        initialValue: player.currentSort,
                        onSelected: (sort) => player.scanDeviceTracks(sortType: sort),
                        itemBuilder: (context) => [
                          const PopupMenuItem(
                            value: TrackSortType.title,
                            child: Text('Sort by Title (A-Z)'),
                          ),
                          const PopupMenuItem(
                            value: TrackSortType.artist,
                            child: Text('Sort by Artist'),
                          ),
                          const PopupMenuItem(
                            value: TrackSortType.dateAdded,
                            child: Text('Sort by Recently Added'),
                          ),
                          const PopupMenuItem(
                            value: TrackSortType.duration,
                            child: Text('Sort by Duration'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),

              // Permission Request Banner (if permission not granted)
              if (!player.hasPermission && !player.isLoadingTracks)
                SliverToBoxAdapter(
                  child: Container(
                    margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: const Color(0xFF1E2430),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: primaryColor.withOpacity(0.3)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(Icons.folder_shared_rounded, color: primaryColor, size: 24),
                            const SizedBox(width: 8),
                            const Text(
                              'Storage Permission Needed',
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.bold,
                                color: Colors.white,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Linus needs permission to access audio files on your device storage to play your downloaded songs.',
                          style: TextStyle(color: Colors.grey.shade400, fontSize: 13),
                        ),
                        const SizedBox(height: 12),
                        ElevatedButton.icon(
                          onPressed: () => player.requestPermission(),
                          icon: const Icon(Icons.check_circle_outline),
                          label: const Text('Allow Access'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: primaryColor,
                            foregroundColor: Colors.black,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(10),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),

              // Action Buttons: Play All & Shuffle
              if (tracks.isNotEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    child: Row(
                      children: [
                        Expanded(
                          child: ElevatedButton.icon(
                            onPressed: () => player.playAll(shuffle: false),
                            icon: const Icon(Icons.play_arrow_rounded),
                            label: const Text('Play All'),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: primaryColor,
                              foregroundColor: Colors.black,
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(10),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: () => player.playAll(shuffle: true),
                            icon: Icon(Icons.shuffle_rounded, color: primaryColor),
                            label: Text('Shuffle', style: TextStyle(color: primaryColor)),
                            style: OutlinedButton.styleFrom(
                              side: BorderSide(color: primaryColor.withOpacity(0.5)),
                              padding: const EdgeInsets.symmetric(vertical: 12),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(10),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),

              // Recently Played horizontal list if available
              if (history.isNotEmpty) ...[
                const SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
                    child: Text(
                      'Recently Played',
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
                SliverToBoxAdapter(
                  child: SizedBox(
                    height: 155,
                    child: ListView.builder(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      scrollDirection: Axis.horizontal,
                      itemCount: history.length > 8 ? 8 : history.length,
                      itemBuilder: (context, index) {
                        final track = history[index];
                        final isCurrent = player.currentTrack?.id == track.id;
                        return _buildRecentCard(track, player, isCurrent);
                      },
                    ),
                  ),
                ),
              ],

              // All Songs Header
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'All Songs',
                        style: TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                      Text(
                        _sortLabel(player.currentSort),
                        style: TextStyle(
                          fontSize: 12,
                          color: Colors.grey.shade400,
                        ),
                      ),
                    ],
                  ),
                ),
              ),

              // Loading indicator
              if (player.isLoadingTracks && tracks.isEmpty)
                const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.all(50),
                    child: Center(
                      child: Column(
                        children: [
                          CircularProgressIndicator(),
                          SizedBox(height: 16),
                          Text(
                            'Scanning storage for music files...',
                            style: TextStyle(color: Colors.grey),
                          ),
                        ],
                      ),
                    ),
                  ),
                )
              // Empty State
              else if (tracks.isEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.all(36),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.music_off_rounded, size: 64, color: Colors.grey.shade600),
                        const SizedBox(height: 16),
                        const Text(
                          'No Music Files Found',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Ensure audio files (.mp3, .m4a, .flac, .wav) are saved in your Music or Download folders, then tap Rescan.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.grey.shade400, fontSize: 13),
                        ),
                        const SizedBox(height: 20),
                        OutlinedButton.icon(
                          onPressed: () => player.scanDeviceTracks(),
                          icon: const Icon(Icons.refresh_rounded),
                          label: const Text('Rescan Device'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: primaryColor,
                            side: BorderSide(color: primaryColor),
                          ),
                        ),
                      ],
                    ),
                  ),
                )
              // Track List
              else
                SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final track = tracks[index];
                      final isCurrent = player.currentTrack?.id == track.id;
                      return TrackTile(
                        track: track,
                        isCurrent: isCurrent,
                        onTap: () => player.playTrack(track, newQueue: tracks),
                      );
                    },
                    childCount: tracks.length,
                  ),
                ),

              const SliverToBoxAdapter(child: SizedBox(height: 100)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildRecentCard(Track track, PlayerProvider player, bool isCurrent) {
    return GestureDetector(
      onTap: () => player.playTrack(track),
      child: Container(
        width: 110,
        margin: const EdgeInsets.only(right: 12),
        decoration: BoxDecoration(
          color: const Color(0xFF1E2430),
          borderRadius: BorderRadius.circular(12),
          border: isCurrent
              ? Border.all(color: Theme.of(context).colorScheme.primary, width: 1.5)
              : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ClipRRect(
              borderRadius: const BorderRadius.vertical(top: Radius.circular(12)),
              child: SizedBox(
                width: 110,
                height: 95,
                child: track.audioId != null
                    ? QueryArtworkWidget(
                        id: track.audioId!,
                        type: ArtworkType.AUDIO,
                        artworkWidth: 110,
                        artworkHeight: 95,
                        artworkFit: BoxFit.cover,
                        nullArtworkWidget: Container(
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
            Padding(
              padding: const EdgeInsets.all(6.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    track.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                      color: isCurrent
                          ? Theme.of(context).colorScheme.primary
                          : Colors.white,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    track.artist,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 10,
                      color: Colors.grey.shade400,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
