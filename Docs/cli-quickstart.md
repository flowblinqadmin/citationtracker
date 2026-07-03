# Flowblinq CLI — Quickstart

## Setup

**1. Set credentials**

```bash
export FLOWBLINQ_CLIENT_ID=fq_live_...
export FLOWBLINQ_CLIENT_SECRET=sk_...
```

Or create `~/.flowblinq/config.json`:
```json
{
  "client_id": "fq_live_...",
  "client_secret": "sk_..."
}
```

Get credentials from: geo.flowblinq.com → Dashboard → API Access → Generate key

**2. Verify connection**

```bash
npm run cli -- auth test
# ✓ Connected — team: team_abc123 | credits: 95
```

---

## Run an audit

```bash
# Submit + poll in one shot (easiest)
npm run cli -- audit run https://example.com

# Or step by step:
npm run cli -- audit submit https://example.com
# → Audit ID: site_abc123

npm run cli -- audit wait site_abc123
# → Score: 72/100 + pillar breakdown + file URLs
```

---

## Second run (post-optimization)

After applying the generated assets (llms.txt, schema blocks):

```bash
npm run cli -- audit verify site_abc123
# → New Audit ID: site_def456

npm run cli -- audit wait site_def456
# → before/after score comparison
```

---

## Other commands

```bash
npm run cli -- audit status site_abc123   # quick status check, no waiting
npm run cli -- account                    # credit balance
npm run cli -- mcp                        # MCP manifest (for AI agent integrations)
```

---

## JSON output

Add `--json` to any command to get raw JSON (pipe to `jq`):

```bash
npm run cli -- audit run https://example.com --json | jq '.overall_score'
```

---

## Credential override (one-off)

```bash
npm run cli -- --client-id fq_live_... --client-secret sk_... auth test
```
