# Madrasa RMS: Go-Live Guide (Cloudflare Workers + D1)

One Cloudflare Worker serves the website (`public/`) and the API (`/api/*`), with a D1 (SQLite) database. The free plan is enough for a madrasa.

## Project layout
| File | Purpose |
|---|---|
| `public/index.html` | The app (mobile-first, installable PWA) |
| `public/styles.css` | Compiled Tailwind (rebuild with `npm run css`) |
| `public/manifest.webmanifest`, `public/sw.js`, `public/icons/` | PWA: manifest, offline cache, app icons |
| `src/worker.js` | Backend API |
| `schema.sql` | Database tables |
| `wrangler.toml` | Cloudflare config |

## 1. Prerequisites
1. Free account at https://dash.cloudflare.com/sign-up
2. Node.js 18+ (https://nodejs.org)
3. In the project folder: `npm install`
4. `npx wrangler login` (opens the browser to authorise)

## 2. Create the database
```bash
npx wrangler d1 create madrasa-rms
```
Copy the printed `database_id` into `wrangler.toml` (replace `PASTE_YOUR_DATABASE_ID_HERE`). Then create the tables on the live database:
```bash
npx wrangler d1 execute madrasa-rms --remote --file=schema.sql
```

## 3. Set the admin password and signing key (secrets)
```bash
npx wrangler secret put ADMIN_PASSWORD   # type a strong password
npx wrangler secret put JWT_SECRET       # type 40+ random characters
```
Change the username in `wrangler.toml` (`ADMIN_USER`) if you want something other than `admin`.
Secrets are never stored in your files or in the browser code. Generate a random key with `openssl rand -hex 32`.

## 4. Deploy
```bash
npm run deploy
```
You get a URL like `https://madrasa-rms.<your-subdomain>.workers.dev`. Open it, then click **Admin Portal** and sign in.

## 5. First-time setup inside the app
Admin → **Exams, Classes & Subjects**: add classes, subjects and exams → **Students**: add or CSV-import students → **Marks**: enter results. Tick *Publish* on an exam so students can see it.

## 6. Custom domain (optional)
Cloudflare dashboard → Workers & Pages → `madrasa-rms` → Settings → Domains & Routes → Add → Custom domain (the domain must be on Cloudflare DNS). HTTPS is automatic.

## 7. Install as an app (PWA)
- Android/Chrome: menu → *Install app* / *Add to Home screen*
- iPhone/Safari: Share → *Add to Home Screen*

## Updating later
Edit files → `npm run deploy`. If you change `public/sw.js` caching, bump `CACHE = 'madrasa-rms-v2'`. If you add new Tailwind classes to `index.html`, `npm run deploy` rebuilds the CSS automatically.

## Local testing
Create `.dev.vars`:
```
ADMIN_PASSWORD=test1234
JWT_SECRET=any-long-random-text
```
Then `npx wrangler d1 execute madrasa-rms --local --file=schema.sql` and `npm run dev` (http://localhost:8787).

## Backups
```bash
npx wrangler d1 export madrasa-rms --remote --output=backup.sql
```
Run this before each exam season. D1 also has Time Travel (30-day point-in-time restore) on the dashboard.

## Security notes
- Students can only fetch **one result at a time** (exam + admission no.). The full student list is never sent to the public.
- All admin routes need a signed token (12 h). Login is slowed after a wrong password. Add a Cloudflare rate-limiting rule on `/api/login` (Security → WAF → Rate limiting) for extra protection.
- Because results are looked up by admission number only, anyone who guesses a number can see that result. If that's a concern, add a second factor (e.g. date of birth or a PIN) later.
- Keep `ADMIN_PASSWORD` private; to rotate it, run `wrangler secret put ADMIN_PASSWORD` again (changing `JWT_SECRET` logs everyone out).

## Troubleshooting
| Problem | Fix |
|---|---|
| `Invalid username or password` | Secrets not set on the deployed Worker; redo step 3, then `npm run deploy` |
| `D1_ERROR: no such table` | Run the `--remote` schema command in step 2 |
| 500 / binding error | `database_id` in `wrangler.toml` is wrong or still the placeholder |
| Old design still shows | Hard-refresh, or bump the `CACHE` version in `sw.js` |
