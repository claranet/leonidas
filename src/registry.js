/*
The device registry is shared by all Leonidas instances through Redis:

  <prefix>:devices   hash, field = device IP, value = JSON device
  <prefix>:devices   pub/sub channel, message = JSON { ip, action }

Every change is published, and every instance (including the one making the
change) applies it when the message arrives. No state is kept here.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createLogger } from './logger.js';

const log = createLogger(`registry`);

export const HANDLERS = [ `proxy`, `passthrough` ];

export const validateDevice = (device) => {
  if (!device || !net.isIPv4(device.ip))
    throw new Error(`device needs an IPv4 address: ${JSON.stringify(device)}`);

  if (!HANDLERS.includes(device.handler))
    throw new Error(`device handler must be one of ${HANDLERS.join(`, `)}: ${JSON.stringify(device)}`);

  // Optional fixed listen port, for setups where pollers address Leonidas directly.
  if (device.port !== undefined && !(Number.isInteger(device.port) && device.port > 0 && device.port < 65536))
    throw new Error(`device port must be 1-65535: ${JSON.stringify(device)}`);

  return device;
};

export class DeviceRegistry extends EventEmitter {
  constructor({ client, subscriber, prefix }) {
    super();
    this.client = client;
    this.subscriber = subscriber;
    this.key = `${prefix}:devices`;
  }

  async start() {
    await this.subscriber.subscribe(this.key, (message) => this.onMessage(message));
  }

  async stop() {
    await this.subscriber.unsubscribe(this.key);
  }

  async list() {
    const all = await this.client.hGetAll(this.key);

    return Object.values(all).map((raw) => JSON.parse(raw));
  }

  async get(ip) {
    const raw = await this.client.hGet(this.key, ip);

    return raw ? JSON.parse(raw) : null;
  }

  async upsert(device) {
    validateDevice(device);

    await this.client.hSet(this.key, device.ip, JSON.stringify(device));
    await this.client.publish(this.key, JSON.stringify({ ip: device.ip, action: `upsert` }));
  }

  async remove(ip) {
    await this.client.hDel(this.key, ip);
    await this.client.publish(this.key, JSON.stringify({ ip, action: `remove` }));
  }

  async onMessage(message) {
    try {
      const { ip, action } = JSON.parse(message);

      if (action === `remove`)
        return this.emit(`remove`, ip);

      const device = await this.get(ip);
      if (device)
        this.emit(`upsert`, device);
    } catch (err) {
      log.warn(`cannot handle message ${message}: ${err.message}`);
    }
  }
}
