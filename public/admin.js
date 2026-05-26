/* Coach Adaptatif — Admin SPA.
 *
 * Security posture on the client:
 *  - Access decisions are enforced server-side; this file only renders UI.
 *    Even if someone loads /admin without being an admin, every /api/admin/*
 *    call returns 401/404.
 *  - Every state-changing call goes through api(), which echoes the CSRF
 *    cookie into the X-CSRF-Token header.
 *  - User-generated text (email, JSON fields) is always inserted via
 *    textContent / escapeHtml helpers — never innerHTML concatenation.
 *  - Destructive actions prompt for the target email as a typed confirmation
 *    to avoid accidental deletion.
 */
'use strict';

/* =================== API =================== */
function getCookie(name) {
  const m = document.cookie.match('(^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)');
  return m ? decodeURIComponent(m[2]) : null;
}
async function api(method, path, body) {
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    // Audit M-03 : préfère __Host- sur HTTPS.
    const t = getCookie('__Host-coach_csrf') || getCookie('coach_csrf');
    if (t) headers['X-CSRF-Token'] = t;
  }
  const res = await fetch(path, {
    method, headers, credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
async function refreshCSRF() { try { await api('GET', '/api/csrf'); } catch (_) {} }

/* =================== HELPERS =================== */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// num coerces a user-controlled value to a finite number, defaulting to 0.
// Defense-in-depth for the admin view: a regular user saves their own JSON
// (via PUT /api/data), and the server only whitelists top-level keys — it
// does NOT validate the shape of nested fields. So a malicious user could
// save e.g. history[i].sets = {length: "<script>"} and hope the admin view
// renders .length without escaping. Arithmetic on that value would
// string-concat, producing "0<script>" which injected via innerHTML fires.
// Running every user-provided numeric through num() blocks that path.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function safeArr(v) { return Array.isArray(v) ? v : []; }
function fmtDate(s) {
  if (!s) return '—';
  try {
    const d = new Date(s);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  } catch (_) { return '—'; }
}
function show(id) {
  ['viewLogin', 'viewForbidden', 'viewDash'].forEach(v => {
    document.getElementById(v).classList.toggle('hide', v !== id);
  });
}
// Cryptographically random password using the browser's getRandomValues.
function genPassword(len) {
  const alpha = 'abcdefghijkmnpqrstuvwxyz';
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const nums  = '23456789';
  const sym   = '!@#$%&*+-=?';
  const all   = alpha + ALPHA + nums + sym;
  const out = [];
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out.push(all[buf[i] % all.length]);
  // Ensure we have at least one of each category (simple fix-up).
  out[0] = alpha[buf[0] % alpha.length];
  out[1] = ALPHA[buf[1] % ALPHA.length];
  out[2] = nums[buf[2] % nums.length];
  out[3] = sym[buf[3] % sym.length];
  return out.join('');
}

/* =================== STATE =================== */
let ME = null;              // { id, email, isAdmin }
let USERS = [];             // latest user list from server
let SELECTED_ID = null;     // currently-open user in the detail pane

/* =================== BOOT =================== */
async function boot() {
  await refreshCSRF();
  try {
    const me = await api('GET', '/api/me');
    if (!me.user) {
      show('viewLogin');
      document.getElementById('hdrSub').textContent = 'non connecté';
      return;
    }
    ME = me.user;
    document.getElementById('hdrSub').textContent = ME.email + (ME.isAdmin ? ' · admin' : '');
    if (!ME.isAdmin) { show('viewForbidden'); return; }
    show('viewDash');
    await loadUsers();
  } catch (e) {
    show('viewLogin');
    document.getElementById('hdrSub').textContent = 'erreur';
  }
}

/* =================== LOGIN =================== */
document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  const err = document.getElementById('loginErr');
  err.textContent = '';
  if (!email || !pass) { err.textContent = 'Email + mot de passe requis.'; return; }
  try {
    await api('POST', '/api/login', { email, password: pass });
    document.getElementById('loginPass').value = '';
    await refreshCSRF();
    await boot();
  } catch (e) { err.textContent = e.message; }
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch (_) {}
  ME = null; USERS = []; SELECTED_ID = null;
  location.reload();
});

