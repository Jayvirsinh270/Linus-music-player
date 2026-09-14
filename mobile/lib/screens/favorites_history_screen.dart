import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/player_provider.dart';
import '../services/recommendation_engine.dart';
import '../widgets/track_tile.dart';

class FavoritesHistoryScreen extends StatelessWidget {
  final RecommendationEngine recEngine;

  const FavoritesHistoryScreen({super.key, required this.recEngine});

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();
    final favorites = player.favorites;
    final history = recEngine.recentHistory;

    return DefaultTabController(
      length: 2,
      child: Scaffold(
        backgroundColor: const Color(0xFF10141D),
        appBar: AppBar(
          backgroundColor: const Color(0xFF10141D),
          elevation: 0,
          title: const Text(
            'Library',
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.bold,
              color: Colors.white,
            ),
          ),
          bottom: TabBar(
            indicatorColor: Theme.of(context).colorScheme.primary,
            labelColor: Theme.of(context).colorScheme.primary,
            unselectedLabelColor: Colors.grey,
            tabs: [
              Tab(text: 'Favorites (${favorites.length})'),
              Tab(text: 'History (${history.length})'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            // Favorites Tab
            favorites.isEmpty
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.favorite_border_rounded, size: 64, color: Colors.grey.shade700),
                        const SizedBox(height: 12),
                        Text(
                          'No favorite songs yet',
                          style: TextStyle(color: Colors.grey.shade500, fontSize: 16),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.only(bottom: 100, top: 8),
                    itemCount: favorites.length,
                    itemBuilder: (context, index) {
                      final track = favorites[index];
                      final isCurrent = player.currentTrack?.id == track.id;
                      return TrackTile(
                        track: track,
                        isCurrent: isCurrent,
                        onTap: () => player.playTrack(track, newQueue: favorites),
                      );
                    },
                  ),

            // History Tab
            history.isEmpty
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.history_rounded, size: 64, color: Colors.grey.shade700),
                        const SizedBox(height: 12),
                        Text(
                          'No listening history yet',
                          style: TextStyle(color: Colors.grey.shade500, fontSize: 16),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.only(bottom: 100, top: 8),
                    itemCount: history.length,
                    itemBuilder: (context, index) {
                      final track = history[index];
                      final isCurrent = player.currentTrack?.id == track.id;
                      return TrackTile(
                        track: track,
                        isCurrent: isCurrent,
                        onTap: () => player.playTrack(track),
                      );
                    },
                  ),
          ],
        ),
      ),
    );
  }
}
