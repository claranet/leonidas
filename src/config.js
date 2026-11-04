/*
Configuration is merged from (later wins):
  1. config/default.json
  2. the file in $LEONIDAS_CONFIG, or config/local.json if it exists
  3. environment variables (see ENV below)
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `..`);

const ENV = {
  REDIS_URL: [ `redis`, `url` ],
  LEONIDAS_PROXY_ADDRESS: [ `proxy`, `address` ],
  LEONIDAS_MEMORY_TTL_SEC: [ `cache`, `memoryTtlSec` ],
  LEONIDAS_REDIS_TTL_SEC: [ `cache`, `redisTtlSec` ],
  LEONIDAS_IPTABLES_ENABLED: [ `iptables`, `enabled` ],
  LEONIDAS_WATCHER_ENABLED: [ `watcher`, `enabled` ],
  LEONIDAS_WATCHER_FILE: [ `watcher`, `file` ],
  LEONIDAS_HTTP_ADDRESS: [ `http`, `address` ],
  LEONIDAS_HTTP_PORT: [ `http`, `port` ],
  LOG_LEVEL: [ `log`, `level` ]
};

const isObject = (v) => v !== null && typeof v === `object` && !Array.isArray(v);

export const merge = (target, source) => {
  const out = { ...target };

  for (const [ key, value ] of Object.entries(source))
    out[key] = isObject(value) && isObject(out[key]) ? merge(out[key], value) : value;

  return out;
};

// Coerces env strings to the type of the default value they override.
const coerce = (raw, current) => {
  if (typeof current === `number`)
    return Number(raw);

  if (typeof current === `boolean`)
    return [ `1`, `true`, `yes`, `on` ].includes(raw.toLowerCase());

  return raw;
};

const readJson = (file) => JSON.parse(readFileSync(file, `utf8`));

export const loadConfig = (env = process.env) => {
  let config = readJson(path.join(root, `config`, `default.json`));

  const override = env.LEONIDAS_CONFIG || path.join(root, `config`, `local.json`);
  if (env.LEONIDAS_CONFIG || existsSync(override))
    config = merge(config, readJson(override));

  for (const [ name, [ section, key ] ] of Object.entries(ENV)) {
    if (env[name] !== undefined && env[name] !== ``)
      config[section][key] = coerce(env[name], config[section][key]);
  }

  validate(config);

  return config;
};

const validate = (config) => {
  const { cache, iptables, proxy } = config;

  if (iptables.enabled && !proxy.address)
    throw new Error(`proxy.address (LEONIDAS_PROXY_ADDRESS) is required when iptables is enabled`);

  if (cache.memoryTtlSec > cache.redisTtlSec)
    throw new Error(`cache.memoryTtlSec must not be larger than cache.redisTtlSec`);
};