/* =================== USERS LIST =================== */
async function loadUsers() {
  const tbody = document.getElementById('usersTbody');
  tbody.innerHTML = '<tr><td colspan="3" class="mut">Chargement…</td></tr>';
  try {
    const resp = await api('GET', '/api/admin/users');
    USERS = resp.users || [];
    renderUsers();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" class="mut">Erreur : ${esc(e.message)}</td></tr>`;
  }
}
function renderUsers() {
  const tbody = document.getElementById('usersTbody');
  const filter = document.getElementById('userFilter').value.trim().toLowerCase();
  const rows = USERS.filter(u => !filter || u.email.toLowerCase().includes(filter));
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="mut">Aucun utilisateur.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(u => {
    const selected = u.id === SELECTED_ID ? 'selected' : '';
    const role = u.isAdmin ? '<span class="pill admin">admin</span>' : '<span class="pill">user</span>';
    const self = u.isSelf ? ' <span class="pill self">toi</span>' : '';
    return `<tr class="clickable ${selected}" data-id="${esc(u.id)}">
      <td>${esc(u.email)}${self}</td>
      <td>${role}</td>
      <td class="mut">${esc(fmtDate(u.createdAt))}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => selectUser(tr.dataset.id));
  });
}
document.getElementById('userFilter').addEventListener('input', renderUsers);
document.getElementById('refreshBtn').addEventListener('click', loadUsers);

/* =================== CREATE USER =================== */
document.getElementById('genPassBtn').addEventListener('click', () => {
  const p = genPassword(14);
  const input = document.getElementById('newPass');
  input.type = 'text';
  input.value = p;
  // Auto-revert to password type after a few seconds so it doesn't stay on screen.
  setTimeout(() => { input.type = 'password'; }, 30000);
});
document.getElementById('createBtn').addEventListener('click', async () => {
  const email = document.getElementById('newEmail').value.trim();
  const pass  = document.getElementById('newPass').value;
  const isAdmin = document.getElementById('newIsAdmin').checked;
  const err = document.getElementById('createErr');
  const ok  = document.getElementById('createOk');
  err.textContent = ''; ok.textContent = '';
  if (!email || !pass) { err.textContent = 'Email + mot de passe requis.'; return; }
  try {
    const resp = await api('POST', '/api/admin/users', { email, password: pass, isAdmin });
    ok.textContent = `Compte créé : ${resp.user.email}. Communique le mot de passe à l'utilisateur via un canal sûr.`;
    document.getElementById('newEmail').value = '';
    document.getElementById('newPass').value = '';
    document.getElementById('newIsAdmin').checked = false;
    await loadUsers();
  } catch (e) { err.textContent = e.message; }
});

/* =================== DETAIL / ACTIONS =================== */
async function selectUser(id) {
  SELECTED_ID = id;
  renderUsers();
  document.getElementById('detailEmpty').classList.add('hide');
  document.getElementById('detailView').classList.remove('hide');
  const u = USERS.find(x => x.id === id);
  if (!u) return;
  document.getElementById('detailEmail').textContent = u.email;
  document.getElementById('detailId').textContent = u.id;
  document.getElementById('detailCreated').textContent = fmtDate(u.createdAt);
  document.getElementById('detailLastSeen').textContent = u.lastSeen ? fmtDate(u.lastSeen) : 'jamais';
  document.getElementById('detailSessions').textContent = u.activeSessions;
  const role = document.getElementById('detailRole');
  role.textContent = u.isAdmin ? 'admin' : 'utilisateur';
  role.classList.toggle('admin', u.isAdmin);
  document.getElementById('detailSelf').classList.toggle('hide', !u.isSelf);
  document.getElementById('togglAdminBtn').textContent = u.isAdmin ? 'Retirer les droits admin' : 'Donner les droits admin';
  // Self-protection: you can't admin-toggle or delete yourself via the admin panel.
  document.getElementById('togglAdminBtn').disabled = u.isSelf;
  document.getElementById('deleteBtn').disabled = u.isSelf;
  document.getElementById('detailErr').textContent = '';
  document.getElementById('detailOk').textContent = '';
  // Load the user's workout data.
  document.getElementById('profileView').innerHTML = '<p class="mut">Chargement…</p>';
  document.getElementById('programView').innerHTML = '<p class="mut">Chargement…</p>';
  document.getElementById('summaryView').innerHTML = '<p class="mut">—</p>';
  document.getElementById('historyView').innerHTML = '<p class="mut">—</p>';
  document.getElementById('rawJson').textContent = '…';
  try {
    const resp = await api('GET', `/api/admin/users/${encodeURIComponent(id)}/data`);
    renderUserData(resp.data);
  } catch (e) {
    document.getElementById('profileView').innerHTML = `<p class="mut">Erreur : ${esc(e.message)}</p>`;
    document.getElementById('programView').innerHTML = '';
    document.getElementById('rawJson').textContent = '';
  }
}

