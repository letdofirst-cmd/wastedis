import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createDatabase } from './database.mjs';
import { registerCommunityRoutes } from './community.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(ROOT, 'data', 'ecopulse.sqlite');
const UPLOAD_DIR = join(ROOT, 'data', 'uploads');
const SESSION_COOKIE = 'ecopulse_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const LOCATION_CHECK_TTL_MS = 10 * 60 * 1000;
const scryptAsync = promisify(scrypt);
const DUMMY_SALT = Buffer.alloc(16, 37);
const DUMMY_HASH = scryptSync('not-a-real-ecopulse-password', DUMMY_SALT, 64).toString('hex');
const NOMINATIM_CONTACT = process.env.NOMINATIM_CONTACT || '';
const NOMINATIM_USER_AGENT = `EcoPulse/1.0${NOMINATIM_CONTACT ? ` (${NOMINATIM_CONTACT})` : ''}`;
let nominatimQueue = Promise.resolve();
let nextNominatimRequestAt = 0;
const PUBLIC_PAGES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/features.html', 'features.html'],
  ['/how-it-works.html', 'how-it-works.html'],
  ['/about.html', 'about.html'],
  ['/contact.html', 'contact.html'],
  ['/login.html', 'login.html'],
]);

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt, hash: derived.toString('hex') };
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function readCookie(req, name) {
  const prefix = `${name}=`;
  for (const part of (req.headers.cookie || '').split(';')) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length);
  }
  return '';
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role || 'citizen',
    area: row.area || row.ward_village || row.wardVillage || '',
    state: row.state || '',
    city: row.city || '',
    wardVillage: row.ward_village || row.wardVillage || '',
    locationVerified: Boolean(row.location_verified ?? row.locationVerified ?? false),
    localityVerified: Boolean(row.locality_verified ?? row.localityVerified ?? false),
    locationVerifiedAt: row.location_verified_at ?? row.locationVerifiedAt ?? null,
  };
}

