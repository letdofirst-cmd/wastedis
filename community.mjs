import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

const TYPES = ['city', 'school', 'college', 'hostel', 'society', 'other'];
const CATEGORIES = ['garbage', 'overflow', 'drain', 'toilet', 'littering', 'other'];
const STATUSES = ['open', 'in_progress', 'resolved', 'rejected'];
const MAX_POINTS = 100;
const MAX_PHOTO_BYTES = 900 * 1024;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function registerCommunityRoutes({ app, db, currentUser, requireSameOrigin, uploadDir }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      location_text TEXT NOT NULL DEFAULT '', head_user_id TEXT NOT NULL REFERENCES users(id),
      join_code TEXT NOT NULL UNIQUE, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_members (
      community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at INTEGER NOT NULL, PRIMARY KEY (community_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY, community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      reporter_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL, location_text TEXT NOT NULL DEFAULT '', latitude REAL, longitude REAL,
      location_source TEXT NOT NULL, photo_file TEXT, status TEXT NOT NULL DEFAULT 'open',
      head_response TEXT NOT NULL DEFAULT '', points_awarded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS issues_community ON issues(community_id, status);
    CREATE TABLE IF NOT EXISTS points_ledger (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      issue_id TEXT, delta INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rewards (
      id TEXT PRIMARY KEY, community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', cost INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY, reward_id TEXT NOT NULL REFERENCES rewards(id), community_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, cost INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
    );
  `);
  mkdirSync(uploadDir, { recursive: true });

  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  function auth(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in.' });
    req.me = user;
    next();
  }
  function adminOnly(req, res, next) {
    if (req.me?.role !== 'admin') return res.status(404).json({ error: 'Not found.' });
    next();
  }
  const isAdmin = req => req.me.role === 'admin';
  function community(id) { return one('SELECT * FROM communities WHERE id = ?', id); }
  function isMember(cid, uid) { return Boolean(one('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', cid, uid)); }
  function canView(req, c) { return isAdmin(req) || c.head_user_id === req.me.id || isMember(c.id, req.me.id); }
  function balance(uid, cid) { return one('SELECT COALESCE(SUM(delta),0) AS b FROM points_ledger WHERE user_id = ? AND community_id = ?', uid, cid).b; }
  function issueView(r, full) {
    return {
      id: r.id, communityId: r.community_id, communityName: r.community_name, title: r.title, description: r.description,
      category: r.category, locationText: r.location_text, latitude: r.latitude, longitude: r.longitude,
      locationSource: r.location_source, hasPhoto: Boolean(r.photo_file), status: r.status, response: r.head_response,
      points: r.points_awarded, createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
      reporterName: r.reporter_name, reporterId: full ? r.reporter_id : undefined, reporterEmail: full ? r.reporter_email : undefined,
    };
  }
  const ISSUE_SELECT = `SELECT issues.*, users.name AS reporter_name, users.email AS reporter_email, communities.name AS community_name
    FROM issues JOIN users ON users.id = issues.reporter_id JOIN communities ON communities.id = issues.community_id`;

  const api = express.Router();
  api.use(auth);
  const writeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many submissions. Try again later.' } });

  // ---------- communities ----------
  api.get('/communities/mine', (req, res) => {
    const rows = q(`SELECT c.*, (c.head_user_id = ?) AS is_head,
      (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS members,
      (SELECT COUNT(*) FROM issues i WHERE i.community_id = c.id AND i.status IN ('open','in_progress')) AS open_issues
      FROM communities c WHERE c.head_user_id = ? OR c.id IN (SELECT community_id FROM community_members WHERE user_id = ?)
      ORDER BY c.created_at DESC`, req.me.id, req.me.id, req.me.id);
    res.json({ communities: rows.map(c => ({ id: c.id, name: c.name, type: c.type, description: c.description, locationText: c.location_text,
      verified: Boolean(c.verified), isHead: Boolean(c.is_head), members: c.members, openIssues: c.open_issues, points: balance(req.me.id, c.id) })) });
  });

  api.post('/communities', requireSameOrigin, writeLimiter, (req, res) => {
    const name = str(req.body?.name, 80), type = str(req.body?.type, 20), description = str(req.body?.description, 400), locationText = str(req.body?.locationText, 160);
    if (name.length < 3) return res.status(400).json({ error: 'Community name must be at least 3 characters.' });
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Choose a valid community type.' });
    if (one('SELECT COUNT(*) AS n FROM communities WHERE head_user_id = ?', req.me.id).n >= 10) return res.status(400).json({ error: 'You can lead at most 10 communities.' });
    const id = randomUUID(), code = randomBytes(4).toString('hex').toUpperCase();
    tx(() => {
      run('INSERT INTO communities(id,name,type,description,location_text,head_user_id,join_code,created_at) VALUES (?,?,?,?,?,?,?,?)', id, name, type, description, locationText, req.me.id, code, Date.now());
      run('INSERT INTO community_members(community_id,user_id,joined_at) VALUES (?,?,?)', id, req.me.id, Date.now());
    });
    res.status(201).json({ id, joinCode: code });
  });

  api.post('/communities/join', requireSameOrigin, writeLimiter, (req, res) => {
    const code = str(req.body?.code, 16).toUpperCase();
    const c = code && one('SELECT * FROM communities WHERE join_code = ?', code);
    if (!c) return res.status(404).json({ error: 'No community found for that code.' });
    run('INSERT OR IGNORE INTO community_members(community_id,user_id,joined_at) VALUES (?,?,?)', c.id, req.me.id, Date.now());
    res.json({ id: c.id, name: c.name });
  });

  api.get('/communities/:id', (req, res) => {
    const c = community(req.params.id);
    if (!c || !canView(req, c)) return res.status(404).json({ error: 'Community not found.' });
    const head = c.head_user_id === req.me.id;
    const head_user = one('SELECT name FROM users WHERE id = ?', c.head_user_id);
    const stats = one(`SELECT COUNT(*) AS total, SUM(status='resolved') AS resolved, SUM(status='in_progress') AS progress, SUM(status='open') AS open FROM issues WHERE community_id = ?`, c.id);
    const rewards = q('SELECT id,title,description,cost,active FROM rewards WHERE community_id = ?' + (head || isAdmin(req) ? '' : ' AND active = 1') + ' ORDER BY cost', c.id);
    const out = { id: c.id, name: c.name, type: c.type, description: c.description, locationText: c.location_text, verified: Boolean(c.verified),
      headName: head_user?.name, isHead: head, isAdmin: isAdmin(req), points: balance(req.me.id, c.id),
      stats: { total: stats.total, resolved: stats.resolved || 0, inProgress: stats.progress || 0, open: stats.open || 0 },
      rewards: rewards.map(r => ({ ...r, active: Boolean(r.active) })) };
    if (head) {
      out.joinCode = c.join_code;
      out.members = q('SELECT u.id,u.name,u.email FROM community_members m JOIN users u ON u.id=m.user_id WHERE m.community_id = ? ORDER BY m.joined_at', c.id);
      out.redemptions = q(`SELECT r.id,r.title,r.cost,r.status,r.created_at,u.name AS user_name FROM redemptions r JOIN users u ON u.id=r.user_id WHERE r.community_id = ? ORDER BY r.created_at DESC LIMIT 100`, c.id);
      out.leaderboard = q(`SELECT u.name, SUM(l.delta) AS points FROM points_ledger l JOIN users u ON u.id=l.user_id WHERE l.community_id = ? GROUP BY l.user_id ORDER BY points DESC LIMIT 10`, c.id);
    }
    res.json(out);
  });

  api.patch('/communities/:id', requireSameOrigin, (req, res) => {
    const c = community(req.params.id);
    if (!c || c.head_user_id !== req.me.id) return res.status(404).json({ error: 'Community not found.' });
    const name = str(req.body?.name, 80) || c.name, description = req.body?.description === undefined ? c.description : str(req.body.description, 400);
    if (name.length < 3) return res.status(400).json({ error: 'Community name must be at least 3 characters.' });
    run('UPDATE communities SET name = ?, description = ? WHERE id = ?', name, description, c.id);
    res.json({ ok: true });
  });

  // ---------- issues ----------
  api.get('/communities/:id/issues', (req, res) => {
    const c = community(req.params.id);
    if (!c || !canView(req, c)) return res.status(404).json({ error: 'Community not found.' });
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    const rows = q(`${ISSUE_SELECT} WHERE issues.community_id = ?${status ? ' AND issues.status = ?' : ''} ORDER BY issues.created_at DESC LIMIT 200`, ...(status ? [c.id, status] : [c.id]));
    const full = c.head_user_id === req.me.id || isAdmin(req);
    res.json({ issues: rows.map(r => issueView(r, full)) });
  });

  api.post('/communities/:id/issues', requireSameOrigin, writeLimiter, (req, res) => {
    const c = community(req.params.id);
    if (!c || !isMember(c.id, req.me.id)) return res.status(404).json({ error: 'Community not found.' });
    const b = req.body || {};
    const title = str(b.title, 100), description = str(b.description, 1000), category = str(b.category, 20), locationText = str(b.locationText, 200);
    if (title.length < 3) return res.status(400).json({ error: 'Add a short title (at least 3 characters).' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Choose a valid category.' });
    let latitude = null, longitude = null, source = 'typed';
    if (b.latitude != null || b.longitude != null) {
      if (!Number.isFinite(b.latitude) || !Number.isFinite(b.longitude) || Math.abs(b.latitude) > 90 || Math.abs(b.longitude) > 180) return res.status(400).json({ error: 'Invalid GPS coordinates.' });
      latitude = b.latitude; longitude = b.longitude; source = 'gps';
    }
    if (!latitude && !locationText) return res.status(400).json({ error: 'Type the location or use live location.' });
    let photoFile = null;
    if (b.photo != null && b.photo !== '') {
      const m = typeof b.photo === 'string' && /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(b.photo);
      const buf = m && Buffer.from(m[1], 'base64');
      if (!buf || buf.length > MAX_PHOTO_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return res.status(400).json({ error: 'Photo must be a JPEG under 900 KB.' });
      photoFile = `${randomUUID()}.jpg`;
      writeFileSync(join(uploadDir, photoFile), buf);
    }
    const id = randomUUID(), now = Date.now();
    run(`INSERT INTO issues(id,community_id,reporter_id,title,description,category,location_text,latitude,longitude,location_source,photo_file,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, c.id, req.me.id, title, description, category, locationText, latitude, longitude, source, photoFile, now, now);
    res.status(201).json({ id });
  });

  api.get('/issues/:id/photo', (req, res) => {
    const i = one('SELECT * FROM issues WHERE id = ?', req.params.id);
    const c = i && community(i.community_id);
    if (!i || !i.photo_file || !canView(req, c)) return res.status(404).end();
    const file = join(uploadDir, i.photo_file);
    if (!existsSync(file)) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=3600').send(readFileSync(file));
  });

  api.patch('/issues/:id', requireSameOrigin, (req, res) => {
    const i = one('SELECT * FROM issues WHERE id = ?', req.params.id);
    const c = i && community(i.community_id);
    if (!i || !(isAdmin(req) || c.head_user_id === req.me.id)) return res.status(404).json({ error: 'Issue not found.' });
    const status = str(req.body?.status, 20) || i.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const response = req.body?.response === undefined ? i.head_response : str(req.body.response, 500);
    const wantPoints = req.body?.points === undefined ? 0 : Number(req.body.points);
    if (!Number.isInteger(wantPoints) || wantPoints < 0 || wantPoints > MAX_POINTS) return res.status(400).json({ error: `Points must be a whole number from 0 to ${MAX_POINTS}.` });
    if (status === 'resolved' && !response) return res.status(400).json({ error: 'Add a short note about how the issue was solved.' });
    try { tx(() => {
      const now = Date.now();
      let awarded = i.points_awarded;
      if (status === 'resolved' && wantPoints > 0 && !i.points_awarded) {
        if (i.reporter_id === c.head_user_id) throw Object.assign(new Error('self'), { status: 400, msg: 'Points cannot be awarded for your own report.' });
        awarded = wantPoints;
        run('INSERT INTO points_ledger(id,user_id,community_id,issue_id,delta,reason,created_at) VALUES (?,?,?,?,?,?,?)', randomUUID(), i.reporter_id, c.id, i.id, awarded, `Issue resolved: ${i.title}`.slice(0, 120), now);
      }
      run('UPDATE issues SET status = ?, head_response = ?, points_awarded = ?, updated_at = ?, resolved_at = ? WHERE id = ?', status, response, awarded, now, status === 'resolved' ? (i.resolved_at || now) : null, i.id);
    }); } catch (e) { if (e.msg) return res.status(e.status).json({ error: e.msg }); throw e; }
    res.json({ ok: true });
  });

  // ---------- rewards & wallet ----------
  api.post('/communities/:id/rewards', requireSameOrigin, writeLimiter, (req, res) => {
    const c = community(req.params.id);
    if (!c || c.head_user_id !== req.me.id) return res.status(404).json({ error: 'Community not found.' });
    const title = str(req.body?.title, 80), description = str(req.body?.description, 200), cost = Number(req.body?.cost);
    if (title.length < 2 || !Number.isInteger(cost) || cost < 1 || cost > 100000) return res.status(400).json({ error: 'Give the reward a title and a point cost (1 or more).' });
    if (one('SELECT COUNT(*) AS n FROM rewards WHERE community_id = ?', c.id).n >= 30) return res.status(400).json({ error: 'Reward limit reached (30).' });
    const id = randomUUID();
    run('INSERT INTO rewards(id,community_id,title,description,cost) VALUES (?,?,?,?,?)', id, c.id, title, description, cost);
    res.status(201).json({ id });
  });

  api.patch('/rewards/:id', requireSameOrigin, (req, res) => {
    const r = one('SELECT * FROM rewards WHERE id = ?', req.params.id);
    const c = r && community(r.community_id);
    if (!r || c.head_user_id !== req.me.id) return res.status(404).json({ error: 'Reward not found.' });
    const b = req.body || {};
    const title = b.title === undefined ? r.title : str(b.title, 80), description = b.description === undefined ? r.description : str(b.description, 200);
    const cost = b.cost === undefined ? r.cost : Number(b.cost), active = b.active === undefined ? r.active : Number(Boolean(b.active));
    if (title.length < 2 || !Number.isInteger(cost) || cost < 1 || cost > 100000) return res.status(400).json({ error: 'Invalid reward.' });
    run('UPDATE rewards SET title=?, description=?, cost=?, active=? WHERE id=?', title, description, cost, active, r.id);
    res.json({ ok: true });
  });

  api.delete('/rewards/:id', requireSameOrigin, (req, res) => {
    const r = one('SELECT * FROM rewards WHERE id = ?', req.params.id);
    const c = r && community(r.community_id);
    if (!r || c.head_user_id !== req.me.id) return res.status(404).json({ error: 'Reward not found.' });
    if (one('SELECT 1 FROM redemptions WHERE reward_id = ?', r.id)) run('UPDATE rewards SET active = 0 WHERE id = ?', r.id);
    else run('DELETE FROM rewards WHERE id = ?', r.id);
    res.json({ ok: true });
  });

  api.post('/rewards/:id/redeem', requireSameOrigin, writeLimiter, (req, res) => {
    const r = one('SELECT * FROM rewards WHERE id = ? AND active = 1', req.params.id);
    if (!r || !isMember(r.community_id, req.me.id)) return res.status(404).json({ error: 'Reward not found.' });
    try {
      tx(() => {
        if (balance(req.me.id, r.community_id) < r.cost) throw Object.assign(new Error('funds'), { status: 400, msg: 'Not enough points yet.' });
        const now = Date.now();
        run('INSERT INTO points_ledger(id,user_id,community_id,delta,reason,created_at) VALUES (?,?,?,?,?,?)', randomUUID(), req.me.id, r.community_id, -r.cost, `Redeemed: ${r.title}`, now);
        run('INSERT INTO redemptions(id,reward_id,community_id,user_id,title,cost,created_at) VALUES (?,?,?,?,?,?,?)', randomUUID(), r.id, r.community_id, req.me.id, r.title, r.cost, now);
      });
    } catch (e) { if (e.msg) return res.status(e.status).json({ error: e.msg }); throw e; }
    res.json({ ok: true });
  });

  api.patch('/redemptions/:id', requireSameOrigin, (req, res) => {
    const r = one('SELECT * FROM redemptions WHERE id = ?', req.params.id);
    const c = r && community(r.community_id);
    if (!r || c.head_user_id !== req.me.id) return res.status(404).json({ error: 'Not found.' });
    run("UPDATE redemptions SET status = 'fulfilled' WHERE id = ?", r.id);
    res.json({ ok: true });
  });

  api.get('/wallet', (req, res) => {
    const ledger = q(`SELECT l.delta, l.reason, l.created_at, c.name AS community FROM points_ledger l JOIN communities c ON c.id = l.community_id WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 50`, req.me.id);
    const mine = q('SELECT title, cost, status, created_at FROM redemptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', req.me.id);
    res.json({ total: one('SELECT COALESCE(SUM(delta),0) AS t FROM points_ledger WHERE user_id = ?', req.me.id).t, ledger, redemptions: mine });
  });

  // ---------- admin ----------
  const admin = express.Router();
  admin.use(auth, adminOnly);
  admin.get('/summary', (req, res) => {
    const iss = one(`SELECT COUNT(*) AS total, COALESCE(SUM(status='open'),0) AS open, COALESCE(SUM(status='in_progress'),0) AS progress, COALESCE(SUM(status='resolved'),0) AS resolved, COALESCE(SUM(status='rejected'),0) AS rejected FROM issues`);
    res.json({ users: one("SELECT COUNT(*) AS n FROM users WHERE role != 'admin'").n, communities: one('SELECT COUNT(*) AS n FROM communities').n,
      issues: iss, pointsIssued: one('SELECT COALESCE(SUM(delta),0) AS n FROM points_ledger WHERE delta > 0').n,
      byCategory: q('SELECT category, COUNT(*) AS n FROM issues GROUP BY category ORDER BY n DESC') });
  });
  admin.get('/issues', (req, res) => {
    const where = [], p = [];
    if (STATUSES.includes(req.query.status)) { where.push('issues.status = ?'); p.push(req.query.status); }
    if (typeof req.query.community === 'string' && req.query.community) { where.push('issues.community_id = ?'); p.push(req.query.community); }
    if (typeof req.query.q === 'string' && req.query.q.trim()) { where.push('(issues.title LIKE ? OR issues.location_text LIKE ?)'); const s = `%${req.query.q.trim().slice(0, 60)}%`; p.push(s, s); }
    const rows = q(`${ISSUE_SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY issues.created_at DESC LIMIT 300`, ...p);
    res.json({ issues: rows.map(r => issueView(r, true)) });
  });
  admin.get('/communities', (req, res) => {
    res.json({ communities: q(`SELECT c.id,c.name,c.type,c.verified,c.created_at,u.name AS head_name,u.email AS head_email,
      (SELECT COUNT(*) FROM community_members m WHERE m.community_id=c.id) AS members,
      (SELECT COUNT(*) FROM issues i WHERE i.community_id=c.id) AS issues,
      (SELECT COUNT(*) FROM issues i WHERE i.community_id=c.id AND i.status IN ('open','in_progress')) AS open_issues
      FROM communities c JOIN users u ON u.id=c.head_user_id ORDER BY c.created_at DESC`).map(c => ({ ...c, verified: Boolean(c.verified) })) });
  });
  admin.patch('/communities/:id', requireSameOrigin, (req, res) => {
    if (!community(req.params.id)) return res.status(404).json({ error: 'Not found.' });
    run('UPDATE communities SET verified = ? WHERE id = ?', Number(Boolean(req.body?.verified)), req.params.id);
    res.json({ ok: true });
  });
  admin.get('/users', (req, res) => {
    res.json({ users: q(`SELECT id,name,email,city,state,ward_village AS wardVillage,role,created_at AS createdAt,
      (SELECT COUNT(*) FROM issues i WHERE i.reporter_id=users.id) AS issues FROM users ORDER BY created_at DESC LIMIT 500`) });
  });

  app.use('/api/admin', admin);
  app.use('/api', api);
}
