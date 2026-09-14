// ============================================================
// Linus — DJ Audio Engine (Web Audio API Core)
// Dual Deck Signal Flow, 3-Band Isolator EQ, Resonant Filter,
// Crossfader Curve Math, Real-Time DSP FX, Synth Sampler & Recorder
// ============================================================

class DJDeck {
  constructor(id, engine) {
    this.id = id; // 'A' or 'B'
    this.engine = engine;
    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';

    this.track = null;
    this.bpm = 120.0;
    this.detectedBpm = 120.0;
    this.key = '8A';
    this.hotCues = [null, null, null, null]; // seconds
    this.loopActive = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.loopTimer = null;

    // Gains & EQ values
    this.trim = 1.0;
    this.low = 0.0; // dB (-40 to +6)
    this.mid = 0.0;
    this.high = 0.0;
    this.filterVal = 0.0; // -1 (LPF) to +1 (HPF)
    this.upfader = 1.0; // 0 to 1
    this.pitchRate = 1.0;

    this.kills = { low: false, mid: false, high: false };
    this.isPflCue = false;

    // Web Audio Nodes
    this.sourceNode = null;
    this.lowNode = null;
    this.midNode = null;
    this.highNode = null;
    this.filterNode = null;
    this.trimGainNode = null;
    this.faderGainNode = null;
    this.crossfaderGainNode = null;
    this.analyserNode = null;

    this._setupAudioGraph();
    this._bindEvents();
  }

