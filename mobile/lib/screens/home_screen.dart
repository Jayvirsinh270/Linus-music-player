import 'dart:async';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/track.dart';
import '../providers/player_provider.dart';
import '../services/recommendation_engine.dart';
import '../services/youtube_service.dart';
import '../widgets/track_tile.dart';

class HomeScreen extends StatefulWidget {
  final YouTubeService ytService;
  final RecommendationEngine recEngine;

  const HomeScreen({
    super.key,
    required this.ytService,
    required this.recEngine,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<Track> _suggestedTracks = [];
  List<Track> _trendingTracks = [];
  bool _isLoading = true;
  StreamSubscription<String>? _errorSub;

  final List<String> _quickVibes = [
    'Chill Lofi',
    'Trending Hits',
    'Acoustic Pop',
    'Deep Focus',
    'Rock Classics',
    'Synthwave Vibes',
  ];

  @override
  void initState() {
    super.initState();
    _loadAllContent();

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

  Future<void> _loadAllContent() async {
    setState(() => _isLoading = true);
    try {
      final results = await Future.wait([
        widget.recEngine.getSuggestedPicks(),
        widget.ytService.getTrendingTracks(),
      ]);

      if (mounted) {
        setState(() {
          _suggestedTracks = results[0];
          _trendingTracks = results[1];
          _isLoading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  Future<void> _playVibe(String vibe) async {
    final player = context.read<PlayerProvider>();
    setState(() => _isLoading = true);
    final tracks = await widget.ytService.searchTracks('$vibe Music');
    if (tracks.isNotEmpty && mounted) {
      await player.playTrack(tracks.first, newQueue: tracks);
    }
    if (mounted) {
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();
    final history = widget.recEngine.recentHistory;

    return Scaffold(
      backgroundColor: const Color(0xFF10141D),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _loadAllContent,
          color: Theme.of(context).colorScheme.primary,
          child: CustomScrollView(
            slivers: [
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 20, 20, 10),
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(8),
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.primary.withOpacity(0.15),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Icon(
                          Icons.headphones_rounded,
                          color: Theme.of(context).colorScheme.primary,
                          size: 26,
                        ),
                      ),
                      const SizedBox(width: 12),
                      const Text(
                        'Linus',
                        style: TextStyle(
                          fontSize: 24,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                          letterSpacing: -0.5,
                        ),
                      ),
                    ],
                  ),
                ),
              ),

              // Quick Vibes Chips
              SliverToBoxAdapter(
                child: SizedBox(
                  height: 48,
                  child: ListView.separated(
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    scrollDirection: Axis.horizontal,
                    itemCount: _quickVibes.length,
                    separatorBuilder: (_, __) => const SizedBox(width: 8),
                    itemBuilder: (context, index) {
                      final vibe = _quickVibes[index];
                      return ActionChip(
                        label: Text(vibe),
                        labelStyle: const TextStyle(fontSize: 13, color: Colors.white70),
                        backgroundColor: const Color(0xFF1E2430),
                        side: BorderSide.none,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(20),
                        ),
                        onPressed: () => _playVibe(vibe),
                      );
                    },
                  ),
                ),
              ),

              // Trending Section Carousel
              if (_trendingTracks.isNotEmpty) ...[
                const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(20, 24, 20, 12),
                    child: Text(
                      'Trending Today',
                      style: TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
                SliverToBoxAdapter(
                  child: SizedBox(
                    height: 205,
                    child: ListView.builder(
                      padding: const EdgeInsets.symmetric(horizontal: 20),
                      scrollDirection: Axis.horizontal,
                      itemCount: _trendingTracks.length,
                      itemBuilder: (context, index) {
                        final track = _trendingTracks[index];
                        final isCurrent = player.currentTrack?.id == track.id;
                        return _buildTrendingCard(track, _trendingTracks, player, isCurrent);
                      },
                    ),
                  ),
                ),
              ],

              const SliverToBoxAdapter(child: SizedBox(height: 20)),

              // Suggested For You Section
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Suggested For You',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.refresh, color: Colors.grey, size: 20),
                        onPressed: _loadAllContent,
                      ),
                    ],
                  ),
                ),
              ),

              if (_isLoading && _suggestedTracks.isEmpty)
                const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.all(40),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                )
              else if (_suggestedTracks.isEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Center(
                      child: Text(
                        'Play songs or search to discover personalized tracks!',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.grey.shade400),
                      ),
                    ),
                  ),
                )
              else
                SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final track = _suggestedTracks[index];
                      final isCurrent = player.currentTrack?.id == track.id;
                      return TrackTile(
                        track: track,
                        isCurrent: isCurrent,
                        onTap: () => player.playTrack(
                          track,
                          newQueue: _suggestedTracks,
                        ),
                      );
                    },
                    childCount: _suggestedTracks.length,
                  ),
                ),

              // Recently Played Section (if any)
              if (history.isNotEmpty) ...[
                const SliverToBoxAdapter(
                  child: Padding(
                    padding: EdgeInsets.fromLTRB(20, 24, 20, 8),
                    child: Text(
                      'Recently Played',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
                SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final track = history[index];
                      final isCurrent = player.currentTrack?.id == track.id;
                      return TrackTile(
                        track: track,
                        isCurrent: isCurrent,
                        onTap: () => player.playTrack(track),
                      );
                    },
                    childCount: history.length > 10 ? 10 : history.length,
                  ),
                ),
              ],

              const SliverToBoxAdapter(child: SizedBox(height: 100)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildTrendingCard(
    Track track,
    List<Track> playlist,
    PlayerProvider player,
    bool isCurrent,
  ) {
    return GestureDetector(
      onTap: () => player.playTrack(track, newQueue: playlist),
      child: Container(
        width: 140,
        margin: const EdgeInsets.only(right: 12),
        decoration: BoxDecoration(
          color: const Color(0xFF1E2430),
          borderRadius: BorderRadius.circular(14),
          border: isCurrent
              ? Border.all(color: Theme.of(context).colorScheme.primary, width: 1.5)
              : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ClipRRect(
              borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
              child: AspectRatio(
                aspectRatio: 1,
                child: track.thumbnailUrl.isNotEmpty
                    ? CachedNetworkImage(
                        imageUrl: track.thumbnailUrl,
                        fit: BoxFit.cover,
                        placeholder: (_, __) => Container(color: Colors.grey.shade900),
                        errorWidget: (_, __, ___) => Container(
                          color: Colors.grey.shade900,
                          child: const Icon(Icons.music_note, color: Colors.grey),
                        ),
                      )
                    : Container(color: Colors.grey.shade900),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(8.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    track.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
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
                      fontSize: 11,
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
