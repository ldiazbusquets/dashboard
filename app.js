(() => {
  'use strict';

  const cfg = window.DASH_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // ---------- Small helpers ----------

  const store = {
    get(k, session) { try { return (session ? sessionStorage : localStorage).getItem(k); } catch { return null; } },
    set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // Builds DOM nodes with textContent only, so Canvas text can never run as HTML.
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  const safeUrl = (u) => {
    try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; }
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  function dayLabel(d) {
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (dayKey(d) === dayKey(today)) return 'Today';
    if (dayKey(d) === dayKey(tomorrow)) return 'Tomorrow';
    return d.toLocaleDateString([], { weekday: 'long' });
  }

  function relative(ms) {
    const abs = Math.abs(ms);
    const mins = Math.round(abs / 6e4);
    if (mins < 60) return `${Math.max(mins, 1)}m`;
    const hours = Math.round(abs / 36e5);
    if (hours < 48) return `${hours}h`;
    return `${Math.round(abs / 864e5)}d`;
  }

  // ---------- Decryption ----------

  async function decrypt(blob, passphrase) {
    if (!blob || blob.v !== 1 || !(blob.iter >= 100000 && blob.iter <= 5000000)) throw new Error('format');
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(passphrase.normalize('NFKC').trim()), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: fromB64(blob.salt), iterations: blob.iter, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function loadBlob() {
    const res = await fetch('data.enc.json?t=' + Date.now(), { cache: 'no-store' });
    if (res.status === 404) throw new Error('nodata');
    if (!res.ok) throw new Error('network');
    return res.json();
  }

  // ---------- Lock screen ----------

  let passphrase = null;
  let data = null;

  function showLock(msg) {
    $('app').hidden = true;
    $('lock').hidden = false;
    $('lock-msg').textContent = msg || '';
    $('pass').value = '';
    $('pass').focus();
  }

  async function unlock(pass, { silent } = {}) {
    try {
      const blob = await loadBlob();
      data = await decrypt(blob, pass);
      passphrase = pass;
      $('lock').hidden = true;
      $('app').hidden = false;
      render();
      return true;
    } catch (e) {
      if (silent && e.message !== 'nodata' && e.message !== 'network') { store.del('dash_pass'); }
      const msg =
        e.message === 'nodata' ? 'No data published yet. Run the "Update dashboard" workflow first.' :
        e.message === 'network' ? 'Could not load the data file. Check your connection.' :
        e.message === 'format' ? 'The data file is in an unexpected format.' :
        silent ? '' : 'Wrong passphrase.';
      showLock(msg);
      return false;
    }
  }

  $('lock-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pass = $('pass').value;
    const btn = $('unlock-btn');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    const ok = await unlock(pass);
    btn.disabled = false; btn.textContent = 'Unlock';
    if (ok) {
      store.del('dash_pass');
      store.set('dash_pass', pass, !$('remember').checked);
      startSpotify();
    }
  });

  $('lock-btn').addEventListener('click', () => {
    store.del('dash_pass');
    passphrase = null; data = null;
    for (const id of ['missing', 'upcoming', 'events', 'announcements', 'courses', 'stats']) $(id).replaceChildren();
    showLock('');
  });

  async function refresh() {
    if (!passphrase) return;
    try {
      data = await decrypt(await loadBlob(), passphrase);
      render();
    } catch (e) {
      if (e.message !== 'network' && e.message !== 'nodata') { store.del('dash_pass'); passphrase = null; showLock('Passphrase no longer matches. Enter the new one.'); }
    }
  }
  $('refresh').addEventListener('click', refresh);
  $('hide-done').addEventListener('change', () => { store.set('dash_hide_done', $('hide-done').checked ? '1' : ''); render(); });

  // ---------- Rendering ----------

  function itemRow(item, when, chip) {
    const url = safeUrl(item.url);
    const main = h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, item.name || item.title || 'Untitled'),
      h('div', { class: 'row-sub' }, when));
    const inner = [main, chip];
    return url
      ? h('a', { class: 'row' + (item.done ? ' done' : ''), href: url, target: '_blank', rel: 'noopener noreferrer' }, inner)
      : h('div', { class: 'row' + (item.done ? ' done' : '') }, inner);
  }

  function render() {
    if (!data) return;
    const now = Date.now();
    $('title').textContent = cfg.title || 'Dashboard';
    document.title = cfg.title || 'Dashboard';

    const gen = new Date(data.generatedAt);
    const age = now - gen.getTime();
    $('updated').textContent = `Canvas data from ${relative(age)} ago · ${fmtDate(gen)}, ${fmtTime(gen)}`;

    const notes = [...(data.warnings || [])];
    if (age > 3 * 36e5) notes.unshift(`This data is ${relative(age)} old. Check that the "Update dashboard" workflow is still running.`);
    $('banner').hidden = notes.length === 0;
    $('banner').replaceChildren(...notes.map((n) => h('div', null, n)));

    // Items whose due time has passed since the last fetch drop out of "upcoming".
    const upcoming = (data.upcoming || []).filter((i) => new Date(i.dueAt).getTime() > now);
    const missing = data.missing || [];
    const open = upcoming.filter((i) => !i.done);
    const in48 = open.filter((i) => new Date(i.dueAt).getTime() - now <= 48 * 36e5).length;
    const in7 = open.filter((i) => new Date(i.dueAt).getTime() - now <= 7 * 864e5).length;
    const doneCount = upcoming.length - open.length;

    const stat = (num, label, alert) =>
      h('div', { class: 'stat' + (alert ? ' alert' : '') }, h('div', { class: 'stat-num' }, String(num)), h('div', { class: 'stat-label' }, label));
    $('stats').replaceChildren(
      stat(missing.length, 'Missing', missing.length > 0),
      stat(in48, 'Due in 48 hours'),
      stat(in7, 'Due in 7 days'),
      stat(`${doneCount}/${upcoming.length}`, 'Already submitted'),
    );

    // Missing
    $('missing-card').classList.toggle('has-missing', missing.length > 0);
    $('missing').replaceChildren(...(missing.length
      ? missing.map((i) => {
          const due = new Date(i.dueAt);
          return itemRow(i, `${i.course} · was due ${fmtDate(due)}, ${fmtTime(due)}`,
            h('span', { class: 'chip late' }, `${relative(now - due.getTime())} late`));
        })
      : [h('p', { class: 'empty' }, 'Nothing missing.')]));

    // Upcoming, grouped by day
    $('hide-done').checked = store.get('dash_hide_done') === '1';
    $('upcoming-title').textContent = `Due in the next ${data.windowDays || 14} days`;
    const shown = $('hide-done').checked ? open : upcoming;
    const nodes = [];
    let lastDay = null;
    for (const i of shown) {
      const due = new Date(i.dueAt);
      if (dayKey(due) !== lastDay) {
        lastDay = dayKey(due);
        nodes.push(h('div', { class: 'day' }, dayLabel(due), h('span', null, fmtDate(due))));
      }
      const left = due.getTime() - now;
      const chip = i.done
        ? h('span', { class: 'chip ok' }, 'Submitted')
        : h('span', { class: 'chip' + (left <= 48 * 36e5 ? ' urgent' : '') }, `in ${relative(left)}`);
      const bits = [i.course, fmtTime(due)];
      if (i.type && i.type !== 'assignment') bits.push(i.type);
      if (i.noSubmit) bits.push('nothing to submit online');
      else if (i.points != null) bits.push(`${i.points} pts`);
      nodes.push(itemRow(i, bits.join(' · '), chip));
    }
    $('upcoming').replaceChildren(...(nodes.length ? nodes : [h('p', { class: 'empty' }, 'Nothing due in this window.')]));

    // Calendar events
    const events = (data.events || []).filter((e) => new Date(e.startAt).getTime() > now - 36e5);
    $('events').replaceChildren(...(events.length
      ? events.map((e) => {
          const s = new Date(e.startAt);
          const sub = [e.course, `${dayLabel(s)}, ${fmtDate(s)} at ${fmtTime(s)}`, e.location].filter(Boolean).join(' · ');
          return itemRow(e, sub, null);
        })
      : [h('p', { class: 'empty' }, 'No calendar events in this window.')]));

    // Announcements
    const anns = data.announcements || [];
    $('announcements').replaceChildren(...(anns.length
      ? anns.map((a) => {
          const url = safeUrl(a.url);
          const body = [
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title' }, a.title || 'Announcement'),
              h('div', { class: 'row-sub' }, `${a.course} · ${relative(now - new Date(a.postedAt).getTime())} ago`),
              a.text ? h('div', { class: 'row-sub' }, a.text) : null),
          ];
          return url ? h('a', { class: 'row', href: url, target: '_blank', rel: 'noopener noreferrer' }, body) : h('div', { class: 'row' }, body);
        })
      : [h('p', { class: 'empty' }, 'No announcements in the last two weeks.')]));

    // Courses
    const courses = data.courses || [];
    $('courses').replaceChildren(...(courses.length
      ? courses.map((c) => {
          const due = open.filter((i) => i.course === c.name).length;
          const miss = missing.filter((i) => i.course === c.name).length;
          const sub = [c.code, plural(due, 'item') + ' open', miss ? `${miss} missing` : null, c.score != null ? `${c.score}%` : null]
            .filter(Boolean).join(' · ');
          return h('div', { class: 'row' }, h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, c.name), h('div', { class: 'row-sub' }, sub)));
        })
      : [h('p', { class: 'empty' }, 'No active courses found.')]));
  }

  // ---------- Spotify (Authorization Code with PKCE; no secret needed) ----------

  const SP = {
    authorize: 'https://accounts.spotify.com/authorize',
    token: 'https://accounts.spotify.com/api/token',
    api: 'https://api.spotify.com/v1',
    scopes: 'user-read-currently-playing user-read-playback-state user-read-recently-played user-modify-playback-state',
  };
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

  let spTokens = null;
  try { spTokens = JSON.parse(store.get('sp_tokens') || 'null'); } catch { spTokens = null; }
  let spMsg = '';
  let spTimer = null;
  let spTick = 0;
  let spRecent = [];

  function saveTokens(t, prev) {
    spTokens = { access: t.access_token, refresh: t.refresh_token || (prev && prev.refresh) || null, exp: Date.now() + (t.expires_in || 3600) * 1000 };
    store.set('sp_tokens', JSON.stringify(spTokens));
  }
  function clearTokens() { spTokens = null; store.del('sp_tokens'); }

  async function tokenRequest(params) {
    const res = await fetch(SP.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.spotifyClientId, ...params }),
    });
    if (!res.ok) throw new Error('token');
    return res.json();
  }

  async function spotifyLogin() {
    const verifier = randomString(64);
    const state = randomString(16);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    store.set('sp_verifier', verifier, true);
    store.set('sp_state', state, true);
    location.assign(SP.authorize + '?' + new URLSearchParams({
      client_id: cfg.spotifyClientId, response_type: 'code', redirect_uri: redirectUri(),
      code_challenge_method: 'S256', code_challenge: challenge, scope: SP.scopes, state,
    }));
  }

  // Runs on page load: finishes the login if Spotify just sent us back here.
  async function spotifyCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    const code = q.get('code');
    const okState = q.get('state') && q.get('state') === store.get('sp_state', true);
    const verifier = store.get('sp_verifier', true);
    history.replaceState(null, '', redirectUri());
    if (!code || !okState || !verifier) { spMsg = 'Spotify sign-in was cancelled or failed.'; return; }
    try {
      saveTokens(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier }));
    } catch { spMsg = 'Spotify sign-in failed. Check the redirect URI in your Spotify app settings.'; }
    try { sessionStorage.removeItem('sp_verifier'); sessionStorage.removeItem('sp_state'); } catch { /* ignore */ }
  }

  async function spFetch(path, opts) {
    if (!spTokens) throw new Error('auth');
    if (Date.now() > spTokens.exp - 60000) {
      if (!spTokens.refresh) { clearTokens(); throw new Error('auth'); }
      try { saveTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: spTokens.refresh }), spTokens); }
      catch { clearTokens(); throw new Error('auth'); }
    }
    const res = await fetch(SP.api + path, { ...opts, headers: { Authorization: 'Bearer ' + spTokens.access } });
    if (res.status === 401) { clearTokens(); throw new Error('auth'); }
    return res;
  }

  async function spControl(method, path) {
    try {
      const res = await spFetch(path, { method });
      spMsg = res.status === 404 ? 'No active device. Open Spotify on your phone or computer first.'
        : res.status === 403 ? 'Spotify refused that action.' : '';
    } catch { spMsg = ''; }
    setTimeout(pollSpotify, 500);
  }

  function renderSpotify(now) {
    const box = $('spotify');
    if (!cfg.spotifyClientId) {
      box.replaceChildren(h('p', { class: 'empty' }, 'Add your Spotify Client ID to config.js to turn this on.'));
      return;
    }
    if (!spTokens) {
      box.replaceChildren(
        h('button', { type: 'button', onclick: spotifyLogin }, 'Connect Spotify'),
        h('p', { class: 'sp-msg' }, spMsg));
      return;
    }
    const item = now && now.item;
    const art = item && safeUrl(((item.album && item.album.images) || item.images || []).slice(-2)[0]?.url);
    const artists = item ? (item.artists || []).map((a) => a.name).join(', ') || (item.show && item.show.name) || '' : '';
    const pct = item && item.duration_ms ? Math.min(100, (now.progress_ms / item.duration_ms) * 100) : 0;
    const fill = h('div');
    fill.style.width = pct + '%';
    const playing = !!(now && now.is_playing);

    box.replaceChildren(
      h('div', { class: 'np' },
        art ? h('img', { src: art, alt: '', referrerpolicy: 'no-referrer' }) : h('div', { class: 'art' }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, item ? item.name : 'Nothing playing'),
          h('div', { class: 'row-sub' }, item ? artists : 'Start something in Spotify and it shows up here.'))),
      h('div', { class: 'bar' }, fill),
      h('div', { class: 'controls' },
        h('button', { class: 'ghost', type: 'button', 'aria-label': 'Previous track', onclick: () => spControl('POST', '/me/player/previous') }, 'Prev'),
        h('button', { class: 'ghost', type: 'button', onclick: () => spControl('PUT', playing ? '/me/player/pause' : '/me/player/play') }, playing ? 'Pause' : 'Play'),
        h('button', { class: 'ghost', type: 'button', 'aria-label': 'Next track', onclick: () => spControl('POST', '/me/player/next') }, 'Next'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', type: 'button', onclick: () => { clearTokens(); renderSpotify(null); } }, 'Disconnect')),
      h('p', { class: 'sp-msg' }, spMsg),
      spRecent.length ? h('div', { class: 'recent' },
        h('div', { class: 'recent-title' }, 'Recently played'),
        spRecent.map((r) => h('div', { class: 'row' }, h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, r.name), h('div', { class: 'row-sub' }, r.artists))))) : null,
    );
  }

  async function pollSpotify() {
    if (!cfg.spotifyClientId || !spTokens || document.hidden || !passphrase) { renderSpotify(null); return; }
    try {
      if (spTick++ % 6 === 0) {
        const r = await spFetch('/me/player/recently-played?limit=5');
        if (r.ok) {
          const j = await r.json();
          spRecent = (j.items || []).map((x) => ({ name: x.track.name, artists: (x.track.artists || []).map((a) => a.name).join(', ') }));
        }
      }
      const res = await spFetch('/me/player/currently-playing?additional_types=episode');
      renderSpotify(res.status === 200 ? await res.json() : null);
    } catch { renderSpotify(null); }
  }

  function startSpotify() {
    pollSpotify();
    if (!spTimer) spTimer = setInterval(pollSpotify, 10000);
  }

  // ---------- Start ----------

  document.addEventListener('visibilitychange', () => { if (!document.hidden && passphrase) { render(); pollSpotify(); } });
  setInterval(refresh, 5 * 60 * 1000);   // pick up new Canvas data
  setInterval(() => { if (passphrase && !document.hidden) render(); }, 60 * 1000); // keep countdowns current

  (async () => {
    await spotifyCallback();
    const saved = store.get('dash_pass') || store.get('dash_pass', true);
    if (saved && (await unlock(saved, { silent: true }))) startSpotify();
    else if (!saved) showLock('');
  })();
})();
