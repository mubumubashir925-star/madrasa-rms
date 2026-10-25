// ============================================================================
//  Result Publisher - multi-institution (SaaS) backend
//  Runs on Cloudflare Pages (_worker.js) or Workers, with one D1 database.
//  Every institution ("tenant") has its own data, address and admin login.
// ============================================================================
const BRAND = 'Result Publisher';
const enc = new TextEncoder();
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (m, s = 400) => json({ error: m }, s);
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- crypto, passwords, tokens ----------
async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const safeEq = async (a, b, secret) => crypto.subtle.timingSafeEqual(await hmac(secret, String(a)), await hmac(secret, String(b)));
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
async function hashPw(pw) { const s = crypto.getRandomValues(new Uint8Array(16)); return { salt: hex(s), hash: hex(await pbkdf2(String(pw), s)) }; }
const checkPw = async (pw, salt, hash) => crypto.subtle.timingSafeEqual(await pbkdf2(String(pw), unhex(salt)), unhex(hash));

async function makeToken(env, claims, hours = 12) {
  const p = btoa(JSON.stringify({ ...claims, exp: Date.now() + hours * 3600e3 }));
  return p + '.' + b64u(await hmac(env.JWT_SECRET, p));
}
async function readToken(req, env) {
  const [p, sig] = (req.headers.get('Authorization') || '').replace('Bearer ', '').split('.');
  if (!p || !sig || b64u(await hmac(env.JWT_SECRET, p)) !== sig) return null;
  try { const t = JSON.parse(atob(p)); return t.exp > Date.now() ? t : null; } catch { return null; }
}

// ---------- validation helpers ----------
const str = (v, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Invalid or missing text value'); return v.trim(); };
const opt = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const absent = v => v === 'AB';
const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error('Number out of range'); return v; };
const RESERVED = new Set(['super', 'admin', 'api', 'logo', 'icons', 'assets', 'static', 'login', 'logout', 'www', 'app', 'sw', 'styles', 'manifest', 'index', 'new', 'null', 'undefined', 'home', 'help', 'support', 'pricing']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const cleanSlug = v => String(v || '').trim().toLowerCase();
function checkSlug(slug) {
  if (!SLUG_RE.test(slug)) throw new Error('Address must be 3-40 characters: lowercase letters, numbers and hyphens only.');
  if (RESERVED.has(slug)) throw new Error('That address is reserved. Please choose another.');
}
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const todayStr = () => new Date().toISOString().slice(0, 10);
const tenantState = t => (t.status !== 'active' ? 'suspended' : (t.paid_until && t.paid_until < todayStr() ? 'expired' : 'active'));
const blockedMsg = st => (st === 'expired' ? 'This subscription has expired. Please contact support to renew.' : 'This account is suspended. Please contact support.');
const publicBlockedMsg = 'This results portal is currently unavailable. Please contact the institution.';
const escH = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Full-page notice for suspended / expired institutions: the real app (public portal, admin login) is never sent.
function blockedPage(name, title, msg) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escH(name)}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:#064e3b;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1e293b}
.c{background:#fff;max-width:420px;width:100%;border-radius:20px;padding:32px 24px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.35)}
.i{width:64px;height:64px;margin:0 auto 16px;border-radius:50%;background:#fef3c7;color:#b45309;font-size:30px;line-height:64px;font-weight:700}
h1{font-size:20px;margin:0 0 6px}h2{font-size:14px;font-weight:600;color:#64748b;margin:0 0 14px}p{margin:0;font-size:15px;line-height:1.6;color:#475569}</style></head>
<body><div class="c"><div class="i">!</div><h1>${escH(title)}</h1><h2>${escH(name)}</h2><p>${escH(msg)}</p></div></body></html>`;
  return new Response(html, { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

// ---------- database: schema + automatic upgrade from the old single-institution version ----------
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, admin_user TEXT NOT NULL, admin_salt TEXT NOT NULL, admin_hash TEXT NOT NULL, admin_ver INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'standard', paid_until TEXT NOT NULL DEFAULT '', max_students INTEGER NOT NULL DEFAULT 500, contact TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE IF NOT EXISTS settings (tenant_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant_id, key))",
  "CREATE TABLE IF NOT EXISTS exams (tenant_id INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, id))",
  "CREATE TABLE IF NOT EXISTS classes (tenant_id INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, working_days INTEGER NOT NULL DEFAULT 200, teacher_title TEXT NOT NULL DEFAULT '', teacher_name TEXT NOT NULL DEFAULT '', PRIMARY KEY (tenant_id, id))",
  "CREATE TABLE IF NOT EXISTS subjects (tenant_id INTEGER NOT NULL, id TEXT NOT NULL, class_id TEXT NOT NULL, name TEXT NOT NULL, max_marks INTEGER NOT NULL, pass_marks INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, id))",
  "CREATE TABLE IF NOT EXISTS students (tenant_id INTEGER NOT NULL, id TEXT NOT NULL, admission_no TEXT NOT NULL, name TEXT NOT NULL, father_name TEXT NOT NULL DEFAULT '', class_id TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, admission_no))",
  "CREATE TABLE IF NOT EXISTS results (tenant_id INTEGER NOT NULL, exam_id TEXT NOT NULL, student_id TEXT NOT NULL, attendance_days INTEGER NOT NULL DEFAULT 0, marks TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (tenant_id, exam_id, student_id))",
  "CREATE INDEX IF NOT EXISTS idx_subjects_class ON subjects(tenant_id, class_id)",
  "CREATE INDEX IF NOT EXISTS idx_students_class ON students(tenant_id, class_id)",
  "CREATE INDEX IF NOT EXISTS idx_results_student ON results(tenant_id, student_id)"
];
const LEGACY_COLUMNS = [
  ['students', 'extra', "TEXT NOT NULL DEFAULT '{}'"], ['classes', 'teacher_title', "TEXT NOT NULL DEFAULT ''"],
  ['classes', 'teacher_name', "TEXT NOT NULL DEFAULT ''"], ['subjects', 'active', 'INTEGER NOT NULL DEFAULT 1'],
];
const COPY = {
  settings: 'tenant_id, key, value', exams: 'tenant_id, id, name, is_public', classes: 'tenant_id, id, name, working_days, teacher_title, teacher_name',
  subjects: 'tenant_id, id, class_id, name, max_marks, pass_marks, active', students: 'tenant_id, id, admission_no, name, father_name, class_id, extra',
  results: 'tenant_id, exam_id, student_id, attendance_days, marks',
};
const tableExists = async (db, n) => !!(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(n).first());
const initialSettings = name => ({
  madrasa: { name, subtitle: 'Online Result Portal', logo: '', headTitle: 'Principal', headName: '', shareText: '' },
  portal: { enabled: false, message: 'Results are not published yet. Please check back soon.', showPosition: true },
});
let tenancyReady = false;
async function ensureTenancy(db, env) {
  if (tenancyReady) return;
  if (!(await tableExists(db, 'tenants'))) {
    if (!(await tableExists(db, 'exams'))) { await db.batch(SCHEMA.map(q => db.prepare(q))); } // brand-new database
    else {                                                    // old single-institution database -> becomes institution #1
      for (const [t, c, def] of LEGACY_COLUMNS) {
        const { results } = await db.prepare(`PRAGMA table_info(${t})`).all();
        if (!results.some(r => r.name === c)) await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`).run();
      }
      const old = Object.fromEntries((await db.prepare('SELECT key,value FROM settings').all()).results.map(r => [r.key, r.value]));
      const prof = old.madrasa ? JSON.parse(old.madrasa) : {}, adm = old.admin ? JSON.parse(old.admin) : null;
      let slug = slugify(prof.name) || 'main'; if (!SLUG_RE.test(slug) || RESERVED.has(slug)) slug = 'main';
      const cred = adm || { username: env.ADMIN_USER || 'admin', ...(await hashPw(env.ADMIN_PASSWORD || crypto.randomUUID())), ver: 0 };
      const stmts = [db.prepare(SCHEMA[0]), db.prepare(SCHEMA[1])];
      for (const [t, cols] of Object.entries(COPY)) {
        const def = SCHEMA.find(q => q.startsWith(`CREATE TABLE IF NOT EXISTS ${t} `));
        stmts.push(db.prepare(`ALTER TABLE ${t} RENAME TO ${t}_old`), db.prepare(def),
          db.prepare(`INSERT INTO ${t} (${cols}) SELECT ${cols.replace('tenant_id', '1')} FROM ${t}_old`), db.prepare(`DROP TABLE ${t}_old`));
      }
      stmts.push(...SCHEMA.filter(q => q.startsWith('CREATE INDEX')).map(q => db.prepare(q)),
        db.prepare("DELETE FROM settings WHERE key='admin'"),
        db.prepare("INSERT INTO tenants (id, slug, name, admin_user, admin_salt, admin_hash, admin_ver, plan, max_students, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, 'owner', 0, ?)")
          .bind(slug, prof.name || 'Institution', cred.username, cred.salt, cred.hash, cred.ver || 0, todayStr()),
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('default_slug', ?)").bind(slug));
      await db.batch(stmts);
    }
  }
  tenancyReady = true;
}
const getDefaultSlug = async db => (await db.prepare("SELECT value FROM meta WHERE key='default_slug'").first())?.value || '';
const tenantBySlug = (db, slug) => db.prepare('SELECT * FROM tenants WHERE slug=?').bind(cleanSlug(slug)).first();

