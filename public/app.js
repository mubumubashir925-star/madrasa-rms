        // ================= STATE + API LAYER =================
        // The server fills in <meta name="tenant"> and <meta name="route"> for every address:
        //   /            -> landing page (or the "main address" institution)   /<name>        -> that institution's public portal
        //   /<name>/admin -> its admin login                                   /super         -> platform owner console
        const META = n => (document.querySelector(`meta[name="${n}"]`) || {}).content || '';
        const QS = new URLSearchParams(location.search), PATH_SEG = location.pathname.split('/').filter(Boolean);
        let TENANT = META('tenant'), ROUTE = META('route');
        if (!ROUTE) { // opened without the server (plain file / test): work it out from the address
            if (PATH_SEG[0] === 'super' || QS.get('view') === 'super') ROUTE = 'super';
            else if (PATH_SEG[0] && PATH_SEG[0] !== 'admin') { TENANT = PATH_SEG[0]; ROUTE = PATH_SEG[1] === 'admin' ? 'admin' : 'public'; }
            else { TENANT = QS.get('t') || ''; ROUTE = TENANT ? (QS.get('view') === 'admin' ? 'admin' : 'public') : 'landing'; }
        }
        const IS_ADMIN_ROUTE = ROUTE === 'admin';
        // ---- institution accent colour: every "emerald" colour in the app is driven by CSS variables ----
        const EM_DEFAULT = { 50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 850: '#064e3b', 900: '#064e3b', 950: '#022c22' };
        let ACC = { ...EM_DEFAULT };
        const accHex = n => ACC[n];
        function hexToHsl(hex) {
            const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
            let h = 0; const l = (mx + mn) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
            if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
            return [h, s * 100, l * 100];
        }
        function hslToHex(h, s, l) {
            s /= 100; l /= 100; const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2; let r = 0, g = 0, b = 0;
            if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
            return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
        }
        function buildAccentPalette(hex) {
            if (!/^#[0-9a-f]{6}$/i.test(hex || '') || hex.toLowerCase() === '#065f46') return { ...EM_DEFAULT };
            let [h, s, l] = hexToHsl(hex); l = Math.min(l, 40); // very light colours are darkened so white text stays readable
            const up = k => l + (97 - l) * k, hsl = (sat, light) => hslToHex(h, Math.max(0, Math.min(100, sat)), Math.max(2, Math.min(98, light)));
            return { 50: hsl(s * .8, up(.965)), 100: hsl(s * .85, up(.93)), 200: hsl(s * .9, up(.85)), 300: hsl(s, up(.72)), 400: hsl(s, up(.55)), 500: hsl(s, up(.38)), 600: hsl(s, up(.22)), 700: hsl(s, up(.1)), 800: hsl(s, l), 850: hsl(s, l * .9), 900: hsl(s, l * .8), 950: hsl(s, l * .52) };
        }
        function applyAccent(hex) {
            ACC = buildAccentPalette(hex); const root = document.documentElement.style;
            Object.entries(ACC).forEach(([n, v]) => { const x = parseInt(v.slice(1), 16); root.setProperty('--em-' + n, `${x >> 16 & 255} ${x >> 8 & 255} ${x & 255}`); });
            const tc = document.querySelector('meta[name="theme-color"]'); if (tc) tc.content = ACC[900];
            try { if (TENANT) localStorage.setItem('acc_' + TENANT, hex || ''); } catch (e) { }
        }
        try { const a0 = TENANT && localStorage.getItem('acc_' + TENANT); if (a0) applyAccent(a0); } catch (e) { } // no colour flash on repeat visits
        const ROOT_MODE = !!TENANT && PATH_SEG[0] !== TENANT;          // the main-address institution lives at "/" and "/admin"
        const pubPath = () => (ROOT_MODE ? '/' : '/' + TENANT);
        const adminPath = () => (ROOT_MODE ? '/admin' : '/' + TENANT + '/admin');
        const TOKEN_KEY = ROUTE === 'super' ? 'rms_super_token' : 'rms_token_' + (TENANT || 'main');
        const API_T = '/t/' + TENANT;
        let isAdminAuthenticated = false;
        let token = localStorage.getItem(TOKEN_KEY) || '';
        let appState = emptyState();
        let snapshot = null;
        let syncChain = Promise.resolve();
        const TABLES = ['exams', 'classes', 'subjects', 'students', 'results'];

        function emptyState() {
            return { madrasa: { name: 'Institution', subtitle: '', logo: '', headTitle: 'Principal', headName: '' }, announcements: [],
                portal: { enabled: false, message: '', showPosition: true },
                grades: { scale: [{ min: 85, grade: 'A+', title: 'Outstanding' }, { min: 70, grade: 'A', title: 'Very Good' }, { min: 55, grade: 'B', title: 'Good' }, { min: 0, grade: 'C', title: 'Satisfactory' }], fail: { grade: 'F', title: 'Fail' } },
                fields: [{ id: 'admissionNo', label: 'Admission No', show: true }, { id: 'fatherName', label: 'Father / Guardian', show: true }], classSigns: {}, teachers: [], assistants: [], exams: [], classes: [], subjects: [], students: [], results: [] };
        }
        const clone = o => JSON.parse(JSON.stringify(o));
        const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

        // slim progress bar at the top of the screen whenever the app is talking to the server
        let netPending = 0, netTimer = 0;
        function netStart() { netPending++; if (!netTimer) netTimer = setTimeout(() => { if (netPending > 0) document.getElementById('net-bar').classList.add('on'); }, 250); }
        function netEnd() { netPending = Math.max(0, netPending - 1); if (!netPending) { clearTimeout(netTimer); netTimer = 0; const b = document.getElementById('net-bar'); if (b) b.classList.remove('on'); } }
        function showAppLoader(text) { const l = document.getElementById('app-loader'); document.getElementById('app-loader-text').textContent = text || 'Loading...'; l.classList.remove('hide'); }
        function hideAppLoader() { const l = document.getElementById('app-loader'); if (l) l.classList.add('hide'); }
        async function api(path, opts) { netStart(); try { return await apiRaw(path, opts); } finally { netEnd(); } }
        async function apiRaw(path, opts = {}) {
            const res = await fetch('/api' + path, {
                method: opts.method || 'GET',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
                body: opts.body ? JSON.stringify(opts.body) : undefined,
                keepalive: !!opts.keepalive
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { if (data.blocked) showBlocked(data.error); const err = new Error(data.error || 'Request failed'); err.status = res.status; throw err; }
            return data;
        }

        // The server puts a revision number into every page. Same number as the saved copy = nothing changed = no data request.
        const PUB = { rev: '', checkedAt: 0 };
        async function fetchPublicInfo(pre) {
            let info = pre || null; if (!info) info = await api(API_T + '/public');
            if (info.unavailable) { try { localStorage.removeItem('pi_' + TENANT); } catch (e) { } showBlocked(info.portal && info.portal.message, info.madrasa && info.madrasa.name); return false; }
            appState = { ...emptyState(), ...info }; applyAccent((info.madrasa || {}).accent || ''); renderPublicPortal();
            PUB.rev = String(info.rev ?? PUB.rev); try { localStorage.setItem('pi_' + TENANT, JSON.stringify(info)); } catch (e) { }
            return true;
        }
        async function loadPublicData() {
            PUB.rev = META('rev'); PUB.checkedAt = Date.now();
            let c = null; try { c = JSON.parse(localStorage.getItem('pi_' + TENANT) || 'null'); } catch (e) { }
            if (c && c.madrasa && c.rev != null && String(c.rev) === PUB.rev && !META('blocked')) { // saved copy is current
                appState = { ...emptyState(), ...c }; applyAccent((c.madrasa || {}).accent || ''); renderPublicPortal(); hideAppLoader(); return;
            }
            try { const pre = window.__pi ? await window.__pi : null; window.__pi = null; await fetchPublicInfo(pre); }
            catch (e) {
                if (c && c.madrasa) { appState = { ...emptyState(), ...c }; renderPublicPortal(); showToast('You are offline. Showing the last saved information.', 'info'); }
                else if (e.status === 404) showLanding(true); else showToast('Could not load data. Check your connection.', 'error');
            }
        }
        // a page left open for a while asks the server (1 tiny read) whether anything changed, before trusting a saved result
        async function freshRev() {
            if (Date.now() - PUB.checkedAt < 120000) return PUB.rev;
            try {
                const r = await api(API_T + '/rev'); PUB.checkedAt = Date.now();
                if (String(r.rev) !== PUB.rev) { PUB.rev = String(r.rev); await fetchPublicInfo(); }
            } catch (e) { }
            return PUB.rev;
        }
        // ---- results saved on this device (until the server revision changes) ----
        const RES_PREFIX = () => 'res_' + TENANT + '_';
        function savedResultKeys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(RES_PREFIX())) out.push(k); } } catch (e) { } return out; }
        function updateSavedNote() { const el = document.getElementById('saved-results-note'); if (el) el.classList.toggle('hidden', !savedResultKeys().length); }
        function clearSavedResults() { savedResultKeys().forEach(k => { try { localStorage.removeItem(k); } catch (e) { } }); updateSavedNote(); showToast('Saved results cleared from this device.', 'info'); }
        function storeResult(key, entry) {
            const put = () => localStorage.setItem(key, JSON.stringify(entry));
            try {
                const keys = savedResultKeys().map(k => { try { return [k, JSON.parse(localStorage.getItem(k)).t || 0]; } catch (e) { return [k, 0]; } }).sort((a, b) => a[1] - b[1]);
                while (keys.length > 14) localStorage.removeItem(keys.shift()[0]);
                put();
            } catch (e) { try { savedResultKeys().forEach(k => localStorage.removeItem(k)); put(); } catch (x) { } }
            updateSavedNote();
        }

        // ---- admin copy on this device: opening the panel costs one tiny check; data is downloaded only when something changed ----
        const ADM = { arev: -1, stale: false, timer: 0 };
        function idbOpen() { return new Promise((res, rej) => { const r = indexedDB.open('rp_cache', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
        async function idbGet(k) { try { const db = await idbOpen(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (e) { return undefined; } }
        async function idbSet(k, v) { try { const db = await idbOpen(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) { } }
        async function idbDel(k) { try { const db = await idbOpen(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) { } }
        const admKey = () => 'admin:' + TENANT;
        function cacheAdmin() { clearTimeout(ADM.timer); ADM.timer = setTimeout(() => { if (ADM.arev >= 0 && snapshot) idbSet(admKey(), { arev: ADM.arev, state: snapshot }); }, 2500); }
        function trackRev(resp) { if (!resp || resp.arev == null) return; if (resp.arev === ADM.arev + 1) ADM.arev = resp.arev; else { ADM.arev = resp.arev; ADM.stale = true; } } // someone else saved in between: the stored copy is no longer trustworthy
        function adminCacheAfterSave() { if (ADM.stale) { ADM.stale = false; ADM.arev = -1; idbDel(admKey()); } else cacheAdmin(); }
        async function loadAdminState() {
            const cached = await idbGet(admKey()), usable = cached && cached.state && cached.arev >= 0;
            const r = await api('/admin/state' + (usable ? '?arev=' + cached.arev : ''));
            if (r.unchanged) { appState = { ...emptyState(), ...clone(cached.state), institution: r.institution }; }
            else appState = { ...emptyState(), ...r };
            ADM.arev = appState.arev ?? r.arev ?? -1; ADM.stale = false;
            applyAccent((appState.madrasa || {}).accent || '');
            snapshot = clone(appState);
            if (!r.unchanged) cacheAdmin();
            renderPublicPortal();
            renderAllAdminData();
            renderPlanBanner();
        }

        const rowKey = (t, r) => t === 'results' ? r.examId + '|' + r.studentId : r.id;

        // Compares current state with last synced snapshot; sends only what changed
        function computeDiff() {
            const upserts = {}, deletes = {};
            for (const t of TABLES) {
                const old = new Map(snapshot[t].map(r => [rowKey(t, r), JSON.stringify(r)]));
                const seen = new Set();
                for (const r of appState[t]) {
                    const k = rowKey(t, r); seen.add(k);
                    if (old.get(k) !== JSON.stringify(r)) (upserts[t] ||= []).push(r);
                }
                for (const k of old.keys()) if (!seen.has(k)) (deletes[t] ||= []).push(k);
            }
            const st = {};
            for (const k of ['madrasa', 'announcements', 'portal', 'grades', 'fields', 'classSigns', 'teachers', 'assistants']) if (JSON.stringify(appState[k]) !== JSON.stringify(snapshot[k])) st[k] = k === 'classSigns' ? Object.fromEntries(Object.entries(appState[k] || {}).filter(([id]) => appState.classes.some(c => c.id === id))) : appState[k];
            if (Object.keys(st).length) upserts.settings = st;
            return (Object.keys(upserts).length || Object.keys(deletes).length) ? { upserts, deletes } : null;
        }

        // Saving: changes go to the server in the background. A failed save is never thrown away - it stays on screen and is retried.
        const SAVE = { busy: false, queued: false, again: false, fails: 0, timer: 0, err: '' };
        function saveChip(kind, text) {
            const el = document.getElementById('save-chip'); if (!el) return;
            el.className = 'save-chip show ' + (kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '');
            el.innerHTML = kind === 'busy' ? '<span class="btn-spin" style="margin:0"></span> ' + esc(text || 'Saving...') : kind === 'ok' ? '<i class="fas fa-check"></i> ' + esc(text || 'Saved') : '<i class="fas fa-triangle-exclamation"></i> ' + esc(text) + ' &mdash; tap to retry';
        }
        function saveState() {
            renderPublicPortal();
            if (!isAdminAuthenticated || !snapshot) return;
            SAVE.fails = 0; SAVE.err = ''; queueSave(250);
        }
        function queueSave(delay) { SAVE.queued = true; clearTimeout(SAVE.timer); SAVE.timer = setTimeout(flushSave, delay); saveChip('busy'); }
        function splitDiff(diff) { // tables and settings travel separately, so one rejected item (e.g. a too-large logo) can't block the marks
            const { settings, ...tables } = diff.upserts, parts = [];
            if (Object.keys(tables).length || Object.keys(diff.deletes).length) parts.push({ body: { upserts: tables, deletes: diff.deletes }, commit: sent => TABLES.forEach(t => { snapshot[t] = clone(sent[t]); }) });
            if (settings) parts.push({ body: { upserts: { settings }, deletes: {} }, commit: sent => Object.keys(settings).forEach(k => { snapshot[k] = clone(sent[k]); }) });
            return parts;
        }
        async function flushSave() {
            SAVE.queued = false;
            if (!isAdminAuthenticated || !snapshot) return;
            if (SAVE.busy) { SAVE.again = true; return; }
            const diff = computeDiff(); if (!diff) { saveDone(); return; }
            SAVE.busy = true; saveChip('busy');
            const sent = clone(appState); let failed = null;
            for (const part of splitDiff(diff)) {
                try { const resp = await api('/admin/sync', { method: 'POST', body: part.body, keepalive: JSON.stringify(part.body).length < 60000 }); part.commit(sent); trackRev(resp); }
                catch (err) { if (err.status === 401) { SAVE.busy = false; return handleSessionExpired(); } failed = failed || err; }
            }
            SAVE.busy = false;
            if (failed) {
                if ((!failed.status || failed.status >= 500) && SAVE.fails < 5) { SAVE.fails++; queueSave([2000, 4000, 8000, 15000, 30000][SAVE.fails - 1]); return; }
                SAVE.err = failed.message || 'Could not save'; saveChip('err', SAVE.err); showToast(SAVE.err, 'error'); return;
            }
            if (SAVE.again || computeDiff()) { SAVE.again = false; queueSave(100); return; }
            saveDone();
        }
        function saveDone() { adminCacheAfterSave(); SAVE.err = ''; SAVE.fails = 0; saveChip('ok', 'Saved'); setTimeout(() => { const el = document.getElementById('save-chip'); if (el && !SAVE.busy && !SAVE.queued && !SAVE.err) el.classList.remove('show'); }, 1400); }
        function saveChipTap() { if (SAVE.err || SAVE.fails) { SAVE.fails = 0; SAVE.err = ''; saveChip('busy'); flushSave(); } }
        window.addEventListener('beforeunload', e => { if (SAVE.busy || SAVE.queued || SAVE.err) { e.preventDefault(); e.returnValue = ''; } });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && SAVE.queued) { clearTimeout(SAVE.timer); flushSave(); } });
        window.addEventListener('online', () => { if (SAVE.err || SAVE.fails) saveChipTap(); });

        function handleSessionExpired() {
            token = ''; localStorage.removeItem(TOKEN_KEY); idbDel(admKey()); ADM.arev = -1;
            isAdminAuthenticated = false; snapshot = null;
            switchView('admin');
            showToast('Session expired. Please log in again.', 'error');
        }

        function toggleSidebar() {
            document.getElementById('admin-sidebar').classList.toggle('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.toggle('hidden');
            document.body.classList.toggle('overflow-hidden', !document.getElementById('admin-sidebar').classList.contains('-translate-x-full'));
        }
        function closeSidebar() {
            document.getElementById('admin-sidebar').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
            document.body.classList.remove('overflow-hidden');
        }

        // ================= UI UTILITIES =================
        function showToast(message, type = 'success') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            const colors = {
                success: 'bg-emerald-900 text-white border-emerald-600',
                error: 'bg-red-900 text-white border-red-600',
                info: 'bg-slate-800 text-white border-amber-400'
            };
            const icons = {
                success: 'fa-check-circle text-amber-400',
                error: 'fa-exclamation-circle text-red-300',
                info: 'fa-info-circle text-amber-400'
            };
            toast.className = `pointer-events-auto ${colors[type]} border-l-4 px-4 py-3 rounded-lg shadow-xl flex items-center gap-3 text-sm font-medium transition-all duration-300`;
            toast.innerHTML = `<i class="fas ${icons[type]} text-base"></i> <span>${esc(message)}</span>`;
            toast.style.opacity = '0'; toast.style.transform = 'translateY(14px)';
            container.appendChild(toast);
            while (container.children.length > 3) container.firstChild.remove();
            requestAnimationFrame(() => requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; }));
            setTimeout(() => {
                toast.style.opacity = '0'; toast.style.transform = 'translateY(14px)';
                setTimeout(() => toast.remove(), 300);
            }, 3500);
        }

        function switchView(view) {
            if (view === 'public') { location.href = pubPath(); return; }
            if (!IS_ADMIN_ROUTE) return; // public visitors can never reach the admin screens
            document.getElementById('public-view').classList.add('hidden');
            document.getElementById('admin-view').classList.remove('hidden');
            const on = isAdminAuthenticated;
            document.getElementById('admin-login-screen').classList.toggle('hidden', on);
            document.getElementById('admin-dashboard').classList.toggle('hidden', !on);
            if (on) renderAllAdminData();
        }

        // ================= PUBLIC PORTAL LOGIC =================
        function renderPublicPortal() {
            // Header Info
            document.getElementById('public-madrasa-name').textContent = appState.madrasa.name;
            document.getElementById('public-madrasa-subtitle').textContent = appState.madrasa.subtitle;
            document.getElementById('footer-madrasa-name').textContent = appState.madrasa.name;
            if (!IS_ADMIN_ROUTE) document.title = appState.madrasa.name;
            document.getElementById('footer-year').textContent = new Date().getFullYear();

            const logoContainer = document.getElementById('public-logo-container');
            logoContainer.innerHTML = `<i class="fas fa-school text-emerald-800"></i>`;
            const logoUrl = (appState.madrasa.logo || '').trim();
            if (/^(https?:\/\/|data:image\/|\/(?!\/))/i.test(logoUrl)) {
                const img = new Image();
                img.alt = 'Logo'; img.className = 'w-full h-full object-cover';
                img.onload = () => { logoContainer.innerHTML = ''; logoContainer.appendChild(img); };
                img.src = logoUrl;
            }

            // Announcements Bar
            const annBar = document.getElementById('announcement-bar');
            const annContainer = document.getElementById('public-announcements');
            if (appState.announcements.length === 0) {
                annBar.classList.add('hidden');
            } else {
                annBar.classList.remove('hidden');
                annContainer.innerHTML = appState.announcements
                    .map(a => `<span class="mx-8"><i class="fas fa-star text-xs text-emerald-900 mr-1.5"></i> ${esc(a)}</span>`)
                    .join('');
            }

            // Public Exams Dropdown
            const examSelect = document.getElementById('search-exam-select');
            const currentVal = examSelect.value;
            const publicExams = appState.exams.filter(e => e.isPublic);
            
            if (publicExams.length === 0) {
                examSelect.innerHTML = `<option value="">No Public Exams Available</option>`;
            } else {
                examSelect.innerHTML = publicExams.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
                if (publicExams.some(e => e.id === currentVal)) {
                    examSelect.value = currentVal;
                }
            }

            const open = !!appState.portal.enabled;
            document.getElementById('search-card').classList.toggle('hidden', !open);
            document.getElementById('portal-closed').classList.toggle('hidden', open);
            document.getElementById('portal-closed-msg').textContent = appState.portal.message || 'Results are not published yet. Please check back soon.';
            if (!open) document.getElementById('result-display-container').classList.add('hidden');
            document.getElementById('search-adm-label').textContent = admLabel();
        }

        async function handleResultSearch(e) {
            e.preventDefault();
            const examId = document.getElementById('search-exam-select').value;
            const adm = document.getElementById('search-adm-input').value.trim().toUpperCase();
            if (!examId) { showToast("Please select an active examination.", "error"); return; }
            const btn = e.target.querySelector('button[type=submit]'), btnHtml = btn.innerHTML;
            btn.disabled = true; btn.classList.add('opacity-60'); btn.innerHTML = '<span class="btn-spin"></span>Loading result...';
            try {
                const rkey = RES_PREFIX() + examId + '_' + adm, rev = await freshRev();
                let hit = null; try { hit = JSON.parse(localStorage.getItem(rkey) || 'null'); } catch (e) { }
                if (hit && hit.data && String(hit.rev) === rev && Date.now() - (hit.t || 0) < 30 * 864e5) { displayMarksheet(hit.data); return; } // saved on this device and nothing changed since
                const data = await api(`${API_T}/result?exam=${encodeURIComponent(examId)}&adm=${encodeURIComponent(adm)}`);
                if (data && data.rev != null) storeResult(rkey, { rev: String(data.rev), t: Date.now(), data });
                displayMarksheet(data);
            } catch (err) {
                document.getElementById('result-display-container').classList.add('hidden');
                showToast(err.message, err.status === 404 ? 'info' : 'error');
            } finally { btn.disabled = false; btn.classList.remove('opacity-60'); btn.innerHTML = btnHtml; }
        }

        // ================= CARD LISTS (tap a card to expand: details, edit, delete) =================
        const openCards = new Set(), listLimit = {}, PAGE = 40;
        const RENDER = { tenants: () => renderTenants(), exams: () => renderAdminExams(), classes: () => renderAdminClasses(), subjects: () => renderAdminSubjects(), students: () => renderAdminStudents() };
        function resetLimit(n) { listLimit[n] = PAGE; RENDER[n](); }
        function showMore(n) { listLimit[n] = (listLimit[n] || PAGE) + PAGE; RENDER[n](); }
        const moreBtn = (n, rest) => rest > 0 ? `<button type="button" class="more-btn" onclick="showMore('${n}')">Show more (${rest} more)</button>` : '';
        const emptyMsg = t => `<p class="text-center text-slate-400 text-xs py-6">${t}</p>`;
        function cardHTML(key, title, sub, details, actions) {
            return `<div class="acard${openCards.has(key) ? ' open' : ''}" data-key="${esc(key)}">
                <button type="button" class="acard-head" onclick="toggleCard(this)"><div class="min-w-0"><div class="acard-title">${esc(title)}</div><div class="acard-sub">${sub}</div></div>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg></button>
                <div class="acard-body">${details.map(([l, v]) => `<div class="acard-row"><span>${esc(l)}</span><b>${v}</b></div>`).join('')}
                    <div class="acard-actions">${actions.map(a => `<button type="button" onclick="${a.on}" class="abtn ${a.cls}"><i class="fas ${a.icon}"></i> ${a.label}</button>`).join('')}</div></div></div>`;
        }
        function toggleCard(btn) {
            const card = btn.closest('.acard'), opening = !card.classList.contains('open');
            card.parentElement.querySelectorAll('.acard.open').forEach(c => { c.classList.remove('open'); openCards.delete(c.dataset.key); });
            if (opening) { card.classList.add('open'); openCards.add(card.dataset.key); }
        }
        const qOf = id => (document.getElementById(id)?.value || '').toLowerCase().trim();

        function renderAdminExams() {
            const q = qOf('exam-search'), el = document.getElementById('admin-exams-list'), lim = listLimit.exams || PAGE;
            const list = appState.exams.filter(e => !q || e.name.toLowerCase().includes(q));
            if (!list.length) { el.innerHTML = emptyMsg(appState.exams.length ? 'No exam matches your search.' : 'No exams yet. Tap the + button to add one.'); return; }
            el.innerHTML = list.slice(0, lim).map(ex => {
                const n = appState.results.filter(r => r.examId === ex.id).length;
                return cardHTML('exam:' + ex.id, ex.name, ex.isPublic ? '<span class="text-emerald-600 font-semibold">&#9679; Public</span>' : '<span>&#9675; Hidden (draft)</span>',
                    [['Results entered', n + ' students'], ['Visibility', ex.isPublic ? 'Visible on public portal' : 'Hidden']],
                    [{ on: `editExam('${ex.id}')`, cls: 'abtn-edit', icon: 'fa-pen', label: 'Edit' }, { on: `toggleExamVisibility('${ex.id}')`, cls: 'abtn-ok', icon: 'fa-eye', label: ex.isPublic ? 'Hide' : 'Publish' }, { on: `deleteExam('${ex.id}')`, cls: 'abtn-del', icon: 'fa-trash', label: 'Delete' }]);
            }).join('') + moreBtn('exams', list.length - lim);
        }
        function renderAdminClasses() {
            const q = qOf('class-search'), el = document.getElementById('admin-classes-list'), lim = listLimit.classes || PAGE;
            const list = appState.classes.filter(c => !q || (c.name + ' ' + (c.teacherName || '') + ' ' + (c.teacherTitle || '')).toLowerCase().includes(q));
            if (!list.length) { el.innerHTML = emptyMsg(appState.classes.length ? 'No class matches your search.' : 'No classes yet. Tap the + button to add one.'); return; }
            el.innerHTML = list.slice(0, lim).map(c => {
                const sc = appState.subjects.filter(x => x.classId === c.id).length, nst = appState.students.filter(x => x.classId === c.id).length;
                const teacher = [c.teacherName, c.teacherTitle ? '(' + c.teacherTitle + ')' : ''].filter(Boolean).join(' ');
                return cardHTML('class:' + c.id, c.name, `${sc} subjects &bull; ${nst} students`,
                    [['Class teacher', esc(teacher || '-')], ['Working days', c.totalWorkingDays], ['Subjects', sc], ['Students', nst]],
                    [{ on: `gotoSubjects('${c.id}')`, cls: 'abtn-ok', icon: 'fa-book', label: 'Subjects' }, { on: `gotoStudents('${c.id}')`, cls: 'abtn-ok', icon: 'fa-users', label: 'Students' },
                     { on: `editClass('${c.id}')`, cls: 'abtn-edit', icon: 'fa-pen', label: 'Edit' }, { on: `deleteClass('${c.id}')`, cls: 'abtn-del', icon: 'fa-trash', label: 'Delete' }]);
            }).join('') + moreBtn('classes', list.length - lim);
        }
        function renderAdminSubjects() {
            const fc = document.getElementById('subject-filter-class').value || 'ALL', q = qOf('subject-search'), el = document.getElementById('admin-subjects-list'), lim = listLimit.subjects || PAGE;
            const list = appState.subjects.filter(x => (fc === 'ALL' || x.classId === fc) && (!q || x.name.toLowerCase().includes(q)));
            if (!list.length) { el.innerHTML = emptyMsg(appState.subjects.length ? 'No subject found for this class / search.' : 'No subjects yet. Tap the + button to add one.'); return; }
            el.innerHTML = list.slice(0, lim).map(x => {
                const c = appState.classes.find(k => k.id === x.classId);
                return cardHTML('subject:' + x.id, x.name, `${esc(c ? c.name : 'Unknown class')} &bull; Max ${x.maxMarks} &bull; Pass ${x.passingMarks}${isActive(x) ? '' : ' &bull; <span class="text-amber-600 font-semibold">Skipped</span>'}`,
                    [['Class', esc(c ? c.name : 'Unknown')], ['Maximum marks', x.maxMarks], ['Passing marks', x.passingMarks]],
                    [{ on: `toggleClassSubject('${x.id}', ${!isActive(x)})`, cls: 'abtn-ok', icon: 'fa-eye', label: isActive(x) ? 'Skip' : 'Include' }, { on: `editSubject('${x.id}')`, cls: 'abtn-edit', icon: 'fa-pen', label: 'Edit' }, { on: `deleteSubject('${x.id}')`, cls: 'abtn-del', icon: 'fa-trash', label: 'Delete' }]);
            }).join('') + moreBtn('subjects', list.length - lim);
        }
        // ================= GENDER (kept inside each student's extra data as "gender": "M" or "F"; nothing to migrate) =================
        const GENDER_WORDS = { m: 'M', male: 'M', boy: 'M', b: 'M', 'ആൺ': 'M', 'ആണ്\u200d': 'M', 'ആൺകുട്ടി': 'M', 'ذكر': 'M', 'ولد': 'M', 'لڑکا': 'M', f: 'F', female: 'F', girl: 'F', g: 'F', 'പെൺ': 'F', 'പെണ്\u200d': 'F', 'പെൺകുട്ടി': 'F', 'أنثى': 'F', 'بنت': 'F', 'لڑکی': 'F' };
        const normGender = v => GENDER_WORDS[String(v || '').trim().toLowerCase()] || '';
        const genderOf = st => normGender((st.extra || {}).gender);
        const genderName = g => g === 'M' ? 'Boy' : g === 'F' ? 'Girl' : '';
        const genderBadge = st => { const g = genderOf(st); return g ? `<span class="font-semibold ${g === 'M' ? 'text-sky-700' : 'text-pink-700'}">${genderName(g)}</span>` : '<span class="text-slate-400">Not set</span>'; };
        const genderMatch = (st, f) => f === 'ALL' || (f === 'U' ? !genderOf(st) : genderOf(st) === f);
        const genderCounts = list => { let M = 0, F = 0, U = 0; list.forEach(s => { const g = genderOf(s); if (g === 'M') M++; else if (g === 'F') F++; else U++; }); return { all: list.length, M, F, U }; };
        const GF = { students: 'ALL', ov: 'ALL', rep: 'ALL', bulk: 'ALL' }, GF_LABEL = { ALL: 'All', M: 'Boys', F: 'Girls', U: 'Students without gender' };
        const GF_RENDER = { students: () => resetLimit('students'), ov: () => renderInstOverview(), rep: () => renderClassReport(), bulk: () => updateBulkInfo() };
        function genderChips(key, c) {
            const chip = (v, label, n) => `<button type="button" onclick="setGF('${key}', '${v}')" class="gchip ${GF[key] === v ? 'on' : ''}">${label} <b>${n}</b></button>`;
            return chip('ALL', 'All', c.all) + chip('M', 'Boys', c.M) + chip('F', 'Girls', c.F) + (c.U && (c.M || c.F) ? chip('U', 'Not set', c.U) : '');
        }
        function setGF(key, v) { GF[key] = v; GF_RENDER[key](); }
        function genderToggleHTML(id, value) { return `<div id="${id}" class="gt" data-value="${value || ''}"><button type="button" data-g="M" class="${value === 'M' ? 'on-m' : ''}" onclick="gtTap(this)">Boy</button><button type="button" data-g="F" class="${value === 'F' ? 'on-f' : ''}" onclick="gtTap(this)">Girl</button></div>`; }
        function gtTap(btn) { const box = btn.parentElement, next = box.dataset.value === btn.dataset.g ? '' : btn.dataset.g; box.dataset.value = next; box.querySelectorAll('button').forEach(b => { b.classList.toggle('on-m', b.dataset.g === 'M' && next === 'M'); b.classList.toggle('on-f', b.dataset.g === 'F' && next === 'F'); }); }
        const gtVal = id => { const e = document.getElementById(id); return e ? (e.dataset.value || '') : ''; };
        function cycleGender(id) { const st = appState.students.find(x => x.id === id); if (!st) return; const next = { '': 'M', M: 'F', F: '' }[genderOf(st)]; st.extra = st.extra || {}; if (next) st.extra.gender = next; else delete st.extra.gender; saveState(); renderAllAdminData(); }
        function renderAdminStudents() {
            const fc = document.getElementById('student-list-filter-class').value || 'ALL', q = qOf('student-list-search'), el = document.getElementById('admin-students-list'), lim = listLimit.students || PAGE;
            const gch = document.getElementById('student-gchips'); if (gch) { const c = genderCounts(appState.students.filter(x => fc === 'ALL' || x.classId === fc)); gch.innerHTML = c.M || c.F ? genderChips('students', c) : ''; }
            const list = appState.students.filter(x => (fc === 'ALL' || x.classId === fc) && genderMatch(x, GF.students) && (!q || x.name.toLowerCase().includes(q) || x.admissionNo.toLowerCase().includes(q) || Object.entries(x.extra || {}).filter(([k]) => k !== 'gender').some(([, v]) => String(v).toLowerCase().includes(q)))).sort((a, b) => a.name.localeCompare(b.name));
            if (!list.length) { el.innerHTML = emptyMsg(appState.students.length ? 'No matching student found.' : 'No students yet. Tap the + button to add one.'); return; }
            el.innerHTML = list.slice(0, lim).map(x => {
                const c = appState.classes.find(k => k.id === x.classId), cn = c ? c.name : 'Unassigned';
                const more = appState.fields.filter(f => f.id !== 'admissionNo' && fieldVal(x, f.id)).map(f => [f.label, esc(fieldVal(x, f.id))]);
                return cardHTML('student:' + x.id, x.name, `${esc(x.admissionNo)} &bull; ${esc(cn)}`, [[admLabel(), esc(x.admissionNo)], ['Class', esc(cn)], ['Gender', genderBadge(x)], ...more],
                    [{ on: `cycleGender('${x.id}')`, cls: 'abtn-gray', icon: genderOf(x) === 'M' ? 'fa-mars' : genderOf(x) === 'F' ? 'fa-venus' : 'fa-venus-mars', label: genderName(genderOf(x)) || 'Set gender' }, { on: `jumpToStudentMarks('${x.id}', '${x.classId}')`, cls: 'abtn-ok', icon: 'fa-edit', label: 'Enter marks' }, { on: `openStudentEdit('${x.id}')`, cls: 'abtn-edit', icon: 'fa-pen', label: 'Edit' }, { on: `deleteStudent('${x.id}')`, cls: 'abtn-del', icon: 'fa-trash', label: 'Delete' }]);
            }).join('') + moreBtn('students', list.length - lim);
        }
        function gotoSubjects(id) { switchAdminTab('academics'); showSub('acad', 'subjects'); document.getElementById('subject-filter-class').value = id; resetLimit('subjects'); window.scrollTo({ top: 0 }); }
        function gotoStudents(id) { switchAdminTab('students'); showSub('stu', 'dir'); document.getElementById('student-list-filter-class').value = id; resetLimit('students'); window.scrollTo({ top: 0 }); }

        // ================= FLOATING + BUTTON & ADD DIALOGS =================
        let currentAdminTab = 'overview';
        const classOptions = () => appState.classes.map(c => ({ v: c.id, t: c.name }));
        const FABS = { exams: ['Add exam', () => addExam()], classes: ['Add class', () => addClass()], subjects: ['Add subject', () => addSubject()], dir: ['Add student', () => addStudent()] };
        function currentFab() { if (ROUTE === 'super') return superConsoleOpen ? ['Add institution', () => addTenant()] : null; return currentAdminTab === 'academics' ? FABS[subState.acad] : currentAdminTab === 'students' ? FABS[subState.stu] : null; }
        function updateFab() {
            const f = currentFab(), b = document.getElementById('fab'); if (!b) return;
            b.classList.toggle('show', !!f);
            if (f) { document.getElementById('fab-label').textContent = f[0]; b.setAttribute('aria-label', f[0]); }
        }
        function fabAction() { const f = currentFab(); if (f) f[1](); }
        function addExam() {
            openEdit('Add Exam', [{ label: 'Exam title', value: '', required: true }, { label: 'Visible on the public portal', type: 'checkbox', value: true }],
                v => { if (!v[0]) return 'Exam title is required.'; appState.exams.push({ id: 'EXM_' + Date.now(), name: v[0], isPublic: v[1] }); }, { again: addExam, msg: 'Exam added.' });
        }
        function addClass() {
            openEdit('Add Class', [{ label: 'Class name', value: '', required: true }, { label: 'Total working days', type: 'number', min: 1, max: 365, value: 200, required: true }, { label: 'Teacher designation', value: '' }, { label: 'Teacher name', value: '' }, { label: 'Teacher signature', type: 'sign', sign: '' }],
                v => { if (!v[0]) return 'Class name is required.'; if (!(v[1] >= 1 && v[1] <= 365)) return 'Working days must be 1 to 365.'; const id = 'CLS_' + Date.now(); appState.classes.push({ id, name: v[0], totalWorkingDays: v[1], teacherTitle: v[2], teacherName: v[3] }); if (v[4]) { appState.classSigns = appState.classSigns || {}; appState.classSigns[id] = v[4]; } }, { again: addClass, msg: 'Class added.' });
        }
        let lastSubjectClass = '';
        function addSubject() {
            if (!appState.classes.length) { showToast('Create a class first.', 'error'); return; }
            const f = document.getElementById('subject-filter-class').value, def = classOptions().some(o => o.v === lastSubjectClass) ? lastSubjectClass : (appState.classes.some(c => c.id === f) ? f : appState.classes[0].id);
            openEdit('Add Subject', [{ label: 'Class', type: 'select', options: classOptions(), value: def }, { label: 'Subject name', value: '', required: true }, { label: 'Maximum marks', type: 'number', min: 1, max: 1000, value: 100, required: true }, { label: 'Passing marks', type: 'number', min: 0, max: 1000, value: 35, required: true }],
                v => { if (!v[0]) return 'Choose a class.'; if (!v[1]) return 'Subject name is required.'; if (v[3] > v[2]) return 'Passing marks cannot exceed maximum marks.';
                    lastSubjectClass = v[0]; appState.subjects.push({ id: 'SUB_' + Date.now(), classId: v[0], name: v[1], maxMarks: v[2], passingMarks: v[3], active: true }); }, { again: addSubject, msg: 'Subject added.' });
        }
        let lastStudentClass = '';
        function addStudent() {
            if (!appState.classes.length) { showToast('Create a class first.', 'error'); return; }
            const extra = appState.fields.filter(f => f.id !== 'admissionNo' && f.id !== 'gender'), f = document.getElementById('student-list-filter-class').value;
            const def = classOptions().some(o => o.v === lastStudentClass) ? lastStudentClass : (appState.classes.some(c => c.id === f) ? f : appState.classes[0].id);
            openEdit('Add Student', [{ label: admLabel(), value: '', required: true }, { label: 'Full name', value: '', required: true }, ...extra.map(x => ({ label: x.label, value: '' })), { label: 'Class', type: 'select', options: classOptions(), value: def }, { label: 'Gender (optional)', type: 'gender', value: '' }],
                v => {
                    const adm = v[0].toUpperCase(), classId = v[2 + extra.length];
                    if (!adm || !v[1]) return 'ID and name are required.'; if (!classId) return 'Choose a class.';
                    if (appState.students.some(x => x.admissionNo.toUpperCase() === adm)) return `${admLabel()} ${adm} already exists!`;
                    let fatherName = ''; const ex = {};
                    extra.forEach((x, i) => { const val = v[2 + i]; if (x.id === 'fatherName') fatherName = val; else if (val) ex[x.id] = val; });
                    if (v[3 + extra.length]) ex.gender = v[3 + extra.length];
                    lastStudentClass = classId; appState.students.push({ id: 'ST_' + Date.now(), admissionNo: adm, name: v[1], fatherName, extra: ex, classId });
                }, { again: addStudent, msg: 'Student added.' });
        }
        function stepStudent(d) {
            const sel = document.getElementById('entry-student-select'), ids = [...sel.options].map(o => o.value).filter(Boolean), i = ids.indexOf(sel.value), n = i + d;
            if (n < 0 || n >= ids.length) { showToast(d > 0 ? 'That is the last student in this class.' : 'That is the first student in this class.', 'info'); return; }
            sel.value = ids[n]; loadMarksEntrySheet();
        }
        // Blocks any value above the maximum (subject marks, or the class's working days for attendance)
        let limitToastAt = 0;
        function entryMax(inp) {
            if (inp.id === 'entry-days-present') { const c = appState.classes.find(x => x.id === document.getElementById('entry-class-select').value); return c ? Number(c.totalWorkingDays) || 365 : 365; }
            return Number(inp.dataset.max);
        }
        function limitEntry(inp) {
            const v = inp.value;
            if (v === '') { inp.dataset.prev = ''; return; }
            const n = Number(v), max = entryMax(inp);
            if (Number.isFinite(n) && n >= 0 && n <= max) { inp.dataset.prev = v; return; }
            inp.value = inp.dataset.prev || '';
            inp.classList.add('border-red-500', 'bg-red-50'); setTimeout(() => inp.classList.remove('border-red-500', 'bg-red-50'), 700);
            if (Date.now() - limitToastAt > 1200) { limitToastAt = Date.now(); showToast(inp.id === 'entry-days-present' ? `Present days can't be more than ${max} (working days of this class).` : `Marks can't be more than ${max} for this subject.`, 'error'); }
        }
        function entryEnter(e, el) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const all = [...document.querySelectorAll('.entry-mark-input:not(:disabled)')], i = all.indexOf(el);
            if (i > -1 && i < all.length - 1) all[i + 1].focus(); else document.querySelector('button[data-next]').click();
        }

        // ================= SEARCHABLE SELECT (replaces every native dropdown) =================
        function enhanceSelect(sel) {
            if (sel._cs) return;
            const btn = document.createElement('button');
            btn.type = 'button'; btn.className = sel.className + ' cs-btn';
            btn.innerHTML = '<span class="cs-label"></span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>';
            sel.style.display = 'none'; sel.removeAttribute('required');
            sel.insertAdjacentElement('afterend', btn); sel._cs = btn;
            const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
            const sync = () => { const o = sel.options[sel.selectedIndex]; btn.querySelector('.cs-label').textContent = o ? o.text : ''; btn.classList.toggle('cs-placeholder', !o || o.value === ''); btn.classList.toggle('cs-att', !!o && o.dataset.kind === 'att'); };
            Object.defineProperty(sel, 'value', { get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); sync(); }, configurable: true });
            new MutationObserver(sync).observe(sel, { childList: true, subtree: true });
            sel.addEventListener('change', sync);
            btn.addEventListener('click', () => openSelect(sel));
            sync();
        }
        function closeSelect() { document.querySelectorAll('.cs-overlay').forEach(o => { if (o._fit && window.visualViewport) { window.visualViewport.removeEventListener('resize', o._fit); window.visualViewport.removeEventListener('scroll', o._fit); } o.remove(); }); }
        function openSelect(sel) {
            closeSelect();
            const opts = [...sel.options].map(o => ({ v: o.value, t: o.text, s: o.dataset.search || '', k: o.dataset.kind || '' }));
            const ov = document.createElement('div'); ov.className = 'cs-overlay';
            ov.innerHTML = '<div class="cs-panel" role="dialog"><div class="cs-head"><input class="cs-search" type="search" placeholder="Type to search..." autocomplete="off"><button type="button" class="cs-close" aria-label="Close">&times;</button></div><div class="cs-list"></div></div>';
            document.body.appendChild(ov);
            const vv = window.visualViewport;
            const fit = () => { if (vv) { ov.style.top = vv.offsetTop + 'px'; ov.style.height = vv.height + 'px'; ov.style.bottom = 'auto'; } };
            fit(); if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); ov._fit = fit; }
            const list = ov.querySelector('.cs-list'), inp = ov.querySelector('.cs-search');
            const render = q => {
                q = q.trim().toLowerCase();
                const m = opts.filter(o => !q || (o.t + ' ' + o.s).toLowerCase().includes(q));
                list.innerHTML = m.length ? m.map(o => `<button type="button" class="cs-opt${o.v === sel.value ? ' sel' : ''}${o.k ? ' cs-' + o.k : ''}" data-v="${esc(o.v)}">${esc(o.t)}</button>`).join('') : '<div class="cs-empty">No match found</div>';
            };
            const choose = v => { closeSelect(); if (sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); } };
            render('');
            list.addEventListener('click', e => { const b = e.target.closest('.cs-opt'); if (b) choose(b.dataset.v); });
            inp.addEventListener('input', () => render(inp.value));
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const f = list.querySelector('.cs-opt'); if (f) choose(f.dataset.v); } if (e.key === 'Escape') closeSelect(); });
            ov.addEventListener('click', e => { if (e.target === ov) closeSelect(); });
            ov.querySelector('.cs-close').addEventListener('click', closeSelect);
            const cur = list.querySelector('.cs-opt.sel'); if (cur) cur.scrollIntoView({ block: 'center' });
            if (opts.length > 7) setTimeout(() => inp.focus(), 30); // avoid popping the keyboard for short lists
        }

        // ================= SUB-TABS =================
        const subState = { acad: 'exams', stu: 'dir', setup: 'portal' };
        function showSub(group, id) {
            subState[group] = id;
            document.querySelectorAll(`.subpanel[data-group="${group}"]`).forEach(p => p.classList.toggle('hidden', p.dataset.sub !== id));
            document.querySelectorAll(`.subtab-btn[data-group="${group}"]`).forEach(b => b.classList.toggle('active', b.dataset.sub === id));
            updateFab();
        }
        // ================= INSTITUTION OVERVIEW (worked out on this device from the data the admin already has) =================
        const OV = { exam: '', allSubs: false };
        function ovPick(v) { OV.exam = v; OV.allSubs = false; renderInstOverview(); }
        function ovCompute(examId, gf) {
            gf = gf || 'ALL';
            const G = appState.grades, all = examId === '__ALL__';
            const clsOf = new Map(appState.classes.map(c => [c.id, c])), subsBy = new Map(appState.classes.map(c => [c.id, appState.subjects.filter(s => s.classId === c.id && isActive(s))]));
            const resBy = new Map(appState.results.map(r => [r.examId + '|' + r.studentId, r]));
            const exams = all ? appState.exams : appState.exams.filter(e => e.id === examId);
            const perAll = appState.students.map(st => {
                const subs = subsBy.get(st.classId) || [], maxAll = subs.reduce((a, s) => a + Number(s.maxMarks), 0);
                let obtained = 0, max = 0, failedExams = 0, done = 0, partial = 0, absent = 0, attSum = 0, attN = 0;
                exams.forEach(ex => {
                    const r = resBy.get(ex.id + '|' + st.id); if (!r || !subs.length) return;
                    const m = r.marks || {}; if (subs.some(s => m[s.id] === undefined)) { partial++; return; } // blank = marks still pending
                    done++; obtained += sumMarks(m, subs); max += maxAll;
                    if (subs.some(s => isAb(m[s.id]) || Number(m[s.id]) < Number(s.passingMarks))) failedExams++;
                    absent += subs.filter(s => isAb(m[s.id])).length;
                    const days = Number((clsOf.get(st.classId) || {}).totalWorkingDays) || 0; if (Number(r.attendanceDays) >= 0 && days > 0) { attSum += Math.min(100, r.attendanceDays / days * 100); attN++; }
                });
                const status = done ? 'done' : partial ? 'partial' : 'none', pct = done ? exactPct(obtained, max) : 0, passed = done > 0 && failedExams === 0;
                return { st, status, pct, passed, absent, att: attN ? attSum / attN : null, grade: done ? gradeOf(pct, !passed, G).grade : '' };
            });
            const per = perAll.filter(x => genderMatch(x.st, gf));
            const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, r1 = n => Math.round(n * 10) / 10;
            const agg = list => { const dn = list.filter(x => x.status === 'done'), p = dn.filter(x => x.passed).length; return { total: list.length, done: dn.length, passed: p, failed: dn.length - p, passPct: pctOf(p, dn.length), avg: r1(mean(dn.map(x => x.pct))), hi: dn.length ? r1(Math.max(...dn.map(x => x.pct))) : null }; };
            const done = per.filter(x => x.status === 'done'), partial = per.filter(x => x.status === 'partial').length, none = per.filter(x => x.status === 'none').length;
            const byG = {}; ['M', 'F', 'U'].forEach(k => { const L = perAll.filter(x => genderMatch(x.st, k)), dn = L.filter(x => x.status === 'done'), ps = dn.filter(x => x.passed).length; byG[k] = { total: L.length, done: dn.length, passed: ps, failed: dn.length - ps, partial: L.filter(x => x.status === 'partial').length, none: L.filter(x => x.status === 'none').length, absent: dn.filter(x => x.absent > 0).length, passPct: pctOf(ps, dn.length), failPct: pctOf(dn.length - ps, dn.length), avg: r1(mean(dn.map(x => x.pct))) }; });
            const passed = done.filter(x => x.passed).length, failed = done.length - passed;
            const byPct = [...done].sort((a, b) => b.pct - a.pct), attList = done.filter(x => x.att !== null).map(x => x.att);
            const gradeOrder = [...G.scale].sort((a, b) => b.min - a.min).map(x => x.grade).concat([G.fail.grade]), gradeCount = Object.fromEntries(gradeOrder.map(g => [g, 0]));
            done.forEach(x => { gradeCount[x.grade] = (gradeCount[x.grade] || 0) + 1; });
            const genderRows = [['M', 'Boys'], ['F', 'Girls'], ['U', 'Not set']].map(([k, label]) => ({ k, label, ...agg(perAll.filter(x => genderMatch(x.st, k))) })).filter(r => r.total);
            const classRows = appState.classes.map(c => {
                const a = agg(per.filter(x => x.st.classId === c.id)), b = agg(perAll.filter(x => x.st.classId === c.id && genderOf(x.st) === 'M')), g = agg(perAll.filter(x => x.st.classId === c.id && genderOf(x.st) === 'F'));
                return { name: c.name, total: a.total, boys: b.total, girls: g.total, done: a.done, passed: a.passed, failed: a.failed, passPct: a.passPct, avg: a.avg, pending: a.total - a.done, bDone: b.done, bPassed: b.passed, bFail: b.failed, bPend: b.total - b.done, bPct: b.passPct, gDone: g.done, gPassed: g.passed, gFail: g.failed, gPend: g.total - g.done, gPct: g.passPct, unset: a.total - b.total - g.total };
            });
            const subjectRows = [];
            if (!all && exams[0]) appState.classes.forEach(c => (subsBy.get(c.id) || []).forEach(s => {
                let entered = 0, pass = 0, ab = 0, sum = 0, n = 0, hi = null; const gE = { M: 0, F: 0, U: 0 }, gP = { M: 0, F: 0, U: 0 };
                appState.students.filter(x => x.classId === c.id && genderMatch(x, gf)).forEach(st => {
                    const r = resBy.get(exams[0].id + '|' + st.id), v = r && r.marks ? r.marks[s.id] : undefined; if (v === undefined) return;
                    entered++; const gk = genderOf(st) || 'U'; gE[gk]++; if (isAb(v)) { ab++; return; }
                    const num = Number(v); n++; sum += exactPct(num, Number(s.maxMarks)); if (num >= Number(s.passingMarks)) { pass++; gP[gk]++; } if (hi === null || num > hi) hi = num;
                });
                if (entered) subjectRows.push({ cls: c.name, name: s.name, entered, gE, gP, pass, fail: entered - pass, ab, passPct: pctOf(pass, entered), avg: r1(sum / Math.max(1, n)), hi, max: s.maxMarks });
            }));
            return { total: per.length, done: done.length, partial, none, passed, failed, passPct: pctOf(passed, done.length), failPct: pctOf(failed, done.length), avg: r1(mean(done.map(x => x.pct))),
                hi: byPct[0], lo: byPct[byPct.length - 1], absentStudents: done.filter(x => x.absent > 0).length, attAvg: attList.length ? r1(mean(attList)) : null,
                gradeOrder, gradeCount, classRows, subjectRows, genderRows, byG, counts: genderCounts(appState.students), top: byPct.slice(0, 5), all };
        }
        function renderInstOverview() {
            const box = document.getElementById('ov-body'), sel = document.getElementById('ov-exam'); if (!box || !sel) return;
            const exams = appState.exams;
            if (!OV.exam || (OV.exam !== '__ALL__' && !exams.some(e => e.id === OV.exam))) { // default: the newest published exam that has marks
                const hasRes = e => appState.results.some(r => r.examId === e.id), withRes = [...exams].reverse().find(e => e.isPublic && hasRes(e)) || [...exams].reverse().find(hasRes); OV.exam = withRes ? withRes.id : (exams.length ? exams[exams.length - 1].id : '__ALL__');
            }
            sel.innerHTML = (exams.length > 1 ? '<option value="__ALL__">All exams (combined)</option>' : '') + exams.map(e => `<option value="${esc(e.id)}">${esc(e.name)}${e.isPublic ? '' : ' (not published)'}</option>`).join('');
            if (!exams.length) sel.innerHTML = '<option value="">No exams yet</option>'; else if (exams.length === 1 && OV.exam === '__ALL__') OV.exam = exams[0].id;
            sel.value = OV.exam;
            if (!appState.students.length || !exams.length) { box.innerHTML = '<p class="text-sm text-slate-400 text-center py-6">Add classes, students and an exam, then enter marks &mdash; the overview of the whole institution appears here.</p>'; return; }
            const gc = genderCounts(appState.students), hasGender = !!(gc.M || gc.F);
            if (!hasGender) GF.ov = 'ALL';
            const gf = GF.ov, d = ovCompute(OV.exam, gf), cardTone = { g: 'text-emerald-700', r: 'text-red-600', a: 'text-amber-600', s: 'text-slate-800', b: 'text-sky-700' };
            const kpi = (k, label, val, sub, tone, gsub) => `<div class="p-3 rounded-xl border border-slate-200 bg-slate-50"><p class="text-[10px] font-bold uppercase text-slate-400 leading-tight">${label}</p><p data-k="${k}" class="text-2xl font-bold mt-1 ${cardTone[tone || 's']}">${val}</p>${sub ? `<p class="text-[11px] text-slate-500 mt-0.5 truncate">${sub}</p>` : ''}${gsub ? `<p class="text-[10px] font-semibold leading-snug mt-1">${gsub}</p>` : ''}</div>`;
            const seg = (n, cls, label) => d.total && n ? `<div class="${cls} h-full" style="width:${(n / d.total * 100).toFixed(2)}%" title="${label}: ${n}"></div>` : '';
            const complete = pctOf(d.done, d.total), barColor = p => p >= 75 ? 'bg-emerald-500' : p >= 50 ? 'bg-amber-400' : 'bg-red-500';
            const maxGrade = Math.max(1, ...Object.values(d.gradeCount)), subs = OV.allSubs ? d.subjectRows : d.subjectRows.slice(0, 10);
            const pbar = (p, on) => `<div class="flex items-center gap-2"><div class="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden"><div class="h-full ${barColor(p)}" style="width:${on ? p : 0}%"></div></div><span class="w-10 text-right font-semibold">${on ? p + '%' : '-'}</span></div>`;
            const showG0 = hasGender && gf === 'ALL';
            const gsplit = key => showG0 ? `<span class="text-sky-700">${d.byG.M[key]} Boys</span> &middot; <span class="text-pink-700">${d.byG.F[key]} Girls</span>${d.byG.U[key] ? ` &middot; <span class="text-slate-400">${d.byG.U[key]} Not set</span>` : ''}` : '';
            const gsplitPct = key => showG0 ? `<span class="text-sky-700">Boys ${d.byG.M[key]}%</span> &middot; <span class="text-pink-700">Girls ${d.byG.F[key]}%</span>` : '';
            const gs = (b, g, u) => showG0 ? `<div class="text-[10px] font-normal leading-tight mt-0.5"><span class="text-sky-700">${b} Boys</span> &middot; <span class="text-pink-700">${g} Girls</span>${u ? ` &middot; <span class="text-slate-400">${u} Not set</span>` : ''}</div>` : '';
            const gTone = k => k === 'M' ? 'text-sky-700' : k === 'F' ? 'text-pink-700' : 'text-slate-500';
            const chips = hasGender ? `<div class="flex flex-wrap items-center gap-2"><span class="text-xs font-bold uppercase text-slate-500">Show</span><div class="gchips">${genderChips('ov', gc)}</div></div>`
                : `<p class="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2"><i class="fas fa-venus-mars mr-1"></i> Set each student&rsquo;s <b>Boy / Girl</b> (Students tab, or a Gender column in the CSV) to see boys-vs-girls figures and filters here.</p>`;
            const note = gf !== 'ALL' ? `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">Showing <b>${GF_LABEL[gf]}</b> only &mdash; every figure below is for ${GF_LABEL[gf].toLowerCase()}.</p>` : '';
            const gTable = hasGender && d.genderRows.length ? `<div><p class="text-xs font-bold uppercase text-slate-600 mb-2">Boys vs Girls</p>
                <div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs text-left min-w-[520px]"><thead class="bg-slate-100 text-[10px] uppercase text-slate-500"><tr><th class="px-3 py-2">Group</th><th class="px-2 py-2 text-center">Students</th><th class="px-2 py-2 text-center">Complete</th><th class="px-2 py-2 text-center">Passed</th><th class="px-2 py-2 text-center">Failed</th><th class="px-3 py-2 w-36">Pass %</th><th class="px-2 py-2 text-center">Avg %</th><th class="px-2 py-2 text-center">Highest</th></tr></thead>
                <tbody class="divide-y divide-slate-100">${d.genderRows.map(r => `<tr><td class="px-3 py-2 font-bold ${gTone(r.k)}">${r.label}</td><td class="px-2 py-2 text-center">${r.total}</td><td class="px-2 py-2 text-center">${r.done}</td><td class="px-2 py-2 text-center text-emerald-700 font-semibold">${r.passed}</td><td class="px-2 py-2 text-center text-red-600 font-semibold">${r.failed}</td><td class="px-3 py-2">${pbar(r.passPct, r.done)}</td><td class="px-2 py-2 text-center">${r.done ? r.avg + '%' : '-'}</td><td class="px-2 py-2 text-center">${r.hi === null ? '-' : r.hi + '%'}</td></tr>`).join('')}</tbody></table></div>
                ${gf !== 'ALL' ? '<p class="text-[11px] text-slate-400 mt-1">This table always compares everyone, whatever filter is chosen above.</p>' : ''}</div>` : '';
            const showG = hasGender && gf === 'ALL', cell = (n, dn, p) => dn ? `${p}% <span class="text-slate-400">(${n}/${dn})</span>` : '-';
            box.innerHTML = `
                ${chips}${note}
                <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                    ${kpi('total', gf === 'ALL' ? 'Total students' : GF_LABEL[gf], d.total, `${appState.classes.length} classes &bull; ${appState.subjects.filter(isActive).length} subjects`, 's', gsplit('total'))}
                    ${kpi('appeared', 'Result complete', d.done, `of ${d.total} students`, 'b', gsplit('done'))}
                    ${kpi('passed', 'Passed', d.passed, `${d.passPct}% of complete`, 'g', gsplit('passed'))}
                    ${kpi('failed', 'Failed', d.failed, `${d.failPct}% of complete`, 'r', gsplit('failed'))}
                    ${kpi('passpct', 'Pass percentage', d.passPct + '%', '', 'g', gsplitPct('passPct'))}
                    ${kpi('avg', 'Average marks', d.avg + '%', 'of complete results', 's', gsplitPct('avg'))}
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                    ${kpi('hi', 'Highest', d.hi ? Math.round(d.hi.pct * 10) / 10 + '%' : '-', d.hi ? esc(d.hi.st.name) : '', 'g')}
                    ${kpi('lo', 'Lowest', d.lo ? Math.round(d.lo.pct * 10) / 10 + '%' : '-', d.lo ? esc(d.lo.st.name) : '', 'r')}
                    ${kpi('absent', 'With absent (AB)', d.absentStudents, 'students', 's', gsplit('absent'))}
                    ${kpi('att', 'Average attendance', d.attAvg === null ? '-' : d.attAvg + '%', d.attAvg === null ? 'not entered yet' : '')}
                    ${kpi('partial', 'Marks incomplete', d.partial, 'some subjects pending', 'a', gsplit('partial'))}
                    ${kpi('none', 'Not entered', d.none, 'no marks yet', 's', gsplit('none'))}
                </div>
                <div>
                    <div class="flex items-center justify-between mb-1.5"><p class="text-xs font-bold uppercase text-slate-600">Results at a glance</p><p class="text-xs text-slate-500">${complete}% of students have complete marks</p></div>
                    <div class="flex h-4 rounded-full overflow-hidden bg-slate-100">${seg(d.passed, 'bg-emerald-500', 'Passed')}${seg(d.failed, 'bg-red-500', 'Failed')}${seg(d.partial, 'bg-amber-400', 'Incomplete')}${seg(d.none, 'bg-slate-300', 'Not entered')}</div>
                    <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-600">
                        <span><i class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1"></i>Passed ${d.passed}</span><span><i class="inline-block w-2.5 h-2.5 rounded-full bg-red-500 mr-1"></i>Failed ${d.failed}</span>
                        <span><i class="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 mr-1"></i>Incomplete ${d.partial}</span><span><i class="inline-block w-2.5 h-2.5 rounded-full bg-slate-300 mr-1"></i>Not entered ${d.none}</span></div>
                </div>
                ${gTable}
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div><p class="text-xs font-bold uppercase text-slate-600 mb-2">Grade distribution</p>
                        <div class="space-y-1.5">${d.gradeOrder.map(g => { const n = d.gradeCount[g] || 0; return `<div class="flex items-center gap-2 text-xs"><span class="w-8 font-bold text-slate-700 shrink-0">${esc(g)}</span><div class="flex-1 h-4 bg-slate-100 rounded overflow-hidden"><div class="h-full ${g === appState.grades.fail.grade ? 'bg-red-500' : 'bg-emerald-500'}" style="width:${(n / maxGrade * 100).toFixed(1)}%"></div></div><span class="w-8 text-right text-slate-600">${n}</span></div>`; }).join('')}</div></div>
                    <div><p class="text-xs font-bold uppercase text-slate-600 mb-2">Top 5 students${gf !== 'ALL' ? ' (' + GF_LABEL[gf].toLowerCase() + ')' : ''}</p>
                        ${d.top.length ? `<ol class="space-y-1.5">${d.top.map((x, i) => `<li class="flex items-center gap-2 text-sm"><span class="w-6 h-6 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold flex items-center justify-center shrink-0">${i + 1}</span><span class="min-w-0 flex-1 truncate"><span class="font-semibold text-slate-800">${esc(x.st.name)}</span> <span class="text-slate-400 text-xs">${esc((appState.classes.find(c => c.id === x.st.classId) || {}).name || '')}</span></span><span class="font-bold text-slate-700 shrink-0">${Math.round(x.pct * 10) / 10}%</span><span class="text-[10px] font-bold bg-amber-100 text-amber-800 rounded-full px-2 py-0.5 shrink-0">${esc(x.grade)}</span></li>`).join('')}</ol>` : '<p class="text-xs text-slate-400">No complete results yet.</p>'}
                    </div>
                </div>
                <div><p class="text-xs font-bold uppercase text-slate-600 mb-2">Class-wise performance</p>
                    <div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs text-left ${showG ? 'min-w-[900px]' : 'min-w-[560px]'}"><thead class="bg-slate-100 text-[10px] uppercase text-slate-500"><tr><th class="px-3 py-2">Class</th><th class="px-2 py-2 text-center">Students</th><th class="px-2 py-2 text-center">Complete</th><th class="px-2 py-2 text-center">Passed</th><th class="px-2 py-2 text-center">Failed</th><th class="px-3 py-2 w-36">Pass %</th>${showG ? '<th class="px-2 py-2 text-center text-sky-700">Boys pass</th><th class="px-2 py-2 text-center text-pink-700">Girls pass</th>' : ''}<th class="px-2 py-2 text-center">Avg %</th><th class="px-2 py-2 text-center">Pending</th></tr></thead>
                        <tbody class="divide-y divide-slate-100">${d.classRows.map(c => `<tr><td class="px-3 py-2 font-semibold text-slate-800">${esc(c.name)}</td><td class="px-2 py-2 text-center">${c.total}${gs(c.boys, c.girls, c.unset)}</td><td class="px-2 py-2 text-center">${c.done}${gs(c.bDone, c.gDone)}</td><td class="px-2 py-2 text-center text-emerald-700 font-semibold">${c.passed}${gs(c.bPassed, c.gPassed)}</td><td class="px-2 py-2 text-center text-red-600 font-semibold">${c.failed}${gs(c.bFail, c.gFail)}</td><td class="px-3 py-2">${pbar(c.passPct, c.done)}</td>${showG ? `<td class="px-2 py-2 text-center">${cell(c.bPassed, c.bDone, c.bPct)}</td><td class="px-2 py-2 text-center">${cell(c.gPassed, c.gDone, c.gPct)}</td>` : ''}<td class="px-2 py-2 text-center">${c.done ? c.avg + '%' : '-'}</td><td class="px-2 py-2 text-center ${c.pending ? 'text-amber-600 font-semibold' : 'text-slate-400'}">${c.pending}${gs(c.bPend, c.gPend)}</td></tr>`).join('')}</tbody></table></div>
                </div>
                ${d.all ? '' : `<div><p class="text-xs font-bold uppercase text-slate-600 mb-2">Subject-wise performance</p>
                    ${d.subjectRows.length ? `<div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs text-left min-w-[560px]"><thead class="bg-slate-100 text-[10px] uppercase text-slate-500"><tr><th class="px-3 py-2">Class</th><th class="px-2 py-2">Subject</th><th class="px-2 py-2 text-center">Entered</th><th class="px-2 py-2 text-center">Passed</th><th class="px-2 py-2 text-center">Failed</th><th class="px-3 py-2 w-36">Pass %</th><th class="px-2 py-2 text-center">Avg %</th><th class="px-2 py-2 text-center">Highest</th></tr></thead>
                        <tbody class="divide-y divide-slate-100">${subs.map(s => `<tr><td class="px-3 py-2 text-slate-500">${esc(s.cls)}</td><td class="px-2 py-2 font-semibold text-slate-800">${esc(s.name)}</td><td class="px-2 py-2 text-center">${s.entered}${gs(s.gE.M, s.gE.F, s.gE.U)}</td><td class="px-2 py-2 text-center text-emerald-700 font-semibold">${s.pass}${gs(s.gP.M, s.gP.F, s.gP.U)}</td><td class="px-2 py-2 text-center text-red-600 font-semibold">${s.fail}${s.ab ? ` <span class="text-[10px] text-slate-400">(${s.ab} AB)</span>` : ''}${gs(s.gE.M - s.gP.M, s.gE.F - s.gP.F, s.gE.U - s.gP.U)}</td><td class="px-3 py-2">${pbar(s.passPct, true)}</td><td class="px-2 py-2 text-center">${s.avg}%</td><td class="px-2 py-2 text-center">${s.hi === null ? '-' : s.hi + '/' + s.max}</td></tr>`).join('')}</tbody></table></div>
                    ${d.subjectRows.length > 10 ? `<button type="button" onclick="OV.allSubs = !OV.allSubs; renderInstOverview()" class="mt-2 text-xs font-semibold text-emerald-700 underline">${OV.allSubs ? 'Show fewer' : `Show all ${d.subjectRows.length} subjects`}</button>` : ''}` : '<p class="text-xs text-slate-400">No subject marks entered for this exam yet.</p>'}
                </div>`}`;
        }
        // ---- PDF of the overview (opens the print window: choose "Save as PDF") ----
        function ovPrintHTML(d, examName, gf) {
            const m = appState.madrasa, ink = '#0f172a', ac = 'rgb(var(--em-800))', hasGender = !!(d.counts.M || d.counts.F), showG = hasGender && gf === 'ALL';
            const box = (l, v, c, sub) => `<div style="border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;text-align:center"><div style="font-size:8.5px;text-transform:uppercase;color:#64748b">${l}</div><div style="font-size:17px;font-weight:700;color:${c || ink}">${v}</div>${sub ? `<div style="font-size:7.5px;color:#475569;margin-top:2px;line-height:1.25">${sub}</div>` : ''}</div>`;
            const bg = key => showG ? `<span style="color:#0369a1">${d.byG.M[key]} Boys</span> &middot; <span style="color:#be185d">${d.byG.F[key]} Girls</span>${d.byG.U[key] ? ` &middot; ${d.byG.U[key]} Not set` : ''}` : '', bgp = key => showG ? `<span style="color:#0369a1">Boys ${d.byG.M[key]}%</span> &middot; <span style="color:#be185d">Girls ${d.byG.F[key]}%</span>` : '';
            const gl = (b, g, u) => showG ? `<div style="font-size:7.5px;color:#475569;line-height:1.2"><span style="color:#0369a1">${b} Boys</span> &middot; <span style="color:#be185d">${g} Girls</span>${u ? ` &middot; ${u} Not set` : ''}</div>` : '';
            const th = t => `<th style="padding:5px 6px;background:rgb(var(--em-900));color:#fff;font-size:9px;text-transform:uppercase;text-align:center">${t}</th>`;
            const td = (t, x) => `<td style="padding:5px 6px;border-bottom:1px solid #e2e8f0;font-size:10.5px;text-align:center;${x || ''}">${t}</td>`, tdl = t => td(t, 'text-align:left;font-weight:600');
            const pc = p => p >= 75 ? '#10b981' : p >= 50 ? '#fbbf24' : '#ef4444';
            const bar = (p, on) => `<div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:7px;background:#e2e8f0;border-radius:4px;overflow:hidden;min-width:56px"><div style="height:7px;width:${on ? p : 0}%;background:${pc(p)}"></div></div><span style="width:34px;text-align:right;font-weight:600">${on ? p + '%' : '-'}</span></div>`;
            const sec = (t, body) => `<div style="margin-top:12px;break-inside:avoid"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#475569;margin-bottom:5px">${t}</div>${body}</div>`;
            const table = (head, rows) => `<table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0"><thead><tr>${head.map(th).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
            const seg = (n, c) => d.total && n ? `<div style="width:${n / d.total * 100}%;background:${c};height:12px"></div>` : '';
            const gcol = k => k === 'M' ? '#0369a1' : k === 'F' ? '#be185d' : '#64748b', maxGrade = Math.max(1, ...Object.values(d.gradeCount));
            const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), cell = (n, dn, p) => dn ? `${p}% (${n}/${dn})` : '-';
            return `<style>@media print { #print-root tr { break-inside: avoid; } #print-root thead { display: table-header-group; } }</style>
            <div style="font-family:system-ui,Arial,sans-serif;color:${ink};padding:6mm 4mm">
                <div style="display:flex;align-items:center;gap:12px;border-bottom:2px solid ${ac};padding-bottom:8px">${m.logo ? `<img src="${esc(m.logo)}" style="height:54px;width:auto;max-width:90px;object-fit:contain" alt="">` : ''}<div><div style="font-size:18px;font-weight:800;text-transform:uppercase;color:${ac}">${esc(m.name)}</div>${m.subtitle ? `<div style="font-size:10px;color:#475569">${esc(m.subtitle)}</div>` : ''}</div></div>
                <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:baseline;gap:8px"><div style="font-size:14px;font-weight:700">Institution Overview &mdash; ${esc(examName)}${gf !== 'ALL' ? ' &mdash; ' + GF_LABEL[gf] + ' only' : ''}</div><div style="font-size:9px;color:#64748b;white-space:nowrap">Generated ${date}</div></div>
                <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:10px">${box('Students', d.total, ink, bg('total'))}${box('Result complete', d.done, '#0369a1', bg('done'))}${box('Passed', d.passed, 'rgb(var(--em-700))', bg('passed'))}${box('Failed', d.failed, '#dc2626', bg('failed'))}${box('Pass %', d.passPct + '%', 'rgb(var(--em-700))', bgp('passPct'))}${box('Average', d.avg + '%', ink, bgp('avg'))}</div>
                <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:6px">${box('Highest', d.hi ? Math.round(d.hi.pct * 10) / 10 + '%' : '-', '#059669')}${box('Lowest', d.lo ? Math.round(d.lo.pct * 10) / 10 + '%' : '-', '#dc2626')}${box('With absent', d.absentStudents, ink, bg('absent'))}${box('Attendance', d.attAvg === null ? '-' : d.attAvg + '%', ink)}${box('Incomplete', d.partial, '#b45309', bg('partial'))}${box('Not entered', d.none, '#475569', bg('none'))}</div>
                ${sec('Results at a glance', `<div style="display:flex;border-radius:6px;overflow:hidden;background:#e2e8f0">${seg(d.passed, '#10b981')}${seg(d.failed, '#ef4444')}${seg(d.partial, '#fbbf24')}${seg(d.none, '#cbd5e1')}</div><div style="font-size:9px;color:#475569;margin-top:4px">Passed ${d.passed} &bull; Failed ${d.failed} &bull; Incomplete ${d.partial} &bull; Not entered ${d.none}</div>`)}
                ${hasGender && d.genderRows.length ? sec('Boys vs Girls', table(['Group', 'Students', 'Complete', 'Passed', 'Failed', 'Pass %', 'Avg %', 'Highest'], d.genderRows.map(r => `<tr>${td(r.label, `text-align:left;font-weight:700;color:${gcol(r.k)}`)}${td(r.total)}${td(r.done)}${td(r.passed, 'color:#047857;font-weight:600')}${td(r.failed, 'color:#dc2626;font-weight:600')}${td(bar(r.passPct, r.done))}${td(r.done ? r.avg + '%' : '-')}${td(r.hi === null ? '-' : r.hi + '%')}</tr>`).join(''))) : ''}
                ${sec('Grade distribution', `<table style="width:100%;border-collapse:collapse">${d.gradeOrder.map(g => { const n = d.gradeCount[g] || 0; return `<tr><td style="width:36px;font-size:10.5px;font-weight:700;padding:2px 0">${esc(g)}</td><td><div style="height:9px;background:#e2e8f0;border-radius:4px;overflow:hidden"><div style="height:9px;width:${(n / maxGrade * 100).toFixed(1)}%;background:${g === appState.grades.fail.grade ? '#ef4444' : 'rgb(var(--em-600))'}"></div></div></td><td style="width:30px;text-align:right;font-size:10.5px">${n}</td></tr>`; }).join('')}</table>`)}
                ${sec('Class-wise performance', table(['Class', 'Students', 'Complete', 'Passed', 'Failed', 'Pass %'].concat(showG ? ['Boys pass', 'Girls pass'] : [], ['Avg %', 'Pending']), d.classRows.map(c => `<tr>${tdl(esc(c.name))}${td(c.total + gl(c.boys, c.girls, c.unset))}${td(c.done + gl(c.bDone, c.gDone))}${td(c.passed + gl(c.bPassed, c.gPassed), 'color:#047857;font-weight:600')}${td(c.failed + gl(c.bFail, c.gFail), 'color:#dc2626;font-weight:600')}${td(bar(c.passPct, c.done))}${showG ? td(cell(c.bPassed, c.bDone, c.bPct)) + td(cell(c.gPassed, c.gDone, c.gPct)) : ''}${td(c.done ? c.avg + '%' : '-')}${td(c.pending + gl(c.bPend, c.gPend), c.pending ? 'color:#b45309;font-weight:600' : '')}</tr>`).join('')))}
                ${d.all ? '' : sec('Subject-wise performance', d.subjectRows.length ? table(['Class', 'Subject', 'Entered', 'Passed', 'Failed', 'Pass %', 'Avg %', 'Highest'], d.subjectRows.map(s => `<tr>${td(esc(s.cls), 'text-align:left;color:#64748b')}${tdl(esc(s.name))}${td(s.entered + gl(s.gE.M, s.gE.F, s.gE.U))}${td(s.pass + gl(s.gP.M, s.gP.F, s.gP.U), 'color:#047857;font-weight:600')}${td(s.fail + (s.ab ? ` (${s.ab} AB)` : '') + gl(s.gE.M - s.gP.M, s.gE.F - s.gP.F, s.gE.U - s.gP.U), 'color:#dc2626;font-weight:600')}${td(bar(s.passPct, true))}${td(s.avg + '%')}${td(s.hi === null ? '-' : s.hi + '/' + s.max)}</tr>`).join('')) : '<div style="font-size:10px;color:#94a3b8">No subject marks entered for this exam yet.</div>')}
                ${sec('Top 5 students' + (gf !== 'ALL' ? ' (' + GF_LABEL[gf].toLowerCase() + ')' : ''), d.top.length ? table(['#', 'Student', 'Class', 'Percentage', 'Grade'], d.top.map((x, i) => `<tr>${td(i + 1)}${tdl(esc(x.st.name))}${td(esc((appState.classes.find(c => c.id === x.st.classId) || {}).name || ''))}${td(Math.round(x.pct * 10) / 10 + '%', 'font-weight:700')}${td(esc(x.grade))}</tr>`).join('')) : '<div style="font-size:10px;color:#94a3b8">No complete results yet.</div>')}
                <div style="margin-top:14px;font-size:8.5px;color:#94a3b8;text-align:center">Complete = marks entered for every subject. Pass = no absent mark and every subject at or above its pass mark. Generated from the institution&rsquo;s live data.</div>
            </div>`;
        }
        function printOverview() {
            if (!appState.students.length || !appState.exams.length) { showToast('Nothing to print yet.', 'info'); return; }
            const gf = GF.ov, d = ovCompute(OV.exam, gf), ex = appState.exams.find(e => e.id === OV.exam), name = OV.exam === '__ALL__' ? 'All exams (combined)' : (ex ? ex.name : '');
            const root = document.createElement('div'); root.id = 'print-root'; root.innerHTML = ovPrintHTML(d, name, gf);
            document.body.appendChild(root); document.body.classList.add('print-ov');
            const old = document.title; document.title = fileSafe('Overview_' + (appState.madrasa.name || '') + '_' + name + (gf !== 'ALL' ? '_' + GF_LABEL[gf] : '')).replace(/ /g, '_');
            const done = () => { document.title = old; document.body.classList.remove('print-ov'); root.remove(); window.removeEventListener('afterprint', done); };
            window.addEventListener('afterprint', done); setTimeout(() => window.print(), 150);
        }
        function updateCounts() {
            const set = (id, n) => { const e = document.getElementById(id); if (e) e.textContent = `(${n})`; };
            set('cnt-exams', appState.exams.length); set('cnt-classes', appState.classes.length);
            set('cnt-subjects', appState.subjects.length); set('cnt-students', appState.students.length);
        }

        // ================= GENERIC EDIT DIALOG =================
        let geFields = [], geSave = null, geOpts = {};
        function openEdit(title, fields, onSave, opts = {}) {
            document.getElementById('ge-title').textContent = title;
            const lbl = t => `<label class="block text-xs font-bold uppercase text-slate-600 mb-1">${esc(t)}</label>`;
            document.getElementById('ge-fields').innerHTML = fields.map((f, i) => {
                if (f.type === 'gender') return `<div>${lbl(f.label)}${genderToggleHTML('ge-g-' + i, f.value)}</div>`;
                if (f.type === 'sign') return `<div>${lbl(f.label)}<div class="flex items-center gap-3 p-2.5 rounded-lg border border-slate-200 bg-slate-50"><div id="ge-sign-${i}" class="w-28 h-14 shrink-0 bg-white border border-slate-200 rounded flex items-center justify-center overflow-hidden"></div><div class="flex flex-col sm:flex-row gap-1.5 ml-auto"><button type="button" id="ge-sign-btn-${i}" class="abtn abtn-ok" onclick="geSignEdit(${i})">Sign</button><button type="button" id="ge-sign-rm-${i}" class="abtn abtn-gray hidden" onclick="geSignRemove(${i})">Remove</button></div></div></div>`;
                if (f.type === 'checkbox') return `<label class="flex items-center gap-2 text-sm"><input type="checkbox" id="ge-f-${i}" ${f.value ? 'checked' : ''} class="w-5 h-5 accent-emerald-700"> ${esc(f.label)}</label>`;
                if (f.type === 'select') return `<div>${lbl(f.label)}<select id="ge-f-${i}" class="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm bg-white">${f.options.map(o => `<option value="${esc(o.v)}" ${o.v === f.value ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select></div>`;
                if (f.type === 'textarea') return `<div>${lbl(f.label)}<textarea id="ge-f-${i}" rows="9" class="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm font-mono">${esc(f.value ?? '')}</textarea></div>`;
                return `<div>${lbl(f.label)}<input id="ge-f-${i}" type="${f.type || 'text'}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} maxlength="200" value="${esc(f.value ?? '')}" ${f.required ? 'required' : ''} class="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm"></div>`;
            }).join('');
            document.querySelectorAll('#ge-fields select').forEach(enhanceSelect);
            geFields = fields; fields.forEach((f, i) => { if (f.type === 'sign') geSignRefresh(i); }); geSave = onSave; geOpts = opts;
            document.getElementById('ge-save').textContent = opts.saveLabel || 'Save';
            document.getElementById('ge-again').classList.toggle('hidden', !opts.again);
            document.getElementById('ge-modal').classList.remove('hidden'); document.body.classList.add('overflow-hidden');
        }
        function closeEdit() { document.getElementById('ge-modal').classList.add('hidden'); document.body.classList.remove('overflow-hidden'); }
        async function submitEdit(e) {
            e.preventDefault();
            const wantAgain = !!(e.submitter && e.submitter.dataset.again);
            const vals = geFields.map((f, i) => { if (f.type === 'gender') return gtVal('ge-g-' + i); if (f.type === 'sign') return f.sign || ''; const el = document.getElementById('ge-f-' + i); return f.type === 'checkbox' ? el.checked : f.type === 'number' ? Number(el.value) : (f.type === 'select' || f.type === 'textarea') ? el.value : el.value.trim(); });
            let err = geSave(vals); if (err && typeof err.then === 'function') err = await err;
            if (typeof err === 'string') { showToast(err, 'error'); return; }
            const again = wantAgain ? geOpts.again : null, msg = geOpts.msg || 'Changes saved.', custom = !!geOpts.custom;
            if (!custom) { saveState(); renderAllAdminData(); }
            closeEdit(); if (!custom) showToast(msg, 'success');
            if (again) again();
        }
        function editExam(id) {
            const ex = appState.exams.find(x => x.id === id); if (!ex) return;
            openEdit('Edit Exam', [{ label: 'Exam title', value: ex.name, required: true }, { label: 'Visible on the public portal', type: 'checkbox', value: ex.isPublic }],
                v => { if (!v[0]) return 'Exam title is required.'; ex.name = v[0]; ex.isPublic = v[1]; });
        }
        function editClass(id) {
            const c = appState.classes.find(x => x.id === id); if (!c) return;
            openEdit('Edit Class', [{ label: 'Class name', value: c.name, required: true }, { label: 'Total working days', type: 'number', min: 1, max: 365, value: c.totalWorkingDays, required: true },
                { label: 'Teacher designation', value: c.teacherTitle || '' }, { label: 'Teacher name', value: c.teacherName || '' }, { label: 'Teacher signature', type: 'sign', sign: (appState.classSigns || {})[c.id] || '' }],
                v => { if (!v[0]) return 'Class name is required.'; if (!(v[1] >= 1 && v[1] <= 365)) return 'Working days must be 1 to 365.'; Object.assign(c, { name: v[0], totalWorkingDays: v[1], teacherTitle: v[2], teacherName: v[3] }); appState.classSigns = appState.classSigns || {}; if (v[4]) appState.classSigns[c.id] = v[4]; else delete appState.classSigns[c.id]; });
        }
        function editSubject(id) {
            const sub = appState.subjects.find(x => x.id === id); if (!sub) return;
            const cls = appState.classes.find(c => c.id === sub.classId);
            openEdit('Edit Subject' + (cls ? ' (' + cls.name + ')' : ''), [{ label: 'Subject name', value: sub.name, required: true }, { label: 'Maximum marks', type: 'number', min: 1, max: 1000, value: sub.maxMarks, required: true }, { label: 'Passing marks', type: 'number', min: 0, max: 1000, value: sub.passingMarks, required: true }],
                v => { if (!v[0]) return 'Subject name is required.'; if (v[2] > v[1]) return 'Passing marks cannot exceed maximum marks.';
                    if (appState.results.some(r => Number(r.marks[id]) > v[1])) return 'Some students already have marks above this maximum.';
                    Object.assign(sub, { name: v[0], maxMarks: v[1], passingMarks: v[2] }); });
        }
        function editAnnouncement(idx) {
            openEdit('Edit Announcement', [{ label: 'Announcement text', value: appState.announcements[idx], required: true }], v => { if (!v[0]) return 'Text is required.'; appState.announcements[idx] = v[0]; });
        }

        // ================= MARKS ENTRY: subject checklist =================
        let entrySel = {}, entrySelCur = [], entryDraft = {};
        const isActive = x => x.active !== false;
        function renderEntryChips() {
            const classId = document.getElementById('entry-class-select').value, subjects = appState.subjects.filter(x => x.classId === classId);
            document.getElementById('entry-subject-checks').innerHTML = subjects.length
                ? subjects.map(x => `<label class="chip"><input type="checkbox" ${isActive(x) ? 'checked' : ''} onchange="toggleClassSubject('${x.id}', this.checked)"> ${esc(x.name)}</label>`).join('')
                : '<span class="text-xs text-slate-400">No subjects for this class yet.</span>';
            updateSubjectCount();
        }
        function updateSubjectCount() {
            const classId = document.getElementById('entry-class-select').value, all = appState.subjects.filter(x => x.classId === classId), on = all.filter(isActive).length;
            const el = document.getElementById('entry-subject-count'); if (el) el.textContent = all.length ? `${on}/${all.length} on` : '';
        }
        function refreshEntryRows() {
            const classId = document.getElementById('entry-class-select').value, examId = document.getElementById('entry-exam-select').value, studentId = document.getElementById('entry-student-select').value;
            const subjects = appState.subjects.filter(x => x.classId === classId);
            renderEntryRows(subjects.filter(isActive), appState.results.find(r => r.examId === examId && r.studentId === studentId), subjects.length);
        }
        function toggleClassSubject(id, on) {
            const sub = appState.subjects.find(x => x.id === id); if (!sub) return;
            document.querySelectorAll('.entry-mark-input').forEach(inp => { entryDraft[inp.dataset.subjectId] = { val: inp.value, ab: inp.closest('tr').querySelector('.entry-absent').checked }; });
            sub.active = on; saveState(); updateSubjectCount(); refreshEntryRows(); renderAdminSubjects(); renderClassReport();
            showToast(`${sub.name} ${on ? 'is back in' : 'is now skipped for'} this class.`, 'info');
        }
        function setClassSubjects(on) {
            const classId = document.getElementById('entry-class-select').value;
            appState.subjects.filter(x => x.classId === classId).forEach(x => x.active = on);
            saveState(); renderEntryChips(); refreshEntryRows(); renderAdminSubjects(); renderClassReport();
        }
        function renderEntryRows(subjects, existingResult, totalSubjects) {
            const tbody = document.getElementById('entry-subjects-tbody');
            if (!subjects.length) {
                tbody.innerHTML = `<tr><td colspan="3" class="py-6 text-center text-slate-400">${totalSubjects ? 'All subjects of this class are switched off. Tick at least one under the class selector.' : 'No subjects configured for this class. Add subjects first (Exams, Classes & Subjects).'}</td></tr>`;
                recalculateLiveEntry(); return;
            }
            tbody.innerHTML = subjects.map(sub => {
                const d = entryDraft[sub.id], stored = existingResult && existingResult.marks[sub.id] !== undefined ? existingResult.marks[sub.id] : '';
                const ab = d ? d.ab : stored === 'AB', val = d ? d.val : (stored === 'AB' ? '' : stored);
                return `
                    <tr>
                        <td class="py-2.5 px-2 sm:px-4">
                            <div class="font-semibold text-slate-800 text-sm leading-tight">${esc(sub.name)}</div>
                            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] text-slate-400"><span>Max ${sub.maxMarks} &bull; Pass ${sub.passingMarks}</span>
                                <span id="live-sub-status-${sub.id}" class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">-</span></div>
                        </td>
                        <td class="py-2.5 px-1.5 text-center">
                            <input type="number" ${ab ? 'disabled' : ''} min="0" max="${sub.maxMarks}" data-subject-id="${sub.id}" data-max="${sub.maxMarks}" data-pass="${sub.passingMarks}"
                                value="${esc(val)}" placeholder="0-${sub.maxMarks}" onfocus="this.dataset.prev = this.value" oninput="limitEntry(this); recalculateLiveEntry()" onkeydown="entryEnter(event, this)" enterkeyhint="next"
                                class="entry-mark-input w-full px-2 py-2 border border-slate-300 rounded-lg text-center font-bold text-slate-800 focus:ring-2 focus:ring-emerald-600 outline-none">
                        </td>
                        <td class="py-2.5 px-1.5 text-center">
                            <label class="inline-flex flex-col items-center gap-0.5 text-[10px] font-bold text-red-700 cursor-pointer"><input type="checkbox" class="entry-absent w-5 h-5 accent-red-600" onchange="toggleAbsent(this)" ${ab ? 'checked' : ''}>AB</label>
                        </td>
                    </tr>`;
            }).join('');
            recalculateLiveEntry();
        }
        function syncSubjectClass() {}

        // ================= LANDING / NOT FOUND =================
        function showBlocked(msg, name) {
            hideAppLoader();
            ['public-view', 'admin-view', 'super-view', 'landing-view', 'entry-view'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
            ['fab', 'ge-modal', 'student-edit-modal', 'staff-modal'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
            const nm = name || (appState && appState.madrasa && appState.madrasa.name !== 'Institution' ? appState.madrasa.name : '');
            document.getElementById('blocked-title').textContent = IS_ADMIN_ROUTE ? 'Admin access blocked' : 'Portal unavailable';
            document.getElementById('blocked-name').textContent = nm;
            document.getElementById('blocked-msg').textContent = msg || 'This account is suspended. Please contact support.';
            document.getElementById('blocked-view').classList.remove('hidden');
            document.title = nm || 'Unavailable';
        }
        function showLanding(notFound) {
            hideAppLoader();
            ['public-view', 'admin-view', 'super-view'].forEach(id => document.getElementById(id).classList.add('hidden'));
            document.getElementById('landing-view').classList.remove('hidden');
            if (notFound) {
                document.getElementById('landing-title').textContent = 'Institution not found';
                document.getElementById('landing-text').textContent = 'Please check the address you were given, or enter the correct one below.';
                document.title = 'Not found';
            }
        }
        function goToInstitution(e) {
            e.preventDefault();
            const v = document.getElementById('landing-code').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
            if (v) location.href = '/' + v;
        }
        function renderPlanBanner() {
            const b = document.getElementById('plan-banner'); if (!b) return;
            const pu = appState.institution && appState.institution.paidUntil;
            const days = pu ? Math.ceil((new Date(pu + 'T23:59:59') - new Date()) / 86400000) : null;
            if (days === null || days > 14) { b.classList.add('hidden'); return; }
            b.textContent = `Your subscription ends on ${pu} (${Math.max(days, 0)} day${days === 1 ? '' : 's'} left). Please contact support to renew.`;
            b.classList.remove('hidden');
        }

        // ================= SUPER ADMIN (platform owner) =================
        let superTenants = [], superDefault = '', superConsoleOpen = false;
        const slugify = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        const genPass = () => { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let o = ''; for (const n of crypto.getRandomValues(new Uint32Array(10))) o += c[n % c.length]; return o; };
        const TSTATE = { active: ['Active', 'text-emerald-600'], suspended: ['Suspended', 'text-red-600'], expired: ['Expired', 'text-amber-600'] };
        async function sapi(path, opts) {
            try { return await api('/super' + path, opts); }
            catch (e) { if (e.status === 401) { showSuperLogin(); showToast('Session expired. Please log in again.', 'error'); } throw e; }
        }
        function showSuperLogin() { superConsoleOpen = false; document.getElementById('super-login').classList.remove('hidden'); document.getElementById('super-console').classList.add('hidden'); updateFab(); }
        function showSuperConsole() { superConsoleOpen = true; document.getElementById('super-login').classList.add('hidden'); document.getElementById('super-console').classList.remove('hidden'); updateFab(); }
        async function initSuper() {
            ['public-view', 'admin-view', 'landing-view'].forEach(id => document.getElementById(id).classList.add('hidden'));
            document.getElementById('super-view').classList.remove('hidden'); document.title = 'Platform Admin';
            if (token) { try { await loadTenants(); showSuperConsole(); return; } catch (e) { token = ''; localStorage.removeItem(TOKEN_KEY); } }
            showSuperLogin();
        }
        async function superLogin(e) {
            e.preventDefault();
            try {
                const r = await api('/super/login', { method: 'POST', body: { username: document.getElementById('super-user').value.trim(), password: document.getElementById('super-pass').value } });
                token = r.token; localStorage.setItem(TOKEN_KEY, token); document.getElementById('super-pass').value = '';
                await loadTenants(); showSuperConsole();
            } catch (err) { showToast(err.message, 'error'); }
        }
        function superLogout() { token = ''; localStorage.removeItem(TOKEN_KEY); showSuperLogin(); }
        async function loadTenants() { const r = await sapi('/tenants'); superTenants = r.tenants; superDefault = r.defaultSlug || ''; renderTenants(); }
        function renderTenants() {
            document.getElementById('st-total').textContent = superTenants.length;
            document.getElementById('st-active').textContent = superTenants.filter(t => t.state === 'active').length;
            document.getElementById('st-students').textContent = superTenants.reduce((a, t) => a + t.students, 0);
            const q = qOf('tenant-search'), f = document.getElementById('tenant-filter').value || 'all', el = document.getElementById('tenant-list'), lim = listLimit.tenants || PAGE;
            const list = superTenants.filter(t => (f === 'all' || t.state === f) && (!q || (t.name + ' ' + t.slug + ' ' + t.contact + ' ' + t.adminUser).toLowerCase().includes(q)));
            if (!list.length) { el.innerHTML = emptyMsg(superTenants.length ? 'No institution matches.' : 'No institutions yet. Tap the + button to add your first customer.'); return; }
            const o = location.origin;
            el.innerHTML = list.slice(0, lim).map(t => {
                const [label, color] = TSTATE[t.state] || TSTATE.active, main = t.slug === superDefault;
                return cardHTML('tenant:' + t.id, t.name, `<span class="${color} font-semibold">&#9679; ${label}</span> &bull; /${esc(t.slug)} &bull; ${t.students} students${main ? ' &bull; <b>Main address</b>' : ''}`,
                    [['Public page', esc(o + '/' + t.slug)], ['Admin page', esc(o + '/' + t.slug + '/admin')], ['Admin username', esc(t.adminUser)], ['Plan', esc(t.plan)], ['Paid until', esc(t.paidUntil || 'No expiry')],
                     ['Student limit', t.maxStudents || 'Unlimited'], ['Students / classes', `${t.students} / ${t.classes}`], ['Contact', esc(t.contact || '-')], ['Notes', esc(t.notes || '-')], ['Created', esc(t.createdAt || '-')]],
                    [{ on: `openTenant(${t.id})`, cls: 'abtn-ok', icon: 'fa-up-right-from-square', label: 'Open' }, { on: `loginAs(${t.id})`, cls: 'abtn-ok', icon: 'fa-right-to-bracket', label: 'Login as admin' },
                     { on: `editTenant(${t.id})`, cls: 'abtn-edit', icon: 'fa-pen', label: 'Edit' }, { on: `resetTenantPw(${t.id})`, cls: 'abtn-edit', icon: 'fa-key', label: 'Reset password' },
                     { on: `toggleTenant(${t.id})`, cls: 'abtn-gray', icon: 'fa-pause', label: t.status === 'active' ? 'Suspend' : 'Activate' }, { on: `makeDefault(${t.id})`, cls: 'abtn-gray', icon: 'fa-house', label: main ? 'Remove main address' : 'Make main address' },
                     { on: `deleteTenant(${t.id})`, cls: 'abtn-del', icon: 'fa-trash', label: 'Delete' }]);
            }).join('') + moreBtn('tenants', list.length - lim);
        }
        const tenantById = id => superTenants.find(t => t.id === id);
        function inviteText(name, slug, user, pass) {
            const o = location.origin;
            return `${name} - Online Results Portal\n\nPublic page (share with students and parents):\n${o}/${slug}\n\nAdmin login (staff only):\n${o}/${slug}/admin\nUsername: ${user}\nPassword: ${pass}\n\nBefore installing the app on a phone: log in, open Overview > Institution Profile and type a short App name (up to 12 letters) - then press Save. The name under the app icon is fixed at install time.\n\nPlease change the password after your first login (Setup > Admin Login).`;
        }
        async function shareOrCopy(text) {
            try { if (navigator.share) { await navigator.share({ text }); return; } await navigator.clipboard.writeText(text); showToast('Copied to clipboard.', 'success'); }
            catch (e) { if (e.name !== 'AbortError') window.prompt('Copy this message:', text); }
        }
        function showInvite(name, slug, user, pass) {
            openEdit('Share with the institution', [{ label: 'Message (copy it or share it on WhatsApp)', type: 'textarea', value: inviteText(name, slug, user, pass) }], v => { shareOrCopy(v[0]); }, { custom: true, saveLabel: 'Copy / Share' });
        }
        function addTenant() {
            openEdit('Add Institution', [
                { label: 'Institution name', value: '', required: true }, { label: 'Web address (letters, numbers, hyphens)', value: '', required: true },
                { label: 'Admin username', value: 'admin', required: true }, { label: 'Admin password', value: genPass(), required: true },
                { label: 'Plan name', value: 'standard' }, { label: 'Paid until (optional)', type: 'date', value: '' },
                { label: 'Student limit (0 = unlimited)', type: 'number', min: 0, max: 100000, value: 500 }, { label: 'Contact (phone / email)', value: '' }, { label: 'Notes', value: '' }],
                async v => {
                    try {
                        const r = await sapi('/tenants', { method: 'POST', body: { name: v[0], slug: v[1], adminUser: v[2], adminPassword: v[3], plan: v[4], paidUntil: v[5], maxStudents: v[6], contact: v[7], notes: v[8] } });
                        await loadTenants(); setTimeout(() => showInvite(r.tenant.name, r.tenant.slug, v[2], v[3]), 200);
                    } catch (err) { return err.message; }
                }, { custom: true, saveLabel: 'Create institution' });
            const n = document.getElementById('ge-f-0'), a = document.getElementById('ge-f-1'); let touched = false;
            a.addEventListener('input', () => touched = true); n.addEventListener('input', () => { if (!touched) a.value = slugify(n.value); });
        }
        function editTenant(id) {
            const t = tenantById(id); if (!t) return;
            openEdit('Edit Institution', [
                { label: 'Institution name', value: t.name, required: true }, { label: 'Web address (changing it changes the link!)', value: t.slug, required: true },
                { label: 'Status', type: 'select', options: [{ v: 'active', t: 'Active' }, { v: 'suspended', t: 'Suspended' }], value: t.status },
                { label: 'Plan name', value: t.plan }, { label: 'Paid until (empty = no expiry)', type: 'date', value: t.paidUntil },
                { label: 'Student limit (0 = unlimited)', type: 'number', min: 0, max: 100000, value: t.maxStudents }, { label: 'Contact', value: t.contact }, { label: 'Notes', value: t.notes }],
                async v => {
                    try { await sapi('/tenants/' + id, { method: 'PUT', body: { name: v[0], slug: v[1], status: v[2], plan: v[3], paidUntil: v[4], maxStudents: v[5], contact: v[6], notes: v[7] } }); await loadTenants(); showToast('Institution updated.', 'success'); }
                    catch (err) { return err.message; }
                }, { custom: true });
        }
        function resetTenantPw(id) {
            const t = tenantById(id); if (!t) return;
            openEdit('Reset admin login', [{ label: 'Admin username', value: t.adminUser, required: true }, { label: 'New password', value: genPass(), required: true }],
                async v => {
                    try { await sapi(`/tenants/${id}/reset`, { method: 'POST', body: { username: v[0], password: v[1] } }); await loadTenants(); setTimeout(() => showInvite(t.name, t.slug, v[0], v[1]), 200); }
                    catch (err) { return err.message; }
                }, { custom: true, saveLabel: 'Set new password' });
        }
        async function toggleTenant(id) {
            const t = tenantById(id); if (!t) return;
            const status = t.status === 'active' ? 'suspended' : 'active';
            if (status === 'suspended' && !confirm(`Suspend ${t.name}? Their public page and admin login will stop working until you activate it again.`)) return;
            try { await sapi('/tenants/' + id, { method: 'PUT', body: { name: t.name, slug: t.slug, status, plan: t.plan, paidUntil: t.paidUntil, maxStudents: t.maxStudents, contact: t.contact, notes: t.notes } }); await loadTenants(); showToast(`${t.name} is now ${status}.`, 'success'); }
            catch (err) { showToast(err.message, 'error'); }
        }
        async function makeDefault(id) {
            const t = tenantById(id); if (!t) return;
            try { await sapi('/default', { method: 'POST', body: { slug: t.slug === superDefault ? '' : t.slug } }); await loadTenants(); showToast(t.slug === superDefault ? 'Main address now shows the landing page.' : `${t.name} now opens at the main address.`, 'success'); }
            catch (err) { showToast(err.message, 'error'); }
        }
        function openTenant(id) { const t = tenantById(id); if (t) window.open('/' + t.slug, '_blank'); }
        async function loginAs(id) {
            const t = tenantById(id); if (!t) return;
            const w = window.open('', '_blank'); // opened first so the browser does not block it
            try { const r = await sapi(`/tenants/${id}/impersonate`, { method: 'POST' }); localStorage.setItem('rms_token_' + t.slug, r.token); if (w) w.location = '/' + t.slug + '/admin'; else location.href = '/' + t.slug + '/admin'; }
            catch (err) { if (w) w.close(); showToast(err.message, 'error'); }
        }
        function deleteTenant(id) {
            const t = tenantById(id); if (!t) return;
            openEdit('Delete institution', [{ label: `Type "${t.slug}" to confirm. ALL its data will be deleted permanently.`, value: '' }],
                async v => { try { await sapi('/tenants/' + id, { method: 'DELETE', body: { confirm: v[0] } }); await loadTenants(); showToast('Institution deleted.', 'success'); } catch (err) { return err.message; } },
                { custom: true, saveLabel: 'Delete forever' });
        }
        function superAccount() {
            openEdit('My platform login', [{ label: 'Current password', type: 'password', value: '', required: true }, { label: 'New username (optional)', value: '' }, { label: 'New password (optional, 8+ characters)', type: 'password', value: '' }],
                async v => {
                    try { const r = await sapi('/account', { method: 'POST', body: { current: v[0], username: v[1], password: v[2] } }); token = r.token; localStorage.setItem(TOKEN_KEY, token); showToast('Login updated.', 'success'); }
                    catch (err) { return err.message; }
                }, { custom: true, saveLabel: 'Update login' });
        }

        // ================= HELPERS =================
        const sumMarks = (m, subs) => subs.reduce((a, s) => a + (Number(m?.[s.id]) || 0), 0);
        const exactPct = (a, b) => (b > 0 ? a / b * 100 : 0); // grades use the exact percentage, not the rounded one
        const isAb = v => v === 'AB';
        const pctOf = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : 0);
        const ord = n => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
        const gradeOf = (p, failed, g) => { if (failed) return g.fail; const s = [...g.scale].sort((a, b) => b.min - a.min); return s.find(x => p >= x.min) || s[s.length - 1] || g.fail; };
        const admLabel = () => (appState.fields.find(f => f.id === 'admissionNo') || {}).label || 'Admission No';
        const fieldVal = (s, id) => id === 'fatherName' ? (s.fatherName || '') : ((s.extra || {})[id] || '');

        // ---- logo upload (stored in the database; works everywhere, unlike Drive links) ----
        let pendingLogo = null; // null = unchanged, '' = removed, 'data:...' = newly uploaded
        function setLogoPreview(url) { document.getElementById('logo-preview').innerHTML = url ? `<img src="${esc(url)}" class="w-full h-full object-cover" alt="">` : '<i class="fas fa-school"></i>'; }
        function normalizeLogoUrl(u) {
            u = (u || '').trim();
            const m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/) || u.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)/);
            return m ? 'https://lh3.googleusercontent.com/d/' + m[1] : u;
        }
        // ---- logo cropper ----
        const CR = { dw: 0, dh: 0, k: 1, box: { x: 0, y: 0, w: 0, h: 0 }, lock: false, drag: null, revoke: '' };
        function cropBounds(img) { // where the real picture is (ignores empty / white margins), in natural pixels
            const r = Math.min(1, 700 / Math.max(img.naturalWidth, img.naturalHeight, 1)), w = Math.max(1, Math.round(img.naturalWidth * r)), h = Math.max(1, Math.round(img.naturalHeight * r));
            const c = document.createElement('canvas'); c.width = w; c.height = h; const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0, w, h);
            let d; try { d = cx.getImageData(0, 0, w, h).data; } catch (e) { return null; }
            let x0 = w, y0 = h, x1 = -1, y1 = -1;
            for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { const i = (yy * w + xx) * 4; if (d[i + 3] > 24 && !(d[i] > 238 && d[i + 1] > 238 && d[i + 2] > 238)) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; } }
            if (x1 < 0) return null;
            const pad = Math.round(Math.max(x1 - x0, y1 - y0) * .035); x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
            return { x: x0 / r, y: y0 / r, w: (x1 - x0 + 1) / r, h: (y1 - y0 + 1) / r };
        }
        function openLogoCropper(url, revoke) {
            const im = document.getElementById('crop-img'); CR.revoke = revoke || '';
            im.onload = () => { document.getElementById('crop-modal').classList.remove('hidden'); document.body.classList.add('overflow-hidden'); requestAnimationFrame(() => { cropLayout(); CR.lock = false; cropMarkAspect(); cropFit(); }); };
            im.onerror = () => { closeCropper(); showToast('Could not read that image.', 'error'); };
            im.src = url;
        }
        function cropLayout() { const im = document.getElementById('crop-img'); CR.dw = im.clientWidth; CR.dh = im.clientHeight; CR.k = im.naturalWidth / (CR.dw || 1); }
        function cropDraw() { const b = CR.box; ['crop-box', 'crop-dim'].forEach(id => { const el = document.getElementById(id); el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; el.style.width = b.w + 'px'; el.style.height = b.h + 'px'; }); }
        function cropClamp() {
            const b = CR.box, MIN = 24; b.w = Math.max(MIN, Math.min(b.w, CR.dw)); b.h = Math.max(MIN, Math.min(b.h, CR.dh));
            if (CR.lock) { const sq = Math.min(b.w, b.h); b.w = sq; b.h = sq; }
            b.x = Math.max(0, Math.min(b.x, CR.dw - b.w)); b.y = Math.max(0, Math.min(b.y, CR.dh - b.h));
        }
        function cropFit() { const im = document.getElementById('crop-img'), bb = cropBounds(im) || { x: 0, y: 0, w: im.naturalWidth, h: im.naturalHeight }; CR.box = { x: bb.x / CR.k, y: bb.y / CR.k, w: bb.w / CR.k, h: bb.h / CR.k }; cropClamp(); cropDraw(); }
        function cropReset() { CR.box = { x: 0, y: 0, w: CR.dw, h: CR.dh }; cropClamp(); cropDraw(); }
        function cropMarkAspect() { [['crop-free', !CR.lock], ['crop-square', CR.lock]].forEach(([id, on]) => { const b = document.getElementById(id); b.style.background = on ? 'rgb(var(--em-100))' : ''; b.style.color = on ? 'rgb(var(--em-800))' : ''; }); }
        function cropAspect(mode) {
            CR.lock = mode === 'square'; cropMarkAspect();
            if (CR.lock) { const b = CR.box, sq = Math.min(b.w, b.h), cx = b.x + b.w / 2, cy = b.y + b.h / 2; CR.box = { x: cx - sq / 2, y: cy - sq / 2, w: sq, h: sq }; cropClamp(); cropDraw(); }
        }
        function cropMove(e) {
            const d = CR.drag, b0 = d.b;
            if (d.mode === 'move') { CR.box = { ...b0, x: b0.x + e.clientX - d.sx, y: b0.y + e.clientY - d.sy }; cropClamp(); cropDraw(); return; }
            const px = Math.max(0, Math.min(CR.dw, e.clientX - d.ox)), py = Math.max(0, Math.min(CR.dh, e.clientY - d.oy)), MIN = 24, m = d.mode;
            let x1 = b0.x, y1 = b0.y, x2 = b0.x + b0.w, y2 = b0.y + b0.h;
            if (m.includes('w')) x1 = Math.min(px, x2 - MIN); if (m.includes('e')) x2 = Math.max(px, x1 + MIN);
            if (m.includes('n')) y1 = Math.min(py, y2 - MIN); if (m.includes('s')) y2 = Math.max(py, y1 + MIN);
            if (CR.lock) {
                let w = Math.min(x2 - x1, y2 - y1); const room = Math.min(m.includes('n') ? y2 : CR.dh - y1, m.includes('w') ? x2 : CR.dw - x1); w = Math.min(w, room);
                if (m.includes('w')) x1 = x2 - w; else x2 = x1 + w; if (m.includes('n')) y1 = y2 - w; else y2 = y1 + w;
            }
            CR.box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }; cropClamp(); cropDraw();
        }
        (function initCropper() {
            const st = document.getElementById('crop-stage');
            st.addEventListener('pointerdown', e => {
                const h = e.target.closest('.crop-h'), onBox = e.target.closest('#crop-box'); if (!h && !onBox) return;
                e.preventDefault(); try { st.setPointerCapture(e.pointerId); } catch (x) { }
                const r = st.getBoundingClientRect(); CR.drag = { mode: h ? h.dataset.h : 'move', sx: e.clientX, sy: e.clientY, b: { ...CR.box }, ox: r.left, oy: r.top };
            });
            st.addEventListener('pointermove', e => { if (CR.drag) { e.preventDefault(); cropMove(e); } });
            const end = () => { CR.drag = null; }; st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
            window.addEventListener('resize', () => { if (!document.getElementById('crop-modal').classList.contains('hidden')) { const o = CR.k; cropLayout(); CR.box = { x: CR.box.x * o / CR.k, y: CR.box.y * o / CR.k, w: CR.box.w * o / CR.k, h: CR.box.h * o / CR.k }; cropClamp(); cropDraw(); } });
        })();
        function closeCropper() { document.getElementById('crop-modal').classList.add('hidden'); document.body.classList.remove('overflow-hidden'); if (CR.revoke) URL.revokeObjectURL(CR.revoke); CR.revoke = ''; CR.drag = null; }
        function cropApply() {
            const im = document.getElementById('crop-img'), b = CR.box; let out = '';
            try {
                const nw = b.w * CR.k, nh = b.h * CR.k, mx = Math.min(1, 1400 / Math.max(nw, nh)), base = document.createElement('canvas');
                base.width = Math.max(1, Math.round(nw * mx)); base.height = Math.max(1, Math.round(nh * mx));
                base.getContext('2d').drawImage(im, b.x * CR.k, b.y * CR.k, nw, nh, 0, 0, base.width, base.height);
                for (const m of [512, 400, 320, 256, 200]) {
                    const k = Math.min(1, m / Math.max(base.width, base.height)), c = document.createElement('canvas'), cx = c.getContext('2d');
                    c.width = Math.max(1, Math.round(base.width * k)); c.height = Math.max(1, Math.round(base.height * k)); cx.drawImage(base, 0, 0, c.width, c.height);
                    out = c.toDataURL('image/png'); if (out.length <= 150000) break;
                    cx.globalCompositeOperation = 'destination-over'; cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
                    out = c.toDataURL('image/jpeg', 0.9); if (out.length <= 150000) break;
                }
            } catch (e) { out = ''; }
            if (!out || out.length > 190000) { showToast('That picture is too large to use. Crop a smaller area or choose another image.', 'error'); return; }
            pendingLogo = out; pendingLogoCropped = true; markProfileDirty();
            document.getElementById('setting-madrasa-logo').value = ''; document.getElementById('setting-madrasa-logo').placeholder = 'Using the uploaded image';
            setLogoPreview(out); closeCropper(); showToast('Logo ready. Press "Save Profile Changes" to apply it.', 'info');
        }
        function handleLogoFile(inp) {
            const f = inp.files[0]; inp.value = ''; if (!f) return;
            if (!f.type.startsWith('image/')) { showToast('Please choose an image file.', 'error'); return; }
            const url = URL.createObjectURL(f); openLogoCropper(url, url);
        }
        function recropLogo() {
            const cur = logoValue();
            if (!cur) showToast('Upload a logo first.', 'info');
            else if (/^https?:/i.test(cur)) showToast("An online link can't be cropped here. Upload the image file instead.", 'info');
            else openLogoCropper(cur);
        }
        // ================= SIGNATURE PAD (draw with finger / mouse) =================
        const SP = { strokes: [], redo: [], cur: null, onSave: null, raf: 0 }, SP_INK = '#0f1d57', SP_W = 3;
        function spCtx() { return document.getElementById('sp-canvas').getContext('2d'); }
        function spPath(ctx, pts) {
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            if (pts.length < 3) { pts.slice(1).forEach(q => ctx.lineTo(q.x, q.y)); }
            else { for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2; ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my); } ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y); }
            ctx.stroke();
        }
        function spDraw(ctx, strokes, w) {
            ctx.strokeStyle = SP_INK; ctx.fillStyle = SP_INK; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            strokes.forEach(st => { if (st.length === 1) { ctx.beginPath(); ctx.arc(st[0].x, st[0].y, w / 2, 0, Math.PI * 2); ctx.fill(); } else if (st.length) spPath(ctx, st); });
        }
        function spRender() {
            const cv = document.getElementById('sp-canvas'), ctx = spCtx(), dpr = cv.width / (cv.clientWidth || 1);
            ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            spDraw(ctx, SP.strokes, SP_W);
            document.getElementById('sp-undo').disabled = !SP.strokes.length; document.getElementById('sp-redo').disabled = !SP.redo.length; document.getElementById('sp-clear').disabled = !SP.strokes.length;
            document.getElementById('sp-hint').style.display = SP.strokes.length ? 'none' : 'flex';
        }
        function spQueue() { if (!SP.raf) SP.raf = requestAnimationFrame(() => { SP.raf = 0; spRender(); }); }
        function spPoint(e) { const r = document.getElementById('sp-canvas').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
        function spSize() {
            const cv = document.getElementById('sp-canvas'), dpr = Math.min(3, window.devicePixelRatio || 1);
            cv.width = Math.max(1, Math.round(cv.clientWidth * dpr)); cv.height = Math.max(1, Math.round(cv.clientHeight * dpr)); spRender();
        }
        (function initPad() {
            const cv = document.getElementById('sp-canvas');
            cv.addEventListener('pointerdown', e => { e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (x) { } SP.cur = [spPoint(e)]; SP.strokes.push(SP.cur); SP.redo = []; spQueue(); });
            cv.addEventListener('pointermove', e => { if (!SP.cur) return; e.preventDefault(); (e.getCoalescedEvents ? e.getCoalescedEvents() : [e]).forEach(ev => SP.cur.push(spPoint(ev))); spQueue(); });
            const end = e => { if (SP.cur) { SP.cur = null; spQueue(); } };
            cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end); cv.addEventListener('lostpointercapture', end);
            cv.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
            window.addEventListener('resize', () => { if (!document.getElementById('sp-modal').classList.contains('hidden')) spSize(); });
            document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.getElementById('sp-modal').classList.contains('hidden')) closeSignPad(); });
        })();
        function openSignPad(title, onSave) {
            SP.strokes = []; SP.redo = []; SP.cur = null; SP.onSave = onSave;
            document.getElementById('sp-title').textContent = title;
            document.getElementById('sp-modal').classList.remove('hidden');
            requestAnimationFrame(spSize);
        }
        function closeSignPad() { document.getElementById('sp-modal').classList.add('hidden'); SP.onSave = null; }
        function spUndo() { if (SP.strokes.length) { SP.redo.push(SP.strokes.pop()); spRender(); } }
        function spRedo() { if (SP.redo.length) { SP.strokes.push(SP.redo.pop()); spRender(); } }
        function spClear() { SP.strokes = []; SP.redo = []; spRender(); }
        function spSave() {
            if (!SP.strokes.length) { showToast('Please sign first.', 'error'); return; }
            const all = SP.strokes.flat(), pad = SP_W * 2;
            const x0 = Math.min(...all.map(q => q.x)) - pad, y0 = Math.min(...all.map(q => q.y)) - pad, x1 = Math.max(...all.map(q => q.x)) + pad, y1 = Math.max(...all.map(q => q.y)) + pad;
            const bw = Math.max(8, x1 - x0), bh = Math.max(8, y1 - y0);
            let k = Math.min(3, 540 / bw, 210 / bh), out = '';
            for (let t = 0; t < 6; t++) {
                const o = document.createElement('canvas'); o.width = Math.max(1, Math.round(bw * k)); o.height = Math.max(1, Math.round(bh * k));
                const cx = o.getContext('2d'); cx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k); spDraw(cx, SP.strokes, SP_W);
                out = o.toDataURL('image/png'); if (out.length <= 60000) break; k *= .8;
            }
            if (out.length > 85000) { showToast('That signature is too detailed. Please clear and sign more simply.', 'error'); return; }
            const cb = SP.onSave; closeSignPad(); if (cb) cb(out);
        }
        const signPreview = v => v ? `<img src="${esc(v)}" alt="" style="max-width:100%;max-height:100%">` : '<span class="text-[10px] text-slate-300">No signature</span>';
        // head of institution (applied when the profile is saved, like the logo)
        let pendingHeadSign = null; // null = unchanged, '' = removed, 'data:...' = newly drawn
        function headSignValue() { return pendingHeadSign !== null ? pendingHeadSign : (appState.madrasa.headSign || ''); }
        function renderHeadSign() { const v = headSignValue(); document.getElementById('head-sign-preview').innerHTML = signPreview(v); document.getElementById('head-sign-btn').textContent = v ? 'Change' : 'Sign'; document.getElementById('head-sign-rm').classList.toggle('hidden', !v); }
        function signHead() { openSignPad('Head signature' + (document.getElementById('setting-head-name').value.trim() ? ' \u2014 ' + document.getElementById('setting-head-name').value.trim() : ''), v => { pendingHeadSign = v; markProfileDirty(); renderHeadSign(); showToast('Signature ready. Press Save Profile to keep it.', 'info'); }); }
        function removeHeadSign() { markProfileDirty(); pendingHeadSign = ''; renderHeadSign(); }
        // class teacher signature field inside the Add / Edit Class form
        function geSignRefresh(i) { const v = geFields[i].sign || ''; document.getElementById('ge-sign-' + i).innerHTML = signPreview(v); document.getElementById('ge-sign-btn-' + i).textContent = v ? 'Change' : 'Sign'; document.getElementById('ge-sign-rm-' + i).classList.toggle('hidden', !v); }
        function geSignEdit(i) { openSignPad(geFields[i].label, v => { geFields[i].sign = v; geSignRefresh(i); }); }
        function geSignRemove(i) { geFields[i].sign = ''; geSignRefresh(i); }
        // ---- assistant heads (vice principal, secretary...) ----
        const newAsstId = () => 'AS_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        function renderAssistants() {
            const el = document.getElementById('assistant-list'); if (!el) return; const list = appState.assistants || [];
            document.getElementById('assistant-add').disabled = list.length >= 6;
            el.innerHTML = list.length ? list.map((a, i) => `<div class="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input type="text" maxlength="60" value="${esc(a.title)}" placeholder="Designation (e.g., Vice Principal)" oninput="asstEdit(${i}, 'title', this.value)" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white">
                    <input type="text" maxlength="80" value="${esc(a.name)}" placeholder="Name" oninput="asstEdit(${i}, 'name', this.value)" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white"></div>
                <div class="flex items-center gap-2">
                    <div class="w-24 h-12 shrink-0 bg-white border border-slate-200 rounded flex items-center justify-center overflow-hidden">${signPreview(a.sign)}</div>
                    <button type="button" class="abtn abtn-ok" onclick="asstSign(${i})">${a.sign ? 'Change' : 'Sign'}</button>${a.sign ? `<button type="button" class="abtn abtn-gray" onclick="asstEdit(${i}, 'sign', ''); renderAssistants()">Remove</button>` : ''}
                    <button type="button" class="abtn abtn-del ml-auto" aria-label="Delete" onclick="asstDelete(${i})"><i class="fas fa-trash"></i></button></div>
                <label class="flex items-start gap-2 text-sm"><input type="checkbox" class="w-5 h-5 mt-0.5 shrink-0 accent-emerald-700" ${a.show ? 'checked' : ''} onchange="asstEdit(${i}, 'show', this.checked)"><span>Show name &amp; signature on the result certificate</span></label></div>`).join('')
                : '<p class="text-xs text-slate-400">No assistant heads added.</p>';
        }
        function asstEdit(i, k, v) { appState.assistants[i][k] = v; markProfileDirty(); }
        function addAssistant() {
            appState.assistants = appState.assistants || [];
            if (appState.assistants.length >= 6) { showToast('You can add up to 6 assistant heads.', 'error'); return; }
            appState.assistants.push({ id: newAsstId(), title: '', name: '', sign: '', show: true }); markProfileDirty(); renderAssistants();
            const inp = document.querySelector('#assistant-list > div:last-child input'); if (inp) inp.focus();
        }
        function asstSign(i) { const a = appState.assistants[i]; openSignPad((a.title || 'Assistant head') + (a.name ? ' \u2014 ' + a.name : ''), v => { a.sign = v; markProfileDirty(); renderAssistants(); showToast('Signature ready. Press Save Profile Changes to keep it.', 'info'); }); }
        function asstDelete(i) { const a = appState.assistants[i]; if (!confirm(`Remove ${a.title || a.name || 'this assistant head'}?`)) return; appState.assistants.splice(i, 1); markProfileDirty(); renderAssistants(); }
        // ---- accent colour picker ----
        const ACCENTS = ['#065f46', '#0f766e', '#1d4ed8', '#4338ca', '#7e22ce', '#be123c', '#c2410c', '#78350f', '#334155'];
        let pendingAccent = null; // null = unchanged
        const accentValue = () => pendingAccent !== null ? pendingAccent : ((appState.madrasa || {}).accent || '');
        function renderAccentPicker() {
            const cur = (accentValue() || '#065f46').toLowerCase();
            document.getElementById('accent-swatches').innerHTML = ACCENTS.map(c => `<button type="button" aria-label="Colour ${c}" onclick="pickAccent('${c}')" style="background:${c}" class="w-9 h-9 rounded-full border-2 ${c === cur ? 'border-slate-900 ring-2 ring-offset-2 ring-slate-400' : 'border-white shadow'}"></button>`).join('');
            document.getElementById('accent-custom').value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#065f46';
        }
        function pickAccent(hex) { markProfileDirty(); hex = String(hex).toLowerCase(); pendingAccent = hex === '#065f46' ? '' : hex; applyAccent(pendingAccent); renderAccentPicker(); }
        function clearLogo() { markProfileDirty(); pendingLogoCropped = false; pendingLogo = ''; document.getElementById('setting-madrasa-logo').value = ''; setLogoPreview(''); }

        let logoTaps = 0, logoTimer;
        function logoTap() { logoTaps++; clearTimeout(logoTimer); logoTimer = setTimeout(() => logoTaps = 0, 1500); if (logoTaps >= 5) { logoTaps = 0; openStaffLogin(); } }
        function openStaffLogin() {
            if (token) { location.href = adminPath(); return; }
            document.getElementById('staff-modal').classList.remove('hidden');
            setTimeout(() => document.getElementById('staff-user').focus(), 50);
        }
        function closeStaffLogin() { document.getElementById('staff-modal').classList.add('hidden'); }
        async function staffLogin(e) {
            e.preventDefault();
            try {
                const r = await api('/login', { method: 'POST', body: { slug: TENANT, username: document.getElementById('staff-user').value.trim(), password: document.getElementById('staff-pass').value } });
                localStorage.setItem(TOKEN_KEY, r.token);
                location.href = adminPath();
            } catch (err) { showToast(err.message, 'error'); }
        }

        async function shareLink() {
            const url = location.origin + pubPath();
            try {
                if (navigator.share) { await navigator.share({ title: appState.madrasa.name, text: appState.madrasa.shareText || ('Check your exam results online - ' + appState.madrasa.name), url }); return; }
                await navigator.clipboard.writeText(url);
                showToast('Link copied: ' + url, 'success');
            } catch (e) { if (e.name !== 'AbortError') window.prompt('Copy this link:', url); }
        }

        // ================= MARKSHEET (public + bulk) =================
        // Watermark (repeating institution name + faint logo), micro-text borders and the hologram seal.
        // uid keeps SVG ids unique when many marksheets are on one page (bulk PDF).
        function msSecurity(inst, logo, uid) {
            const name = inst.toUpperCase().slice(0, 40);
            const wm = `<svg xmlns='http://www.w3.org/2000/svg' width='430' height='270'><g transform='rotate(-28 215 135)' fill='${accHex(800)}' fill-opacity='.06' font-family='Georgia,serif' font-weight='700' text-anchor='middle'><text x='215' y='125' font-size='21' letter-spacing='3'>${esc(name)}</text><text x='215' y='152' font-size='11' letter-spacing='7'>OFFICIAL RESULT</text></g></svg>`;
            const bg = `url('data:image/svg+xml;utf8,${encodeURIComponent(wm).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')}')`;
            const micro = (name + ' \u2022 ').repeat(60);
            // Ring text: institution name + stars, repeated and stretched so it fills the circle exactly (short or long names)
            const CIRC = 2 * Math.PI * 44, ctx = (() => { try { return document.createElement('canvas').getContext('2d'); } catch (e) { return null; } })();
            const measure = (t, f) => (ctx ? (ctx.font = `700 ${f}px Georgia, serif`, ctx.measureText(t).width) : t.length * f * .62) + t.length * .9;
            const SEP = ' \u2605 ';
            let nm = name.replace(/\s+/g, ' ').trim() || 'INSTITUTION', fs = 7.6, unit = nm + SEP;
            while (measure(unit, fs) > CIRC && fs > 4.8) fs -= .2;
            while (measure(unit, fs) > CIRC && nm.length > 10) { nm = nm.slice(0, -2).trim(); unit = nm + '\u2026' + SEP; }
            const reps = Math.max(1, Math.min(14, Math.round(CIRC / measure(unit, fs))));
            fs = Math.max(4.8, Math.min(9.5, fs * CIRC / (reps * measure(unit, fs))));
            const ring = unit.repeat(reps), tl = (CIRC - .5).toFixed(1);
            let rays = ''; for (let i = 0; i < 36; i++) { const a = i * Math.PI / 18; rays += `<line x1='${(60 + 33 * Math.cos(a)).toFixed(1)}' y1='${(60 + 33 * Math.sin(a)).toFixed(1)}' x2='${(60 + 52 * Math.cos(a)).toFixed(1)}' y2='${(60 + 52 * Math.sin(a)).toFixed(1)}'/>`; }
            const seal = `<svg viewBox="0 0 120 120" role="img" aria-label="Verified result"><defs>
                <linearGradient id="msHolo${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbc2eb"/><stop offset=".2" stop-color="#a6c1ee"/><stop offset=".4" stop-color="#84fab0"/><stop offset=".6" stop-color="#fef9d7"/><stop offset=".8" stop-color="#f6b7d0"/><stop offset="1" stop-color="#8fd3f4"/></linearGradient>
                <radialGradient id="msGlow${uid}"><stop offset="0" stop-color="#fff" stop-opacity=".97"/><stop offset="1" stop-color="#fff" stop-opacity=".7"/></radialGradient>
                <path id="msRing${uid}" d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0"/></defs>
                <circle cx="60" cy="60" r="58" fill="url(#msHolo${uid})" stroke="#b8923a" stroke-width="1.6"/>
                <g stroke="#fff" stroke-opacity=".55" stroke-width=".7">${rays}</g>
                <circle cx="60" cy="60" r="53.5" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width=".8"/>
                <text font-family="Georgia,serif" font-size="${fs.toFixed(2)}" font-weight="700" letter-spacing=".9" fill="${accHex(900)}" textLength="${tl}" lengthAdjust="spacing"><textPath href="#msRing${uid}" textLength="${tl}" lengthAdjust="spacing">${esc(ring)}</textPath></text>
                <circle cx="60" cy="60" r="35" fill="url(#msGlow${uid})" stroke="#8a6d1f" stroke-width="1"/>
                <circle cx="60" cy="60" r="32.5" fill="none" stroke="#b8923a" stroke-width=".5" stroke-dasharray="1.2 1.6"/>
                <text x="60" y="55" text-anchor="middle" font-family="Playball,'Brush Script MT',cursive" font-size="16" fill="${accHex(900)}">Verified</text>
                <path d="M41 61.5 H53 M67 61.5 H79" stroke="#b8923a" stroke-width=".7"/><text x="60" y="64" text-anchor="middle" font-size="6" fill="#b8923a">\u2726</text>
                <text x="60" y="78" text-anchor="middle" font-family="Playball,'Brush Script MT',cursive" font-size="16" fill="${accHex(900)}">Result</text></svg>`;
            return { bg, micro, seal, wmImg: logo ? `<img src="${esc(logo)}" alt="">` : '' };
        }

        // Builds the inside of one marksheet (same markup for the public page, image export and bulk PDF).
        function marksheetHTML(d, uid = 'p') {
            const { madrasa, exam, cls, subjects, details, result, summary, position, exams, overall } = d;
            const inst = madrasa.name || 'Institution', logo = (madrasa.logo || '').trim();
            const sec = msSecurity(inst, logo, uid);
            const sig = (title, name) => (name ? `<p class="ms-sign-name">${esc(name)}</p>` : '') + `<p class="ms-sign-title">${esc(title)}</p>`;
            const sigBlock = (title, name, img) => `<div><div class="ms-sig-line">${img ? `<img class="ms-sign-img" src="${esc(img)}" alt="">` : ''}</div><div>${sig(title, name)}</div></div>`;
            const detailsHTML = [...details, { label: 'Class', value: cls.name }].map(x => `<div><p class="ms-k">${esc(x.label)}</p><p class="ms-v">${esc(x.value)}</p></div>`).join('');

            const tile = (c, label, val, sub) => `<div class="ms-tile ${c}"><p class="ms-tl">${label}</p><p class="ms-tv">${val}</p>${sub ? `<p class="ms-ts">${sub}</p>` : ''}</div>`;
            const boxes = [
                summary.passed ? tile('ok', 'Result', 'PASSED') : tile('bad', 'Result', 'FAILED'),
                tile('gold', 'Grade', esc(summary.grade.grade), esc(summary.grade.title))
            ];
            if (position) boxes.push(tile('sky', 'Class Position', ord(position.rank), `of ${position.of} students`));

            // The server only says whether each subject was passed; pass marks themselves are never sent or shown.
            const row = sub => { const ab = result.marks[sub.id] === 'AB'; return { ab, o: ab ? 0 : Number(result.marks[sub.id] ?? 0), ok: !ab && !!sub.passed, g: esc((result.grades[sub.id] || {}).grade || '-') }; };
            const tbody = subjects.map(sub => {
                const { ab, o, ok, g } = row(sub);
                return `<tr><td class="ms-sub">${esc(sub.name)}</td>
                    <td class="c" style="color:#475569">${sub.maxMarks}</td>
                    <td class="c" style="font-weight:800;color:${ok ? '#0f172a' : '#dc2626'}">${ab ? 'AB' : o}</td>
                    <td class="c" style="font-weight:800;color:${ok ? '#b45309' : '#dc2626'}">${g}</td>
                    <td class="c"><span class="ms-pill ${ab ? 'abs' : ok ? 'pass' : 'fail'}">${ab ? 'ABSENT' : ok ? 'PASS' : 'FAIL'}</span></td></tr>`;
            }).join('');
            const tfoot = `<tr><td style="text-align:left;text-transform:uppercase;letter-spacing:.06em;font-size:11px">Grand Total</td><td class="c">${summary.max}</td><td class="c" style="color:rgb(var(--em-800))">${summary.obtained}</td><td class="c" style="color:#b45309">${esc(summary.grade.grade)}</td><td class="c" style="color:rgb(var(--em-800))">${summary.percentage}%</td></tr>`;
            const cards = subjects.map(sub => {
                const { ab, o, ok, g } = row(sub);
                return `<div class="flex items-center justify-between gap-3 p-3 rounded-xl border ${ok ? 'border-slate-200 bg-white' : 'border-red-200 bg-red-50'}">
                    <div class="min-w-0"><p class="font-semibold text-slate-800 text-sm">${esc(sub.name)}</p><p class="text-xs text-slate-500 mt-0.5">Max ${sub.maxMarks}</p></div>
                    <div class="text-right shrink-0"><p class="text-lg font-bold leading-tight ${ok ? 'text-slate-900' : 'text-red-600'}">${ab ? 'AB' : o}</p>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">${g}</span>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${ok ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}">${ab ? 'ABSENT' : ok ? 'PASS' : 'FAIL'}</span></div></div>`;
            }).join('') + `<div class="flex items-center justify-between p-3.5 rounded-xl bg-emerald-900 text-white text-sm"><span class="font-semibold">Grand Total</span><span class="font-bold">${summary.obtained} / ${summary.max} &bull; ${summary.percentage}%</span></div>`;

            const days = Number(cls.totalWorkingDays) || 200, present = Number(result.attendanceDays || 0), att = days > 0 ? Math.min(100, present / days * 100).toFixed(1) : 0;
            const attOn = Number(result.attendanceDays) >= 0;
            const bg = 'background:rgba(241,245,249,.9)';
            const overallHTML = exams.length < 2 ? '' : `<div class="ms-overall mb-4"><h4>Overall Performance &mdash; All Exams</h4><div class="ms-tablewrap" style="margin-bottom:0"><table class="ms-table" style="font-size:12px">
                <thead><tr><th>Exam</th><th class="c">Marks</th><th class="c">%</th><th class="c">Result</th><th class="c">Grade</th></tr></thead><tbody>`
                + exams.map(x => `<tr><td>${esc(x.name)}</td><td class="c">${x.obtained}/${x.max}</td><td class="c">${x.percentage}%</td><td class="c" style="font-weight:800;color:${x.passed ? 'rgb(var(--em-700))' : '#dc2626'}">${x.passed ? 'PASS' : 'FAIL'}</td><td class="c" style="font-weight:800">${esc(x.grade.grade)}</td></tr>`).join('')
                + `<tr><td style="font-weight:800;${bg}">Overall</td><td class="c" style="font-weight:800;${bg}">${overall.obtained}/${overall.max}</td><td class="c" style="font-weight:800;${bg}">${overall.percentage}%</td><td class="c" style="font-weight:800;${bg};color:${overall.failedCount ? '#dc2626' : 'rgb(var(--em-700))'}">${overall.failedCount ? 'Failed in ' + overall.failedCount : 'Passed all'}</td><td class="c" style="font-weight:800;${bg}">${esc(overall.grade.grade)}${overall.grade.title ? ' &bull; ' + esc(overall.grade.title) : ''}</td></tr></tbody></table></div></div>`;
            const extras = (d.assistants || []).filter(a => a.name || a.sign), sealHTML = `<div class="ms-seal" title="Security hologram">${sec.seal}</div>`;
            let footHTML;
            if (!extras.length) footHTML = `<div class="ms-foot">${sigBlock(cls.teacherTitle || 'Class Teacher', cls.teacherName, cls.teacherSign)}${sealHTML}${sigBlock(madrasa.headTitle || 'Principal', madrasa.headName, madrasa.headSign)}</div>`;
            else { // more signers: hologram moves up, signatures share one tidy row (or two when there are many)
                const signers = [[cls.teacherTitle || 'Class Teacher', cls.teacherName, cls.teacherSign], ...extras.map(a => [a.title || 'Assistant', a.name, a.sign]), [madrasa.headTitle || 'Principal', madrasa.headName, madrasa.headSign]];
                const cols = signers.length <= 4 ? signers.length : Math.ceil(signers.length / 2);
                footHTML = `<div class="ms-foot ms-foot-multi"><div class="ms-seal-row">${sealHTML}</div><div class="ms-sigs" style="grid-template-columns:repeat(${cols}, minmax(0, 1fr))">${signers.map(x => sigBlock(...x)).join('')}</div></div>`;
            }
            const issued = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

            return `<div class="ms-wm" style="background-image:${sec.bg}" aria-hidden="true">${sec.wmImg}</div>
                <div class="ms-frame">
                    <div class="ms-micro" aria-hidden="true">${esc(sec.micro)}</div>
                    <div class="ms-head">
                        ${logo ? `<img class="ms-logo" src="${esc(logo)}" alt="">` : ''}
                        <div><h2 class="ms-inst">${esc(inst)}</h2>${madrasa.subtitle ? `<p class="ms-addr">${esc(madrasa.subtitle)}</p>` : ''}</div>
                    </div>
                    <div class="ms-titlebar"><span class="ms-rule"></span><div><span class="ms-exam">${esc(exam.name)}</span></div><span class="ms-rule"></span></div>
                    <div class="ms-details">${detailsHTML}</div>
                    <div class="ms-stats" style="grid-template-columns:repeat(${boxes.length}, minmax(0, 1fr))">${boxes.join('')}</div>
                    <div class="ms-cards md:hidden print:hidden space-y-2 mb-4">${cards}</div>
                    <div class="hidden md:block print:block ms-tablewrap">
                        <table class="ms-table">
                            <thead><tr><th>Subject</th><th class="c">Max</th><th class="c">Obtained</th><th class="c">Grade</th><th class="c">Status</th></tr></thead>
                            <tbody>${tbody}</tbody><tfoot>${tfoot}</tfoot>
                        </table>
                    </div>
                    <div class="ms-mini"${attOn ? '' : ' style="grid-template-columns:1fr"'}>
                        <div class="ms-box"><h4>Percentage</h4><p class="big">${summary.percentage}%</p></div>
                        ${attOn ? `<div class="ms-box"><h4>Attendance</h4><p class="big">${att}% <small>(${present}/${days} days)</small></p><div class="ms-bar"><div style="width:${att}%"></div></div></div>` : ''}
                    </div>
                    ${overallHTML}
                    ${footHTML}
                    <p class="ms-note">Date of issue: ${issued} &bull; Computer generated result.</p>
                    <div class="ms-micro" aria-hidden="true" style="margin-top:8px">${esc(sec.micro)}</div>
                </div>`;
        }

        // ---- file names: "<admission no>_<student name>" ----
        const fileSafe = v => String(v ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
        const resultFileName = m => fileSafe(`${m.adm}_${m.name}`).replace(/^_+|_+$/g, '') || 'Result';
        let lastMs = null; // the marksheet currently shown on the public page

        // ---- logo / signature helpers: trim empty margins so the logo fills its box ----
        function trimToCanvas(img, maxSide) {
            const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height, r = Math.min(1, maxSide / Math.max(nw, nh, 1));
            const w = Math.max(1, Math.round(nw * r)), h = Math.max(1, Math.round(nh * r));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
            const d = x.getImageData(0, 0, w, h).data; let x0 = w, y0 = h, x1 = -1, y1 = -1;
            for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
                const i = (yy * w + xx) * 4;
                if (d[i + 3] > 24 && !(d[i] > 238 && d[i + 1] > 238 && d[i + 2] > 238)) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
            }
            if (x1 < 0) return { canvas: c, trimmed: false };
            const pad = Math.round(Math.max(x1 - x0, y1 - y0) * .035);
            x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
            const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
            if (cw * ch > .9 * w * h) return { canvas: c, trimmed: false };
            const o = document.createElement('canvas'); o.width = cw; o.height = ch; o.getContext('2d').drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
            return { canvas: o, trimmed: true };
        }
        const trimCache = new Map();
        function trimImage(src) {
            const key = src.length + '|' + src.slice(0, 60) + src.slice(-30);
            if (!trimCache.has(key)) trimCache.set(key, new Promise(res => {
                const img = new Image(); if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
                img.onload = () => { try { const t = trimToCanvas(img, 1000); res(t.trimmed ? t.canvas.toDataURL('image/png') : src); } catch (e) { res(src); } };
                img.onerror = () => res(src); img.src = src;
            }));
            return trimCache.get(key);
        }
        // html2canvas ignores object-fit, which stretched logos/signatures: give such images their exact "contain" size
        function fixContainImages(root) {
            root.querySelectorAll('img').forEach(img => {
                const nw = img.naturalWidth, nh = img.naturalHeight, bw = img.offsetWidth, bh = img.offsetHeight;
                if (!nw || !nh || !bw || !bh || getComputedStyle(img).objectFit !== 'contain') return;
                const k = Math.min(bw / nw, bh / nh);
                img.style.cssText += `;width:${(nw * k).toFixed(2)}px;height:${(nh * k).toFixed(2)}px;max-width:none;max-height:none;object-fit:fill`;
            });
        }

        async function displayMarksheet(d) {
            const lg0 = ((d.madrasa || {}).logo || '').trim();
            if (lg0 && !(d.madrasa || {}).logoCropped) { const t = await trimImage(lg0); if (t !== lg0) d = { ...d, madrasa: { ...d.madrasa, logo: t } }; }
            const nameV = (d.details[0] || {}).value || '';
            const admV = ((d.details.find(x => x.label === admLabel()) || {}).value) || document.getElementById('search-adm-input').value.trim().toUpperCase();
            lastMs = { adm: admV, name: nameV, img: null };
            document.getElementById('printable-result').innerHTML = marksheetHTML(d, 'p');
            const container = document.getElementById('result-display-container');
            container.classList.remove('hidden');
            container.scrollIntoView({ behavior: 'smooth', block: 'start' });
            const mine = lastMs; setTimeout(() => { if (lastMs === mine) prepareMarksheetImage(mine); }, 900); // render in the background so Share is instant
        }

        // Print / Save PDF: the browser uses the page title as the PDF file name, so set it to "<admission no>_<name>".
        function printWithTitle(title) {
            const old = document.title; document.title = title;
            const restore = () => { document.title = old; window.removeEventListener('afterprint', restore); };
            window.addEventListener('afterprint', restore); setTimeout(restore, 60000);
            window.print();
        }
        function printMarksheet() { printWithTitle(lastMs ? resultFileName(lastMs) : document.title); }

        // ---- share / save as image (lossless PNG, 3x resolution) ----
        let h2cPromise = null;
        function loadHtml2Canvas() {
            if (window.html2canvas) return Promise.resolve(window.html2canvas);
            if (!h2cPromise) h2cPromise = new Promise((res, rej) => {
                const sc = document.createElement('script');
                sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                sc.onload = () => res(window.html2canvas); sc.onerror = () => { h2cPromise = null; rej(new Error('Could not load the image tool. Check your internet connection.')); };
                document.head.appendChild(sc);
            });
            return h2cPromise;
        }
        function looksBlank(canvas, r, minFrac) {
            if (!r || r.w < 4 || r.h < 4) return false;
            const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y)), w = Math.min(canvas.width - x, Math.floor(r.w)), h = Math.min(canvas.height - y, Math.floor(r.h));
            if (w <= 0 || h <= 0) return false;
            const d = canvas.getContext('2d').getImageData(x, y, w, h).data; let ink = 0, n = 0;
            for (let i = 0; i < d.length; i += 16) { n++; if (d[i + 3] > 20 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) ink++; }
            return ink / n < minFrac;
        }
        async function renderMarksheetBlob() {
            const src = document.getElementById('printable-result'), stage = document.createElement('div');
            stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;pointer-events:none';
            const clone = src.cloneNode(true); clone.removeAttribute('id'); clone.classList.add('ms-export'); clone.style.width = '820px';
            stage.appendChild(clone); document.body.appendChild(stage); // copy of THIS result, taken before anything slow happens
            try {
                const h2c = await loadHtml2Canvas();
                if (document.fonts && document.fonts.ready) await document.fonts.ready;
                await Promise.all([...clone.querySelectorAll('img')].map(i => i.decode ? i.decode().catch(() => { }) : (i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))));
                fixContainImages(clone);
                const h = clone.offsetHeight || 1200, scale = Math.max(1.5, Math.min(3, Math.sqrt(16e6 / (820 * h))));
                const cr = clone.getBoundingClientRect(), rel = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: (r.left - cr.left) * scale, y: (r.top - cr.top) * scale, w: r.width * scale, h: r.height * scale }; };
                const logoBox = rel(clone.querySelector('.ms-logo')), marksBox = rel(clone.querySelector('.ms-table tbody'));
                let canvas;
                for (let attempt = 0; attempt < 3; attempt++) { // if the logo or the marks came out empty, draw it again
                    canvas = await h2c(clone, { scale, backgroundColor: '#ffffff', useCORS: true, logging: false, width: 820, windowWidth: 820, imageTimeout: 30000 });
                    if (!looksBlank(canvas, logoBox, .01) && !looksBlank(canvas, marksBox, .004)) break;
                    await new Promise(r => setTimeout(r, 400));
                }
                return await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Image could not be created')), 'image/png'));
            } finally { stage.remove(); }
        }
        function prepareMarksheetImage(m) {
            if (!m.img) m.img = renderMarksheetBlob().catch(e => { m.img = null; throw e; });
            m.img.catch(() => {}); return m.img;
        }
        function saveBlob(blob, name) {
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
            document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        }
        async function withBusy(id, label, fn) {
            const b = document.getElementById(id), html = b.innerHTML; b.disabled = true; b.classList.add('opacity-60'); b.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${label}`;
            try { await fn(); } finally { b.disabled = false; b.classList.remove('opacity-60'); b.innerHTML = html; }
        }
        async function downloadMarksheetImage() {
            if (!lastMs) return;
            await withBusy('ms-save-img', 'Wait', async () => {
                try { saveBlob(await prepareMarksheetImage(lastMs), resultFileName(lastMs) + '.png'); showToast('Image saved.', 'success'); }
                catch (e) { showToast(e.message || 'Could not create the image. Please use Print / Save PDF.', 'error'); }
            });
        }
        async function shareMarksheetImage() {
            if (!lastMs) return;
            await withBusy('ms-share-img', 'Wait', async () => {
                const name = resultFileName(lastMs) + '.png';
                let blob;
                try { blob = await prepareMarksheetImage(lastMs); } catch (e) { showToast(e.message || 'Could not create the image. Please use Print / Save PDF.', 'error'); return; }
                const file = new File([blob], name, { type: 'image/png' });
                try {
                    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name.replace(/\.png$/, '') }); return; }
                    saveBlob(blob, name); showToast('Sharing is not supported here, so the image was saved to your device.', 'info');
                } catch (e) {
                    if (e.name === 'AbortError') return;
                    saveBlob(blob, name); showToast('Could not open the share sheet, so the image was saved instead.', 'info');
                }
            });
        }

        // ================= SETUP TAB =================
        const IN = 'min-w-0 px-2 py-2 border border-slate-300 rounded-lg text-sm w-full';
        const gradeRowHTML = r => `<div class="grade-row grid grid-cols-[4rem_4rem_minmax(0,1fr)_1.75rem] gap-2 items-center"><input type="number" min="0" max="100" step="0.1" value="${esc(r.min)}" class="g-min ${IN}"><input value="${esc(r.grade)}" maxlength="12" class="g-grade ${IN}"><input value="${esc(r.title || '')}" maxlength="40" class="g-title ${IN}"><button type="button" onclick="this.closest('.grade-row').remove()" class="text-slate-400 hover:text-red-600"><i class="fas fa-trash"></i></button></div>`;
        const fieldRowHTML = f => `<div class="field-row flex items-center gap-2" data-id="${esc(f.id)}"><input value="${esc(f.label)}" maxlength="40" class="f-label ${IN} flex-1"><label class="flex items-center gap-1 text-xs whitespace-nowrap"><input type="checkbox" class="f-show accent-emerald-700" ${f.show ? 'checked' : ''}> On marksheet</label>${f.id === 'admissionNo' ? '<span class="w-6"></span>' : `<button type="button" onclick="this.closest('.field-row').remove()" class="text-slate-400 hover:text-red-600 w-6"><i class="fas fa-trash"></i></button>`}</div>`;

        function renderSetup() {
            const p = appState.portal;
            document.getElementById('portal-enabled').checked = !!p.enabled;
            document.getElementById('portal-badge').textContent = p.enabled ? 'Public: ON' : 'Public: OFF';
            document.getElementById('portal-message').value = p.message || '';
            document.getElementById('portal-show-pos').checked = p.showPosition !== false;
            document.getElementById('portal-link').textContent = location.origin + pubPath();
            document.getElementById('admin-link').textContent = location.origin + adminPath();
            document.getElementById('grade-rows').innerHTML = [...appState.grades.scale].sort((a, b) => b.min - a.min).map(gradeRowHTML).join('');
            document.getElementById('fail-grade').value = appState.grades.fail.grade;
            document.getElementById('fail-title').value = appState.grades.fail.title || '';
            document.getElementById('field-rows').innerHTML = appState.fields.map(fieldRowHTML).join('');
        }
        function savePortal() {
            appState.portal = { enabled: document.getElementById('portal-enabled').checked, message: document.getElementById('portal-message').value.trim(), showPosition: document.getElementById('portal-show-pos').checked };
            document.getElementById('portal-badge').textContent = appState.portal.enabled ? 'Public: ON' : 'Public: OFF';
            saveState();
            showToast(appState.portal.enabled ? 'Public portal is now ON' : 'Public portal is now OFF', 'success');
        }
        function addGradeRow() { document.getElementById('grade-rows').insertAdjacentHTML('beforeend', gradeRowHTML({ min: 0, grade: '', title: '' })); }
        function saveGrades() {
            const scale = [...document.querySelectorAll('.grade-row')].map(r => ({ min: Number(r.querySelector('.g-min').value), grade: r.querySelector('.g-grade').value.trim(), title: r.querySelector('.g-title').value.trim() }));
            const fail = { grade: document.getElementById('fail-grade').value.trim(), title: document.getElementById('fail-title').value.trim() };
            if (!scale.length || scale.some(x => !x.grade || isNaN(x.min) || x.min < 0 || x.min > 100) || !fail.grade) { showToast('Fill every grade row (min % 0-100) and the fail grade.', 'error'); return; }
            appState.grades = { scale: scale.sort((a, b) => b.min - a.min), fail };
            saveState(); renderSetup(); showToast('Grading criteria saved', 'success');
        }
        function addFieldRow() {
            const inp = document.getElementById('new-field-label'), label = inp.value.trim();
            if (!label) return;
            document.getElementById('field-rows').insertAdjacentHTML('beforeend', fieldRowHTML({ id: 'f_' + Date.now().toString(36), label, show: true }));
            inp.value = '';
        }
        function saveFields() {
            const fields = [...document.querySelectorAll('.field-row')].map(r => ({ id: r.dataset.id, label: r.querySelector('.f-label').value.trim(), show: r.querySelector('.f-show').checked }));
            if (fields.some(f => !f.label)) { showToast('Every field needs a label.', 'error'); return; }
            appState.fields = fields;
            saveState(); renderAllAdminData(); showToast('Student fields saved', 'success');
        }

        // ================= BACKUP / RESTORE =================
        const BACKUP_TYPE = 'result-publisher-backup';
        function downloadBackup() {
            const keys = ['madrasa', 'announcements', 'portal', 'grades', 'fields', 'classSigns', 'teachers', 'assistants', ...TABLES], data = {};
            keys.forEach(k => { data[k] = clone(appState[k]); });
            const file = { type: BACKUP_TYPE, version: 1, exportedAt: new Date().toISOString(), institution: appState.madrasa.name, data };
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
            a.download = `backup-${TENANT || 'institution'}-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            showToast('Backup downloaded.', 'success');
        }
        async function importBackup(input) {
            const f = input.files && input.files[0]; input.value = '';
            if (!f) return;
            try {
                if (f.size > 25 * 1024 * 1024) throw new Error('File is too large.');
                const j = JSON.parse(await f.text()), D = j && j.data;
                if (!j || j.type !== BACKUP_TYPE || !D) throw new Error('This is not a backup file from this app.');
                if (j.version !== 1) throw new Error('Unsupported backup version.');
                for (const t of TABLES) if (!Array.isArray(D[t])) throw new Error(`Backup is missing "${t}".`);
                const S = v => String(v ?? ''), N = v => Number(v) || 0, obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
                const exams = D.exams.filter(r => r && r.id).map(r => ({ id: S(r.id), name: S(r.name), isPublic: !!r.isPublic }));
                const classes = D.classes.filter(r => r && r.id).map(r => ({ id: S(r.id), name: S(r.name), totalWorkingDays: N(r.totalWorkingDays) || 200, teacherTitle: S(r.teacherTitle), teacherName: S(r.teacherName) }));
                const cid = new Set(classes.map(c => c.id)), eid = new Set(exams.map(e => e.id));
                const subjects = D.subjects.filter(r => r && r.id && cid.has(S(r.classId))).map(r => ({ id: S(r.id), classId: S(r.classId), name: S(r.name), maxMarks: N(r.maxMarks), passingMarks: N(r.passingMarks), active: r.active !== false }));
                const students = D.students.filter(r => r && r.id && cid.has(S(r.classId))).map(r => ({ id: S(r.id), admissionNo: S(r.admissionNo).toUpperCase(), name: S(r.name), fatherName: S(r.fatherName), classId: S(r.classId), extra: obj(r.extra) }));
                const sid = new Set(students.map(x => x.id));
                const results = D.results.filter(r => r && eid.has(S(r.examId)) && sid.has(S(r.studentId))).map(r => ({ examId: S(r.examId), studentId: S(r.studentId), attendanceDays: N(r.attendanceDays), marks: obj(r.marks) }));
                if (new Set(students.map(x => x.admissionNo)).size !== students.length) throw new Error('Backup has duplicate admission numbers.');
                const skipped = (D.subjects.length - subjects.length) + (D.students.length - students.length) + (D.results.length - results.length);
                if (!confirm(`Replace ALL current data with this backup?\n\n${S(j.institution)}\nBackup date: ${S(j.exportedAt).slice(0, 10)}\n${classes.length} classes, ${subjects.length} subjects, ${students.length} students, ${exams.length} exams, ${results.length} results${skipped ? `\n(${skipped} broken rows will be skipped)` : ''}\n\nThis cannot be undone.`)) return;
                const m = obj(D.madrasa), fields = Array.isArray(D.fields) && D.fields.some(x => x && x.id === 'admissionNo') ? D.fields.filter(x => x && x.id).map(x => ({ id: S(x.id), label: S(x.label), show: !!x.show })) : appState.fields;
                Object.assign(appState, { madrasa: { ...appState.madrasa, ...m, name: S(m.name).trim() || appState.madrasa.name },
                    announcements: Array.isArray(D.announcements) ? D.announcements.map(S) : [], portal: { ...appState.portal, ...obj(D.portal) },
                    assistants: (Array.isArray(D.assistants) ? D.assistants : []).slice(0, 8).map(x => ({ id: S(x && x.id) || newAsstId(), title: S(x && x.title).slice(0, 60), name: S(x && x.name).slice(0, 80), sign: x && typeof x.sign === 'string' && x.sign.startsWith('data:image/') ? x.sign : '', show: !!(x && x.show) })),
                    teachers: (Array.isArray(D.teachers) ? D.teachers : []).filter(x => x && /^[A-Za-z0-9_-]{24,64}$/.test(S(x.token))).map(x => ({ id: S(x.id) || 'T_' + Math.random().toString(36).slice(2, 9), name: S(x.name) || 'Teacher', token: S(x.token), subjectIds: (Array.isArray(x.subjectIds) ? x.subjectIds.map(S) : []).filter(id => subjects.some(b => b.id === id)), active: x.active !== false, attendance: x.attendance !== false, createdAt: S(x.createdAt) })),
                    classSigns: Object.fromEntries(Object.entries(obj(D.classSigns)).filter(([id, v]) => typeof v === 'string' && v.startsWith('data:image/') && classes.some(c => c.id === id))),
                    grades: D.grades && Array.isArray(D.grades.scale) ? D.grades : appState.grades, fields, exams, classes, subjects, students, results });
                saveState(); renderAllAdminData();
                showToast('Backup restored.', 'success');
            } catch (err) { showToast(err.message || 'Could not read the backup file.', 'error'); }
        }

        async function saveAccount() {
            const v = id => document.getElementById(id).value;
            const body = { current: v('acc-current'), username: v('acc-username').trim(), password: v('acc-new') };
            if (!body.current) { showToast('Enter your current password.', 'error'); return; }
            if (!body.username && !body.password) { showToast('Enter a new username or a new password.', 'error'); return; }
            if (body.password !== v('acc-confirm')) { showToast('New passwords do not match.', 'error'); return; }
            try {
                const r = await api('/admin/account', { method: 'POST', body });
                token = r.token; localStorage.setItem(TOKEN_KEY, token);
                ['acc-current', 'acc-username', 'acc-new', 'acc-confirm'].forEach(id => document.getElementById(id).value = '');
                showToast('Login updated. Use the new details next time.', 'success');
            } catch (err) { showToast(err.message, 'error'); }
        }

        // ================= STUDENT FORM (dynamic fields) =================
        function renderStudentForm() {}

        // ================= CLASS RESULT REPORT =================
        function renderReportSelectors() {
            const e = document.getElementById('rep-exam'), c = document.getElementById('rep-class'), ev = e.value, cv = c.value;
            e.innerHTML = appState.exams.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') + (appState.exams.length > 1 ? '<option value="__ALL__">All exams (cumulative)</option>' : '');
            c.innerHTML = (appState.classes.length > 1 ? '<option value="ALL">All Classes (one PDF)</option>' : '') + appState.classes.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
            if ([...e.options].some(o => o.value === ev)) e.value = ev;
            if ([...c.options].some(o => o.value === cv)) c.value = cv;
            const be = document.getElementById('bulk-exam'), bc = document.getElementById('bulk-class'), bev = be.value, bcv = bc.value;
            be.innerHTML = appState.exams.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
            bc.innerHTML = (appState.classes.length > 1 ? '<option value="ALL">All Classes (one PDF)</option>' : '') + appState.classes.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
            if ([...be.options].some(o => o.value === bev)) be.value = bev;
            if ([...bc.options].some(o => o.value === bcv)) bc.value = bcv;
            updateBulkInfo();
            renderClassReport();
        }
        function renderClassReport() {
            const area = document.getElementById('class-print-area');
            const rgc = document.getElementById('rep-gchips'); if (rgc) { const rc = document.getElementById('rep-class').value, c = genderCounts(appState.students.filter(s => rc === 'ALL' || s.classId === rc)); rgc.innerHTML = c.M || c.F ? genderChips('rep', c) : ''; }
            const examId = document.getElementById('rep-exam').value, classId = document.getElementById('rep-class').value;
            if (!examId || !appState.classes.length) { area.innerHTML = '<p class="text-sm text-slate-400 text-center py-6">Create an exam and a class first.</p>'; return; }
            if (classId === 'ALL') {
                const pages = appState.classes.map(c => classReportHTML(examId, c)).filter(x => x.rows);
                area.innerHTML = pages.length ? pages.map(x => `<div class="class-page">${x.html}</div>`).join('') : '<p class="text-sm text-slate-400 text-center py-6">No results entered for any class yet.</p>';
                return;
            }
            const cls = appState.classes.find(c => c.id === classId);
            if (!cls) { area.innerHTML = '<p class="text-sm text-slate-400 text-center py-6">Create an exam and a class first.</p>'; return; }
            area.innerHTML = classReportHTML(examId, cls).html;
        }
        function classReportHTML(examId, cls) {
            const classId = cls.id;
            const all = examId === '__ALL__', G = appState.grades, days = Number(cls.totalWorkingDays) || 200;
            const exams = all ? appState.exams : appState.exams.filter(e => e.id === examId);
            const subs = appState.subjects.filter(s => s.classId === classId && isActive(s));
            const maxPer = subs.reduce((a, s) => a + Number(s.maxMarks), 0);
            const students = appState.students.filter(s => s.classId === classId && genderMatch(s, GF.rep));
            const rows = students.map(st => {
                const per = exams.map(ex => { const r = appState.results.find(r => r.examId === ex.id && r.studentId === st.id);
                    if (!r) return null; const ap = subs.filter(s => r.marks[s.id] !== undefined);
                    return { m: r.marks, pend: subs.some(s => r.marks[s.id] === undefined), att: Number(r.attendanceDays) >= 0 ? Number(r.attendanceDays) : null, o: sumMarks(r.marks, ap), mx: ap.reduce((a, s) => a + Number(s.maxMarks), 0), fail: ap.length === 0 || ap.some(s => isAb(r.marks[s.id]) || (Number(r.marks[s.id]) || 0) < Number(s.passingMarks)) }; });
                const have = per.filter(x => x && !x.pend), pendRow = !all && per[0] && per[0].pend;
                if (!have.length && !pendRow) return null;
                if (pendRow) return { st, per, pend: true, o: 0, max: 0, p: 0, failN: 0, attDays: null, attPct: null, grade: { grade: '-' } };
                const o = have.reduce((a, x) => a + x.o, 0), max = have.reduce((a, x) => a + x.mx, 0), failN = have.filter(x => x.fail).length;
                return { st, per, o, max, p: pctOf(o, max), failN, attDays: have[0].att, attPct: have.some(x => x.att !== null) ? pctOf(have.reduce((a, x) => a + (x.att || 0), 0), have.length * days) : null, grade: gradeOf(exactPct(o, max), failN > 0, G) };
            }).filter(Boolean).sort((a, b) => (a.pend ? 1 : 0) - (b.pend ? 1 : 0) || exactPct(b.o, b.max) - exactPct(a.o, a.max) || a.st.name.localeCompare(b.st.name));
            const done = rows.filter(r => !r.pend);
            rows.forEach(r => r.rank = r.pend ? '-' : 1 + done.filter(x => exactPct(x.o, x.max) > exactPct(r.o, r.max) + 1e-9).length);
            const th = 'border border-slate-300 px-2 py-1.5 bg-slate-100 text-[11px] uppercase', td = 'border border-slate-300 px-2 py-1 text-center';
            const cols = all ? exams.map(e => `<th class="${th}">${esc(e.name)}</th>`).join('')
                : subs.map(s => `<th class="${th}">${esc(s.name)}<br><span class="font-normal">/${s.maxMarks}</span></th>`).join('');
            const body = rows.map(r => `<tr><td class="${td} font-bold">${r.rank}</td><td class="${td}">${esc(r.st.admissionNo)}</td><td class="${td} text-left font-medium">${esc(r.st.name)}</td>`
                + (all ? r.per.map(x => `<td class="${td}">${x ? (x.pend ? 'Pending' : x.o + '/' + x.mx) : '-'}</td>`).join('')
                    : subs.map(s => { const v = r.per[0].m[s.id], ab = isAb(v), bad = v !== undefined && (ab || Number(v) < Number(s.passingMarks));
                        const g = (v === undefined || ab) ? '' : gradeOf(exactPct(Number(v), Number(s.maxMarks)), bad, G).grade;
                        return `<td class="${td} ${bad ? 'text-red-600 font-bold' : ''}">${ab ? 'AB' : (v ?? '-')}${g ? `<span class="block text-[9px] font-semibold text-slate-500">${esc(g)}</span>` : ''}</td>`; }).join(''))
                + `<td class="${td} font-bold">${r.pend ? '-' : r.o + '/' + r.max}</td><td class="${td}">${r.pend ? '-' : r.p + '%'}</td><td class="${td} font-bold">${esc(r.grade.grade)}</td><td class="${td}">${r.attPct === null ? '-' : all ? r.attPct + '%' : `${r.attDays}/${days}<span class="block text-[9px] text-slate-500">${r.attPct}%</span>`}</td><td class="${td} font-semibold ${r.pend ? 'text-amber-600' : r.failN ? 'text-red-600' : 'text-emerald-700'}">${r.pend ? 'PENDING' : all ? (r.failN ? r.failN + ' failed' : 'Passed all') : (r.failN ? 'FAIL' : 'PASS')}</td></tr>`).join('');
            const passed = done.filter(r => r.failN === 0).length, failed = done.length - passed, pendingN = rows.length - done.length;
            const stat = (l, v, c, sub) => `<div style="border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;text-align:center"><div style="font-size:9px;text-transform:uppercase;color:#64748b">${l}</div><div style="font-size:15px;font-weight:700;color:${c}">${v}</div>${sub ? `<div style="font-size:8px;color:#475569;margin-top:2px;line-height:1.3">${sub}</div>` : ''}</div>`;
            const showGS = GF.rep === 'ALL' && students.some(s => genderOf(s));
            const gc = list => { if (!showGS) return ''; let M = 0, F = 0, U = 0; list.forEach(x => { const g = genderOf(x.st || x); if (g === 'M') M++; else if (g === 'F') F++; else U++; }); return `<span style="color:#0369a1">${M} Boys</span> &middot; <span style="color:#be185d">${F} Girls</span>${U ? ` &middot; ${U} Not set` : ''}`; };
            const gp = (list, test) => { if (!showGS) return ''; const f = g => { const l = list.filter(x => genderOf(x.st) === g); return pctOf(l.filter(test).length, l.length); }; return `<span style="color:#0369a1">Boys ${f('M')}%</span> &middot; <span style="color:#be185d">Girls ${f('F')}%</span>`; };
            const okRow = r => r.failN === 0, badRow = r => r.failN > 0;
            const overview = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px;margin-bottom:10px">`
                + stat('Total Students', students.length, '#0f172a', gc(students)) + stat('Appeared', done.length, '#0f172a', gc(done)) + stat('Passed', passed, 'rgb(var(--em-700))', gc(done.filter(okRow))) + stat('Failed', failed, '#dc2626', gc(done.filter(badRow)))
                + stat('Pass %', pctOf(passed, done.length) + '%', 'rgb(var(--em-700))', gp(done, okRow)) + stat('Fail %', pctOf(failed, done.length) + '%', '#dc2626', gp(done, badRow)) + (pendingN ? stat('Pending', pendingN, '#b45309', gc(rows.filter(r => r.pend))) : '') + `</div>`;
            const key = [...G.scale].sort((a, b) => b.min - a.min).map(x => `${esc(x.grade)} (${x.min}%+)`).join(' &bull; ') + ` &bull; ${esc(G.fail.grade)} (fail) &bull; AB = absent`;
            const sign = (title, name, img) => `<div style="text-align:center"><div style="border-bottom:1px solid #94a3b8;height:40px;margin-bottom:4px;display:flex;align-items:flex-end;justify-content:center">${img ? `<img src="${esc(img)}" style="max-height:38px;max-width:80%;object-fit:contain" alt="">` : ''}</div>${name ? `<div style="font-weight:700;font-size:12px">${esc(name)}</div>` : ''}<div style="font-size:11px;color:#475569">${esc(title)}</div></div>`;
            const html = `<div class="text-center mb-3"><h2 class="text-lg font-bold uppercase font-serif">${esc(appState.madrasa.name)}</h2>
                <p class="text-sm font-semibold">${all ? 'All Exams (Cumulative)' : esc(exams[0] ? exams[0].name : '')} &bull; ${esc(cls.name)}${GF.rep !== 'ALL' ? ' &bull; ' + GF_LABEL[GF.rep] : ''}</p>
                <p class="text-xs text-slate-500 mt-1">${new Date().toLocaleDateString('en-GB')}</p></div>` + overview
                + (rows.length ? `<table class="min-w-full text-xs border-collapse"><thead><tr><th class="${th}">Pos</th><th class="${th}">${esc(admLabel())}</th><th class="${th} text-left">Name</th>${cols}<th class="${th}">Total</th><th class="${th}">%</th><th class="${th}">Grade</th><th class="${th}">Attendance</th><th class="${th}">${all ? 'Exams' : 'Result'}</th></tr></thead><tbody>${body}</tbody></table><p class="text-[10px] text-slate-500 mt-2">Grade key: ${key}</p>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:60px;margin-top:28px;padding:0 30px">${sign(cls.teacherTitle || 'Class Teacher', cls.teacherName, (appState.classSigns || {})[cls.id])}${sign(appState.madrasa.headTitle || 'Principal', appState.madrasa.headName, appState.madrasa.headSign)}</div>`
                    : '<p class="text-sm text-slate-400 text-center py-6">No results entered for this selection yet.</p>');
            return { rows: rows.length, html };
        }
        // ================= SUBJECT-WISE ENTRY (shared by admin "By subject" and the teacher link page) =================
        const seNat = (a, b) => String(a.admissionNo).localeCompare(String(b.admissionNo), undefined, { numeric: true, sensitivity: 'base' });
        const SE_ATT = '__att__', seAttOption = '<option value="__att__" data-kind="att">\ud83d\udcc5 Attendance (days present)</option>';
        const seG = id => document.getElementById(id);
        function seRows(students, sub, getMark) {
            const att = !!sub.att;
            return students.map((st, i) => {
                const v = getMark(st.id), ab = !att && v === 'AB', val = (v === undefined || ab) ? '' : v;
                return `<tr data-sid="${esc(st.id)}" data-g="${st.gender !== undefined ? (st.gender || 'U') : (genderOf(st) || 'U')}" data-orig="${esc(ab ? 'AB' : val)}" data-q="${esc((st.name + ' ' + st.admissionNo).toLowerCase())}"><td class="py-2 px-2 text-slate-400 text-xs">${i + 1}</td>
                    <td class="py-2 px-1"><div class="font-semibold text-slate-800 text-sm leading-tight">${esc(st.name)}</div><div class="text-[11px] text-slate-400">${esc(st.admissionNo)}</div></td>
                    <td class="py-2 px-1.5"><input type="number" inputmode="${att ? 'numeric' : 'decimal'}" step="${att ? 1 : 'any'}" min="0" max="${sub.maxMarks}" data-max="${sub.maxMarks}" data-pass="${sub.passingMarks}" data-prev="${esc(val)}" value="${esc(val)}" ${ab ? 'disabled' : ''} placeholder="-" oninput="seInput(this)" onkeydown="seEnter(event, this)" enterkeyhint="next" class="se-input w-full px-2 py-2.5 border border-slate-300 rounded-lg text-center font-bold text-slate-800 focus:ring-2 focus:ring-emerald-600 outline-none"></td>
                    ${att ? '' : `<td class="py-2 px-1.5 text-center"><label class="inline-flex flex-col items-center gap-0.5 text-[10px] font-bold text-red-700 cursor-pointer"><input type="checkbox" class="se-ab w-5 h-5 accent-red-600" onchange="seAbsent(this)" ${ab ? 'checked' : ''}>AB</label></td>`}</tr>`;
            }).join('') || '<tr><td colspan="4" class="py-6 text-center text-slate-400">No students in this class.</td></tr>';
        }
        // marks sheet (green) or attendance sheet (amber, "days present") - clearly different so nobody mistakes it for a subject
        function seHead(box, att, title, sub) {
            box.dataset.mode = att ? 'att' : 'marks';
            const bar = box.querySelector('.se-bar'), bs = box.querySelector('.se-bar-sub');
            bar.className = 'se-bar px-4 py-2.5 text-white ' + (att ? 'bg-amber-600' : 'bg-emerald-900'); bs.className = 'se-bar-sub text-[11px] truncate ' + (att ? 'text-amber-100' : 'text-emerald-200');
            bar.querySelector('h4').innerHTML = (att ? '<i class="fas fa-calendar-check mr-1.5"></i>' : '') + esc(title); bs.textContent = sub;
            box.querySelector('.se-h-val').textContent = att ? 'Days present' : 'Marks'; box.querySelector('.se-h-ab').classList.toggle('hidden', att);
            const q = box.querySelector('.se-search'); if (q) q.value = '';
            box.querySelector('.se-nomatch').classList.add('hidden');
        }
        function seInput(inp) {
            const box = inp.closest('[data-se]'), att = box.dataset.mode === 'att';
            if (inp.value !== '') {
                const n = Number(inp.value), max = Number(inp.dataset.max);
                if (!(Number.isFinite(n) && n >= 0 && n <= max && (!att || Number.isInteger(n)))) {
                    inp.value = inp.dataset.prev || ''; inp.classList.add('border-red-500', 'bg-red-50'); setTimeout(() => inp.classList.remove('border-red-500', 'bg-red-50'), 700);
                    showToast(att ? `Days present must be a whole number from 0 to ${max}.` : `Marks can't be more than ${max} for this subject.`, 'error'); return;
                }
            }
            inp.dataset.prev = inp.value; seRefresh(box, true);
        }
        function seAbsent(cb) { const inp = cb.closest('tr').querySelector('.se-input'); inp.disabled = cb.checked; if (cb.checked) { inp.value = ''; inp.dataset.prev = ''; } seRefresh(cb.closest('[data-se]'), true); }
        function seEnter(e, el) {
            if (e.key !== 'Enter') return; e.preventDefault();
            const all = [...el.closest('[data-se]').querySelectorAll('.se-input:not(:disabled)')].filter(i => i.closest('tr').style.display !== 'none'), i = all.indexOf(el);
            if (i > -1 && i < all.length - 1) all[i + 1].focus(); else el.blur();
        }
        function seFilter(inp) {
            const box = inp.closest('[data-se]'), q = inp.value.trim().toLowerCase(), gf = box.dataset.gf || 'ALL'; let shown = 0;
            box.querySelectorAll('.se-rows tr[data-sid]').forEach(tr => { const hit = (!q || tr.dataset.q.includes(q)) && (gf === 'ALL' || tr.dataset.g === gf); tr.style.display = hit ? '' : 'none'; if (hit) shown++; });
            box.querySelector('.se-nomatch').classList.toggle('hidden', shown > 0 || (!q && gf === 'ALL'));
        }
        function seGenderBar(box, students) {
            const bar = box.querySelector('.se-gchips'); box.dataset.gf = 'ALL'; if (!bar) return;
            const g = s => s.gender !== undefined ? s.gender : genderOf(s), c = { M: students.filter(s => g(s) === 'M').length, F: students.filter(s => g(s) === 'F').length };
            c.U = students.length - c.M - c.F;
            if (!c.M && !c.F) { bar.classList.add('hidden'); return; }
            bar.classList.remove('hidden');
            bar.innerHTML = [['ALL', 'All', students.length], ['M', 'Boys', c.M], ['F', 'Girls', c.F]].concat(c.U ? [['U', 'Not set', c.U]] : []).map(([v, l, n]) => `<button type="button" class="gchip ${v === 'ALL' ? 'on' : ''}" data-v="${v}" onclick="seSetGF(this)">${l} <b>${n}</b></button>`).join('');
        }
        function seSetGF(btn) { const box = btn.closest('[data-se]'); box.dataset.gf = btn.dataset.v; box.querySelectorAll('.se-gchips .gchip').forEach(b => b.classList.toggle('on', b === btn)); seFilter(box.querySelector('.se-search')); }
        function seRefresh(box, dirty) {
            const att = box.dataset.mode === 'att'; let total = 0, entered = 0, pass = 0, fail = 0, ab = 0, sum = 0, days = 0;
            box.querySelectorAll('.se-rows tr[data-sid]').forEach(tr => {
                const inp = tr.querySelector('.se-input'), abx = tr.querySelector('.se-ab'), isAb = !!(abx && abx.checked); total++; days = Number(inp.dataset.max);
                if (isAb) { entered++; ab++; fail++; } else if (inp.value !== '') { entered++; sum += Number(inp.value); if (Number(inp.value) >= Number(inp.dataset.pass)) pass++; else fail++; }
            });
            const pend = total - entered;
            box.querySelector('.se-summary').innerHTML = att
                ? `<b>${entered}</b> of ${total} entered${entered && days ? ` &bull; <span class="text-amber-300">avg ${(sum / (entered * days) * 100).toFixed(1)}%</span>` : ''}${pend ? ` &bull; <span class="text-slate-300">${pend} blank</span>` : ''}`
                : `<b>${entered}</b> of ${total} entered &bull; <span class="text-emerald-300">${pass} pass</span> &bull; <span class="text-red-300">${fail} fail</span>${ab ? ` (${ab} AB)` : ''}${pend ? ` &bull; <span class="text-amber-300">${pend} pending</span>` : ''}`;
            if (dirty) box.dataset.dirty = '1';
        }
        const seCur = tr => { const inp = tr.querySelector('.se-input'), abx = tr.querySelector('.se-ab'); return (abx && abx.checked) ? 'AB' : inp.value === '' ? '' : String(Number(inp.value)); };
        function seRead(box, changedOnly) { const out = {}; box.querySelectorAll('.se-rows tr[data-sid]').forEach(tr => { const c = seCur(tr); if (changedOnly && c === String(tr.dataset.orig ?? '')) return; out[tr.dataset.sid] = c === 'AB' ? 'AB' : c === '' ? '' : Number(c); }); return out; }
        function seMarkSaved(box) { box.querySelectorAll('.se-rows tr[data-sid]').forEach(tr => { tr.dataset.orig = seCur(tr); }); }

        // ---- admin: By student | By subject ----
        let entryMode = 'student';
        function setEntryMode(m) {
            entryMode = m;
            document.getElementById('entry-mode-student').classList.toggle('hidden', m !== 'student'); document.getElementById('entry-mode-subject').classList.toggle('hidden', m !== 'subject');
            [['em-student', 'student'], ['em-subject', 'subject']].forEach(([id, k]) => { const b = document.getElementById(id); b.className = 'flex-1 py-2 rounded-lg ' + (k === m ? 'bg-white shadow text-emerald-800' : 'text-slate-500'); });
            if (m === 'subject') renderSubjectSelectors();
        }
        function fillSelect(id, html) { const el = document.getElementById(id), prev = el.value; el.innerHTML = html; if ([...el.options].some(o => o.value === prev)) el.value = prev; }
        const SM = { seq: 0, prev: null };
        function renderSubjectSelectors() {
            if (seG('sm-sheet').dataset.dirty) return; // never wipe marks that are being typed
            fillSelect('sm-exam', appState.exams.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') || '<option value="">No exams yet</option>');
            fillSelect('sm-class', appState.classes.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') || '<option value="">No classes yet</option>');
            smClassChange();
        }
        function smGuard() {
            if (seG('sm-sheet').dataset.dirty && !confirm('You have marks that are not saved yet. Discard them?')) {
                if (SM.prev) { seG('sm-exam').value = SM.prev.exam; seG('sm-class').value = SM.prev.cls; smFillSubjects(SM.prev.sub); }
                return false;
            }
            return true;
        }
        function smFillSubjects(want) {
            const cid = seG('sm-class').value, subs = appState.subjects.filter(x => x.classId === cid && isActive(x));
            fillSelect('sm-subject', subs.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') + (cid ? seAttOption : '') || '<option value="">No subjects in this class</option>');
            if (want && [...seG('sm-subject').options].some(o => o.value === want)) seG('sm-subject').value = want;
        }
        function smClassChange(user) { if (user && !smGuard()) return; seG('sm-sheet').dataset.dirty = ''; smFillSubjects(); loadSubjectEntry(); }
        function smChange() { if (!smGuard()) return; seG('sm-sheet').dataset.dirty = ''; loadSubjectEntry(); }
        function loadSubjectEntry() { // spinner first, so nobody can type into the previous selection while the new one loads
            const seq = ++SM.seq, box = seG('sm-sheet'), ld = seG('sm-loading');
            box.classList.add('hidden'); ld.classList.remove('hidden');
            setTimeout(() => { if (seq !== SM.seq) return; ld.classList.add('hidden'); renderSubjectSheet(); }, 220);
        }
        function renderSubjectSheet() {
            const examId = seG('sm-exam').value, cid = seG('sm-class').value, subId = seG('sm-subject').value, box = seG('sm-sheet'), att = subId === SE_ATT;
            const cls = appState.classes.find(x => x.id === cid), ex = appState.exams.find(x => x.id === examId);
            const sub = att ? (cls ? { att: true, id: SE_ATT, name: 'Attendance', maxMarks: Number(cls.totalWorkingDays) || 200, passingMarks: 0 } : null) : appState.subjects.find(x => x.id === subId);
            if (!sub || !cls || !ex) { box.classList.add('hidden'); return; }
            SM.prev = { exam: examId, cls: cid, sub: subId };
            const students = appState.students.filter(x => x.classId === cid).sort(seNat), byStu = new Map(appState.results.filter(r => r.examId === examId).map(r => [r.studentId, r]));
            seHead(box, att, att ? `Attendance \u2014 ${cls.name}` : `${sub.name} \u2014 ${cls.name}`,
                att ? `${ex.name} \u00b7 Total working days: ${sub.maxMarks} \u00b7 ${students.length} students` : `${ex.name} \u00b7 Max ${sub.maxMarks} \u00b7 Pass ${sub.passingMarks} \u00b7 ${students.length} students`);
            box.querySelector('.se-rows').innerHTML = seRows(students, sub, att ? id => { const r = byStu.get(id); return r && r.attendanceDays >= 0 ? r.attendanceDays : undefined; } : id => ((byStu.get(id) || {}).marks || {})[sub.id]);
            seGenderBar(box, students);
            box.dataset.dirty = ''; seRefresh(box); box.classList.remove('hidden');
        }
        function saveSubjectEntry() {
            const examId = seG('sm-exam').value, cid = seG('sm-class').value, subId = seG('sm-subject').value, box = seG('sm-sheet'), att = subId === SE_ATT;
            if (!examId || !subId) return;
            const vals = seRead(box);
            Object.entries(vals).forEach(([sid, v]) => {
                if (!appState.students.some(x => x.id === sid && x.classId === cid)) return;
                const idx = appState.results.findIndex(r => r.examId === examId && r.studentId === sid);
                if (att) {
                    if (v === '') { if (idx > -1) { const r = appState.results[idx]; r.attendanceDays = -1; if (!Object.keys(r.marks).length) appState.results.splice(idx, 1); } }
                    else if (idx > -1) appState.results[idx].attendanceDays = v;
                    else appState.results.push({ examId, studentId: sid, attendanceDays: v, marks: {} });
                } else if (v === '') { // blank = not entered: remove the mark if there was one
                    if (idx > -1) { delete appState.results[idx].marks[subId]; if (!Object.keys(appState.results[idx].marks).length && !(appState.results[idx].attendanceDays >= 0)) appState.results.splice(idx, 1); }
                } else if (idx > -1) appState.results[idx].marks[subId] = v;
                else appState.results.push({ examId, studentId: sid, attendanceDays: -1, marks: { [subId]: v } });
            });
            saveState(); box.dataset.dirty = ''; renderAllAdminData();
            const filled = Object.values(vals).filter(v => v !== '').length, left = Object.values(vals).length - filled;
            showToast(`${att ? 'Attendance' : 'Marks'} saved for ${filled} student${filled === 1 ? '' : 's'}${left ? ` (${left} still blank)` : ''}.`, 'success');
        }

        // ================= TEACHER LINKS (admin) =================
        let tlEditing = null;
        const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const teacherLink = tc => `${location.origin}/${TENANT}/entry/${tc.token}`;
        function scopeText(tc) {
            if (!tc.subjectIds || !tc.subjectIds.length) return 'All classes & subjects';
            const subs = tc.subjectIds.map(id => appState.subjects.find(x => x.id === id)).filter(Boolean);
            if (!subs.length) return 'No valid subject \u2014 edit this link';
            return subs.slice(0, 3).map(x => `${(appState.classes.find(c => c.id === x.classId) || { name: '?' }).name}: ${x.name}`).join(', ') + (subs.length > 3 ? ` +${subs.length - 3} more` : '');
        }
        function renderTeachers() {
            const el = document.getElementById('teacher-list'); if (!el) return;
            const list = appState.teachers || [];
            if (!list.length) { el.innerHTML = emptyMsg('No teacher links yet. Tap Add to create one.'); return; }
            el.innerHTML = list.map(tc => `<div class="p-3 rounded-xl border ${tc.active === false ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-emerald-200 bg-emerald-50/40'}">
                <div class="flex items-start justify-between gap-2"><div class="min-w-0"><p class="font-bold text-slate-800 text-sm truncate">${esc(tc.name)} ${tc.active === false ? '<span class="ml-1 text-[10px] font-bold bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">OFF</span>' : ''}</p>
                    <p class="text-xs text-slate-500 mt-0.5">${esc(scopeText(tc))}${tc.attendance === false ? '' : ' <span class="text-amber-700 font-semibold">+ attendance</span>'}</p></div></div>
                <input readonly value="${esc(teacherLink(tc))}" onclick="this.select()" class="mt-2 w-full px-3 py-2 border border-slate-200 rounded-lg text-[11px] text-slate-600 bg-white">
                <div class="flex flex-wrap gap-1.5 mt-2">
                    <button type="button" class="abtn abtn-ok" onclick="copyTeacherLink('${esc(tc.id)}')"><i class="fas fa-copy"></i> Copy</button>
                    <button type="button" class="abtn abtn-ok" onclick="shareTeacherLink('${esc(tc.id)}')"><i class="fab fa-whatsapp"></i> WhatsApp</button>
                    <button type="button" class="abtn abtn-edit" onclick="openTeacherModal('${esc(tc.id)}')"><i class="fas fa-pen"></i> Edit</button>
                    <button type="button" class="abtn abtn-gray" onclick="toggleTeacher('${esc(tc.id)}')"><i class="fas fa-power-off"></i> ${tc.active === false ? 'Turn on' : 'Turn off'}</button>
                    <button type="button" class="abtn abtn-gray" onclick="regenTeacher('${esc(tc.id)}')"><i class="fas fa-rotate"></i> New link</button>
                    <button type="button" class="abtn abtn-del" onclick="deleteTeacher('${esc(tc.id)}')"><i class="fas fa-trash"></i></button>
                </div></div>`).join('');
        }
        function classTeacherList() { // [name, [class names]] for every class teacher that is set
            const m = new Map(); appState.classes.forEach(c => { const n = (c.teacherName || '').trim(); if (n) m.set(n, [...(m.get(n) || []), c.name]); }); return [...m];
        }
        function openTeacherModal(id) {
            tlEditing = id || null; const tc = id ? appState.teachers.find(x => x.id === id) : null, list = classTeacherList(), isClassT = tc && list.some(([n]) => n === tc.name);
            document.getElementById('tl-title').textContent = tc ? 'Edit teacher link' : 'New teacher link';
            const pick = document.getElementById('tl-pick');
            pick.innerHTML = '<option value="">Choose teacher...</option>' + list.map(([n, cl]) => `<option value="${esc(n)}">${esc(n)} \u2014 ${esc(cl.join(', '))}</option>`).join('') + '<option value="__new__">+ Add another teacher (not a class teacher)</option>';
            pick.value = tc ? (isClassT ? tc.name : '__new__') : (list.length ? '' : '__new__');
            document.getElementById('tl-name').value = tc && !isClassT ? tc.name : '';
            tlPickChange();
            const picked = new Set(tc ? tc.subjectIds : []);
            document.getElementById('tl-all').checked = !tc || !tc.subjectIds.length;
            document.getElementById('tl-att').checked = !tc || tc.attendance !== false;
            document.getElementById('tl-scope').innerHTML = appState.classes.map(c => {
                const subs = appState.subjects.filter(x => x.classId === c.id);
                return subs.length ? `<div><p class="text-xs font-bold text-slate-700 mb-1">${esc(c.name)}</p><div class="flex flex-wrap gap-x-4 gap-y-1.5">${subs.map(x => `<label class="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" class="tl-sub w-4 h-4 accent-emerald-700" value="${esc(x.id)}" ${picked.has(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('')}</div></div>` : '';
            }).join('') || '<p class="text-xs text-slate-400">Add classes and subjects first.</p>';
            tlAllChange();
            document.getElementById('tl-modal').classList.remove('hidden'); document.body.classList.add('overflow-hidden');
        }
        function tlPickChange() {
            const v = document.getElementById('tl-pick').value, inp = document.getElementById('tl-name'), hint = document.getElementById('tl-hint');
            inp.classList.toggle('hidden', v !== '__new__');
            const cl = (classTeacherList().find(([n]) => n === v) || [])[1];
            hint.textContent = v === '__new__' ? 'For a subject teacher who is not the class teacher of any class.' : cl ? `Class teacher of ${cl.join(', ')}.` : '';
        }
        function tlAllChange() { const all = document.getElementById('tl-all').checked, box = document.getElementById('tl-scope'); box.classList.toggle('opacity-40', all); box.querySelectorAll('input').forEach(i => i.disabled = all); }
        function closeTeacherModal() { document.getElementById('tl-modal').classList.add('hidden'); document.body.classList.remove('overflow-hidden'); }
        function saveTeacherModal() {
            const pv = document.getElementById('tl-pick').value, name = pv === '__new__' ? document.getElementById('tl-name').value.trim() : pv;
            if (!name) { showToast('Choose the teacher, or add a new name.', 'error'); return; }
            const all = document.getElementById('tl-all').checked, attendance = document.getElementById('tl-att').checked, subjectIds = all ? [] : [...document.querySelectorAll('#tl-scope .tl-sub:checked')].map(i => i.value);
            if (!all && !subjectIds.length) { showToast('Tick at least one subject, or choose "All classes & subjects".', 'error'); return; }
            if (tlEditing) { const tc = appState.teachers.find(x => x.id === tlEditing); Object.assign(tc, { name, subjectIds, attendance }); }
            else appState.teachers.push({ id: 'T_' + Date.now().toString(36), name, token: newToken(), subjectIds, attendance, active: true, createdAt: new Date().toISOString().slice(0, 10) });
            saveState(); closeTeacherModal(); renderTeachers(); showToast(tlEditing ? 'Teacher link updated.' : 'Teacher link created. Copy it and send it to the teacher.', 'success');
        }
        async function copyTeacherLink(id) {
            const tc = appState.teachers.find(x => x.id === id); if (!tc) return;
            try { await navigator.clipboard.writeText(teacherLink(tc)); showToast('Link copied.', 'success'); } catch (e) { window.prompt('Copy this link:', teacherLink(tc)); }
        }
        function shareTeacherLink(id) {
            const tc = appState.teachers.find(x => x.id === id); if (!tc) return;
            window.open('https://wa.me/?text=' + encodeURIComponent(`Marks entry link for ${tc.name} \u2014 ${appState.madrasa.name}\n${teacherLink(tc)}\n(Private link: please do not share it.)`), '_blank');
        }
        function toggleTeacher(id) { const tc = appState.teachers.find(x => x.id === id); if (!tc) return; tc.active = tc.active === false; saveState(); renderTeachers(); showToast(tc.active ? 'Link turned on.' : 'Link turned off. The teacher can no longer enter marks.', 'info'); }
        function regenTeacher(id) { const tc = appState.teachers.find(x => x.id === id); if (!tc || !confirm(`Make a new link for ${tc.name}? The old link will stop working.`)) return; tc.token = newToken(); saveState(); renderTeachers(); showToast('New link created. Send it to the teacher.', 'success'); }
        function deleteTeacher(id) { const tc = appState.teachers.find(x => x.id === id); if (!tc || !confirm(`Delete the link of ${tc.name}? It will stop working immediately.`)) return; appState.teachers = appState.teachers.filter(x => x.id !== id); saveState(); renderTeachers(); showToast('Link deleted.', 'info'); }

        // ================= TEACHER MARKS-ENTRY PAGE (opened from a private link) =================
        const TE = { token: '', roster: null, prev: null, seq: 0 };
        const teEl = id => document.getElementById(id);
        function teMsg(text, ok) { const el = teEl('te-msg'); el.textContent = text; el.className = 'rounded-xl p-4 text-sm ' + (ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'); }
        function teLoading(on) { teEl('te-loading').classList.toggle('hidden', !on); if (on) teEl('te-sheet').classList.add('hidden'); }
        async function initEntry() {
            teEl('entry-view').classList.remove('hidden'); teLoading(true);
            const seg = location.pathname.split('/').filter(Boolean), i = seg.indexOf('entry'); TE.token = seg[i + 1] || '';
            try { TE.roster = await api(`${API_T}/entry/${TE.token}`); } catch (e) { teLoading(false); teMsg(e.message, false); return; }
            const r = TE.roster; applyAccent((r.madrasa || {}).accent || '');
            teEl('te-inst').textContent = r.madrasa.name || 'Marks entry'; teEl('te-who').textContent = 'Marks entry \u00b7 ' + r.teacher; document.title = 'Marks entry - ' + (r.madrasa.name || '');
            if (r.madrasa.logo) { const lg = teEl('te-logo'); lg.src = r.madrasa.logo; lg.classList.remove('hidden'); }
            if (!r.exams.length || !r.subjects.length) { teLoading(false); teMsg(!r.exams.length ? 'No exam has been created yet. Please ask the administrator.' : 'No subject is available for this link yet. Please ask the administrator.', false); return; }
            let last = {}; try { last = JSON.parse(localStorage.getItem('te_' + TE.token) || '{}'); } catch (e) { }
            teEl('te-exam').innerHTML = r.exams.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
            teEl('te-exam').value = r.exams.some(x => x.id === last.exam) ? last.exam : r.exams[r.exams.length - 1].id;
            teEl('te-class').innerHTML = r.classes.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
            if (r.classes.some(x => x.id === last.cls)) teEl('te-class').value = last.cls;
            teFillSubjects(last.sub); teEl('te-ctrl').classList.remove('hidden'); await teLoad(true);
        }
        function teFillSubjects(want) {
            const cid = teEl('te-class').value, subs = TE.roster.subjects.filter(x => x.classId === cid);
            teEl('te-subject').innerHTML = subs.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('') + (TE.roster.attendance && cid ? seAttOption : '');
            if (want && [...teEl('te-subject').options].some(o => o.value === want)) teEl('te-subject').value = want;
        }
        function teGuard() {
            if (teEl('te-sheet').dataset.dirty && !confirm('You have marks that are not saved yet. Discard them?')) {
                if (TE.prev) { teEl('te-exam').value = TE.prev.exam; teEl('te-class').value = TE.prev.cls; teFillSubjects(TE.prev.sub); }
                return false;
            }
            return true;
        }
        function teClassChange() { if (!teGuard()) return; teEl('te-sheet').dataset.dirty = ''; teFillSubjects(''); teLoad(true); }
        async function teLoad(skipGuard) {
            if (!skipGuard && !teGuard()) return;
            const seq = ++TE.seq, box = teEl('te-sheet'), examId = teEl('te-exam').value, cid = teEl('te-class').value, subId = teEl('te-subject').value, att = subId === SE_ATT;
            const ex = TE.roster.exams.find(x => x.id === examId), cls = TE.roster.classes.find(x => x.id === cid);
            const sub = att ? (cls && TE.roster.attendance ? { att: true, id: SE_ATT, name: 'Attendance', maxMarks: cls.workingDays, passingMarks: 0 } : null) : TE.roster.subjects.find(x => x.id === subId);
            box.dataset.dirty = ''; teEl('te-msg').className = 'hidden';
            if (!sub || !ex) { teLoading(false); box.classList.add('hidden'); return; }
            teLoading(true); // hide the old sheet right away: nobody can type while the new data loads
            try {
                const r = await api(`${API_T}/entry/${TE.token}?exam=${encodeURIComponent(examId)}&subject=${encodeURIComponent(subId)}${att ? '&class=' + encodeURIComponent(cid) : ''}`);
                if (seq !== TE.seq) return;
                TE.prev = { exam: examId, cls: cid, sub: subId }; try { localStorage.setItem('te_' + TE.token, JSON.stringify(TE.prev)); } catch (e) { }
                const students = TE.roster.students.filter(x => x.classId === cid).sort(seNat);
                seHead(box, att, att ? `Attendance \u2014 ${cls.name}` : `${sub.name} \u2014 ${cls ? cls.name : ''}`,
                    att ? `${ex.name} \u00b7 Total working days: ${sub.maxMarks} \u00b7 ${students.length} students` : `${ex.name} \u00b7 Max ${sub.maxMarks} \u00b7 Pass ${sub.passingMarks} \u00b7 ${students.length} students`);
                box.querySelector('.se-rows').innerHTML = seRows(students, sub, att ? id => r.att[id] : id => r.marks[id]);
                seGenderBar(box, students);
                teEl('te-saved').textContent = ''; seRefresh(box); teLoading(false); box.classList.remove('hidden');
            } catch (e) { if (seq !== TE.seq) return; teLoading(false); box.classList.add('hidden'); teMsg(e.message, false); }
        }
        async function teSave() {
            const box = teEl('te-sheet'), btn = teEl('te-save'), changed = seRead(box, true);
            if (!Object.keys(changed).length) { box.dataset.dirty = ''; showToast('No changes to save.', 'info'); return; }
            btn.disabled = true; btn.classList.add('opacity-60');
            try {
                await api(`${API_T}/entry/${TE.token}`, { method: 'POST', body: { examId: teEl('te-exam').value, subjectId: teEl('te-subject').value, classId: teEl('te-class').value, marks: changed } });
                seMarkSaved(box); box.dataset.dirty = ''; teEl('te-saved').textContent = 'Saved at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); showToast(box.dataset.mode === 'att' ? 'Attendance saved.' : 'Marks saved.', 'success');
            } catch (e) { showToast(e.message || 'Could not save. Check your connection and try again.', 'error'); }
            finally { btn.disabled = false; btn.classList.remove('opacity-60'); }
        }
        window.addEventListener('beforeunload', e => { const b = document.getElementById('te-sheet'); if (b && b.dataset.dirty) { e.preventDefault(); e.returnValue = ''; } });

        // ================= BULK STUDENT MARKSHEETS (same design as the public page) =================
        // Builds the same data the public result API returns, from the admin's local data.
        function buildMarksheetData(ex, st) {
            const G = appState.grades, cls = appState.classes.find(c => c.id === st.classId);
            if (!cls) return null;
            const subsAll = appState.subjects.filter(s => s.classId === st.classId);
            const take = m => subsAll.filter(s => isActive(s) && m && m[s.id] !== undefined);
            const maxOf = l => l.reduce((a, s) => a + Number(s.maxMarks), 0);
            const subOk = (m, s) => !isAb(m && m[s.id]) && (Number(m && m[s.id]) || 0) >= Number(s.passingMarks);
            const mine = appState.results.filter(r => r.studentId === st.id);
            const cur = mine.find(r => r.examId === ex.id);
            if (!cur) return null;
            const actSubs = subsAll.filter(isActive), complete = m => actSubs.every(s => m && m[s.id] !== undefined);
            if (!complete(cur.marks)) return null; // marks still pending
            const marks = cur.marks || {}, mySubs = take(marks), maxPer = maxOf(mySubs);
            const obtained = sumMarks(marks, mySubs), passed = mySubs.length > 0 && mySubs.every(s => subOk(marks, s));
            const myPct = exactPct(obtained, maxPer);
            const mateIds = new Set(appState.students.filter(s => s.classId === st.classId).map(s => s.id));
            const pcts = appState.results.filter(r => r.examId === ex.id && mateIds.has(r.studentId) && complete(r.marks)).map(r => { const l = take(r.marks); return exactPct(sumMarks(r.marks, l), maxOf(l)); });
            const exams = appState.exams.filter(e => e.isPublic).map(e => ({ e, r: mine.find(r => r.examId === e.id) })).filter(x => x.r && complete(x.r.marks)).map(({ e, r }) => {
                const l = take(r.marks), o = sumMarks(r.marks, l), mx = maxOf(l), ok = l.length > 0 && l.every(s => subOk(r.marks, s));
                return { name: e.name, obtained: o, max: mx, percentage: pctOf(o, mx), passed: ok, grade: gradeOf(exactPct(o, mx), !ok, G) };
            });
            const oObt = exams.reduce((a, x) => a + x.obtained, 0), oMax = exams.reduce((a, x) => a + x.max, 0), failedCount = exams.filter(x => !x.passed).length;
            return {
                madrasa: appState.madrasa, exam: { id: ex.id, name: ex.name },
                cls: { name: cls.name, totalWorkingDays: Number(cls.totalWorkingDays) || 200, teacherTitle: cls.teacherTitle || '', teacherName: cls.teacherName || '', teacherSign: (appState.classSigns || {})[cls.id] || '' },
                subjects: mySubs.map(s => ({ id: s.id, name: s.name, maxMarks: Number(s.maxMarks), passed: subOk(marks, s) })),
                details: [{ label: 'Student Name', value: st.name }, ...appState.fields.filter(f => f.show).map(f => ({ label: f.label, value: f.id === 'admissionNo' ? st.admissionNo : fieldVal(st, f.id) })).filter(x => x.value)],
                result: { attendanceDays: Number.isFinite(Number(cur.attendanceDays)) ? Number(cur.attendanceDays) : 0, marks, grades: Object.fromEntries(mySubs.map(s => [s.id, isAb(marks[s.id]) ? { grade: 'AB', title: 'Absent' } : gradeOf(exactPct(Number(marks[s.id]) || 0, Number(s.maxMarks)), !subOk(marks, s), G)])) },
                summary: { obtained, max: maxPer, percentage: pctOf(obtained, maxPer), passed, grade: gradeOf(myPct, !passed, G) },
                position: appState.portal.showPosition !== false ? { rank: 1 + pcts.filter(p => p > myPct + 1e-9).length, of: pcts.length } : null,
                assistants: (appState.assistants || []).filter(a => a.show && (a.name || a.sign)).map(a => ({ title: a.title, name: a.name, sign: a.sign })),
                exams, overall: { obtained: oObt, max: oMax, percentage: pctOf(oObt, oMax), failedCount, count: exams.length, grade: gradeOf(exactPct(oObt, oMax), failedCount > 0, G) }
            };
        }
        function bulkSelection() {
            const ex = appState.exams.find(e => e.id === document.getElementById('bulk-exam').value), cid = document.getElementById('bulk-class').value;
            const classes = cid === 'ALL' ? appState.classes : appState.classes.filter(c => c.id === cid);
            const natural = (a, b) => String(a.admissionNo).localeCompare(String(b.admissionNo), undefined, { numeric: true, sensitivity: 'base' });
            const list = [], missing = [];
            if (ex) classes.forEach(c => appState.students.filter(s => s.classId === c.id && genderMatch(s, GF.bulk)).sort(natural).forEach(st => { const d = buildMarksheetData(ex, st); (d ? list : missing).push(d || st); }));
            return { ex, classes, list, missing };
        }
        function updateBulkInfo() {
            const el = document.getElementById('bulk-info'); if (!el) return;
            const bgc = document.getElementById('bulk-gchips'); if (bgc) { const c = genderCounts(appState.students); bgc.innerHTML = c.M || c.F ? genderChips('bulk', c) : ''; }
            const { ex, list, missing } = bulkSelection();
            el.textContent = !ex ? 'Create an exam and a class first.' : `${list.length} marksheet${list.length === 1 ? '' : 's'} will be created` + (missing.length ? ` (${missing.length} student${missing.length === 1 ? '' : 's'} without complete marks for this exam will be skipped).` : '.') + ' In the print window choose "Save as PDF".';
        }
        async function printBulkMarksheets() {
            const { ex, classes, list } = bulkSelection();
            if (!ex || !list.length) { showToast('No results entered for this selection.', 'error'); return; }
            const btn = document.getElementById('bulk-btn'), html = btn.innerHTML; btn.disabled = true; btn.classList.add('opacity-60'); btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Preparing ${list.length}...`;
            let root = null; const blobs = [], cache = new Map();
            try {
                await new Promise(r => setTimeout(r, 50));
                // logos/signatures are big text strings: turn each into one short blob link so hundreds of pages stay light
                const blobFor = async u => { if (!u || !(u.startsWith('data:') || u.startsWith('/'))) return u || ''; if (!cache.has(u)) { try { const b = URL.createObjectURL(await (await fetch(u)).blob()); blobs.push(b); cache.set(u, b); } catch (e) { cache.set(u, u); } } return cache.get(u); };
                const m0 = appState.madrasa, logo0 = (m0.logo || '').trim();
                const madrasa = { ...m0, logo: await blobFor(logo0 ? await trimImage(logo0) : ''), headSign: await blobFor(m0.headSign) };
                for (const d of list) d.cls.teacherSign = await blobFor(d.cls.teacherSign);
                const assistants = []; for (const a of (list[0].assistants || [])) assistants.push({ ...a, sign: await blobFor(a.sign) });
                root = document.createElement('div'); root.id = 'print-root';
                root.innerHTML = list.map((d, i) => `<div class="ms-sheet ms-bulk">${marksheetHTML({ ...d, madrasa, assistants }, 'b' + i)}</div>`).join('');
                document.body.appendChild(root); document.body.classList.add('print-bulk');
                await Promise.all([...root.querySelectorAll('img')].slice(0, 2).map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
                const old = document.title;
                document.title = fileSafe(`Marksheets_${classes.length === 1 ? classes[0].name : 'All Classes'}_${ex.name}${GF.bulk !== 'ALL' ? '_' + GF_LABEL[GF.bulk] : ''}`).replace(/ /g, '_');
                const done = () => { document.title = old; document.body.classList.remove('print-bulk'); root.remove(); blobs.forEach(u => URL.revokeObjectURL(u)); window.removeEventListener('afterprint', done); };
                window.addEventListener('afterprint', done);
                setTimeout(() => window.print(), 100);
            } catch (e) {
                document.body.classList.remove('print-bulk'); if (root) root.remove(); showToast('Could not prepare the marksheets.', 'error');
            } finally { btn.disabled = false; btn.classList.remove('opacity-60'); btn.innerHTML = html; }
        }

        function printClassReport() {
            const src = document.getElementById('class-print-area');
            if (!src.querySelector('table')) { showToast('No results to print for this selection.', 'error'); return; }
            const root = document.createElement('div'); root.id = 'print-root'; root.innerHTML = src.innerHTML;
            document.body.appendChild(root); document.body.classList.add('print-class');
            const done = () => { document.body.classList.remove('print-class'); root.remove(); window.removeEventListener('afterprint', done); };
            window.addEventListener('afterprint', done);
            setTimeout(() => window.print(), 80);
        }

        function closeResultCard() {
            document.getElementById('result-display-container').classList.add('hidden');
        }

        // ================= ADMIN AUTHENTICATION & NAVIGATION =================
        async function handleAdminLogin(e) {
            e.preventDefault();
            const username = document.getElementById('login-username').value.trim();
            const password = document.getElementById('login-password').value;
            const lb = e.target.querySelector('button[type=submit]'), lbHtml = lb ? lb.innerHTML : ''; if (lb) { lb.disabled = true; lb.innerHTML = '<span class="btn-spin"></span>Signing in...'; }
            try {
                const { token: t } = await api('/login', { method: 'POST', body: { slug: TENANT, username, password } });
                token = t; localStorage.setItem(TOKEN_KEY, t);
                isAdminAuthenticated = true;
                document.getElementById('login-password').value = '';
                document.getElementById('admin-login-screen').classList.add('hidden');
                document.getElementById('admin-dashboard').classList.remove('hidden');
                switchAdminTab('overview');
                showAppLoader('Loading your data...');
                await loadAdminState();
                showToast("Welcome to the Admin Panel", "success");
            } catch (err) {
                isAdminAuthenticated = false;
                showToast(err.message, "error");
            } finally { hideAppLoader(); if (lb) { lb.disabled = false; lb.innerHTML = lbHtml; } }
        }

        function handleAdminLogout() {
            token = ''; localStorage.removeItem(TOKEN_KEY); idbDel(admKey()); ADM.arev = -1; // nothing of the institution stays on a shared computer
            isAdminAuthenticated = false; snapshot = null;
            closeSidebar();
            appState = emptyState();
            switchView('admin');
            showToast("Logged out successfully.", "info");
        }

        function switchAdminTab(tabId) {
            closeSidebar();
            currentAdminTab = tabId; setTimeout(updateFab, 0);
            const titles = {
                overview: "Overview, Institution Branding & Announcements",
                academics: "Examination, Class & Subject Configuration",
                students: "Student Registration & CSV Bulk Import",
                marks: "Student Marks & Attendance Entry",
                reports: "Class Result Sheets (PDF)",
                setup: "Setup: Portal, Grading & Student Fields"
            };
            document.getElementById('admin-page-title').textContent = titles[tabId] || "Dashboard";

            document.querySelectorAll('.admin-tab-content').forEach(el => el.classList.add('hidden'));
            document.getElementById(`admin-tab-${tabId}`).classList.remove('hidden');

            document.querySelectorAll('.admin-tab-btn').forEach(btn => {
                btn.className = "admin-tab-btn w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition whitespace-nowrap text-emerald-200 hover:bg-emerald-900/60";
            });
            const activeBtn = document.getElementById(`tab-btn-${tabId}`);
            if (activeBtn) {
                activeBtn.className = "admin-tab-btn w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition whitespace-nowrap bg-amber-500 text-slate-950 shadow";
            }

            if (tabId === 'marks') initMarksEntrySelectors();
            if (tabId === 'reports') renderReportSelectors();
            if (tabId === 'setup') renderSetup();
        }

        // ---- Overview form: unsaved changes (logo, name, signature, colour...) survive any background refresh ----
        let profileDirty = false, pendingLogoCropped = false, entryDirty = false, suppressEntryReload = false;
        function markProfileDirty() { profileDirty = true; }
        const logoValue = () => pendingLogo !== null ? pendingLogo : (appState.madrasa.logo || '');
        function appNameInput() { const i = document.getElementById('setting-app-name'); document.getElementById('app-name-count').textContent = i.value.length + '/12'; }
        function renderProfileForm() {
            const m = appState.madrasa, g = id => document.getElementById(id);
            if (!profileDirty) {
                pendingLogo = null; pendingAccent = null; pendingHeadSign = null; pendingLogoCropped = false;
                g('setting-madrasa-name').value = m.name; g('setting-madrasa-subtitle').value = m.subtitle;
                g('setting-app-name').value = m.appName || ''; appNameInput();
                const lg = m.logo || '';
                g('setting-madrasa-logo').value = lg.startsWith('data:') ? '' : lg;
                g('setting-madrasa-logo').placeholder = lg.startsWith('data:') ? 'Using the uploaded image' : 'https://example.com/logo.png';
                g('setting-share-text').value = m.shareText || ''; g('setting-head-title').value = m.headTitle || ''; g('setting-head-name').value = m.headName || '';
            }
            applyAccent(accentValue()); renderAccentPicker(); setLogoPreview(logoValue()); renderHeadSign(); renderAssistants();
        }
        function renderAllAdminData() {
            // Overview stats
            document.getElementById('stat-students').textContent = appState.students.length;
            { const c = genderCounts(appState.students), el = document.getElementById('stat-students-g'); if (el) el.innerHTML = c.M || c.F ? `<span class="text-sky-700">${c.M} Boys</span> &middot; <span class="text-pink-700">${c.F} Girls</span>${c.U ? ` &middot; <span class="text-slate-400">${c.U} Not set</span>` : ''}` : ''; }
            document.getElementById('stat-classes').textContent = appState.classes.length;
            document.getElementById('stat-exams').textContent = appState.exams.filter(e => e.isPublic).length;
            document.getElementById('stat-results').textContent = appState.results.length;
            renderInstOverview();

            renderProfileForm();

            updateCounts();
            renderAdminAnnouncements();
            renderAdminExams();
            renderAdminClasses();
            suppressEntryReload = entryDirty; populateClassDropdowns(); suppressEntryReload = false; // keep marks that are still being typed
            renderAdminSubjects();
            renderAdminStudents();
            renderStudentForm();
            renderReportSelectors();
            renderSetup();
            renderTeachers();
            if (entryMode === 'subject') renderSubjectSelectors();
        }

        // ================= TAB 1: SETTINGS & ANNOUNCEMENTS =================
        function saveMadrasaSettings(e) {
            e.preventDefault();
            const m = appState.madrasa, g = id => document.getElementById(id);
            m.name = g('setting-madrasa-name').value.trim();
            m.subtitle = g('setting-madrasa-subtitle').value.trim();
            m.appName = g('setting-app-name').value.trim().slice(0, 12);
            const cur = m.logo || '', urlIn = normalizeLogoUrl(g('setting-madrasa-logo').value);
            m.logo = pendingLogo !== null ? pendingLogo : (urlIn ? urlIn : (cur.startsWith('data:') ? cur : '')); // an uploaded logo is never wiped by an empty link box
            if (pendingLogo !== null) m.logoCropped = !!pendingLogoCropped && !!pendingLogo; else if (urlIn && urlIn !== cur) m.logoCropped = false;
            m.shareText = g('setting-share-text').value.trim();
            m.headTitle = g('setting-head-title').value.trim();
            m.headName = g('setting-head-name').value.trim();
            if (pendingHeadSign !== null) m.headSign = pendingHeadSign;
            if (pendingAccent !== null) m.accent = pendingAccent;
            appState.assistants = (appState.assistants || []).filter(a => a.title || a.name || a.sign);
            pendingLogo = null; pendingAccent = null; pendingHeadSign = null; pendingLogoCropped = false; profileDirty = false;
            renderProfileForm();
            saveState();
            showToast("Institution profile updated!", "success");
        }

        function renderAdminAnnouncements() {
            const container = document.getElementById('admin-announcements-list');
            if (appState.announcements.length === 0) {
                container.innerHTML = `<p class="text-xs text-slate-400 italic py-4 text-center">No active announcements.</p>`;
                return;
            }
            container.innerHTML = appState.announcements.map((text, idx) => `
                <div class="flex items-center justify-between gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200 text-xs">
                    <span class="text-slate-700 font-medium">${esc(text)}</span>
                    <button onclick="editAnnouncement(${idx})" class="text-sky-600 hover:text-sky-800 px-2 py-1 shrink-0" aria-label="Edit"><i class="fas fa-pen"></i></button>
                    <button onclick="deleteAnnouncement(${idx})" class="text-red-500 hover:text-red-700 px-2 py-1 shrink-0">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            `).join('');
        }

        function addAnnouncement(e) {
            e.preventDefault();
            const input = document.getElementById('new-announcement-text');
            if (input.value.trim()) {
                appState.announcements.unshift(input.value.trim());
                input.value = '';
                saveState();
                renderAdminAnnouncements();
                showToast("Announcement published on public portal!", "success");
            }
        }

        function deleteAnnouncement(index) {
            appState.announcements.splice(index, 1);
            saveState();
            renderAdminAnnouncements();
            showToast("Announcement removed.", "info");
        }


        // ================= TAB 2: EXAMS, CLASSES & SUBJECTS =================
        function createExam(e) {
            e.preventDefault();
            const name = document.getElementById('new-exam-name').value.trim();
            const isPublic = document.getElementById('new-exam-public').checked;
            appState.exams.push({
                id: 'EX_' + Date.now(),
                name,
                isPublic
            });
            document.getElementById('new-exam-name').value = '';
            saveState();
            renderAllAdminData();
            showToast(`Exam "${name}" created.`, "success");
        }

        function toggleExamVisibility(examId) {
            const ex = appState.exams.find(e => e.id === examId);
            if (ex) {
                ex.isPublic = !ex.isPublic;
                saveState();
                renderAllAdminData();
                showToast(`Exam visibility updated.`, "info");
            }
        }

        function deleteExam(examId) {
            const ex = appState.exams.find(e => e.id === examId);
            if (ex && !confirm(`Delete exam "${ex.name}" and all its results?`)) return;
            if (appState.exams.length <= 1) {
                showToast("At least one examination must remain in the system.", "error");
                return;
            }
            appState.exams = appState.exams.filter(e => e.id !== examId);
            appState.results = appState.results.filter(r => r.examId !== examId);
            saveState();
            renderAllAdminData();
            showToast("Exam deleted.", "info");
        }

        function createClass(e) {
            e.preventDefault();
            const name = document.getElementById('new-class-name').value.trim();
            const days = Number(document.getElementById('new-class-days').value);
            appState.classes.push({
                id: 'CLS_' + Date.now(),
                name,
                totalWorkingDays: days,
                teacherTitle: document.getElementById('new-class-teacher-title').value.trim(),
                teacherName: document.getElementById('new-class-teacher-name').value.trim()
            });
            document.getElementById('new-class-name').value = '';
            document.getElementById('new-class-teacher-title').value = '';
            document.getElementById('new-class-teacher-name').value = '';
            saveState();
            renderAllAdminData();
            showToast(`Class "${name}" added!`, "success");
        }

        function updateClassTeacher(classId, key, value) {
            const cls = appState.classes.find(c => c.id === classId);
            if (!cls) return;
            cls[key] = value.trim();
            saveState();
            showToast(`Class teacher updated for ${cls.name}.`, "success");
        }

        function updateClassWorkingDays(classId, newDays) {
            const cls = appState.classes.find(c => c.id === classId);
            if (cls && Number(newDays) > 0) {
                cls.totalWorkingDays = Number(newDays);
                saveState();
                showToast(`Total working days updated for ${cls.name}.`, "success");
            }
        }

        function deleteClass(classId) {
            const cl = appState.classes.find(c => c.id === classId);
            if (cl && !confirm(`Delete class "${cl.name}" and its subjects?`)) return;
            if (appState.classes.length <= 1) {
                showToast("Cannot delete the only class.", "error");
                return;
            }
            appState.classes = appState.classes.filter(c => c.id !== classId);
            appState.subjects = appState.subjects.filter(s => s.classId !== classId);
            saveState();
            renderAllAdminData();
            showToast("Class and its subjects removed.", "info");
        }

        function populateClassDropdowns() {
            const opts = appState.classes.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
            const withAll = `<option value="ALL">All Classes</option>` + opts;
            const first = appState.classes[0] ? appState.classes[0].id : '';
            const fill = (id, html, fallback) => { const el = document.getElementById(id), cur = el.value; el.innerHTML = html; el.value = [...el.options].some(o => o.value === cur) ? cur : fallback; };
            fill('student-list-filter-class', withAll, 'ALL'); fill('subject-filter-class', withAll, first || 'ALL');
        }

        function createSubject(e) {
            e.preventDefault();
            const classId = document.getElementById('new-subject-class').value;
            if (!classId) { showToast('Create a class first.', 'error'); return; }
            const name = document.getElementById('new-subject-name').value.trim();
            const maxMarks = Number(document.getElementById('new-subject-max').value);
            const passingMarks = Number(document.getElementById('new-subject-pass').value);

            if (passingMarks > maxMarks) {
                showToast("Passing marks cannot exceed Maximum marks!", "error");
                return;
            }

            appState.subjects.push({
                id: 'SUB_' + Date.now(),
                classId,
                name,
                maxMarks,
                passingMarks
            });
            document.getElementById('new-subject-name').value = '';
            saveState();
            renderAdminSubjects();
            renderAdminClasses();
            showToast(`Subject "${name}" added.`, "success");
        }

        function deleteSubject(subId) {
            const sb = appState.subjects.find(x => x.id === subId);
            if (sb && !confirm(`Remove subject "${sb.name}"? Its marks will no longer count.`)) return;
            appState.subjects = appState.subjects.filter(s => s.id !== subId);
            saveState();
            renderAdminSubjects();
            renderAdminClasses();
            showToast("Subject removed.", "info");
        }

        // ================= TAB 3: STUDENT MANAGEMENT & CSV IMPORT =================
        function registerStudent(e) {
            e.preventDefault();
            const admissionNo = document.getElementById('std-adm-no').value.trim().toUpperCase();
            const name = document.getElementById('std-name').value.trim();
            const classId = document.getElementById('std-class').value;
            if (!classId) { showToast('Create a class first.', 'error'); return; }
            if (appState.students.some(s => s.admissionNo.toUpperCase() === admissionNo)) {
                showToast(`${admLabel()} ${admissionNo} already exists!`, "error");
                return;
            }
            let fatherName = ''; const extra = {};
            appState.fields.filter(f => f.id !== 'admissionNo').forEach(f => {
                const v = (document.getElementById('std-f-' + f.id)?.value || '').trim();
                if (f.id === 'fatherName') fatherName = v; else if (v) extra[f.id] = v;
            });
            appState.students.push({ id: 'ST_' + Date.now(), admissionNo, name, fatherName, extra, classId });
            document.getElementById('std-adm-no').value = '';
            document.getElementById('std-name').value = '';
            document.querySelectorAll('#std-extra-fields input').forEach(i => i.value = '');
            saveState();
            renderAllAdminData();
            showToast(`Student ${name} (${admissionNo}) registered!`, "success");
        }

        let editingStudentId = null;
        function openStudentEdit(id) {
            const st = appState.students.find(x => x.id === id); if (!st) return;
            editingStudentId = id;
            document.getElementById('edit-adm-label').textContent = admLabel();
            document.getElementById('edit-adm-no').value = st.admissionNo;
            document.getElementById('edit-name').value = st.name;
            document.getElementById('edit-class').innerHTML = appState.classes.map(c => `<option value="${esc(c.id)}" ${c.id === st.classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
            document.getElementById('edit-gender-wrap').innerHTML = genderToggleHTML('edit-gender', genderOf(st));
            document.getElementById('edit-extra-fields').innerHTML = appState.fields.filter(f => f.id !== 'admissionNo' && f.id !== 'gender').map(f =>
                `<div><label class="block text-xs font-bold uppercase text-slate-600 mb-1">${esc(f.label)}</label><input type="text" id="edit-f-${esc(f.id)}" value="${esc(fieldVal(st, f.id))}" maxlength="200" class="w-full px-3.5 py-2.5 border border-slate-300 rounded-lg text-sm"></div>`).join('');
            document.getElementById('student-edit-modal').classList.remove('hidden');
            document.body.classList.add('overflow-hidden');
        }
        function closeStudentEdit() {
            document.getElementById('student-edit-modal').classList.add('hidden');
            document.body.classList.remove('overflow-hidden');
            editingStudentId = null;
        }
        function saveStudentEdit(e) {
            e.preventDefault();
            const st = appState.students.find(x => x.id === editingStudentId); if (!st) return;
            const admissionNo = document.getElementById('edit-adm-no').value.trim().toUpperCase();
            const name = document.getElementById('edit-name').value.trim();
            const classId = document.getElementById('edit-class').value;
            if (appState.students.some(x => x.id !== st.id && x.admissionNo.toUpperCase() === admissionNo)) { showToast(`${admLabel()} ${admissionNo} already belongs to another student.`, 'error'); return; }
            if (classId !== st.classId && appState.results.some(r => r.studentId === st.id) &&
                !confirm('This student already has marks. Marks were entered for the old class subjects and will not count in the new class. Continue?')) return;
            const extra = { ...(st.extra || {}) };
            appState.fields.filter(f => f.id !== 'admissionNo' && f.id !== 'gender').forEach(f => {
                const v = (document.getElementById('edit-f-' + f.id)?.value || '').trim();
                if (f.id === 'fatherName') st.fatherName = v; else if (v) extra[f.id] = v; else delete extra[f.id];
            });
            const gv = gtVal('edit-gender'); if (gv) extra.gender = gv; else delete extra.gender;
            Object.assign(st, { admissionNo, name, classId, extra });
            saveState();
            renderAllAdminData();
            closeStudentEdit();
            showToast(`${name} updated.`, 'success');
        }

        function deleteStudent(studentId) {
            const st = appState.students.find(s => s.id === studentId);
            if (st && !confirm(`Delete ${st.name} and all their results? This cannot be undone.`)) return;
            appState.students = appState.students.filter(s => s.id !== studentId);
            appState.results = appState.results.filter(r => r.studentId !== studentId);
            saveState();
            renderAllAdminData();
            showToast("Student record deleted.", "info");
        }

        function parseCSVLine(line) {
            const out = []; let cur = '', q = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
                else if (ch === '"') q = true;
                else if (ch === ',') { out.push(cur.trim()); cur = ''; }
                else cur += ch;
            }
            out.push(cur.trim());
            return out;
        }

        function downloadSampleCSV() {
            const labels = appState.fields.filter(f => f.id !== 'admissionNo' && f.id !== 'gender').map(f => f.label);
            const cls = appState.classes[0] ? appState.classes[0].name : 'Class 1';
            const sample = n => [n === 1 ? 'ADM108' : 'ADM109', n === 1 ? 'Hassan Ali' : 'Maryam Bibi', ...labels.map(l => 'Sample ' + l), cls, n === 1 ? 'Boy' : 'Girl'];
            const csv = [[admLabel(), 'Name', ...labels, 'ClassName', 'Gender'], sample(1), sample(2)].map(r => r.map(c => `"${c}"`).join(",")).join("\n");
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
            link.download = "students_sample.csv";
            document.body.appendChild(link); link.click(); link.remove();
        }

        function exportStudentsCSV() { // edit gender in Excel / Sheets, then upload the same file again: gender of existing students is filled in
            if (!appState.students.length) { showToast('No students to export yet.', 'info'); return; }
            const fields = appState.fields.filter(f => f.id !== 'admissionNo' && f.id !== 'gender'), q = c => `"${String(c ?? '').replace(/"/g, '""')}"`;
            const nat = (a, b) => String(a.admissionNo).localeCompare(String(b.admissionNo), undefined, { numeric: true, sensitivity: 'base' });
            const rows = [[admLabel(), 'Name', ...fields.map(f => f.label), 'ClassName', 'Gender']];
            appState.classes.forEach(c => appState.students.filter(s => s.classId === c.id).sort(nat).forEach(s => rows.push([s.admissionNo, s.name, ...fields.map(f => fieldVal(s, f.id)), c.name, genderName(genderOf(s))])));
            const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' })); link.download = fileSafe('students_' + (appState.madrasa.name || 'list')).replace(/ /g, '_') + '.csv';
            document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 4000);
        }
        function processCSVUpload() {
            const fileInput = document.getElementById('csv-file-input');
            if (!fileInput.files || fileInput.files.length === 0) { showToast("Please select a .CSV file first.", "error"); return; }
            const reader = new FileReader();
            reader.onload = function (e) {
                const lines = String(e.target.result).replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
                if (lines.length < 2) { showToast("CSV file is empty or missing data rows.", "error"); return; }
                const norm = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
                const targetOf = h => {
                    const n = norm(h);
                    if (['gender', 'sex', 'boygirl', 'mf', 'malefemale'].includes(n)) return 'gender';
                    if (['admissionno', 'admissionnumber', 'admno', 'rollno', 'rollnumber'].includes(n) || n === norm(admLabel())) return 'admissionNo';
                    if (['name', 'fullname', 'studentname'].includes(n)) return 'name';
                    if (['classname', 'class'].includes(n)) return 'class';
                    const f = appState.fields.find(f => f.id !== 'admissionNo' && (norm(f.label) === n || norm(f.id) === n));
                    if (f) return f.id;
                    return ['fathername', 'guardian', 'fatherguardian'].includes(n) ? 'fatherName' : null;
                };
                let targets = parseCSVLine(lines[0]).map(targetOf), start = 1;
                if (!targets.includes('admissionNo') || !targets.includes('name')) { targets = ['admissionNo', 'name', 'fatherName', 'class']; start = 0; }
                let imported = 0, skipped = 0, genderSet = 0, genderBad = 0;
                for (let i = start; i < lines.length; i++) {
                    const cols = parseCSVLine(lines[i]), rec = {};
                    targets.forEach((t, j) => { if (t && cols[j] !== undefined) rec[t] = cols[j]; });
                    const admNo = (rec.admissionNo || '').toUpperCase();
                    if (!admNo || !rec.name) continue;
                    const gnorm = normGender(rec.gender); if (rec.gender && !gnorm) genderBad++;
                    const dup = appState.students.find(s => s.admissionNo.toUpperCase() === admNo);
                    if (dup) { skipped++; if (gnorm && genderOf(dup) !== gnorm) { dup.extra = dup.extra || {}; dup.extra.gender = gnorm; genderSet++; } continue; } // a repeated student is not added again, but his/her gender is filled in
                    const className = rec.class || (appState.classes[0] && appState.classes[0].name) || 'General';
                    let target = appState.classes.find(c => c.name.toLowerCase() === className.toLowerCase());
                    if (!target) { target = { id: 'CLS_' + Date.now() + '_' + i, name: className, totalWorkingDays: 200 }; appState.classes.push(target); }
                    const extra = {};
                    appState.fields.filter(f => f.id !== 'admissionNo' && f.id !== 'fatherName' && f.id !== 'gender').forEach(f => { if (rec[f.id]) extra[f.id] = rec[f.id]; });
                    if (gnorm) extra.gender = gnorm;
                    appState.students.push({ id: 'ST_' + Date.now() + '_' + i, admissionNo: admNo, name: rec.name, fatherName: rec.fatherName || '', extra, classId: target.id });
                    imported++;
                }
                fileInput.value = '';
                saveState(); renderAllAdminData();
                showToast(`CSV Import Complete: ${imported} added, ${skipped} duplicates skipped${genderSet ? `, gender updated for ${genderSet}` : ''}.${genderBad ? ` ${genderBad} Gender value(s) not understood (use Boy / Girl).` : ''}`, genderBad ? 'info' : 'success');
            };
            reader.readAsText(fileInput.files[0]);
        }

        // ================= TAB 4: MARKS & ATTENDANCE ENTRY =================
        function jumpToStudentMarks(studentId, classId) {
            switchAdminTab('marks');
            document.getElementById('entry-class-select').value = classId;
            populateEntryStudentDropdown();
            document.getElementById('entry-student-select').value = studentId;
            loadMarksEntrySheet();
        }

        function initMarksEntrySelectors() {
            const examSel = document.getElementById('entry-exam-select'), classSel = document.getElementById('entry-class-select');
            const ev = examSel.value, cv = classSel.value;
            examSel.innerHTML = appState.exams.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('');
            classSel.innerHTML = appState.classes.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
            if ([...examSel.options].some(o => o.value === ev)) examSel.value = ev;
            if ([...classSel.options].some(o => o.value === cv)) classSel.value = cv;
            populateEntryStudentDropdown();
        }

        function populateEntryStudentDropdown() {
            const classId = document.getElementById('entry-class-select').value;
            renderEntryChips();
            const studentSel = document.getElementById('entry-student-select'), prev = studentSel.value, examSel2 = document.getElementById('entry-exam-select').value;
            const list = appState.students.filter(s => s.classId === classId).sort((a, b) => a.name.localeCompare(b.name));
            studentSel.innerHTML = list.length
                ? list.map(s => { const r = appState.results.find(x => x.examId === examSel2 && x.studentId === s.id), act = appState.subjects.filter(x => x.classId === classId && isActive(x)), miss = r ? act.filter(x => r.marks[x.id] === undefined).length : 0;
                    return `<option value="${esc(s.id)}" data-search="${esc(s.admissionNo)}">${esc(s.name)}${r ? (miss ? ` \u2014 ${miss} pending` : ' \u2713') : ''}</option>`; }).join('')
                : `<option value="">No students in this class</option>`;
            if ([...studentSel.options].some(o => o.value === prev)) studentSel.value = prev;
            loadMarksEntrySheet();
        }

        function loadMarksEntrySheet() {
            if (suppressEntryReload) return;
            entryDirty = false;
            const examId = document.getElementById('entry-exam-select').value;
            const classId = document.getElementById('entry-class-select').value;
            const studentId = document.getElementById('entry-student-select').value;

            const workspace = document.getElementById('marks-entry-workspace');
            if (!examId || !classId || !studentId) {
                workspace.classList.add('opacity-50', 'pointer-events-none');
                return;
            }
            workspace.classList.remove('opacity-50', 'pointer-events-none');

            const student = appState.students.find(s => s.id === studentId);
            const cls = appState.classes.find(c => c.id === classId);
            const subjects = appState.subjects.filter(sub => sub.classId === classId);
            const existingResult = appState.results.find(r => r.examId === examId && r.studentId === studentId);
            if (!student || !cls) { workspace.classList.add('opacity-50', 'pointer-events-none'); return; }

            document.getElementById('entry-sheet-student-title').textContent = `${student.name} (${student.admissionNo})`;
            document.getElementById('entry-sheet-subtitle').textContent = `Class: ${cls.name} • ${student.admissionNo}`;
            document.getElementById('entry-total-working-days').textContent = cls.totalWorkingDays;

            const existingBadge = document.getElementById('entry-existing-badge');
            if (existingResult) {
                existingBadge.classList.remove('hidden');
                const ad = existingResult.attendanceDays >= 0 ? existingResult.attendanceDays : cls.totalWorkingDays; document.getElementById('entry-days-present').value = ad; document.getElementById('entry-days-present').dataset.prev = ad;
            } else {
                existingBadge.classList.add('hidden');
                document.getElementById('entry-days-present').value = cls.totalWorkingDays;
            }
            document.getElementById('entry-days-present').max = cls.totalWorkingDays;

            entryDraft = {};
            renderEntryRows(subjects.filter(isActive), existingResult, subjects.length);
        }

        function toggleAbsent(cb) {
            const inp = cb.closest('tr').querySelector('.entry-mark-input');
            inp.disabled = cb.checked;
            if (cb.checked) inp.value = '';
            recalculateLiveEntry();
        }
        function markAllAbsent() {
            document.querySelectorAll('.entry-absent').forEach(cb => { cb.checked = true; toggleAbsent(cb); });
        }

        function recalculateLiveEntry() {
            const classId = document.getElementById('entry-class-select').value;
            const cls = appState.classes.find(c => c.id === classId);
            const totalDays = cls ? Number(cls.totalWorkingDays) : 200;
            const daysPresent = Number(document.getElementById('entry-days-present').value || 0);
            const attPerc = totalDays > 0 ? Math.min(100, ((daysPresent / totalDays) * 100)).toFixed(1) : 0;
            document.getElementById('entry-live-att-perc').textContent = `${attPerc}%`;

            const inputs = document.querySelectorAll('.entry-mark-input');
            let totalMax = 0, totalObtained = 0, failed = false, pending = 0;

            inputs.forEach(inp => {
                const subId = inp.getAttribute('data-subject-id');
                const max = Number(inp.getAttribute('data-max'));
                const pass = Number(inp.getAttribute('data-pass'));
                const abBox = inp.closest('tr').querySelector('.entry-absent'), ab = !!(abBox && abBox.checked);
                const blank = !ab && inp.value === '';
                const val = (ab || blank) ? 0 : Number(inp.value);
                const statusSpan = document.getElementById(`live-sub-status-${subId}`);
                if (ab) {
                    totalMax += max; failed = true;
                    statusSpan.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700";
                    statusSpan.textContent = "AB";
                } else if (blank) {
                    pending++;
                    statusSpan.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700";
                    statusSpan.textContent = "pending";
                } else if (val >= pass) {
                    totalMax += max; totalObtained += val;
                    statusSpan.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800";
                    statusSpan.textContent = "\u2713 " + gradeOf(exactPct(val, max), false, appState.grades).grade;
                } else {
                    totalMax += max; totalObtained += val; failed = true;
                    statusSpan.className = "px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700";
                    statusSpan.textContent = "\u2717 " + gradeOf(exactPct(val, max), true, appState.grades).grade;
                }
            });

            const perc = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(1) : '0.0';
            document.getElementById('live-total-marks').textContent = `${totalObtained} / ${totalMax}`;
            document.getElementById('live-percentage').textContent = `${perc}%`;

            const overallEl = document.getElementById('live-pass-fail');
            if (inputs.length === 0) {
                overallEl.textContent = '-';
            } else if (pending > 0) {
                overallEl.className = "inline-block mt-0.5 px-3 py-0.5 rounded text-xs font-bold uppercase bg-amber-400 text-slate-950";
                overallEl.textContent = `${pending} PENDING`;
            } else if (!failed) {
                overallEl.className = "inline-block mt-0.5 px-3 py-0.5 rounded text-xs font-bold uppercase bg-emerald-500 text-slate-950";
                overallEl.textContent = "PASSED";
            } else {
                overallEl.className = "inline-block mt-0.5 px-3 py-0.5 rounded text-xs font-bold uppercase bg-red-500 text-white";
                overallEl.textContent = "FAILED";
            }
        }

        function saveStudentResult(e) {
            e.preventDefault();
            const examId = document.getElementById('entry-exam-select').value;
            const studentId = document.getElementById('entry-student-select').value;
            const attendanceDays = Number(document.getElementById('entry-days-present').value);

            const marksObj = {};
            const inputs = document.querySelectorAll('.entry-mark-input');
            if (!inputs.length) { showToast('Tick at least one subject to save.', 'error'); return; }
            const attInp = document.getElementById('entry-days-present');
            if (attendanceDays > entryMax(attInp)) { showToast(`Present days can't be more than ${entryMax(attInp)}.`, 'error'); return; }
            for (const inp of inputs) { if (!inp.disabled && Number(inp.value) > entryMax(inp)) { showToast(`Marks can't be more than ${entryMax(inp)} for this subject.`, 'error'); inp.focus(); return; } }
            inputs.forEach(inp => { // blank = not entered yet: it is simply not saved, and can be added later
                const subId = inp.getAttribute('data-subject-id');
                if (inp.closest('tr').querySelector('.entry-absent').checked) marksObj[subId] = 'AB';
                else if (inp.value !== '') marksObj[subId] = Number(inp.value);
            });
            entryDirty = false;
            const pendingN = inputs.length - Object.keys(marksObj).length;
            if (!Object.keys(marksObj).length && !appState.results.some(r => r.examId === examId && r.studentId === studentId)) { showToast('Enter at least one subject mark to save.', 'error'); return; }

            const existingIdx = appState.results.findIndex(r => r.examId === examId && r.studentId === studentId);
            if (existingIdx > -1) {
                appState.results[existingIdx].attendanceDays = attendanceDays;
                appState.results[existingIdx].marks = marksObj; // unticked subjects are dropped from the result
            } else {
                appState.results.push({
                    examId,
                    studentId,
                    attendanceDays,
                    marks: marksObj
                });
            }

            saveState();
            renderAllAdminData();
            document.getElementById('entry-existing-badge').classList.remove('hidden');
            const student = appState.students.find(s => s.id === studentId);
            showToast(`Saved ${student.name} (${student.admissionNo})${pendingN ? ` - ${pendingN} subject${pendingN > 1 ? 's' : ''} still pending` : ''}.`, "success");
            if (e.submitter && e.submitter.dataset.next) {
                const sel = document.getElementById('entry-student-select'), ids = [...sel.options].map(o => o.value), i = ids.indexOf(studentId);
                if (i > -1 && i < ids.length - 1) { sel.value = ids[i + 1]; loadMarksEntrySheet(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
                else showToast('That was the last student in this class.', 'info');
            }
        }

        function labelTables() {
            document.querySelectorAll('table.rtable').forEach(t => {
                const heads = [...t.querySelectorAll('thead th')].map(h => h.textContent.trim());
                t.querySelectorAll('tbody tr').forEach(tr => {
                    if (tr.children.length === heads.length) [...tr.children].forEach((td, i) => td.setAttribute('data-label', heads[i]));
                });
            });
        }
        const labelObserver = new MutationObserver(labelTables);
        document.addEventListener('DOMContentLoaded', () => document.querySelectorAll('table.rtable tbody').forEach(tb => labelObserver.observe(tb, { childList: true })));

        // Initialize Application on Load
        async function bootApp() {
            ['ge-modal', 'sp-modal', 'tl-modal', 'student-edit-modal', 'fab'].forEach(id => { const el = document.getElementById(id); if (el) document.body.appendChild(el); }); // dialogs must work on every screen
            if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
            document.querySelectorAll('select').forEach(enhanceSelect);
            const mew = document.getElementById('marks-entry-workspace'); if (mew) { mew.addEventListener('input', () => { entryDirty = true; }); mew.addEventListener('change', () => { entryDirty = true; }); }
            ['acad', 'stu', 'setup'].forEach(g => showSub(g, subState[g]));
            [['stat-students', () => { switchAdminTab('students'); showSub('stu', 'dir'); }], ['stat-classes', () => { switchAdminTab('academics'); showSub('acad', 'classes'); }],
             ['stat-exams', () => { switchAdminTab('academics'); showSub('acad', 'exams'); }], ['stat-results', () => switchAdminTab('marks')]].forEach(([id, fn]) => {
                const c = document.getElementById(id)?.closest('.rounded-xl'); if (c) { c.style.cursor = 'pointer'; c.addEventListener('click', fn); } });
            if (ROUTE === 'landing' || ROUTE === 'notfound') { showLanding(ROUTE === 'notfound'); return; }
            if (ROUTE === 'super') { await initSuper(); return; }
            if (ROUTE === 'entry') { await initEntry(); return; }
            if (!IS_ADMIN_ROUTE) { document.getElementById('public-view').classList.remove('hidden'); await loadPublicData(); return; }
            if (META('blocked')) { // suspended / expired: no login form; only a support session opened from the platform console gets in
                let ok = false;
                if (token) { try { await loadAdminState(); ok = true; } catch (e) {} }
                if (!ok) { token = ''; localStorage.removeItem(TOKEN_KEY); showBlocked(META('blocked')); return; }
                isAdminAuthenticated = true; switchView('admin'); switchAdminTab('overview'); return;
            }
            switchView('admin');
            if (token) {
                try {
                    isAdminAuthenticated = true;
                    await loadAdminState();
                    switchView('admin');
                    switchAdminTab('overview');
                } catch (e) { token = ''; localStorage.removeItem(TOKEN_KEY); isAdminAuthenticated = false; switchView('admin'); }
            }
        }
        window.addEventListener('DOMContentLoaded', async () => {
            setTimeout(hideAppLoader, 20000); // safety: never leave the loading screen up forever
            try { await bootApp(); } catch (e) { console.error(e); } finally { hideAppLoader(); }
        });
    