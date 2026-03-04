(function () {
    // ═══════════════════════════════════════════════════════════════════════════
    // SPOTIFY CONVERTER PLUGIN - ENHANCED VERSION
    // ═══════════════════════════════════════════════════════════════════════════

    const SpotifyConverter = {
        name: 'Spotify Converter',
        api: null,

        isOpen: false,
        isConverting: false,
        stopConversion: false,
        abortController: null,
        mbAbortController: null,
        importedPlaylistData: null,

        failedTracks: [],

        // MB rescue
        mbQueue: [],
        mbWorkerRunning: false,

        // Pre-allocated by original playlist index
        foundTracks: [],

        // counters
        counters: null,

        // library map
        existingTracks: null,

        // Pending reviews Map: idx -> { track, tidalTrack, score, resolve }
        pendingReviews: new Map(),

        // Active mobile tab
        mobileTab: 'progress',

        settings: {
            mbRescueEnabled:      true,
            mbRescoreThreshold:   60,
            autoApproveThreshold: 80,
            maxRetries:           3,
            requestTimeoutMs:     12000,
        },

        // API endpoints
        TIDAL_SEARCH_ENDPOINTS: [
            'https://hund.qqdl.site',
            'https://katze.qqdl.site',
            'https://tidal.kinoplus.online',
            'https://maus.qqdl.site',
            'https://arran.monochrome.tf'
        ],
        TIDAL_DETAILS_ENDPOINT: 'https://triton.squid.wtf',
        NEW_SPOTIFY_API_BASE:   'https://playlist.audionplayer.com/api/playlist',

        lastWorkingSearchEndpoint: null,
        trackCache: new Map(),
        candidateCache: new Map(),

        // ── Lifecycle ────────────────────────────────────────────────────────
        async init(api) {
            console.log('[SpotifyConverter] Initializing...');
            this.api = api;
            this.injectStyles();
            this.createSettingsPopup();
            this.createModal();
            this.createMenuButton();
            this._initMobileTabBar();
            console.log('[SpotifyConverter] Ready');
        },

        // ── Mobile tab bar ───────────────────────────────────────────────────
        _initMobileTabBar() {
            const mq = window.matchMedia('(max-width: 900px)');
            const onMqChange = (e) => {
                const tabBar = document.getElementById('sc-tab-bar');
                if (tabBar) tabBar.style.display = e.matches ? 'flex' : 'none';
                if (e.matches) this._applyMobileTab(this.mobileTab);
                else this._clearMobileTabs();
            };
            mq.addEventListener('change', onMqChange);
        },

        _applyMobileTab(tab) {
            this.mobileTab = tab;
            const leftPanel  = document.getElementById('sc-left-panel');
            const rightPanel = document.getElementById('sc-right-panel');
            const tabProgress = document.getElementById('sc-tab-progress');
            const tabReviews  = document.getElementById('sc-tab-reviews');
            if (!leftPanel || !rightPanel) return;

            if (tab === 'progress') {
                leftPanel.style.display  = 'flex';
                rightPanel.style.display = 'none';
                tabProgress?.classList.add('active');
                tabReviews?.classList.remove('active');
            } else {
                leftPanel.style.display  = 'none';
                rightPanel.style.display = 'flex';
                tabProgress?.classList.remove('active');
                tabReviews?.classList.add('active');
            }
        },

        _clearMobileTabs() {
            const leftPanel  = document.getElementById('sc-left-panel');
            const rightPanel = document.getElementById('sc-right-panel');
            if (leftPanel)  leftPanel.style.display  = '';
            if (rightPanel) rightPanel.style.display = '';
        },

        _switchToReviewsTabIfMobile() {
            if (window.matchMedia('(max-width: 900px)').matches) {
                this._applyMobileTab('reviews');
            }
        },

        // ── Settings ─────────────────────────────────────────────────────────
        syncSettingsUI() {
            const settings   = this.settings;
            const mbToggle   = document.getElementById('sc-setting-mb-toggle');
            const mbSlider   = document.getElementById('sc-setting-mb-threshold');
            const mbVal      = document.getElementById('sc-setting-mb-threshold-val');
            const autoSlider = document.getElementById('sc-setting-auto-approve');
            const autoVal    = document.getElementById('sc-setting-auto-approve-val');
            const mbSection  = document.getElementById('sc-setting-mb-section');

            if (mbToggle)   mbToggle.checked              = settings.mbRescueEnabled;
            if (mbSection)  mbSection.style.opacity       = settings.mbRescueEnabled ? '1' : '0.4';
            if (mbSlider)   {
                mbSlider.value    = settings.mbRescoreThreshold;
                mbSlider.disabled = !settings.mbRescueEnabled;
            }
            if (mbVal)      mbVal.textContent             = settings.mbRescoreThreshold;
            if (autoSlider) autoSlider.value              = settings.autoApproveThreshold;
            if (autoVal)    autoVal.textContent           = settings.autoApproveThreshold;
        },

        // ── Retry helper ─────────────────────────────────────────────────────
        async withRetry(fn, signal, label) {
            const max = this.settings.maxRetries;
            let attempt = 0;
            while (true) {
                try {
                    return await fn(signal);
                } catch (err) {
                    if (err.name === 'AbortError' || err.code === 'NOT_FOUND') throw err;
                    attempt++;
                    if (attempt >= max) {
                        this.log(`⚡ [Retry] Gave up after ${max} attempts: ${label}`, 'warn');
                        throw err;
                    }
                    const isRateLimit = err.code === 'RATE_LIMIT';
                    const delay = isRateLimit ? 5000 * attempt : 1000 * Math.pow(2, attempt - 1);
                    this.log(`🔁 [Retry ${attempt}/${max}] ${isRateLimit ? 'Rate limited' : 'API error'} — waiting ${delay/1000}s: ${label}`, 'warn');
                    await new Promise(r => setTimeout(r, delay));
                    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
                }
            }
        },

        // ── Timed fetch ──────────────────────────────────────────────────────
        async timedFetch(url, options = {}) {
            const timeoutMs = this.settings.requestTimeoutMs;
            const timeoutController = new AbortController();
            const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
            const callerSignal = options.signal;
            let callerListener;
            if (callerSignal) {
                callerListener = () => timeoutController.abort();
                callerSignal.addEventListener('abort', callerListener);
            }
            try {
                const res = await this.api.fetch(url, { ...options, signal: timeoutController.signal });
                return res;
            } catch (err) {
                if (err.name === 'AbortError') {
                    if (callerSignal?.aborted) throw err;
                    const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
                    timeoutErr.code = 'API_ERROR';
                    throw timeoutErr;
                }
                throw err;
            } finally {
                clearTimeout(timeoutId);
                if (callerSignal && callerListener) callerSignal.removeEventListener('abort', callerListener);
            }
        },

        // ── API helpers ──────────────────────────────────────────────────────
        async getWorkingSearchEndpoint() {
            const endpoints = [...this.TIDAL_SEARCH_ENDPOINTS];
            if (this.lastWorkingSearchEndpoint) {
                const idx = endpoints.indexOf(this.lastWorkingSearchEndpoint);
                if (idx > -1) {
                    endpoints.splice(idx, 1);
                    endpoints.unshift(this.lastWorkingSearchEndpoint);
                }
            }
            for (const base of endpoints) {
                try {
                    const res = await fetch(`${base}/search/?s=test`, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
                    if (res.ok) {
                        this.lastWorkingSearchEndpoint = base;
                        return base;
                    }
                } catch (e) { }
            }
            return this.TIDAL_SEARCH_ENDPOINTS[0];
        },

        async searchByISRC(isrc, signal) {
            try {
                const res = await this.timedFetch(`${this.TIDAL_DETAILS_ENDPOINT}/track/?isrc=${isrc}`, { signal });
                if (res.ok) return (await res.json()).data;
                if (res.status === 429) {
                    const err = new Error('Rate limited');
                    err.code = 'RATE_LIMIT';
                    throw err;
                }
            } catch (e) {
                if (e.name === 'AbortError' || e.code === 'RATE_LIMIT') throw e;
            }
            return null;
        },

        async searchTidal(sourceTrack, signal) {
            if (sourceTrack.isrc) {
                try {
                    const tidalTrack = await this.searchByISRC(sourceTrack.isrc, signal);
                    if (tidalTrack) return { track: tidalTrack, score: 200, allCandidates: [{ track: tidalTrack, score: 200 }] };
                } catch (e) {
                    if (e.name === 'AbortError' || e.code === 'RATE_LIMIT') throw e;
                }
            }

            const endpoint = await this.getWorkingSearchEndpoint();
            const url = `${endpoint}/search/?s=${encodeURIComponent(`${sourceTrack.title} ${sourceTrack.artist}`)}`;
            let res;
            try {
                res = await this.timedFetch(url, { signal });
            } catch (e) {
                if (e.name === 'AbortError') throw e;
                const err = new Error(`Network error: ${e.message}`);
                err.code = 'API_ERROR';
                throw err;
            }
            if (res.status === 429) {
                const err = new Error('Rate limited');
                err.code = 'RATE_LIMIT';
                throw err;
            }
            if (!res.ok) {
                const err = new Error(`Search API HTTP ${res.status}`);
                err.code = 'API_ERROR';
                throw err;
            }

            const data = await res.json();
            if (!data.data?.items?.length) return null;

            const candidates = data.data.items.map(tidalTrack => ({
                track: tidalTrack,
                score: this.calculateMatchScore(tidalTrack, sourceTrack)
            }));
            candidates.sort((a, b) => b.score - a.score);
            const best = candidates[0];
            if (best.score <= 0) return null;
            return { track: best.track, score: best.score, allCandidates: candidates };
        },

        normalizeString(str) {
            if (!str) return '';
            return str
                .toLowerCase()
                .replace(/\(feat\..*?\)/gi, '').replace(/\[feat\..*?\]/gi, '')
                .replace(/- remaster(ed)?(\s+\d{4})?/gi, '').replace(/- \d{4} remaster/gi, '')
                .replace(/\(remaster(ed)?\)/gi, '').replace(/\(deluxe.*?\)/gi, '').replace(/\(bonus.*?\)/gi, '')
                .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        },

        calculateMatchScore(tidalTrack, spotifyTrack) {
            let score = 0;
            const tidalTitle   = this.normalizeString(tidalTrack.title);
            const spotifyTitle = this.normalizeString(spotifyTrack.title);
            if (tidalTitle === spotifyTitle) score += 50;
            else if (tidalTitle.includes(spotifyTitle) || spotifyTitle.includes(tidalTitle)) score += 30;

            const tidalArtist   = this.normalizeString(tidalTrack.artist?.name || tidalTrack.artists?.[0]?.name || '');
            const spotifyArtist = this.normalizeString(spotifyTrack.artist);
            if (tidalArtist === spotifyArtist) score += 30;
            else if (tidalArtist.includes(spotifyArtist) || spotifyArtist.includes(tidalArtist)) score += 15;

            if (spotifyTrack.duration_ms) {
                const diff = Math.abs(tidalTrack.duration - spotifyTrack.duration_ms / 1000);
                if (diff < 5) score += 20;
                else if (diff < 10) score += 10;
            }
            if (tidalTrack.isrc && spotifyTrack.isrc && tidalTrack.isrc === spotifyTrack.isrc) score += 100;
            return score;
        },

        // ── Library helpers ──────────────────────────────────────────────────
        async getTidalLibraryMap() {
            const map = new Map();
            if (this.api.library.getTracks) {
                try {
                    const tracks = await this.api.library.getTracks();
                    if (Array.isArray(tracks)) {
                        tracks.forEach(t => {
                            if (t.source_type === 'tidal' && t.external_id) map.set(String(t.external_id), t.id);
                        });
                    }
                } catch (e) { console.error(e); }
            }
            return map;
        },

        async addTrackToLibrary(tidalTrack) {
            const artistName = tidalTrack.artist?.name || tidalTrack.artists?.[0]?.name || 'Unknown Artist';
            const title      = tidalTrack.title + (tidalTrack.version ? ` (${tidalTrack.version})` : '');
            const coverUrl   = tidalTrack.album?.cover
                ? `https://resources.tidal.com/images/${tidalTrack.album.cover.replace(/-/g, '/')}/1280x1280.jpg`
                : null;
            return await this.api.library.addExternalTrack({
                title,
                artist:       artistName,
                album:        tidalTrack.album?.title  || null,
                duration:     tidalTrack.duration      || null,
                cover_url:    coverUrl,
                source_type:  'tidal',
                external_id:  String(tidalTrack.id),
                format:       'LOSSLESS',
                bitrate:      null,
                track_number: tidalTrack.trackNumber   || null,
                disc_number:  tidalTrack.volumeNumber  || null
            });
        },

        // ── Pending reviews ──────────────────────────────────────────────────
        _cancelAllPendingReviews(accept) {
            for (const [, entry] of this.pendingReviews) entry.resolve(accept);
            this.pendingReviews.clear();
            this.updateReviewBadge();
        },

        _hasPendingReviews() {
            return this.pendingReviews.size > 0;
        },

        // ── Review panel ─────────────────────────────────────────────────────
        async presentForReview(track, tidalTrack, score, idx) {
            return new Promise(resolve => {
                this.pendingReviews.set(idx, { track, tidalTrack, score, resolve });

                const card = this.createReviewCard(track, tidalTrack, score, idx, (accepted) => {
                    this.pendingReviews.delete(idx);
                    this.updateReviewBadge();
                    resolve(accepted);
                });

                const list = document.getElementById('sc-review-list');
                if (list) {
                    const empty = document.getElementById('sc-review-empty');
                    if (empty) empty.style.display = 'none';
                    list.appendChild(card);
                    this.updateReviewBadge();
                    if (this.pendingReviews.size === 1) this._switchToReviewsTabIfMobile();
                }
            });
        },

        createReviewCard(spotifyTrack, tidalTrack, score, idx, resolve) {
            const card     = document.createElement('div');
            card.className = 'sc-review-card';
            card.id        = `sc-review-card-${idx}`;
            const artistName = tidalTrack.artist?.name || tidalTrack.artists?.[0]?.name || 'Unknown';
            const coverUrl   = tidalTrack.album?.cover
                ? `https://resources.tidal.com/images/${tidalTrack.album.cover.replace(/-/g, '/')}/80x80.jpg`
                : null;
            const scoreColor = score >= 70 ? '#ffb800' : '#ff7b6b';
            const formatDuration = secs => secs ? `${Math.floor(secs/60)}:${String(Math.floor(secs%60)).padStart(2,'0')}` : '?';

            card.innerHTML = `
                <div class="sc-review-score" style="background:${scoreColor}22;color:${scoreColor};border-color:${scoreColor}55">${score}</div>
                <div class="sc-review-tracks">
                    <div class="sc-review-side">
                        <div class="sc-review-side-label sc-label-spotify">SPOTIFY</div>
                        <div class="sc-review-title">${this._esc(spotifyTrack.title)}</div>
                        <div class="sc-review-meta">${this._esc(spotifyTrack.artist)}</div>
                        ${spotifyTrack.album ? `<div class="sc-review-album">${this._esc(spotifyTrack.album)}</div>` : ''}
                        <div class="sc-review-dur">${formatDuration(spotifyTrack.duration_ms/1000)}</div>
                    </div>
                    <div class="sc-review-arrow">→</div>
                    <div class="sc-review-side">
                        <div class="sc-review-side-label sc-label-tidal">TIDAL</div>
                        ${coverUrl ? `<img class="sc-review-cover" src="${coverUrl}" alt="">` : ''}
                        <div class="sc-review-title">${this._esc(tidalTrack.title)}${tidalTrack.version ? ` <span class="sc-review-ver">(${this._esc(tidalTrack.version)})</span>` : ''}</div>
                        <div class="sc-review-meta">${this._esc(artistName)}</div>
                        ${tidalTrack.album?.title ? `<div class="sc-review-album">${this._esc(tidalTrack.album.title)}</div>` : ''}
                        <div class="sc-review-dur">${formatDuration(tidalTrack.duration)}</div>
                    </div>
                </div>
                <div class="sc-review-actions">
                    <button class="sc-review-btn sc-review-accept" id="sc-accept-${idx}">✅ Accept</button>
                    <button class="sc-review-btn sc-review-reject" id="sc-reject-${idx}">❌ Reject → MB</button>
                </div>`;

            card.querySelector(`#sc-accept-${idx}`).onclick = () => {
                card.classList.add('sc-review-resolved');
                card.innerHTML = `<div class="sc-review-resolved-label sc-resolved-accept">✅ Accepted — ${this._esc(spotifyTrack.artist)} — ${this._esc(spotifyTrack.title)}</div>`;
                resolve(true);
            };
            card.querySelector(`#sc-reject-${idx}`).onclick = () => {
                card.classList.add('sc-review-resolved');
                card.innerHTML = `<div class="sc-review-resolved-label sc-resolved-reject">❌ Rejected → MB — ${this._esc(spotifyTrack.artist)} — ${this._esc(spotifyTrack.title)}</div>`;
                resolve(false);
            };
            return card;
        },

        updateReviewBadge() {
            const badge = document.getElementById('sc-review-badge');
            if (!badge) return;
            const pendingCount   = this.pendingReviews.size;
            badge.textContent    = pendingCount > 0 ? String(pendingCount) : '';
            badge.style.display  = pendingCount > 0 ? 'inline-flex' : 'none';

            const tabBadge = document.getElementById('sc-tab-reviews-badge');
            if (tabBadge) {
                tabBadge.textContent   = pendingCount > 0 ? String(pendingCount) : '';
                tabBadge.style.display = pendingCount > 0 ? 'inline-flex' : 'none';
            }
        },

        _esc(str) {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },

        // ── Close guard popup ─────────────────────────────────────────────────
        _showCloseGuardPopup() {
            return new Promise(resolve => {
                const popup = document.getElementById('sc-close-guard-popup');
                popup.classList.add('open');

                const onAcceptAll = () => { cleanup(); this._cancelAllPendingReviews(true);  resolve('close'); };
                const onRejectAll = () => { cleanup(); this._cancelAllPendingReviews(false); resolve('close'); };
                const onContinue  = () => { cleanup(); this._cancelAllPendingReviews(false); resolve('close'); };
                const onCancel    = () => { cleanup(); resolve('cancel'); };

                const cleanup = () => {
                    popup.classList.remove('open');
                    document.getElementById('sc-guard-accept-all').removeEventListener('click', onAcceptAll);
                    document.getElementById('sc-guard-reject-all').removeEventListener('click', onRejectAll);
                    document.getElementById('sc-guard-continue').removeEventListener('click', onContinue);
                    document.getElementById('sc-guard-cancel').removeEventListener('click', onCancel);
                };

                document.getElementById('sc-guard-accept-all').addEventListener('click', onAcceptAll);
                document.getElementById('sc-guard-reject-all').addEventListener('click', onRejectAll);
                document.getElementById('sc-guard-continue').addEventListener('click', onContinue);
                document.getElementById('sc-guard-cancel').addEventListener('click', onCancel);
            });
        },

        // ── MusicBrainz rescue ───────────────────────────────────────────────
        async startMbWorker() {
            if (this.mbWorkerRunning) return;

            this.mbAbortController = new AbortController();
            this.mbWorkerRunning   = true;
            this.log('🔬 MB rescue worker started', 'info');

            let rescued = 0, failed = 0, mbIndex = 0;

            while (this.mbQueue.length > 0) {
                if (this.stopConversion || this.mbAbortController.signal.aborted) {
                    this.log(`⏹ MB rescue stopped (${this.mbQueue.length} remaining)`, 'warn');
                    break;
                }

                const { track, idx: slotIdx } = this.mbQueue.shift();
                mbIndex++;
                this.log(`🔬 [MB ${mbIndex}] ${track.artist} — ${track.title}`, 'info');
                const startTime = Date.now();

                try {
                    const enrichment = await this.withRetry(
                        () => this.api.musicbrainz.enrichTrack(track.artist, track.title),
                        this.mbAbortController.signal,
                        `MB lookup: ${track.artist} — ${track.title}`
                    );

                    if (enrichment.isrcs?.length) {
                        const cacheKey = `${this.normalizeString(track.title)}|${this.normalizeString(track.artist)}`;
                        const existing = this.candidateCache.get(cacheKey) || { tidalCandidates: [], mbIsrcs: [] };
                        existing.mbIsrcs = enrichment.isrcs;
                        this.candidateCache.set(cacheKey, existing);

                        this.log(`🔬 [MB ${mbIndex}] ${enrichment.isrcs.length} ISRC(s) found — trying Tidal...`, 'info');
                        let tidalTrack = null;
                        for (const isrc of enrichment.isrcs) {
                            tidalTrack = await this.withRetry(
                                (signal) => this.searchByISRC(isrc, signal),
                                this.mbAbortController.signal,
                                `ISRC lookup: ${isrc}`
                            );
                            if (tidalTrack) break;
                        }
                        if (tidalTrack) {
                            const tidalId    = String(tidalTrack.id);
                            const inLib      = this.existingTracks.has(tidalId);
                            const resolvedId = inLib ? this.existingTracks.get(tidalId) : await this.addTrackToLibrary(tidalTrack);
                            if (!inLib) this.existingTracks.set(tidalId, resolvedId);

                            this.foundTracks[slotIdx] = { track, trackId: resolvedId, wasInLibrary: inLib, truncatedTitle: track.title };
                            this.failedTracks = this.failedTracks.filter(f => !(f.title === track.title && f.artist === track.artist));
                            inLib ? this.counters.fromLibrary++ : this.counters.successes++;
                            this.counters.notFound = Math.max(0, this.counters.notFound - 1);
                            rescued++;
                            this.log(`✅ [MB ${mbIndex}] Rescued: ${track.artist} — ${track.title}`, 'success');
                        } else {
                            failed++;
                            this.log(`🚫 [MB ${mbIndex}] ISRC found but no Tidal match: ${track.artist} — ${track.title}`, 'warn');
                        }
                    } else {
                        failed++;
                        this.log(`🚫 [MB ${mbIndex}] No ISRC in MusicBrainz: ${track.artist} — ${track.title}`, 'warn');
                    }
                } catch (err) {
                    if (err?.name === 'AbortError') { this.log('⏹ MB rescue aborted', 'warn'); break; }
                    failed++;
                    this.log(`⚡ [MB ${mbIndex}] Error: ${err.message}`, 'warn');
                }

                const elapsed = Date.now() - startTime;
                if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
            }

            this.mbWorkerRunning   = false;
            this.mbAbortController = null;
            this.log(`🔬 MB rescue done — ✅ ${rescued} rescued | 🚫 ${failed} still missing`, 'info');
        },

        _restartMbWorker() {
            if (this.mbAbortController) {
                this.mbAbortController.abort();
                this.mbAbortController = null;
            }
            this.mbWorkerRunning = false;
            this.mbQueue         = [];
        },

        queueForMbLookup(track, idx) {
            if (!this.settings.mbRescueEnabled) return;
            this.mbQueue.push({ track, idx });
            this.startMbWorker();
        },

        // ── Failed tracks ────────────────────────────────────────────────────
        recordFailedTrack(track, reasonCode, reasonDetail) {
            this.failedTracks.push({
                title:      track.title  || 'Unknown',
                artist:     track.artist || 'Unknown',
                album:      track.album  || '',
                isrc:       track.isrc   || '',
                reasonCode,
                reason:     reasonDetail || ''
            });
        },

        getReasonLabel(code) {
            return {
                NOT_FOUND:  'Not available on Tidal',
                RATE_LIMIT: 'Rate limited by API',
                API_ERROR:  'API / network error',
                STOPPED:    'Conversion stopped early'
            }[code] || 'Unknown error';
        },

        exportFailedTracks() {
            if (!this.failedTracks.length) { this.log('No failed tracks to export.', 'warn'); return; }
            const lines = [
                '# Failed Tracks Report',
                `# Generated: ${new Date().toLocaleString()}`,
                `# Total failed: ${this.failedTracks.length}`,
                ''
            ];
            for (const code of ['NOT_FOUND', 'RATE_LIMIT', 'API_ERROR', 'STOPPED']) {
                const group = this.failedTracks.filter(t => t.reasonCode === code);
                if (!group.length) continue;
                lines.push(`## ${this.getReasonLabel(code)} (${group.length})`, '');
                for (const t of group) {
                    let line = `- ${t.artist} — ${t.title}`;
                    if (t.album) line += ` [${t.album}]`;
                    if (t.isrc)  line += ` (ISRC: ${t.isrc})`;
                    lines.push(line);
                    if (t.reason && t.reason !== this.getReasonLabel(code)) lines.push(`  Detail: ${t.reason}`);
                }
                lines.push('');
            }
            this._downloadBlob(lines.join('\n'), 'text/plain', `failed-tracks-${Date.now()}.txt`);
            this.log(`📄 Exported ${this.failedTracks.length} failed tracks as .txt`, 'success');
        },

        exportFailedTracksCSV() {
            if (!this.failedTracks.length) { this.log('No failed tracks to export.', 'warn'); return; }
            const escapeCSV = v => `"${String(v || '').replace(/"/g, '""')}"`;
            const rows = [
                ['Title', 'Artist', 'Album', 'ISRC', 'Failure Reason', 'Detail'].map(escapeCSV).join(','),
                ...this.failedTracks.map(t => [
                    t.title, t.artist, t.album, t.isrc, this.getReasonLabel(t.reasonCode), t.reason
                ].map(escapeCSV).join(','))
            ];
            this._downloadBlob(rows.join('\n'), 'text/csv', `failed-tracks-${Date.now()}.csv`);
            this.log(`📊 Exported ${this.failedTracks.length} failed tracks as .csv`, 'success');
        },

        _downloadBlob(content, mimeType, filename) {
            const a = Object.assign(document.createElement('a'), {
                href:     URL.createObjectURL(new Blob([content], { type: mimeType })),
                download: filename
            });
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        },

        updateExportButton() {
            const btn = document.getElementById('sc-export-btn');
            if (!btn) return;
            const count   = this.failedTracks.length;
            btn.disabled  = count === 0;
            btn.innerHTML = count > 0 ? `📄 Export Failed (${count}) ▾` : `📄 Export Failed`;
        },

        updateFailSummary() {
            const summary = document.getElementById('sc-fail-summary');
            if (!summary) return;
            if (!this.failedTracks.length) {
                summary.classList.remove('visible');
                this.updateExportButton();
                return;
            }
            const counts = { NOT_FOUND: 0, RATE_LIMIT: 0, API_ERROR: 0, STOPPED: 0 };
            this.failedTracks.forEach(t => { if (t.reasonCode in counts) counts[t.reasonCode]++; });
            const showPill = (id, code, labelFn) => {
                const el = document.getElementById(id);
                if (!el) return;
                if (counts[code] > 0) { el.textContent = labelFn(counts[code]); el.style.display = 'inline-flex'; }
                else el.style.display = 'none';
            };
            showPill('sc-pill-not-found',  'NOT_FOUND',  n => `🚫 ${n} not on Tidal`);
            showPill('sc-pill-rate-limit', 'RATE_LIMIT', n => `⏱ ${n} rate limited`);
            showPill('sc-pill-api-error',  'API_ERROR',  n => `⚡ ${n} API error`);
            showPill('sc-pill-stopped',    'STOPPED',    n => `⏹ ${n} stopped`);
            summary.classList.add('visible');
            this.updateExportButton();
        },

        // ── Styles ───────────────────────────────────────────────────────────
        injectStyles() {
            if (document.getElementById('spotify-converter-styles')) return;
            const styleEl = document.createElement('style');
            styleEl.id = 'spotify-converter-styles';
            styleEl.textContent = `
                #spotify-converter-overlay {
                    position:fixed;inset:0;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);
                    z-index:10000;opacity:0;visibility:hidden;transition:opacity 0.2s;
                }
                #spotify-converter-overlay.open{opacity:1;visibility:visible;}
                #spotify-converter-modal {
                    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.96);
                    width:1060px;max-width:97vw;max-height:90vh;
                    background:var(--bg-elevated,#181818);border:1px solid var(--border-color,#2e2e2e);
                    border-radius:20px;z-index:10001;box-shadow:0 32px 80px rgba(0,0,0,0.7);
                    display:flex;flex-direction:column;overflow:hidden;
                    opacity:0;visibility:hidden;transition:all 0.3s cubic-bezier(0.16,1,0.3,1);
                }
                #spotify-converter-modal.open{opacity:1;visibility:visible;transform:translate(-50%,-50%) scale(1);}

                .sc-header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border-color,#2a2a2a);background:var(--bg-elevated,#181818);flex-shrink:0;}
                .sc-header h2{margin:0;color:var(--text-primary,#fff);font-size:18px;display:flex;align-items:center;gap:10px;}
                .sc-icon{color:#1DB954;}
                .sc-header-actions{display:flex;align-items:center;gap:8px;}
                .sc-gear-btn,.sc-close-btn{background:transparent;border:none;color:var(--text-secondary,#b3b3b3);cursor:pointer;border-radius:8px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:18px;transition:background 0.2s,color 0.2s;}
                .sc-close-btn{border-radius:50%;font-size:22px;}
                .sc-gear-btn:hover,.sc-close-btn:hover{background:var(--bg-highlight,#2a2a2a);color:#fff;}

                /* ── Tab bar (mobile only, hidden on desktop) ── */
                #sc-tab-bar {
                    display:none;
                    flex-shrink:0;
                    background:var(--bg-elevated,#181818);
                    border-bottom:1px solid var(--border-color,#2a2a2a);
                    padding:0 12px;
                    gap:4px;
                }
                .sc-tab {
                    flex:1;
                    display:flex;align-items:center;justify-content:center;gap:6px;
                    padding:10px 8px;
                    font-size:12px;font-weight:600;
                    color:var(--text-secondary,#777);
                    border:none;background:transparent;cursor:pointer;
                    border-bottom:2px solid transparent;
                    transition:color 0.15s,border-color 0.15s;
                    position:relative;
                }
                .sc-tab.active{color:#fff;border-bottom-color:#1DB954;}
                .sc-tab-badge {
                    background:#ffb800;color:#000;font-size:9px;font-weight:700;
                    border-radius:20px;padding:1px 5px;
                    display:none;align-items:center;justify-content:center;
                    line-height:1.4;
                }

                .sc-panels{display:flex;flex:1;min-height:0;overflow:hidden;}
                .sc-left-panel{flex:1;display:flex;flex-direction:column;border-right:1px solid var(--border-color,#2a2a2a);min-width:0;overflow:hidden;}
                #sc-left-panel{} /* id hook for JS */
                .sc-left-body{flex:1;overflow-y:auto;padding:14px;background:var(--bg-base,#111);display:flex;flex-direction:column;gap:10px;min-height:0;}
                .sc-left-body::-webkit-scrollbar{width:5px;}
                .sc-left-body::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:3px;}

                .sc-right-panel{width:380px;flex-shrink:0;display:flex;flex-direction:column;background:var(--bg-base,#0e0e0e);overflow:hidden;}
                #sc-right-panel{} /* id hook for JS */
                .sc-review-header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border-color,#2a2a2a);background:var(--bg-elevated,#181818);flex-shrink:0;}
                .sc-review-header-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-secondary,#888);flex:1;}
                .sc-review-badge{background:#ffb800;color:#000;font-size:10px;font-weight:700;border-radius:20px;padding:2px 7px;display:none;align-items:center;justify-content:center;}
                .sc-review-list{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;}
                .sc-review-list::-webkit-scrollbar{width:5px;}
                .sc-review-list::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:3px;}
                .sc-review-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;color:var(--text-secondary,#555);font-size:12px;text-align:center;padding:20px;}
                .sc-review-empty-icon{font-size:28px;opacity:0.4;}

                .sc-review-card{background:var(--bg-elevated,#1a1a1a);border:1px solid var(--border-color,#2e2e2e);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;animation:sc-card-in 0.2s ease;}
                @keyframes sc-card-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
                .sc-review-card.sc-review-resolved{opacity:0.5;padding:8px 10px;}
                .sc-review-resolved-label{font-size:11px;font-style:italic;}
                .sc-resolved-accept{color:#1DB954;}
                .sc-resolved-reject{color:#ff7b6b;}
                .sc-resolved-skipped{color:#888;}
                .sc-review-score{align-self:flex-start;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;border:1px solid;}
                .sc-review-tracks{display:flex;align-items:flex-start;gap:6px;}
                .sc-review-side{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
                .sc-review-side-label{font-size:9px;font-weight:700;letter-spacing:0.5px;margin-bottom:2px;}
                .sc-label-spotify{color:#1DB954;}
                .sc-label-tidal{color:#0078ff;}
                .sc-review-title{font-size:12px;font-weight:600;color:var(--text-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
                .sc-review-ver{font-weight:400;color:var(--text-secondary,#888);font-size:11px;}
                .sc-review-meta{font-size:11px;color:var(--text-secondary,#b3b3b3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
                .sc-review-album{font-size:10px;color:var(--text-secondary,#666);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
                .sc-review-dur{font-size:10px;color:var(--text-secondary,#555);}
                .sc-review-arrow{color:var(--text-secondary,#555);font-size:14px;padding-top:18px;flex-shrink:0;}
                .sc-review-cover{width:36px;height:36px;border-radius:4px;object-fit:cover;margin-bottom:4px;}
                .sc-review-actions{display:flex;gap:6px;}
                .sc-review-btn{flex:1;border:none;border-radius:6px;padding:6px 8px;font-size:11px;font-weight:600;cursor:pointer;transition:filter 0.15s;}
                .sc-review-btn:hover{filter:brightness(1.15);}
                .sc-review-accept{background:rgba(29,185,84,0.15);color:#1DB954;border:1px solid rgba(29,185,84,0.3);}
                .sc-review-reject{background:rgba(231,76,60,0.12);color:#ff7b6b;border:1px solid rgba(231,76,60,0.25);}

                .sc-section{background:var(--bg-elevated,#1a1a1a);border-radius:10px;padding:12px;border:1px solid var(--border-color,#2a2a2a);flex-shrink:0;}
                .sc-section-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-secondary,#888);margin-bottom:8px;display:flex;align-items:center;gap:6px;}
                .sc-row{display:flex;gap:8px;align-items:center;}
                .sc-input-wrapper{flex:1;position:relative;}
                .sc-input{width:100%;background:var(--bg-surface,#282828);border:1px solid var(--border-color,#404040);color:var(--text-primary,#fff);padding:9px 34px 9px 10px;border-radius:8px;font-size:13px;box-sizing:border-box;}
                .sc-input:focus{outline:none;border-color:#1DB954;}
                .sc-input:disabled{opacity:0.6;background:var(--bg-highlight,#222);}
                .sc-clear-file{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:#555;border:none;border-radius:50%;width:18px;height:18px;color:white;font-size:11px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2;}
                .sc-clear-file:hover{background:#777;}
                .sc-file-input-label{display:inline-flex;align-items:center;gap:6px;background:var(--bg-surface,#282828);border:1px solid var(--border-color,#404040);color:var(--text-primary,#fff);padding:9px 13px;border-radius:8px;cursor:pointer;transition:border-color 0.2s;white-space:nowrap;font-size:13px;}
                .sc-file-input-label:hover{border-color:#1DB954;}
                #sc-file-input{display:none;}
                .sc-file-info{font-size:12px;color:#1DB954;margin-top:8px;display:none;align-items:center;gap:8px;}
                .sc-remove-json{background:transparent;border:1px solid #e74c3c;color:#e74c3c;padding:2px 9px;border-radius:20px;font-size:11px;cursor:pointer;}
                .sc-remove-json:hover{background:#e74c3c;color:#fff;}
                .sc-info-banner{font-size:11px;color:var(--text-secondary,#999);padding:8px 10px;border-radius:6px;background:rgba(255,255,255,0.04);line-height:1.5;flex-shrink:0;}
                .sc-info-banner strong{color:var(--text-primary,#ccc);}
                .sc-help-link{color:#1DB954;cursor:pointer;text-decoration:none;font-weight:500;}
                .sc-help-link:hover{text-decoration:underline;}
                .sc-help-box{background:var(--bg-surface,#282828);border:1px solid var(--border-color,#404040);border-radius:8px;padding:12px;font-size:12px;color:var(--text-secondary,#b3b3b3);display:none;flex-shrink:0;}
                .sc-help-box.visible{display:block;}
                .sc-help-box a{color:#1DB954;text-decoration:none;}
                .sc-help-box ol{margin:6px 0 0;padding-left:18px;}
                .sc-btn{background:#1DB954;color:#fff;border:none;padding:9px 15px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;transition:filter 0.15s,transform 0.1s;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
                .sc-btn:hover:not(:disabled){filter:brightness(1.1);transform:scale(1.02);}
                .sc-btn:disabled{opacity:0.5;cursor:not-allowed;}
                .sc-btn.secondary{background:var(--bg-surface,#282828);border:1px solid var(--border-color,#404040);color:var(--text-primary,#fff);}
                .sc-btn.secondary:hover:not(:disabled){background:var(--bg-highlight,#333);border-color:#555;}
                .sc-export-group{position:relative;display:inline-flex;}
                .sc-export-dropdown{
                    position:absolute;bottom:calc(100% + 6px);right:0;
                    background:var(--bg-elevated,#222);border:1px solid var(--border-color,#404040);
                    border-radius:8px;overflow:hidden;display:none;flex-direction:column;
                    min-width:170px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:20;
                }
                .sc-export-dropdown.open{display:flex;}
                .sc-export-dropdown button{background:transparent;border:none;color:var(--text-primary,#fff);padding:10px 14px;font-size:13px;cursor:pointer;text-align:left;display:flex;align-items:center;gap:8px;transition:background 0.15s;}
                .sc-export-dropdown button:hover{background:var(--bg-highlight,#2e2e2e);}
                .sc-fail-summary{display:none;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-radius:8px;background:rgba(231,76,60,0.07);border:1px solid rgba(231,76,60,0.2);flex-shrink:0;}
                .sc-fail-summary.visible{display:flex;}
                .sc-fail-label{font-size:11px;color:var(--text-secondary,#888);margin-right:2px;}
                .sc-fail-pill{font-size:11px;padding:3px 8px;border-radius:20px;font-weight:600;display:none;align-items:center;gap:4px;}
                .sc-fail-pill.not-found{background:rgba(231,76,60,0.18);color:#ff7b6b;}
                .sc-fail-pill.rate-limit{background:rgba(255,184,0,0.18);color:#ffb800;}
                .sc-fail-pill.api-error{background:rgba(102,110,255,0.18);color:#8890ff;}
                .sc-fail-pill.stopped{background:rgba(180,180,180,0.1);color:#aaa;}
                .sc-playlist-preview{background:var(--bg-surface,#1e1e1e);border-radius:8px;padding:10px;display:flex;align-items:center;gap:10px;flex-shrink:0;}
                .sc-playlist-cover{width:44px;height:44px;border-radius:6px;background:var(--bg-highlight,#2a2a2a);object-fit:cover;flex-shrink:0;}
                .sc-playlist-info{flex:1;overflow:hidden;display:flex;flex-direction:column;gap:2px;}
                .sc-playlist-name{font-size:13px;font-weight:600;color:var(--text-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
                .sc-playlist-owner{font-size:11px;color:var(--text-secondary,#b3b3b3);}
                .sc-playlist-meta{font-size:11px;color:var(--text-secondary,#888);}
                .sc-progress-bar{height:4px;background:var(--bg-highlight,#3e3e3e);border-radius:2px;overflow:hidden;flex-shrink:0;}
                .sc-progress-value{height:100%;background:#1DB954;width:0%;transition:width 0.25s;}
                .sc-log{background:#000;border-radius:8px;padding:10px;flex:1;min-height:100px;overflow-y:auto;font-family:monospace;font-size:11px;color:#bbb;display:flex;flex-direction:column;gap:3px;}
                .sc-log-item.success{color:#1DB954;}
                .sc-log-item.error{color:#ff5555;}
                .sc-log-item.warn{color:#ffb86c;}
                .sc-log-item.info{color:#66d9ef;}
                .sc-footer{
                    display:flex;align-items:center;justify-content:flex-end;gap:8px;
                    padding:10px 16px;border-top:1px solid var(--border-color,#2a2a2a);
                    background:var(--bg-elevated,#181818);flex-shrink:0;
                }

                /* Close guard popup */
                #sc-close-guard-popup{position:fixed;z-index:10020;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.95);width:380px;max-width:94vw;background:var(--bg-elevated,#1e1e1e);border:1px solid var(--border-color,#3a3a3a);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,0.8);opacity:0;visibility:hidden;transition:all 0.2s cubic-bezier(0.16,1,0.3,1);overflow:hidden;}
                #sc-close-guard-popup.open{opacity:1;visibility:visible;transform:translate(-50%,-50%) scale(1);}
                .sc-guard-header{padding:16px 18px 0;display:flex;flex-direction:column;gap:6px;}
                .sc-guard-title{font-size:15px;font-weight:700;color:var(--text-primary,#fff);display:flex;align-items:center;gap:8px;}
                .sc-guard-subtitle{font-size:12px;color:var(--text-secondary,#888);line-height:1.5;}
                .sc-guard-body{display:flex;flex-direction:column;gap:8px;padding:14px 18px 18px;}
                .sc-guard-btn{width:100%;padding:10px 14px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;border:none;text-align:left;display:flex;flex-direction:column;gap:2px;transition:filter 0.15s;}
                .sc-guard-btn:hover{filter:brightness(1.1);}
                .sc-guard-btn-accept{background:rgba(29,185,84,0.15);color:#1DB954;border:1px solid rgba(29,185,84,0.3);}
                .sc-guard-btn-reject{background:rgba(231,76,60,0.12);color:#ff7b6b;border:1px solid rgba(231,76,60,0.25);}
                .sc-guard-btn-continue{background:rgba(255,184,0,0.1);color:#ffb800;border:1px solid rgba(255,184,0,0.25);}
                .sc-guard-btn-cancel{background:var(--bg-surface,#282828);color:var(--text-secondary,#aaa);border:1px solid var(--border-color,#404040);}
                .sc-guard-btn-desc{font-size:11px;font-weight:400;opacity:0.75;}

                /* Settings popup */
                #sc-settings-popup{position:fixed;z-index:10010;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.95);width:360px;max-width:94vw;background:var(--bg-elevated,#1e1e1e);border:1px solid var(--border-color,#333);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,0.7);opacity:0;visibility:hidden;transition:all 0.2s cubic-bezier(0.16,1,0.3,1);overflow:hidden;}
                #sc-settings-popup.open{opacity:1;visibility:visible;transform:translate(-50%,-50%) scale(1);}
                .sc-settings-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border-color,#2a2a2a);}
                .sc-settings-title{font-size:14px;font-weight:600;color:var(--text-primary,#fff);display:flex;align-items:center;gap:8px;}
                .sc-settings-close{background:transparent;border:none;color:var(--text-secondary,#888);font-size:18px;cursor:pointer;border-radius:6px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;}
                .sc-settings-close:hover{background:var(--bg-highlight,#2a2a2a);color:#fff;}
                .sc-settings-body{padding:16px;display:flex;flex-direction:column;gap:16px;max-height:70vh;overflow-y:auto;}
                .sc-settings-group{display:flex;flex-direction:column;gap:10px;}
                .sc-settings-group-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-secondary,#666);}
                .sc-setting-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}
                .sc-setting-label-wrap{display:flex;flex-direction:column;}
                .sc-setting-label{font-size:13px;color:var(--text-primary,#ddd);}
                .sc-setting-sublabel{font-size:11px;color:var(--text-secondary,#777);margin-top:1px;}
                .sc-toggle{position:relative;width:40px;height:22px;flex-shrink:0;}
                .sc-toggle input{opacity:0;width:0;height:0;}
                .sc-toggle-slider{position:absolute;inset:0;background:#444;border-radius:22px;cursor:pointer;transition:background 0.2s;}
                .sc-toggle-slider:before{content:'';position:absolute;width:16px;height:16px;left:3px;top:3px;background:white;border-radius:50%;transition:transform 0.2s;}
                .sc-toggle input:checked+.sc-toggle-slider{background:#1DB954;}
                .sc-toggle input:checked+.sc-toggle-slider:before{transform:translateX(18px);}
                .sc-slider-row{display:flex;flex-direction:column;gap:6px;}
                .sc-slider-header{display:flex;justify-content:space-between;align-items:center;}
                .sc-slider-label{font-size:13px;color:var(--text-primary,#ddd);}
                .sc-slider-val{font-size:13px;font-weight:700;color:#1DB954;background:rgba(29,185,84,0.12);padding:1px 8px;border-radius:20px;min-width:32px;text-align:center;}
                .sc-slider{-webkit-appearance:none;width:100%;height:4px;border-radius:2px;background:#333;outline:none;}
                .sc-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#1DB954;cursor:pointer;transition:transform 0.1s;}
                .sc-slider::-webkit-slider-thumb:hover{transform:scale(1.2);}
                .sc-slider:disabled{opacity:0.4;}
                .sc-slider:disabled::-webkit-slider-thumb{cursor:not-allowed;}
                .sc-settings-divider{height:1px;background:var(--border-color,#2a2a2a);}
                .sc-settings-note{font-size:11px;color:var(--text-secondary,#666);background:rgba(255,255,255,0.03);border-radius:6px;padding:8px 10px;line-height:1.5;}

                /* ── Mobile ── */
                @media(max-width:900px){
                    #spotify-converter-modal{
                        top:0;left:0;
                        width:100vw;
                        height:100dvh;
                        transform:none !important;
                        border-radius:0;border:none;
                        max-width:none;max-height:none;
                        padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
                        box-sizing:border-box;
                    }
                    #sc-tab-bar{display:flex;}
                    .sc-panels{flex-direction:column;overflow:visible;}
                    .sc-left-panel{border-right:none;flex:1;min-height:0;overflow:hidden;}
                    .sc-right-panel{width:100%;flex:1;min-height:0;}
                    .sc-review-tracks{flex-direction:column;gap:10px;}
                    .sc-review-arrow{display:none;}
                    .sc-review-side{flex:none;width:100%;}
                    .sc-review-side:last-child{border-top:1px solid var(--border-color,#2a2a2a);padding-top:8px;}
                    .sc-footer{flex-wrap:wrap;gap:6px;padding:8px 12px 10px;}
                    .sc-footer > #sc-stop-btn,
                    .sc-footer > .sc-export-group{flex:1 1 0;min-width:0;}
                    .sc-footer > .sc-export-group > #sc-export-btn{width:100%;justify-content:center;}
                    .sc-footer > #sc-convert-btn{flex:1 1 100%;justify-content:center;min-height:44px;}
                    .sc-footer > #sc-stop-btn{justify-content:center;}
                    .sc-export-dropdown{bottom:calc(100% + 6px);top:auto;right:0;left:auto;max-height:50vh;overflow-y:auto;}
                    .sc-input{font-size:16px;}
                    .sc-review-btn{min-height:42px;font-size:13px;}
                    #sc-settings-popup{width:94vw;max-height:88dvh;top:calc(50% - env(safe-area-inset-bottom) / 2);}
                    .sc-settings-body{max-height:calc(88dvh - 56px);}
                    #sc-close-guard-popup{width:92vw;top:calc(50% - env(safe-area-inset-bottom) / 2);}
                }
            `;
            document.head.appendChild(styleEl);
        },

        // ── Close guard popup DOM ─────────────────────────────────────────────
        createCloseGuardPopup() {
            const popup = document.createElement('div');
            popup.id = 'sc-close-guard-popup';
            popup.innerHTML = `
                <div class="sc-guard-header">
                    <div class="sc-guard-title">⚠️ Pending Reviews</div>
                    <div class="sc-guard-subtitle">Some tracks are still waiting for your review. What would you like to do before closing?</div>
                </div>
                <div class="sc-guard-body">
                    <button class="sc-guard-btn sc-guard-btn-accept" id="sc-guard-accept-all">
                        ✅ Accept All
                        <div class="sc-guard-btn-desc">Add all pending tracks to the playlist</div>
                    </button>
                    <button class="sc-guard-btn sc-guard-btn-reject" id="sc-guard-reject-all">
                        ❌ Reject All
                        <div class="sc-guard-btn-desc">Send all pending tracks to MusicBrainz rescue</div>
                    </button>
                    <button class="sc-guard-btn sc-guard-btn-continue" id="sc-guard-continue">
                        ⚠️ Skip & Close
                        <div class="sc-guard-btn-desc">Pending tracks will be skipped and not added</div>
                    </button>
                    <button class="sc-guard-btn sc-guard-btn-cancel" id="sc-guard-cancel">
                        ↩ Cancel — Keep Reviewing
                    </button>
                </div>`;
            document.body.appendChild(popup);
        },

        // ── Settings popup ───────────────────────────────────────────────────
        createSettingsPopup() {
            const popup = document.createElement('div');
            popup.id = 'sc-settings-popup';
            popup.innerHTML = `
                <div class="sc-settings-header">
                    <div class="sc-settings-title">⚙️ Conversion Settings</div>
                    <button class="sc-settings-close" id="sc-settings-close">✕</button>
                </div>
                <div class="sc-settings-body">
                    <div class="sc-settings-group">
                        <div class="sc-settings-group-label">Confidence Thresholds</div>
                        <div class="sc-slider-row">
                            <div class="sc-slider-header">
                                <span class="sc-slider-label">Auto-approve above</span>
                                <span class="sc-slider-val" id="sc-setting-auto-approve-val">80</span>
                            </div>
                            <input type="range" class="sc-slider" id="sc-setting-auto-approve" min="50" max="150" step="5" value="80">
                        </div>
                        <div class="sc-slider-row" id="sc-setting-mb-section">
                            <div class="sc-slider-header">
                                <span class="sc-slider-label">Send to MB rescue below</span>
                                <span class="sc-slider-val" id="sc-setting-mb-threshold-val">60</span>
                            </div>
                            <input type="range" class="sc-slider" id="sc-setting-mb-threshold" min="0" max="100" step="5" value="60">
                        </div>
                        <div class="sc-settings-note">
                            Scores between <strong>MB threshold</strong> and <strong>auto-approve</strong> appear in the review panel. Changes apply immediately.
                        </div>
                    </div>
                    <div class="sc-settings-divider"></div>
                    <div class="sc-settings-group">
                        <div class="sc-settings-group-label">MusicBrainz Rescue</div>
                        <div class="sc-setting-row">
                            <div class="sc-setting-label-wrap">
                                <span class="sc-setting-label">Enable MB rescue</span>
                                <span class="sc-setting-sublabel">Looks up ISRCs for failed/rejected tracks</span>
                            </div>
                            <label class="sc-toggle">
                                <input type="checkbox" id="sc-setting-mb-toggle" checked>
                                <span class="sc-toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                    <div class="sc-settings-divider"></div>
                    <div class="sc-settings-group">
                        <div class="sc-settings-group-label">Reliability</div>
                        <div class="sc-slider-row">
                            <div class="sc-slider-header">
                                <span class="sc-slider-label">Max retries (transient errors)</span>
                                <span class="sc-slider-val" id="sc-setting-retries-val">3</span>
                            </div>
                            <input type="range" class="sc-slider" id="sc-setting-retries" min="1" max="5" step="1" value="3">
                        </div>
                        <div class="sc-slider-row">
                            <div class="sc-slider-header">
                                <span class="sc-slider-label">Request timeout (seconds)</span>
                                <span class="sc-slider-val" id="sc-setting-timeout-val">12</span>
                            </div>
                            <input type="range" class="sc-slider" id="sc-setting-timeout" min="5" max="30" step="1" value="12">
                        </div>
                        <div class="sc-settings-note">
                            Retries apply to <strong>rate limits</strong> and <strong>API errors</strong> only. Content not found on Tidal is never retried.
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(popup);

            document.getElementById('sc-settings-close').onclick = () => this.closeSettings();
            document.addEventListener('click', e => {
                const popup = document.getElementById('sc-settings-popup');
                if (popup?.classList.contains('open') && !popup.contains(e.target) && e.target.id !== 'sc-gear-btn') {
                    this.closeSettings();
                }
            });

            document.getElementById('sc-setting-auto-approve').addEventListener('input', e => {
                const val = parseInt(e.target.value);
                document.getElementById('sc-setting-auto-approve-val').textContent = val;
                const mbSlider = document.getElementById('sc-setting-mb-threshold');
                if (val <= parseInt(mbSlider.value)) {
                    const newMb = val - 5;
                    mbSlider.value = newMb;
                    document.getElementById('sc-setting-mb-threshold-val').textContent = newMb;
                    this.settings.mbRescoreThreshold = newMb;
                }
                this.settings.autoApproveThreshold = val;
            });

            document.getElementById('sc-setting-mb-threshold').addEventListener('input', e => {
                const val = parseInt(e.target.value);
                document.getElementById('sc-setting-mb-threshold-val').textContent = val;
                const autoSlider = document.getElementById('sc-setting-auto-approve');
                if (val >= parseInt(autoSlider.value)) {
                    const newAuto = val + 5;
                    autoSlider.value = newAuto;
                    document.getElementById('sc-setting-auto-approve-val').textContent = newAuto;
                    this.settings.autoApproveThreshold = newAuto;
                }
                this.settings.mbRescoreThreshold = val;
            });

            document.getElementById('sc-setting-mb-toggle').addEventListener('change', e => {
                this.settings.mbRescueEnabled = e.target.checked;
                this.syncSettingsUI();
            });

            document.getElementById('sc-setting-retries').addEventListener('input', e => {
                const val = parseInt(e.target.value);
                document.getElementById('sc-setting-retries-val').textContent = val;
                this.settings.maxRetries = val;
            });

            document.getElementById('sc-setting-timeout').addEventListener('input', e => {
                const val = parseInt(e.target.value);
                document.getElementById('sc-setting-timeout-val').textContent = val;
                this.settings.requestTimeoutMs = val * 1000;
            });
        },

        openSettings()  { document.getElementById('sc-settings-popup').classList.add('open'); },
        closeSettings() { document.getElementById('sc-settings-popup').classList.remove('open'); },

        // ── Modal ────────────────────────────────────────────────────────────
        createModal() {
            this.createCloseGuardPopup();

            const overlay = document.createElement('div');
            overlay.id = 'spotify-converter-overlay';
            overlay.onclick = () => this.close();
            document.body.appendChild(overlay);

            const modal = document.createElement('div');
            modal.id = 'spotify-converter-modal';
            modal.innerHTML = `
                <div class="sc-header">
                    <h2>
                        <svg class="sc-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.38 9.841-.719 13.44 1.56.42.3.6.84.3 1.26zm.12-3.36C14.939 8.46 8.641 8.28 5.1 9.421c-.6.18-1.26-.12-1.441-.72-.18-.6.12-1.26.72-1.44 4.08-1.26 11.04-1.02 15.361 1.56.6.358.779 1.14.421 1.74-.359.6-1.14.779-1.741.419z"/>
                        </svg>
                        Spotify → Audion
                    </h2>
                    <div class="sc-header-actions">
                        <button class="sc-gear-btn" id="sc-gear-btn" title="Settings">⚙️</button>
                        <button class="sc-close-btn" id="sc-close-btn" title="Close">✕</button>
                    </div>
                </div>

                <!-- Mobile tab bar — hidden on desktop via CSS -->
                <div id="sc-tab-bar">
                    <button class="sc-tab active" id="sc-tab-progress">
                        📊 Progress
                    </button>
                    <button class="sc-tab" id="sc-tab-reviews">
                        🔍 Reviews
                        <span class="sc-tab-badge" id="sc-tab-reviews-badge"></span>
                    </button>
                </div>

                <div class="sc-panels">
                    <div class="sc-left-panel" id="sc-left-panel">
                        <div class="sc-left-body" id="sc-body">
                            <div class="sc-section">
                                <div class="sc-section-title">📥 Import Source</div>
                                <div class="sc-row">
                                    <div class="sc-input-wrapper">
                                        <input type="text" id="sc-url-input" class="sc-input" placeholder="https://open.spotify.com/playlist/..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
                                        <div id="sc-clear-file" class="sc-clear-file" style="display:none;">✕</div>
                                    </div>
                                    <label for="sc-file-input" class="sc-file-input-label" id="sc-upload-btn-label">
                                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                                        </svg>
                                        JSON
                                    </label>
                                    <input type="file" id="sc-file-input" accept=".json">
                                </div>
                                <div id="sc-file-info" class="sc-file-info"></div>
                            </div>

                            <div class="sc-info-banner">
                                ⚠️ Playlists must be <strong>public</strong>. Requires <strong>tidal-search</strong> plugin to play.
                                <a class="sc-help-link" id="sc-help-toggle">Need help?</a>
                            </div>
                            <div class="sc-help-box" id="sc-help-box">
                                <strong>💡 Alternative Method:</strong> If automatic conversion fails:
                                <ol>
                                    <li>Visit <a href="https://playlist.audionplayer.com" target="_blank">playlist.audionplayer.com</a></li>
                                    <li>Paste your Spotify playlist URL to get JSON data</li>
                                    <li>Save the JSON and upload using the JSON button above</li>
                                </ol>
                            </div>

                            <div id="sc-playlist-preview" class="sc-playlist-preview" style="display:none;">
                                <img id="sc-playlist-cover" class="sc-playlist-cover" src="" alt="">
                                <div class="sc-playlist-info">
                                    <div id="sc-playlist-name" class="sc-playlist-name"></div>
                                    <div id="sc-playlist-owner" class="sc-playlist-owner"></div>
                                    <div id="sc-playlist-trackcount" class="sc-playlist-meta"></div>
                                </div>
                            </div>

                            <div class="sc-progress-bar"><div class="sc-progress-value" id="sc-progress"></div></div>

                            <div class="sc-fail-summary" id="sc-fail-summary">
                                <span class="sc-fail-label">Failed:</span>
                                <span class="sc-fail-pill not-found"  id="sc-pill-not-found"></span>
                                <span class="sc-fail-pill rate-limit" id="sc-pill-rate-limit"></span>
                                <span class="sc-fail-pill api-error"  id="sc-pill-api-error"></span>
                                <span class="sc-fail-pill stopped"    id="sc-pill-stopped"></span>
                            </div>

                            <div class="sc-log" id="sc-log">
                                <div class="sc-log-item info">> Ready to convert...</div>
                            </div>
                        </div>
                    </div>

                    <div class="sc-right-panel" id="sc-right-panel">
                        <div class="sc-review-header">
                            <span class="sc-review-header-title">🔍 Review Low-Confidence Matches</span>
                            <span class="sc-review-badge" id="sc-review-badge"></span>
                        </div>
                        <div class="sc-review-list" id="sc-review-list">
                            <div class="sc-review-empty" id="sc-review-empty">
                                <span class="sc-review-empty-icon">🎯</span>
                                <span>Low-confidence matches will<br>appear here during conversion</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="sc-footer">
                    <button class="sc-btn secondary" id="sc-stop-btn" disabled>⏹ Stop</button>
                    <div class="sc-export-group">
                        <button class="sc-btn secondary" id="sc-export-btn" disabled>📄 Export Failed</button>
                        <div class="sc-export-dropdown" id="sc-export-dropdown">
                            <button id="sc-export-txt-btn">📄 Download as .txt</button>
                            <button id="sc-export-csv-btn">📊 Download as .csv</button>
                        </div>
                    </div>
                    <button class="sc-btn" id="sc-convert-btn">🚀 Convert</button>
                </div>`;
            document.body.appendChild(modal);

            // Event bindings
            modal.querySelector('#sc-close-btn').onclick   = () => this.close();
            modal.querySelector('#sc-convert-btn').onclick = () => this.startConversion();
            modal.querySelector('#sc-stop-btn').onclick    = () => this.stopConversionProcess();
            modal.querySelector('#sc-gear-btn').onclick    = e => { e.stopPropagation(); this.openSettings(); };
            modal.querySelector('#sc-file-input').addEventListener('change', e => this.handleFileUpload(e));
            modal.querySelector('#sc-clear-file').addEventListener('click', () => this.clearFile());
            modal.querySelector('#sc-help-toggle').onclick = e => {
                e.preventDefault();
                const helpBox = document.getElementById('sc-help-box');
                helpBox.classList.toggle('visible');
                e.target.textContent = helpBox.classList.contains('visible') ? 'Hide help' : 'Need help?';
            };

            const exportBtn      = modal.querySelector('#sc-export-btn');
            const exportDropdown = modal.querySelector('#sc-export-dropdown');
            exportBtn.onclick = e => { e.stopPropagation(); if (!exportBtn.disabled) exportDropdown.classList.toggle('open'); };
            document.addEventListener('click', () => exportDropdown.classList.remove('open'));
            modal.querySelector('#sc-export-txt-btn').onclick = () => { exportDropdown.classList.remove('open'); this.exportFailedTracks(); };
            modal.querySelector('#sc-export-csv-btn').onclick = () => { exportDropdown.classList.remove('open'); this.exportFailedTracksCSV(); };

            // Tab bar bindings
            modal.querySelector('#sc-tab-progress').onclick = () => this._applyMobileTab('progress');
            modal.querySelector('#sc-tab-reviews').onclick  = () => this._applyMobileTab('reviews');

            if (window.matchMedia('(max-width: 900px)').matches) {
                this._applyMobileTab('progress');
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

        open() {
            this.isOpen = true;
            document.getElementById('spotify-converter-overlay').classList.add('open');
            document.getElementById('spotify-converter-modal').classList.add('open');
            if (window.matchMedia('(max-width: 900px)').matches) {
                this._applyMobileTab('progress');
            }
        },

        async close() {
            if (this.isConverting) return;

            if (this._hasPendingReviews()) {
                const result = await this._showCloseGuardPopup();
                if (result === 'cancel') return;
            }

            this.isOpen = false;
            document.getElementById('spotify-converter-overlay').classList.remove('open');
            document.getElementById('spotify-converter-modal').classList.remove('open');
            this.closeSettings();
        },

        log(msg, type = 'info') {
            const logEl  = document.getElementById('sc-log');
            const item   = document.createElement('div');
            item.className   = `sc-log-item ${type}`;
            item.textContent = `> ${msg}`;
            logEl.appendChild(item);
            logEl.scrollTop = logEl.scrollHeight;
        },

        updateProgress(pct) {
            document.getElementById('sc-progress').style.width = `${Math.min(100, pct)}%`;
        },

        showPlaylistPreview(data) {
            const img        = document.getElementById('sc-playlist-cover');
            const nameEl     = document.getElementById('sc-playlist-name');
            const ownerEl    = document.getElementById('sc-playlist-owner');
            const countEl    = document.getElementById('sc-playlist-trackcount');
            img.style.display = data.image ? 'block' : 'none';
            if (data.image) img.src = data.image;
            nameEl.textContent    = data.title || 'Playlist';
            ownerEl.innerHTML     = data.owner ? `👤 ${data.owner}` : '';
            ownerEl.style.display = data.owner ? 'flex' : 'none';
            const total   = data.total || data.tracks.length;
            const fetched = data.tracks.length;
            countEl.innerHTML = (data.total && data.total > fetched)
                ? `🎵 ${fetched} of ${total} tracks loaded`
                : `🎵 ${total} tracks`;
            document.getElementById('sc-playlist-preview').style.display = 'flex';
        },

        // ── File handling ─────────────────────────────────────────────────────
        handleFileUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.log(`Reading file: ${file.name}...`);
            const reader = new FileReader();
            reader.onload = e => {
                try {
                    const json = JSON.parse(e.target.result);
                    if (!Array.isArray(json)) throw new Error('JSON must be an array');
                    this.importedPlaylistData = this.normalizeJSON(json);
                    const fileInfo = document.getElementById('sc-file-info');
                    fileInfo.innerHTML = `📁 Loaded ${this.importedPlaylistData.tracks.length} tracks <button class="sc-remove-json" id="sc-remove-json">Remove</button>`;
                    fileInfo.style.display = 'flex';
                    const urlInput = document.getElementById('sc-url-input');
                    urlInput.value       = '';
                    urlInput.placeholder = 'Using imported JSON file...';
                    urlInput.disabled    = true;
                    document.getElementById('sc-clear-file').style.display      = 'flex';
                    document.getElementById('sc-upload-btn-label').style.display = 'none';
                    document.getElementById('sc-remove-json').onclick = () => this.clearFile();
                    this.log(`Parsed ${this.importedPlaylistData.tracks.length} tracks`, 'success');
                } catch (err) {
                    this.log('Invalid JSON file format', 'error');
                    event.target.value = '';
                }
            };
            reader.readAsText(file);
        },

        clearFile() {
            this.importedPlaylistData = null;
            document.getElementById('sc-file-input').value = '';
            const urlInput = document.getElementById('sc-url-input');
            urlInput.value       = '';
            urlInput.disabled    = false;
            urlInput.placeholder = 'https://open.spotify.com/playlist/...';
            document.getElementById('sc-file-info').style.display       = 'none';
            document.getElementById('sc-clear-file').style.display      = 'none';
            document.getElementById('sc-upload-btn-label').style.display = 'flex';
            document.getElementById('sc-playlist-preview').style.display = 'none';
            this.log('File cleared.', 'info');
        },

        normalizeJSON(jsonData) {
            return {
                title: 'JSON Import',
                description: `Imported ${jsonData.length} tracks from file`,
                tracks: jsonData.map(t => ({
                    title:       t.songTitle || t.title || t.name || 'Unknown',
                    artist:      Array.isArray(t.artist) ? t.artist.join(', ') : (t.artist || t.artist_name || 'Unknown'),
                    album:       t.album || null,
                    duration_ms: this.parseDurationToMs(t.duration),
                    isrc:        t.isrc || null
                }))
            };
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

        // ── Spotify API ───────────────────────────────────────────────────────
        async fetchPlaylistFromAPI(playlistId) {
            this.log('Fetching playlist from Spotify API...', 'info');
            const limit = 100;
            let offset = 0, allTracks = [], playlistMeta = null, total = 0, page = 1;

            while (true) {
                const response = await this.api.fetch(`${this.NEW_SPOTIFY_API_BASE}/${playlistId}?limit=${limit}&offset=${offset}`);
                if (!response.ok) throw new Error(`Failed to fetch playlist: ${response.status}`);
                const json = await response.json();
                if (!json.success || !json.data) throw new Error('Invalid API response');
                const data = json.data;

                if (!playlistMeta) {
                    playlistMeta = {
                        title:       data.name        || 'Spotify Import',
                        description: data.description || '',
                        image:       data.image        || null,
                        owner:       data.owner        || null
                    };
                    total = data.total || 0;
                }

                const pageTracks = data.tracks.map(t => ({
                    title:       t.name,
                    artist:      t.artists.join(', '),
                    album:       t.album,
                    duration_ms: t.duration_ms,
                    isrc:        null
                }));
                allTracks = allTracks.concat(pageTracks);
                this.log(`📄 Page ${page}: ${pageTracks.length} tracks (${allTracks.length}/${total})`, 'info');
                this.showPlaylistPreview({ ...playlistMeta, total, tracks: allTracks });

                if (!data.next || pageTracks.length === 0 || allTracks.length >= total) {
                    if (allTracks.length < total) {
                        this.log(`⚠️ Only fetched ${allTracks.length} of ${total} — API stopped early`, 'warn');
                    }
                    break;
                }
                offset += limit;
                page++;
            }
            this.log(`✅ Fetched ${allTracks.length} tracks`, 'success');
            return { ...playlistMeta, total, tracks: allTracks };
        },

        // ── Conversion core ───────────────────────────────────────────────────
        async startConversion() {
            const urlInput = document.getElementById('sc-url-input');
            const btn      = document.getElementById('sc-convert-btn');
            const stopBtn  = document.getElementById('sc-stop-btn');

            this._restartMbWorker();

            if (this._hasPendingReviews()) {
                this._cancelAllPendingReviews(false);
                this.log('⚠️ Previous pending reviews were cancelled by new conversion', 'warn');
            }

            this.failedTracks   = [];
            this.mbQueue        = [];
            this.foundTracks    = [];
            this.counters       = { processed: 0, successes: 0, fromLibrary: 0, notFound: 0 };
            this.existingTracks = null;
            this.trackCache     = new Map();
            this.candidateCache = new Map();
            this.updateExportButton();
            document.getElementById('sc-fail-summary').classList.remove('visible');

            document.getElementById('sc-review-list').innerHTML = `
                <div class="sc-review-empty" id="sc-review-empty">
                    <span class="sc-review-empty-icon">🎯</span>
                    <span>Low-confidence matches will<br>appear here during conversion</span>
                </div>`;
            this.updateReviewBadge();

            if (window.matchMedia('(max-width: 900px)').matches) {
                this._applyMobileTab('progress');
            }

            let playlistData = null;

            if (this.importedPlaylistData) {
                playlistData = this.importedPlaylistData;
                this.log(`📁 Using imported JSON: ${playlistData.tracks.length} tracks`, 'info');
            } else {
                const url = urlInput.value.trim();
                if (!url.includes('spotify.com/playlist/')) {
                    this.log('❌ Invalid Spotify playlist URL', 'error');
                    return;
                }
                const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
                if (!match) {
                    this.log('❌ Could not extract playlist ID', 'error');
                    return;
                }
                this.log('🔍 Fetching playlist...', 'info');
                try {
                    playlistData = await this.fetchPlaylistFromAPI(match[1]);
                    this.showPlaylistPreview(playlistData);
                } catch (err) {
                    this.log(`❌ ${err.message}`, 'error');
                    return;
                }
            }

            this.isConverting    = true;
            this.stopConversion  = false;
            this.abortController = new AbortController();
            btn.disabled     = true;
            stopBtn.disabled = false;
            urlInput.disabled = true;
            this.updateProgress(0);
            document.getElementById('sc-log').innerHTML = '';

            const settings = this.settings;
            this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
            this.log(`📝 ${playlistData.title}`, 'info');
            this.log(`🎵 ${playlistData.tracks.length} tracks`, 'info');
            this.log(`⚙️  Auto ≥${settings.autoApproveThreshold} | Review ${settings.mbRescoreThreshold}–${settings.autoApproveThreshold} | MB <${settings.mbRescoreThreshold} ${settings.mbRescueEnabled ? '✅' : '❌'}`, 'info');
            this.log(`🔁 Retries: ${settings.maxRetries} | Timeout: ${settings.requestTimeoutMs / 1000}s`, 'info');
            this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');

            try {
                this.existingTracks = await this.getTidalLibraryMap();
                this.log(`📚 ${this.existingTracks.size} existing Tidal tracks in library`, 'info');

                const audionPlaylistId = await this.api.library.createPlaylist(playlistData.title);
                this.log('✅ Playlist created', 'success');

                if (playlistData.image) {
                    try {
                        await this.api.library.updatePlaylistCover(audionPlaylistId, playlistData.image);
                        this.log('🖼️ Cover set', 'success');
                    } catch (e) {
                        this.log('⚠️ Could not set cover', 'warn');
                    }
                }

                this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
                this.log('🔎 Phase 1: Searching Tidal (3 workers)...', 'info');
                this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');

                const total      = playlistData.tracks.length;
                this.foundTracks = new Array(total).fill(null);
                const inFlight   = new Map();
                const queue      = playlistData.tracks.map((track, idx) => ({ track, idx }));

                const searchWorker = async () => {
                    while (queue.length > 0 && !this.stopConversion) {
                        const item = queue.shift();
                        if (!item) break;
                        const { track, idx } = item;
                        const key = `${this.normalizeString(track.title)}|${this.normalizeString(track.artist)}|${track.duration_ms}`;

                        let trackId = null, wasInLibrary = false;

                        const cached = this.trackCache.get(key);
                        if (cached) {
                            trackId = cached.trackId;
                            wasInLibrary = true;
                            this.counters.fromLibrary++;
                        } else if (inFlight.has(key)) {
                            try {
                                const result = await inFlight.get(key);
                                if (result?.trackId) {
                                    trackId      = result.trackId;
                                    wasInLibrary = !result.isNew;
                                    result.isNew ? this.counters.successes++ : this.counters.fromLibrary++;
                                } else {
                                    this.counters.notFound++;
                                    this.recordFailedTrack(track, 'NOT_FOUND', 'No match (original rejected or failed)');
                                    this.queueForMbLookup(track, idx);
                                }
                            } catch (err) {
                                if (err.name === 'AbortError') {
                                    this.foundTracks[idx] = { track, trackId: null, wasInLibrary: false, truncatedTitle: track.title };
                                    this.counters.processed++;
                                    this.updateProgress((this.counters.processed / total) * 50);
                                    break;
                                }
                                this.counters.notFound++;
                                this.recordFailedTrack(track, err.code || 'API_ERROR', err.message);
                            }
                        } else {
                            const searchPromise = (async () => {
                                await new Promise(r => setTimeout(r, 100 + Math.random() * 100));

                                let searchResult;
                                try {
                                    searchResult = await this.withRetry(
                                        (signal) => this.searchTidal(track, signal),
                                        this.abortController.signal,
                                        `${track.artist} — ${track.title}`
                                    );
                                } catch (err) { throw err; }

                                if (!searchResult) return null;

                                const candidateKey = `${this.normalizeString(track.title)}|${this.normalizeString(track.artist)}`;
                                this.candidateCache.set(candidateKey, { tidalCandidates: searchResult.allCandidates, mbIsrcs: [] });

                                const tidalId    = String(searchResult.track.id);
                                const inLib      = this.existingTracks.has(tidalId);
                                const resolvedId = inLib ? this.existingTracks.get(tidalId) : await this.addTrackToLibrary(searchResult.track);
                                if (!inLib) this.existingTracks.set(tidalId, resolvedId);

                                return { trackId: resolvedId, isNew: !inLib, score: searchResult.score, tidalTrack: searchResult.track };
                            })();

                            inFlight.set(key, searchPromise.then(r => r));

                            try {
                                const result = await searchPromise;
                                if (result) {
                                    const { score, tidalTrack, trackId: resolvedId, isNew } = result;
                                    const { autoApproveThreshold, mbRescoreThreshold } = this.settings;

                                    if (score >= autoApproveThreshold) {
                                        trackId      = resolvedId;
                                        wasInLibrary = !isNew;
                                        isNew ? this.counters.successes++ : this.counters.fromLibrary++;
                                        this.trackCache.set(key, { trackId: resolvedId });
                                        this.log(`✅ [${score}] ${track.artist} — ${track.title}`, 'success');

                                    } else if (score >= mbRescoreThreshold) {
                                        this.log(`🔍 [${score}] Review: ${track.artist} — ${track.title}`, 'warn');
                                        this.presentForReview(track, tidalTrack, score, idx).then(accepted => {
                                            if (accepted) {
                                                this.foundTracks[idx] = { track, trackId: resolvedId, wasInLibrary: !isNew, truncatedTitle: track.title };
                                                this.trackCache.set(key, { trackId: resolvedId });
                                                isNew ? this.counters.successes++ : this.counters.fromLibrary++;
                                                this.log(`✅ Review accepted: ${track.artist} — ${track.title}`, 'success');
                                            } else {
                                                this.log(`❌ Review rejected → MB: ${track.artist} — ${track.title}`, 'warn');
                                                this.counters.notFound++;
                                                this.recordFailedTrack(track, 'NOT_FOUND', 'Rejected in review');
                                                this.queueForMbLookup(track, idx);
                                            }
                                        });
                                        this.counters.processed++;
                                        if (this.counters.processed % 5 === 0 || this.counters.processed === total) {
                                            this.updateProgress((this.counters.processed / total) * 50);
                                            this.log(`📊 ${this.counters.processed}/${total} | ✅ ${this.counters.successes} | 📚 ${this.counters.fromLibrary} | ❌ ${this.counters.notFound}`, 'info');
                                        }
                                        inFlight.delete(key);
                                        continue;

                                    } else {
                                        this.log(`🔬 [${score}] Low conf → MB: ${track.artist} — ${track.title}`, 'warn');
                                        this.counters.notFound++;
                                        this.recordFailedTrack(track, 'NOT_FOUND', `Low confidence (score: ${score})`);
                                        this.queueForMbLookup(track, idx);
                                    }
                                } else {
                                    this.counters.notFound++;
                                    this.recordFailedTrack(track, 'NOT_FOUND', 'No match on Tidal');
                                    this.log(`❌ Not found → MB: ${track.artist} — ${track.title}`, 'error');
                                    this.queueForMbLookup(track, idx);
                                }
                            } catch (err) {
                                if (err.name === 'AbortError') {
                                    this.foundTracks[idx] = { track, trackId: null, wasInLibrary: false, truncatedTitle: track.title };
                                    this.counters.processed++;
                                    this.updateProgress((this.counters.processed / total) * 50);
                                    inFlight.delete(key);
                                    break;
                                }
                                this.counters.notFound++;
                                const code = err.code || 'API_ERROR';
                                this.recordFailedTrack(track, code, err.message);
                                if (code === 'RATE_LIMIT') this.log(`⏱ Rate limited (retries exhausted): ${track.artist} — ${track.title}`, 'warn');
                                else this.log(`⚡ API error (retries exhausted): ${track.artist} — ${track.title}`, 'warn');
                            } finally {
                                inFlight.delete(key);
                            }
                        }

                        if (trackId !== null) {
                            this.foundTracks[idx] = { track, trackId, wasInLibrary, truncatedTitle: track.title };
                        }

                        this.counters.processed++;
                        if (this.counters.processed % 5 === 0 || this.counters.processed === total) {
                            this.updateProgress((this.counters.processed / total) * 50);
                            this.log(`📊 ${this.counters.processed}/${total} | ✅ ${this.counters.successes} | 📚 ${this.counters.fromLibrary} | ❌ ${this.counters.notFound}`, 'info');
                        }
                    }
                };

                const workers = [];
                for (let i = 0; i < 3; i++) workers.push(searchWorker());
                await Promise.all(workers);

                this.foundTracks.forEach((entry, idx) => {
                    if (entry === null && !this.pendingReviews.has(idx)) {
                        const track = playlistData.tracks[idx];
                        this.recordFailedTrack(track, 'STOPPED', 'Stopped before search');
                        this.foundTracks[idx] = { track, trackId: null, wasInLibrary: false, truncatedTitle: track.title };
                    }
                });

                if (this.mbWorkerRunning || this.mbQueue.length > 0 || this._hasPendingReviews()) {
                    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
                    this.log('⏳ Waiting for MB rescue & pending reviews...', 'info');
                    await new Promise(resolve => {
                        const check = setInterval(() => {
                            if (!this.mbWorkerRunning && this.mbQueue.length === 0 && !this._hasPendingReviews()) {
                                clearInterval(check);
                                resolve();
                            }
                        }, 500);
                    });
                }

                this.foundTracks.forEach((entry, idx) => {
                    if (entry === null) {
                        const track = playlistData.tracks[idx];
                        this.foundTracks[idx] = { track, trackId: null, wasInLibrary: false, truncatedTitle: track.title };
                    }
                });

                if (this.stopConversion) {
                    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
                    this.log('⚠️ Stopped by user — partial results saved', 'warn');
                } else {
                    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
                    this.log('📋 Phase 2: Adding tracks to playlist in order...', 'info');

                    let addedCount = 0;
                    for (let i = 0; i < this.foundTracks.length; i++) {
                        if (this.stopConversion) break;
                        const entry = this.foundTracks[i];
                        if (!entry?.trackId) continue;
                        try {
                            await new Promise(r => setTimeout(r, 50));
                            await this.api.library.addTrackToPlaylist(audionPlaylistId, entry.trackId);
                            addedCount++;
                        } catch (err) {
                            this.log(`❌ Failed to add: ${entry.truncatedTitle}`, 'error');
                        }
                        this.updateProgress(50 + ((i + 1) / this.foundTracks.length) * 50);
                    }

                    this.updateProgress(100);
                    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
                    this.log('🎉 CONVERSION COMPLETE!', 'success');
                    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
                    this.log(`🎵 Total:             ${total}`, 'info');
                    this.log(`✅ Newly added:       ${this.counters.successes}`, 'success');
                    this.log(`📚 From library:      ${this.counters.fromLibrary}`, 'warn');
                    this.log(`📋 Added to playlist: ${addedCount}`, 'info');
                    this.log(`❌ Not found:         ${this.counters.notFound}`, this.counters.notFound > 0 ? 'error' : 'info');
                    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
                    if (this.failedTracks.length > 0) {
                        this.log(`📄 ${this.failedTracks.length} failed — use Export to download list`, 'warn');
                    } else {
                        this.log('🏆 All tracks found!', 'success');
                    }
                    if (this.api.library.refresh) this.api.library.refresh();
                }

            } catch (err) {
                console.error(err);
                this.log(`❌ Unexpected error: ${err.message}`, 'error');
            } finally {
                this.isConverting    = false;
                this.abortController = null;
                document.getElementById('sc-convert-btn').disabled = false;
                document.getElementById('sc-stop-btn').disabled    = true;
                if (!this.importedPlaylistData) urlInput.disabled = false;
                this.updateFailSummary();
            }
        },

        stopConversionProcess() {
            this.stopConversion = true;
            if (this.abortController)   this.abortController.abort();
            if (this.mbAbortController) this.mbAbortController.abort();
            document.getElementById('sc-stop-btn').disabled = true;
            this.log('⏹ Stop requested — finishing current track...', 'warn');
        }
    };

    if (typeof Audion !== 'undefined' && Audion.register) {
        Audion.register(SpotifyConverter);
    } else {
        window.SpotifyConverter = SpotifyConverter;
        window.AudionPlugin     = SpotifyConverter;
    }

})();