function normalizePlace(value) {
  return String(value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/^(?:ward|village)\s+/u, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function matchesPlace(input, candidates) {
  const expected = normalizePlace(input);
  return candidates.some(candidate => {
    const actual = normalizePlace(candidate);
    return actual && actual === expected;
  });
}

function isLocalDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function nominatimReverseGeocode(latitude, longitude) {
  const run = async () => {
    const delay = Math.max(0, nextNominatimRequestAt - Date.now());
    if (delay) await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
    nextNominatimRequestAt = Date.now() + 1100;
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({ format: 'jsonv2', lat: String(latitude), lon: String(longitude), zoom: '18', addressdetails: '1' });
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': NOMINATIM_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Nominatim returned ${response.status}`);
    return response.json();
  };
  const result = nominatimQueue.then(run);
  nominatimQueue = result.catch(() => {});
  return result;
}

export async function createApp({ databasePath = DB_PATH, databaseUrl = process.env.DATABASE_URL, production = process.env.NODE_ENV === 'production', reverseGeocode = nominatimReverseGeocode, adminEmail, adminPassword } = {}) {
  if (!databaseUrl && databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = createDatabase({ databasePath, connectionString: databaseUrl });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      area TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      ward_village TEXT NOT NULL DEFAULT '',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      location_verified INTEGER NOT NULL DEFAULT 0,
      locality_verified INTEGER NOT NULL DEFAULT 0,
      location_verified_at INTEGER,
      role TEXT NOT NULL DEFAULT 'citizen'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS location_verifications (
      token_hash TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      city TEXT NOT NULL,
      ward_village TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      locality_verified INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS geocode_cache (
      cache_key TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const userColumns = db.dialect === 'sqlite'
    ? new Set((await db.all('PRAGMA table_info(users)')).map(column => column.name))
    : null;
  for (const [column, definition] of [
    ['state', "TEXT NOT NULL DEFAULT ''"],
    ['city', "TEXT NOT NULL DEFAULT ''"],
    ['ward_village', "TEXT NOT NULL DEFAULT ''"],
    ['location_verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['locality_verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['location_verified_at', 'INTEGER'],
    ['role', "TEXT NOT NULL DEFAULT 'citizen'"],
  ]) {
    if (db.dialect === 'postgres') await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    else if (!userColumns.has(column)) await db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  }

  // Admin account: created from ADMIN_EMAIL / ADMIN_PASSWORD (or options). It signs in through the normal login form;
  // the server decides the role, so nothing on the public site reveals an admin login.
  const seedEmail = String(adminEmail ?? process.env.ADMIN_EMAIL ?? (databasePath === ':memory:' || databaseUrl || production ? '' : 'hallosaini3@gmail.com')).trim().toLowerCase();
  const seedPassword = String(adminPassword ?? process.env.ADMIN_PASSWORD ?? (databasePath === ':memory:' || databaseUrl || production ? '' : 'teambreak'));
  if (seedEmail && seedPassword) {
    const existing = await db.get('SELECT id FROM users WHERE email = ?', seedEmail);
    const explicit = adminPassword !== undefined || process.env.ADMIN_PASSWORD;
    if (!existing || explicit) {
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(seedPassword, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
      if (existing) await db.run("UPDATE users SET role = 'admin', password_salt = ?, password_hash = ? WHERE id = ?", salt, hash, existing.id);
      else await db.run(`INSERT INTO users(id, name, email, area, password_salt, password_hash, created_at, role) VALUES (?, ?, ?, 'Admin', ?, ?, ?, 'admin')`,
        randomUUID(), 'EcoPulse Admin', seedEmail, salt, hash, Date.now());
    } else await db.run("UPDATE users SET role = 'admin' WHERE id = ?", existing.id);
  }

  const app = express();
  app.disable('x-powered-by');
  if (production) app.set('trust proxy', 1);
  app.locals.db = db;
  app.locals.close = () => db.close();

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
    const localDevelopmentOrigin = !production && origin && isLocalDevelopmentOrigin(origin);
    if (origin && !sameOrigin && !localDevelopmentOrigin) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    if (localDevelopmentOrigin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const smallJson = express.json({ limit: '16kb', strict: true });
  const bigJson = express.json({ limit: '1.5mb', strict: true });
  app.use('/api', (req, res, next) => {
    const parser = req.method === 'POST' && /^\/communities\/[\w-]+\/issues$/.test(req.path) ? bigJson : smallJson;
    parser(req, res, next);
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many attempts. Please try again later.' },
  });

  async function currentUser(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = Date.now();
    await db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
    return await db.get(`
      SELECT users.id, users.name, users.email, users.role, users.area, users.state, users.city,
        users.ward_village, users.location_verified, users.locality_verified, users.location_verified_at
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hashToken(token), now) || null;
  }

  function setSessionCookie(res, token) {
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      `Max-Age=${SESSION_TTL_SECONDS}`,
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (production) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  async function createSession(userId, res) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    await db.run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)', hashToken(token), userId, expiresAt);
    setSessionCookie(res, token);
  }

  function requireSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}` && (production || !isLocalDevelopmentOrigin(origin))) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    next();
  }

  app.get('/api/auth/me', async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in.' });
    res.json({ user: publicUser(user) });
  });

  const locationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 6,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many GPS checks. Please wait before trying again.' },
  });

  app.post('/api/location/verify', locationLimiter, requireSameOrigin, async (req, res) => {
    const { state, city, wardVillage, latitude, longitude } = req.body || {};
    const submittedState = typeof state === 'string' ? state.trim() : '';
    const submittedCity = typeof city === 'string' ? city.trim() : '';
    const submittedWardVillage = typeof wardVillage === 'string' ? wardVillage.trim() : '';
    const isSuggestionRequest = !submittedState && !submittedCity && !submittedWardVillage;
    if (submittedState.length > 100 || submittedCity.length > 100 || submittedWardVillage.length > 120 ||
      (!isSuggestionRequest && (!submittedState || !submittedCity))) {
      return res.status(400).json({ error: 'Enter your state and city before verifying.' });
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Allow GPS access so we can check your location.' });
    }

    const cacheKey = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    let result;
    const cached = await db.get('SELECT response_json FROM geocode_cache WHERE cache_key = ? AND expires_at > ?', cacheKey, Date.now());
    try {
      if (cached) result = JSON.parse(cached.response_json);
      else {
        result = await reverseGeocode(latitude, longitude);
        await db.run(`INSERT INTO geocode_cache(cache_key, response_json, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET response_json = excluded.response_json, expires_at = excluded.expires_at`,
        cacheKey, JSON.stringify(result), Date.now() + 30 * 24 * 60 * 60 * 1000);
      }
    } catch (error) {
      return res.status(503).json({ error: 'GPS address lookup is unavailable right now. Please try again shortly.' });
    }

    const address = result?.address || {};
    const cityCandidates = [address.city, address.town, address.municipality, address.village, address.county, address.state_district].filter(Boolean);
    const localityCandidates = [address.ward, address.village, address.hamlet, address.suburb, address.neighbourhood, address.quarter, address.city_district].filter(Boolean);
    if (isSuggestionRequest) {
      const suggestions = {
        state: address.state || '',
        city: cityCandidates[0] || '',
        wardVillage: address.ward ? `Ward ${address.ward}` : [address.village, address.hamlet, address.suburb, address.neighbourhood, address.quarter, address.city_district].find(Boolean) || '',
      };
      if (!suggestions.state || !suggestions.city) {
        return res.status(422).json({ error: 'GPS found this location, but map data is missing a state or city.' });
      }
      const localityAvailable = Boolean(suggestions.wardVillage);
      return res.json({
        suggestions,
        localityAvailable,
        message: localityAvailable
          ? 'GPS filled the location fields. Review them, then verify once more to confirm.'
          : 'GPS filled your State and City. Map data has no ward or local area here; enter your ward or village manually, then verify State and City again.',
        attribution: 'Location lookup by OpenStreetMap contributors.',
      });
    }
    if (!matchesPlace(submittedState, [address.state].filter(Boolean))) {
      return res.status(422).json({ error: 'The GPS location does not match the state entered. Check the state and try again.' });
    }
    if (!matchesPlace(submittedCity, cityCandidates)) {
      return res.status(422).json({ error: 'The GPS location does not match the city entered. Check the city and try again.' });
    }

    const localityVerified = localityCandidates.length > 0 && matchesPlace(submittedWardVillage, localityCandidates);
    if (!localityCandidates.length && !submittedWardVillage) {
      return res.status(400).json({ error: 'Map data has no ward or local area here. Enter your ward or village manually to continue.' });
    }
    if (localityCandidates.length > 0 && !localityVerified) {
      return res.status(422).json({ error: 'The GPS location does not match the ward, village, or locality entered. Check it and try again.' });
    }

    const verificationId = randomBytes(32).toString('base64url');
    await db.run(`INSERT INTO location_verifications(token_hash, state, city, ward_village, latitude, longitude, locality_verified, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      ;
    res.json({
      verificationId,
      state: address.state,
      city: cityCandidates[0],
      localityVerified,
      message: localityVerified
        ? 'GPS matched your state, city, and mapped locality.'
        : 'GPS verified your state and city. The ward or village was not in map data and will be saved as entered, unverified.',
      attribution: 'Location lookup by OpenStreetMap contributors.',
    });
  });

  app.post('/api/auth/register', authLimiter, requireSameOrigin, async (req, res) => {
    const { name, email, password, state, city, wardVillage, verificationId } = req.body || {};
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedState = typeof state === 'string' ? state.trim() : '';
    const normalizedCity = typeof city === 'string' ? city.trim() : '';
    const normalizedWardVillage = typeof wardVillage === 'string' ? wardVillage.trim() : '';
    if (normalizedName.length < 1 || normalizedName.length > 80) {
      return res.status(400).json({ error: 'Name must be between 1 and 80 characters.' });
    }
    if (typeof email !== 'string' || normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be between 12 and 128 characters.' });
    }
    if (!normalizedState || normalizedState.length > 100 || !normalizedCity || normalizedCity.length > 100 || !normalizedWardVillage || normalizedWardVillage.length > 120) {
      return res.status(400).json({ error: 'Enter your state, city, and ward or village.' });
    }
    if (typeof verificationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(verificationId)) {
      return res.status(400).json({ error: 'Verify your location with GPS before creating an account.' });
    }
    db.prepare('DELETE FROM location_verifications WHERE expires_at <= ?').run(Date.now());
    const verification = db.prepare(`SELECT * FROM location_verifications WHERE token_hash = ? AND expires_at > ?`)
      .get(hashToken(verificationId), Date.now());
    if (!verification || verification.state !== normalizePlace(normalizedState) || verification.city !== normalizePlace(normalizedCity) || verification.ward_village !== normalizePlace(normalizedWardVillage)) {
      return res.status(409).json({ error: 'Your location check expired or the address changed. Verify GPS again.' });
    }

    const { salt, hash } = await hashPassword(password);
    const user = {
      id: randomUUID(),
      name: normalizedName,
      email: normalizedEmail,
      area: normalizedWardVillage,
      state: normalizedState,
      city: normalizedCity,
      wardVillage: normalizedWardVillage,
      locationVerified: true,
      localityVerified: Boolean(verification.locality_verified),
      locationVerifiedAt: Date.now(),
    };
    try {
      db.prepare(`INSERT INTO users(id, name, email, area, password_salt, password_hash, created_at, state, city,
        ward_village, location_verified, locality_verified, location_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(user.id, user.name, user.email, user.area, salt, hash, Date.now(), user.state, user.city,
          user.wardVillage, 1, Number(user.localityVerified), user.locationVerifiedAt);
    } catch (error) {
      if (error.errcode === 2067 || String(error.message).includes('UNIQUE constraint failed: users.email')) {
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }
      throw error;
    }
    db.prepare('DELETE FROM location_verifications WHERE token_hash = ?').run(hashToken(verificationId));
    createSession(user.id, res);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', authLimiter, requireSameOrigin, async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || password.length > 128) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const user = db.prepare('SELECT id, name, email, role, area, password_salt, password_hash FROM users WHERE email = ?')
      .get(normalizedEmail);
    const salt = user?.password_salt || DUMMY_SALT.toString('hex');
    const candidate = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const expected = Buffer.from(user?.password_hash || DUMMY_HASH, 'hex');
    const passwordMatches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (!user || !passwordMatches) return res.status(401).json({ error: 'Invalid email or password.' });

    createSession(user.id, res);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', requireSameOrigin, (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    }
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
    if (production) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
    res.status(204).end();
  });

  app.use('/app', (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
    req.user = publicUser(user);
    if (user.role === 'admin' && req.path === '/dashboard.html') return res.redirect(302, '/admin');
    next();
  });
  app.get('/app/dashboard.html', (req, res) => res.redirect(302, '/app/community.html'));
  app.use('/app', express.static(join(ROOT, 'app'), { dotfiles: 'deny', index: false }));
  app.use('/assets', express.static(join(ROOT, 'assets'), { dotfiles: 'deny', fallthrough: false }));

  function requirePageAuth(req, res, next) {
    if (!currentUser(req)) return res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
    next();
  }

  for (const [route, file] of PUBLIC_PAGES) {
    app.get(route, ...(route === '/login.html' ? [] : [requirePageAuth]), (req, res) => res.sendFile(join(ROOT, file)));
  }

  registerCommunityRoutes({ app, db, currentUser, requireSameOrigin, uploadDir: process.env.UPLOAD_DIR || UPLOAD_DIR });
  // Hidden admin console: anyone who is not a signed-in admin just gets a plain 404.
  app.get('/admin', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
    if (user.role !== 'admin') return res.status(404).type('text').send('Not found');
    res.set('Cache-Control', 'no-store').sendFile(join(ROOT, 'admin', 'index.html'));
  });

  app.use((req, res) => res.status(404).type('text').send('Not found'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (req.path.startsWith('/api/')) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Internal server error.' : 'Invalid request.' });
    }
    res.status(500).type('text').send('Internal server error.');
  });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 8000);
  const app = createApp();
  app.listen(port, '0.0.0.0', () => console.log(`EcoPulse server listening on http://localhost:${port}`));
}
