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
async function makeToken(env) {
  const p = btoa(JSON.stringify({ exp: Date.now() + 12 * 3600e3 }));
  return p + '.' + b64u(await hmac(env.JWT_SECRET, p));
}
async function isAdmin(req, env) {
  const [p, sig] = (req.headers.get('Authorization') || '').replace('Bearer ', '').split('.');
  if (!p || !sig || b64u(await hmac(env.JWT_SECRET, p)) !== sig) return false;
  try { return JSON.parse(atob(p)).exp > Date.now(); } catch { return false; }
}

// ---------- validation + table mapping ----------
const str = (v, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Invalid or missing text value'); return v.trim(); };
const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error('Number out of range'); return v; };
const TABLES = {
  classes:  { cols: ['id', 'name', 'working_days'], pk: ['id'], row: r => [str(r.id, 64), str(r.name), num(r.totalWorkingDays, 1, 366)] },
  exams:    { cols: ['id', 'name', 'is_public'], pk: ['id'], row: r => [str(r.id, 64), str(r.name), r.isPublic ? 1 : 0] },
  subjects: { cols: ['id', 'class_id', 'name', 'max_marks', 'pass_marks'], pk: ['id'], row: r => [str(r.id, 64), str(r.classId, 64), str(r.name), num(r.maxMarks, 1, 1000), num(r.passingMarks, 0, 1000)] },
  students: { cols: ['id', 'admission_no', 'name', 'father_name', 'class_id'], pk: ['id'], row: r => [str(r.id, 64), str(r.admissionNo, 40).toUpperCase(), str(r.name), str(r.fatherName), str(r.classId, 64)] },
  results:  { cols: ['exam_id', 'student_id', 'attendance_days', 'marks'], pk: ['exam_id', 'student_id'],
    row: r => [str(r.examId, 64), str(r.studentId, 64), num(r.attendanceDays, 0, 366),
      JSON.stringify(Object.fromEntries(Object.entries(r.marks || {}).map(([k, v]) => [k, num(v, 0, 1000)])))] },
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
const settings = async db => {
  const { results } = await db.prepare('SELECT key,value FROM settings').all();
  const m = Object.fromEntries(results.map(r => [r.key, JSON.parse(r.value)]));
  return { madrasa: m.madrasa || { name: 'Madrasa', subtitle: '', logo: '' }, announcements: m.announcements || [] };
};

async function adminState(db) {
  const [ex, cl, su, st, re] = await db.batch(['exams', 'classes', 'subjects', 'students', 'results'].map(t => db.prepare(`SELECT * FROM ${t}`)));
  return {
    ...(await settings(db)),
    exams: ex.results.map(r => ({ id: r.id, name: r.name, isPublic: !!r.is_public })),
    classes: cl.results.map(r => ({ id: r.id, name: r.name, totalWorkingDays: r.working_days })),
    subjects: su.results.map(r => ({ id: r.id, classId: r.class_id, name: r.name, maxMarks: r.max_marks, passingMarks: r.pass_marks })),
    students: st.results.map(r => ({ id: r.id, admissionNo: r.admission_no, name: r.name, fatherName: r.father_name, classId: r.class_id })),
    results: re.results.map(r => ({ examId: r.exam_id, studentId: r.student_id, attendanceDays: r.attendance_days, marks: JSON.parse(r.marks) })),
  };
}

async function sync(db, body) {
  const stmts = [], { upserts: up = {}, deletes: del = {} } = body;
  for (const t of ['results', 'students', 'subjects', 'classes', 'exams']) if (del[t]?.length) stmts.push(...deletes(db, t, del[t]));
  for (const t of ['classes', 'exams', 'subjects', 'students', 'results']) if (up[t]?.length) stmts.push(...upserts(db, t, up[t]));
  if (up.settings) {
    const { madrasa: m, announcements: a } = up.settings;
    if (m) {
      const logo = (m.logo || '').trim();
      if (logo && !/^https?:\/\//i.test(logo)) throw new Error('Logo must be an http(s) URL');
      stmts.push(db.prepare("INSERT INTO settings VALUES ('madrasa', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(JSON.stringify({ name: str(m.name), subtitle: str(m.subtitle, 300), logo })));
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
  const examId = url.searchParams.get('exam') || '', adm = (url.searchParams.get('adm') || '').trim().toUpperCase();
  if (!examId || !adm) return fail('Exam and admission number are required');
  const exam = await db.prepare('SELECT id,name FROM exams WHERE id=? AND is_public=1').bind(examId).first();
  if (!exam) return fail('This examination is not available', 404);
  const st = await db.prepare('SELECT * FROM students WHERE admission_no=?').bind(adm).first();
  if (!st) return fail(`No student found with Admission No: ${adm}`, 404);
  const [cl, su, re] = await db.batch([
    db.prepare('SELECT name,working_days FROM classes WHERE id=?').bind(st.class_id),
    db.prepare('SELECT id,name,max_marks,pass_marks FROM subjects WHERE class_id=? ORDER BY rowid').bind(st.class_id),
    db.prepare('SELECT attendance_days,marks FROM results WHERE exam_id=? AND student_id=?').bind(examId, st.id),
  ]);
  const r = re.results[0], c = cl.results[0];
  if (!r) return fail(`Result not yet uploaded for ${st.name} (${adm}) in the selected exam.`, 404);
  return json({
    madrasa: (await settings(db)).madrasa, exam,
    student: { name: st.name, admissionNo: st.admission_no, fatherName: st.father_name },
    cls: { name: c?.name || 'N/A', totalWorkingDays: c?.working_days || 200 },
    subjects: su.results.map(s => ({ id: s.id, name: s.name, maxMarks: s.max_marks, passingMarks: s.pass_marks })),
    result: { attendanceDays: r.attendance_days, marks: JSON.parse(r.marks) },
  });
}

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (p === '/api/public' && req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT id,name FROM exams WHERE is_public=1 ORDER BY rowid').all();
        return json({ ...(await settings(env.DB)), exams: results.map(e => ({ id: e.id, name: e.name, isPublic: true })) });
      }
      if (p === '/api/result' && req.method === 'GET') return publicResult(env.DB, new URL(req.url));

      if (p === '/api/login' && req.method === 'POST') {
        const { username = '', password = '' } = await req.json();
        const okU = await safeEq(String(username), env.ADMIN_USER, env.JWT_SECRET);
        const okP = await safeEq(String(password), env.ADMIN_PASSWORD, env.JWT_SECRET);
        if (!(okU && okP)) { await new Promise(r => setTimeout(r, 600)); return fail('Invalid username or password', 401); }
        return json({ token: await makeToken(env) });
      }

      if (p.startsWith('/api/admin/')) {
        if (!(await isAdmin(req, env))) return fail('Session expired. Please log in again.', 401);
        if (p === '/api/admin/state' && req.method === 'GET') return json(await adminState(env.DB));
        if (p === '/api/admin/sync' && req.method === 'POST') { await sync(env.DB, await req.json()); return json({ ok: true }); }
      }
      return fail('Not found', 404);
    } catch (e) {
      const dup = /UNIQUE/i.test(e.message);
      return fail(dup ? 'Duplicate admission number' : e.message, dup ? 409 : 400);
    }
  },
};
