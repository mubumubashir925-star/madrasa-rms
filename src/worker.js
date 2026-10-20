const enc = new TextEncoder();
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (m, s = 400) => json({ error: m }, s);
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- auth (HMAC-signed token, 12h) ----------
async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
async function safeEq(a, b, secret) { // compare digests in constant time
  return crypto.subtle.timingSafeEqual(await hmac(secret, a), await hmac(secret, b));
}
async function makeToken(env, ver) {
  const p = btoa(JSON.stringify({ exp: Date.now() + 12 * 3600e3, v: ver || 0 }));
  return p + '.' + b64u(await hmac(env.JWT_SECRET, p));
}
async function isAdmin(req, env) {
  const [p, sig] = (req.headers.get('Authorization') || '').replace('Bearer ', '').split('.');
  if (!p || !sig || b64u(await hmac(env.JWT_SECRET, p)) !== sig) return false;
  try { const t = JSON.parse(atob(p)); return t.exp > Date.now() && (t.v || 0) === ((await getAdmin(env.DB))?.ver || 0); } catch { return false; }
}

// ---------- admin credentials (stored hashed in D1; falls back to Cloudflare secrets) ----------
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
async function getAdmin(db) { const r = await db.prepare("SELECT value FROM settings WHERE key='admin'").first(); return r ? JSON.parse(r.value) : null; }
async function passwordOk(env, adm, pw) {
  return adm ? crypto.subtle.timingSafeEqual(await pbkdf2(String(pw), unhex(adm.salt)), unhex(adm.hash)) : safeEq(String(pw), env.ADMIN_PASSWORD, env.JWT_SECRET);
}
async function changeAccount(env, body) {
  const adm = await getAdmin(env.DB);
  if (!(await passwordOk(env, adm, body.current || ''))) return fail('Current password is wrong', 403);
  const username = opt(body.username, 40) || adm?.username || env.ADMIN_USER;
  if (username.length < 3) return fail('Username must be at least 3 characters');
  let { salt, hash } = adm || {};
  if (body.password) {
    if (body.password.length < 8 || body.password.length > 100) return fail('New password must be 8 to 100 characters');
    const s = crypto.getRandomValues(new Uint8Array(16)); salt = hex(s); hash = hex(await pbkdf2(body.password, s));
  } else if (!adm) { // username-only change while still on the Cloudflare secret: keep the current password
    const s = crypto.getRandomValues(new Uint8Array(16)); salt = hex(s); hash = hex(await pbkdf2(body.current, s));
  }
  const ver = Date.now();
  await env.DB.prepare("INSERT INTO settings VALUES ('admin', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({ username, salt, hash, ver })).run();
  return json({ token: await makeToken(env, ver), username });
}

// ---------- validation + table mapping ----------
const str = (v, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Invalid or missing text value'); return v.trim(); };
const opt = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const absent = v => v === 'AB';
const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error('Number out of range'); return v; };
const TABLES = {
  classes:  { cols: ['id', 'name', 'working_days', 'teacher_title', 'teacher_name'], pk: ['id'], row: r => [str(r.id, 64), str(r.name), num(r.totalWorkingDays, 1, 366), opt(r.teacherTitle, 60), opt(r.teacherName, 80)] },
  exams:    { cols: ['id', 'name', 'is_public'], pk: ['id'], row: r => [str(r.id, 64), str(r.name), r.isPublic ? 1 : 0] },
  subjects: { cols: ['id', 'class_id', 'name', 'max_marks', 'pass_marks', 'active'], pk: ['id'], row: r => [str(r.id, 64), str(r.classId, 64), str(r.name), num(r.maxMarks, 1, 1000), num(r.passingMarks, 0, 1000), r.active === false ? 0 : 1] },
  students: { cols: ['id', 'admission_no', 'name', 'father_name', 'class_id', 'extra'], pk: ['id'], row: r => [str(r.id, 64), str(r.admissionNo, 40).toUpperCase(), str(r.name), opt(r.fatherName), str(r.classId, 64),
    JSON.stringify(Object.fromEntries(Object.entries(r.extra || {}).slice(0, 20).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 200)])))] },
  results:  { cols: ['exam_id', 'student_id', 'attendance_days', 'marks'], pk: ['exam_id', 'student_id'],
    row: r => [str(r.examId, 64), str(r.studentId, 64), num(r.attendanceDays, 0, 366),
      JSON.stringify(Object.fromEntries(Object.entries(r.marks || {}).map(([k, v]) => [k, absent(v) ? 'AB' : num(v, 0, 1000)])))] },
};
// D1 allows max 100 bound params per statement -> chunk rows
const upserts = (db, t, rows) => {
  const { cols, pk, row } = TABLES[t], per = Math.floor(90 / cols.length), out = [];
  const upd = cols.filter(c => !pk.includes(c)).map(c => `${c}=excluded.${c}`).join(',');
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per).map(row);
    const ph = chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    out.push(db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES ${ph} ON CONFLICT(${pk.join(',')}) DO UPDATE SET ${upd}`).bind(...chunk.flat()));
  }
  return out;
};
const deletes = (db, t, keys) => {
  const { pk } = TABLES[t], per = Math.floor(90 / pk.length), out = [];
  for (let i = 0; i < keys.length; i += per) {
    const chunk = keys.slice(i, i + per).map(k => String(k).split('|'));
    const where = pk.length === 1 ? `${pk[0]} IN (${chunk.map(() => '?').join(',')})` : chunk.map(() => `(${pk[0]}=? AND ${pk[1]}=?)`).join(' OR ');
    out.push(db.prepare(`DELETE FROM ${t} WHERE ${where}`).bind(...chunk.flat()));
  }
  return out;
};

// ---------- handlers ----------
const DEF = {
  portal: { enabled: false, message: 'Results are not published yet. Please check back soon.', showPosition: true },
  grades: { scale: [{ min: 85, grade: 'A+', title: 'Outstanding' }, { min: 70, grade: 'A', title: 'Very Good' }, { min: 55, grade: 'B', title: 'Good' }, { min: 0, grade: 'C', title: 'Satisfactory' }], fail: { grade: 'F', title: 'Fail' } },
  fields: [{ id: 'admissionNo', label: 'Admission No', show: true }, { id: 'fatherName', label: 'Father / Guardian', show: true }],
};
const settings = async db => {
  const { results } = await db.prepare('SELECT key,value FROM settings').all();
  const m = Object.fromEntries(results.map(r => [r.key, JSON.parse(r.value)]));
  return { madrasa: m.madrasa || { name: 'Your Institution', subtitle: 'Online Result Portal', logo: '', headTitle: 'Principal', headName: '', bismillah: false }, announcements: m.announcements || [],
    portal: { ...DEF.portal, ...(m.portal || {}) }, grades: m.grades || DEF.grades, fields: m.fields || DEF.fields };
};
const gradeOf = (p, failed, g) => { if (failed) return g.fail; const s = [...g.scale].sort((a, b) => b.min - a.min); return s.find(x => p >= x.min) || s[s.length - 1] || g.fail; };
const pctOf = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : 0);
const sumMarks = (m, subs) => subs.reduce((a, s) => a + (Number(m?.[s.id]) || 0), 0);
const exact = (a, b) => (b > 0 ? a / b * 100 : 0); // grades use the exact percentage, never the rounded one
const subPassed = (m, x) => !absent(m?.[x.id]) && (Number(m?.[x.id]) || 0) >= x.passingMarks;

async function adminState(db) {
  const [ex, cl, su, st, re] = await db.batch(['exams', 'classes', 'subjects', 'students', 'results'].map(t => db.prepare(`SELECT * FROM ${t}`)));
  return {
    ...(await settings(db)),
    exams: ex.results.map(r => ({ id: r.id, name: r.name, isPublic: !!r.is_public })),
    classes: cl.results.map(r => ({ id: r.id, name: r.name, totalWorkingDays: r.working_days, teacherTitle: r.teacher_title || '', teacherName: r.teacher_name || '' })),
    subjects: su.results.map(r => ({ id: r.id, classId: r.class_id, name: r.name, maxMarks: r.max_marks, passingMarks: r.pass_marks, active: r.active !== 0 })),
    students: st.results.map(r => ({ id: r.id, admissionNo: r.admission_no, name: r.name, fatherName: r.father_name, classId: r.class_id, extra: JSON.parse(r.extra || '{}') })),
    results: re.results.map(r => ({ examId: r.exam_id, studentId: r.student_id, attendanceDays: r.attendance_days, marks: JSON.parse(r.marks) })),
  };
}

async function sync(db, body) {
  const stmts = [], { upserts: up = {}, deletes: del = {} } = body;
  for (const t of ['results', 'students', 'subjects', 'classes', 'exams']) if (del[t]?.length) stmts.push(...deletes(db, t, del[t]));
  for (const t of ['classes', 'exams', 'subjects', 'students', 'results']) if (up[t]?.length) stmts.push(...upserts(db, t, up[t]));
  if (up.settings) {
    const { madrasa: m, announcements: a, portal: po, grades: gr, fields: fl } = up.settings;
    const put = (k, v) => stmts.push(db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, JSON.stringify(v)));
    if (po) put('portal', { enabled: !!po.enabled, message: opt(po.message, 500), showPosition: !!po.showPosition });
    if (gr) {
      if (!Array.isArray(gr.scale) || !gr.scale.length || gr.scale.length > 12) throw new Error('Add 1 to 12 grade rows');
      put('grades', { scale: gr.scale.map(x => ({ min: num(x.min, 0, 100), grade: str(x.grade, 12), title: opt(x.title, 40) })), fail: { grade: str(gr.fail?.grade, 12), title: opt(gr.fail?.title, 40) } });
    }
    if (fl) {
      if (!Array.isArray(fl) || fl.length > 20 || !fl.some(f => f.id === 'admissionNo')) throw new Error('Invalid student fields');
      put('fields', fl.map(f => { if (!/^[A-Za-z0-9_]{1,40}$/.test(f.id)) throw new Error('Invalid field id'); return { id: f.id, label: str(f.label, 40), show: !!f.show }; }));
    }
    if (m) {
      const logo = (m.logo || '').trim();
      const okLogo = /^https?:\/\//i.test(logo) || /^\/(?!\/)[\w./-]*$/.test(logo) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(logo);
      if (logo && (!okLogo || logo.length > 200000)) throw new Error('Logo must be an image link, a /path, or an uploaded image under 150 KB');
      stmts.push(db.prepare("INSERT INTO settings VALUES ('madrasa', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(JSON.stringify({ name: str(m.name), subtitle: opt(m.subtitle, 300), logo, headTitle: opt(m.headTitle, 60), headName: opt(m.headName, 80), shareText: opt(m.shareText, 200), bismillah: typeof m.bismillah === 'boolean' ? m.bismillah : true })));
    }
    if (a) {
      if (!Array.isArray(a) || a.length > 30) throw new Error('Too many announcements');
      stmts.push(db.prepare("INSERT INTO settings VALUES ('announcements', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(JSON.stringify(a.map(x => str(x, 500)))));
    }
  }
  if (stmts.length) await db.batch(stmts); // atomic
}

async function publicResult(db, url) {
  const set = await settings(db);
  if (!set.portal.enabled) return fail(set.portal.message || 'Results are not available yet.', 403);
  const examId = url.searchParams.get('exam') || '', adm = (url.searchParams.get('adm') || '').trim().toUpperCase();
  if (!examId || !adm) return fail('Exam and admission number are required');
  const exam = await db.prepare('SELECT id,name FROM exams WHERE id=? AND is_public=1').bind(examId).first();
  if (!exam) return fail('This examination is not available', 404);
  const st = await db.prepare('SELECT * FROM students WHERE admission_no=?').bind(adm).first();
  if (!st) return fail(`No student found with ${set.fields[0]?.label || 'Admission No'}: ${adm}`, 404);
  const [cl, su, mine, mates] = await db.batch([
    db.prepare('SELECT name,working_days,teacher_title,teacher_name FROM classes WHERE id=?').bind(st.class_id),
    db.prepare('SELECT * FROM subjects WHERE class_id=? ORDER BY rowid').bind(st.class_id),
    db.prepare('SELECT r.exam_id, r.attendance_days, r.marks, e.name FROM results r JOIN exams e ON e.id=r.exam_id WHERE r.student_id=? AND e.is_public=1 ORDER BY e.rowid').bind(st.id),
    db.prepare('SELECT r.student_id, r.marks FROM results r JOIN students s ON s.id=r.student_id WHERE r.exam_id=? AND s.class_id=?').bind(examId, st.class_id),
  ]);
  const c = cl.results[0], subs = su.results.map(x => ({ id: x.id, name: x.name, maxMarks: x.max_marks, passingMarks: x.pass_marks, active: x.active !== 0 }));
  const cur = mine.results.find(r => r.exam_id === examId);
  if (!cur) return fail(`Result not yet uploaded for ${st.name} (${adm}) in the selected exam.`, 404);
  // A subject counts only if it is switched on for the class (ticked in the marks screen) and marks exist for it; hidden subjects are skipped everywhere.
  const take = m => subs.filter(x => x.active && m?.[x.id] !== undefined);
  const maxOf = l => l.reduce((a, x) => a + x.maxMarks, 0);
  const marks = JSON.parse(cur.marks), mySubs = take(marks), maxPer = maxOf(mySubs);
  const obtained = sumMarks(marks, mySubs), passed = mySubs.length > 0 && mySubs.every(x => subPassed(marks, x));
  const percentage = pctOf(obtained, maxPer), G = set.grades, myPct = exact(obtained, maxPer);
  const pcts = mates.results.map(r => { const m = JSON.parse(r.marks), l = take(m); return exact(sumMarks(m, l), maxOf(l)); });
  const exams = mine.results.map(r => {
    const m = JSON.parse(r.marks), l = take(m), o = sumMarks(m, l), mx = maxOf(l), ok = l.length > 0 && l.every(x => subPassed(m, x));
    return { name: r.name, obtained: o, max: mx, percentage: pctOf(o, mx), passed: ok, grade: gradeOf(exact(o, mx), !ok, G) };
  });
  const oObt = exams.reduce((a, x) => a + x.obtained, 0), oMax = exams.reduce((a, x) => a + x.max, 0), failedCount = exams.filter(x => !x.passed).length, extra = JSON.parse(st.extra || '{}');
  return json({
    madrasa: set.madrasa, exam, cls: { name: c?.name || 'N/A', totalWorkingDays: c?.working_days || 200, teacherTitle: c?.teacher_title || '', teacherName: c?.teacher_name || '' }, subjects: mySubs,
    details: [{ label: 'Student Name', value: st.name }, ...set.fields.filter(f => f.show).map(f => ({ label: f.label, value: f.id === 'admissionNo' ? st.admission_no : f.id === 'fatherName' ? st.father_name : extra[f.id] || '' })).filter(d => d.value)],
    result: { attendanceDays: cur.attendance_days, marks, grades: Object.fromEntries(mySubs.map(x => [x.id, absent(marks[x.id]) ? { grade: 'AB', title: 'Absent' } : gradeOf(exact(Number(marks[x.id]) || 0, x.maxMarks), !subPassed(marks, x), G)])) },
    summary: { obtained, max: maxPer, percentage, passed, grade: gradeOf(exact(obtained, maxPer), !passed, G) },
    position: set.portal.showPosition ? { rank: 1 + pcts.filter(t => t > myPct + 1e-9).length, of: pcts.length } : null,
    exams, overall: { obtained: oObt, max: oMax, percentage: pctOf(oObt, oMax), failedCount, count: exams.length, grade: gradeOf(exact(oObt, oMax), failedCount > 0, G) },
  });
}

// Chat apps (WhatsApp, Telegram...) read the page's meta tags without running JavaScript, so the Worker fills them in from the institution profile.
async function servePage(req, env, url) {
  const res = await env.ASSETS.fetch(req);
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let m; try { m = (await settings(env.DB)).madrasa; } catch { return res; }
  const name = m.name || 'Results', desc = m.shareText || `Check your exam results online - ${name}`;
  const lg = m.logo || '', img = /^https?:\/\//i.test(lg) ? lg : lg.startsWith('data:') ? url.origin + '/logo' : /^\/(?!\/)/.test(lg) ? url.origin + lg : url.origin + '/icons/icon-512.png';
  const meta = v => ({ element(e) { e.setAttribute('content', v); } });
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(name); } })
    .on('meta[name="description"]', meta(desc)).on('meta[property="og:title"]', meta(name)).on('meta[property="og:description"]', meta(desc))
    .on('meta[property="og:image"]', meta(img)).on('meta[property="og:url"]', meta(url.origin + '/')).on('meta[property="og:site_name"]', meta(name))
    .transform(new Response(res.body, { status: res.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } }));
}

// Self-healing database: if an update needs a column the database doesn't have yet, add it automatically and retry once.
const MIGRATIONS = [
  ['students', 'extra', "TEXT NOT NULL DEFAULT '{}'"],
  ['classes', 'teacher_title', "TEXT NOT NULL DEFAULT ''"],
  ['classes', 'teacher_name', "TEXT NOT NULL DEFAULT ''"],
  ['subjects', 'active', 'INTEGER NOT NULL DEFAULT 1'],
];
const schemaErr = e => /no such column|has no column named/i.test(String(e && e.message));
async function ensureSchema(db) {
  for (const [t, c, def] of MIGRATIONS) {
    const { results } = await db.prepare(`PRAGMA table_info(${t})`).all();
    if (!results.some(r => r.name === c)) await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`).run();
  }
}

