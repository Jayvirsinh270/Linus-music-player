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
  bool _isLoading = true;

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
    _loadRecommendations();
  }

  Future<void> _loadRecommendations() async {
    setState(() => _isLoading = true);
    final picks = await widget.recEngine.getSuggestedPicks();
    if (mounted) {
      setState(() {
        _suggestedTracks = picks;
        _isLoading = false;
      });
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
          onRefresh: _loadRecommendations,
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
                        onPressed: _loadRecommendations,
                      ),
                    ],
                  ),
                ),
              ),

              if (_isLoading)
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
                        'Play a few songs to get personalized suggestions!',
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
}
