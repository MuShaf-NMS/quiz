const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const { Pool } = require('pg');
const xlsx = require('./xlsx');
const QRCode = require('qrcode');
const { DB_USER, DB_PASSWORD, DB_HOST = 'localhost', DB_PORT = 5432, DB_NAME = 'quiz', ADMIN_USERNAME = 'admin' } = process.env;
if (!process.env.DATABASE_URL && !(DB_USER && DB_PASSWORD)) {
  console.error('Kredensial database belum diatur: isi DB_USER dan DB_PASSWORD (atau DATABASE_URL) di .env, lihat .env.example');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL
  || `postgres://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}` });
const initDb = async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS events (
    id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS quizzes (
    id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS games (
    id text PRIMARY KEY, quiz_id text, quiz_title text NOT NULL,
    event_id text REFERENCES events(id) ON DELETE SET NULL, event_name text,
    finished boolean NOT NULL DEFAULT false, total_questions int NOT NULL, answered_questions int NOT NULL,
    results jsonb NOT NULL, played_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id serial PRIMARY KEY, username text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'host'");
  await pool.query("UPDATE users SET role='admin' WHERE username=$1", [ADMIN_USERNAME]);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY, user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL)`);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  if (!(await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
    const generated = !process.env.ADMIN_PASSWORD;
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)', [ADMIN_USERNAME, hashPw(pw), 'admin']);
    console.log(`User awal dibuat: ${ADMIN_USERNAME}${generated ? ' / ' + pw + ' (password acak, catat sekarang)' : ''}`);
  }
  await pool.query('ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS event_id text REFERENCES events(id) ON DELETE SET NULL');
};
const QSEL = "SELECT data || jsonb_build_object('eventId', event_id) AS data FROM quizzes";
const listQuizzes = async () => (await pool.query(QSEL + ' ORDER BY created_at')).rows.map((r) => r.data);
const getQuiz = async (id) => (await pool.query(QSEL + ' WHERE id=$1', [id])).rows[0]?.data;
const saveQuiz = (q) => {
  const { eventId, ...data } = q;
  return pool.query('INSERT INTO quizzes (id, data, event_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=$2, event_id=$3',
    [q.id, data, eventId || null]);
};
const listEvents = async () => (await pool.query('SELECT id, name FROM events ORDER BY created_at')).rows;
const eventGames = async (eid) => (await pool.query(
  'SELECT * FROM games WHERE event_id=$1 AND answered_questions>0 ORDER BY played_at', [eid])).rows;

function persist(r) {
  if (r.qi < 0 || !r.players.size) return;
  const ranked = [...r.players.values()].sort((a, b) => b.score - a.score);
  const results = ranked.map((p, i) => ({ name: p.name, score: p.score, rank: i + 1, correct: p.correct, wrong: p.wrong }));
  pool.query(`INSERT INTO games (id, quiz_id, quiz_title, event_id, event_name, finished, total_questions, answered_questions, results)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET finished=$6, answered_questions=$8, results=$9, updated_at=now()`,
  [r.gameId, r.quiz.id, r.quiz.title, r.quiz.eventId || null, r.eventName || null, r.phase === 'end',
    r.quiz.questions.length, r.phase === 'end' ? r.quiz.questions.length : r.qi + 1, JSON.stringify(results)])
    .catch((e) => console.error('persist', e.message));
}
const rawBody = (req) => new Promise((ok, bad) => {
  const c = []; let n = 0;
  req.on('data', (d) => { n += d.length; if (n > 10e6) { bad(new Error('too large')); req.destroy(); } else c.push(d); });
  req.on('end', () => ok(Buffer.concat(c)));
  req.on('error', bad);
});

async function importXlsx(buf) {
  const { groups, errors } = await xlsx.parse(buf);
  if (errors.length) return { errors };
  const client = await pool.connect();
  const res = { events: 0, created: 0, replaced: 0, questions: 0 };
  try {
    await client.query('BEGIN');
    for (const g of groups) {
      let eid = null;
      if (g.event) {
        const f = await client.query('SELECT id FROM events WHERE lower(name)=lower($1)', [g.event]);
        if (f.rows[0]) eid = f.rows[0].id;
        else { eid = uid(); await client.query('INSERT INTO events (id, name) VALUES ($1,$2)', [eid, g.event.slice(0, 100)]); res.events++; }
      }
      const f = await client.query(
        "SELECT id FROM quizzes WHERE lower(data->>'title')=lower($1) AND event_id IS NOT DISTINCT FROM $2", [g.title, eid]);
      const q = cleanQuiz({ id: f.rows[0]?.id, title: g.title, questions: g.questions });
      await client.query('INSERT INTO quizzes (id, data, event_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET data=$2, event_id=$3', [q.id, q, eid]);
      if (f.rows[0]) res.replaced++; else res.created++;
      res.questions += q.questions.length;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return res;
}
// ---------- auth ----------
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const SESSION_DAYS = 7;
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === name)?.[1];
async function currentUser(req) {
  const t = cookieOf(req, 'sid');
  if (!t) return null;
  const r = await pool.query(
    `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token=$1 AND s.expires_at > now()`, [crypto.createHash('sha256').update(t).digest('hex')]);
  return r.rows[0] || null;
}
const fails = new Map();
const tooMany = (ip) => (fails.get(ip) || []).filter((t) => Date.now() - t < 5 * 60e3).length >= 10;
const setCookie = (req, res, v, maxAge) => res.setHeader('Set-Cookie',
  `sid=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);

const uid = () => crypto.randomBytes(5).toString('hex');

function cleanQuiz(q) {
  const questions = (Array.isArray(q.questions) ? q.questions : []).map((x) => {
    const type = ['mc', 'text', 'buzz'].includes(x.type) ? x.type : 'mc';
    const o = {
      type,
      text: String(x.text || '').slice(0, 500),
      image: String(x.image || '').slice(0, 500),
      time: Math.max(5, Math.min(300, +x.time || 20)),
      points: Math.max(0, Math.min(100000, +x.points || 1000)),
      penalty: Math.max(0, Math.min(100000, +x.penalty || 0)),
      speedBonus: x.speedBonus !== false,
      session: String(x.session || '').trim().slice(0, 60),
    };
    if (type === 'mc') {
      o.options = (x.options || []).map((s) => String(s).slice(0, 200)).filter((s) => s !== '').slice(0, 8);
      o.correct = [...new Set((x.correct || []).map(Number))].filter((i) => i >= 0 && i < o.options.length);
      o.multi = !!x.multi;
    } else {
      o.accepted = (x.accepted || []).map((s) => String(s).slice(0, 200)).filter((s) => s.trim() !== '');
    }
    return o;
  });
  return { id: q.id || uid(), eventId: q.eventId || null, title: String(q.title || 'Tanpa judul').slice(0, 100), questions };
}

// ---------- rooms ----------
const rooms = new Map();
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

function newPin() {
  let p;
  do { p = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(p));
  return p;
}

function createRoom(quiz) {
  const r = {
    pin: newPin(), hostToken: uid(), gameId: uid(), eventName: null, quiz, players: new Map(), clients: new Set(),
    phase: 'lobby', qi: -1, q: null, startedAt: 0, total: 0, remaining: 0, endsAt: 0,
    timer: null, answers: new Map(), buzz: null, locked: new Set(), deltas: new Map(), last: Date.now(),
  };
  rooms.set(r.pin, r);
  return r;
}

const bonus = (q, rem, total) => (q.speedBonus ? 0.5 + 0.5 * (rem / total) : 1);

const COUNTDOWN_MS = 3000;
function startQuestion(r) {
  r.q = r.quiz.questions[r.qi];
  r.phase = 'countdown';
  r.cdEnds = Date.now() + COUNTDOWN_MS;
  r.answers.clear(); r.buzz = null; r.locked.clear(); r.deltas.clear();
  clearTimeout(r.timer);
  r.timer = setTimeout(() => { beginQuestion(r); push(r); }, COUNTDOWN_MS);
}
function beginQuestion(r) {
  r.phase = 'question';
  r.total = r.q.time * 1000;
  r.remaining = r.total;
  r.endsAt = Date.now() + r.total;
  r.timer = setTimeout(() => { reveal(r); push(r); }, r.total);
}

function addScore(r, pid, d) {
  const p = r.players.get(pid);
  if (!p) return;
  if (d > 0) p.correct++; else if (d < 0) p.wrong++;
  p.score += d;
  r.deltas.set(pid, (r.deltas.get(pid) || 0) + d);
}

function isCorrect(q, v) {
  if (q.type === 'mc') {
    const sel = [...new Set((Array.isArray(v) ? v : [v]).map(Number))].sort();
    const cor = [...q.correct].sort();
    if (q.multi) return sel.length === cor.length && sel.every((x, i) => x === cor[i]);
    return sel.length === 1 && cor.includes(sel[0]);
  }
  return q.accepted.some((a) => norm(a) === norm(v));
}

function reveal(r) {
  if (r.phase !== 'question') return;
  clearTimeout(r.timer);
  if (r.q.type !== 'buzz') {
    for (const [pid, a] of r.answers) {
      if (isCorrect(r.q, a.value)) addScore(r, pid, Math.round(r.q.points * bonus(r.q, a.rem, r.total)));
      else if (r.q.penalty) addScore(r, pid, -r.q.penalty);
    }
  }
  r.phase = 'reveal';
}

function next(r) {
  if (r.qi + 1 >= r.quiz.questions.length) { r.phase = 'end'; return; }
  r.qi++;
  startQuestion(r);
}
function afterReveal(r) {
  const qs = r.quiz.questions;
  if (r.qi + 1 < qs.length && (qs[r.qi].session || '') !== (qs[r.qi + 1].session || '')) { clearTimeout(r.timer); r.phase = 'interim'; return; }
  next(r);
}
function nextAfterInterim(r) { r.qi++; startQuestion(r); }

// ---------- views ----------
function view(r, role, pid) {
  const isHost = role === 'host';
  const showAns = isHost || r.phase === 'reveal' || r.phase === 'end';
  const ranked = [...r.players.values()].sort((a, b) => b.score - a.score);
  const v = {
    pin: r.pin, gameId: isHost ? r.gameId : undefined, phase: r.phase, title: r.quiz.title, qi: r.qi, count: r.quiz.questions.length,
    players: ranked.map((p, i) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, rank: i + 1,
      answered: r.answers.has(p.id), delta: r.deltas.get(p.id) || 0,
      answer: isHost && r.answers.has(p.id) ? r.answers.get(p.id).value : undefined,
      locked: isHost ? r.locked.has(p.id) : undefined })),
  };
  const qs = r.quiz.questions;
  v.session = r.qi >= 0 && qs[r.qi] ? qs[r.qi].session || '' : '';
  if (r.phase === 'reveal') v.sessionEnds = r.qi + 1 < qs.length && (qs[r.qi].session || '') !== (qs[r.qi + 1].session || '');
  if (r.phase === 'interim') {
    v.nextSession = qs[r.qi + 1].session || '';
    v.sessionNo = new Set(qs.slice(0, r.qi + 1).map((x) => x.session || '')).size;
    v.sessionCount = new Set(qs.map((x) => x.session || '')).size;
  } else if (r.phase === 'countdown') {
    v.countdown = Math.max(0, r.cdEnds - Date.now());
    v.countdownTotal = COUNTDOWN_MS;
    if (isHost) v.q = { type: r.q.type, text: r.q.text, image: r.q.image, time: r.q.time, points: r.q.points, penalty: r.q.penalty,
      options: r.q.options, multi: r.q.multi, correct: r.q.correct, accepted: r.q.accepted };
  } else if (r.q && r.phase !== 'lobby' && r.phase !== 'end' && r.phase !== 'interim') {
    const q = r.q;
    v.q = { type: q.type, text: q.text, image: q.image, time: q.time, points: q.points, penalty: q.penalty,
      options: q.options, multi: q.multi };
    if (showAns) { v.q.correct = q.correct; v.q.accepted = q.accepted; }
    v.remaining = r.phase === 'question' && !r.buzz ? Math.max(0, r.endsAt - Date.now()) : r.remaining;
    v.paused = !!r.buzz && r.phase === 'question';
    v.total = r.total;
    if (r.buzz) { const p = r.players.get(r.buzz); v.buzz = { id: r.buzz, name: p ? p.name : '?' }; }
  }
  if (role === 'player') {
    const me = r.players.get(pid);
    if (!me) return { ...v, gone: true };
    v.you = { id: me.id, name: me.name, avatar: me.avatar, score: me.score, rank: ranked.indexOf(me) + 1, delta: r.deltas.get(pid) || 0,
      answered: r.answers.has(pid), answer: r.answers.has(pid) ? r.answers.get(pid).value : null,
      locked: r.locked.has(pid) };
    if (r.phase === 'reveal' && r.q.type !== 'buzz' && r.answers.has(pid)) v.you.correct = isCorrect(r.q, r.answers.get(pid).value);
  }
  return v;
}

