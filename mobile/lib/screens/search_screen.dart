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
                child: Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.search_rounded,
                        size: 64,
                        color: Colors.grey.shade700,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        _controller.text.isEmpty
                            ? 'Search any music on YouTube'
                            : 'No songs found',
                        style: TextStyle(
                          color: Colors.grey.shade500,
                          fontSize: 16,
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
