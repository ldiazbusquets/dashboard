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
    for (const id of ['missing', 'upcoming', 'cal', 'cal-list', 'announcements', 'courses', 'stats', 'markets']) $(id).replaceChildren();
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

  let dismissed = [];
  try { dismissed = JSON.parse(store.get('dash_dismissed') || '[]'); } catch { dismissed = []; }
  let showDismissed = false;
  let showAllAnns = false;
  let calDay = null;

  const SVG = 'http://www.w3.org/2000/svg';
  function sparkline(values) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 100 28'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'spark'); svg.setAttribute('aria-hidden', 'true');
    if (values.length < 2) return svg;
    const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1) * 100).toFixed(1)},${(25 - ((v - min) / span) * 22).toFixed(1)}`).join(' ');
    const line = document.createElementNS(SVG, 'polyline');
    line.setAttribute('points', pts); line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.6'); line.setAttribute('stroke-linejoin', 'round'); line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
    return svg;
  }
  function setDismissed(id, on) {
    dismissed = dismissed.filter((x) => x !== id);
    if (on) dismissed.push(id);
    store.set('dash_dismissed', JSON.stringify(dismissed));
    render();
  }

  function itemRow(item, when, chip, action) {
    const url = safeUrl(item.url);
    if (action) {
      const text = [h('div', { class: 'row-title' }, item.name || 'Untitled'), h('div', { class: 'row-sub' }, when)];
      return h('div', { class: 'row' + (item.dim ? ' dim' : '') },
        url ? h('a', { class: 'row-main', href: url, target: '_blank', rel: 'noopener noreferrer' }, text) : h('div', { class: 'row-main' }, text),
        chip, action);
    }
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
    tick();
    focusTick();

    const gen = new Date(data.generatedAt);
    const age = now - gen.getTime();
    $('updated').textContent = `Canvas data from ${relative(age)} ago · ${fmtDate(gen)}, ${fmtTime(gen)}`;

    const notes = [...(data.warnings || [])];
    if (age > 3 * 36e5) notes.unshift(`This data is ${relative(age)} old. Check that the "Update dashboard" workflow is still running.`);
    $('banner').hidden = notes.length === 0;
    $('banner').replaceChildren(...notes.map((n) => h('div', null, n)));

    // Items whose due time has passed since the last fetch drop out of "upcoming".
    const upcoming = (data.upcoming || []).filter((i) => new Date(i.dueAt).getTime() > now);
    const allMissing = data.missing || [];
    const missing = allMissing.filter((i) => !dismissed.includes(i.id));
    const hidden = allMissing.filter((i) => dismissed.includes(i.id));
    const open = upcoming.filter((i) => !i.done);
    const in48 = open.filter((i) => new Date(i.dueAt).getTime() - now <= 48 * 36e5).length;
    const in7 = open.filter((i) => new Date(i.dueAt).getTime() - now <= 7 * 864e5).length;
    const doneCount = upcoming.length - open.length;

    const stat = (num, label, alert) =>
      h('div', { class: 'stat glass' + (alert ? ' alert' : '') }, h('div', { class: 'stat-num' }, String(num)), h('div', { class: 'stat-label' }, label));
    $('stats').replaceChildren(
      stat(missing.length, 'Missing', missing.length > 0),
      stat(in48, 'Due in 48 hours'),
      stat(in7, 'Due in 7 days'),
      stat(`${doneCount}/${upcoming.length}`, 'Already submitted'),
    );

    // Missing
    $('missing-card').classList.toggle('has-missing', missing.length > 0);
    const missRow = (i, isHidden) => {
      const due = new Date(i.dueAt);
      return itemRow({ ...i, dim: isHidden }, `${i.course} · was due ${fmtDate(due)}, ${fmtTime(due)}`,
        h('span', { class: 'chip' + (isHidden ? '' : ' late') }, `${relative(now - due.getTime())} late`),
        h('button', { class: 'ghost tiny', type: 'button', onclick: () => setDismissed(i.id, !isHidden) }, isHidden ? 'Restore' : 'Dismiss'));
    };
    const missNodes = missing.length ? missing.map((i) => missRow(i, false)) : [h('p', { class: 'empty' }, 'Nothing missing.')];
    if (hidden.length) {
      missNodes.push(h('button', { class: 'linkish', type: 'button', onclick: () => { showDismissed = !showDismissed; render(); } },
        `${hidden.length} dismissed · ${showDismissed ? 'hide' : 'show'}`));
      if (showDismissed) missNodes.push(...hidden.map((i) => missRow(i, true)));
    }
    $('missing').replaceChildren(...missNodes);

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

    // Weather line under the date
    const w = data.weather;
    $('weather').textContent = w
      ? [`${w.temp}°`, w.text, `H ${w.hi}° L ${w.lo}°`, w.rain != null && w.rain >= 30 ? `${w.rain}% rain` : null].filter(Boolean).join(' · ')
      : '';

    // Markets strip
    const mk = data.markets || [];
    $('markets').hidden = mk.length === 0;
    $('markets').replaceChildren(...mk.map((q) => {
      const up = (q.changePct || 0) >= 0;
      const pct = q.changePct == null ? '' : `${up ? '+' : ''}${q.changePct.toFixed(2)}%`;
      return h('div', { class: 'quote glass ' + (up ? 'up' : 'down') },
        h('div', { class: 'quote-top' }, h('span', { class: 'quote-sym' }, q.symbol), h('span', { class: 'quote-pct' }, pct)),
        h('div', { class: 'quote-price' }, q.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
        sparkline(q.spark || []));
    }));

    // Calendar: three weeks starting from this week's Sunday, with Canvas due dates and events on each day.
    const byDay = new Map();
    const put = (iso, entry) => { const k = dayKey(new Date(iso)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(entry); };
    for (const i of upcoming) put(i.dueAt, { kind: i.done ? 'done' : 'due', item: i, when: i.dueAt });
    for (const i of missing) put(i.dueAt, { kind: 'late', item: i, when: i.dueAt });
    for (const e of data.events || []) put(e.startAt, { kind: 'event', item: { ...e, name: e.title }, when: e.startAt });
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const start = new Date(today0); start.setDate(start.getDate() - start.getDay());
    if (!calDay) calDay = dayKey(today0);
    const cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => h('div', { class: 'cal-dow' }, d));
    for (let n = 0; n < 21; n++) {
      const d = new Date(start); d.setDate(start.getDate() + n);
      const k = dayKey(d);
      const list = byDay.get(k) || [];
      const cls = ['cal-day', k === dayKey(today0) ? 'today' : '', d < today0 ? 'past' : '', k === calDay ? 'sel' : ''].filter(Boolean).join(' ');
      cells.push(h('button', { class: cls, type: 'button', 'aria-label': `${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}, ${plural(list.length, 'item')}`,
        onclick: () => { calDay = k; render(); } },
        h('span', { class: 'cal-num' }, String(d.getDate())),
        h('span', { class: 'cal-dots' }, list.slice(0, 4).map((x) => h('i', { class: 'dot ' + x.kind })))));
    }
    $('cal').replaceChildren(...cells);
    $('cal-month').textContent = today0.toLocaleDateString([], { month: 'long', year: 'numeric' });
    const picked = (byDay.get(calDay) || []).slice().sort((a, b) => new Date(a.when) - new Date(b.when));
    $('cal-list').replaceChildren(...(picked.length
      ? picked.map((x) => {
          const t = new Date(x.when);
          const tag = { due: 'Due', done: 'Submitted', late: 'Missing', event: 'Event' }[x.kind];
          return itemRow({ ...x.item, done: x.kind === 'done' }, [x.item.course, fmtTime(t)].filter(Boolean).join(' · '),
            h('span', { class: 'chip' + (x.kind === 'late' ? ' late' : x.kind === 'done' ? ' ok' : '') }, tag));
        })
      : [h('p', { class: 'empty cal-empty' }, calDay === dayKey(today0) ? 'Nothing due today.' : 'Nothing on this day.')]));

    // Announcements: one line each from the last 7 days, newest first. Click one to read it.
    const anns = (data.announcements || []).filter((a) => now - new Date(a.postedAt).getTime() < 7 * 864e5);
    const annNode = (a) => {
      const url = safeUrl(a.url);
      return h('details', { class: 'ann' },
        h('summary', null,
          h('span', { class: 'ann-title' }, a.title || 'Announcement'),
          h('span', { class: 'ann-meta' }, `${(a.course || '').split(' · ')[0]} · ${relative(now - new Date(a.postedAt).getTime())}`)),
        h('div', { class: 'ann-body' },
          a.text ? h('p', null, a.text) : null,
          url ? h('a', { class: 'ann-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Canvas') : null));
    };
    const annShown = showAllAnns ? anns : anns.slice(0, 4);
    const annNodes = anns.length ? annShown.map(annNode) : [h('p', { class: 'empty' }, 'Nothing new this week.')];
    if (anns.length > 4) {
      annNodes.push(h('button', { class: 'linkish', type: 'button', onclick: () => { showAllAnns = !showAllAnns; render(); } },
        showAllAnns ? 'Show fewer' : `Show ${anns.length - 4} more`));
    }
    // Keep announcements the user has opened from snapping shut on the once-a-minute redraw.
    const openTitles = new Set([...$('announcements').querySelectorAll('details[open] .ann-title')].map((n) => n.textContent));
    $('announcements').replaceChildren(...annNodes);
    for (const d of $('announcements').querySelectorAll('details')) {
      if (openTitles.has(d.querySelector('.ann-title').textContent)) d.open = true;
    }

    // Courses: real classes only (names that start with a course code such as "FIN458 ·"),
    // plus anything else that actually has work open or missing.
    const isClass = (c) => /^[A-Z]{2,5}\s?\d{3}[A-Z]? · /.test(c.name);
    const courses = (data.courses || []).map((c) => ({
      c,
      due: open.filter((i) => i.course === c.name).length,
      miss: missing.filter((i) => i.course === c.name).length,
    })).filter((x) => isClass(x.c) || x.due || x.miss);
    $('courses').replaceChildren(...(courses.length
      ? courses.map(({ c, due, miss }) => {
          const [code, ...rest] = c.name.split(' · ');
          return h('div', { class: 'course' },
            h('span', { class: 'course-code' }, rest.length ? code : c.name),
            h('span', { class: 'course-name' }, rest.join(' · ')),
            miss ? h('span', { class: 'chip late' }, `${miss} missing`) : null,
            h('span', { class: 'chip' + (due ? '' : ' quiet') }, due ? `${due} open` : 'clear'),
            c.score != null ? h('span', { class: 'chip' }, `${c.score}%`) : null);
        })
      : [h('p', { class: 'empty' }, 'No active courses found.')]));
  }

  // ---------- Spotify (Authorization Code with PKCE; no secret needed) ----------

  const SP = {
    authorize: 'https://accounts.spotify.com/authorize',
    token: 'https://accounts.spotify.com/api/token',
    api: 'https://api.spotify.com/v1',
    scopes: 'user-read-currently-playing user-read-playback-state user-modify-playback-state',
  };
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

  let spTokens = null;
  try { spTokens = JSON.parse(store.get('sp_tokens') || 'null'); } catch { spTokens = null; }
  let spMsg = '';
  let spTimer = null;

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
      spMsg ? h('p', { class: 'sp-msg' }, spMsg) : null,
    );
  }

  async function pollSpotify() {
    if (!cfg.spotifyClientId || !spTokens || document.hidden || !passphrase) { renderSpotify(null); return; }
    try {
      const res = await spFetch('/me/player/currently-playing?additional_types=episode');
      renderSpotify(res.status === 200 ? await res.json() : null);
    } catch { renderSpotify(null); }
  }

  function startSpotify() {
    pollSpotify();
    if (!spTimer) spTimer = setInterval(pollSpotify, 10000);
  }

  $('brand').toggleAttribute('hidden', cfg.brand === false || cfg.brand === '');

  // ---------- Quick links (from config.js) ----------

  (function renderLinks() {
    const links = (cfg.links || []).map((l) => ({ name: String(l.name || ''), url: safeUrl(l.url) })).filter((l) => l.name && l.url);
    $('links').hidden = links.length === 0;
    $('links').replaceChildren(...links.map((l) => h('a', { class: 'link-pill', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.name)));
  })();

  // ---------- To-do list (saved in this browser only) ----------

  let todos = [];
  try { todos = JSON.parse(store.get('dash_todos') || '[]'); } catch { todos = []; }
  if (!Array.isArray(todos)) todos = [];
  const saveTodos = () => store.set('dash_todos', JSON.stringify(todos));
  function renderTodos() {
    const sorted = [...todos.filter((t) => !t.done), ...todos.filter((t) => t.done)];
    $('todo-clear').hidden = !todos.some((t) => t.done);
    $('todos').replaceChildren(...(sorted.length
      ? sorted.map((t) => {
          const box = h('input', { type: 'checkbox', 'aria-label': 'Done' });
          box.checked = !!t.done;
          box.addEventListener('change', () => { t.done = box.checked; saveTodos(); renderTodos(); });
          return h('div', { class: 'todo' + (t.done ? ' done' : '') },
            h('label', { class: 'todo-main' }, box, h('span', null, t.text)),
            h('button', { class: 'todo-x', type: 'button', 'aria-label': 'Delete task', onclick: () => { todos = todos.filter((x) => x !== t); saveTodos(); renderTodos(); } }, '×'));
        })
      : [h('p', { class: 'empty' }, 'Nothing on your list.')]));
  }
  $('todo-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('todo-input').value.trim();
    if (!text) return;
    todos.push({ id: Date.now(), text, done: false });
    $('todo-input').value = '';
    saveTodos(); renderTodos();
  });
  $('todo-clear').addEventListener('click', () => { todos = todos.filter((t) => !t.done); saveTodos(); renderTodos(); });
  renderTodos();

  // ---------- Focus timer ----------
  // A focus block followed by a short break. The end time is saved, so the timer
  // keeps counting correctly through refreshes and while the tab is in the background.

  const FOCUS_KEY = 'dash_focus';
  const PRESETS = [{ focus: 25, rest: 5 }, { focus: 50, rest: 10 }, { focus: 90, rest: 15 }];
  let focus = { preset: 0, mode: 'focus', endsAt: null, left: null, day: '', done: 0 };
  try { focus = { ...focus, ...JSON.parse(store.get(FOCUS_KEY) || '{}') }; } catch { /* keep defaults */ }
  const todayKey = () => new Date().toDateString();
  const saveFocus = () => store.set(FOCUS_KEY, JSON.stringify(focus));
  const blockMs = () => PRESETS[focus.preset][focus.mode === 'focus' ? 'focus' : 'rest'] * 60000;

  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      [660, 880].forEach((freq, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        const t = ac.currentTime + i * 0.28;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 1);
      });
      setTimeout(() => ac.close(), 2500);
    } catch { /* sound is optional */ }
  }

  function focusTick() {
    if (focus.day !== todayKey()) { focus.day = todayKey(); focus.done = 0; saveFocus(); }
    const running = focus.endsAt != null;
    let left = running ? focus.endsAt - Date.now() : (focus.left != null ? focus.left : blockMs());
    if (running && left <= 0) {
      chime();
      if (focus.mode === 'focus') {
        focus.done += 1; focus.mode = 'rest'; focus.endsAt = Date.now() + blockMs();   // break starts by itself
      } else {
        focus.mode = 'focus'; focus.endsAt = null;                                      // then wait for the user
      }
      focus.left = null; saveFocus();
      return focusTick();
    }
    left = Math.max(0, left);
    const secs = Math.ceil(left / 1000);
    const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    $('focus-time').textContent = text;
    $('focus-mode').textContent = focus.mode === 'focus' ? 'Focus' : 'Break';
    $('focus-fill').style.width = (100 - (left / blockMs()) * 100) + '%';
    $('focus-toggle').textContent = running ? 'Pause' : (focus.left != null ? 'Resume' : 'Start');
    $('focus-count').textContent = `${plural(focus.done, 'session')} today`;
    $('focus-card').classList.toggle('resting', focus.mode === 'rest');
    for (const b of $('focus-presets').children) b.classList.toggle('on', Number(b.dataset.i) === focus.preset);
    if (passphrase) document.title = running ? `${text} · ${focus.mode === 'focus' ? 'Focus' : 'Break'}` : (cfg.title || 'Dashboard');
  }

  $('focus-presets').replaceChildren(...PRESETS.map((p, i) =>
    h('button', { class: 'ghost tiny', type: 'button', 'data-i': String(i), onclick: () => {
      focus.preset = i; focus.mode = 'focus'; focus.endsAt = null; focus.left = null; saveFocus(); focusTick();
    } }, `${p.focus} min`)));
  $('focus-toggle').addEventListener('click', () => {
    if (focus.endsAt != null) { focus.left = Math.max(0, focus.endsAt - Date.now()); focus.endsAt = null; }
    else { focus.endsAt = Date.now() + (focus.left != null ? focus.left : blockMs()); focus.left = null; }
    saveFocus(); focusTick();
  });
  $('focus-reset').addEventListener('click', () => { focus.mode = 'focus'; focus.endsAt = null; focus.left = null; saveFocus(); focusTick(); });
  setInterval(focusTick, 500);
  focusTick();

  // ---------- Clock and greeting ----------

  function tick() {
    const d = new Date();
    const hr = d.getHours();
    const hello = hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    $('greet').textContent = hello + (cfg.name ? ', ' + cfg.name : '');
    $('clock').textContent = fmtTime(d);
    $('today').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  setInterval(tick, 5000);

  // ---------- Background video and adaptive color ----------
  // Plays a muted, looping video behind the top of the page, then samples its
  // frames and steers the page's hue toward the video's dominant color.

  async function initScene() {
    // Videos come from videos.json (written by the workflow: every .mp4/.webm in the repo),
    // falling back to the list in config.js.
    let list = [];
    try {
      const res = await fetch('videos.json', { cache: 'no-store' });
      if (res.ok) list = (await res.json()).filter((f) => typeof f === 'string' && /^[\w .()-]+\.(mp4|webm)$/i.test(f));
    } catch { /* no manifest */ }
    if (!list.length) list = [].concat(cfg.backgroundVideo || []).filter(Boolean);
    if (!list.length) return;

    // Shuffle, then walk the list in order so nothing repeats until all have played.
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    const holdSeconds = Math.max(10, Number(cfg.sceneSeconds) || 60);

    const scene = $('scene');
    const btn = $('scene-btn');
    const nextBtn = $('scene-next');
    const root = document.documentElement;
    const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let paused = store.get('dash_scene_paused') === '1' || reduceMotion;

    const mk = () => {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
      // When a clip is about to finish, fade to the next one instead of repeating it.
      // (With a single video there is nothing to skip to, so it just loops.)
      v.addEventListener('timeupdate', () => {
        if (v !== active || switching || paused || list.length < 2 || !isFinite(v.duration)) return;
        if (v.currentTime > 1 && v.duration - v.currentTime < 1.7) next();
      });
      scene.prepend(v);
      return v;
    };
    let active = mk();
    let spare = mk();
    let index = -1;
    let elapsed = 0;
    let switching = false;
    let started = false;

    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 18;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const cur = { h: 205, s: 30, sa: 62 };
    let target = null;
    let canSample = true;

    function sample() {
      const v = active;
      if (!canSample || v.readyState < 2) return;
      try {
        ctx.drawImage(v, 0, 0, cv.width, cv.height);
        const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let x = 0, y = 0, wsum = 0, chroma = 0;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
          const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
          chroma += c;
          if (c < 0.04) continue;
          let hue = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
          hue *= Math.PI / 3;
          x += Math.cos(hue) * c; y += Math.sin(hue) * c; wsum += c;
        }
        const avgChroma = chroma / (px.length / 4);
        if (wsum === 0) { target = { h: cur.h, s: 6, sa: 14 }; return; }
        const hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        // How strongly the colors agree on one hue (0 = rainbow, 1 = single color).
        const agree = Math.hypot(x, y) / wsum;
        const strength = Math.min(1, avgChroma * 3.2) * (0.35 + 0.65 * agree);
        target = { h: hue, s: 10 + 34 * strength, sa: 26 + 52 * strength };
      } catch { canSample = false; }
    }

    function ease() {
      if (!target) return;
      const dh = ((target.h - cur.h + 540) % 360) - 180;
      const ds = target.s - cur.s, da = target.sa - cur.sa;
      if (Math.abs(dh) < 0.3 && Math.abs(ds) < 0.3 && Math.abs(da) < 0.3) return;
      cur.h = (cur.h + dh * 0.12 + 360) % 360; cur.s += ds * 0.12; cur.sa += da * 0.12;
      root.style.setProperty('--h', cur.h.toFixed(1));
      root.style.setProperty('--s', cur.s.toFixed(1));
      root.style.setProperty('--sa', cur.sa.toFixed(1));
    }

    function apply() {
      btn.textContent = paused ? 'Play scene' : 'Pause scene';
      if (paused || document.hidden) active.pause(); else active.play().catch(() => {});
    }

    // Loads the next clip into the hidden layer and crossfades to it once it can play.
    function next() {
      if (switching || !list.length) return;
      switching = true;
      index = (index + 1) % list.length;
      const file = list[index];
      const incoming = spare;
      const done = () => { incoming.removeEventListener('loadeddata', ok); incoming.removeEventListener('error', bad); };
      const ok = () => {
        done();
        const outgoing = active;
        active = incoming; spare = outgoing;
        incoming.classList.add('on');
        outgoing.classList.remove('on');
        setTimeout(() => { outgoing.pause(); outgoing.removeAttribute('src'); outgoing.load(); }, 2000);
        elapsed = 0; switching = false;
        if (!started) {
          started = true;
          scene.classList.add('has-video');
          btn.hidden = false;
          nextBtn.hidden = list.length < 2;
          setInterval(() => { if (!document.hidden && !active.paused) sample(); }, 1500);
          setInterval(() => { if (!document.hidden) ease(); }, 120);
          setInterval(() => {
            if (document.hidden || paused || list.length < 2) return;
            if (++elapsed >= holdSeconds) next();
          }, 1000);
        }
        apply();
        sample();
      };
      const bad = () => {
        done();
        list.splice(index, 1); index -= 1; switching = false;   // drop a clip that will not load
        nextBtn.hidden = list.length < 2;
        if (list.length && (list.length > 1 || !started)) next();
      };
      incoming.addEventListener('loadeddata', ok);
      incoming.addEventListener('error', bad);
      incoming.src = encodeURI(file);
      incoming.load();
    }

    btn.addEventListener('click', () => { paused = !paused; store.set('dash_scene_paused', paused ? '1' : ''); apply(); });
    nextBtn.addEventListener('click', next);
    document.addEventListener('visibilitychange', apply);
    next();
  }
  initScene();

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