function push(r) {
  r.last = Date.now();
  if (r.phase === 'reveal' || r.phase === 'end') persist(r);
  for (const c of r.clients) c.res.write(`data: ${JSON.stringify(view(r, c.role, c.pid))}\n\n`);
}

// ---------- actions ----------
function act(r, role, pid, b) {
  if (role === 'host') {
    switch (b.type) {
      case 'start': if (r.phase === 'lobby' && r.players.size && r.quiz.questions.length) { r.qi = 0; startQuestion(r); } break;
      case 'next': if (r.phase === 'reveal') afterReveal(r); else if (r.phase === 'interim') nextAfterInterim(r); break;
      case 'skip': reveal(r); break;
      case 'kick': r.players.delete(b.id); r.answers.delete(b.id); if (r.buzz === b.id) { r.buzz = null; resume(r); } break;
      case 'judge':
        if (r.phase === 'question' && r.buzz) {
          const id = r.buzz;
          if (b.correct) {
            addScore(r, id, Math.round(r.q.points * bonus(r.q, r.remaining, r.total)));
            r.buzz = null; reveal(r);
          } else {
            if (r.q.penalty) addScore(r, id, -r.q.penalty);
            r.locked.add(id); r.buzz = null;
            if ([...r.players.keys()].every((k) => r.locked.has(k))) reveal(r); else resume(r);
          }
        }
        break;
    }
  } else {
    if (!r.players.has(pid)) return;
    if (r.phase !== 'question') return;
    if (b.type === 'answer' && r.q.type !== 'buzz' && !r.answers.has(pid)) {
      const rem = Math.max(0, r.endsAt - Date.now());
      r.answers.set(pid, { value: b.value, rem });
      if (r.answers.size >= r.players.size) reveal(r);
    } else if (b.type === 'buzz' && r.q.type === 'buzz' && !r.buzz && !r.locked.has(pid)) {
      r.buzz = pid;
      r.remaining = Math.max(0, r.endsAt - Date.now());
      clearTimeout(r.timer);
    }
  }
}

