# sillyapps.co

Landing page for [sillyapps.co](https://sillyapps.co). Edmund Lim's list of small free apps. One page, cards that link out. Not a store and not a blog.

The site files live in `site/`. There is no build step.

## Preview locally

From the repo root:

```sh
python3 -m http.server 8787 --directory site
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Python's server does not serve `site/404.html`. Cloudflare Pages and `wrangler pages dev` do.

If Wrangler is already on your PATH:

```sh
npx wrangler pages dev site
```

That serves on [http://127.0.0.1:8788](http://127.0.0.1:8788) by default.

## Add an app card

Copy an `<article class="app-card">` in `site/index.html`. Keep the same fields:

- `data-app` as a stable id
- `data-tone` as `calm` or `utility` (top border color)
- kicker, name, blurb, notes
- a primary Get it button, then live outbound links

If TestFlight or the App Store URL is not public yet, leave the primary button `href` as `#`. `site/apps.js` treats `#` as a placeholder and blocks the click. Paste a real URL into `href` when you have it, and delete the `<span class="soon">` label.

Bump the `app-index` number (`01`, `02`, then `03`). Add a matching `SoftwareApplication` block in the JSON-LD script if the app should show up in search rich results.

## Deploy on Cloudflare Pages

Jeremy owns production deploy for `sillyapps.co`. DNS is out of scope for this repo. The notes below are the Pages and Wrangler steps only.

### Git-connected project

In the Cloudflare dashboard, create a Pages project from `EdmundLimBoEn/sillyapps`.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | leave empty |
| Build output directory | `site` |
| Root directory | `/` |

Each push to `main` publishes production. Other branches get preview URLs.

### Wrangler direct upload

After `wrangler login`:

```sh
npx wrangler pages deploy
```

`wrangler.jsonc` already points at `./site` and the project name `sillyapps`. If the Pages project does not exist yet, create it in the dashboard first, or run `npx wrangler pages project create sillyapps`. To set the name and branch explicitly:

```sh
npx wrangler pages deploy site --project-name sillyapps --branch main
```

### Custom domain `sillyapps.co`

This is an apex domain. The zone must sit on the same Cloudflare account as the Pages project.

1. Open the Pages project → Custom domains → Set up a domain.
2. Enter `sillyapps.co` and continue.
3. If the zone already points at Cloudflare nameservers, Pages adds the CNAME for you.
4. Wait until the domain status is Active. Then `https://sillyapps.co` should serve this `site/` output.

Do not add a CNAME to `*.pages.dev` by hand without attaching the domain in the Pages project first. That path returns a 522.

Preview hostnames stay on `*.pages.dev`. Keep production on `main`.

## Links still to paste

- Lazy Man's Reminders TestFlight public join URL, on the first card's primary button in `site/index.html`. The web board is already linked at [lmr.edmundlim.systems](https://lmr.edmundlim.systems).
- UsageWidget App Store URL, on the second card's primary button. Source and install notes are already linked.
