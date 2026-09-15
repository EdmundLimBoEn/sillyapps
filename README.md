# sillyapps.co

Landing page for [sillyapps.co](https://sillyapps.co). Edmund Lim's list of small free apps. One page and a waitlist. Not a store and not a blog.

The static files live in `site/`. The waitlist API lives in `functions/`. There is no build step.

## Preview locally

Static page only, from the repo root:

```sh
python3 -m http.server 8787 --directory site
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). That server does not run Pages Functions, so the form cannot save signups.

To exercise the waitlist API, copy `.dev.vars.example` to `.dev.vars`, then:

```sh
npx wrangler d1 migrations apply sillyapps-waitlist --local
npx wrangler pages dev
```

That serves on [http://127.0.0.1:8788](http://127.0.0.1:8788) by default. Local D1 uses the placeholder `database_id` in `wrangler.jsonc`. That is enough for `wrangler pages dev`.

Checks:

```sh
node scripts/check-site.mjs
node scripts/test-waitlist.mjs
```

## How the waitlist works

The form on the home page POSTs JSON to `/api/waitlist` (`functions/api/waitlist.js`).

The function:

1. Reads JSON (or a regular form body).
2. Rejects a missing or malformed email.
3. Treats a filled hidden `company` field as spam and returns success without writing a row.
4. Inserts into the D1 `waitlist` table. The email is the primary key, so a repeat signup is a no-op.

Name is optional. Duplicate emails stay one row. The page tells people their address is only used for a launch note.

Edmund exports later with a GET. Launch mail itself is out of scope.

### Export signups

After Jeremy sets `WAITLIST_ADMIN_TOKEN`:

```sh
curl -fsS -H "Authorization: Bearer $WAITLIST_ADMIN_TOKEN" \
  https://sillyapps.co/api/waitlist > waitlist.csv
```

JSON instead of CSV:

```sh
curl -fsS -H "Authorization: Bearer $WAITLIST_ADMIN_TOKEN" \
  "https://sillyapps.co/api/waitlist?format=json"
```

If the secret is unset, that route returns 404 on purpose.

## Add an app card

Copy an `<article class="app-card">` in `site/index.html`. Keep the same fields:

- `data-app` as a stable id
- `data-tone` as `calm` or `utility` (top border color)
- kicker, name, blurb, notes
- a primary waitlist button that points at `#waitlist`

Do not add TestFlight, App Store, or other store download links. Edmund will mail waitlistees when a real link exists.

Bump the `app-index` number (`01`, `02`, then `03`). Add a matching `SoftwareApplication` block in the JSON-LD script if the app should show up in search rich results.

## Deploy on Cloudflare Pages

Jeremy owns production deploy for project `sillyapps` and domain `sillyapps.co`. DNS is out of scope. Previous deploys were a direct upload of `site/` only. This revision adds Pages Functions, so deploy from the repo root. A `site/`-only upload will not include `/api/waitlist`.

### 1. Create the D1 database

```sh
npx wrangler login
npx wrangler d1 create sillyapps-waitlist
```

Copy the printed `database_id` UUID into `wrangler.jsonc` in place of `00000000-0000-0000-0000-000000000000`. Keep the binding name `DB` and the database name `sillyapps-waitlist`.

### 2. Apply the schema on the remote database

```sh
npx wrangler d1 migrations apply sillyapps-waitlist --remote
```

That creates table `waitlist` (`email`, `name`, `created_at`).

### 3. Bind D1 to the Pages project

`npx wrangler pages deploy` from this repo reads `wrangler.jsonc` and should attach `DB`. If the dashboard still shows no D1 binding after a deploy:

1. Open Workers & Pages → project `sillyapps` → Settings → Bindings.
2. Add a D1 binding.
3. Variable name `DB`.
4. Database `sillyapps-waitlist`.
5. Redeploy.

Use the same binding in Production. Add it on Preview too if preview URLs should accept signups.

### 4. Set the export secret

Pick a long random token. Do not commit it.

```sh
echo "your-long-random-token" | npx wrangler pages secret put WAITLIST_ADMIN_TOKEN --project-name sillyapps
```

No other secrets are required. Turnstile is not wired, so there is no Turnstile site key to create. The form uses a honeypot instead.

### 5. Deploy

From the repo root, with `main` checked out:

```sh
npx wrangler pages deploy
```

`wrangler.jsonc` already sets project name `sillyapps` and output dir `./site`. To be explicit:

```sh
npx wrangler pages deploy --project-name sillyapps --branch main
```

Do not run `npx wrangler pages deploy site`. That uploads the asset folder without the root `functions/` directory.

### Git-connected project

If the Pages project is connected to `EdmundLimBoEn/sillyapps`, use:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | leave empty |
| Build output directory | `site` |
| Root directory | `/` |

Functions still come from `/functions` at the repo root, not from `site/`. Each push to `main` publishes production. Bindings in `wrangler.jsonc` apply on that deploy. Still run the D1 create and migration commands once. Still set `WAITLIST_ADMIN_TOKEN`.

### Custom domain `sillyapps.co`

The apex domain should already be attached to project `sillyapps`. After a successful deploy, `https://sillyapps.co` serves `site/` and `https://sillyapps.co/api/waitlist` serves the function. Preview hostnames stay on `*.pages.dev`. Keep production on `main`.

### Confirm production

1. Open `https://sillyapps.co` and submit the form with a real email you control.
2. Confirm the success message.
3. Export with the curl command above and check that the email is in the CSV.

If submit returns "Could not join right now", the D1 binding or the remote migration is missing. Check Bindings, then rerun `npx wrangler d1 migrations apply sillyapps-waitlist --remote`, then redeploy.