function resume(r) {
  if (r.phase !== 'question' || r.buzz) return;
  r.endsAt = Date.now() + r.remaining;
  clearTimeout(r.timer);
  r.timer = setTimeout(() => { reveal(r); push(r); }, r.remaining);
}

// ---------- avatar (proxy + cache DiceBear) & QR ----------
const AVATAR_URL = process.env.DICEBEAR_URL || 'https://api.dicebear.com/10.x/clay/svg';
const AVATAR_CACHE_MAX = 2000;
const avatarCache = new Map(); // seed -> Promise<string|null>
const fallbackAvatar = (seed) => {
  const hue = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="hsl(${hue} 70% 65%)"/>`
    + '<circle cx="35" cy="42" r="6" fill="#222"/><circle cx="65" cy="42" r="6" fill="#222"/>'
    + '<path d="M30 62q20 20 40 0" stroke="#222" stroke-width="6" fill="none" stroke-linecap="round"/></svg>';
};
function avatarSvg(seed) {
  if (!avatarCache.has(seed)) {
    const p = fetch(`${AVATAR_URL}?seed=${encodeURIComponent(seed)}`, { signal: AbortSignal.timeout(5000) })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .catch((e) => { avatarCache.delete(seed); console.error('avatar', seed, e.message); return null; });
    if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value);
    avatarCache.set(seed, p);
  }
  return avatarCache.get(seed);
}
const randomSeed = () => crypto.randomBytes(6).toString('hex');
const validSeed = (s) => /^[\w-]{1,24}$/.test(String(s || ''));

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((ok) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
});

http.createServer((req, res) => handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Server error' }); else res.end(); }))
  .listen(PORT, async () => { await initDb(); console.log(`Quiz app jalan di http://localhost:${PORT}  (host: /host)`); });

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  const PUBLIC_API = ['/api/join', '/api/act', '/api/login', '/api/logout', '/api/me'];
  const user = p.startsWith('/api/') ? await currentUser(req) : null;
  if (p.startsWith('/api/') && !PUBLIC_API.includes(p) && !user) return json(res, 401, { error: 'Belum login' });

  if (p === '/api/me') return user ? json(res, 200, { username: user.username, role: user.role }) : json(res, 401, { error: 'Belum login' });
  if (p === '/api/login' && req.method === 'POST') {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
    if (tooMany(ip)) return json(res, 429, { error: 'Terlalu banyak percobaan, coba lagi beberapa menit' });
    const b = await body(req);
    const row = (await pool.query('SELECT * FROM users WHERE lower(username)=lower($1)', [String(b.username || '')])).rows[0];
    if (!row || !checkPw(String(b.password || ''), row.password_hash)) {
      fails.set(ip, [...(fails.get(ip) || []), Date.now()]);
      return json(res, 401, { error: 'Username atau password salah' });
    }
    const t = crypto.randomBytes(32).toString('hex');
    await pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)",
      [crypto.createHash('sha256').update(t).digest('hex'), row.id, String(SESSION_DAYS)]);
    setCookie(req, res, t, SESSION_DAYS * 86400);
    return json(res, 200, { username: row.username, role: row.role });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const t = cookieOf(req, 'sid');
    if (t) await pool.query('DELETE FROM sessions WHERE token=$1', [crypto.createHash('sha256').update(t).digest('hex')]);
    setCookie(req, res, '', 0);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/password' && req.method === 'POST') {
    const b = await body(req);
    const row = (await pool.query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
    if (!checkPw(String(b.old || ''), row.password_hash)) return json(res, 400, { error: 'Password lama salah' });
    if (String(b.new || '').length < 6) return json(res, 400, { error: 'Password baru minimal 6 karakter' });
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPw(b.new), user.id]);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/users' || p.startsWith('/api/users/')) {
    if (user.role !== 'admin') return json(res, 403, { error: 'Hanya admin yang boleh mengelola user' });
    const id = +p.split('/')[3] || null;
    const admins = async () => +(await pool.query("SELECT count(*) FROM users WHERE role='admin'")).rows[0].count;
    if (p === '/api/users' && req.method === 'GET')
      return json(res, 200, (await pool.query('SELECT id, username, role FROM users ORDER BY id')).rows);
    if (p === '/api/users' && req.method === 'POST') {
      const b = await body(req);
      const username = String(b.username || '').trim();
      if (!/^[\w.-]{3,30}$/.test(username)) return json(res, 400, { error: 'Username 3-30 karakter (huruf, angka, . _ -)' });
      if (String(b.password || '').length < 6) return json(res, 400, { error: 'Password minimal 6 karakter' });
      if (!['admin', 'host'].includes(b.role)) return json(res, 400, { error: 'Role tidak valid' });
      try { await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)', [username, hashPw(b.password), b.role]); }
      catch (e) { if (e.code === '23505') return json(res, 400, { error: 'Username sudah dipakai' }); throw e; }
      return json(res, 200, { ok: true });
    }
    const target = id && (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!target) return json(res, 404, { error: 'User tidak ditemukan' });
    if (req.method === 'DELETE') {
      if (id === user.id) return json(res, 400, { error: 'Tidak bisa menghapus akun sendiri' });
      await pool.query('DELETE FROM users WHERE id=$1', [id]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      if (b.role !== undefined) {
        if (!['admin', 'host'].includes(b.role)) return json(res, 400, { error: 'Role tidak valid' });
        if (target.role === 'admin' && b.role !== 'admin' && (await admins()) <= 1) return json(res, 400, { error: 'Harus ada minimal satu admin' });
        await pool.query('UPDATE users SET role=$1 WHERE id=$2', [b.role, id]);
      }
      if (b.password !== undefined) {
        if (String(b.password).length < 6) return json(res, 400, { error: 'Password minimal 6 karakter' });
        await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPw(b.password), id]);
        await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method tidak didukung' });
  }

  if (p === '/events') {
    const r = rooms.get(u.searchParams.get('pin'));
    const role = u.searchParams.get('role');
    const pid = u.searchParams.get('id');
    if (!r || (role === 'host' && u.searchParams.get('token') !== r.hostToken)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const c = { res, role, pid };
    r.clients.add(c);
    res.write(`data: ${JSON.stringify(view(r, role, pid))}\n\n`);
    req.on('close', () => r.clients.delete(c));
    return;
  }

  if (p === '/api/quizzes' && req.method === 'GET') return json(res, 200, await listQuizzes());
  if (p === '/api/quizzes' && req.method === 'POST') {
    const q = cleanQuiz(await body(req));
    await saveQuiz(q);
    return json(res, 200, q);
  }
  if (p.startsWith('/api/quizzes/') && req.method === 'DELETE') {
    await pool.query('DELETE FROM quizzes WHERE id=$1', [p.split('/').pop()]);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/events' && req.method === 'GET') return json(res, 200, await listEvents());
  if (p === '/api/events' && req.method === 'POST') {
    const b = await body(req);
    const name = String(b.name || '').trim().slice(0, 100);
    if (!name) return json(res, 400, { error: 'Nama event kosong' });
    const id = b.id || uid();
    await pool.query('INSERT INTO events (id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name=$2', [id, name]);
    return json(res, 200, { id, name });
  }
  if (p.startsWith('/api/events/') && req.method === 'DELETE') {
    await pool.query('DELETE FROM events WHERE id=$1', [p.split('/').pop()]);
    return json(res, 200, { ok: true });
  }
  let m;
  if ((m = p.match(/^\/api\/events\/([^/]+)\/results$/))) {
    const ev = (await pool.query('SELECT id, name FROM events WHERE id=$1', [m[1]])).rows[0];
    if (!ev) return json(res, 404, { error: 'Event tidak ditemukan' });
    return json(res, 200, { event: ev, ...xlsx.aggregate(await eventGames(ev.id)) });
  }
  const sendXlsx = (name, buf) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}.xlsx"` });
    res.end(buf);
  };
  if ((m = p.match(/^\/api\/events\/([^/]+)\/export\.xlsx$/))) {
    const ev = (await pool.query('SELECT id, name FROM events WHERE id=$1', [m[1]])).rows[0];
    if (!ev) { res.writeHead(404); return res.end('Event tidak ditemukan'); }
    return sendXlsx('hasil-' + ev.name, await xlsx.exportEvent(ev, await eventGames(ev.id)));
  }
  if ((m = p.match(/^\/api\/games\/([^/]+)\/export\.xlsx$/))) {
    const g = (await pool.query('SELECT * FROM games WHERE id=$1', [m[1]])).rows[0];
    if (!g) { res.writeHead(404); return res.end('Game tidak ditemukan'); }
    return sendXlsx('hasil-' + g.quiz_title, await xlsx.exportGame(g));
  }
  if (p === '/api/template.xlsx') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="template-quiz.xlsx"' });
    return res.end(await xlsx.template());
  }
  if (p === '/api/import' && req.method === 'POST') {
    try { return json(res, 200, await importXlsx(await rawBody(req))); }
    catch (e) { console.error(e); return json(res, 400, { errors: ['File bukan xlsx yang valid'] }); }
  }
  if (p === '/api/room' && req.method === 'POST') {
    const rb = await body(req);
    const quiz = await getQuiz(rb.quizId);
    if (!quiz || !quiz.questions.length) return json(res, 400, { error: 'Quiz kosong / tidak ditemukan' });
    const r = createRoom(quiz);
    if (quiz.eventId) r.eventName = (await pool.query('SELECT name FROM events WHERE id=$1', [quiz.eventId])).rows[0]?.name || null;
    return json(res, 200, { pin: r.pin, token: r.hostToken });
  }
  if (p === '/api/join' && req.method === 'POST') {
    const b = await body(req);
    const r = rooms.get(String(b.pin));
    const name = String(b.name || '').trim().slice(0, 20);
    if (!r) return json(res, 404, { error: 'PIN tidak ditemukan' });
    if (!name) return json(res, 400, { error: 'Isi nama dulu' });
    if (r.phase !== 'lobby') return json(res, 400, { error: 'Game sudah dimulai' });
    if ([...r.players.values()].some((x) => norm(x.name) === norm(name))) return json(res, 400, { error: 'Nama sudah dipakai' });
    const id = uid();
    r.players.set(id, { id, name, avatar: validSeed(b.avatar) ? String(b.avatar) : randomSeed(), score: 0, correct: 0, wrong: 0 });
    push(r);
    return json(res, 200, { id, pin: r.pin });
  }
  if (p === '/api/act' && req.method === 'POST') {
    const b = await body(req);
    const r = rooms.get(String(b.pin));
    if (!r) return json(res, 404, { error: 'room' });
    if (b.role === 'host') { if (b.token !== r.hostToken) return json(res, 403, {}); act(r, 'host', null, b); }
    else act(r, 'player', b.id, b);
    push(r);
    return json(res, 200, { ok: true });
  }

  if ((m = p.match(/^\/avatar\/([\w-]{1,24})\.svg$/))) {
    const svg = await avatarSvg(m[1]);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': svg ? 'public, max-age=86400' : 'public, max-age=30' });
    return res.end(svg || fallbackAvatar(m[1]));
  }
  if (p === '/qr.svg') {
    const target = u.searchParams.get('u') || '';
    if (!/^https?:\/\/\S{1,300}$/.test(target)) return json(res, 400, { error: 'URL tidak valid' });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
    return res.end(await QRCode.toString(target, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  }

  // static
  let f = p === '/' ? '/index.html' : p;
  if (f === '/host') f = '/host.html';
  const fp = path.join(PUB, path.normalize(f));
  if (!fp.startsWith(PUB) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

setInterval(() => {
  for (const [k, r] of rooms) if (Date.now() - r.last > 3 * 3600e3 && !r.clients.size) rooms.delete(k);
}, 600e3);
