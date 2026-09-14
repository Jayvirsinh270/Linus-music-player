/**
 * Linus Music Player — Interactive Feature Tour & Onboarding Engine
 * Handles guided walkthrough, dynamic spotlight positioning, keyboard shortcuts,
 * view synchronization, and first-time user detection.
 */

(function () {
  'use strict';

  // Tour Steps Configuration
  const TOUR_STEPS = [
    {
      id: 'greeting',
      title: 'Dashboard & Daily Streak',
      category: 'Home & Activity',
      icon: 'ph-fire',
      target: '#rec-greeting',
      view: 'library',
      desc: 'Welcome to your aesthetic listening sanctuary! Linus greets you based on the time of day, tracks your <strong>daily listening streak</strong>, and gives you access to your personalized <strong>Weekly Sound Rewind</strong> (Spotify Wrapped-style stats & musical persona).',
      tip: 'Click the Streak flame badge anytime to view your interactive listening calendar heatmap!'
    },
    {
      id: 'moods',
      title: 'Circadian Mood Filter Chips',
      category: 'Personalization',
      icon: 'ph-sparkle',
      target: '#mood-chips-bar',
      view: 'library',
      desc: 'Adapt your music stream to match your mindset or energy level. Filter tracks dynamically by <strong>Chill & Lo-Fi</strong>, <strong>High Energy</strong>, <strong>Focus & Flow</strong>, <strong>Late Night</strong>, or <strong>Discovery</strong> with a single click.',
      tip: 'Your recommendations and mixes immediately re-sort to match your chosen mood.'
    },
    {
      id: 'launchpad',
      title: '6-Card Quick Launchpad',
      category: 'Instant Playback',
      icon: 'ph-squares-four',
      target: '#rec-quick-grid',
      view: 'library',
      desc: 'Your personalized 1-click listening deck! Jump instantly into curated <strong>Daily Mixes</strong>, <strong>Liked Songs</strong>, <strong>Artist Radio</strong>, or pick up right where you left off.',
      tip: 'Hover over any card for instant play and quick favorite controls.'
    },
    {
      id: 'hero-deck',
      title: 'Hero Deck & Audio Waveform',
      category: 'Now Playing',
      icon: 'ph-waveform',
      target: '#hero-now-playing-card',
      view: 'library',
      desc: 'Watch your sound come to life. The Hero Deck features an authentic spinning vinyl record, a <strong>real-time audio waveform visualizer</strong>, and an Up Next queue paired with an interactive <strong>2D Vibe Compass / Mood Dial</strong>.',
      tip: 'Click the Vibe tab in the queue to steer playback between Calming, Energetic, Melancholic, and Uplifting moods!'
    },
    {
      id: 'search',
      title: 'Universal Fuzzy Search',
      category: 'Search & Discovery',
      icon: 'ph-magnifying-glass',
      target: '.topbar-search',
      desc: 'Search your local music library and query the entire online catalogue simultaneously. Type song titles, artists, or albums with fast instant fuzzy matching.',
      tip: 'Press "/" on your keyboard anywhere in the app to immediately focus the search bar.'
    },
    {
      id: 'radio-mode',
      title: 'Smart Online ⇄ Offline Radio',
      category: 'Autoplay Engine',
      icon: 'ph-globe',
      target: '#radio-mode-toggle-btn',
      desc: '1-Click toggle between <strong>Online Radio</strong> (infinite YouTube Music smart stream discovery) and <strong>Offline Mode</strong> (pure local library playback).',
      tip: 'When Online Radio is active, Linus seamlessly queues up similar recommended songs forever so the music never stops!'
    },
    {
      id: 'cozy-vibe',
      title: 'Cozy Mode & Atmospheric Moods',
      category: 'Atmosphere',
      icon: 'ph-coffee',
      target: '#cozy-mode-quick-btn',
      desc: 'Transform your environment! Tap <strong>Cozy Mode</strong> for warm candlelight glow and rain ambiance, or open the <strong>Atmospheric Palette</strong> to choose from 6 aesthetic themes (Lo-Fi Cozy, Cyber Ecstatic, Sunset Sakura, Emerald Forest, Midnight Ocean, and Titanium Noir).',
      tip: 'Each theme dynamically adapts your background aura, lighting accents, and player glow.'
    },
    {
      id: 'sidebar-nav',
      title: 'Sanctuary Navigation Views',
      category: 'Navigation',
      icon: 'ph-compass',
      target: '#sidebar .nav',
      openSidebar: true,
      desc: 'Explore online trending charts in <strong>Explore</strong>, watch music videos in <strong>Videos</strong>, curate custom <strong>Playlists</strong> (with 1-click YouTube playlist import), access your <strong>Favorites</strong>, and manage local downloads.',
      tip: 'You can pin the sidebar visible using the push-pin icon in the sidebar header!'
    },
    {
      id: 'lyrics',
      title: 'Real-Time Synchronized Lyrics',
      category: 'Karaoke',
      icon: 'ph-quotes',
      target: '[data-view="lyrics"]',
      openSidebar: true,
      desc: 'Sing along with real-time synchronized karaoke lyrics that scroll smoothly with the track. Includes <strong>romanized pronunciation</strong> for Japanese, Korean, and international songs, plus manual lyric search.',
      tip: 'Click any line of lyrics to jump playback directly to that exact moment!'
    },
    {
      id: 'downloads',
      title: 'In-App Media Downloader',
      category: 'Offline Media',
      icon: 'ph-download-simple',
      target: '[data-view="downloads"]',
      openSidebar: true,
      desc: 'Expand your offline collection effortlessly. Paste any YouTube, SoundCloud, or media link to download high-quality audio (MP3/FLAC/M4A) or video directly into your music library.',
      tip: 'Downloads are automatically tagged with high-res cover art, metadata, and lyrics.'
    },
    {
      id: 'dj-studio',
      title: 'Pro Dual-Deck DJ Studio',
      category: 'DJ & Mixing',
      icon: 'ph-sliders',
      target: '[data-view="dj-studio"]',
      openSidebar: true,
      desc: 'A full-featured live DJ mixer right in your browser! Features dual independent decks, automated <strong>BPM detection & sync</strong>, pitch bending, 3-band EQ, filter sweeps, hot cues, beat loopers, crossfader, live WAV/WebM recording, and <strong>Web MIDI hardware controller support</strong>.',
      tip: 'Plug in any USB/Bluetooth MIDI DJ controller and Linus maps it automatically!'
    },
    {
      id: 'studio-customizer',
      title: 'Studio Customizer & Live Wallpapers',
      category: 'Aesthetics',
      icon: 'ph-paint-brush-broad',
      target: '#sidebar-studio-btn',
      openSidebar: true,
      desc: 'Make Linus truly yours. Choose from stunning <strong>procedural canvas motions</strong>, animated <strong>live video wallpapers</strong> (cyber rain, lo-fi anime rooms, ocean waves), custom photo uploads, and atmospheric dimming.',
      tip: 'Live sliders let you tweak transparency, blur, and lighting aura in real time.'
    },
    {
      id: 'fx-launcher',
      title: 'Audio Suite & DSP Enhancers',
      category: 'Pro Audio',
      icon: 'ph-sparkle',
      target: '#fx-launcher-btn',
      desc: 'Open the bottom player <strong>FX</strong> menu to access pro-grade sound processing: <strong>Smart Gain</strong> (consistent loudness), <strong>20s Audio Previews</strong>, <strong>Chameleon Glow</strong> (album art dynamic glow), <strong>Karaoke Mode</strong> (real-time vocal suppression), <strong>10-Band Graphic EQ</strong> with 8D spatial audio, and <strong>Ambient Sleep Sounds</strong> (rain, campfire, cafe, binaural beats).',
      tip: 'Layer gentle rain audio over any song for a serene study or sleep session.'
    },
    {
      id: 'autodj-controls',
      title: 'Smart Auto-DJ & Player Controls',
      category: 'Playback',
      icon: 'ph-headphones',
      target: '#autodj-quick-btn',
      desc: 'Experience nightclub-grade seamless transitions between songs with <strong>Smart Auto-DJ</strong>! Linus matches tempos and blends songs with equal-power crossfading. Also includes playback speed adjustment, queue drawer, and Desktop Picture-in-Picture Mini Player.',
      tip: 'Press "D" on your keyboard anytime to toggle Smart Auto-DJ crossfading!'
    }
  ];

  class LinusTourManager {
    constructor() {
      this.currentStep = 0;
      this.isActive = false;
      this.elements = {};
      this.storageKey = 'linus_tour_completed';
      this.resizeHandler = this.reposition.bind(this);
      this.keyHandler = this.handleKeyDown.bind(this);
    }

    init() {
      this.injectDOM();
      this.bindTriggers();
      this.checkFirstRun();
    }

    injectDOM() {
      // 1. Overlay & Spotlight
      let overlay = document.querySelector('#linus-tour-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'linus-tour-overlay';
        overlay.className = 'linus-tour-overlay';
        overlay.innerHTML = `
          <div class="linus-tour-spotlight" id="linus-tour-spotlight"></div>
          <div class="linus-tour-card" id="linus-tour-card">
            <div class="tour-card-header">
              <div class="tour-header-badges">
                <span class="tour-step-badge" id="tour-step-badge">Step 1 of 14</span>
                <span class="tour-category-badge" id="tour-category-badge">Category</span>
              </div>
              <button class="tour-close-btn" id="tour-close-btn" title="Exit Tour (Esc)">
                <i class="ph ph-x"></i>
              </button>
            </div>
            <div class="tour-card-body">
              <h3 class="tour-title" id="tour-title">
                <i class="ph-bold ph-sparkle" id="tour-icon"></i>
                <span id="tour-title-text">Feature Title</span>
              </h3>
              <p class="tour-desc" id="tour-desc"></p>
              <div class="tour-tip-pill" id="tour-tip-pill">
                <i class="ph-fill ph-lightbulb"></i>
                <span id="tour-tip-text"></span>
              </div>
            </div>
            <div class="tour-progress-bar-wrap">
              <div class="tour-progress-bar-fill" id="tour-progress-bar-fill"></div>
            </div>
            <div class="tour-card-actions">
              <div class="tour-action-left">
                <button class="tour-btn tour-btn-secondary" id="tour-prev-btn">
                  <i class="ph ph-arrow-left"></i> Back
                </button>
                <button class="tour-btn tour-btn-ghost" id="tour-skip-btn">Skip Tour</button>
              </div>
              <div class="tour-action-right">
                <button class="tour-btn tour-btn-primary" id="tour-next-btn">
                  Next <i class="ph ph-arrow-right"></i>
                </button>
              </div>
            </div>
            <div class="tour-kbd-hints">
              <span class="tour-kbd-hint-item"><span class="tour-kbd">→</span> or <span class="tour-kbd">Enter</span> Next</span>
              <span class="tour-kbd-hint-item"><span class="tour-kbd">←</span> Back</span>
              <span class="tour-kbd-hint-item"><span class="tour-kbd">Esc</span> Exit</span>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);
      }

      // 2. Welcome Invitation Modal
      let welcomeModal = document.querySelector('#linus-tour-welcome-modal');
      if (!welcomeModal) {
        welcomeModal = document.createElement('div');
        welcomeModal.id = 'linus-tour-welcome-modal';
        welcomeModal.className = 'linus-tour-modal-backdrop';
        welcomeModal.innerHTML = `
          <div class="linus-tour-dialog">
            <div class="linus-tour-dialog-inner">
              <div class="tour-welcome-icon-wrap">
                <i class="ph-fill ph-vinyl-record"></i>
              </div>
              <h2 class="tour-welcome-title">Welcome to <em>Linus.</em></h2>
              <p class="tour-welcome-subtitle">Your aesthetic listening sanctuary is loaded with powerful music tools, studio DSP effects, and atmospheric vibes.</p>
              
              <div class="tour-feature-highlights-grid">
                <div class="tour-highlight-item">
                  <div class="tour-highlight-icon"><i class="ph-fill ph-globe"></i></div>
                  <div class="tour-highlight-text">
                    <strong>Smart Radio Autoplay</strong>
                    <span>Switch between local & infinite YouTube streams</span>
                  </div>
                </div>
                <div class="tour-highlight-item">
                  <div class="tour-highlight-icon"><i class="ph-fill ph-palette"></i></div>
                  <div class="tour-highlight-text">
                    <strong>Atmospheric Moods</strong>
                    <span>6 circadian vibes, live video wallpapers & aura</span>
                  </div>
                </div>
                <div class="tour-highlight-item">
                  <div class="tour-highlight-icon"><i class="ph-fill ph-quotes"></i></div>
                  <div class="tour-highlight-text">
                    <strong>Synced Karaoke Lyrics</strong>
                    <span>Word-synced scrolling & romanized text</span>
                  </div>
                </div>
                <div class="tour-highlight-item">
                  <div class="tour-highlight-icon"><i class="ph-fill ph-sliders"></i></div>
                  <div class="tour-highlight-text">
                    <strong>Pro DJ Studio & FX</strong>
                    <span>Dual decks, BPM sync, 10-band EQ & 8D audio</span>
                  </div>
                </div>
              </div>

              <div class="tour-modal-actions">
                <button class="tour-welcome-start-btn" id="tour-welcome-start-btn">
                  <i class="ph-fill ph-sparkle"></i> Take Quick Tour (~2 min)
                </button>
                <button class="tour-welcome-skip-btn" id="tour-welcome-skip-btn">
                  Explore on My Own
                </button>
                <span class="tour-revisit-note">You can revisit this tour anytime from the sidebar menu.</span>
              </div>
            </div>
          </div>
        `;
        document.body.appendChild(welcomeModal);
      }

      // 3. Completion / Celebration Modal
      let completeModal = document.querySelector('#linus-tour-complete-modal');
      if (!completeModal) {
        completeModal = document.createElement('div');
        completeModal.id = 'linus-tour-complete-modal';
        completeModal.className = 'linus-tour-modal-backdrop';
        completeModal.innerHTML = `
          <div class="linus-tour-dialog">
            <div class="linus-tour-dialog-inner">
              <div class="tour-welcome-icon-wrap" style="border-color: #22c55e; box-shadow: 0 0 30px rgba(34, 197, 94, 0.4);">
                <i class="ph-fill ph-sparkle" style="color: #22c55e; animation: none;"></i>
              </div>
              <h2 class="tour-welcome-title">You're All <em>Set!</em> 🎉</h2>
              <p class="tour-welcome-subtitle">You are now ready to enjoy the ultimate listening experience. Discover new music, customize your atmosphere, and relax.</p>
              
              <div class="tour-tip-pill" style="margin-bottom: 24px; text-align: left;">
                <i class="ph-fill ph-info"></i>
                <span>Need a refresher later? Click <strong>"Feature Tour"</strong> anytime at the bottom of the sidebar.</span>
              </div>

              <div class="tour-modal-actions">
                <button class="tour-welcome-start-btn" id="tour-complete-finish-btn" style="background: linear-gradient(135deg, var(--accent, #e5a95d), #f59e0b);">
                  <i class="ph-fill ph-play"></i> Start Listening
                </button>
              </div>
            </div>
          </div>
        `;
        document.body.appendChild(completeModal);
      }

      // Cache elements
      this.elements = {
        overlay,
        spotlight: overlay.querySelector('#linus-tour-spotlight'),
        card: overlay.querySelector('#linus-tour-card'),
        stepBadge: overlay.querySelector('#tour-step-badge'),
        categoryBadge: overlay.querySelector('#tour-category-badge'),
        icon: overlay.querySelector('#tour-icon'),
        titleText: overlay.querySelector('#tour-title-text'),
        desc: overlay.querySelector('#tour-desc'),
        tipPill: overlay.querySelector('#tour-tip-pill'),
        tipText: overlay.querySelector('#tour-tip-text'),
        progressFill: overlay.querySelector('#tour-progress-bar-fill'),
        prevBtn: overlay.querySelector('#tour-prev-btn'),
        nextBtn: overlay.querySelector('#tour-next-btn'),
        skipBtn: overlay.querySelector('#tour-skip-btn'),
        closeBtn: overlay.querySelector('#tour-close-btn'),
        welcomeModal,
        completeModal
      };

      // Wire tour action buttons
      this.elements.nextBtn.addEventListener('click', () => this.next());
      this.elements.prevBtn.addEventListener('click', () => this.prev());
      this.elements.skipBtn.addEventListener('click', () => this.end(true));
      this.elements.closeBtn.addEventListener('click', () => this.end(true));

      // Wire welcome modal buttons
      document.querySelector('#tour-welcome-start-btn')?.addEventListener('click', () => {
        this.hideWelcome();
        this.start();
      });
      document.querySelector('#tour-welcome-skip-btn')?.addEventListener('click', () => {
        this.hideWelcome();
        this.markCompleted();
      });

      // Wire complete modal buttons
      document.querySelector('#tour-complete-finish-btn')?.addEventListener('click', () => {
        this.hideComplete();
      });
    }

    bindTriggers() {
      // Sidebar "Feature Tour" button
      const sidebarBtn = document.querySelector('#sidebar-tour-btn');
      if (sidebarBtn) {
        sidebarBtn.addEventListener('click', (e) => {
          e.preventDefault();
          this.start();
        });
      }
    }

    checkFirstRun() {
      const hasCompleted = localStorage.getItem(this.storageKey);
      if (!hasCompleted) {
        // Delay slightly for smooth app boot and sidebar intro animation
        setTimeout(() => {
          this.showWelcome();
        }, 1200);
      }
    }

    showWelcome() {
      this.elements.welcomeModal?.classList.add('active');
    }

    hideWelcome() {
      this.elements.welcomeModal?.classList.remove('active');
    }

    showComplete() {
      this.elements.completeModal?.classList.add('active');
      this.triggerConfetti();
    }

    hideComplete() {
      this.elements.completeModal?.classList.remove('active');
    }

    markCompleted() {
      localStorage.setItem(this.storageKey, 'true');
    }

    start(stepIndex = 0) {
      this.isActive = true;
      this.currentStep = stepIndex;
      this.elements.overlay.classList.add('active');

      window.addEventListener('resize', this.resizeHandler);
      window.addEventListener('scroll', this.resizeHandler, true);
      document.addEventListener('keydown', this.keyHandler);

      this.renderStep();
    }

    next() {
      if (this.currentStep < TOUR_STEPS.length - 1) {
        this.currentStep++;
        this.renderStep();
      } else {
        this.end(true, true);
      }
    }

    prev() {
      if (this.currentStep > 0) {
        this.currentStep--;
        this.renderStep();
      }
    }

    end(markDone = true, showCelebration = false) {
      this.isActive = false;
      this.elements.overlay.classList.remove('active');
      this.elements.card.classList.remove('visible');

      window.removeEventListener('resize', this.resizeHandler);
      window.removeEventListener('scroll', this.resizeHandler, true);
      document.removeEventListener('keydown', this.keyHandler);

      if (markDone) {
        this.markCompleted();
      }

      if (showCelebration) {
        this.showComplete();
      }
    }

    handleKeyDown(e) {
      if (!this.isActive) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this.end(true);
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        this.next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.prev();
      }
    }

    renderStep() {
      const step = TOUR_STEPS[this.currentStep];
      if (!step) return;

      // Ensure target view is active
      if (step.view) {
        const viewBtn = document.querySelector(`[data-view="${step.view}"]`);
        if (viewBtn && !viewBtn.classList.contains('active')) {
          viewBtn.click();
        }
      }

      // Ensure sidebar is visible if target is in sidebar
      if (step.openSidebar) {
        const sidebar = document.querySelector('#sidebar');
        if (sidebar && !sidebar.classList.contains('active') && !sidebar.classList.contains('pinned')) {
          sidebar.classList.add('active');
        }
      }

      // Fill in content
      const total = TOUR_STEPS.length;
      this.elements.stepBadge.textContent = `Step ${this.currentStep + 1} of ${total}`;
      this.elements.categoryBadge.textContent = step.category || 'Feature';
      this.elements.icon.className = `ph-bold ${step.icon || 'ph-sparkle'}`;
      this.elements.titleText.textContent = step.title;
      this.elements.desc.innerHTML = step.desc;

      if (step.tip) {
        this.elements.tipText.textContent = step.tip;
        this.elements.tipPill.style.display = 'flex';
      } else {
        this.elements.tipPill.style.display = 'none';
      }

      // Progress bar fill
      const progressPercent = Math.round(((this.currentStep + 1) / total) * 100);
      this.elements.progressFill.style.width = `${progressPercent}%`;

      // Update button states
      this.elements.prevBtn.disabled = this.currentStep === 0;
      if (this.currentStep === total - 1) {
        this.elements.nextBtn.innerHTML = `Finish Tour <i class="ph-fill ph-sparkle"></i>`;
      } else {
        this.elements.nextBtn.innerHTML = `Next <i class="ph ph-arrow-right"></i>`;
      }

      // Allow a brief frame for DOM updates/view changes, then position spotlight & card
      requestAnimationFrame(() => {
        setTimeout(() => {
          this.reposition();
          this.elements.card.classList.add('visible');
        }, 50);
      });
    }

    reposition() {
      if (!this.isActive) return;

      const step = TOUR_STEPS[this.currentStep];
      const targetEl = document.querySelector(step.target);

      const spotlight = this.elements.spotlight;
      const card = this.elements.card;

      if (!targetEl || targetEl.offsetParent === null) {
        // Target is not visible or not found on screen; center card in viewport
        spotlight.style.opacity = '0';
        card.style.top = '50%';
        card.style.left = '50%';
        card.style.transform = 'translate(-50%, -50%) scale(1)';
        return;
      }

      // Scroll into view if outside viewport
      const rect = targetEl.getBoundingClientRect();
      const inViewport = (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
      );

      if (!inViewport) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }

      // Re-query bounding rect after scroll
      const currentRect = targetEl.getBoundingClientRect();
      const padding = 8;
      const spotTop = Math.max(0, currentRect.top - padding);
      const spotLeft = Math.max(0, currentRect.left - padding);
      const spotWidth = currentRect.width + (padding * 2);
      const spotHeight = currentRect.height + (padding * 2);

      // Apply spotlight coordinates
      spotlight.style.opacity = '1';
      spotlight.style.top = `${spotTop}px`;
      spotlight.style.left = `${spotLeft}px`;
      spotlight.style.width = `${spotWidth}px`;
      spotlight.style.height = `${spotHeight}px`;

      // Match border-radius of target if available
      const computed = window.getComputedStyle(targetEl);
      spotlight.style.borderRadius = computed.borderRadius && computed.borderRadius !== '0px'
        ? computed.borderRadius
        : '16px';

      // Smart Card Positioning
      const cardWidth = card.offsetWidth || 420;
      const cardHeight = card.offsetHeight || 300;
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      const margin = 18;

      let cardTop = 0;
      let cardLeft = 0;

      // Small screens: dock neatly to bottom or top
      if (winW <= 640) {
        cardLeft = 14;
        if (currentRect.bottom + cardHeight + margin < winH) {
          cardTop = currentRect.bottom + margin;
        } else if (currentRect.top - cardHeight - margin > 0) {
          cardTop = currentRect.top - cardHeight - margin;
        } else {
          cardTop = Math.max(14, winH - cardHeight - 14);
        }
        card.style.top = `${cardTop}px`;
        card.style.left = `${cardLeft}px`;
        card.style.transform = 'translateY(0) scale(1)';
        return;
      }

      // Desktop: Prefer positioning below the element, then above, then right, then left
      const spaceBelow = winH - currentRect.bottom;
      const spaceAbove = currentRect.top;
      const spaceRight = winW - currentRect.right;
      const spaceLeft = currentRect.left;

      if (spaceBelow >= cardHeight + margin) {
        // Below
        cardTop = currentRect.bottom + margin;
        cardLeft = Math.min(Math.max(margin, currentRect.left), winW - cardWidth - margin);
      } else if (spaceAbove >= cardHeight + margin) {
        // Above
        cardTop = currentRect.top - cardHeight - margin;
        cardLeft = Math.min(Math.max(margin, currentRect.left), winW - cardWidth - margin);
      } else if (spaceRight >= cardWidth + margin) {
        // Right
        cardLeft = currentRect.right + margin;
        cardTop = Math.min(Math.max(margin, currentRect.top), winH - cardHeight - margin);
      } else if (spaceLeft >= cardWidth + margin) {
        // Left
        cardLeft = currentRect.left - cardWidth - margin;
        cardTop = Math.min(Math.max(margin, currentRect.top), winH - cardHeight - margin);
      } else {
        // Fallback: Best fit
        cardTop = Math.min(Math.max(margin, currentRect.top), winH - cardHeight - margin);
        cardLeft = Math.min(Math.max(margin, currentRect.left), winW - cardWidth - margin);
      }

      // Clamping to screen boundaries
      cardTop = Math.max(margin, Math.min(winH - cardHeight - margin, cardTop));
      cardLeft = Math.max(margin, Math.min(winW - cardWidth - margin, cardLeft));

      card.style.top = `${cardTop}px`;
      card.style.left = `${cardLeft}px`;
      card.style.transform = 'translateY(0) scale(1)';
    }

    triggerConfetti() {
      // Use existing spawnConfettiParticles if exposed, or trigger inline aesthetic confetti
      if (typeof window.spawnConfettiParticles === 'function') {
        const x = window.innerWidth / 2;
        const y = window.innerHeight / 2;
        window.spawnConfettiParticles(x, y);
      } else {
        const container = document.querySelector('#vibe-confetti-container');
        if (!container) return;
        
        container.innerHTML = '';
        const colors = ['#e5a95d', '#d946ef', '#38bdf8', '#22c55e', '#f59e0b', '#fff'];
        for (let i = 0; i < 60; i++) {
          const p = document.createElement('div');
          p.className = 'confetti-particle';
          p.style.left = `${Math.random() * 100}%`;
          p.style.top = `-20px`;
          p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
          p.style.width = `${Math.random() * 8 + 6}px`;
          p.style.height = `${Math.random() * 12 + 6}px`;
          p.style.position = 'fixed';
          p.style.zIndex = '999999';
          p.style.borderRadius = '3px';
          p.style.pointerEvents = 'none';
          p.style.transform = `rotate(${Math.random() * 360}deg)`;
          p.style.transition = `transform ${Math.random() * 2 + 2}s cubic-bezier(0.25, 1, 0.5, 1), top ${Math.random() * 2 + 2}s ease-in, opacity 2.5s ease-out`;

          container.appendChild(p);

          setTimeout(() => {
            p.style.top = `${window.innerHeight + 50}px`;
            p.style.transform = `rotate(${Math.random() * 720}deg) translateX(${Math.random() * 100 - 50}px)`;
            p.style.opacity = '0';
          }, 20);

          setTimeout(() => p.remove(), 4500);
        }
      }
    }
  }

  // Expose to window
  const tourInstance = new LinusTourManager();
  window.LinusTour = {
    start: (step = 0) => tourInstance.start(step),
    showWelcome: () => tourInstance.showWelcome(),
    reset: () => {
      localStorage.removeItem(tourInstance.storageKey);
      tourInstance.showWelcome();
    }
  };

  // Initialize once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tourInstance.init());
  } else {
    tourInstance.init();
  }
})();