// ---------- per-institution data ----------
const TABLES = {
  classes:  { cols: ['id', 'name', 'working_days', 'teacher_title', 'teacher_name'], pk: ['id'], row: r => [str(r.id, 64), str(r.name), num(r.totalWorkingDays, 1, 366), opt(r.teacherTitle, 60), opt(r.teacherName, 80)] },
  exams:    { cols: ['id', 'name', 'is_public'], pk: ['id'], row: r => [str(r.id, 64), str(r.name), r.isPublic ? 1 : 0] },
  subjects: { cols: ['id', 'class_id', 'name', 'max_marks', 'pass_marks', 'active'], pk: ['id'], row: r => [str(r.id, 64), str(r.classId, 64), str(r.name), num(r.maxMarks, 1, 1000), num(r.passingMarks, 0, 1000), r.active === false ? 0 : 1] },
  students: { cols: ['id', 'admission_no', 'name', 'father_name', 'class_id', 'extra'], pk: ['id'], row: r => [str(r.id, 64), str(r.admissionNo, 40).toUpperCase(), str(r.name), opt(r.fatherName), str(r.classId, 64),
    JSON.stringify(Object.fromEntries(Object.entries(r.extra || {}).slice(0, 20).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 200)])))] },
  results:  { cols: ['exam_id', 'student_id', 'attendance_days', 'marks'], pk: ['exam_id', 'student_id'],
    row: r => [str(r.examId, 64), str(r.studentId, 64), num(r.attendanceDays, -1, 366),
      JSON.stringify(Object.fromEntries(Object.entries(r.marks || {}).map(([k, v]) => [k, absent(v) ? 'AB' : num(v, 0, 1000)])))] },
};
// D1 allows max 100 bound params per statement -> chunk rows. Every statement is locked to one tenant_id.
const upserts = (db, tid, t, rows) => {
  const { cols, pk, row } = TABLES[t], all = ['tenant_id', ...cols], per = Math.floor(90 / all.length), out = [];
  const upd = cols.filter(c => !pk.includes(c)).map(c => `${c}=excluded.${c}`).join(',');
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per).map(r => [tid, ...row(r)]);
    const ph = chunk.map(() => `(${all.map(() => '?').join(',')})`).join(',');
    out.push(db.prepare(`INSERT INTO ${t} (${all.join(',')}) VALUES ${ph} ON CONFLICT(tenant_id,${pk.join(',')}) DO UPDATE SET ${upd}`).bind(...chunk.flat()));
  }
  return out;
};
const deletes = (db, tid, t, keys) => {
  const { pk } = TABLES[t], per = Math.floor(89 / pk.length), out = [];
  for (let i = 0; i < keys.length; i += per) {
    const chunk = keys.slice(i, i + per).map(k => String(k).split('|'));
    const where = pk.length === 1 ? `${pk[0]} IN (${chunk.map(() => '?').join(',')})` : '(' + chunk.map(() => `(${pk[0]}=? AND ${pk[1]}=?)`).join(' OR ') + ')';
    out.push(db.prepare(`DELETE FROM ${t} WHERE tenant_id=? AND ${where}`).bind(tid, ...chunk.flat()));
  }
  return out;
};

