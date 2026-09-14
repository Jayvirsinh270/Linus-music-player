import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/track.dart';
import '../providers/player_provider.dart';
import '../services/youtube_service.dart';
import '../widgets/track_tile.dart';

class SearchScreen extends StatefulWidget {
  final YouTubeService ytService;

  const SearchScreen({super.key, required this.ytService});

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _controller = TextEditingController();
  List<Track> _results = [];
  bool _isSearching = false;
  Timer? _debounceTimer;

  void _onSearchChanged(String query) {
    _debounceTimer?.cancel();
    if (query.trim().isEmpty) {
      setState(() {
        _results = [];
        _isSearching = false;
      });
      return;
    }

    _debounceTimer = Timer(const Duration(milliseconds: 600), () {
      _executeSearch(query.trim());
    });
  }

  Future<void> _executeSearch(String query) async {
    if (query.isEmpty) return;
    setState(() => _isSearching = true);

    final tracks = await widget.ytService.searchTracks(query);
    if (mounted) {
      setState(() {
        _results = tracks;
        _isSearching = false;
      });
    }
  }

  final List<String> _popularKeywords = [
    'Top Global Hits',
    'Trending Pop',
    'Lofi Chill Beats',
    'Hip-Hop Classics',
    'Workout EDM',
    'Acoustic Covers',
    'Synthwave 80s',
    'Bollywood Melodies',
    'Piano Peace',
    'Rock Anthems',
  ];

  void _searchPopular(String query) {
    _controller.text = query;
    _executeSearch(query);
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final player = context.watch<PlayerProvider>();

    return Scaffold(
      backgroundColor: const Color(0xFF10141D),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.all(16.0),
              child: TextField(
                controller: _controller,
                onChanged: _onSearchChanged,
                onSubmitted: _executeSearch,
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
            if (_isSearching)
              const Expanded(
                child: Center(
                  child: CircularProgressIndicator(),
                ),
              )
            else if (_results.isEmpty)
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const SizedBox(height: 10),
                      Text(
                        _controller.text.isEmpty
                            ? 'Popular Searches & Discover'
                            : 'No songs found for "${_controller.text}"',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(height: 14),
                      Wrap(
                        spacing: 8,
                        runSpacing: 10,
                        children: _popularKeywords.map((keyword) {
                          return ActionChip(
                            label: Text(keyword),
                            labelStyle: const TextStyle(
                              color: Colors.white,
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                            backgroundColor: const Color(0xFF1E2430),
                            side: BorderSide(
                              color: Theme.of(context).colorScheme.primary.withOpacity(0.2),
                            ),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(20),
                            ),
                            onPressed: () => _searchPopular(keyword),
                          );
                        }).toList(),
                      ),
                      const SizedBox(height: 30),
                      if (_controller.text.isEmpty)
                        Center(
                          child: Column(
                            children: [
                              Icon(
                                Icons.music_note_rounded,
                                size: 54,
                                color: Colors.grey.shade700,
                              ),
                              const SizedBox(height: 10),
                              Text(
                                'Tap any topic above or type in the search bar',
                                style: TextStyle(
                                  color: Colors.grey.shade500,
                                  fontSize: 13,
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              )
            else
              Expanded(
                child: ListView.builder(
                  itemCount: _results.length,
                  padding: const EdgeInsets.only(bottom: 100),
                  itemBuilder: (context, index) {
                    final track = _results[index];
                    final isCurrent = player.currentTrack?.id == track.id;
                    return TrackTile(
                      track: track,
                      isCurrent: isCurrent,
                      onTap: () => player.playTrack(
                        track,
                        newQueue: _results,
                      ),
                    );
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}
