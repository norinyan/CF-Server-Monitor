import { getAllServers } from '../utils/cache.js';
import { getLatestTimestampsForAllServers } from '../database/schema.js';
import { createSuccessResponse } from '../utils/errors.js';

// An explicit projection: never return server rows, IDs, metrics or settings.
export async function handlePublicStatus(env) {
  const servers = await getAllServers(env.DB, false);
  const timestamps = await getLatestTimestampsForAllServers(env.DB);
  if (!timestamps) {
    return new Response(JSON.stringify({ error: 'Status temporarily unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  const now = Date.now();
  const visible = servers.map(server => {
    const timestamp = Number(timestamps.get(server.id));
    return {
      name: String(server.name || 'Unnamed'),
      region: String(server.region || ''),
      online: Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now && now - timestamp < 300000
    };
  });
  const online = visible.filter(server => server.online).length;
  return createSuccessResponse({
    servers: visible,
    stats: { total: visible.length, online, offline: visible.length - online }
  }, { 'Cache-Control': 'no-store' });
}
