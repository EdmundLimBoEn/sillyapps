# snippets.sillyapps.co

Static landing page for Snippets. No build step. Text in `[BRACKETS]` is a placeholder for Edmund to write.

Preview: `python3 -m http.server 8790 --directory snippets`

`styles.css`, `theme.js`, `favicon.svg` are copies from `site/`. Keep them in sync.

Deploy (Jeremy, with Edmund's OK): separate Pages project, e.g. `npx wrangler pages deploy snippets --project-name snippets-sillyapps`, then attach custom domain `snippets.sillyapps.co` in that project (Cloudflare adds the proxied CNAME in the sillyapps.co zone).