  _setupAudioGraph() {
    const ctx = this.engine.ctx;

    // Source
    this.sourceNode = ctx.createMediaElementSource(this.audio);

    // 3-Band EQ Nodes
    this.lowNode = ctx.createBiquadFilter();
    this.lowNode.type = 'lowshelf';
    this.lowNode.frequency.value = 300;
    this.lowNode.gain.value = 0;

    this.midNode = ctx.createBiquadFilter();
    this.midNode.type = 'peaking';
    this.midNode.frequency.value = 1000;
    this.midNode.Q.value = 1.0;
    this.midNode.gain.value = 0;

    this.highNode = ctx.createBiquadFilter();
    this.highNode.type = 'highshelf';
    this.highNode.frequency.value = 3500;
    this.highNode.gain.value = 0;

    // Sound Color Filter (Bi-directional LPF / HPF)
    this.filterNode = ctx.createBiquadFilter();
    this.filterNode.type = 'allpass';
    this.filterNode.frequency.value = 1000;
    this.filterNode.Q.value = 2.5;

    // Gains
    this.trimGainNode = ctx.createGain();
    this.trimGainNode.gain.value = 1.0;

    this.faderGainNode = ctx.createGain();
    this.faderGainNode.gain.value = 1.0;

    this.crossfaderGainNode = ctx.createGain();
    this.crossfaderGainNode.gain.value = 1.0;

    // Fast VU Meter Analyser
    this.analyserNode = ctx.createAnalyser();
    this.analyserNode.fftSize = 64;
    this.analyserNode.smoothingTimeConstant = 0.5;

    // Signal Flow:
    // source -> low -> mid -> high -> filter -> trim -> fader -> analyser -> crossfaderGain -> masterBus
    this.sourceNode.connect(this.lowNode);
    this.lowNode.connect(this.midNode);
    this.midNode.connect(this.highNode);
    this.highNode.connect(this.filterNode);
    this.filterNode.connect(this.trimGainNode);
    this.trimGainNode.connect(this.faderGainNode);
    this.faderGainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.crossfaderGainNode);
    this.crossfaderGainNode.connect(this.engine.masterBus);
  }

  _bindEvents() {
    this.audio.addEventListener('timeupdate', () => {
      if (this.loopActive && this.audio.currentTime >= this.loopEnd) {
        this.audio.currentTime = this.loopStart;
      }
    });

    this.audio.addEventListener('ended', () => {
      if (this.loopActive) {
        this.audio.currentTime = this.loopStart;
        this.audio.play();
      }
    });
  }

  loadTrack(track) {
    this.track = track;
    this.audio.src = track.url;
    this.audio.currentTime = 0;
    this.audio.playbackRate = this.pitchRate;
    this.audio.preservesPitch = true;
    this.hotCues = [null, null, null, null];
    this.exitLoop();

    // Default BPM estimation if not yet analyzed
    this.bpm = track.bpm || 124.0;
    this.detectedBpm = this.bpm;
    this.key = track.key || '8A';
  }

  play() {
    this.engine.ensureContext();
    return this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  togglePlay() {
    if (this.audio.paused) {
      return this.play();
    } else {
      this.pause();
      return Promise.resolve();
    }
  }

  cue() {
    this.engine.ensureContext();
    if (!this.audio.paused) {
      this.audio.pause();
      this.audio.currentTime = this.hotCues[0] !== null ? this.hotCues[0] : 0;
    } else {
      this.audio.currentTime = this.hotCues[0] !== null ? this.hotCues[0] : 0;
      this.audio.play();
    }
  }

  setHotCue(index) {
    this.hotCues[index] = this.audio.currentTime;
  }

  jumpHotCue(index) {
    if (this.hotCues[index] !== null) {
      this.engine.ensureContext();
      this.audio.currentTime = this.hotCues[index];
      if (this.audio.paused) {
        this.audio.play();
      }
    } else {
      this.setHotCue(index);
    }
  }

  clearHotCue(index) {
    this.hotCues[index] = null;
  }

  setLoop(beats) {
    if (!this.bpm || this.bpm <= 0) this.bpm = 120;
    const secondsPerBeat = 60 / this.effectiveBpm;
    const loopDuration = beats * secondsPerBeat;
    this.loopStart = this.audio.currentTime;
    this.loopEnd = this.loopStart + loopDuration;
    this.loopActive = true;
  }

  exitLoop() {
    this.loopActive = false;
  }

  setTrim(val) {
    // 0.0 to 2.0 (1.0 = 0dB unity)
    this.trim = Math.max(0, Math.min(2, val));
    this.trimGainNode.gain.setTargetAtTime(this.trim, this.engine.ctx.currentTime, 0.02);
  }

  setEq(band, dbVal) {
    // -40 to +6 dB
    const clamped = Math.max(-40, Math.min(6, dbVal));
    this[band] = clamped;
    const effectiveGain = this.kills[band] ? -70 : clamped;

    const targetNode = band === 'low' ? this.lowNode : (band === 'mid' ? this.midNode : this.highNode);
    targetNode.gain.setTargetAtTime(effectiveGain, this.engine.ctx.currentTime, 0.02);
  }

  toggleKill(band) {
    this.kills[band] = !this.kills[band];
    this.setEq(band, this[band]);
    return this.kills[band];
  }

  setColorFilter(val) {
    // val in range [-1.0, 1.0] (0 = neutral/bypassed)
    this.filterVal = Math.max(-1, Math.min(1, val));
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;

    if (Math.abs(this.filterVal) < 0.02) {
      this.filterNode.type = 'allpass';
      this.filterNode.frequency.setTargetAtTime(1000, now, 0.02);
    } else if (this.filterVal < 0) {
      // Low-Pass Filter sweep: 0 -> -1 maps 20000Hz down to 100Hz
      this.filterNode.type = 'lowpass';
      const f = 20000 * Math.pow(0.005, Math.abs(this.filterVal));
      this.filterNode.frequency.setTargetAtTime(Math.max(80, f), now, 0.02);
      this.filterNode.Q.setTargetAtTime(2.5, now, 0.02);
    } else {
      // High-Pass Filter sweep: 0 -> +1 maps 20Hz up to 10000Hz
      this.filterNode.type = 'highpass';
      const f = 20 * Math.pow(500, this.filterVal);
      this.filterNode.frequency.setTargetAtTime(Math.min(12000, f), now, 0.02);
      this.filterNode.Q.setTargetAtTime(2.5, now, 0.02);
    }
  }

  setUpfader(val) {
    // 0 to 1
    this.upfader = Math.max(0, Math.min(1, val));
    this.faderGainNode.gain.setTargetAtTime(this.upfader, this.engine.ctx.currentTime, 0.02);
  }

  setPitch(rate) {
    // 0.84 to 1.16 (+/- 16%)
    this.pitchRate = Math.max(0.7, Math.min(1.3, rate));
    this.audio.playbackRate = this.pitchRate;
    this.audio.preservesPitch = true;
  }

  nudgePitch(delta) {
    const originalRate = this.pitchRate;
    this.audio.playbackRate = originalRate + delta;
    setTimeout(() => {
      this.audio.playbackRate = originalRate;
    }, 180);
  }

  get effectiveBpm() {
    return Math.round(this.bpm * this.pitchRate * 10) / 10;
  }

  getVULevel() {
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    return Math.min(1.0, rms * 3.2); // Scaled 0 to 1
  }
}

class DJAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterBus = null;
    this.masterGainNode = null;
    this.masterAnalyser = null;
    this.recordDestination = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;

    // Crossfader
    this.crossfaderPos = 0; // -1 (Left Deck A) to +1 (Right Deck B)
    this.crossfaderCurve = 'smooth'; // 'smooth' | 'linear' | 'scratch'

    // FX Rack
    this.activeFx = 'none'; // 'none' | 'echo' | 'reverb' | 'flanger' | 'roll'
    this.fxDryWet = 0.35;
    this.fxBeatFraction = 0.5; // 1/2 beat
    this._initAudioNodes();

    this.deckA = new DJDeck('A', this);
    this.deckB = new DJDeck('B', this);

    this.updateCrossfader(0);
    this._initMidi();
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  _initAudioNodes() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();

    // Master Summing Node
    this.masterBus = this.ctx.createGain();
    this.masterBus.gain.value = 1.0;

    // Master Volume
    this.masterGainNode = this.ctx.createGain();
    this.masterGainNode.gain.value = 1.0;

    // Master Limiter to prevent harsh DAC clipping
    this.limiterNode = this.ctx.createDynamicsCompressor();
    this.limiterNode.threshold.value = -1.0;
    this.limiterNode.knee.value = 0;
    this.limiterNode.ratio.value = 20;
    this.limiterNode.attack.value = 0.003;
    this.limiterNode.release.value = 0.05;

    // Master Analyser
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 64;

    // FX Bus
    this._setupFxRack();

    // Recording Destination
    this.recordDestination = this.ctx.createMediaStreamDestination();

    // Routing: masterBus -> FX Rack -> limiter -> masterGain -> destination & recorder
    this.masterBus.connect(this.fxInputNode);
    this.fxOutputNode.connect(this.limiterNode);
    this.limiterNode.connect(this.masterGainNode);
    this.masterGainNode.connect(this.masterAnalyser);
    this.masterGainNode.connect(this.ctx.destination);
    this.masterGainNode.connect(this.recordDestination);
  }

  _setupFxRack() {
    const ctx = this.ctx;

    this.fxInputNode = ctx.createGain();
    this.fxDryNode = ctx.createGain();
    this.fxWetNode = ctx.createGain();
    this.fxOutputNode = ctx.createGain();

    this.fxDryNode.gain.value = 1.0;
    this.fxWetNode.gain.value = 0.0;

    // Delay / Echo
    this.delayNode = ctx.createDelay(4.0);
    this.delayNode.delayTime.value = 0.25;
    this.delayFeedbackNode = ctx.createGain();
    this.delayFeedbackNode.gain.value = 0.45;

    this.delayNode.connect(this.delayFeedbackNode);
    this.delayFeedbackNode.connect(this.delayNode);

    // Reverb (Synthetic algorithmic impulse)
    this.reverbNode = ctx.createConvolver();
    this.reverbNode.buffer = this._generateReverbImpulse(2.2, 2.0);

    // Flanger
    this.flangerDelay = ctx.createDelay(0.1);
    this.flangerDelay.delayTime.value = 0.004;
    this.flangerLfo = ctx.createOscillator();
    this.flangerLfoGain = ctx.createGain();
    this.flangerLfo.frequency.value = 0.3; // 0.3 Hz sweep
    this.flangerLfoGain.gain.value = 0.0025;
    this.flangerLfo.connect(this.flangerLfoGain);
    this.flangerLfoGain.connect(this.flangerDelay.delayTime);
    this.flangerLfo.start();

    // Wire FX Routing
    this.fxInputNode.connect(this.fxDryNode);
    this.fxDryNode.connect(this.fxOutputNode);

    this.fxWetNode.connect(this.fxOutputNode);
    this._rebuildFxRouting();
  }

  _generateReverbImpulse(duration, decay) {
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = this.ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const n = i;
      left[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
      right[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
    }
    return impulse;
  }

  _rebuildFxRouting() {
    // Disconnect wet inputs
    try {
      this.fxInputNode.disconnect(this.delayNode);
      this.delayNode.disconnect(this.fxWetNode);
      this.fxInputNode.disconnect(this.reverbNode);
      this.reverbNode.disconnect(this.fxWetNode);
      this.fxInputNode.disconnect(this.flangerDelay);
      this.flangerDelay.disconnect(this.fxWetNode);
    } catch (e) {}

    if (this.activeFx === 'echo') {
      this.fxInputNode.connect(this.delayNode);
      this.delayNode.connect(this.fxWetNode);
    } else if (this.activeFx === 'reverb') {
      this.fxInputNode.connect(this.reverbNode);
      this.reverbNode.connect(this.fxWetNode);
    } else if (this.activeFx === 'flanger') {
      this.fxInputNode.connect(this.flangerDelay);
      this.flangerDelay.connect(this.fxWetNode);
    }

    this.setFxDryWet(this.activeFx === 'none' ? 0 : this.fxDryWet);
  }

  setFxType(type) {
    this.activeFx = this.activeFx === type ? 'none' : type;
    this._rebuildFxRouting();
    return this.activeFx;
  }

  setFxDryWet(val) {
    this.fxDryWet = Math.max(0, Math.min(1, val));
    const wet = this.activeFx === 'none' ? 0 : this.fxDryWet;
    const dry = 1.0 - (wet * 0.5);
    const now = this.ctx.currentTime;
    this.fxWetNode.gain.setTargetAtTime(wet, now, 0.02);
    this.fxDryNode.gain.setTargetAtTime(dry, now, 0.02);
  }

  setFxBeat(fraction) {
    this.fxBeatFraction = fraction;
    // Calculate delay time based on active deck BPM (defaults to 124)
    const activeDeck = !this.deckA.audio.paused ? this.deckA : this.deckB;
    const bpm = activeDeck.effectiveBpm || 124;
    const secondsPerBeat = 60 / bpm;
    const delayTime = Math.max(0.04, Math.min(2.0, fraction * secondsPerBeat));
    this.delayNode.delayTime.setTargetAtTime(delayTime, this.ctx.currentTime, 0.03);
  }

  updateCrossfader(pos, curve = null) {
    // pos in range [-1.0, 1.0]
    this.crossfaderPos = Math.max(-1, Math.min(1, pos));
    if (curve) this.crossfaderCurve = curve;

    let gainA = 1.0;
    let gainB = 1.0;
    const x = this.crossfaderPos;

    if (this.crossfaderCurve === 'smooth') {
      // Constant Power: cos / sin curve
      const angle = ((x + 1) * Math.PI) / 4;
      gainA = Math.cos(angle);
      gainB = Math.sin(angle);
    } else if (this.crossfaderCurve === 'linear') {
      gainA = Math.max(0, -0.5 * x + 0.5);
      gainB = Math.max(0, 0.5 * x + 0.5);
    } else if (this.crossfaderCurve === 'scratch') {
      // Sharp Cut: instant cut-in within 5% from edges
      gainA = x < 0.9 ? 1.0 : 0.0;
      gainB = x > -0.9 ? 1.0 : 0.0;
    }

    const now = this.ctx.currentTime;
    this.deckA.crossfaderGainNode.gain.setTargetAtTime(gainA, now, 0.01);
    this.deckB.crossfaderGainNode.gain.setTargetAtTime(gainB, now, 0.01);
  }

  syncDecks(masterDeckId, targetDeckId) {
    const master = masterDeckId === 'A' ? this.deckA : this.deckB;
    const target = targetDeckId === 'A' ? this.deckA : this.deckB;

    if (!master.bpm || !target.bpm) return;

    // Match BPM
    const targetRate = (master.effectiveBpm / target.bpm);
    target.setPitch(targetRate);
    return targetRate;
  }

  // ============================================================
  // SYNTHESIZED SAMPLER SOUNDBOARD (100% Offline / Zero Latency)
  // ============================================================
  triggerSample(name) {
    this.ensureContext();
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const sampleBus = ctx.createGain();
    sampleBus.gain.value = 0.9;
    sampleBus.connect(this.masterBus);

    switch (name) {
      case 'airhorn': {
        // Iconic 3-burst reggae/dancehall airhorn
        const playBurst = (delay, dur, freq) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(freq, now + delay);
          osc.frequency.exponentialRampToValueAtTime(freq * 0.96, now + delay + dur);

          gain.gain.setValueAtTime(0, now + delay);
          gain.gain.linearRampToValueAtTime(0.7, now + delay + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.001, now + delay + dur);

          osc.connect(gain);
          gain.connect(sampleBus);
          osc.start(now + delay);
          osc.stop(now + delay + dur);
        };
        // Triple fanfare chords
        playBurst(0.00, 0.12, 466.16); // Bb4
        playBurst(0.00, 0.12, 587.33); // D5
        playBurst(0.14, 0.12, 466.16);
        playBurst(0.14, 0.12, 587.33);
        playBurst(0.28, 0.40, 466.16);
        playBurst(0.28, 0.40, 587.33);
        break;
      }

      case 'laser': {
        // Fast pitch dive retro sci-fi laser
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(2800, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.35);

        gain.gain.setValueAtTime(0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        osc.connect(gain);
        gain.connect(sampleBus);
        osc.start(now);
        osc.stop(now + 0.35);
        break;
      }

      case 'siren': {
        // Dub siren with LFO frequency modulation
        const osc = ctx.createOscillator();
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        const gain = ctx.createGain();

        osc.type = 'square';
        osc.frequency.value = 650;
        lfo.type = 'sawtooth';
        lfo.frequency.value = 4.0; // 4 Hz siren sweep
        lfoGain.gain.value = 350;

        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);

        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

        osc.connect(gain);
        gain.connect(sampleBus);

        lfo.start(now);
        osc.start(now);
        lfo.stop(now + 1.2);
        osc.stop(now + 1.2);
        break;
      }

      case 'drop': {
        // Massive 808 sub boom drop
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(140, now);
        osc.frequency.exponentialRampToValueAtTime(32, now + 1.4);

        gain.gain.setValueAtTime(1.0, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);

        osc.connect(gain);
        gain.connect(sampleBus);
        osc.start(now);
        osc.stop(now + 1.4);
        break;
      }

      case 'clap': {
        // 808 layered noise clap
        const bufferSize = ctx.sampleRate * 0.25;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = Math.random() * 2 - 1;
        }

        const noise = ctx.createBufferSource();
        noise.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1100;
        filter.Q.value = 1.8;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.8, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(sampleBus);

        noise.start(now);
        noise.stop(now + 0.25);
        break;
      }

      case 'scratch': {
        // Fast vinyl record spinback
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.28);

        gain.gain.setValueAtTime(0.7, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

        osc.connect(gain);
        gain.connect(sampleBus);
        osc.start(now);
        osc.stop(now + 0.28);
        break;
      }
    }
  }

  // ============================================================
  // LIVE MIX RECORDING (MediaRecorder)
  // ============================================================
  startRecording() {
    this.ensureContext();
    this.recordedChunks = [];
    const stream = this.recordDestination.stream;
    
    // Choose optimal mimeType supported by browser
    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = '';
    }

    try {
      this.mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      this.mediaRecorder = new MediaRecorder(stream);
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };

    this.mediaRecorder.start(200); // 200ms slices
    this.isRecording = true;
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this.isRecording = false;
        resolve(null);
        return;
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        this.isRecording = false;
        resolve(blob);
      };

      this.mediaRecorder.stop();
    });
  }

  // ============================================================
  // HARDWARE CONTROLLER SUPPORT (Web MIDI API)
  // ============================================================
  _initMidi() {
    if (!navigator.requestMIDIAccess) return;

    navigator.requestMIDIAccess().then((midiAccess) => {
      const inputs = midiAccess.inputs.values();
      for (const input of inputs) {
        input.onmidimessage = (e) => this._handleMidiMessage(e);
      }
      midiAccess.onstatechange = (e) => {
        if (e.port.type === 'input' && e.port.state === 'connected') {
          e.port.onmidimessage = (msg) => this._handleMidiMessage(msg);
          window.dispatchEvent(new CustomEvent('dj-midi-status', { detail: { connected: true, name: e.port.name } }));
        }
      };
      if (midiAccess.inputs.size > 0) {
        window.dispatchEvent(new CustomEvent('dj-midi-status', { detail: { connected: true } }));
      }
    }).catch(() => {});
  }

  _handleMidiMessage(e) {
    const [status, data1, data2] = e.data;
    const cmd = status >> 4;
    const channel = status & 0xf;

    // Control Change (Knobs / Faders)
    if (cmd === 0xb) {
      const val = data2 / 127; // Normalized 0.0 to 1.0
      switch (data1) {
        case 22: // Crossfader
          this.updateCrossfader(val * 2 - 1);
          window.dispatchEvent(new CustomEvent('dj-midi-control', { detail: { target: 'crossfader', value: val * 2 - 1 } }));
          break;
        case 21: // Deck A Upfader
          this.deckA.setUpfader(val);
          window.dispatchEvent(new CustomEvent('dj-midi-control', { detail: { target: 'upfader-a', value: val } }));
          break;
        case 23: // Deck B Upfader
          this.deckB.setUpfader(val);
          window.dispatchEvent(new CustomEvent('dj-midi-control', { detail: { target: 'upfader-b', value: val } }));
          break;
      }
    }
  }
}

// Attach globally
window.DJAudioEngine = DJAudioEngine;
