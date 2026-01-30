(function () {
    // ═══════════════════════════════════════════════════════════════════════════
    // SPOTIFY CONVERTER PLUGIN - API VERSION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * SpotifyClient: Handles token fetching and API requests using Client Credentials Flow.
     * Uses 'api.fetch' to bypass CORS limitations.
     */
    class SpotifyClient {
        static instance = null;

        constructor(api) {
            if (SpotifyClient.instance) return SpotifyClient.instance;

            this.api = api;
            this.clientId = null;
            this.clientSecret = null;
            this.accessToken = null;
            this.tokenExpiry = null;

            SpotifyClient.instance = this;
        }

        static getInstance(api) {
            if (!SpotifyClient.instance) {
                if (!api) throw new Error("SpotifyClient needs api in first init");
                new SpotifyClient(api);
            }
            return SpotifyClient.instance;
        }

        setCredentials(clientId, clientSecret) {
            this.clientId = clientId;
            this.clientSecret = clientSecret;
            // Clear existing token to force refresh with new credentials
            this.accessToken = null;
            this.tokenExpiry = null;
        }

        /**
         * Strategy 1: Client Credentials Flow
         */
        async getClientCredentialsToken() {
            if (!this.clientId || !this.clientSecret) return null;

            try {
                // Base64 encode credentials
                const credentials = btoa(`${this.clientId}:${this.clientSecret}`);

                const response = await this.api.fetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: 'grant_type=client_credentials'
                });

                if (!response.ok) throw new Error(`Client Creds fetch failed: ${response.status}`);

                const data = await response.json();

                if (data.access_token) {
                    this.accessToken = data.access_token;
                    // Token expires in seconds, convert to milliseconds
                    this.tokenExpiry = Date.now() + (data.expires_in * 1000);
                    return this.accessToken;
                }
            } catch (error) {
                console.warn('SpotifyClient: Client Credentials flow failed', error);
            }
            return null;
        }

        /**
         * Strategy 2: Web Token Flow (Fallback)
         */
        async getWebToken() {
            try {
                const response = await this.api.fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });

                if (!response.ok) throw new Error(`Web token fetch failed: ${response.status}`);

                const data = await response.json();
                if (data.accessToken) {
                    this.accessToken = data.accessToken;
                    this.tokenExpiry = data.accessTokenExpirationTimestampMs;
                    return this.accessToken;
                }
            } catch (error) {
                console.warn('SpotifyClient: Web Token flow failed', error);
            }
            return null;
        }

        isTokenExpired() {
            if (!this.tokenExpiry) return true;
            // Refresh 1 minute before expiry
            return Date.now() > (this.tokenExpiry - 60000);
        }

        async ensureValidToken() {
            if (!this.accessToken || this.isTokenExpired()) {
                // Try Client Credentials first
                let token = await this.getClientCredentialsToken();

                // Fallback to Web Token
                if (!token) {
                    console.log('SpotifyClient: Falling back to Web Token strategy');
                    token = await this.getWebToken();
                }

                if (!token) {
                    throw new Error('Unable to acquire Spotify token. Please check your credentials or try again later.');
                }
            }
            return this.accessToken;
        }

        async get(url, params = {}) {
            await this.ensureValidToken();

            const urlObj = new URL(url);
            Object.keys(params).forEach(key =>
                urlObj.searchParams.append(key, params[key])
            );

            const res = await this.api.fetch(urlObj.toString(), {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (!res.ok) {
                if (res.status === 401) {
                    // Token expired, refresh and retry
                    this.accessToken = null;
                    await this.ensureValidToken();

                    const retryRes = await this.api.fetch(urlObj.toString(), {
                        headers: { 'Authorization': `Bearer ${this.accessToken}` }
                    });

                    if (!retryRes.ok) {
                        throw new Error(`Spotify API Error: ${retryRes.status}`);
                    }
                    return await retryRes.json();
                }
                throw new Error(`Spotify API Error: ${res.status}`);
            }

            return await res.json();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PLUGIN LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    const SpotifyConverter = {
        name: 'Spotify Converter',
        api: null,
        client: null,

        // ADD THESE CREDENTIALS
        SPOTIFY_CLIENT_ID: 'YOUR_CLIENT_ID_HERE',
        SPOTIFY_CLIENT_SECRET: 'YOUR_CLIENT_SECRET_HERE',

        isOpen: false,
        isConverting: false,
        stopConversion: false,

        // API endpoints
        TIDAL_API_BASE: 'https://katze.qqdl.site',
        SPOTIFY_API_BASE: 'https://api.spotify.com/v1',

        async init(api) {
            console.log('[SpotifyConverter] Initializing...');
            this.api = api;
            this.client = SpotifyClient.getInstance(api);

            // Load saved credentials
            try {
                if (this.api.storage && this.api.storage.get) {
                    const savedClientId = await this.api.storage.get('spotify_client_id');
                    const savedClientSecret = await this.api.storage.get('spotify_client_secret');

                    if (savedClientId && savedClientSecret) {
                        this.client.setCredentials(savedClientId, savedClientSecret);
                        console.log('[SpotifyConverter] Loaded saved credentials');
                    }
                }
            } catch (e) {
                console.warn('Failed to load credentials', e);
            }

            this.injectStyles();
            this.createModal();
            this.createMenuButton();

            console.log('[SpotifyConverter] Ready');
        },

        injectStyles() {
            if (document.getElementById('spotify-converter-styles')) return;

            const style = document.createElement('style');
            style.id = 'spotify-converter-styles';
            style.textContent = `
                #spotify-converter-modal {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.9);
                    background: var(--bg-elevated, #181818);
                    border: 1px solid var(--border-color, #404040);
                    border-radius: 16px;
                    padding: 24px;
                    width: 500px;
                    max-width: 90vw;
                    z-index: 10001;
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                    opacity: 0;
                    visibility: hidden;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }

                #spotify-converter-modal.open {
                    opacity: 1;
                    visibility: visible;
                    transform: translate(-50%, -50%) scale(1);
                }

                #spotify-converter-overlay {
                    position: fixed;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.6);
                    backdrop-filter: blur(4px);
                    z-index: 10000;
                    opacity: 0;
                    visibility: hidden;
                    transition: opacity 0.3s ease;
                }

                #spotify-converter-overlay.open {
                    opacity: 1;
                    visibility: visible;
                }

                .sc-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }

                .sc-header h2 {
                    margin: 0;
                    color: var(--text-primary, #fff);
                    font-size: 20px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .sc-icon {
                    color: #1DB954;
                }

                .sc-close-btn {
                    background: transparent;
                    border: none;
                    color: var(--text-secondary, #b3b3b3);
                    font-size: 20px;
                    cursor: pointer;
                    padding: 4px;
                }
                .sc-close-btn:hover { color: #fff; }

                .sc-input-group {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                
                .sc-details {
                    font-size: 12px;
                    color: #888;
                    margin-top: -4px;
                }

                .sc-input {
                    background: var(--bg-surface, #282828);
                    border: 1px solid var(--border-color, #404040);
                    color: var(--text-primary, #fff);
                    padding: 12px;
                    border-radius: 8px;
                    font-size: 14px;
                    width: 100%;
                    box-sizing: border-box;
                }
                .sc-input:focus {
                    outline: none;
                    border-color: #1DB954;
                }

                .sc-btn {
                    background: #1DB954;
                    color: #fff;
                    border: none;
                    padding: 12px;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: transform 0.1s;
                }
                .sc-btn:hover:not(:disabled) { transform: scale(1.02); filter: brightness(1.1); }
                .sc-btn:disabled { opacity: 0.6; cursor: not-allowed; }
                .sc-btn.secondary { background: var(--bg-highlight, #3e3e3e); }
                .sc-btn.help { 
                    background: transparent; 
                    border: 1px solid var(--border-color, #404040); 
                    color: var(--text-secondary, #b3b3b3);
                    padding: 8px 12px;
                    font-size: 12px;
                }
                .sc-btn.help:hover {
                    border-color: #1DB954;
                    color: #1DB954;
                }

                .sc-help-box {
                    background: var(--bg-surface, #282828);
                    border: 1px solid var(--border-color, #404040);
                    border-radius: 8px;
                    padding: 16px;
                    margin-bottom: 16px;
                    font-size: 13px;
                    color: var(--text-secondary, #b3b3b3);
                    display: none;
                }
                .sc-help-box.visible { display: block; }
                .sc-help-box a { color: #1DB954; text-decoration: none; }
                .sc-help-box ul { margin: 8px 0; padding-left: 20px; }
                .sc-help-box li { margin-bottom: 4px; }

                .sc-log {
                    background: #000;
                    border-radius: 8px;
                    padding: 12px;
                    height: 150px;
                    overflow-y: auto;
                    font-family: monospace;
                    font-size: 12px;
                    color: #bbb;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .sc-log-item.success { color: #1DB954; }
                .sc-log-item.error { color: #ff5555; }
                .sc-log-item.warn { color: #ffb86c; }

                .sc-progress-bar {
                    height: 6px;
                    background: var(--bg-highlight, #3e3e3e);
                    border-radius: 3px;
                    overflow: hidden;
                }
                .sc-progress-value {
                    height: 100%;
                    background: #1DB954;
                    width: 0%;
                    transition: width 0.3s;
                }
            `;
            document.head.appendChild(style);
        },

        createModal() {
            const overlay = document.createElement('div');
            overlay.id = 'spotify-converter-overlay';
            overlay.onclick = () => { if (!this.isConverting) this.close(); };
            document.body.appendChild(overlay);

            const modal = document.createElement('div');
            modal.id = 'spotify-converter-modal';
            modal.innerHTML = `
                <div class="sc-header">
                    <h2>
                        <svg class="sc-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.38 9.841-.719 13.44 1.56.42.3.6.84.3 1.26zm.12-3.36C14.939 8.46 8.641 8.28 5.1 9.421c-.6.18-1.26-.12-1.441-.72-.18-.6.12-1.26.72-1.44 4.08-1.26 11.04-1.02 15.361 1.56.6.358.779 1.14.421 1.74-.359.6-1.14.779-1.741.419z"/>
                        </svg>
                        Spotify to Audion
                    </h2>
                    <div style="display:flex; gap:8px;">
                        <button class="sc-btn help" id="sc-help-btn">Need Help?</button>
                        <button class="sc-close-btn" id="sc-close-btn">✕</button>
                    </div>
                </div>

                <div class="sc-help-box" id="sc-help-content">
                    <strong>How to get credentials:</strong>
                    <ul>
                        <li>Go to <a href="#" onclick="window.open('https://developer.spotify.com/dashboard')">Spotify Developer Dashboard</a></li>
                        <li>Log in and create an app</li>
                        <li>Copy the Client ID and Client Secret</li>
                    </ul>
                    <hr style="border:0; border-top:1px solid #444; margin:10px 0;">
                    <strong>Alternative:</strong><br>
                    Join our <a href="#" onclick="window.open('https://discord.gg/audion')">Discord Server</a> to apply for a shared API key.
                </div>

                <div class="sc-input-group">
                    <label>Spotify Client ID (Optional)</label>
                    <input type="text" id="sc-client-id" class="sc-input" placeholder="Enter Client ID from Developer Dashboard">
                </div>

                <div class="sc-input-group">
                    <label>Spotify Client Secret (Optional)</label>
                    <input type="password" id="sc-client-secret" class="sc-input" placeholder="Enter Client Secret">
                    <div class="sc-details">Leave empty to use web scraping (less reliable).</div>
                </div>

                <div class="sc-input-group">
                    <label>Spotify Playlist URL</label>
                    <input type="text" id="sc-url-input" class="sc-input" placeholder="https://open.spotify.com/playlist/...">
                </div>

                <div class="sc-progress-bar">
                    <div class="sc-progress-value" id="sc-progress"></div>
                </div>

                <div class="sc-log" id="sc-log">
                    <div class="sc-log-item">Ready to convert...</div>
                </div>

                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button class="sc-btn secondary" id="sc-stop-btn" disabled>Stop</button>
                    <button class="sc-btn" id="sc-convert-btn">Convert</button>
                </div>
            `;
            document.body.appendChild(modal);

            // Populate Inputs if credentials exist
            if (this.client.clientId) document.getElementById('sc-client-id').value = this.client.clientId;
            if (this.client.clientSecret) document.getElementById('sc-client-secret').value = this.client.clientSecret;

            // Events
            modal.querySelector('#sc-close-btn').onclick = () => this.close();
            modal.querySelector('#sc-convert-btn').onclick = () => this.startConversion();
            modal.querySelector('#sc-stop-btn').onclick = () => { this.stopConversion = true; };

            // Help toggle
            modal.querySelector('#sc-help-btn').onclick = () => {
                const helpBox = document.getElementById('sc-help-content');
                helpBox.classList.toggle('visible');
            };

            // Auto-save credentials on change
            modal.querySelector('#sc-client-id').onchange = (e) => this.saveCredentials();
            modal.querySelector('#sc-client-secret').onchange = (e) => this.saveCredentials();
        },

        async saveCredentials() {
            const cid = document.getElementById('sc-client-id').value.trim();
            const sec = document.getElementById('sc-client-secret').value.trim();

            this.client.setCredentials(cid, sec);

            try {
                if (this.api.storage && this.api.storage.set) {
                    await this.api.storage.set('spotify_client_id', cid);
                    await this.api.storage.set('spotify_client_secret', sec);
                }
            } catch (e) {
                console.warn('Failed to save credentials', e);
            }
        },

        createMenuButton() {
            const btn = document.createElement('button');
            btn.className = 'plugin-menu-btn';
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 12h20M2 12l5-5m-5 5l5 5"/>
                    <circle cx="12" cy="12" r="10"/>
                </svg>
                <span>Import Spotify Playlist</span>
            `;
            btn.onclick = () => this.open();

            this.api.ui.registerSlot('playerbar:menu', btn);
        },

        // ═══════════════════════════════════════════════════════════════════════
        // SPOTIFY API METHODS
        // ═══════════════════════════════════════════════════════════════════════

        async fetchPlaylistFromAPI(playlistId) {
            // Get playlist details
            const data = await this.client.get(`${this.SPOTIFY_API_BASE}/playlists/${playlistId}`);

            const tracks = [];
            // Add first batch
            data.tracks.items.forEach(item => this.parseTrackItem(item, tracks));

            // Fetch remaining pages
            let nextUrl = data.tracks.next;

            // Safety limit prevents infinite loops on massive playlists
            const MAX_TRACKS = 5000;

            while (nextUrl && !this.stopConversion && tracks.length < MAX_TRACKS) {
                this.log(`Fetching more tracks (${tracks.length} so far)...`, 'info');

                // Use client.get() ensuring valid token
                const nextData = await this.client.get(nextUrl);

                nextData.items.forEach(item => this.parseTrackItem(item, tracks));

                nextUrl = nextData.next;
                // Small delay to be nice to API
                await new Promise(r => setTimeout(r, 50));
            }

            return {
                title: data.name,
                description: data.description,
                tracks: tracks
            };
        },

        parseTrackItem(item, list) {
            if (item.track && !item.track.is_local) {
                const t = item.track;
                list.push({
                    title: t.name,
                    artist: t.artists.map(a => a.name).join(', '),
                    album: t.album.name,
                    isrc: t.external_ids?.isrc,
                    duration_ms: t.duration_ms
                });
            }
        },

        // ═══════════════════════════════════════════════════════════════════════
        // MAIN LOGIC
        // ═══════════════════════════════════════════════════════════════════════

        open() {
            this.isOpen = true;
            document.getElementById('spotify-converter-overlay').classList.add('open');
            document.getElementById('spotify-converter-modal').classList.add('open');
            document.getElementById('sc-url-input').focus();
        },

        close() {
            if (this.isConverting) return;
            this.isOpen = false;
            document.getElementById('spotify-converter-overlay').classList.remove('open');
            document.getElementById('spotify-converter-modal').classList.remove('open');
        },

        log(msg, type = 'info') {
            const log = document.getElementById('sc-log');
            const item = document.createElement('div');
            item.className = `sc-log-item ${type}`;
            item.textContent = `> ${msg}`;
            log.appendChild(item);
            log.scrollTop = log.scrollHeight;
        },

        updateProgress(percent) {
            document.getElementById('sc-progress').style.width = `${percent}%`;
        },

        async getTidalLibraryMap() {
            const map = new Map();
            if (this.api.library.getTracks) {
                try {
                    const tracks = await this.api.library.getTracks();
                    if (Array.isArray(tracks)) {
                        tracks.forEach(t => {
                            if (t.source_type === 'tidal' && t.external_id) {
                                map.set(String(t.external_id), t.id);
                            }
                        });
                    }
                } catch (e) { console.error(e); }
            }
            return map;
        },

        async startConversion() {
            const urlInput = document.getElementById('sc-url-input');
            const url = urlInput.value.trim();
            const btn = document.getElementById('sc-convert-btn');
            const stopBtn = document.getElementById('sc-stop-btn');

            if (!url.includes('spotify.com/playlist/')) {
                this.log('Invalid Spotify playlist URL', 'error');
                return;
            }

            // Extract playlist ID
            const playlistIdMatch = url.match(/playlist\/([a-zA-Z0-9]+)/);
            if (!playlistIdMatch) {
                this.log('Could not extract playlist ID', 'error');
                return;
            }
            const playlistId = playlistIdMatch[1];

            this.isConverting = true;
            this.stopConversion = false;
            btn.disabled = true;
            stopBtn.disabled = false;
            urlInput.disabled = true;
            this.updateProgress(0);

            document.getElementById('sc-log').innerHTML = '';
            this.log('Starting conversion...');

            try {
                // 1. Fetch playlist data using the new Client
                this.log('Connecting to Spotify...', 'info');

                // Ensure we have a token first
                try {
                    await this.client.ensureValidToken();
                } catch (e) {
                    this.log('Failed to get Spotify Token. Please login to Spotify Web Player in your browser.', 'error');
                    throw e;
                }

                this.log('Fetching playlist...', 'info');
                const playlistData = await this.fetchPlaylistFromAPI(playlistId);
                this.log(`Found: "${playlistData.title}" with ${playlistData.tracks.length} tracks`, 'success');

                // 2. Pre-fetch library map for fast dup-checking
                this.log('Checking existing library...', 'info');
                const existingTracks = await this.getTidalLibraryMap();
                this.log(`Loaded ${existingTracks.size} existing Tidal tracks`, 'info');

                // 3. Create Audion playlist
                this.log('Creating local playlist...', 'info');
                const audionPlaylistId = await this.api.library.createPlaylist(playlistData.title);

                // 4. Process tracks concurrently
                // Worker Pool Pattern
                const concurrency = 5; // Run 5 searches/adds in parallel
                const total = playlistData.tracks.length;
                let processed = 0;
                let successes = 0;

                // Create a queue
                const queue = [...playlistData.tracks];
                const activeWorkers = [];

                const worker = async () => {
                    while (queue.length > 0 && !this.stopConversion) {
                        const track = queue.shift();

                        try {
                            const query = track.isrc ? `isrc:${track.isrc}` : `${track.title} ${track.artist}`;

                            // Log only every 5th track or so to reduce spam, or just progress
                            // this.log(`Searching: ${track.title}`, 'info');

                            // Find best match
                            const tidalTrack = await this.searchTidal(track);

                            if (tidalTrack) {
                                const tidalId = String(tidalTrack.id);
                                let trackId;

                                if (existingTracks.has(tidalId)) {
                                    trackId = existingTracks.get(tidalId);
                                } else {
                                    trackId = await this.addTrackToLibrary(tidalTrack);
                                    existingTracks.set(tidalId, trackId);
                                }

                                await this.api.library.addTrackToPlaylist(audionPlaylistId, trackId);
                                successes++;
                            }

                            processed++;
                            if (processed % 5 === 0 || processed === total) {
                                this.updateProgress((processed / total) * 100);
                                this.log(`Processed ${processed}/${total} tracks...`, 'info');
                            }

                        } catch (err) {
                            console.error(err);
                            // this.log(`Error processing ${track.title}`, 'error');
                            processed++;
                        }
                    }
                };

                // Start workers
                for (let i = 0; i < concurrency; i++) {
                    activeWorkers.push(worker());
                }

                await Promise.all(activeWorkers);

                if (this.stopConversion) {
                    this.log('Conversion stopped by user.', 'warn');
                } else {
                    this.log(`Done! Imported ${successes}/${total} tracks`, 'success');
                    if (this.api.library.refresh) this.api.library.refresh();
                }

            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
            } finally {
                this.isConverting = false;
                btn.disabled = false;
                stopBtn.disabled = true;
                urlInput.disabled = false;
            }
        },

        async searchTidal(sourceTrack) {
            try {
                // 1. Try ISRC search first (Highly accurate)
                if (sourceTrack.isrc) {
                    // Try fetch via ISRC if API supported it, but we can stick to search for now or use the track endpoint
                    // const res = await this.api.fetch(...) 
                }

                // Standard search
                const query = `${sourceTrack.title} ${sourceTrack.artist}`;
                const response = await this.api.fetch(`${this.TIDAL_API_BASE}/search/?s=${encodeURIComponent(query)}`);

                if (!response.ok) return null;
                const data = await response.json();

                if (data.data && data.data.items && data.data.items.length > 0) {
                    // Filter Logic:
                    // 1. If we have duration, check if it's within tolerance (e.g. +/- 10s)
                    const matches = data.data.items;

                    if (sourceTrack.duration_ms) {
                        const sourceSec = sourceTrack.duration_ms / 1000;
                        const validDuration = matches.find(m => {
                            const diff = Math.abs(m.duration - sourceSec);
                            return diff < 10; // 10 seconds tolerance
                        });

                        // If we found a duration match, return it
                        if (validDuration) return validDuration;
                    }

                    // Fallback to first result if no duration match (or no duration info)
                    return matches[0];
                }
            } catch (e) {
                console.warn('Tidal search failed', e);
            }
            return null;
        },

        async addTrackToLibrary(tidalTrack) {
            const artistName = tidalTrack.artist?.name || tidalTrack.artists?.[0]?.name || 'Unknown Artist';
            const title = tidalTrack.title + (tidalTrack.version ? ` (${tidalTrack.version})` : '');

            // High res cover if available
            const coverUrl = tidalTrack.album?.cover
                ? `https://resources.tidal.com/images/${tidalTrack.album.cover.replace(/-/g, '/')}/1280x1280.jpg`
                : null;

            const trackData = {
                title: title,
                artist: artistName,
                album: tidalTrack.album?.title || null,
                duration: tidalTrack.duration || null,
                cover_url: coverUrl,
                source_type: 'tidal',
                external_id: String(tidalTrack.id),
                format: 'LOSSLESS',
                bitrate: null
            };

            return await this.api.library.addExternalTrack(trackData);
        }
    };

    window.SpotifyConverter = SpotifyConverter;
    window.AudionPlugin = SpotifyConverter;
})();
