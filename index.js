(function () {
    // ═══════════════════════════════════════════════════════════════════════════
    // SPOTIFY CONVERTER PLUGIN - API VERSION
    // ═══════════════════════════════════════════════════════════════════════════

    const SpotifyConverter = {
        name: 'Spotify Converter',
        api: null,
        isOpen: false,
        isConverting: false,
        stopConversion: false,
        spotifyToken: null,

        // API endpoints
        TIDAL_API_BASE: 'https://katze.qqdl.site',
        SPOTIFY_API_BASE: 'https://api.spotify.com/v1',

        init(api) {
            console.log('[SpotifyConverter] Initializing...');
            this.api = api;

            this.injectStyles();
            this.createModal();
            this.createMenuButton();

            console.log('[SpotifyConverter] Ready');
        },

        // ═══════════════════════════════════════════════════════════════════════
        // UI (Same as before)
        // ═══════════════════════════════════════════════════════════════════════

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

                .sc-input {
                    background: var(--bg-surface, #282828);
                    border: 1px solid var(--border-color, #404040);
                    color: var(--text-primary, #fff);
                    padding: 12px;
                    border-radius: 8px;
                    font-size: 14px;
                    width: 100%;
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

                .sc-log {
                    background: #000;
                    border-radius: 8px;
                    padding: 12px;
                    height: 200px;
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
                    <button class="sc-close-btn" id="sc-close-btn">✕</button>
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

            // Events
            modal.querySelector('#sc-close-btn').onclick = () => this.close();
            modal.querySelector('#sc-convert-btn').onclick = () => this.startConversion();
            modal.querySelector('#sc-stop-btn').onclick = () => { this.stopConversion = true; };
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
        // SPOTIFY API TOKEN EXTRACTION
        // ═══════════════════════════════════════════════════════════════════════

        async extractSpotifyToken() {
            // Method 1: Try to get token from open.spotify.com session
            try {
                this.log('Attempting to extract Spotify token...', 'info');

                // Open Spotify in hidden iframe to get token from their app
                const iframe = document.createElement('iframe');
                iframe.style.display = 'none';
                iframe.src = 'https://open.spotify.com';
                document.body.appendChild(iframe);

                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for load

                // Try to access localStorage/sessionStorage from iframe
                try {
                    const iframeWindow = iframe.contentWindow;
                    
                    // Look for token in localStorage
                    for (let i = 0; i < iframeWindow.localStorage.length; i++) {
                        const key = iframeWindow.localStorage.key(i);
                        const value = iframeWindow.localStorage.getItem(key);
                        
                        // Spotify stores tokens in various keys
                        if (key && value && (key.includes('token') || key.includes('auth'))) {
                            try {
                                const parsed = JSON.parse(value);
                                if (parsed.accessToken) {
                                    document.body.removeChild(iframe);
                                    this.log('Token extracted successfully!', 'success');
                                    return parsed.accessToken;
                                }
                            } catch (e) {
                                // Not JSON, might be direct token
                                if (value.length > 100 && value.includes('.')) {
                                    document.body.removeChild(iframe);
                                    this.log('Token extracted successfully!', 'success');
                                    return value;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Cross-origin access blocked:', e);
                }

                document.body.removeChild(iframe);
            } catch (e) {
                console.error('Token extraction failed:', e);
            }

            // Method 2: Fetch playlist page and extract from HTML/scripts
            return null;
        },

        async extractTokenFromPage(playlistUrl) {
            try {
                this.log('Fetching playlist page for token...', 'info');
                
                const proxies = [
                    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
                    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
                ];

                let html = null;
                
                for (const proxyFn of proxies) {
                    const proxyUrl = proxyFn(playlistUrl);
                    try {
                        const res = await fetch(proxyUrl);
                        if (res.ok) {
                            html = await res.text();
                            break;
                        }
                    } catch (e) {
                        console.warn('Proxy failed:', e);
                    }
                }

                if (!html) return null;

                // Look for access token in scripts
                // Spotify embeds token in: window.Spotify = {...} or similar
                const tokenMatch = html.match(/"accessToken":"([^"]+)"/);
                if (tokenMatch && tokenMatch[1]) {
                    this.log('Token found in page source!', 'success');
                    return tokenMatch[1];
                }

                // Alternative pattern
                const altMatch = html.match(/accessToken["\s:]+([A-Za-z0-9_-]+)/);
                if (altMatch && altMatch[1]) {
                    this.log('Token found (alt pattern)!', 'success');
                    return altMatch[1];
                }

            } catch (e) {
                console.error('Failed to extract token from page:', e);
            }

            return null;
        },

        // ═══════════════════════════════════════════════════════════════════════
        // SPOTIFY API METHODS
        // ═══════════════════════════════════════════════════════════════════════

        async fetchPlaylistFromAPI(playlistId, token) {
            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };

            // Get playlist details
            const playlistUrl = `${this.SPOTIFY_API_BASE}/playlists/${playlistId}`;
            const response = await fetch(playlistUrl, { headers });
            
            if (!response.ok) {
                throw new Error(`Spotify API error: ${response.status}`);
            }

            const data = await response.json();
            const tracks = [];

            // Get all tracks (handle pagination)
            let nextUrl = data.tracks.next;
            
            // Add first batch
            data.tracks.items.forEach(item => {
                if (item.track && !item.track.is_local) {
                    tracks.push({
                        title: item.track.name,
                        artist: item.track.artists.map(a => a.name).join(', '),
                        album: item.track.album.name,
                        isrc: item.track.external_ids?.isrc
                    });
                }
            });

            // Fetch remaining pages
            while (nextUrl && !this.stopConversion) {
                this.log(`Fetching more tracks (${tracks.length} so far)...`, 'info');
                const nextResponse = await fetch(nextUrl, { headers });
                
                if (!nextResponse.ok) break;
                
                const nextData = await nextResponse.json();
                nextData.items.forEach(item => {
                    if (item.track && !item.track.is_local) {
                        tracks.push({
                            title: item.track.name,
                            artist: item.track.artists.map(a => a.name).join(', '),
                            album: item.track.album.name,
                            isrc: item.track.external_ids?.isrc
                        });
                    }
                });

                nextUrl = nextData.next;
                await new Promise(r => setTimeout(r, 100)); // Rate limiting
            }

            return {
                title: data.name,
                description: data.description,
                tracks: tracks
            };
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
                // Get Spotify token
                if (!this.spotifyToken) {
                    this.spotifyToken = await this.extractTokenFromPage(url);
                    
                    if (!this.spotifyToken) {
                        this.log('Could not extract Spotify token. Trying alternative method...', 'warn');
                        this.spotifyToken = await this.extractSpotifyToken();
                    }
                }

                if (!this.spotifyToken) {
                    this.log('Failed to get Spotify access token.', 'error');
                    this.log('Please ensure you are logged into Spotify in this browser.', 'warn');
                    return;
                }

                // Fetch playlist data using API
                this.log('Fetching playlist via Spotify API...', 'info');
                const playlistData = await this.fetchPlaylistFromAPI(playlistId, this.spotifyToken);
                this.log(`Found: "${playlistData.title}" with ${playlistData.tracks.length} tracks`, 'success');

                // Pre-fetch library map
                this.log('Checking existing library...', 'info');
                const existingTracks = await this.getTidalLibraryMap();
                this.log(`Loaded ${existingTracks.size} existing Tidal tracks`, 'info');

                // Create Audion playlist
                this.log('Creating local playlist...', 'info');
                const audionPlaylistId = await this.api.library.createPlaylist(playlistData.title);
                this.log(`Created playlist ID: ${audionPlaylistId}`, 'success');

                // Process tracks
                let processed = 0;
                let successes = 0;

                for (const track of playlistData.tracks) {
                    if (this.stopConversion) {
                        this.log('Conversion stopped by user.', 'warn');
                        break;
                    }

                    processed++;
                    this.updateProgress((processed / playlistData.tracks.length) * 100);

                    try {
                        const query = `${track.title} ${track.artist}`;
                        this.log(`[${processed}/${playlistData.tracks.length}] Searching: ${track.title}`, 'info');

                        const tidalTrack = await this.searchTidal(query);

                        if (tidalTrack) {
                            const tidalId = String(tidalTrack.id);
                            let trackId;

                            if (existingTracks.has(tidalId)) {
                                trackId = existingTracks.get(tidalId);
                                this.log(`[${processed}/${playlistData.tracks.length}] ✓ Reusing existing`, 'info');
                            } else {
                                trackId = await this.addTrackToLibrary(tidalTrack);
                                existingTracks.set(tidalId, trackId);
                                this.log(`[${processed}/${playlistData.tracks.length}] ✓ Added to library`, 'success');
                            }

                            await this.api.library.addTrackToPlaylist(audionPlaylistId, trackId);
                            successes++;
                        } else {
                            this.log(`[${processed}/${playlistData.tracks.length}] ✗ Not found`, 'warn');
                        }
                    } catch (err) {
                        console.error(err);
                        this.log(`[${processed}/${playlistData.tracks.length}] ✗ Error`, 'error');
                    }

                    await new Promise(r => setTimeout(r, 200));
                }

                this.log(`Done! Imported ${successes}/${playlistData.tracks.length} tracks`, 'success');

                if (this.api.library.refresh) {
                    this.api.library.refresh();
                }

            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
                
                // Reset token on auth errors
                if (err.message.includes('401') || err.message.includes('403')) {
                    this.spotifyToken = null;
                    this.log('Token may have expired. Please try again.', 'warn');
                }
            } finally {
                this.isConverting = false;
                btn.disabled = false;
                stopBtn.disabled = true;
                urlInput.disabled = false;
            }
        },

        async searchTidal(query) {
            try {
                const response = await fetch(`${this.TIDAL_API_BASE}/search/?s=${encodeURIComponent(query)}`);
                if (!response.ok) return null;
                const data = await response.json();

                if (data.data && data.data.items && data.data.items.length > 0) {
                    return data.data.items[0];
                }
            } catch (e) {
                console.warn('Tidal search failed', e);
            }
            return null;
        },

        async addTrackToLibrary(tidalTrack) {
            const artistName = tidalTrack.artist?.name || tidalTrack.artists?.[0]?.name || 'Unknown Artist';
            const title = tidalTrack.title + (tidalTrack.version ? ` (${tidalTrack.version})` : '');
            const coverUrl = tidalTrack.album?.cover
                ? `https://resources.tidal.com/images/${tidalTrack.album.cover.replace(/-/g, '/')}/640x640.jpg`
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
