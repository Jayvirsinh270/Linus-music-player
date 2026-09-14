// ============================================================
// Linus — DJ Studio UI Controller (Hardware Simulation & Canvas)
// Interactive 60 FPS Dual Waveforms, Spinning Jog Wheels,
// Rotary Knobs, Crossfader Curves, Hot Cues, Soundboard & Rec
// ============================================================

class DJStudioUI {
  constructor() {
    this.engine = null;
    this.initialized = false;
    this.animationFrame = null;
    this.recInterval = null;
    this.recSeconds = 0;
    this.currentModalDeck = 'A';

    // Jog wheel interaction state
    this.jogState = {
      A: { isDragging: false, lastAngle: 0, rotation: 0 },
      B: { isDragging: false, lastAngle: 0, rotation: 0 }
    };
  }

  init() {
    if (this.initialized) return;
    this.engine = new window.DJAudioEngine();
    this.initialized = true;

    this._bindDOM();
    this._bindKnobs();
    this._bindJogWheels();
    this._bindKeyboardShortcuts();
    this._startRenderLoop();

    // Listen for MIDI updates
    window.addEventListener('dj-midi-status', (e) => {
      const pill = document.querySelector('#dj-midi-pill');
      if (pill) {
        pill.classList.add('connected');
        pill.title = e.detail?.name ? `Connected: ${e.detail.name}` : 'MIDI Controller Connected';
      }
    });

    window.addEventListener('dj-midi-control', (e) => {
      if (e.detail.target === 'crossfader') {
        const slider = document.querySelector('#dj-crossfader');
        if (slider) slider.value = e.detail.value;
      } else if (e.detail.target === 'upfader-a') {
        const slider = document.querySelector('#upfader-a');
        if (slider) slider.value = e.detail.value;
      } else if (e.detail.target === 'upfader-b') {
        const slider = document.querySelector('#upfader-b');
        if (slider) slider.value = e.detail.value;
      }
    });
  }

