/*
This is the core app. It binds together the components in src/ and keeps the
local state: which devices are handled here, and how.

1. Prepare the iptables chain
2. Register statically configured devices
3. Subscribe to registry changes and apply all known devices
4. Start the watcher, which registers newly seen devices
 */

import os from 'node:os';
import { createClient } from 'redis';
import { createLogger } from './logger.js';
import { PollCache } from './cache.js';
import { DeviceProxy } from './proxy.js';
import { DeviceRegistry, validateDevice } from './registry.js';
import { Iptables } from './iptables.js';
import { Watcher } from './watcher.js';
import { createHttpServer } from './http.js';

const log = createLogger(`app`);

export class App {
  constructor(config) {
    this.config = config;
    this.devices = new Map(); // ip -> { device, proxy }
    this.discovered = new Set();
    this.changes = Promise.resolve();
  }

  async start() {
    const { config } = this;

    this.redis = await this.connect(`redis`);
    this.subscriber = await this.connect(`redis-subscriber`);

    this.cache = new PollCache({ redis: this.redis, ...config.cache });
    this.registry = new DeviceRegistry({ client: this.redis, subscriber: this.subscriber, prefix: config.redis.prefix });

    if (config.iptables.enabled) {
      this.iptables = new Iptables(config.iptables);
      await this.iptables.setup({ logging: config.watcher.enabled });
    } else {
      log.warn(`iptables disabled - only devices with a fixed port are reachable`);
    }

    for (const device of config.devices.static)
      await this.registry.upsert(validateDevice({ handler: config.devices.defaultHandler, source: `config`, ...device }));

    this.registry.on(`upsert`, (device) => this.enqueue(() => this.apply(device)));
    this.registry.on(`remove`, (ip) => this.enqueue(() => this.drop(ip)));
    await this.registry.start();

    for (const device of await this.registry.list())
      await this.enqueue(() => this.apply(device));

    if (config.watcher.enabled) {
      this.watcher = new Watcher({ file: config.watcher.file, prefix: config.iptables.logPrefix });
      this.watcher.on(`ip`, (ip) => this.discover(ip));
      this.watcher.start();
    }

    if (config.http.enabled) {
      const { address, port } = config.http;

      this.http = createHttpServer(this);
      await new Promise((resolve) => this.http.listen(port, address, resolve));
      log.info(`http listening on ${address}:${port}`);
    }

    log.info(`started with ${this.devices.size} device(s)`);
  }

  async stop() {
    log.info(`stopping`);

    this.watcher?.stop();
    this.http?.close();

    // Remove the DNAT rules first, so polls go straight to the devices again.
    await this.iptables?.teardown();

    await this.changes;
    for (const { proxy } of this.devices.values())
      await proxy?.stop();
    this.devices.clear();

    await this.registry?.stop().catch(() => {});
    await this.subscriber?.close().catch(() => {});
    await this.redis?.close().catch(() => {});
  }

  async connect(name) {
    const client = createClient({ url: this.config.redis.url, disableOfflineQueue: true });

    client.on(`error`, (err) => log.warn(`${name}: ${err.message}`));
    client.on(`ready`, () => log.info(`${name} connected`));

    await client.connect();

    return client;
  }

  // Device changes are applied one at a time to keep iptables consistent.
  enqueue(fn) {
    const job = this.changes.then(fn);

    this.changes = job.catch((err) => log.error(err));

    return job;
  }

  async apply(device) {
    const { ip, handler, port } = device;
    const current = this.devices.get(ip)?.device;

    if (current && current.handler === handler && current.port === port)
      return;

    await this.drop(ip);

    if (handler === `passthrough`) {
      await this.iptables?.passthrough(ip);
      this.devices.set(ip, { device, proxy: null });
      log.info(`${ip}: passthrough`);
      return;
    }

    const { proxy: { address }, redis: { prefix }, upstream } = this.config;
    const proxy = new DeviceProxy({ ip, address, port, cache: this.cache, prefix, upstream });

    await proxy.start();
    await this.iptables?.proxy(ip, address, proxy.port);
    this.devices.set(ip, { device, proxy });
    log.info(`${ip}: proxied via ${address ?? `*`}:${proxy.port}`);
  }

  async drop(ip) {
    const entry = this.devices.get(ip);
    if (!entry)
      return;

    await this.iptables?.remove(ip);
    await entry.proxy?.stop();
    this.devices.delete(ip);
    this.discovered.delete(ip);
    log.info(`${ip}: removed`);
  }

  discover(ip) {
    if (this.devices.has(ip) || this.discovered.has(ip))
      return;

    this.discovered.add(ip);
    log.info(`${ip}: discovered`);

    this.registry.upsert({
      ip,
      handler: this.config.devices.defaultHandler,
      source: os.hostname(),
      discoveredAt: new Date().toISOString()
    }).catch((err) => {
      this.discovered.delete(ip);
      log.error(`${ip}: cannot register: ${err.message}`);
    });
  }
}
