# Operations Runbook

Short procedures for common ops tasks on the MatchedCare billing server.
Keep this file lean — only stuff that's tribal knowledge or non-obvious
goes here.

## Rotating CRON_SECRET

The internal billing cron runs in-process via `setInterval` and calls
`runBillingCheck()` directly — it does NOT go through HTTP, so rotating
the secret cannot break the cron itself. The only thing CRON_SECRET
gates is the HTTP escape hatch (`POST /start-billing`, `GET /check-billing`)
used for manual triggers and out-of-band scripts.

Rotation is a 1-line env var change:

1. Generate a new secret: `openssl rand -hex 32`
2. Railway → matchedcare-billing → Variables → edit `CRON_SECRET` to the new value
3. Save. Railway redeploys (~60s). Old secret stops working the moment the new build is live.
4. Update any external callers (scripts, your own scratch terminal, etc.) to use the new value.

Verify the rotation:

```bash
# Old secret should return 401
curl -i -H "x-cron-token: <OLD>" https://matchedcare-billing-production.up.railway.app/check-billing

# New secret should return 200 with JSON
curl -i -H "x-cron-token: <NEW>" https://matchedcare-billing-production.up.railway.app/check-billing
```

There is no overlap window. If you have external callers that need
zero-downtime rotation, do the rollout in two passes: first add a
`CRON_SECRET_NEXT` variable, deploy a temporary middleware change that
accepts either secret, swap external callers to the new value, then
remove the old one. For the current setup (no external callers), the
single-step rotation above is fine.

## Bad deploy on Railway

Railway auto-deploys on push to `main`. To revert:

1. Identify the last-known-good commit on `main`.
2. `git revert <bad-sha>` and push — Railway redeploys the inverse.
3. If multiple bad commits need rolling back together, `git revert --no-commit <range>` then commit and push.

Do NOT force-push to roll back — Railway sometimes caches old builds and you can end up serving a stale image.

## Stripe webhook secret rotation

If `STRIPE_WEBHOOK_SECRET` leaks or you rotate the endpoint:

1. Stripe Dashboard → Developers → Webhooks → click the endpoint → "Roll secret"
2. Copy the new `whsec_...` value
3. Railway → matchedcare-billing → Variables → update `STRIPE_WEBHOOK_SECRET` → Save
4. Stripe sends events using the new signature within seconds. The old signature stops being accepted.

If you need overlap (rare), Stripe supports up to 5 active endpoint secrets per endpoint — add the new one in code (accept either), deploy, then remove the old one from Stripe + env.

## Where errors go

- **Server-side:** Railway log viewer. Filter for `[client-error]` for browser-reported errors, or by route name (e.g., `create-setup-intent:`).
- **Client-side:** Browser console plus a POST to `/report-error` on this server (see above).
- **Stripe webhook failures:** Stripe Dashboard → Developers → Webhooks → endpoint detail page shows retry history and the response body we returned.
