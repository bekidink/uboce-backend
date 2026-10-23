import express, { type Router } from 'express';
import type { Logger } from 'pino';
import { getAbsoluteFSPath } from 'swagger-ui-dist';

import { type ServiceName, SERVICES } from './routes.js';

const TITLES: Record<ServiceName, string> = {
  identity: 'Identity — auth, sessions, MFA',
  organization: 'Organization — orgs, members, invitations',
  notification: 'Notification — inbox, devices',
  catalog: 'Catalog — products & categories',
  discovery: 'Discovery — public search',
  procurement: 'Procurement — RFQs & quotations',
  commerce: 'Commerce — purchase & sales orders',
  inventory: 'Inventory — stock ledger',
  warehouse: 'Warehouse — receiving & transfers',
  logistics: 'Logistics — shipments & delivery',
  quality: 'Quality — inspections',
  agriculture: 'Agriculture — farms, harvests, lots',
  manufacturing: 'Manufacturing — BOMs & production',
  kyc: 'KYC — individual verification',
  kyb: 'KYB — business verification',
  finance: 'Finance — invoices & payments',
  document: 'Document — private files',
  dispute: 'Dispute & Performance',
  integration: 'Integration — provider webhooks',
  analytics: 'Analytics — reports',
  administration: 'Administration — platform staff',
};

const CACHE_MS = 60_000;

/**
 * One Swagger UI for the whole API at /docs, with a service picker. Specs are
 * fetched from each service's /docs-json and served same-origin, so "Try it
 * out" goes through the gateway (routing, rate limits) exactly like a client.
 */
export function docsRouter(upstreams: Record<ServiceName, string>, logger: Logger): Router {
  const router = express.Router();
  const cache = new Map<ServiceName, { at: number; spec: unknown }>();

  router.get('/docs/specs/:service.json', async (req, res) => {
    const service = req.params.service as ServiceName;
    if (!SERVICES.includes(service)) {
      res.status(404).json({ error: { code: 'not_found', message: 'Unknown service' } });
      return;
    }
    const hit = cache.get(service);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      res.json(hit.spec);
      return;
    }
    try {
      const upstream = await fetch(`${upstreams[service]}/docs-json`, { signal: AbortSignal.timeout(3000) });
      if (!upstream.ok) throw new Error(`status ${upstream.status}`);
      const spec = (await upstream.json()) as { servers?: unknown; info?: { description?: string } };
      // Requests from the UI go to the gateway, the only public entry point.
      spec.servers = [{ url: '/', description: 'API gateway' }];
      cache.set(service, { at: Date.now(), spec });
      res.json(spec);
    } catch (error) {
      logger.warn({ err: error, service }, 'could not load OpenAPI spec');
      res.status(502).json({ error: { code: 'upstream_unavailable', message: `The ${service} service is not reachable` } });
    }
  });

  // Config lives in a file, not inline, so the page works under helmet's Content-Security-Policy.
  router.get('/docs/init.js', (_req, res) => {
    const urls = SERVICES.map((s) => ({ url: `/docs/specs/${s}.json`, name: TITLES[s] }));
    res.type('application/javascript').send(`window.onload = function () {
  window.ui = SwaggerUIBundle({
    urls: ${JSON.stringify(urls)},
    'urls.primaryName': ${JSON.stringify(TITLES.identity)},
    dom_id: '#swagger-ui',
    deepLinking: true,
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: false,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    layout: 'StandaloneLayout',
  });
};
`);
  });

  router.get(['/docs', '/docs/'], (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>UBOCE API</title>
  <link rel="stylesheet" href="/docs/assets/swagger-ui.css" />
  <link rel="icon" href="/docs/assets/favicon-32x32.png" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/assets/swagger-ui-bundle.js"></script>
  <script src="/docs/assets/swagger-ui-standalone-preset.js"></script>
  <script src="/docs/init.js"></script>
</body>
</html>`);
  });

  router.use('/docs/assets', express.static(getAbsoluteFSPath(), { index: false, maxAge: '1d' }));
  return router;
}
