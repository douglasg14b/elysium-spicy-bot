import {
    DnsRecord,
    getZeroTrustTunnelCloudflaredTokenOutput,
    ZeroTrustTunnelCloudflared,
    ZeroTrustTunnelCloudflaredConfig,
} from '@pulumi/cloudflare';
import { Config, interpolate, secret } from '@pulumi/pulumi';

/**
 * BrattyBot's public edge: the web dashboard at https://brattybot.fettra.app, reached through one remotely-managed
 * Cloudflare Tunnel, so the home server publishes no inbound port and never exposes its IP.
 *
 * The gate is the dashboard's own Discord login; there is no Cloudflare Access in front. Who may change what is
 * decided in the app (`src/web/api/guildAccess.ts`), so this program only makes the dashboard reachable.
 *
 * Deliberately NOT declared here, because fettra.app is not owned by this project:
 *   - any other DNS record in the zone;
 *   - WAF custom rules and rate limiting rules. Each phase is one zone-wide ruleset, so declaring one would make this
 *     stack the owner of every rule in the zone. They are set by hand; infra/README.md records the expressions.
 */

/** DNS zone the dashboard's hostname lives in. */
const ZONE_NAME = 'fettra.app';

/**
 * The dashboard's public hostname. `WEB_PUBLIC_URL` in docker-compose.prod.yml names the same origin, because the OAuth
 * redirect URI is built from it; changing one means changing both, and the redirect registered on the Discord app.
 */
const DASHBOARD_HOSTNAME = `brattybot.${ZONE_NAME}`;

/**
 * Where cloudflared sends dashboard traffic: the bot's compose service on WEB_PORT (8080), which serves the built
 * dashboard and its `/api` from one origin. A sibling container in the same Compose project, not localhost. Plain
 * http: the hop never leaves the Docker network.
 */
const DASHBOARD_ORIGIN = 'http://discord-spicy-bot:8080';

/** Catch-all ingress rule. Cloudflare requires the last rule to have no hostname. */
const UNMATCHED_REQUEST_RESPONSE = 'http_status:404';

/** Cloudflare's "automatic" TTL. Proxied records must use it — the edge, not the resolver, controls caching. */
const DNS_TTL_AUTOMATIC = 1;

const config = new Config();

/** Cloudflare account that owns the tunnel. */
const accountId = config.require('accountId');

/** Zone that holds the dashboard's record. */
const zoneId = config.require('zoneId');

/**
 * Tunnel identity. `configSrc: 'cloudflare'` makes it remotely managed: Cloudflare stores the ingress rules
 * (declared below), so the connector in docker-compose.prod.yml runs with only a token and no config file.
 */
const dashboardTunnel = new ZeroTrustTunnelCloudflared(
    'dashboard-tunnel',
    {
        accountId,
        name: 'brattybot-dashboard',
        configSrc: 'cloudflare',
    },
    // The tunnel, its ingress and the DNS record are the entire public path to the dashboard. `protect` makes an
    // accidental `pulumi destroy` fail loudly instead of taking it offline; see README to unprotect.
    { protect: true },
);

/** The remotely-stored ingress rules: the one hostname, then the required catch-all. */
const dashboardTunnelIngress = new ZeroTrustTunnelCloudflaredConfig(
    'dashboard-ingress',
    {
        accountId,
        tunnelId: dashboardTunnel.id,
        config: {
            ingresses: [
                { hostname: DASHBOARD_HOSTNAME, service: DASHBOARD_ORIGIN },
                { service: UNMATCHED_REQUEST_RESPONSE },
            ],
        },
    },
    { protect: true },
);

/**
 * The public hostname pointed at the tunnel. Proxied, so Cloudflare terminates TLS; the cfargotunnel.com target only
 * resolves inside Cloudflare's network.
 *
 * `dependsOn` matters: the record derives only from the tunnel id, which would let Pulumi publish DNS before the
 * remotely-stored ingress exists, serving errors until it caught up.
 */
new DnsRecord(
    'dashboard-dns',
    {
        zoneId,
        name: DASHBOARD_HOSTNAME,
        type: 'CNAME',
        content: interpolate`${dashboardTunnel.id}.cfargotunnel.com`,
        proxied: true,
        ttl: DNS_TTL_AUTOMATIC,
        comment: 'BrattyBot dashboard via Cloudflare Tunnel. Managed by Pulumi (discord-spicy-bot infra/).',
    },
    { protect: true, dependsOn: [dashboardTunnelIngress] },
);

export const tunnelId = dashboardTunnel.id;
export const tunnelIngressVersion = dashboardTunnelIngress.version;
export const dashboardHostname = DASHBOARD_HOSTNAME;

/**
 * What TUNNEL_TOKEN in docker-compose.prod.yml consumes. Anyone holding it can run a connector for this tunnel, so it is a
 * secret: encrypted in stack state and withheld from `pulumi stack output` unless asked for explicitly.
 */
export const tunnelToken = secret(
    getZeroTrustTunnelCloudflaredTokenOutput({ accountId, tunnelId: dashboardTunnel.id }).token,
);
