# BrattyBot edge (Cloudflare Tunnel)

The dashboard is published at **https://brattybot.fettra.app** through a Cloudflare Tunnel. No port is opened on
the home network, and the home IP is never published. The pattern is the home-lab runbook
`Home-Lab/servers/cloudflare-tunnel.md`; this file is the project-specific part.

```
browser → Cloudflare edge (TLS, WAF) → tunnel → cloudflared (compose sidecar) → discord-spicy-bot:8080
```

| Thing | Value |
| --- | --- |
| Gate | The dashboard's own Discord login. No Cloudflare Access. |
| Pulumi | Pulumi Cloud, org `douglasg14b`, project `brattybot-edge`, stack `prod` |
| Account | `95b8af8ccb4ef613c56be4082f89b5be` |
| Zone | `fettra.app`. Treated as shared: Pulumi owns only this one DNS record. |
| Origin | `http://discord-spicy-bot:8080` (compose service + `WEB_PORT`), serving the built dashboard and `/api` |
| LAN path | None. At home the dashboard goes through Cloudflare too. |
| Deploys | Coolify, Docker Compose build pack, `docker-compose.yml`, branch `feat/web-ui-flow-engine` |

`index.ts` declares the tunnel, its ingress, and the DNS record. Nothing else in the zone: WAF and rate limit rules
are zone-wide rulesets, so they're set by hand (below).

## 1. API token (once)

Dashboard → My Profile → API Tokens → Create Custom Token:

- **Account → Cloudflare Tunnel → Edit**
- **Zone → DNS → Edit**, scoped to `fettra.app` only

No WAF or Zone-edit permission, on purpose, so this token can't touch firewall rules. Never reuse it in the app.

## 2. Stack and config

Find the zone id in the dashboard (fettra.app → Overview, right column). Then, in PowerShell:

```powershell
cd infra
pnpm install
pulumi login                                     # Pulumi Cloud, org douglasg14b
pulumi stack init douglasg14b/prod               # or: pulumi stack select douglasg14b/prod
pulumi config set --secret cloudflare:apiToken   # prompts, so nothing lands in shell history
pulumi config set accountId 95b8af8ccb4ef613c56be4082f89b5be
pulumi config set zoneId <fettra.app zone id>
```

Commit `Pulumi.prod.yaml` afterwards. The API token in it is encrypted with the Pulumi Cloud stack key; the ids are
identifiers, not credentials. Always run against Pulumi Cloud: another backend sees empty state and would create a
second tunnel and a clashing DNS record.

## 3. Pre-flight (read-only)

From `infra/`, with the token loaded in-process and never printed:

```powershell
$env:CF_TOKEN = (pulumi config get cloudflare:apiToken)
$h = @{ Authorization = "Bearer $env:CF_TOKEN" }
$account = '95b8af8ccb4ef613c56be4082f89b5be'
$zone = '<fettra.app zone id>'
# The zone is in this account (expect: fettra.app, and this account id):
(Invoke-RestMethod "https://api.cloudflare.com/client/v4/zones/$zone" -Headers $h).result | Select-Object name, @{n='account';e={$_.account.id}}
# No record for the hostname yet, and no wildcard (expect: nothing):
(Invoke-RestMethod "https://api.cloudflare.com/client/v4/zones/$zone/dns_records?name=brattybot.fettra.app" -Headers $h).result
(Invoke-RestMethod "https://api.cloudflare.com/client/v4/zones/$zone/dns_records?name=*.fettra.app" -Headers $h).result
# No tunnel with this name yet (expect: nothing):
(Invoke-RestMethod "https://api.cloudflare.com/client/v4/accounts/$account/cfd_tunnel?name=brattybot-dashboard&is_deleted=false" -Headers $h).result
Remove-Item Env:CF_TOKEN
```

Also look at **fettra.app → Security → WAF** for existing custom rules, especially a "block every host except
these" rule, which would block the new hostname (section 6).

## 4. Create the edge

```powershell
pulumi preview                                   # expect 4 creates: stack, tunnel, ingress, DNS record
pulumi up
pulumi stack output tunnelToken --show-secrets | Set-Clipboard
```

## 5. Discord and Coolify

**Discord Developer Portal → the production BrattyBot app → OAuth2:**