function renderUserData(data) {
  const profileView = document.getElementById('profileView');
  const programView = document.getElementById('programView');
  const summaryView = document.getElementById('summaryView');
  const historyView = document.getElementById('historyView');
  const rawJson = document.getElementById('rawJson');

  if (!data) {
    profileView.innerHTML = '<p class="mut">Aucune donnée enregistrée (onboarding non terminé).</p>';
    programView.innerHTML = '';
    summaryView.innerHTML = '';
    historyView.innerHTML = '';
    rawJson.textContent = '(vide)';
    return;
  }
  rawJson.textContent = JSON.stringify(data, null, 2);

  // Profile
  const p = data.profile;
  if (p) {
    const goals = Array.isArray(p.goals) ? p.goals.join(', ') : '—';
    const gear  = Array.isArray(p.gear) ? p.gear.join(', ') : '—';
    const pain  = Array.isArray(p.painToday) ? p.painToday.join(', ') : '—';
    profileView.innerHTML = `
      <div class="kv">
        <div>Âge</div><div>${esc(p.age)} ans</div>
        <div>Poids / Taille</div><div>${esc(p.weight)} kg · ${esc(p.height)} cm</div>
        <div>Sexe</div><div>${esc(p.sex)}</div>
        <div>Niveau</div><div>${esc(p.level)}/5</div>
        <div>Fréquence</div><div>${esc(p.freq)}×/sem · ${esc(p.duration)} min</div>
        <div>Objectifs</div><div>${esc(goals)}</div>
        <div>Matériel</div><div>${esc(gear)}</div>
        <div>Max haltères / barre</div><div>${esc(p.maxHalteres || '—')} / ${esc(p.maxBarre || '—')}</div>
        <div>Douleurs du jour</div><div>${esc(pain)}</div>
      </div>`;
  } else {
    profileView.innerHTML = '<p class="mut">Pas de profil.</p>';
  }

  // Program
  const cs = data.currentSession;
  if (cs && Array.isArray(cs.exos)) {
    const rows = cs.exos.map(e => {
      const load = e.timed ? `${e.reps}s tenue` : (e.weight != null ? `${e.weight} kg × ${e.reps}` : `${e.reps} reps`);
      return `<tr><td>${esc(e.name)}</td><td>${esc(e.sets)} séries</td><td>${esc(load)}</td><td class="mut">${esc(e.rest)}s repos</td></tr>`;
    }).join('');
    programView.innerHTML = `
      <p class="mut">${esc(cs.title || 'Séance')}</p>
      <table><thead><tr><th>Exo</th><th>Séries</th><th>Charge / Reps</th><th>Repos</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  } else {
    programView.innerHTML = '<p class="mut">Pas de séance en cours.</p>';
  }

  // Summary — all numeric aggregates go through num() to avoid any chance of
  // string-concat XSS on malicious saved data (see num()'s comment).
  const history = safeArr(data.history);
  const sessions = history.length;
  const totalSets = history.reduce((a, h) => a + num(safeArr(h.sets).length), 0);
  const totalVol = history.reduce((a, h) =>
    a + safeArr(h.sets).reduce((s, x) => s + num(x.weight) * num(x.reps), 0), 0);
  const lastDate = sessions ? fmtDate(history[history.length - 1].date) : '—';
  summaryView.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="l">Séances</div><div class="v">${num(sessions)}</div></div>
      <div class="stat-box"><div class="l">Séries totales</div><div class="v">${num(totalSets)}</div></div>
      <div class="stat-box"><div class="l">Volume (kg×reps)</div><div class="v">${num(totalVol)}</div></div>
      <div class="stat-box"><div class="l">Score forme</div><div class="v">${num(Math.round(num(data.formScore)))}</div></div>
    </div>
    <p class="mut" style="margin-top:8px">Dernière séance : ${esc(lastDate)}</p>`;

  // History — same treatment: escape every user-controlled field, force
  // numerics through num(), and coerce arrays via safeArr.
  if (sessions === 0) {
    historyView.innerHTML = '<p class="mut">Aucune séance.</p>';
  } else {
    const rows = history.slice(-20).reverse().map(h => {
      const setsArr = safeArr(h.sets);
      const setsCount = num(setsArr.length);
      const vol = setsArr.reduce((s, x) => s + num(x.weight) * num(x.reps), 0);
      return `<tr><td>${esc(fmtDate(h.date))}</td><td>${esc(h.title || '—')}</td><td>${setsCount}</td><td>${num(vol)}</td><td>RPE ${esc(h.rpe == null ? '—' : h.rpe)}</td></tr>`;
    }).join('');
    historyView.innerHTML = `
      <p class="mut">Les 20 dernières séances.</p>
      <table><thead><tr><th>Date</th><th>Séance</th><th>Séries</th><th>Volume</th><th>RPE</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
}

/* =================== DETAIL BUTTONS =================== */
document.getElementById('togglAdminBtn').addEventListener('click', async () => {
  const u = USERS.find(x => x.id === SELECTED_ID);
  if (!u) return;
  const err = document.getElementById('detailErr'); const ok = document.getElementById('detailOk');
  err.textContent = ''; ok.textContent = '';
  const want = !u.isAdmin;
  const verb = want ? 'promouvoir' : 'rétrograder';
  if (!confirm(`Confirmer : ${verb} « ${u.email} » ?`)) return;
  try {
    await api('POST', `/api/admin/users/${encodeURIComponent(u.id)}/admin`, { isAdmin: want });
    ok.textContent = 'Rôle mis à jour.';
    await loadUsers();
    await selectUser(u.id);
  } catch (e) { err.textContent = e.message; }
});

document.getElementById('resetPassBtn').addEventListener('click', async () => {
  const u = USERS.find(x => x.id === SELECTED_ID);
  if (!u) return;
  const err = document.getElementById('detailErr'); const ok = document.getElementById('detailOk');
  err.textContent = ''; ok.textContent = '';
  const suggested = genPassword(14);
  const pass = prompt(`Nouveau mot de passe pour « ${u.email} » (proposé : ${suggested}) :`, suggested);
  if (pass === null) return;
  try {
    await api('POST', `/api/admin/users/${encodeURIComponent(u.id)}/password`, { password: pass });
    ok.textContent = `Mot de passe changé. Toutes les sessions de cet utilisateur ont été révoquées.`;
  } catch (e) { err.textContent = e.message; }
});

document.getElementById('revokeBtn').addEventListener('click', async () => {
  const u = USERS.find(x => x.id === SELECTED_ID);
  if (!u) return;
  const err = document.getElementById('detailErr'); const ok = document.getElementById('detailOk');
  err.textContent = ''; ok.textContent = '';
  if (!confirm(`Révoquer toutes les sessions actives de « ${u.email} » ?`)) return;
  try {
    await api('POST', `/api/admin/users/${encodeURIComponent(u.id)}/revoke-sessions`);
    ok.textContent = 'Sessions révoquées.';
    await loadUsers();
    await selectUser(u.id);
  } catch (e) { err.textContent = e.message; }
});

document.getElementById('deleteBtn').addEventListener('click', async () => {
  const u = USERS.find(x => x.id === SELECTED_ID);
  if (!u) return;
  const err = document.getElementById('detailErr'); const ok = document.getElementById('detailOk');
  err.textContent = ''; ok.textContent = '';
  const typed = prompt(`Suppression DÉFINITIVE de « ${u.email} » et de toutes ses données.\nTape son email pour confirmer :`);
  if (typed == null) return;
  if (typed.trim().toLowerCase() !== u.email.toLowerCase()) {
    err.textContent = 'Confirmation incorrecte — suppression annulée.';
    return;
  }
  try {
    await api('DELETE', `/api/admin/users/${encodeURIComponent(u.id)}`);
    ok.textContent = `Compte « ${u.email} » supprimé.`;
    SELECTED_ID = null;
    document.getElementById('detailView').classList.add('hide');
    document.getElementById('detailEmpty').classList.remove('hide');
    await loadUsers();
  } catch (e) { err.textContent = e.message; }
});

/* =================== START =================== */
boot();
