/*
Two tier cache for poll responses: a per-process LRU in front of Redis.
Redis errors never fail a poll - they are logged and treated as a miss, so
Leonidas keeps working (uncached) while Redis is unavailable.
 */

import { LRUCache } from 'lru-cache';
import { createLogger } from './logger.js';

const log = createLogger(`cache`);

const serialize = ({ errorStatus, errorIndex, varbinds }) =>
  JSON.stringify({ s: errorStatus, i: errorIndex, v: varbinds.toString(`base64`) });

const deserialize = (raw) => {
  const { s, i, v } = JSON.parse(raw);

  return { errorStatus: s, errorIndex: i, varbinds: Buffer.from(v, `base64`) };
};

export class PollCache {
  constructor({ redis, memoryTtlSec, redisTtlSec, maxEntries }) {
    this.redis = redis;
    this.redisTtlSec = redisTtlSec;

    this.memory = memoryTtlSec > 0
      ? new LRUCache({ max: maxEntries, ttl: memoryTtlSec * 1000 })
      : null;
  }

  // Resolves to { entry, source } where source is `memory`, `redis` or null.
  async get(key) {
    const local = this.memory?.get(key);
    if (local)
      return { entry: local, source: `memory` };

    if (!this.redis)
      return { entry: null, source: null };

    try {
      const raw = await this.redis.get(key);
      if (!raw)
        return { entry: null, source: null };

      const entry = deserialize(raw);
      this.memory?.set(key, entry);

      return { entry, source: `redis` };
    } catch (err) {
      log.warn(`redis get failed for ${key}: ${err.message}`);
      return { entry: null, source: null };
    }
  }

  async set(key, entry) {
    this.memory?.set(key, entry);

    if (!this.redis)
      return;

    try {
      await this.redis.set(key, serialize(entry), { expiration: { type: `EX`, value: this.redisTtlSec } });
    } catch (err) {
      log.warn(`redis set failed for ${key}: ${err.message}`);
    }
  }
}