const DEF = {
  portal: { enabled: false, message: 'Results are not published yet. Please check back soon.', showPosition: true },
  grades: { scale: [{ min: 85, grade: 'A+', title: 'Outstanding' }, { min: 70, grade: 'A', title: 'Very Good' }, { min: 55, grade: 'B', title: 'Good' }, { min: 0, grade: 'C', title: 'Satisfactory' }], fail: { grade: 'F', title: 'Fail' } },
  fields: [{ id: 'admissionNo', label: 'Admission No', show: true }, { id: 'fatherName', label: 'Father / Guardian', show: true }],
};
// ---- public views get the logo as a small cacheable image link instead of a big embedded copy ----
const hashStr = x => { let h = 5381; for (let i = 0; i < x.length; i += 7) h = ((h << 5) + h + x.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + x.length.toString(36); };
const logoRef = (t, logo) => logo && (logo.startsWith('data:') || /^https:\/\//i.test(logo)) ? `/${t.slug}/logo?v=${hashStr(logo)}` : (logo || '');
const pubMadrasa = (t, m, withSign) => { const { headSign, ...rest } = m; return { ...rest, logo: logoRef(t, m.logo), ...(withSign ? { headSign } : {}) }; };
const shortName = (app, name) => { app = (app || '').trim(); if (app) return app.slice(0, 12); name = (name || '').trim(); if (name.length <= 12) return name; const w = name.split(/\s+/)[0]; return w.length <= 12 ? w : name.slice(0, 12); };
const settings = async (db, tid, keys) => {
  const { results } = keys
    ? await db.prepare(`SELECT key,value FROM settings WHERE tenant_id=? AND key IN (${keys.map(() => '?').join(',')})`).bind(tid, ...keys).all()
    : await db.prepare('SELECT key,value FROM settings WHERE tenant_id=?').bind(tid).all();
  const m = Object.fromEntries(results.map(r => [r.key, JSON.parse(r.value)]));
  return { madrasa: m.madrasa || initialSettings('Your Institution').madrasa, announcements: m.announcements || [],
    portal: { ...DEF.portal, ...(m.portal || {}) }, grades: m.grades || DEF.grades, fields: m.fields || DEF.fields, classSigns: m.classSigns || {}, teachers: m.teachers || [], assistants: m.assistants || [] };
};
const gradeOf = (p, failed, g) => { if (failed) return g.fail; const s = [...g.scale].sort((a, b) => b.min - a.min); return s.find(x => p >= x.min) || s[s.length - 1] || g.fail; };
const pctOf = (a, b) => (b > 0 ? Math.round(a / b * 1000) / 10 : 0);
const sumMarks = (m, subs) => subs.reduce((a, s) => a + (Number(m?.[s.id]) || 0), 0);
const exact = (a, b) => (b > 0 ? a / b * 100 : 0); // grades use the exact percentage, never the rounded one
const subPassed = (m, x) => !absent(m?.[x.id]) && (Number(m?.[x.id]) || 0) >= x.passingMarks;

async function adminState(db, tid) {
  const [ex, cl, su, st, re] = await db.batch(['exams', 'classes', 'subjects', 'students', 'results'].map(t => db.prepare(`SELECT * FROM ${t} WHERE tenant_id=?`).bind(tid)));
  return {
    ...(await settings(db, tid)),
    exams: ex.results.map(r => ({ id: r.id, name: r.name, isPublic: !!r.is_public })),
    classes: cl.results.map(r => ({ id: r.id, name: r.name, totalWorkingDays: r.working_days, teacherTitle: r.teacher_title || '', teacherName: r.teacher_name || '' })),
    subjects: su.results.map(r => ({ id: r.id, classId: r.class_id, name: r.name, maxMarks: r.max_marks, passingMarks: r.pass_marks, active: r.active !== 0 })),
    students: st.results.map(r => ({ id: r.id, admissionNo: r.admission_no, name: r.name, fatherName: r.father_name, classId: r.class_id, extra: JSON.parse(r.extra || '{}') })),
    results: re.results.map(r => ({ examId: r.exam_id, studentId: r.student_id, attendanceDays: r.attendance_days, marks: JSON.parse(r.marks) })),
  };
}

async function sync(db, t, body) {
  const tid = t.id, stmts = [], { upserts: up = {}, deletes: del = {} } = body;
  if (t.max_students > 0 && up.students?.length) { // plan limit
    const ids = up.students.map(s => String(s.id)); let existing = 0;
    for (let i = 0; i < ids.length; i += 90) {
      const c = ids.slice(i, i + 90);
      existing += (await db.prepare(`SELECT COUNT(*) AS c FROM students WHERE tenant_id=? AND id IN (${c.map(() => '?').join(',')})`).bind(tid, ...c).first()).c;
    }
    const cur = (await db.prepare('SELECT COUNT(*) AS c FROM students WHERE tenant_id=?').bind(tid).first()).c, added = ids.length - existing;
    if (added > 0 && cur + added - (del.students || []).length > t.max_students) throw new Error(`Student limit reached (${t.max_students}). Please contact support to upgrade your plan.`);
  }
  for (const k of ['results', 'students', 'subjects', 'classes', 'exams']) if (del[k]?.length) stmts.push(...deletes(db, tid, k, del[k]));
  for (const k of ['classes', 'exams', 'subjects', 'students', 'results']) if (up[k]?.length) stmts.push(...upserts(db, tid, k, up[k]));
  if (up.settings) {
    const { madrasa: m, announcements: a, portal: po, grades: gr, fields: fl, classSigns: cs, teachers: tch, assistants: asst } = up.settings;
    const okSign = v => !v || (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 90000);
    const put = (k, v) => stmts.push(db.prepare('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value=excluded.value').bind(tid, k, JSON.stringify(v)));
    if (po) put('portal', { enabled: !!po.enabled, message: opt(po.message, 500), showPosition: !!po.showPosition });
    if (gr) {
      if (!Array.isArray(gr.scale) || !gr.scale.length || gr.scale.length > 12) throw new Error('Add 1 to 12 grade rows');
      put('grades', { scale: gr.scale.map(x => ({ min: num(x.min, 0, 100), grade: str(x.grade, 12), title: opt(x.title, 40) })), fail: { grade: str(gr.fail?.grade, 12), title: opt(gr.fail?.title, 40) } });
    }
    if (fl) {
      if (!Array.isArray(fl) || fl.length > 20 || !fl.some(f => f.id === 'admissionNo')) throw new Error('Invalid student fields');
      put('fields', fl.map(f => { if (!/^[A-Za-z0-9_]{1,40}$/.test(f.id)) throw new Error('Invalid field id'); return { id: f.id, label: str(f.label, 40), show: !!f.show }; }));
    }
    if (tch) {
      if (!Array.isArray(tch) || tch.length > 100) throw new Error('Too many teacher links');
      const seen = new Set();
      put('teachers', tch.map(x => {
        const token = String(x.token || ''); if (!/^[A-Za-z0-9_-]{24,64}$/.test(token) || seen.has(token)) throw new Error('Invalid teacher link');
        seen.add(token);
        return { id: str(x.id, 64), name: str(x.name, 80), token, subjectIds: Array.isArray(x.subjectIds) ? x.subjectIds.slice(0, 600).map(v => str(v, 64)) : [], active: x.active !== false, attendance: x.attendance !== false, createdAt: opt(x.createdAt, 30) };
      }));
    }
    if (asst) {
      if (!Array.isArray(asst) || asst.length > 8) throw new Error('You can add up to 8 assistant heads');
      put('assistants', asst.map(x => { const sign = (x.sign || '').trim(); if (!okSign(sign)) throw new Error('A signature image is too large or invalid'); return { id: str(x.id, 64), title: opt(x.title, 60), name: opt(x.name, 80), sign, show: !!x.show }; }));
    }
    if (cs) {
      const e = Object.entries(cs).filter(([k, v]) => v);
      if (e.length > 80) throw new Error('Too many signatures');
      const out = {}; let total = 0;
      for (const [k, v] of e) { if (!okSign(v)) throw new Error('Signature image is too large or invalid'); total += v.length; out[str(k, 64)] = v; }
      if (total > 1500000) throw new Error('Signatures are too large in total. Use smaller images.');
      put('classSigns', out);
    }
    if (m) {
      const logo = (m.logo || '').trim();
      const okLogo = /^https?:\/\//i.test(logo) || /^\/(?!\/)[\w./-]*$/.test(logo) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(logo);
      if (logo && (!okLogo || logo.length > 200000)) throw new Error('Logo must be an image link, a /path, or an uploaded image under 150 KB');
      const name = str(m.name);
      const headSign = (m.headSign || '').trim(); if (!okSign(headSign)) throw new Error('Signature image is too large or invalid');
      put('madrasa', { name, subtitle: opt(m.subtitle, 300), logo, headTitle: opt(m.headTitle, 60), headName: opt(m.headName, 80), shareText: opt(m.shareText, 200), headSign, appName: opt(m.appName, 12), logoCropped: !!m.logoCropped, accent: /^#[0-9a-fA-F]{6}$/.test(m.accent || '') ? m.accent.toLowerCase() : '' });
      stmts.push(db.prepare('UPDATE tenants SET name=? WHERE id=?').bind(name, tid));
    }
    if (a) { if (!Array.isArray(a) || a.length > 30) throw new Error('Too many announcements'); put('announcements', a.map(x => str(x, 500))); }
  }
  if (stmts.length) await db.batch(stmts); // atomic
}

async function publicInfo(db, t) {
  const set = await settings(db, t.id, ['madrasa', 'announcements', 'portal', 'fields']), st = tenantState(t);
  if (st !== 'active') return json({ madrasa: { ...pubMadrasa(t, set.madrasa), shareText: '' }, announcements: [], portal: { enabled: false, message: publicBlockedMsg, showPosition: true }, fields: set.fields.slice(0, 1), exams: [], unavailable: true });
  const { results } = set.portal.enabled ? await db.prepare('SELECT id,name FROM exams WHERE tenant_id=? AND is_public=1 ORDER BY rowid').bind(t.id).all() : { results: [] };
  return json({ madrasa: pubMadrasa(t, set.madrasa), announcements: set.announcements, portal: set.portal, fields: set.fields.slice(0, 1), exams: results.map(e => ({ id: e.id, name: e.name, isPublic: true })) });
}

async function publicResult(db, t, url) {
  const tid = t.id, state = tenantState(t);
  if (state !== 'active') return json({ error: publicBlockedMsg, blocked: true }, 403);
  const set = await settings(db, tid, ['madrasa', 'portal', 'grades', 'fields', 'classSigns', 'assistants']);
  if (!set.portal.enabled) return fail(set.portal.message || 'Results are not available yet.', 403);
  const examId = url.searchParams.get('exam') || '', adm = (url.searchParams.get('adm') || '').trim().toUpperCase();
  if (!examId || !adm) return fail('Exam and admission number are required');
  const exam = await db.prepare('SELECT id,name FROM exams WHERE tenant_id=? AND id=? AND is_public=1').bind(tid, examId).first();
  if (!exam) return fail('This examination is not available', 404);
  const st = await db.prepare('SELECT * FROM students WHERE tenant_id=? AND admission_no=?').bind(tid, adm).first();
  if (!st) return fail(`No student found with ${set.fields[0]?.label || 'Admission No'}: ${adm}`, 404);
  const [cl, su, mine, mates] = await db.batch([
    db.prepare('SELECT name,working_days,teacher_title,teacher_name FROM classes WHERE tenant_id=? AND id=?').bind(tid, st.class_id),
    db.prepare('SELECT * FROM subjects WHERE tenant_id=? AND class_id=? ORDER BY rowid').bind(tid, st.class_id),
    db.prepare('SELECT r.exam_id, r.attendance_days, r.marks, e.name FROM results r JOIN exams e ON e.tenant_id=r.tenant_id AND e.id=r.exam_id WHERE r.tenant_id=? AND r.student_id=? AND e.is_public=1 ORDER BY e.rowid').bind(tid, st.id),
    db.prepare('SELECT r.student_id, r.marks FROM results r JOIN students s ON s.tenant_id=r.tenant_id AND s.id=r.student_id WHERE r.tenant_id=? AND r.exam_id=? AND s.class_id=?').bind(tid, examId, st.class_id),
  ]);
  const c = cl.results[0], subs = su.results.map(x => ({ id: x.id, name: x.name, maxMarks: x.max_marks, passingMarks: x.pass_marks, active: x.active !== 0 }));
  const cur = mine.results.find(r => r.exam_id === examId);
  if (!cur) return fail(`Result not yet uploaded for ${st.name} (${adm}) in the selected exam.`, 404);
  // A subject counts only if it is switched on for the class and marks exist for it; hidden subjects are skipped everywhere.
  const take = m => subs.filter(x => x.active && m?.[x.id] !== undefined);
  const maxOf = l => l.reduce((a, x) => a + x.maxMarks, 0);
  const complete = m => subs.every(x => !x.active || m?.[x.id] !== undefined); // blank marks = still pending
  const marks = JSON.parse(cur.marks);
  if (!complete(marks)) return fail(`The result of ${st.name} (${adm}) is not complete yet. Marks of some subjects are still pending - please check again later.`, 404);
  const mySubs = take(marks), maxPer = maxOf(mySubs);
  const obtained = sumMarks(marks, mySubs), passed = mySubs.length > 0 && mySubs.every(x => subPassed(marks, x));
  const percentage = pctOf(obtained, maxPer), G = set.grades, myPct = exact(obtained, maxPer);
  const pcts = mates.results.map(r => JSON.parse(r.marks)).filter(complete).map(m => { const l = take(m); return exact(sumMarks(m, l), maxOf(l)); });
  const exams = mine.results.filter(r => complete(JSON.parse(r.marks))).map(r => {
    const m = JSON.parse(r.marks), l = take(m), o = sumMarks(m, l), mx = maxOf(l), ok = l.length > 0 && l.every(x => subPassed(m, x));
    return { name: r.name, obtained: o, max: mx, percentage: pctOf(o, mx), passed: ok, grade: gradeOf(exact(o, mx), !ok, G) };
  });
  const oObt = exams.reduce((a, x) => a + x.obtained, 0), oMax = exams.reduce((a, x) => a + x.max, 0), failedCount = exams.filter(x => !x.passed).length, extra = JSON.parse(st.extra || '{}');
  return json({
    madrasa: pubMadrasa(t, set.madrasa, true), assistants: (set.assistants || []).filter(a => a.show && (a.name || a.sign)).map(a => ({ title: a.title, name: a.name, sign: a.sign })), exam, cls: { name: c?.name || 'N/A', totalWorkingDays: c?.working_days || 200, teacherTitle: c?.teacher_title || '', teacherName: c?.teacher_name || '', teacherSign: set.classSigns?.[st.class_id] || '' }, subjects: mySubs.map(x => ({ id: x.id, name: x.name, maxMarks: x.maxMarks, passed: subPassed(marks, x) })),
    details: [{ label: 'Student Name', value: st.name }, ...set.fields.filter(f => f.show).map(f => ({ label: f.label, value: f.id === 'admissionNo' ? st.admission_no : f.id === 'fatherName' ? st.father_name : extra[f.id] || '' })).filter(d => d.value)],
    result: { attendanceDays: cur.attendance_days, marks, grades: Object.fromEntries(mySubs.map(x => [x.id, absent(marks[x.id]) ? { grade: 'AB', title: 'Absent' } : gradeOf(exact(Number(marks[x.id]) || 0, x.maxMarks), !subPassed(marks, x), G)])) },
    summary: { obtained, max: maxPer, percentage, passed, grade: gradeOf(exact(obtained, maxPer), !passed, G) },
    position: set.portal.showPosition ? { rank: 1 + pcts.filter(p => p > myPct + 1e-9).length, of: pcts.length } : null,
    exams, overall: { obtained: oObt, max: oMax, percentage: pctOf(oObt, oMax), failedCount, count: exams.length, grade: gradeOf(exact(oObt, oMax), failedCount > 0, G) },
  });
}

// ---------- teacher marks-entry links (no login: the secret link is the key) ----------
async function entryApi(req, env, url, slug, token) {
  const db = env.DB, t = await tenantBySlug(db, slug);
  if (!t) return fail('Institution not found', 404);
  if (tenantState(t) !== 'active') return fail(publicBlockedMsg, 403);
  const set = await settings(db, t.id, ['madrasa', 'teachers']); let tc = null;
  for (const x of set.teachers) if ((await safeEq(token, x.token, env.JWT_SECRET)) && !tc) tc = x;
  if (!tc || tc.active === false) return fail('This link is not valid or has been switched off. Please ask the administrator for a new link.', 403);
  const tid = t.id, picked = new Set(tc.subjectIds || []);
  const [ex, cl, su] = await db.batch([
    db.prepare('SELECT id,name FROM exams WHERE tenant_id=? ORDER BY rowid').bind(tid),
    db.prepare('SELECT id,name,working_days FROM classes WHERE tenant_id=? ORDER BY rowid').bind(tid),
    db.prepare('SELECT id,class_id,name,max_marks,pass_marks FROM subjects WHERE tenant_id=? AND active<>0 ORDER BY rowid').bind(tid),
  ]);
  const subs = su.results.filter(x => !picked.size || picked.has(x.id));
  const classIds = new Set(subs.map(x => x.class_id)), classes = cl.results.filter(c => classIds.has(c.id));
  const subOf = id => subs.find(x => x.id === id);
  if (req.method === 'GET' && !url.searchParams.get('subject')) {
    const { results: stu } = await db.prepare('SELECT id,class_id,admission_no,name FROM students WHERE tenant_id=? ORDER BY rowid').bind(tid).all();
    return json({ teacher: tc.name, madrasa: { name: set.madrasa.name, logo: logoRef(t, set.madrasa.logo), accent: set.madrasa.accent || '' }, exams: ex.results, attendance: tc.attendance !== false, classes: classes.map(c => ({ id: c.id, name: c.name, workingDays: c.working_days || 200 })),
      subjects: subs.map(x => ({ id: x.id, classId: x.class_id, name: x.name, maxMarks: x.max_marks, passingMarks: x.pass_marks })),
      students: stu.filter(x => classIds.has(x.class_id)).map(x => ({ id: x.id, classId: x.class_id, admissionNo: x.admission_no, name: x.name })) });
  }
  const isGet = req.method === 'GET'; let b = null;
  if (!isGet) { if (req.method !== 'POST') return fail('Not found', 404); b = await req.json(); }
  const exam = ex.results.find(e => e.id === (isGet ? url.searchParams.get('exam') : b?.examId)), subjectId = isGet ? url.searchParams.get('subject') : b?.subjectId;
  const rowsSql = 'SELECT r.student_id, r.attendance_days, r.marks FROM results r JOIN students s ON s.tenant_id=r.tenant_id AND s.id=r.student_id WHERE r.tenant_id=? AND r.exam_id=? AND s.class_id=?';
  if (subjectId === '__att__') { // attendance (days present) instead of a subject
    const cls = classes.find(c => c.id === (isGet ? url.searchParams.get('class') : b?.classId));
    if (!exam || !cls || tc.attendance === false) return fail('Please choose an exam and a class you are allowed to enter.', 403);
    const days = cls.working_days || 200, { results: arows } = await db.prepare(rowsSql).bind(tid, exam.id, cls.id).all();
    if (isGet) return json({ att: Object.fromEntries(arows.filter(r => r.attendance_days >= 0).map(r => [r.student_id, r.attendance_days])) });
    const { results: astu } = await db.prepare('SELECT id,name FROM students WHERE tenant_id=? AND class_id=?').bind(tid, cls.id).all();
    const avalid = new Map(astu.map(x => [x.id, x.name])), ahave = new Map(arows.map(r => [r.student_id, r])), aentries = Object.entries(b.marks || {});
    if (aentries.length > 1500) throw new Error('Too many students in one save');
    const aup = [], adel = []; let an = 0;
    for (const [sid, v] of aentries) {
      if (!avalid.has(sid)) continue;
      let att = -1;
      if (!(v === '' || v === null || v === undefined)) { att = Number(v); if (!Number.isInteger(att) || att < 0 || att > days) throw new Error(`Days present for ${avalid.get(sid)} must be a whole number from 0 to ${days}.`); }
      const old = ahave.get(sid), m = old ? JSON.parse(old.marks) : {};
      if (att < 0 && !Object.keys(m).length) { if (old) adel.push(exam.id + '|' + sid); } else aup.push({ examId: exam.id, studentId: sid, attendanceDays: att, marks: m });
      an++;
    }
    const astmts = [...(adel.length ? deletes(db, tid, 'results', adel) : []), ...(aup.length ? upserts(db, tid, 'results', aup) : [])];
    if (astmts.length) await db.batch(astmts);
    return json({ ok: true, saved: an });
  }
  const sub = subOf(subjectId);
  if (!exam || !sub) return fail('Please choose an exam and a subject you are allowed to enter.', 403);
  const { results: rows } = await db.prepare(rowsSql).bind(tid, exam.id, sub.class_id).all();
  if (req.method === 'GET') return json({ marks: Object.fromEntries(rows.map(r => [r.student_id, JSON.parse(r.marks)[sub.id]]).filter(([, v]) => v !== undefined)) });
  const { results: stu } = await db.prepare('SELECT id,name FROM students WHERE tenant_id=? AND class_id=?').bind(tid, sub.class_id).all();
  const valid = new Map(stu.map(x => [x.id, x.name])), have = new Map(rows.map(r => [r.student_id, r])), entries = Object.entries(b.marks || {});
  if (entries.length > 1500) throw new Error('Too many students in one save');
  const up = [], del = []; let n = 0;
  for (const [sid, v] of entries) {
    if (!valid.has(sid)) continue;
    const old = have.get(sid), m = old ? JSON.parse(old.marks) : {};
    if (v === '' || v === null || v === undefined) delete m[sub.id];
    else if (absent(v)) m[sub.id] = 'AB';
    else { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > sub.max_marks) throw new Error(`Marks for ${valid.get(sid)} must be between 0 and ${sub.max_marks}.`); m[sub.id] = Math.round(x * 100) / 100; }
    const att = old ? old.attendance_days : -1;
    if (!Object.keys(m).length && att < 0) { if (old) del.push(exam.id + '|' + sid); } else up.push({ examId: exam.id, studentId: sid, attendanceDays: att, marks: m });
    n++;
  }
  const stmts = [...(del.length ? deletes(db, tid, 'results', del) : []), ...(up.length ? upserts(db, tid, 'results', up) : [])];
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true, saved: n });
}

// ---------- institution admin accounts ----------
async function tenantAuth(req, env) {
  const c = await readToken(req, env);
  if (!c || c.role !== 'tenant') return { status: 401, msg: 'Session expired. Please log in again.' };
  const t = await env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(c.tid).first();
  if (!t) return { status: 401, msg: 'Session expired. Please log in again.' };
  if (!c.imp) {
    if ((c.v || 0) !== t.admin_ver) return { status: 401, msg: 'Session expired. Please log in again.' };
    const st = tenantState(t); if (st !== 'active') return { status: 403, msg: blockedMsg(st), blocked: true };
  }
  return { t, claims: c };
}
async function tenantLogin(env, body, defSlug) {
  const t = await tenantBySlug(env.DB, body.slug || defSlug || '');
  const userOk = t ? await safeEq(body.username || '', t.admin_user, env.JWT_SECRET) : (await safeEq('x', 'y', env.JWT_SECRET), false);
  const passOk = t ? await checkPw(body.password || '', t.admin_salt, t.admin_hash) : (await pbkdf2('x', new Uint8Array(16)), false);
  if (!(t && userOk && passOk)) { await new Promise(r => setTimeout(r, 600)); return fail('Invalid username or password', 401); }
  const st = tenantState(t); if (st !== 'active') return fail(blockedMsg(st), 403);
  return json({ token: await makeToken(env, { role: 'tenant', tid: t.id, v: t.admin_ver }), slug: t.slug });
}
async function changeTenantAccount(env, t, body) {
  if (!(await checkPw(body.current || '', t.admin_salt, t.admin_hash))) return fail('Current password is wrong', 403);
  const username = opt(body.username, 40) || t.admin_user;
  if (username.length < 3) return fail('Username must be at least 3 characters');
  let { admin_salt: salt, admin_hash: hash } = t;
  if (body.password) { if (body.password.length < 8 || body.password.length > 100) return fail('New password must be 8 to 100 characters'); ({ salt, hash } = await hashPw(body.password)); }
  const ver = Date.now();
  await env.DB.prepare('UPDATE tenants SET admin_user=?, admin_salt=?, admin_hash=?, admin_ver=? WHERE id=?').bind(username, salt, hash, ver, t.id).run();
  return json({ token: await makeToken(env, { role: 'tenant', tid: t.id, v: ver }), username });
}

// ---------- super admin (the platform owner) ----------
const getSuper = async db => { const r = await db.prepare("SELECT value FROM meta WHERE key='super'").first(); return r ? JSON.parse(r.value) : null; };
const superReady = (env, sup) => !!(sup || (env.SUPER_USER && env.SUPER_PASSWORD));
const superPassOk = (env, sup, pw) => (sup ? checkPw(pw, sup.salt, sup.hash) : safeEq(pw, env.SUPER_PASSWORD, env.JWT_SECRET));
async function superAuth(req, env) {
  const c = await readToken(req, env);
  if (!c || c.role !== 'super') return false;
  return (c.v || 0) === ((await getSuper(env.DB))?.ver || 0);
}
const tenantView = r => ({ id: r.id, slug: r.slug, name: r.name, adminUser: r.admin_user, status: r.status, state: tenantState(r), plan: r.plan, paidUntil: r.paid_until, maxStudents: r.max_students, contact: r.contact, notes: r.notes, createdAt: r.created_at, students: r.students ?? 0, classes: r.classes ?? 0 });
function tenantFields(b) {
  const paid = opt(b.paidUntil, 10); if (paid && !/^\d{4}-\d{2}-\d{2}$/.test(paid)) throw new Error('Paid-until must be a date (YYYY-MM-DD).');
  return { plan: opt(b.plan, 30) || 'standard', paid_until: paid, max_students: num(b.maxStudents ?? 500, 0, 100000), contact: opt(b.contact, 100), notes: opt(b.notes, 500) };
}
async function superApi(req, env, p, url) {
  const db = env.DB, m = p.match(/^\/api\/super\/tenants(?:\/(\d+)(?:\/(reset|impersonate))?)?$/);
  if (p === '/api/super/me') return json({ ok: true, defaultSlug: await getDefaultSlug(db) });
  if (m && !m[1] && req.method === 'GET') {
    const { results } = await db.prepare('SELECT t.*, (SELECT COUNT(*) FROM students s WHERE s.tenant_id=t.id) AS students, (SELECT COUNT(*) FROM classes c WHERE c.tenant_id=t.id) AS classes FROM tenants t ORDER BY t.id DESC').all();
    return json({ tenants: results.map(tenantView), defaultSlug: await getDefaultSlug(db) });
  }
  if (m && !m[1] && req.method === 'POST') {
    const b = await req.json(), slug = cleanSlug(b.slug), name = str(b.name, 100), user = str(b.adminUser, 40), pw = String(b.adminPassword || '');
    checkSlug(slug); if (user.length < 3 || !/^[A-Za-z0-9._-]+$/.test(user)) throw new Error('Admin username: 3+ characters, letters/numbers/dot/dash/underscore.');
    if (pw.length < 8 || pw.length > 100) throw new Error('Admin password must be 8 to 100 characters.');
    const f = tenantFields(b), { salt, hash } = await hashPw(pw), init = initialSettings(name);
    try {
      await db.batch([
        db.prepare('INSERT INTO tenants (slug, name, admin_user, admin_salt, admin_hash, plan, paid_until, max_students, contact, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(slug, name, user, salt, hash, f.plan, f.paid_until, f.max_students, f.contact, f.notes, todayStr()),
        db.prepare("INSERT INTO settings (tenant_id, key, value) SELECT id, 'madrasa', ? FROM tenants WHERE slug=?").bind(JSON.stringify(init.madrasa), slug),
        db.prepare("INSERT INTO settings (tenant_id, key, value) SELECT id, 'portal', ? FROM tenants WHERE slug=?").bind(JSON.stringify(init.portal), slug),
      ]);
    } catch (e) { if (/UNIQUE/i.test(e.message)) throw new Error('That address is already taken. Choose another.'); throw e; }
    return json({ tenant: tenantView(await tenantBySlug(db, slug)) });
  }
  if (m && m[1]) {
    const id = Number(m[1]), t = await db.prepare('SELECT * FROM tenants WHERE id=?').bind(id).first();
    if (!t) return fail('Institution not found', 404);
    if (m[2] === 'impersonate' && req.method === 'POST') return json({ token: await makeToken(env, { role: 'tenant', tid: t.id, v: t.admin_ver, imp: true }, 3), slug: t.slug });
    if (m[2] === 'reset' && req.method === 'POST') {
      const b = await req.json(), pw = String(b.password || ''), user = opt(b.username, 40) || t.admin_user;
      if (pw.length < 8 || pw.length > 100) throw new Error('Password must be 8 to 100 characters.');
      const { salt, hash } = await hashPw(pw);
      await db.prepare('UPDATE tenants SET admin_user=?, admin_salt=?, admin_hash=?, admin_ver=? WHERE id=?').bind(user, salt, hash, Date.now(), id).run();
      return json({ ok: true });
    }
    if (!m[2] && req.method === 'PUT') {
      const b = await req.json(), f = tenantFields(b), name = str(b.name, 100), slug = cleanSlug(b.slug || t.slug), status = b.status === 'suspended' ? 'suspended' : 'active';
      if (slug !== t.slug) checkSlug(slug);
      try { await db.prepare('UPDATE tenants SET slug=?, name=?, status=?, plan=?, paid_until=?, max_students=?, contact=?, notes=? WHERE id=?').bind(slug, name, status, f.plan, f.paid_until, f.max_students, f.contact, f.notes, id).run(); }
      catch (e) { if (/UNIQUE/i.test(e.message)) throw new Error('That address is already taken.'); throw e; }
      if (slug !== t.slug && (await getDefaultSlug(db)) === t.slug) await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('default_slug', ?)").bind(slug).run();
      return json({ tenant: tenantView(await db.prepare('SELECT * FROM tenants WHERE id=?').bind(id).first()) });
    }
    if (!m[2] && req.method === 'DELETE') {
      const b = await req.json().catch(() => ({}));
      if (cleanSlug(b.confirm) !== t.slug) throw new Error('Type the institution address to confirm deletion.');
      const del = ['settings', 'exams', 'classes', 'subjects', 'students', 'results'].map(x => db.prepare(`DELETE FROM ${x} WHERE tenant_id=?`).bind(id));
      await db.batch([...del, db.prepare('DELETE FROM tenants WHERE id=?').bind(id), db.prepare("DELETE FROM meta WHERE key='default_slug' AND value=?").bind(t.slug)]);
      return json({ ok: true });
    }
  }
  if (p === '/api/super/default' && req.method === 'POST') {
    const b = await req.json(), slug = cleanSlug(b.slug);
    if (slug && !(await tenantBySlug(db, slug))) throw new Error('Institution not found');
    if (slug) await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('default_slug', ?)").bind(slug).run(); else await db.prepare("DELETE FROM meta WHERE key='default_slug'").run();
    return json({ ok: true, defaultSlug: slug });
  }
  if (p === '/api/super/account' && req.method === 'POST') {
    const b = await req.json(), sup = await getSuper(db);
    if (!(await superPassOk(env, sup, b.current || ''))) return fail('Current password is wrong', 403);
    const username = opt(b.username, 40) || sup?.username || env.SUPER_USER; if (username.length < 3) throw new Error('Username must be at least 3 characters');
    let { salt, hash } = sup || {};
    if (b.password) { if (b.password.length < 8 || b.password.length > 100) throw new Error('New password must be 8 to 100 characters'); ({ salt, hash } = await hashPw(b.password)); }
    else if (!sup) ({ salt, hash } = await hashPw(b.current));
    const ver = Date.now();
    await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('super', ?)").bind(JSON.stringify({ username, salt, hash, ver })).run();
    return json({ token: await makeToken(env, { role: 'super', v: ver }), username });
  }
  return fail('Not found', 404);
}

// ---------- API router ----------
async function api(req, env, url, p) {
  try {
    if (!env.JWT_SECRET) return fail('Server is not configured yet: add the JWT_SECRET secret in Cloudflare settings.', 500);
    await ensureTenancy(env.DB, env);
    const db = env.DB, defSlug = await getDefaultSlug(db);
    let m = p.match(/^\/api\/t\/([a-z0-9-]+)\/(public|result)$/);
    if (!m && (p === '/api/public' || p === '/api/result') && defSlug) m = [p, defSlug, p.slice(5)]; // old links / cached pages keep working
    if (m && req.method === 'GET') {
      const t = await tenantBySlug(db, m[1]); if (!t) return fail('Institution not found', 404);
      return m[2] === 'public' ? publicInfo(db, t) : publicResult(db, t, url);
    }
    const em = p.match(/^\/api\/t\/([a-z0-9-]+)\/entry\/([A-Za-z0-9_-]{24,64})$/);
    if (em && (req.method === 'GET' || req.method === 'POST')) return await entryApi(req, env, url, em[1], em[2]);
    if (p === '/api/login' && req.method === 'POST') return tenantLogin(env, await req.json(), defSlug);
    if (p === '/api/super/login' && req.method === 'POST') {
      const b = await req.json(), sup = await getSuper(db);
      if (!superReady(env, sup)) return fail('Super admin is not set up. Add SUPER_USER and SUPER_PASSWORD in your Cloudflare settings.', 503);
      const ok = (await safeEq(b.username || '', sup ? sup.username : env.SUPER_USER, env.JWT_SECRET)) && (await superPassOk(env, sup, b.password || ''));
      if (!ok) { await new Promise(r => setTimeout(r, 600)); return fail('Invalid username or password', 401); }
      return json({ token: await makeToken(env, { role: 'super', v: sup?.ver || 0 }) });
    }
    if (p.startsWith('/api/super/')) { if (!(await superAuth(req, env))) return fail('Session expired. Please log in again.', 401); return await superApi(req, env, p, url); }
    if (p.startsWith('/api/admin/')) {
      const a = await tenantAuth(req, env); if (a.status) return json({ error: a.msg, ...(a.blocked ? { blocked: true } : {}) }, a.status);
      if (p === '/api/admin/state' && req.method === 'GET') return json({ ...(await adminState(db, a.t.id)), institution: { slug: a.t.slug, plan: a.t.plan, maxStudents: a.t.max_students, paidUntil: a.t.paid_until } });
      if (p === '/api/admin/account' && req.method === 'POST') return changeTenantAccount(env, a.t, await req.json());
      if (p === '/api/admin/sync' && req.method === 'POST') { await sync(db, a.t, await req.json()); return json({ ok: true }); }
    }
    return fail('Not found', 404);
  } catch (e) {
    const dup = /UNIQUE/i.test(e.message);
    return fail(dup ? 'Duplicate admission number' : e.message, dup ? 409 : 400);
  }
}

// ---------- pages: one HTML shell, filled in per address (so WhatsApp previews show the right institution) ----------
async function servePage(req, env, url, route, slug) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', req.url), { method: 'GET' }));
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let appTitle = 'Results', name = BRAND, desc = 'Publish and check exam results online.', img = url.origin + '/icons/icon-512.png', status = 200, ogUrl = url.origin + '/', r = route, blocked = '';
  if (slug) {
    const t = await tenantBySlug(env.DB, slug);
    if (!t) { r = 'notfound'; status = 404; slug = ''; }
    else {
      const m = (await settings(env.DB, t.id, ['madrasa'])).madrasa, lg = m.logo || '', ts = tenantState(t); appTitle = shortName(m.appName, m.name || t.name);
      if (ts !== 'active') {
        if (r !== 'admin') return blockedPage(m.name || t.name, ts === 'expired' ? 'Portal unavailable' : 'Account suspended', publicBlockedMsg);
        blocked = blockedMsg(ts); // admin address: page loads, but only a platform-owner support session can get past the notice
      }
      name = m.name || t.name; desc = m.shareText || `Check your exam results online - ${name}`;
      img = /^https?:\/\//i.test(lg) ? lg : lg.startsWith('data:') ? `${url.origin}/${t.slug}/logo` : /^\/(?!\/)/.test(lg) ? url.origin + lg : img;
      ogUrl = url.origin + (url.pathname === '/' ? '/' : '/' + t.slug);
      if (r === 'admin') name = 'Admin - ' + name;
      if (r === 'entry') name = 'Marks entry - ' + name;
    }
  }
  const meta = v => ({ element(e) { e.setAttribute('content', v); } });
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(name); } })
    .on('meta[name="description"]', meta(desc)).on('meta[property="og:title"]', meta(name)).on('meta[property="og:description"]', meta(desc))
    .on('meta[property="og:image"]', meta(img)).on('meta[property="og:url"]', meta(ogUrl)).on('meta[property="og:site_name"]', meta(name))
    .on('meta[name="apple-mobile-web-app-title"]', meta(appTitle)).on('meta[name="blocked"]', meta(blocked)).on('meta[name="tenant"]', meta(slug || '')).on('meta[name="route"]', meta(r))
    .on('link[rel="manifest"]', { element(e) { if (slug) e.setAttribute('href', `/${slug}/manifest.webmanifest`); } })
    .transform(new Response(res.body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(r === 'entry' ? { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' } : {}) } }));
}
async function tenantAsset(env, url, slug, kind, defSlug) {
  const t = await tenantBySlug(env.DB, slug); if (!t) return new Response('Not found', { status: 404 });
  const m = (await settings(env.DB, t.id, ['madrasa'])).madrasa;
  if (kind === 'logo') {
    if (/^https:\/\//i.test(m.logo || '')) { // an online logo link: fetch it once and serve it from here
      try {
        const r = await fetch(m.logo, { headers: { Accept: 'image/*' }, cf: { cacheEverything: true, cacheTtl: 3600 } }), ct = r.headers.get('content-type') || '';
        if (!r.ok || !ct.startsWith('image/') || Number(r.headers.get('content-length') || 0) > 3000000) return new Response('Not found', { status: 404 });
        return new Response(r.body, { headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' } });
      } catch (e) { return new Response('Not found', { status: 404 }); }
    }
    const d = /^data:(image\/[a-z]+);base64,(.+)$/.exec(m.logo || ''); if (!d) return new Response('Not found', { status: 404 });
    return new Response(Uint8Array.from(atob(d[2]), c => c.charCodeAt(0)), { headers: { 'Content-Type': d[1], 'Cache-Control': url.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300' } });
  }
  const base = t.slug === defSlug ? '/' : `/${t.slug}/`;
  return new Response(JSON.stringify({ name: m.name, short_name: shortName(m.appName, m.name || t.name), id: base, start_url: base, scope: base, display: 'standalone', orientation: 'portrait', background_color: m.accent || '#064e3b', theme_color: m.accent || '#064e3b', lang: 'en',
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] }),
    { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=300' } });
}

async function handle(req, env) {
  const url = new URL(req.url), p = url.pathname, seg = p.split('/').filter(Boolean);
  if (p.startsWith('/api/')) return api(req, env, url, p);
  const last = seg[seg.length - 1] || '';
  const asset = seg.length === 2 && (seg[1] === 'logo' || seg[1] === 'manifest.webmanifest');
  if (!asset && /\.[a-z0-9]+$/i.test(last)) return env.ASSETS.fetch(req); // real files: styles.css, sw.js, icons...
  await ensureTenancy(env.DB, env);
  const defSlug = await getDefaultSlug(env.DB);
  if (asset) return tenantAsset(env, url, seg[0].toLowerCase(), seg[1] === 'logo' ? 'logo' : 'manifest', defSlug);
  if (p === '/logo' && defSlug) return tenantAsset(env, url, defSlug, 'logo', defSlug);
  let route = 'landing', slug = '';
  if (!seg.length) { if (defSlug) { route = 'public'; slug = defSlug; } }
  else if (seg[0] === 'super') route = 'super';
  else if (seg[0] === 'admin') { route = defSlug ? 'admin' : 'notfound'; slug = defSlug; }
  else { slug = seg[0].toLowerCase(); route = seg[1] === 'admin' ? 'admin' : seg[1] === 'entry' && seg[2] ? 'entry' : 'public'; }
  return servePage(req, env, url, route, slug);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); } catch (e) { return fail(e.message, 500); }
  },
};