  _bindDOM() {
    // Deck Load Buttons
    document.querySelector('#btn-load-a')?.addEventListener('click', () => this.openTrackModal('A'));
    document.querySelector('#btn-load-b')?.addEventListener('click', () => this.openTrackModal('B'));

    // Transport A
    document.querySelector('#play-a')?.addEventListener('click', () => {
      this.engine.deckA.togglePlay().then(() => this._updateTransportUI('A'));
    });
    document.querySelector('#cue-a')?.addEventListener('click', () => {
      this.engine.deckA.cue();
      this._updateTransportUI('A');
    });
    document.querySelector('#sync-a')?.addEventListener('click', () => {
      this.engine.syncDecks('B', 'A');
      this._updateBpmUI('A');
    });

    // Transport B
    document.querySelector('#play-b')?.addEventListener('click', () => {
      this.engine.deckB.togglePlay().then(() => this._updateTransportUI('B'));
    });
    document.querySelector('#cue-b')?.addEventListener('click', () => {
      this.engine.deckB.cue();
      this._updateTransportUI('B');
    });
    document.querySelector('#sync-b')?.addEventListener('click', () => {
      this.engine.syncDecks('A', 'B');
      this._updateBpmUI('B');
    });

    // Pitch Sliders & Nudge
    const pitchA = document.querySelector('#pitch-a');
    pitchA?.addEventListener('input', (e) => {
      // 0 to 100 with 50 at center -> 0.84 to 1.16
      const pct = (parseFloat(e.target.value) - 50) / 50; // -1 to +1
      const rate = 1.0 + (pct * 0.16);
      this.engine.deckA.setPitch(rate);
      this._updateBpmUI('A');
    });
    document.querySelector('#pitch-nudge-down-a')?.addEventListener('click', () => this.engine.deckA.nudgePitch(-0.03));
    document.querySelector('#pitch-nudge-up-a')?.addEventListener('click', () => this.engine.deckA.nudgePitch(0.03));
    document.querySelector('#pitch-reset-a')?.addEventListener('click', () => {
      if (pitchA) pitchA.value = 50;
      this.engine.deckA.setPitch(1.0);
      this._updateBpmUI('A');
    });

    const pitchB = document.querySelector('#pitch-b');
    pitchB?.addEventListener('input', (e) => {
      const pct = (parseFloat(e.target.value) - 50) / 50;
      const rate = 1.0 + (pct * 0.16);
      this.engine.deckB.setPitch(rate);
      this._updateBpmUI('B');
    });
    document.querySelector('#pitch-nudge-down-b')?.addEventListener('click', () => this.engine.deckB.nudgePitch(-0.03));
    document.querySelector('#pitch-nudge-up-b')?.addEventListener('click', () => this.engine.deckB.nudgePitch(0.03));
    document.querySelector('#pitch-reset-b')?.addEventListener('click', () => {
      if (pitchB) pitchB.value = 50;
      this.engine.deckB.setPitch(1.0);
      this._updateBpmUI('B');
    });

    // Hot Cues A & B
    for (let i = 0; i < 4; i++) {
      document.querySelector(`#cue-a-${i + 1}`)?.addEventListener('click', (e) => {
        if (e.shiftKey) {
          this.engine.deckA.clearHotCue(i);
          e.currentTarget.classList.remove('set');
          e.currentTarget.querySelector('.cue-pad-time').textContent = 'EMPTY';
        } else {
          this.engine.deckA.jumpHotCue(i);
          this._updateHotCueUI('A', i, e.currentTarget);
        }
      });

      document.querySelector(`#cue-b-${i + 1}`)?.addEventListener('click', (e) => {
        if (e.shiftKey) {
          this.engine.deckB.clearHotCue(i);
          e.currentTarget.classList.remove('set');
          e.currentTarget.querySelector('.cue-pad-time').textContent = 'EMPTY';
        } else {
          this.engine.deckB.jumpHotCue(i);
          this._updateHotCueUI('B', i, e.currentTarget);
        }
      });
    }

    // Loops A & B
    document.querySelectorAll('.loop-btn-a').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const beats = parseFloat(e.currentTarget.dataset.beats);
        document.querySelectorAll('.loop-btn-a').forEach(b => b.classList.remove('active'));
        if (beats === 0) {
          this.engine.deckA.exitLoop();
        } else {
          this.engine.deckA.setLoop(beats);
          e.currentTarget.classList.add('active');
        }
      });
    });

    document.querySelectorAll('.loop-btn-b').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const beats = parseFloat(e.currentTarget.dataset.beats);
        document.querySelectorAll('.loop-btn-b').forEach(b => b.classList.remove('active'));
        if (beats === 0) {
          this.engine.deckB.exitLoop();
        } else {
          this.engine.deckB.setLoop(beats);
          e.currentTarget.classList.add('active');
        }
      });
    });

    // EQ Kill Buttons
    ['low', 'mid', 'high'].forEach(band => {
      document.querySelector(`#kill-${band}-a`)?.addEventListener('click', (e) => {
        const killed = this.engine.deckA.toggleKill(band);
        e.currentTarget.classList.toggle('killed', killed);
      });
      document.querySelector(`#kill-${band}-b`)?.addEventListener('click', (e) => {
        const killed = this.engine.deckB.toggleKill(band);
        e.currentTarget.classList.toggle('killed', killed);
      });
    });

    // Upfaders
    document.querySelector('#upfader-a')?.addEventListener('input', (e) => {
      this.engine.deckA.setUpfader(parseFloat(e.target.value));
    });
    document.querySelector('#upfader-b')?.addEventListener('input', (e) => {
      this.engine.deckB.setUpfader(parseFloat(e.target.value));
    });

    // Crossfader & Curve
    const cf = document.querySelector('#dj-crossfader');
    const cfCurve = document.querySelector('#crossfader-curve-select');
    cf?.addEventListener('input', (e) => {
      this.engine.updateCrossfader(parseFloat(e.target.value));
    });
    cfCurve?.addEventListener('change', (e) => {
      this.engine.updateCrossfader(parseFloat(cf.value), e.target.value);
    });

    // Master Volume
    document.querySelector('#master-vol-knob')?.addEventListener('input', (e) => {
      this.engine.masterGainNode.gain.value = parseFloat(e.target.value);
    });

    // FX Rack Controls
    document.querySelectorAll('.fx-select-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fxType = e.currentTarget.dataset.fx;
        const currentActive = this.engine.setFxType(fxType);
        document.querySelectorAll('.fx-select-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.fx === currentActive);
        });
      });
    });

    document.querySelectorAll('.fx-beat-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fraction = parseFloat(e.currentTarget.dataset.fraction);
        this.engine.setFxBeat(fraction);
        document.querySelectorAll('.fx-beat-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
      });
    });

    document.querySelector('#fx-wetdry')?.addEventListener('input', (e) => {
      this.engine.setFxDryWet(parseFloat(e.target.value));
    });

    // Sampler Pads
    document.querySelectorAll('.sample-pad-btn').forEach(pad => {
      pad.addEventListener('click', (e) => {
        const sample = e.currentTarget.dataset.sample;
        this.engine.triggerSample(sample);
        pad.classList.add('triggered');
        setTimeout(() => pad.classList.remove('triggered'), 180);
      });
    });

    // Recording Controls
    const recBtn = document.querySelector('#dj-rec-btn');
    recBtn?.addEventListener('click', () => {
      if (!this.engine.isRecording) {
        this.engine.startRecording();
        recBtn.classList.add('recording');
        recBtn.querySelector('.rec-text').textContent = '00:00';
        this.recSeconds = 0;
        this.recInterval = setInterval(() => {
          this.recSeconds++;
          const mins = String(Math.floor(this.recSeconds / 60)).padStart(2, '0');
          const secs = String(this.recSeconds % 60).padStart(2, '0');
          recBtn.querySelector('.rec-text').textContent = `${mins}:${secs}`;
        }, 1000);
      } else {
        clearInterval(this.recInterval);
        recBtn.classList.remove('recording');
        recBtn.querySelector('.rec-text').textContent = 'REC ●';
        this.engine.stopRecording().then((blob) => {
          if (blob) this._promptSaveRecording(blob);
        });
      }
    });

    // Track Picker Modal Close
    document.querySelector('#dj-modal-close')?.addEventListener('click', () => {
      document.querySelector('#dj-track-modal').classList.add('hidden');
    });
    document.querySelector('#dj-track-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'dj-track-modal') {
        document.querySelector('#dj-track-modal').classList.add('hidden');
      }
    });
    document.querySelector('#dj-modal-search-input')?.addEventListener('input', (e) => {
      this._filterModalTracks(e.target.value);
    });
  }

  _updateTransportUI(deckId) {
    const deck = deckId === 'A' ? this.engine.deckA : this.engine.deckB;
    const playBtn = document.querySelector(`#play-${deckId.toLowerCase()}`);
    if (playBtn) {
      playBtn.classList.toggle('playing', !deck.audio.paused);
      const icon = playBtn.querySelector('i');
      if (icon) {
        icon.className = deck.audio.paused ? 'ph-bold ph-play' : 'ph-bold ph-pause';
      }
    }
  }

  _updateBpmUI(deckId) {
    const deck = deckId === 'A' ? this.engine.deckA : this.engine.deckB;
    const bpmEl = document.querySelector(`#bpm-val-${deckId.toLowerCase()}`);
    if (bpmEl) {
      const pct = Math.round((deck.pitchRate - 1.0) * 1000) / 10;
      const sign = pct >= 0 ? '+' : '';
      bpmEl.textContent = `${deck.effectiveBpm.toFixed(1)} BPM (${sign}${pct.toFixed(1)}%)`;
    }
  }

  _updateHotCueUI(deckId, index, btn) {
    const deck = deckId === 'A' ? this.engine.deckA : this.engine.deckB;
    const time = deck.hotCues[index];
    if (time !== null) {
      btn.classList.add('set');
      const timeSpan = btn.querySelector('.cue-pad-time');
      if (timeSpan) {
        const mins = Math.floor(time / 60);
        const secs = String(Math.floor(time % 60)).padStart(2, '0');
        timeSpan.textContent = `${mins}:${secs}`;
      }
    }
  }

  _bindKnobs() {
    // Generic Rotary Knob Mouse Drag Handler
    const bindKnob = (selector, onValueChange, min = -40, max = 6, defaultVal = 0) => {
      const dial = document.querySelector(selector);
      if (!dial) return;

      let currentVal = defaultVal;
      let startY = 0;
      let isDragging = false;

      const updatePointer = (val) => {
        // Map min..max to angle range -135deg .. +135deg
        const norm = (val - min) / (max - min);
        const angle = -135 + (norm * 270);
        const pointer = dial.querySelector('.dj-knob-pointer');
        if (pointer) pointer.style.transform = `translateX(-50%) rotate(${angle}deg)`;
      };

      dial.addEventListener('mousedown', (e) => {
        isDragging = true;
        startY = e.clientY;
        document.body.style.cursor = 'ns-resize';

        const onMouseMove = (moveEvent) => {
          if (!isDragging) return;
          const deltaY = startY - moveEvent.clientY;
          startY = moveEvent.clientY;
          const step = (max - min) / 120;
          currentVal = Math.max(min, Math.min(max, currentVal + (deltaY * step)));
          updatePointer(currentVal);
          onValueChange(currentVal);
        };

        const onMouseUp = () => {
          isDragging = false;
          document.body.style.cursor = '';
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });

      // Double-click to reset to default
      dial.addEventListener('dblclick', () => {
        currentVal = defaultVal;
        updatePointer(currentVal);
        onValueChange(currentVal);
      });

      updatePointer(defaultVal);
    };

    // Channel A Knobs
    bindKnob('#knob-trim-a', (v) => this.engine.deckA.setTrim(v), 0, 2, 1.0);
    bindKnob('#knob-hi-a', (v) => this.engine.deckA.setEq('high', v), -40, 6, 0);
    bindKnob('#knob-mid-a', (v) => this.engine.deckA.setEq('mid', v), -40, 6, 0);
    bindKnob('#knob-low-a', (v) => this.engine.deckA.setEq('low', v), -40, 6, 0);
    bindKnob('#knob-filter-a', (v) => this.engine.deckA.setColorFilter(v), -1.0, 1.0, 0);

    // Channel B Knobs
    bindKnob('#knob-trim-b', (v) => this.engine.deckB.setTrim(v), 0, 2, 1.0);
    bindKnob('#knob-hi-b', (v) => this.engine.deckB.setEq('high', v), -40, 6, 0);
    bindKnob('#knob-mid-b', (v) => this.engine.deckB.setEq('mid', v), -40, 6, 0);
    bindKnob('#knob-low-b', (v) => this.engine.deckB.setEq('low', v), -40, 6, 0);
    bindKnob('#knob-filter-b', (v) => this.engine.deckB.setColorFilter(v), -1.0, 1.0, 0);
  }

  _bindJogWheels() {
    ['A', 'B'].forEach(deckId => {
      const box = document.querySelector(`#jogwheel-${deckId.toLowerCase()}`);
      if (!box) return;

      const deck = deckId === 'A' ? this.engine.deckA : this.engine.deckB;
      const state = this.jogState[deckId];

      const getAngle = (clientX, clientY) => {
        const rect = box.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return Math.atan2(clientY - centerY, clientX - centerX);
      };

      box.addEventListener('mousedown', (e) => {
        state.isDragging = true;
        state.lastAngle = getAngle(e.clientX, e.clientY);

        const onMouseMove = (moveEvent) => {
          if (!state.isDragging) return;
          const currentAngle = getAngle(moveEvent.clientX, moveEvent.clientY);
          let delta = currentAngle - state.lastAngle;

          // Normalize wrap-around at -PI / +PI
          if (delta > Math.PI) delta -= Math.PI * 2;
          if (delta < -Math.PI) delta += Math.PI * 2;

          state.rotation += delta;
          state.lastAngle = currentAngle;

          // Scratch scrub audio
          if (deck.audio.duration) {
            const timeDelta = (delta / (Math.PI * 2)) * 1.8;
            deck.audio.currentTime = Math.max(0, Math.min(deck.audio.duration, deck.audio.currentTime + timeDelta));
          }
        };

        const onMouseUp = () => {
          state.isDragging = false;
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  _bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Don't trigger when typing in inputs
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

      // Only active if DJ studio is currently visible
      const djStudio = document.querySelector('#view-dj-studio');
      if (!djStudio || djStudio.style.display === 'none') return;

      switch (e.code) {
        // Deck A
        case 'KeyW': // Play/Pause Deck A
          this.engine.deckA.togglePlay().then(() => this._updateTransportUI('A'));
          break;
        case 'KeyQ': // Cue Deck A
          this.engine.deckA.cue();
          this._updateTransportUI('A');
          break;
        case 'KeyE': // Sync Deck A to B
          this.engine.syncDecks('B', 'A');
          this._updateBpmUI('A');
          break;

        // Deck B
        case 'KeyI': // Play/Pause Deck B
          this.engine.deckB.togglePlay().then(() => this._updateTransportUI('B'));
          break;
        case 'KeyU': // Cue Deck B
          this.engine.deckB.cue();
          this._updateTransportUI('B');
          break;
        case 'KeyO': // Sync Deck B to A
          this.engine.syncDecks('A', 'B');
          this._updateBpmUI('B');
          break;

        // Crossfader nudging
        case 'BracketLeft': {
          const cf = document.querySelector('#dj-crossfader');
          if (cf) {
            cf.value = Math.max(-1, parseFloat(cf.value) - 0.1);
            this.engine.updateCrossfader(parseFloat(cf.value));
          }
          break;
        }
        case 'BracketRight': {
          const cf = document.querySelector('#dj-crossfader');
          if (cf) {
            cf.value = Math.min(1, parseFloat(cf.value) + 0.1);
            this.engine.updateCrossfader(parseFloat(cf.value));
          }
          break;
        }
        case 'KeyX': {
          // Center crossfader
          const cf = document.querySelector('#dj-crossfader');
          if (cf) {
            cf.value = 0;
            this.engine.updateCrossfader(0);
          }
          break;
        }

        // Sampler Triggers
        case 'Digit1': this.engine.triggerSample('airhorn'); break;
        case 'Digit2': this.engine.triggerSample('laser'); break;
        case 'Digit3': this.engine.triggerSample('siren'); break;
        case 'Digit4': this.engine.triggerSample('drop'); break;
        case 'Digit5': this.engine.triggerSample('clap'); break;
        case 'Digit6': this.engine.triggerSample('scratch'); break;
      }
    });
  }

  // ============================================================
  // 60 FPS CANVAS RENDERING (Waveforms, Jog Wheels, VU Meters)
  // ============================================================
  _startRenderLoop() {
    const canvasA = document.querySelector('#waveform-canvas-a');
    const canvasB = document.querySelector('#waveform-canvas-b');
    const jogCanvasA = document.querySelector('#jogwheel-canvas-a');
    const jogCanvasB = document.querySelector('#jogwheel-canvas-b');

    const render = () => {
      // Only render if DJ studio is visible
      const djStudio = document.querySelector('#view-dj-studio');
      if (djStudio && djStudio.style.display !== 'none') {
        this._renderWaveform('A', canvasA);
        this._renderWaveform('B', canvasB);
        this._renderJogWheel('A', jogCanvasA);
        this._renderJogWheel('B', jogCanvasB);
        this._renderVUMeters();
        this._updateTimeDisplays();
      }

      this.animationFrame = requestAnimationFrame(render);
    };

    this.animationFrame = requestAnimationFrame(render);
  }

  _renderWaveform(deckId, canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;
    const deck = deckId === 'A' ? this.engine.deckA : this.engine.deckB;

    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, width, height);

    if (!deck.audio.src || !deck.audio.duration) {
      ctx.fillStyle = '#334155';
      ctx.font = '12px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`Load track into Deck ${deckId}`, width / 2, height / 2 + 4);
      return;
    }

    const duration = deck.audio.duration;
    const currentTime = deck.audio.currentTime;
    const playheadX = width / 2;

    // Draw scrolling frequency-colored waveform bars
    const barWidth = 3;
    const barGap = 1.5;
    const step = barWidth + barGap;
    const visibleTimeSpan = 8; // 8 seconds visible across canvas
    const timePerPixel = visibleTimeSpan / width;

    const accentColor = deckId === 'A' ? '#00e5ff' : '#ff007f';

    for (let x = 0; x < width; x += step) {
      const timeAtX = currentTime + (x - playheadX) * timePerPixel;
      if (timeAtX < 0 || timeAtX > duration) continue;

      // Synthetic dynamic waveform based on audio time domain & beat pulses
      const beatProgress = (timeAtX * (deck.effectiveBpm / 60)) % 1.0;
      const beatPulse = Math.pow(Math.sin(beatProgress * Math.PI), 8);
      const noise = (Math.sin(timeAtX * 12) + Math.cos(timeAtX * 27) + 2) / 4;
      const amplitude = Math.min(1.0, 0.2 + (beatPulse * 0.55) + (noise * 0.35));

      const barHeight = amplitude * (height - 16);
      const y = (height - barHeight) / 2;

      // Multi-band coloring: Bass = Orange/Red, Mid = Cyan/Pink, High = White
      let col = accentColor;
      if (beatPulse > 0.6) {
        col = '#f59e0b'; // Kick drum pulse
      }

      ctx.fillStyle = col;
      ctx.fillRect(x, y, barWidth, barHeight);
    }

    // Center Playhead Line
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _renderJogWheel(deckId, canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = canvas.width = canvas.height = 140;
    const center = size / 2;
    const radius = center - 4;

    const deck = deckId === 'A' ? this.engine.deckA : this.engine.deckB;
    const state = this.jogState[deckId];

    // Smooth auto-rotation during playback
    if (!deck.audio.paused && !state.isDragging) {
      state.rotation += 0.04 * deck.pitchRate;
    }

    ctx.clearRect(0, 0, size, size);

    // Outer Vinyl Rim
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#0f1118';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = deckId === 'A' ? '#00e5ff' : '#ff007f';
    ctx.stroke();

    // Vinyl Grooves
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    for (let r = 24; r < radius - 8; r += 6) {
      ctx.beginPath();
      ctx.arc(center, center, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Center Label Disc
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(state.rotation);

    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fillStyle = deckId === 'A' ? '#00e5ff' : '#ff007f';
    ctx.fill();

    // Center Spindle Hole
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#050608';
    ctx.fill();

    // Vinyl Position Marker
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(10, -2, 10, 4);

    ctx.restore();
  }

  _renderVUMeters() {
    // Channel A VU Meter
    const levelA = this.engine.deckA.getVULevel();
    const segmentsA = document.querySelectorAll('#vu-meter-a .vu-segment');
    const litCountA = Math.round(levelA * segmentsA.length);
    segmentsA.forEach((seg, idx) => {
      seg.className = 'vu-segment';
      if (idx < litCountA) {
        if (idx < 6) seg.classList.add('lit-green');
        else if (idx < 8) seg.classList.add('lit-amber');
        else seg.classList.add('lit-red');
      }
    });

    // Channel B VU Meter
    const levelB = this.engine.deckB.getVULevel();
    const segmentsB = document.querySelectorAll('#vu-meter-b .vu-segment');
    const litCountB = Math.round(levelB * segmentsB.length);
    segmentsB.forEach((seg, idx) => {
      seg.className = 'vu-segment';
      if (idx < litCountB) {
        if (idx < 6) seg.classList.add('lit-green');
        else if (idx < 8) seg.classList.add('lit-amber');
        else seg.classList.add('lit-red');
      }
    });
  }

  _updateTimeDisplays() {
    const format = (s) => {
      if (!Number.isFinite(s)) return '0:00';
      return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    };

    const timeA = document.querySelector('#time-a');
    if (timeA && this.engine.deckA.audio) {
      timeA.textContent = `${format(this.engine.deckA.audio.currentTime)} / ${format(this.engine.deckA.audio.duration || 0)}`;
    }

    const timeB = document.querySelector('#time-b');
    if (timeB && this.engine.deckB.audio) {
      timeB.textContent = `${format(this.engine.deckB.audio.currentTime)} / ${format(this.engine.deckB.audio.duration || 0)}`;
    }
  }

  // ============================================================
  // TRACK LOADER MODAL (Local Library + Instant YouTube Search)
  // ============================================================
  openTrackModal(deckId) {
    this.currentModalDeck = deckId;
    const modal = document.querySelector('#dj-track-modal');
    if (!modal) return;

    modal.classList.remove('hidden');
    const badgeEl = document.querySelector('#dj-modal-deck-badge');
    if (badgeEl) {
      badgeEl.textContent = `Deck ${deckId}`;
      badgeEl.style.color = deckId === 'A' ? '#00e5ff' : '#ff007f';
    }

    const searchInput = document.querySelector('#dj-modal-search-input');
    if (searchInput) {
      searchInput.value = '';
      setTimeout(() => searchInput.focus(), 50);
    }

    const getLocalTracks = () => {
      return (window.state?.tracks || []).filter(t => t.media_type !== 'video' && !t.missing);
    };

    const tracks = getLocalTracks();
    if (tracks.length > 0) {
      this._renderModalList(tracks);
    } else {
      const list = document.querySelector('#dj-modal-list');
      if (list) {
        list.innerHTML = `
          <div style="text-align:center;padding:36px 16px;color:#94a3b8;">
            <i class="ph ph-spinner-gap spinning" style="font-size:28px;color:#38bdf8;margin-bottom:8px;"></i>
            <p>Loading library tracks...</p>
          </div>
        `;
      }
      fetch('/api/library')
        .then(r => r.json())
        .then(data => {
          if (data && data.tracks) {
            if (window.state) window.state.tracks = data.tracks;
            this._renderModalList(getLocalTracks());
          }
        })
        .catch(() => {
          this._renderModalList([]);
        });
    }
  }

  _renderModalList(tracks, query = '', isSearching = false) {
    const list = document.querySelector('#dj-modal-list');
    if (!list) return;

    if (isSearching) {
      list.innerHTML = `
        <div style="text-align:center;padding:36px 16px;color:#94a3b8;">
          <i class="ph ph-spinner-gap spinning" style="font-size:28px;color:#38bdf8;margin-bottom:8px;"></i>
          <p style="font-weight:600;color:#f1f5f9;margin-bottom:4px;">Searching for "${query}"...</p>
          <span style="font-size:12px;color:#64748b;">Checking local library & YouTube streams</span>
        </div>
      `;
      return;
    }

    if (!tracks || tracks.length === 0) {
      list.innerHTML = `
        <div style="text-align:center;padding:36px 16px;color:#94a3b8;">
          <i class="ph ph-magnifying-glass" style="font-size:32px;color:#64748b;margin-bottom:8px;"></i>
          <p style="font-weight:600;color:#e2e8f0;margin-bottom:4px;">No tracks found${query ? ` for "${query}"` : ''}</p>
          <span style="font-size:12px;color:#64748b;">Try searching for a song title or artist name</span>
        </div>
      `;
      return;
    }

    const actionClass = this.currentModalDeck === 'B' ? 'dj-modal-row-action deck-b-action' : 'dj-modal-row-action';

    list.innerHTML = tracks.map(t => {
      const isOnline = t.is_online || (t.id && t.id.startsWith('yt:'));
      const badge = isOnline
        ? `<span class="dj-modal-badge badge-youtube"><i class="ph-fill ph-globe"></i> YouTube Stream</span>`
        : `<span class="dj-modal-badge badge-local"><i class="ph-fill ph-folder"></i> Local</span>`;

      const thumb = t.artwork_url
        ? `<img class="dj-modal-thumb" src="${t.artwork_url}" alt="" loading="lazy">`
        : `<div class="dj-modal-thumb-placeholder"><i class="ph-fill ph-music-notes"></i></div>`;

      const durStr = t.duration ? `${Math.floor(t.duration / 60)}:${String(Math.floor(t.duration % 60)).padStart(2, '0')}` : '';

      return `
        <div class="dj-modal-row" data-track-id="${t.id}">
          <div class="dj-modal-row-left">
            ${thumb}
            <div style="overflow:hidden;max-width:340px;">
              <div class="dj-modal-row-title" title="${t.title}">${t.title}</div>
              <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
                <span class="dj-modal-row-artist" title="${t.artist || ''}">${t.artist || 'Unknown Artist'}</span>
                ${durStr ? `<span style="font-size:11px;color:#64748b;">· ${durStr}</span>` : ''}
                ${badge}
              </div>
            </div>
          </div>
          <button class="${actionClass}">Load to Deck ${this.currentModalDeck}</button>
        </div>
      `;
    }).join('');

    // Attach click listeners
    list.querySelectorAll('.dj-modal-row').forEach(row => {
      row.addEventListener('click', () => {
        const tid = row.dataset.trackId;
        const track = tracks.find(t => t.id === tid);
        if (track) {
          this._loadTrackIntoDeck(this.currentModalDeck, track);
          document.querySelector('#dj-track-modal').classList.add('hidden');
        }
      });
    });
  }

  _filterModalTracks(query) {
    const q = query.toLowerCase().trim();
    clearTimeout(this._searchDebounceTimer);

    if (!q) {
      const localTracks = (window.state?.tracks || []).filter(t => t.media_type !== 'video' && !t.missing);
      this._renderModalList(localTracks);
      return;
    }

    // 1. Instant local filter
    const localTracks = (window.state?.tracks || []).filter(t => t.media_type !== 'video' && !t.missing);
    const localMatches = localTracks.filter(t => {
      return (t.title && t.title.toLowerCase().includes(q)) ||
             (t.artist && t.artist.toLowerCase().includes(q)) ||
             (t.album && t.album.toLowerCase().includes(q));
    });

    // If we have local matches, show them immediately
    if (localMatches.length > 0) {
      this._renderModalList(localMatches, query);
    }

    // 2. Debounced Remote Search (YouTube Stream Search fallback & complement)
    this._searchDebounceTimer = setTimeout(async () => {
      if (localMatches.length === 0) {
        this._renderModalList([], query, true); // Show searching spinner
      }

      try {
        const ytRes = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}&limit=10`).then(r => r.json());
        const ytItems = (ytRes && ytRes.results) || [];

        const remoteTracks = ytItems.map(item => ({
          id: 'yt:' + item.id,
          title: item.title,
          artist: item.artist || 'YouTube',
          album: 'YouTube Stream',
          duration: item.duration || 0,
          has_artwork: !!item.thumbnail,
          artwork_url: item.thumbnail,
          url: `/api/youtube/stream/${item.id}`,
          is_online: true,
          bpm: 124.0
        }));

        const combined = [...localMatches, ...remoteTracks];
        this._renderModalList(combined, query, false);
      } catch (err) {
        console.error('Track modal online search failed:', err);
        this._renderModalList(localMatches, query, false);
      }
    }, 280);
  }

  _loadTrackIntoDeck(deckId, track) {
    const deck = deckId === 'A' ? this.engine.deckA : this.engine.deckB;
    deck.loadTrack(track);

    const titleEl = document.querySelector(`#track-title-${deckId.toLowerCase()}`);
    const artistEl = document.querySelector(`#track-artist-${deckId.toLowerCase()}`);
    if (titleEl) titleEl.textContent = track.title;
    if (artistEl) artistEl.textContent = `${track.artist || 'Unknown'} · ${track.album || ''}`;

    this._updateBpmUI(deckId);
    this._updateTransportUI(deckId);

    // Call backend analysis asynchronously for BPM and waveform peaks (for local tracks)
    if (track.id && !track.id.startsWith('yt:')) {
      const hexId = track.url.split('/').pop();
      fetch(`/api/dj/analyze/${hexId}`).then(res => res.json()).then(data => {
        if (data && data.bpm) {
          deck.bpm = data.bpm;
          this._updateBpmUI(deckId);
        }
      }).catch(() => {});
    }
  }

  _promptSaveRecording(blob) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `Linus_DJ_Mix_${timestamp}.webm`;

    // Direct browser download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Also upload to server in background to store in library
    const formData = new FormData();
    formData.append('audio', blob, filename);
    formData.append('title', `DJ Mix (${new Date().toLocaleDateString()})`);

    fetch('/api/dj/save-recording', {
      method: 'POST',
      body: formData
    }).then(res => res.json()).then(data => {
      if (window.notify) {
        window.notify('DJ Mix recorded & saved to library!');
      }
    }).catch(err => {
      console.error('Failed to sync mix to backend:', err);
    });
  }
}

// Attach globally
window.DJStudioUI = DJStudioUI;
