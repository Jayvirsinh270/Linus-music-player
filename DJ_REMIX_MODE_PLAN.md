# Linus DJ Remix Mode — Architecture & Implementation Plan

This document provides a comprehensive technical blueprint for integrating a professional **DJ Remix Mode** into the Linus Music Player.

---

## 1. System Overview

The **DJ Remix Mode** transforms Linus into a dual-deck creative workstation while preserving the clean, serene aesthetic of the standard listening player.

### Core Capabilities
* **Dual Virtual Decks (Deck A & Deck B):** Load any two tracks from your Linus library simultaneously.
* **Pro Virtual Mixer:** Gain/Trim, 3-band Isolator EQ (with Full Kill), Bi-directional resonant Sound Color Filter (HPF/LPF), Channel Upfaders, and Crossfader with selectable curves (Smooth, Linear, Scratch Cut).
* **BPM Detection & Beat Sync:** Instant tempo matching and phase alignment.
* **Performance Tools:** 4 Hot Cue pads per deck, beat-synced looping ($1/4$ to $16$ beats), and a 6-pad DJ drop sampler.
* **Master FX Rack:** Synchronized Echo/Delay, Reverb, Flanger, and Beat Roll / Stutter.
* **Live Set Recording:** Direct audio capture via the Web Audio / MediaRecorder API to save your mixes into your Linus library.
* **Hardware MIDI Controller Support:** Web MIDI API integration for plug-and-play USB DJ controllers (Pioneer DDJ-400 / DDJ-FLX4, Numark, etc.) + ergonomic keyboard shortcuts.

---

## 2. Web Audio API Engine Architecture

Standard playback in Linus operates on a single `<audio id="audio">` tag. The DJ Remix Mode runs on an isolated **Web Audio API (`AudioContext`)** graph.

### Audio Graph Topology

```
Deck A Audio Element / Buffer
  │
  ├──> Low Shelf Filter (EQ Low: 300 Hz)
  │      └──> Peaking Filter (EQ Mid: 1000 Hz)
  │             └──> High Shelf Filter (EQ High: 3500 Hz)
  │                    └──> Biquad Filter (Color Filter: HPF / LPF)
  │                           │
  │                           ├──> Channel A Gain (Trim & Upfader)
  │                           │      │
  │                           │      └──> Crossfader A GainNode
  │                           │             │
  │                           │             └──> Master Summing Bus
  │                           │
  │                           └──> PFL / Cue Tap ──> Headphone Monitor Bus (Split Cue)

Deck B Audio Element / Buffer (Mirrored Chain)
  │
  └──> (Mirrored EQ -> Filter -> Channel B Gain -> Crossfader B Gain) ──> Master Summing Bus

Master Summing Bus
  │
  ├──> Master FX Unit (Echo/Delay, Reverb, Flanger, Beat Roll)
  │      └──> Master Volume GainNode
  │             │
  │             ├──> audioContext.destination (Speakers / Main Output)
  │             └──> MediaStreamAudioDestinationNode (Live Set Recording via MediaRecorder)
```

### Audio Filter Specifications
1. **EQ Low:** `BiquadFilterNode` (`type: "lowshelf"`, `frequency: 300`, gain: $-\infty\text{ dB}$ to $+6\text{ dB}$).
2. **EQ Mid:** `BiquadFilterNode` (`type: "peaking"`, `frequency: 1000`, `Q: 1.0`, gain: $-\infty\text{ dB}$ to $+6\text{ dB}$).
3. **EQ High:** `BiquadFilterNode` (`type: "highshelf"`, `frequency: 3500`, gain: $-\infty\text{ dB}$ to $+6\text{ dB}$).
4. **Sound Color Filter:** Single center-detented knob:
   * Left ($< 0$): Low-Pass Filter sweeping down from $20000\text{ Hz}$ to $100\text{ Hz}$ ($Q: 2.5$).
   * Right ($> 0$): High-Pass Filter sweeping up from $20\text{ Hz}$ to $10000\text{ Hz}$ ($Q: 2.5$).
   * Center ($= 0$): Bypassed.
5. **Crossfader Curves:**
   * **Smooth / Constant Power:** $G_A = \cos\left(\frac{(x+1)\pi}{4}\right)$, $G_B = \sin\left(\frac{(x+1)\pi}{4}\right)$ where $x \in [-1, 1]$.
   * **Linear:** $G_A = \max(0, -0.5x + 0.5)$, $G_B = \max(0, 0.5x + 0.5)$.
   * **Scratch Cut:** Full volume across $> 95\%$ of travel, cutting to silence within the last $5\%$ boundary.

---

## 3. UI Console Layout (`dj-studio` View)

