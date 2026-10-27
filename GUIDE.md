# Result Publisher - multi-institution guide

One website, many institutions. Each institution has its own address, admin login and private data.

| Address | What it is |
|---|---|
| `https://YOURSITE/super` | **Your** platform console (create / suspend / renew institutions) |
| `https://YOURSITE/<name>` | An institution's public results page (share this with students & parents) |
| `https://YOURSITE/<name>/admin` | That institution's admin login (give to their staff only) |
| `https://YOURSITE/` | Landing page - or one institution if you choose a "Main address" |

## 1. Upgrade your live site (Cloudflare Pages)
1. **Add two secrets** in your Pages project -> Settings -> Variables and Secrets (Production):
   `SUPER_USER` (Text, e.g. `owner`) and `SUPER_PASSWORD` (Secret, a strong password only you know).
   Keep `JWT_SECRET`. (`ADMIN_USER` / `ADMIN_PASSWORD` are only used once, during the automatic upgrade.)
2. **GitHub**: replace/add these files, commit, wait for the build:
   `src/worker.js` · `public/index.html` · `public/sw.js` · `public/styles.css` · `public/manifest.webmanifest` · `public/_routes.json` (new) · `schema.sql`
3. **Deployments -> Retry deployment** so the new secrets apply.
4. Open any page once. The database upgrades itself: your current institution becomes institution #1 with all its data, its admin login, and keeps working at your existing link (it is set as the "Main address").
   D1 keeps 30 days of Time Travel history, so you can always roll back from the D1 dashboard.

## 2. Adding a customer
1. Go to `/super`, log in, tap the **+** button.
2. Enter the institution name (the web address is filled in for you), admin username and password (one is generated), plan, "paid until" date, student limit.
3. Tap **Create institution**. A ready-made message appears with their public link, admin link, username and password - tap **Copy / Share** and send it on WhatsApp.
4. Their admin logs in, sets up classes/subjects/students, and **turns the Public Portal ON** (Setup -> Public Portal).

## 3. Running the business
- **Paid until** date passed, or **Suspend** -> their public page and admin page are replaced by a blocking message (no results, no login form). Set a new date / Activate to reopen. **Login as admin** from `/super` still opens their panel for support.
- **Suspend / Activate** any time. **Student limit** blocks adding more students (shows a message to upgrade).
- **Login as admin** opens their admin panel to help them (it works even if suspended).
- **Reset password** gives a new password + a fresh message to send. Old sessions are signed out.
- **Make main address**: the institution shown at `https://YOURSITE/`. Remove it to show the landing page instead (do this once you stop using the root link for your first institution).
- **Delete** needs you to type the address; it permanently erases all that institution's data.
- Admins see an amber reminder inside their panel 14 days before the paid-until date.

## 4. Good to know
- Data is fully separated: every database query is locked to the logged-in institution.
- Addresses: 3-40 letters/numbers/hyphens. Changing an address changes the link, so tell the client.
- Installed phone apps are per institution (each opens its own address).
- Add a Cloudflare rate-limiting rule on `/api/login` and `/api/super/login` for extra protection.
- Payments are manual for now (you note "paid until"). Custom domains per institution and online payments can be added later.
