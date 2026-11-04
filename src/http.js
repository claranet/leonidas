/*
Small read-only HTTP endpoint for health checks and statistics.

  GET /health    liveness and Redis connectivity
  GET /devices   handled devices with per-device cache statistics
 */

import http from 'node:http';

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': `application/json` });
  res.end(JSON.stringify(body, null, 2));
};

export const createHttpServer = (app) => http.createServer((req, res) => {
  if (req.method !== `GET`)
    return send(res, 405, { error: `method not allowed` });

  if (req.url === `/health`) {
    return send(res, 200, {
      status: `ok`,
      redis: app.redis?.isReady ?? false,
      devices: app.devices.size
    });
  }

  if (req.url === `/devices`) {
    return send(res, 200, [ ...app.devices.values() ].map(({ device, proxy }) => ({
      ...device,
      listenPort: proxy?.port ?? null,
      stats: proxy?.stats ?? null
    })));
  }

  return send(res, 404, { error: `not found` });
});
