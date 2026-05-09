(function () {

    const SpotifyConverter = {
        name: 'Spotify Converter',
        api: null,

        isOpen: false,
        isConverting: false,
        stopConversion: false,
        abortController: null,
        importedPlaylistData: null,

        NEW_SPOTIFY_API_BASE: 'https://spotify-api-henna.vercel.app/api/playlist',
        trackCache: new Map(),

        async init(api) {
            console.log('[SpotifyConverter] Initializing...');
            this.api = api;
            this.injectStyles();
            this.createModal();
            this.createMenuButton();
            console.log('[SpotifyConverter] Ready');
        },

        searchAllSources(spotifyTrack, signal) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                const results = [];
                this.api.search.query(
                    { title: spotifyTrack.title, artist: spotifyTrack.artist, isrc: spotifyTrack.isrc, duration_ms: spotifyTrack.duration_ms },
                    (result) => {
                        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                        results.push(result);
                    },
                    () => {
                        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                        resolve(results);
                    }
                );
            });
        },

        pickBestResult(results) {
            const SOURCE_PRIORITY = ['qobuz', 'jiosaavn'];
            const successes = results.filter(r => r.status === 'success');
            if (successes.length === 0) return null;
            for (const sourceId of SOURCE_PRIORITY) {
                const fromSource = successes.filter(r => r.sourceId === sourceId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
                if (fromSource.length > 0) return fromSource[0];
            }
            return null;
        },

        normalizeString(str) {
            if (!str) return '';
            return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        },

        async getLibraryIndex() {
            const map = new Map();
            if (this.api.library.getTracks) {
                try {
                    const tracks = await this.api.library.getTracks();
                    if (Array.isArray(tracks)) {
                        tracks.forEach(t => {
                            if (t.source_type && t.external_id) map.set(`${t.source_type}:${t.external_id}`, t.id);
                        });
                    }
                } catch (e) { console.error(e); }
            }
            return map;
        },

        async addTrackToLibrary(result) {
            return await this.api.library.addExternalTrack({
                title: result.title, artist: result.artist, album: result.album || null,
                duration: result.duration || null, cover_url: result.cover_url || null,
                source_type: result.source_type, external_id: result.external_id,
                format: result.format || null, bitrate: result.bitrate || null,
                track_number: result.track_number || null, disc_number: result.disc_number || null,
                musicbrainz_recording_id: result.musicbrainz_recording_id || null,
                metadata_json: result.metadata_json || null,
            });
        },

        // ── Styles ──────────────────────────────────────────────────────────
        injectStyles() {
            if (document.getElementById('sc2-styles')) return;
            const s = document.createElement('style');
            s.id = 'sc2-styles';
            s.textContent = `
                #sc2-overlay {
                    position: fixed; inset: 0;
                    background: rgba(0,0,0,0.75);
                    backdrop-filter: blur(8px);
                    z-index: 10000; opacity: 0; visibility: hidden;
                    transition: opacity 0.2s;
                }
                #sc2-overlay.open { opacity: 1; visibility: visible; }

                #sc2-modal {
                    position: fixed; top: 50%; left: 50%;
                    transform: translate(-50%, -50%) scale(0.96);
                    width: 680px; max-width: 96vw; max-height: 90vh;
                    background: #0d0d0d;
                    border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 24px;
                    z-index: 10001;
                    display: flex; flex-direction: column;
                    overflow: hidden;
                    opacity: 0; visibility: hidden;
                    transition: all 0.3s cubic-bezier(0.16,1,0.3,1);
                }
                #sc2-modal.open {
                    opacity: 1; visibility: visible;
                    transform: translate(-50%, -50%) scale(1);
                }

                .sc2-topbar {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 13px 18px;
                    border-bottom: 0.5px solid rgba(255,255,255,0.07);
                    background: #0d0d0d; flex-shrink: 0;
                }
                .sc2-topbar-left { display: flex; align-items: center; gap: 10px; }
                .sc2-logo { color: #1DB954; display: flex; }
                .sc2-title { font-size: 14px; font-weight: 500; color: #fff; letter-spacing: -0.2px; }
                .sc2-dot { width: 3px; height: 3px; border-radius: 50%; background: #444; }
                .sc2-sub { font-size: 12px; color: #777; }
                .sc2-chip {
                    font-size: 10px; font-weight: 500; color: #1DB954;
                    background: rgba(29,185,84,0.10); border: 0.5px solid rgba(29,185,84,0.22);
                    padding: 3px 9px; border-radius: 20px; letter-spacing: 0.3px;
                }
                .sc2-icon-btn {
                    width: 30px; height: 30px; border-radius: 50%;
                    background: transparent; border: 0.5px solid rgba(255,255,255,0.10);
                    color: #777; cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 14px; transition: background .15s, color .15s;
                }
                .sc2-icon-btn:hover { background: #222; color: #fff; }

                .sc2-two-col {
                    display: grid; grid-template-columns: 1fr 1fr;
                    flex: 1; min-height: 0; overflow: hidden;
                }

                /* Left panel */
                .sc2-left {
                    border-right: 0.5px solid rgba(255,255,255,0.07);
                    display: flex; flex-direction: column;
                    padding: 16px; gap: 12px;
                    overflow-y: auto; background: #0d0d0d;
                }
                .sc2-left::-webkit-scrollbar { width: 3px; }
                .sc2-left::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

                .sc2-plabel {
                    font-size: 10px; font-weight: 500; letter-spacing: 0.7px;
                    text-transform: uppercase; color: #555; margin-bottom: 8px;
                    display: flex; align-items: center; gap: 5px;
                }
                .sc2-plabel i { font-size: 13px; color: #666; }

                .sc2-url-card {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 14px; padding: 13px;
                }
                .sc2-field-wrap { position: relative; margin-bottom: 10px; }
                .sc2-field {
                    width: 100%; height: 40px;
                    background: #1e1e1e; border: 0.5px solid rgba(255,255,255,0.10);
                    color: #fff; padding: 0 38px 0 12px;
                    border-radius: 10px; font-size: 13px;
                    outline: none; transition: border-color .15s; box-sizing: border-box;
                }
                .sc2-field::placeholder { color: #444; }
                .sc2-field:focus { border-color: #1DB954; background: #222; }
                .sc2-field:disabled { opacity: 0.4; pointer-events: none; }
                .sc2-field-x {
                    position: absolute; right: 10px; top: 50%;
                    transform: translateY(-50%);
                    width: 20px; height: 20px; border-radius: 50%;
                    background: #2a2a2a; border: none; color: #aaa;
                    font-size: 11px; cursor: pointer;
                    display: none; align-items: center; justify-content: center;
                }
                .sc2-field-x:hover { background: #444; }

                .sc2-sep { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
                .sc2-sep-line { flex: 1; height: 0.5px; background: rgba(255,255,255,0.06); }
                .sc2-sep-text { font-size: 11px; color: #444; }

                .sc2-json-btn {
                    width: 100%; height: 38px;
                    background: transparent; border: 0.5px solid rgba(255,255,255,0.11);
                    border-radius: 10px; color: #999; font-size: 13px; cursor: pointer;
                    display: flex; align-items: center; justify-content: center; gap: 8px;
                    transition: border-color .15s, color .15s, background .15s;
                    box-sizing: border-box;
                }
                .sc2-json-btn:hover { border-color: rgba(29,185,84,0.45); color: #fff; background: rgba(29,185,84,0.08); }
                .sc2-json-btn i { font-size: 16px; }

                .sc2-file-pill {
                    display: none; align-items: center; gap: 8px;
                    background: rgba(29,185,84,0.09);
                    border: 0.5px solid rgba(29,185,84,0.22);
                    border-radius: 8px; padding: 8px 10px; margin-top: 8px;
                }
                .sc2-pill-icon { color: #1DB954; font-size: 15px; }
                .sc2-pill-text { font-size: 12px; color: #1DB954; flex: 1; }
                .sc2-pill-remove {
                    background: transparent; border: none;
                    color: rgba(29,185,84,0.5); cursor: pointer;
                    font-size: 14px; display: flex; align-items: center;
                    padding: 2px;
                }
                .sc2-pill-remove:hover { color: #e85555; }

                .sc2-notice {
                    background: rgba(245,158,11,0.07);
                    border: 0.5px solid rgba(245,158,11,0.20);
                    border-radius: 10px; padding: 10px 12px;
                    font-size: 12px; color: rgba(245,158,11,0.80); line-height: 1.6;
                }
                .sc2-notice i { font-size: 14px; vertical-align: -2px; margin-right: 3px; }
                .sc2-notice strong { color: #f59e0b; font-weight: 500; }
                .sc2-notice a { color: #f59e0b; cursor: pointer; font-weight: 500; text-decoration: none; }
                .sc2-notice a:hover { text-decoration: underline; }

                .sc2-help {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 10px; padding: 12px;
                    font-size: 12px; color: #888; line-height: 1.7; display: none;
                }
                .sc2-help.open { display: block; }
                .sc2-help strong { color: #ccc; font-weight: 500; }
                .sc2-help a { color: #1DB954; text-decoration: none; }
                .sc2-help a:hover { text-decoration: underline; }
                .sc2-help ol { margin: 6px 0 0 14px; }
                .sc2-help li { margin-bottom: 3px; }

                .sc2-preview {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 14px; padding: 13px;
                    display: none; align-items: center; gap: 12px;
                }
                .sc2-prev-art {
                    width: 54px; height: 54px; border-radius: 10px;
                    background: #1e1e1e; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    color: #444; font-size: 20px; overflow: hidden;
                }
                .sc2-prev-art img { width: 100%; height: 100%; object-fit: cover; border-radius: 9px; }
                .sc2-prev-info { flex: 1; overflow: hidden; }
                .sc2-prev-name {
                    font-size: 14px; font-weight: 500; color: #fff;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px;
                }
                .sc2-prev-owner, .sc2-prev-count {
                    font-size: 11px; color: #777;
                    display: flex; align-items: center; gap: 4px; margin-bottom: 2px;
                }
                .sc2-prev-owner i, .sc2-prev-count i { font-size: 13px; }
                .sc2-prev-badge {
                    width: 28px; height: 28px; border-radius: 50%;
                    background: rgba(29,185,84,0.10); border: 0.5px solid rgba(29,185,84,0.22);
                    display: flex; align-items: center; justify-content: center;
                    color: #1DB954; flex-shrink: 0; font-size: 13px;
                }

                .sc2-actions { margin-top: auto; display: flex; gap: 8px; }
                .sc2-btn-stop {
                    height: 40px; padding: 0 16px; border-radius: 10px;
                    background: transparent; border: 0.5px solid rgba(255,255,255,0.11);
                    color: #888; font-size: 13px; font-weight: 500; cursor: pointer;
                    display: flex; align-items: center; gap: 6px; transition: all .15s;
                }
                .sc2-btn-stop:hover:not(:disabled) { background: #1e1e1e; color: #fff; }
                .sc2-btn-stop:disabled { opacity: 0.3; cursor: not-allowed; }
                .sc2-btn-stop i { font-size: 16px; }
                .sc2-btn-convert {
                    flex: 1; height: 40px; border-radius: 10px;
                    background: #1DB954; border: none; color: #000;
                    font-size: 13px; font-weight: 600; cursor: pointer;
                    display: flex; align-items: center; justify-content: center; gap: 7px;
                    transition: filter .15s, transform .1s; letter-spacing: -0.1px;
                }
                .sc2-btn-convert:hover:not(:disabled) { filter: brightness(1.10); }
                .sc2-btn-convert:active:not(:disabled) { transform: scale(0.98); }
                .sc2-btn-convert:disabled { opacity: 0.4; cursor: not-allowed; }
                .sc2-btn-convert i { font-size: 16px; }

                /* Right panel */
                .sc2-right {
                    display: flex; flex-direction: column; background: #0d0d0d; overflow: hidden;
                }
                .sc2-right-hdr {
                    padding: 14px 16px 10px;
                    border-bottom: 0.5px solid rgba(255,255,255,0.07); flex-shrink: 0;
                }
                .sc2-prog-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
                .sc2-prog-track {
                    flex: 1; height: 3px; background: rgba(255,255,255,0.07);
                    border-radius: 2px; overflow: hidden;
                }
                .sc2-prog-fill {
                    height: 100%; width: 0%; background: #1DB954;
                    border-radius: 2px; transition: width .25s ease;
                }
                .sc2-prog-pct {
                    font-size: 11px; color: #666; min-width: 32px;
                    text-align: right; font-variant-numeric: tabular-nums;
                }

                .sc2-stats {
                    display: grid; grid-template-columns: repeat(3, 1fr);
                    gap: 8px; padding: 12px 16px 0; flex-shrink: 0;
                }
                .sc2-stat {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.07);
                    border-radius: 10px; padding: 10px 12px; text-align: center;
                }
                .sc2-stat-val {
                    font-size: 20px; font-weight: 500; line-height: 1;
                    color: #fff; font-variant-numeric: tabular-nums;
                }
                .sc2-stat-val.green { color: #1DB954; }
                .sc2-stat-val.amber { color: #f59e0b; }
                .sc2-stat-val.red { color: #e85555; }
                .sc2-stat-lbl {
                    font-size: 10px; color: #555; margin-top: 4px;
                    text-transform: uppercase; letter-spacing: 0.5px;
                }

                .sc2-log-wrap {
                    flex: 1; overflow-y: auto; padding: 12px 16px; min-height: 0;
                }
                .sc2-log-wrap::-webkit-scrollbar { width: 3px; }
                .sc2-log-wrap::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

                .sc2-log-line {
                    display: flex; align-items: baseline; gap: 7px;
                    padding: 2px 0; font-size: 11.5px; line-height: 1.6;
                    font-family: 'Courier New', monospace;
                }
                .sc2-log-arrow { color: #444; flex-shrink: 0; font-size: 10px; }
                .sc2-log-msg { color: #777; }
                .sc2-log-line.success .sc2-log-msg { color: #1DB954; }
                .sc2-log-line.error   .sc2-log-msg { color: #e85555; }
                .sc2-log-line.warn    .sc2-log-msg { color: #f59e0b; }
                .sc2-log-line.info    .sc2-log-msg { color: #bbb; }
                .sc2-log-line.divider .sc2-log-msg { color: #2a2a2a; letter-spacing: 1px; }

                .sc2-status-bar {
                    padding: 10px 16px 14px;
                    border-top: 0.5px solid rgba(255,255,255,0.07);
                    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
                }
                .sc2-status-dot {
                    width: 6px; height: 6px; border-radius: 50%;
                    background: #333; flex-shrink: 0; transition: background .3s;
                }
                .sc2-status-dot.active { background: #1DB954; }
                .sc2-status-dot.done   { background: #1DB954; }
                .sc2-status-dot.err    { background: #e85555; }
                .sc2-status-txt { font-size: 11px; color: #555; flex: 1; }

                @media (max-width: 520px) {
                    #sc2-modal { top: 0; left: 0; width: 100vw; height: 100dvh; transform: none !important; border-radius: 0; max-width: none; max-height: none; }
                    .sc2-two-col { grid-template-columns: 1fr; }
                    .sc2-left { border-right: none; border-bottom: 0.5px solid rgba(255,255,255,0.07); }
                    .sc2-right { min-height: 300px; }
                }
            `;
            document.head.appendChild(s);
        },

        // ── Modal ───────────────────────────────────────────────────────────
        createModal() {
            const overlay = document.createElement('div');
            overlay.id = 'sc2-overlay';
            overlay.onclick = () => { if (!this.isConverting) this.close(); };
            document.body.appendChild(overlay);

            const modal = document.createElement('div');
            modal.id = 'sc2-modal';
            modal.innerHTML = `
                <div class="sc2-topbar">
                    <div class="sc2-topbar-left">
                        <span class="sc2-logo" aria-hidden="true">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.38 9.841-.719 13.44 1.56.42.3.6.84.3 1.26zm.12-3.36C14.939 8.46 8.641 8.28 5.1 9.421c-.6.18-1.26-.12-1.441-.72-.18-.6.12-1.26.72-1.44 4.08-1.26 11.04-1.02 15.361 1.56.6.358.779 1.14.421 1.74-.359.6-1.14.779-1.741.419z"/></svg>
                        </span>
                        <span class="sc2-title">Spotify to Audion</span>
                        <span class="sc2-dot" aria-hidden="true"></span>
                        <span class="sc2-sub">Playlist converter</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <span class="sc2-chip">Plugin</span>
                        <button class="sc2-icon-btn" id="sc2-close" aria-label="Close">
                            <i class="ti ti-x" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>

                <div class="sc2-two-col">

                    <div class="sc2-left">
                        <div>
                            <div class="sc2-plabel"><i class="ti ti-link" aria-hidden="true"></i> Source</div>
                            <div class="sc2-url-card">
                                <div class="sc2-field-wrap">
                                    <input type="text" id="sc2-url" class="sc2-field" placeholder="open.spotify.com/playlist/…" autocomplete="off">
                                    <button class="sc2-field-x" id="sc2-field-x" aria-label="Clear"><i class="ti ti-x" aria-hidden="true"></i></button>
                                </div>
                                <div class="sc2-sep">
                                    <div class="sc2-sep-line"></div>
                                    <span class="sc2-sep-text">or</span>
                                    <div class="sc2-sep-line"></div>
                                </div>
                                <label for="sc2-file" class="sc2-json-btn" id="sc2-json-label">
                                    <i class="ti ti-file-upload" aria-hidden="true"></i>
                                    Upload JSON backup
                                </label>
                                <input type="file" id="sc2-file" accept=".json" style="display:none">
                                <div class="sc2-file-pill" id="sc2-pill">
                                    <i class="ti ti-circle-check sc2-pill-icon" aria-hidden="true"></i>
                                    <span class="sc2-pill-text" id="sc2-pill-text"></span>
                                    <button class="sc2-pill-remove" id="sc2-pill-remove" aria-label="Remove file">
                                        <i class="ti ti-x" aria-hidden="true"></i>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div class="sc2-notice">
                            <i class="ti ti-alert-triangle" aria-hidden="true"></i>
                            Playlist must be <strong>public</strong>. Requires <strong>saavan-search</strong> or <strong>qobuz-player</strong> plugin.
                            <a id="sc2-help-toggle"> Need help?</a>
                        </div>

                        <div class="sc2-help" id="sc2-help">
                            <strong>Alternative method</strong> — if automatic conversion fails:
                            <ol>
                                <li>Go to <a href="https://playlist.audionplayer.com" target="_blank">playlist.audionplayer.com</a></li>
                                <li>Paste your Spotify URL and export JSON</li>
                                <li>Upload the file using the button above</li>
                            </ol>
                        </div>

                        <div class="sc2-preview" id="sc2-preview">
                            <div class="sc2-prev-art" id="sc2-prev-art">
                                <i class="ti ti-playlist" aria-hidden="true"></i>
                            </div>
                            <div class="sc2-prev-info">
                                <div class="sc2-prev-name" id="sc2-prev-name">—</div>
                                <div class="sc2-prev-owner" id="sc2-prev-owner" style="display:none">
                                    <i class="ti ti-user" aria-hidden="true"></i>
                                    <span id="sc2-prev-owner-text"></span>
                                </div>
                                <div class="sc2-prev-count">
                                    <i class="ti ti-music" aria-hidden="true"></i>
                                    <span id="sc2-prev-count"></span>
                                </div>
                            </div>
                            <div class="sc2-prev-badge" aria-hidden="true">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.38 9.841-.719 13.44 1.56.42.3.6.84.3 1.26zm.12-3.36C14.939 8.46 8.641 8.28 5.1 9.421c-.6.18-1.26-.12-1.441-.72-.18-.6.12-1.26.72-1.44 4.08-1.26 11.04-1.02 15.361 1.56.6.358.779 1.14.421 1.74-.359.6-1.14.779-1.741.419z"/></svg>
                            </div>
                        </div>

                        <div class="sc2-actions">
                            <button class="sc2-btn-stop" id="sc2-stop" disabled>
                                <i class="ti ti-player-stop" aria-hidden="true"></i> Stop
                            </button>
                            <button class="sc2-btn-convert" id="sc2-convert">
                                <i class="ti ti-rocket" aria-hidden="true"></i> Convert playlist
                            </button>
                        </div>
                    </div>

                    <div class="sc2-right">
                        <div class="sc2-right-hdr">
                            <div class="sc2-plabel" style="margin-bottom:0">
                                <i class="ti ti-terminal-2" aria-hidden="true"></i> Activity log
                            </div>
                            <div class="sc2-prog-row">
                                <div class="sc2-prog-track">
                                    <div class="sc2-prog-fill" id="sc2-prog-fill"></div>
                                </div>
                                <span class="sc2-prog-pct" id="sc2-prog-pct">0%</span>
                            </div>
                        </div>

                        <div class="sc2-stats">
                            <div class="sc2-stat">
                                <div class="sc2-stat-val green" id="sc2-stat-new">—</div>
                                <div class="sc2-stat-lbl">Added</div>
                            </div>
                            <div class="sc2-stat">
                                <div class="sc2-stat-val amber" id="sc2-stat-lib">—</div>
                                <div class="sc2-stat-lbl">Library</div>
                            </div>
                            <div class="sc2-stat">
                                <div class="sc2-stat-val red" id="sc2-stat-miss">—</div>
                                <div class="sc2-stat-lbl">Not found</div>
                            </div>
                        </div>

                        <div class="sc2-log-wrap" id="sc2-log">
                            <div class="sc2-log-line info">
                                <span class="sc2-log-arrow">›</span>
                                <span class="sc2-log-msg">Ready. Paste a Spotify URL or upload a JSON backup.</span>
                            </div>
                        </div>

                        <div class="sc2-status-bar">
                            <div class="sc2-status-dot" id="sc2-status-dot"></div>
                            <span class="sc2-status-txt" id="sc2-status-txt">Idle</span>
                        </div>
                    </div>

                </div>
            `;
            document.body.appendChild(modal);

            modal.querySelector('#sc2-close').onclick = () => this.close();
            modal.querySelector('#sc2-convert').onclick = () => this.startConversion();
            modal.querySelector('#sc2-stop').onclick = () => this.stopConversionProcess();
            modal.querySelector('#sc2-file').addEventListener('change', e => this.handleFileUpload(e));
            modal.querySelector('#sc2-pill-remove').onclick = () => this.clearFile();
            modal.querySelector('#sc2-field-x').addEventListener('click', () => {
                modal.querySelector('#sc2-url').value = '';
                modal.querySelector('#sc2-field-x').style.display = 'none';
                modal.querySelector('#sc2-preview').style.display = 'none';
                modal.querySelector('#sc2-url').focus();
            });
            modal.querySelector('#sc2-url').addEventListener('input', () => {
                const v = modal.querySelector('#sc2-url').value;
                modal.querySelector('#sc2-field-x').style.display = v ? 'flex' : 'none';
            });
            modal.querySelector('#sc2-help-toggle').onclick = e => {
                e.preventDefault();
                const help = document.getElementById('sc2-help');
                const open = help.classList.toggle('open');
                modal.querySelector('#sc2-help-toggle').textContent = open ? ' Hide help' : ' Need help?';
            };
        },

        createMenuButton() {
            const btn = document.createElement('button');
            btn.className = 'plugin-menu-btn';
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 12h20M2 12l5-5m-5 5l5 5"/><circle cx="12" cy="12" r="10"/>
                </svg>
                <span>Import Spotify Playlist</span>
            `;
            btn.onclick = () => this.open();
            this.api.ui.registerSlot('playerbar:menu', btn);
        },

        open() {
            this.isOpen = true;
            document.getElementById('sc2-overlay').classList.add('open');
            document.getElementById('sc2-modal').classList.add('open');
        },

        close() {
            if (this.isConverting) return;
            this.isOpen = false;
            document.getElementById('sc2-overlay').classList.remove('open');
            document.getElementById('sc2-modal').classList.remove('open');
        },

        // ── Log & progress helpers ──────────────────────────────────────────
        log(msg, type = 'info') {
            const log = document.getElementById('sc2-log');
            const line = document.createElement('div');
            line.className = `sc2-log-line ${type}`;
            line.innerHTML = `<span class="sc2-log-arrow">›</span><span class="sc2-log-msg">${msg}</span>`;
            log.appendChild(line);
            log.scrollTop = log.scrollHeight;
        },

        updateProgress(percent) {
            const p = Math.round(percent);
            document.getElementById('sc2-prog-fill').style.width = `${p}%`;
            document.getElementById('sc2-prog-pct').textContent = `${p}%`;
        },

        updateStats(n, l, m) {
            document.getElementById('sc2-stat-new').textContent = n;
            document.getElementById('sc2-stat-lib').textContent = l;
            document.getElementById('sc2-stat-miss').textContent = m;
        },

        setStatus(text, state = 'idle') {
            document.getElementById('sc2-status-txt').textContent = text;
            const dot = document.getElementById('sc2-status-dot');
            dot.className = 'sc2-status-dot';
            if (state !== 'idle') dot.classList.add(state);
        },

        showPlaylistPreview(data) {
            const art = document.getElementById('sc2-prev-art');
            if (data.image) {
                art.innerHTML = `<img src="${data.image}" alt="">`;
            } else {
                art.innerHTML = `<i class="ti ti-playlist" aria-hidden="true"></i>`;
            }
            document.getElementById('sc2-prev-name').textContent = data.title || 'Playlist';
            const ownerEl = document.getElementById('sc2-prev-owner');
            if (data.owner) {
                document.getElementById('sc2-prev-owner-text').textContent = data.owner;
                ownerEl.style.display = 'flex';
            } else {
                ownerEl.style.display = 'none';
            }
            const total = data.total || data.tracks.length;
            const fetched = data.tracks.length;
            document.getElementById('sc2-prev-count').textContent =
                (data.total && data.total > fetched) ? `${fetched} of ${total} tracks` : `${total} tracks`;
            document.getElementById('sc2-preview').style.display = 'flex';
        },

        // ── File handling ───────────────────────────────────────────────────
        handleFileUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.log(`Reading ${file.name}…`);
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const json = JSON.parse(e.target.result);
                    let playlistData;
                    if (Array.isArray(json)) {
                        playlistData = this.normalizeJSON(json);
                    } else {
                        playlistData = {
                            title: json.title || json.name || 'JSON Import',
                            description: json.description || '',
                            image: json.image || json.cover_url || json.cover || null,
                            tracks: Array.isArray(json.tracks) ? this.normalizeTracks(json.tracks) : []
                        };
                    }
                    this.importedPlaylistData = playlistData;
                    document.getElementById('sc2-pill-text').textContent = `${playlistData.tracks.length} tracks · ${file.name}`;
                    document.getElementById('sc2-pill').style.display = 'flex';
                    document.getElementById('sc2-json-label').style.display = 'none';
                    document.getElementById('sc2-url').value = '';
                    document.getElementById('sc2-url').placeholder = 'Using uploaded JSON…';
                    document.getElementById('sc2-url').disabled = true;
                    document.getElementById('sc2-field-x').style.display = 'none';
                    this.log(`Loaded ${playlistData.tracks.length} tracks from "${file.name}"`, 'success');
                    if (playlistData.image) this.showPlaylistPreview(playlistData);
                } catch (err) {
                    this.log('Could not parse JSON — check the format.', 'error');
                    console.error(err);
                    event.target.value = '';
                }
            };
            reader.readAsText(file);
        },

        clearFile() {
            this.importedPlaylistData = null;
            document.getElementById('sc2-file').value = '';
            document.getElementById('sc2-url').value = '';
            document.getElementById('sc2-url').disabled = false;
            document.getElementById('sc2-url').placeholder = 'open.spotify.com/playlist/…';
            document.getElementById('sc2-pill').style.display = 'none';
            document.getElementById('sc2-json-label').style.display = 'flex';
            document.getElementById('sc2-field-x').style.display = 'none';
            document.getElementById('sc2-preview').style.display = 'none';
            this.log('File removed.', 'info');
        },

        normalizeJSON(jsonData) {
            return { title: 'JSON Import', description: `Imported ${jsonData.length} tracks`, tracks: this.normalizeTracks(jsonData) };
        },

        normalizeTracks(tracks) {
            return tracks.map(t => ({
                title: t.songTitle || t.title || t.name || 'Unknown',
                artist: Array.isArray(t.artist) ? t.artist.join(', ') : (t.artist || t.artist_name || 'Unknown'),
                album: t.album || null,
                duration_ms: this.parseDurationToMs(t.duration || t.duration_ms),
                cover_url: t.image || t.cover_url || t.cover || null,
                isrc: t.isrc || null
            }));
        },

        parseDurationToMs(timeStr) {
            if (!timeStr) return 0;
            if (typeof timeStr === 'number') return timeStr > 3600 ? timeStr : timeStr * 1000;
            try {
                const parts = String(timeStr).split(':').map(p => parseInt(p, 10));
                if (parts.some(isNaN)) return 0;
                if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
                if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
                if (parts.length === 1) return parts[0] * 1000;
            } catch (e) { }
            return 0;
        },

        // ── Spotify API ─────────────────────────────────────────────────────
        async fetchPlaylistFromAPI(playlistId) {
            this.log('Fetching playlist from API…', 'info');
            const limit = 100;
            let offset = 0, allTracks = [], playlistMeta = null, total = 0, page = 1;

            while (true) {
                const url = `${this.NEW_SPOTIFY_API_BASE}/${playlistId}?limit=${limit}&offset=${offset}`;
                const response = await this.api.fetch(url);
                if (!response.ok) throw new Error(`API error: ${response.status}`);
                const json = await response.json();
                if (!json.success || !json.data) throw new Error('Invalid API response');
                const data = json.data;

                if (!playlistMeta) {
                    playlistMeta = { title: data.name || 'Spotify Import', description: data.description || '', image: data.image || null, owner: data.owner || null };
                    total = data.total || 0;
                }

                const pageTracks = data.tracks.map(t => ({
                    title: t.name, artist: t.artists.join(', '), album: t.album,
                    duration_ms: t.duration_ms, cover_url: t.image || null, isrc: null
                }));
                allTracks = allTracks.concat(pageTracks);
                this.log(`Page ${page}: ${pageTracks.length} tracks (${allTracks.length}/${total})`, 'info');
                this.showPlaylistPreview({ ...playlistMeta, total, tracks: allTracks });

                if (!data.next || pageTracks.length === 0 || allTracks.length >= total) {
                    if (allTracks.length < total) this.log(`Only fetched ${allTracks.length} of ${total} — API may have stopped early`, 'warn');
                    break;
                }
                offset += limit; page++;
            }

            this.log(`Fetched all ${allTracks.length} tracks`, 'success');
            return { ...playlistMeta, total, tracks: allTracks };
        },

        // ── Conversion core ─────────────────────────────────────────────────
        async startConversion() {
            const urlEl = document.getElementById('sc2-url');
            const convertBtn = document.getElementById('sc2-convert');
            const stopBtn = document.getElementById('sc2-stop');

            let playlistData = null;

            if (this.importedPlaylistData) {
                playlistData = this.importedPlaylistData;
                this.log(`Using uploaded JSON: ${playlistData.tracks.length} tracks`, 'info');
            } else {
                const url = urlEl.value.trim();
                if (!url.includes('spotify.com/playlist/')) { this.log('Enter a valid Spotify playlist URL.', 'error'); return; }
                const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
                if (!match) { this.log('Could not extract playlist ID.', 'error'); return; }
                try {
                    playlistData = await this.fetchPlaylistFromAPI(match[1]);
                    this.showPlaylistPreview(playlistData);
                } catch (err) {
                    console.error(err);
                    this.log(`Error: ${err.message}`, 'error');
                    this.setStatus('Failed', 'err');
                    return;
                }
            }

            this.isConverting = true;
            this.stopConversion = false;
            this.abortController = new AbortController();
            convertBtn.disabled = true;
            stopBtn.disabled = false;
            urlEl.disabled = true;
            this.updateProgress(0);
            this.updateStats('—', '—', '—');
            this.setStatus('Converting…', 'active');

            document.getElementById('sc2-log').innerHTML = '';
            this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');
            this.log(`Playlist: ${playlistData.title}`, 'info');
            this.log(`${playlistData.tracks.length} tracks to process`, 'info');
            this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');

            try {
                const existingTracks = await this.getLibraryIndex();
                this.log(`${existingTracks.size} existing tracks in library index`, 'info');

                const audionPlaylistId = await this.api.library.createPlaylist(playlistData.title, playlistData.image);
                this.log('Playlist created in Audion', 'success');
                if (playlistData.image) this.log('Cover image assigned', 'success');
                this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');

                const total = playlistData.tracks.length;
                let processed = 0, successes = 0, fromLibrary = 0, notFound = 0;
                const foundTracks = new Array(total).fill(null);
                const inFlight = new Map();
                const concurrency = 3;
                const queue = playlistData.tracks.map((track, idx) => ({ track, idx }));

                const searchWorker = async () => {
                    while (queue.length > 0 && !this.stopConversion) {
                        const item = queue.shift();
                        if (!item) break;
                        const { track, idx } = item;
                        const key = `${this.normalizeString(track.title)}|${this.normalizeString(track.artist)}|${track.duration_ms}`;
                        let trackId = null, wasInLibrary = false;

                        const cached = this.trackCache.get(key);
                        if (cached) {
                            trackId = cached.trackId; wasInLibrary = true; fromLibrary++;
                        } else if (inFlight.has(key)) {
                            try {
                                const result = await inFlight.get(key);
                                if (result) { trackId = result.id; wasInLibrary = !result.isNew; result.isNew ? successes++ : fromLibrary++; } else { notFound++; }
                            } catch (err) {
                                if (err.name === 'AbortError') { foundTracks[idx] = { track, trackId: null, wasInLibrary: false, truncatedTitle: track.title }; processed++; this.updateProgress((processed / total) * 50); break; }
                                notFound++;
                            }
                        } else {
                            const searchPromise = (async () => {
                                try {
                                    await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
                                    const allResults = await this.searchAllSources(track, this.abortController.signal);
                                    allResults.filter(r => r.status === 'error').forEach(r => console.warn(`[SpotifyConverter] Source '${r.sourceId}' error for "${track.title}":`, r.error));
                                    const best = this.pickBestResult(allResults);
                                    if (best && !best.cover_url && track.cover_url) best.cover_url = track.cover_url;
                                    if (best) {
                                        const libraryKey = `${best.source_type}:${best.external_id}`;
                                        const alreadyInLibrary = existingTracks.has(libraryKey);
                                        let resolvedId;
                                        if (alreadyInLibrary) { resolvedId = existingTracks.get(libraryKey); }
                                        else { resolvedId = await this.addTrackToLibrary(best); existingTracks.set(libraryKey, resolvedId); }
                                        this.trackCache.set(key, { trackId: resolvedId, sourceId: best.sourceId });
                                        return { id: resolvedId, isNew: !alreadyInLibrary };
                                    }
                                    return null;
                                } catch (err) {
                                    if (err.name === 'AbortError') throw err;
                                    console.error(err);
                                    return null;
                                }
                            })();

                            inFlight.set(key, searchPromise);
                            try {
                                const result = await searchPromise;
                                if (result) { trackId = result.id; wasInLibrary = !result.isNew; result.isNew ? successes++ : fromLibrary++; } else { notFound++; }
                            } catch (err) {
                                if (err.name === 'AbortError') { foundTracks[idx] = { track, trackId: null, wasInLibrary: false, truncatedTitle: track.title }; processed++; this.updateProgress((processed / total) * 50); break; }
                                notFound++;
                            } finally {
                                inFlight.delete(key);
                            }
                        }

                        foundTracks[idx] = { track, trackId, wasInLibrary, truncatedTitle: track.title };
                        processed++;
                        if (processed % 5 === 0 || processed === total) {
                            this.updateProgress((processed / total) * 50);
                            this.updateStats(successes, fromLibrary, notFound);
                            this.log(`Searching: ${processed}/${total} · ${successes} new · ${fromLibrary} library · ${notFound} not found`, 'info');
                        }
                    }
                };

                const workers = [];
                for (let i = 0; i < concurrency; i++) workers.push(searchWorker());
                await Promise.all(workers);

                const skipped = foundTracks.filter(e => e === null).length;
                if (skipped > 0) this.log(`Skipped (stopped early): ${skipped}`, 'warn');

                if (this.stopConversion) {
                    this.log('Conversion stopped by user.', 'warn');
                    this.setStatus('Stopped', 'idle');
                } else {
                    this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');
                    this.log(`Adding ${foundTracks.filter(e => e && e.trackId).length} tracks to playlist…`, 'info');

                    for (let i = 0; i < foundTracks.length; i++) {
                        if (this.stopConversion) break;
                        const entry = foundTracks[i];
                        if (!entry || !entry.trackId) continue;
                        try {
                            await new Promise(r => setTimeout(r, 50));
                            await this.api.library.addTrackToPlaylist(audionPlaylistId, entry.trackId);
                        } catch (err) {
                            this.log(`Failed to add: ${entry.truncatedTitle}`, 'error');
                        }
                        this.updateProgress(50 + ((i + 1) / foundTracks.length) * 50);
                    }

                    this.updateProgress(100);
                    this.updateStats(successes, fromLibrary, notFound);
                    this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');
                    this.log('Conversion complete!', 'success');
                    this.log(`${total} total · ${successes} new · ${fromLibrary} from library · ${notFound} not found${skipped > 0 ? ` · ${skipped} skipped` : ''}`, 'info');
                    this.setStatus(`Done — ${total} tracks converted`, 'done');

                    if (this.api.library.refresh) this.api.library.refresh();
                }

            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
                this.setStatus('Error', 'err');
            } finally {
                this.isConverting = false;
                this.abortController = null;
                convertBtn.disabled = false;
                stopBtn.disabled = true;
                if (!this.importedPlaylistData) urlEl.disabled = false;
            }
        },

        stopConversionProcess() {
            this.stopConversion = true;
            if (this.abortController) this.abortController.abort();
            document.getElementById('sc2-stop').disabled = true;
        }
    };

    if (typeof Audion !== 'undefined' && Audion.register) {
        Audion.register(SpotifyConverter);
    } else {
        window.SpotifyConverter = SpotifyConverter;
        window.AudionPlugin = SpotifyConverter;
    }

})();