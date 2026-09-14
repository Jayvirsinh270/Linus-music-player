import 'package:audio_service/audio_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'providers/player_provider.dart';
import 'screens/main_navigation_screen.dart';
import 'services/audio_handler.dart';
import 'services/recommendation_engine.dart';
import 'services/youtube_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Set system bar styling
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Color(0xFF161B26),
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );

  final ytService = YouTubeService();
  final recEngine = RecommendationEngine(ytService);
  await recEngine.init();

  // Initialize Android background AudioService
  final audioHandler = await AudioService.init(
    builder: () => LinusAudioHandler(ytService),
    config: const AudioServiceConfig(
      androidNotificationChannelId: 'com.linus.musicplayer.audio',
      androidNotificationChannelName: 'Linus Music Playback',
      androidNotificationOngoing: true,
      androidStopForegroundOnPause: true,
    ),
  );

  runApp(LinusApp(
    audioHandler: audioHandler,
    ytService: ytService,
    recEngine: recEngine,
  ));
}

class LinusApp extends StatelessWidget {
  final LinusAudioHandler audioHandler;
  final YouTubeService ytService;
  final RecommendationEngine recEngine;

  const LinusApp({
    super.key,
    required this.audioHandler,
    required this.ytService,
    required this.recEngine,
  });

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => PlayerProvider(audioHandler, recEngine),
      child: MaterialApp(
        title: 'Linus',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          useMaterial3: true,
          brightness: Brightness.dark,
          scaffoldBackgroundColor: const Color(0xFF10141D),
          colorScheme: const ColorScheme.dark(
            primary: Color(0xFF2DD4BF), // Teal accent
            secondary: Color(0xFF38BDF8), // Sky blue accent
            surface: Color(0xFF161B26),
          ),
          fontFamily: 'Roboto',
        ),
        home: MainNavigationScreen(
          ytService: ytService,
          recEngine: recEngine,
        ),
      ),
    );
  }
}
