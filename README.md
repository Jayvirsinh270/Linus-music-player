# Linus

Linus is a personal music library and player for Android and desktop. It helps people bring together music they already own, discover it quickly, build playlists, listen in the background, and read lyrics. Built with Flutter and Python.

> 💡 Don't let anyone know you can also play music directly from YouTube!

## Product Promise

Linus should feel calm, fast, personal, and visual. Opening the app should immediately answer three questions:

- **What can I play now?** — Quick access to your library
- **What was I listening to recently?** — Resume your listening history
- **What should I play next?** — Smart playlist suggestions

## Key Features

### Music Library Management
- **Import Music** — Add music from folders or individual files
- **Metadata Reading** — Automatically read embedded metadata (artist, album, duration, etc.)
- **Album Artwork** — Display album covers and visual elements
- **Search** — Quickly search your local library by artist, album, or track name

### Playback & Control
- **Audio Playback** — High-quality audio playback with controls
- **Queue Management** — Organize and manage your play queue
- **Seek & Duration** — Jump to any point in a track
- **Shuffle & Repeat** — Shuffle mode and repeat controls (one track, playlist, all)
- **Background Playback** — Listen while using other apps

### Playlists & Favorites
- **Create Playlists** — Organize songs into custom playlists
- **Save Favorites** — Mark your favorite tracks
- **Listening History** — Track what you've listened to

### Lyrics & Content
- **Local Lyrics** — Display embedded lyrics from your files
- **Approved Provider Lyrics** — Show lyrics from trusted sources with proper attribution
- **Media Management** — Import or download permitted media through a separate workflow

### Cross-Platform Support
- **Android** — Full-featured mobile app
- **Windows Desktop** — Desktop version
- **Unified Codebase** — Both built from one Flutter codebase

## First Release Focus

The initial release concentrates on user-owned local media:
- Local file imports and library management
- Playback controls and queue management
- Playlist creation and management
- Lyrics display
- Cross-platform compatibility (Android & Windows)

**Note:** Online catalog streaming is intentionally planned for a later release and requires careful consideration of provider terms, licensing, and credentials.

## Getting Started

### Prerequisites
- Python 3.8+
- Flask
- Flutter (for mobile/desktop compilation)
- MySQL/XAMPP (optional, for metadata database)

### Installation & Running

1. **Clone the repository**
   ```bash
   git clone https://github.com/<your-username>/linus-player.git
   cd linus-player
   ```

2. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Start the application**
   ```bash
   python main.py
   ```
   This will start the Flask web server and automatically open Linus in your browser.

### Project Structure

- **`main.py`** — Entry point; starts the Flask server and opens the app
- **`web_app.py`** — Local API server providing backend functionality
- **`templates/`** — Web UI templates (HTML)
- **`static/`** — Static assets (CSS, JavaScript, images)
- **`birthday/index.html`** — Independent demo or special features

## How to Use

### Importing Music

1. Open Linus in your browser (default: `http://localhost:5000`)
2. Click **"Import Music"**
3. Select a folder containing your music files or individual tracks
4. Linus will scan, read metadata, and add songs to your library

### Playing Music

1. Navigate to **"Library"** or **"Browse"**
2. Click on any track to play
3. Use playback controls:
   - ⏸️ Play/Pause
   - ⏭️ Next Track
   - ⏮️ Previous Track
   - 🔀 Shuffle
   - 🔁 Repeat (None → One → All)

### Creating Playlists

1. Go to **"Playlists"**
2. Click **"Create Playlist"**
3. Name your playlist
4. Click on tracks and select **"Add to Playlist"**
5. Click **"Save"**

### Viewing Lyrics

1. While a track is playing, click **"Lyrics"** (if available)
2. Lyrics appear if:
   - Embedded in the track file
   - Available from approved lyrics providers
3. Scroll through lyrics as the track plays

### Accessing Your Listening History

1. Go to **"History"** or **"Recently Played"**
2. View all tracks you've played in chronological order
3. Click to resume any track

### Managing Favorites

1. Click the **❤️ Heart icon** on any track to add to favorites
2. Go to **"Favorites"** to view all saved tracks
3. Create playlists from favorite tracks

## Database Setup (Optional)

For enhanced metadata management using MySQL:
- See [XAMPP MySQL Setup](docs/MYSQL.md)
- Improves search and organization for large libraries

## Documentation

- **[Product Idea](docs/PRODUCT.md)** — Target audience, user experience, and feature scope
- **[Visual Design](docs/DESIGN.md)** — Visual language, UI design rules, and component guidelines
- **[Architecture](docs/ARCHITECTURE.md)** — Application structure, technical stack, and design decisions
- **[Development Guide](docs/DEVELOPMENT.md)** — Setup instructions, build commands, and development workflow
- **[Database Setup](docs/MYSQL.md)** — XAMPP MySQL configuration and metadata management
- **[Roadmap](docs/ROADMAP.md)** — Step-by-step delivery plan and feature priorities
- **[Privacy & Content](docs/PRIVACY.md)** — Local files handling, lyrics sources, downloads, and provider policies

## Supported File Formats

- **MP3** — .mp3
- **FLAC** — .flac
- **OGG** — .ogg
- **WAV** — .wav
- **AAC** — .m4a, .aac
- **ALAC** — .alac

## Troubleshooting

### App won't start
- Ensure Python 3.8+ is installed
- Check that port 5000 is not in use
- Try: `python main.py` in the project directory

### Music won't import
- Verify files are in a supported format
- Check that folder permissions allow reading
- Ensure files have valid metadata

### No lyrics displaying
- Verify lyrics are embedded in track files, or
- Check that you're using an approved lyrics provider
- See [Privacy & Content](docs/PRIVACY.md) for provider details

### Performance issues with large library
- Set up MySQL database for better performance
- See [Database Setup](docs/MYSQL.md)

## Contributing

To contribute to Linus:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

See [Development Guide](docs/DEVELOPMENT.md) for detailed workflow.

## License

[Add your license here if not already specified]

## Support

For issues, feature requests, or questions:
- Open an issue on GitHub
- Check existing documentation in `/docs`
- Review the [Development Guide](docs/DEVELOPMENT.md)

**Enjoy your personal music experience with Linus!** 🎵

