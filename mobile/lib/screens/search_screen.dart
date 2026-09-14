import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/track.dart';
import '../providers/player_provider.dart';
import '../services/local_audio_service.dart';
import '../widgets/track_tile.dart';

class SearchScreen extends StatefulWidget {
  final LocalAudioService localAudioService;

  const SearchScreen({super.key, required this.localAudioService});

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _controller = TextEditingController();
  String _searchQuery = '';

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onSearchChanged(String query) {
    setState(() {
      _searchQuery = query.trim();
    });
  }

  void _selectArtist(String artist) {
    _controller.text = artist;
    _onSearchChanged(artist);
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();
    final allTracks = player.deviceTracks;
    final primaryColor = Theme.of(context).colorScheme.primary;

    // Filter results locally
    final results = _searchQuery.isEmpty
        ? <Track>[]
        : widget.localAudioService.searchTracks(allTracks, _searchQuery);

    // Extract unique artists for quick discovery tags
    final artistsSet = <String>{};
    for (final t in allTracks) {
      if (t.artist.isNotEmpty &&
          t.artist.toLowerCase() != '<unknown>' &&
          t.artist.toLowerCase() != 'unknown') {
        artistsSet.add(t.artist);
      }
    }
    final topArtists = artistsSet.take(12).toList();

    return Scaffold(
      backgroundColor: const Color(0xFF10141D),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Search Input Field
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: TextField(
                controller: _controller,
                onChanged: _onSearchChanged,
                style: const TextStyle(color: Colors.white),
                decoration: InputDecoration(
                  hintText: 'Search songs, artists, albums...',
                  hintStyle: TextStyle(color: Colors.grey.shade500),
                  prefixIcon: const Icon(Icons.search, color: Colors.grey),
                  suffixIcon: _controller.text.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear, color: Colors.grey),
                          onPressed: () {
                            _controller.clear();
                            _onSearchChanged('');
                          },
                        )
                      : null,
                  filled: true,
                  fillColor: const Color(0xFF1E2430),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide.none,
                  ),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                ),
              ),
            ),

            // Content Area
            if (_searchQuery.isEmpty)
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (topArtists.isNotEmpty) ...[
                        const Text(
                          'Artists in Library',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Wrap(
                          spacing: 8,
                          runSpacing: 10,
                          children: topArtists.map((artist) {
                            return ActionChip(
                              avatar: CircleAvatar(
                                backgroundColor: primaryColor.withOpacity(0.2),
                                child: Text(
                                  artist.isNotEmpty ? artist[0].toUpperCase() : '?',
                                  style: TextStyle(fontSize: 12, color: primaryColor),
                                ),
                              ),
                              label: Text(artist),
                              labelStyle: const TextStyle(
                                color: Colors.white,
                                fontSize: 13,
                                fontWeight: FontWeight.w500,
                              ),
                              backgroundColor: const Color(0xFF1E2430),
                              side: BorderSide(
                                color: primaryColor.withOpacity(0.2),
                              ),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(20),
                              ),
                              onPressed: () => _selectArtist(artist),
                            );
                          }).toList(),
                        ),
                        const SizedBox(height: 28),
                      ],
                      Center(
                        child: Column(
                          children: [
                            Icon(
                              Icons.manage_search_rounded,
                              size: 56,
                              color: Colors.grey.shade700,
                            ),
                            const SizedBox(height: 10),
                            Text(
                              'Type song name, artist, or album',
                              style: TextStyle(
                                color: Colors.grey.shade500,
                                fontSize: 14,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              '${allTracks.length} tracks indexed on device',
                              style: TextStyle(
                                color: Colors.grey.shade600,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              )
            else if (results.isEmpty)
              Expanded(
                child: Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.search_off_rounded, size: 56, color: Colors.grey.shade700),
                      const SizedBox(height: 12),
                      Text(
                        'No songs found for "$_searchQuery"',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: Colors.white70,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'Check the spelling or try searching another term',
                        style: TextStyle(color: Colors.grey.shade500, fontSize: 13),
                      ),
                    ],
                  ),
                ),
              )
            else
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
                      child: Text(
                        '${results.length} results found',
                        style: TextStyle(
                          color: Colors.grey.shade400,
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                    Expanded(
                      child: ListView.builder(
                        itemCount: results.length,
                        padding: const EdgeInsets.only(bottom: 100),
                        itemBuilder: (context, index) {
                          final track = results[index];
                          final isCurrent = player.currentTrack?.id == track.id;
                          return TrackTile(
                            track: track,
                            isCurrent: isCurrent,
                            onTap: () => player.playTrack(
                              track,
                              newQueue: results,
                            ),
                          );
                        },
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