| Setting | Value |
| --- | --- |
| Redirects | add `https://brattybot.fettra.app/api/auth/callback` |
| Client Secret | copy it for `DISCORD_OAUTH_CLIENT_SECRET` below (the app's secret, not the bot token) |

**Coolify → the bot's resource → Environment Variables** (all as secrets):

| Variable | Value |
| --- | --- |
| `TUNNEL_TOKEN` | the tunnel token from step 4 (paste from clipboard) |
| `DISCORD_OAUTH_CLIENT_SECRET` | from the Discord portal |
| `SESSION_SECRET` | a long random string, at least 32 characters (a shorter one, or the development placeholder, keeps the dashboard off) — changing it signs everyone out. Rotate it once with the owner/Administrator-only change: sessions from before it still list Manage-Server-only servers for up to 7 days (opening one is refused). Generate one straight to the clipboard: `$b = [byte[]]::new(48); [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) \| Set-Clipboard` |
| `OPENROUTER_API_KEY` | new required variable; the bot won't start without it |
| `ADMIN_DISCORD_IDS` | optional; leave empty normally |
| `ALLOWED_GUILD_IDS` | comma-separated ids of the servers the bot may work in. The bot is public, so set this: on joining any other server it leaves at once. Unset allows every server (logged at startup). Never leaves a server it is already in, but the dashboard hides any server not on the list — list every server you still manage. |

`WEB_PUBLIC_URL` is fixed in `docker-compose.yml`, so it isn't a Coolify variable. Never paste Coolify deploy logs
anywhere: they echo the whole environment in plaintext.

Order: `pulumi up` → variables into Coolify → push → deploy. Coolify deploys from the remote branch.

## 6. Edge rules, by hand

**fettra.app → Security → WAF:**

| Rule | Where | Expression | Action |
| --- | --- | --- | --- |
| `BrattyBot: North America only` | Custom rules | `(http.host eq "brattybot.fettra.app" and not ip.src.continent in {"NA"})` | Block |
| `BrattyBot: login rate limit` | Rate limiting rules | `(http.request.uri.path in {"/api/auth/login" "/api/auth/callback"})` | Block; 5 requests / 10 s per IP; for 10 s |

- If a "block every host except these" rule exists, add `brattybot.fettra.app` to it. Write it as
  `not http.host in {"a.fettra.app" "brattybot.fettra.app"}`; a chain of `ne ... or ne ...` is always true and blocks
  everything.
- The free plan allows **one** rate limiting rule per zone. This zone is separate from `moochermedia.co`, so Budget
  Tools' rule doesn't cover it. If fettra.app's slot is already used, widen that rule's path expression rather than
  replacing it.
- The rate limit covers the OAuth callback as well as the login: each callback makes the server call Discord three
  times, so it is limited per IP here, before anyone has a session. Everything after login is limited per signed-in
  user in the app (`src/web/rateLimit.ts`), because every request reaches the app through `cloudflared` from one
  address.
- Put the geo-block above any **Skip** rule that could match the host.
- **SSL/TLS → Edge Certificates → Always Use HTTPS**: on.

The app refuses plain HTTP on its own as well, marks every `/api` answer `private, no-store`, and sends security
headers on every answer — HSTS, `nosniff`, and framing refused (`X-Frame-Options: DENY`, `frame-ancestors 'none'`)
(`src/web/edgeGuards.ts`). It also refuses any `/api` body over 1 MiB (`src/web/api/index.ts`).

## 7. Verify

Split-horizon DNS at home covers only `*.moochermedia.co`, so from home you're already testing the real tunnel.

1. Tunnel healthy (read `status`, expect `healthy` with connections):
   `GET /accounts/{account}/cfd_tunnel?name=brattybot-dashboard`
2. `https://brattybot.fettra.app/` shows the dashboard. A bare 404 means the ingress hostname is wrong (it hit the
   catch-all).
3. `https://brattybot.fettra.app/api/health` answers `{"ok":true,...}`.
4. `http://brattybot.fettra.app/` gets a 301 to https at the edge.
5. Sign in with Discord, open a server, open a flow. Do it once from a phone on mobile data.
6. From a non-NA VPN: a Cloudflare block page. Six quick hits on `/api/auth/login`, or on `/api/auth/callback`: a
   429.

## Limits

- Cloudflare gives up on a request after **~125 s (HTTP 524)**. Installing or unpublishing a journey talks to
  Discord inside the request; a normal journey takes seconds, but a large one that hits Discord's rate limits could
  pass that. The browser then shows an error, but the work carries on server-side; reload to see where it got to.
- WebSockets would work through the tunnel with no extra config (the dashboard doesn't use them today).

## Tearing down

Everything is `protect: true`. To remove it on purpose: `pulumi state unprotect --all`, then `pulumi destroy`, then
remove the `cloudflared` service and `TUNNEL_TOKEN`.