```
+---------------------------------------------------------------------------------------------------------+
| [LINUS DJ REMIX STUDIO]                                       [REC ●] [MIDI Status: Connected] [Exit]   |
+---------------------------------------------------------------------------------------------------------+
|  [ DECK A: THE NIGHTS - AVICII ]                      |  [ DECK B: WAKE ME UP - AVICII ]                |
|  BPM: 126.0 (0.0%) | Key: 8A | Time: 02:14 / 03:10    |  BPM: 124.0 (+1.6%) | Key: 8A | Time: 00:32 / 04:05   |
|  +-------------------------------------------------+  |  +--------------------------------------------+ |
|  | ~~~~/\~/\~||~/~~/\~~/~~/~~/\~ (Waveform Deck A) |  |  | ~~~~/~/\~/\~~/~~/\~~||~~/\~ (Waveform Deck B)| |
|  +-------------------------------------------------+  |  +--------------------------------------------+ |
|  [SYNC] [CUE] [PLAY/PAUSE]   Pitch Slider: [-==--]    |  [SYNC] [CUE] [PLAY/PAUSE]   Pitch Slider: [--==-]|
|  Hot Cues: [1] [2] [3] [4]   Loop: [1/2] [1] [2] [4]  |  Hot Cues: [1] [2] [3] [4]   Loop: [1/2] [1] [2] [4]|
+-------------------------------------------------------+-------------------------------------------------+
|                                    CENTRAL MIXER SECTION                                                |
|       CH 1 (Deck A)                                                     CH 2 (Deck B)                   |
|       [ ( ) ] GAIN / TRIM                                               [ ( ) ] GAIN / TRIM             |
|       [ ( ) ] HI EQ                                                     [ ( ) ] HI EQ                   |
|       [ ( ) ] MID EQ                                                    [ ( ) ] MID EQ                  |
|       [ ( ) ] LOW EQ (Kill)                                             [ ( ) ] LOW EQ (Kill)           |
|       [ ( ) ] COLOR FILTER (LPF/HPF)                                    [ ( ) ] COLOR FILTER (LPF/HPF)  |
|       [CUE/PFL]                                                         [CUE/PFL]                       |
|       |  ▲  | Level Fader 1                                             |  ▲  | Level Fader 2           |
|       |  █  |                                                           |  █  |                         |
|       |  ▼  | [VU Meters: ▮▮▮▯]                                         |  ▼  | [VU Meters: ▮▮▯▯]       |
+---------------------------------------------------------------------------------------------------------+
|  MASTER FX RACK: [ECHO] [REVERB] [FLANGER] [BEAT ROLL] | Beat: [1/4] [1/2] [1/1] | Dry/Wet: [ ( ) ]     |
|  SAMPLE PADS (DJ DROPS): [AIRHORN] [SIREN] [LASER] [SUB DROP] [808 CLAP] [VINYL SCRATCH]                |
+---------------------------------------------------------------------------------------------------------+
|                                    CROSSFADER SECTION                                                   |
|                        Curve: [Smooth ▼]   [ A <==========[ ■ ]==========> B ]                          |
+---------------------------------------------------------------------------------------------------------+
```

---

## 4. Backend & Database Enhancements

### Database Schema Updates (`linus.db`)
```sql
ALTER TABLE tracks ADD COLUMN bpm REAL DEFAULT 0.0;
ALTER TABLE tracks ADD COLUMN initial_key TEXT DEFAULT '';
ALTER TABLE tracks ADD COLUMN beatgrid_offset REAL DEFAULT 0.0;
ALTER TABLE tracks ADD COLUMN waveform_peaks TEXT DEFAULT '[]';
```

### New API Endpoints (`web_app.py`)
1. **`GET /api/dj/analyze/<track_id>`**: Computes or retrieves BPM, musical key, beatgrid downbeat offset, and normalized waveform peak array.
2. **`POST /api/dj/save-recording`**: Saves recorded DJ mixes directly to the library folder and updates track metadata.

---

## 5. Web MIDI API Controller Support

Integrate `navigator.requestMIDIAccess()` in `dj_engine.js` with standard CC mappings:
* **Play / Cue / Sync / Cues 1-4:** NoteOn / NoteOff
* **Hi / Mid / Low EQ & Color Filter:** CC 16-19
* **Gain & Upfaders:** CC 20-21
* **Crossfader:** CC 22
* **Pitch Slider:** CC 23
* **Jog Wheel Scrub & Scratch:** Pitch Bend / High-resolution CC

---

## 6. Step-by-Step Implementation Roadmap

1. **Phase 1 (Core Web Audio Engine):** Create `static/dj_engine.js` implementing dual deck nodes, 3-band EQs, resonant filters, and gain nodes.
2. **Phase 2 (Mixer & Crossfader):** Implement crossfader curve mathematics, VU meter analyzers, and channel upfaders.
3. **Phase 3 (UI & Waveform Renderer):** Add `dj-studio` tab to `templates/index.html`, render dual 60 FPS HTML5 Canvas waveforms, and track picker modals.
4. **Phase 4 (Performance Tools):** Add 4 Hot Cues, Beat Loops, 6-pad Soundboard, and Master FX (Echo, Reverb, Flanger, Roll).
5. **Phase 5 (BPM Sync & Recording):** Add BPM detection, beat sync, and live mix export via `MediaRecorder`.
6. **Phase 6 (Hardware MIDI):** Connect Web MIDI API and ergonomic keyboard shortcuts.
