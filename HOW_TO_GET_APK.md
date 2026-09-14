# 📱 How to Build and Install Your Android APK

This guide explains how to get your **Linus Music Player APK** onto your Android phone using GitHub Actions (free, automated cloud build — no Android Studio setup required).

---

## Step 1: Push This Code to Your GitHub Account

1. Open your browser and go to [GitHub.com](https://github.com).
2. Click **New Repository** (choose any name, e.g., `linus-music-player`). Keep it Public or Private.
3. Open a terminal / PowerShell in this project folder (`linus-music-player-main`) and run:
   ```bash
   git add .
   git commit -m "feat: Add Flutter mobile music player and GitHub Actions APK builder"
   git branch -M main
   git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>.git
   git push -u origin main
   ```
   *(Replace `<YOUR_USERNAME>` and `<YOUR_REPO_NAME>` with your GitHub username and repo name).*

---

## Step 2: Download the Compiled APK from GitHub

1. Open your repository on GitHub in your phone or PC browser.
2. Click on the **Actions** tab at the top.
3. You will see a workflow running titled **"Build Android APK"**.
4. GitHub will build the APK in ~3 to 4 minutes.
5. Once it completes (green checkmark), click on the completed run.
6. Scroll down to the **Artifacts** section at the bottom of the page.
7. Click **`linus-music-player-apk`** to download the zip file containing your ready-to-install `app-release.apk`!

---

## Step 3: Install the APK on Your Android Phone

1. Transfer or download `app-release.apk` onto your Android phone.
2. Tap the APK file to install it.
3. If Android prompts *"For your security, your phone is not allowed to install unknown apps from this source"*, tap **Settings** and toggle **"Allow from this source"**.
4. Tap **Install** and then open **Linus**!

---

## 🎧 Features Included in Your App:
- **Instant YouTube Search**: Search and stream any song, album, or artist directly on your phone.
- **Background Playback**: Continues playing music when you lock your phone or switch apps.
- **Notification & Lock-Screen Controls**: Play, pause, skip tracks, and scrub through songs directly from your lock-screen.
- **Smart Queue & "Play Next"**: Add songs to queue or tap "Play Next" to insert a song right after the current one.
- **Smart Autoplay Algorithm**: Automatically tracks your listening preferences (completion rate vs. skips) and auto-queues related songs so the music never stops.
