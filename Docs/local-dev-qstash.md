# Local-dev QStash callback setup

Upstash QStash delivers pipeline-stage messages to a callback URL over the
public internet. Local dev runs on `http://localhost:3000`, which QStash
rejects with a 400 on `publishJSON` — hence the real-inet tunnel pattern
below.

## When you need this

- **Manual browser dev** at `localhost:3000` where real QStash enqueue round-trips should flow (e.g. reproducing a prod pipeline-stage bug, verifying a QStash signature change).
- **NOT needed for E2E (Playwright)** — the `NODE_ENV=test` bypass at `lib/qstash.ts:63-86` short-circuits to an inline POST against `http://127.0.0.1:3000/api/pipeline/stage`. E2E runs never hit the real QStash path.

## Setup (ephemeral tunnel)

1. Run a cloudflared quick tunnel pointed at your Next dev server:

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

   The command prints a generated URL like
   `https://asian-edgar-closely-set.trycloudflare.com`. That URL survives
   only for the lifetime of the cloudflared process — **re-run on every
   restart; copy the new URL each time.**

2. Set the callback base in `.env.local`:

   ```bash
   QSTASH_CALLBACK_BASE=https://<your-trycloudflare-subdomain>.trycloudflare.com
   ```

   `.env.local` is git-ignored; the tunnel URL never lands in the repo.

3. Restart your Next dev server so the new env is picked up.

## Precedence (lib/qstash.ts)

The enqueue path resolves the callback base in this order — first non-empty
wins:

1. `QSTASH_CALLBACK_BASE` — preferred; use this for local tunnel dev.
2. `PIPELINE_CALLBACK_URL` — legacy; retained for back-compat with existing
   `.env.local` files and deploys that already set it.
3. `NEXT_PUBLIC_APP_URL` — production default (`https://geo.flowblinq.com`).
4. `http://localhost:3000` — last-resort fallback. QStash will 400 on this;
   the fallback exists only so the throw happens in QStash-land with a
   clear message rather than a `TypeError` from an undefined base.

## Alternatives

- **`LOCAL_PIPELINE=1`** — skips QStash entirely, calls
  `${PIPELINE_CALLBACK_URL ?? "http://localhost:3050"}/api/pipeline/stage`
  directly. Fine for pipeline-logic testing when you don't need the real
  QStash round-trip (signatures, retries, delay semantics). Predates the
  tunnel flow and stays supported.

- **`NODE_ENV=test` OR `QSTASH_LOCAL_BYPASS=1`** — the E2E bypass. Inline
  POST against the webserver port. Never fires in prod. Do not enable this
  for manual dev sessions — it intentionally subverts the real QStash path
  and will confuse signature-verification debugging.