async function handle(req, env) {
    const p = new URL(req.url).pathname;
    if (p === '/admin' || p === '/admin/') return env.ASSETS.fetch(new Request(new URL('/', req.url), req)); // admin lives at /admin, never linked publicly
    if (p === '/logo') { // uploaded logo, served as a real image so WhatsApp/Telegram previews can use it
      const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec((await settings(env.DB)).madrasa.logo || '');
      if (!m) return new Response('Not found', { status: 404 });
      return new Response(Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)), { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=300' } });
    }
    if (p === '/' || p === '/index.html') return servePage(req, env, new URL(req.url));
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (p === '/api/public' && req.method === 'GET') {
        const set = await settings(env.DB);
        const { results } = set.portal.enabled ? await env.DB.prepare('SELECT id,name FROM exams WHERE is_public=1 ORDER BY rowid').all() : { results: [] };
        return json({ madrasa: set.madrasa, announcements: set.announcements, portal: set.portal, fields: set.fields.slice(0, 1), exams: results.map(e => ({ id: e.id, name: e.name, isPublic: true })) });
      }
      if (p === '/api/result' && req.method === 'GET') return publicResult(env.DB, new URL(req.url));

      if (p === '/api/login' && req.method === 'POST') {
        const { username = '', password = '' } = await req.json();
        const adm = await getAdmin(env.DB);
        const okU = await safeEq(String(username), adm?.username || env.ADMIN_USER, env.JWT_SECRET);
        const okP = await passwordOk(env, adm, password);
        if (!(okU && okP)) { await new Promise(r => setTimeout(r, 600)); return fail('Invalid username or password', 401); }
        return json({ token: await makeToken(env, adm?.ver) });
      }

      if (p.startsWith('/api/admin/')) {
        if (!(await isAdmin(req, env))) return fail('Session expired. Please log in again.', 401);
        if (p === '/api/admin/state' && req.method === 'GET') return json(await adminState(env.DB));
        if (p === '/api/admin/account' && req.method === 'POST') return changeAccount(env, await req.json());
        if (p === '/api/admin/sync' && req.method === 'POST') { await sync(env.DB, await req.json()); return json({ ok: true }); }
      }
      return fail('Not found', 404);
    } catch (e) {
      if (schemaErr(e)) throw e;
      const dup = /UNIQUE/i.test(e.message);
      return fail(dup ? 'Duplicate admission number' : e.message, dup ? 409 : 400);
    }
}

export default {
  async fetch(req, env) {
    const copy = req.clone();
    try { return await handle(req, env); }
    catch (e) {
      if (!schemaErr(e)) return fail(e.message, 500);
      try { await ensureSchema(env.DB); return await handle(copy, env); } catch (e2) { return fail(e2.message, 500); }
    }
  },
};
