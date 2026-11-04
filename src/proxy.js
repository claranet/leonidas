/*
A DeviceProxy listens on a random UDP port for the polls that iptables
DNATs to it for one device, and answers them from the cache when possible:

  memory LRU -> Redis -> poll the device (concurrent identical polls share
  one upstream request) -> store in Redis and memory -> reply

Polls that cannot be cached (SET, SNMPv3, ...) are relayed transparently.
 */

import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { createLogger } from './logger.js';
import { parseMessage, readVersion, encodeMessage, PDU, PDU_NAMES, VERSION } from './snmp/message.js';
import { request as defaultRequest, TimeoutError } from './upstream.js';

const CACHEABLE_PDUS = new Set([ PDU.GET, PDU.GET_NEXT, PDU.GET_BULK ]);

// noError and noSuchName (the SNMPv1 end-of-MIB signal) are stable answers;
// anything else (tooBig, genErr, ...) is passed on but not cached.
const CACHEABLE_ERRORS = new Set([ 0, 2 ]);

export const makeKey = (prefix, ip, msg) => {
  // The community is hashed so that secrets do not end up in Redis key names.
  const community = createHash(`sha256`).update(msg.community).digest(`hex`).slice(0, 16);
  const bulk = msg.pduType === PDU.GET_BULK ? `:${msg.errorStatus}:${msg.errorIndex}` : ``;

  return `${prefix}:poll:${ip}:${msg.version}:${community}:${PDU_NAMES[msg.pduType]}${bulk}:${msg.oids.join(`,`)}`;
};

export class DeviceProxy {
  constructor({ ip, address, port = 0, cache, prefix, upstream, request = defaultRequest }) {
    this.ip = ip;
    this.address = address;
    this.listenPort = port;
    this.cache = cache;
    this.prefix = prefix;
    this.upstream = { ...upstream, host: ip };
    this.request = request;

    this.log = createLogger(`proxy:${ip}`);
    this.inflight = new Map();
    this.port = null;
    this.socket = null;

    this.stats = { polls: 0, memoryHits: 0, redisHits: 0, misses: 0, relayed: 0, timeouts: 0, errors: 0 };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket(this.address?.includes(`:`) ? `udp6` : `udp4`);

      this.socket.once(`error`, reject);
      this.socket.on(`message`, (buf, src) => this.handle(buf, src));

      this.socket.bind({ address: this.address, port: this.listenPort }, () => {
        this.socket.off(`error`, reject);
        this.socket.on(`error`, (err) => this.log.error(err));

        this.port = this.socket.address().port;
        this.log.info(`listening on ${this.socket.address().address}:${this.port}`);

        return resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.socket)
        return resolve();

      this.socket.close(() => resolve());
      this.socket = null;
      this.port = null;
    });
  }

  async handle(buf, src) {
    this.stats.polls++;

    try {
      const reply = await this.answer(buf);

      if (reply && this.socket)
        this.socket.send(reply, src.port, src.address);
    } catch (err) {
      if (err instanceof TimeoutError) {
        this.stats.timeouts++;
        this.log.warn(err.message);
      } else {
        this.stats.errors++;
        this.log.warn(`poll from ${src.address}:${src.port} failed: ${err.message}`);
      }
    }
  }

  async answer(buf) {
    let msg = null;

    if ([ VERSION.V1, VERSION.V2C ].includes(readVersion(buf)))
      msg = parseMessage(buf);

    if (!msg || !CACHEABLE_PDUS.has(msg.pduType)) {
      this.stats.relayed++;
      return this.request(buf, this.upstream);
    }

    const key = makeKey(this.prefix, this.ip, msg);
    const { entry: cached, source } = await this.cache.get(key);

    let entry = cached;
    if (cached) {
      this.stats[`${source}Hits`]++;
      this.log.debug(`${source} hit: ${key}`);
    } else {
      this.stats.misses++;
      this.log.debug(`miss: ${key}`);
      entry = await this.fetch(key, buf);
    }

    return encodeMessage({
      version: msg.version,
      community: msg.community,
      pduType: PDU.RESPONSE,
      requestId: msg.requestId,
      ...entry
    });
  }

  // Polls the device, sharing a single upstream request between identical polls.
  fetch(key, buf) {
    if (this.inflight.has(key))
      return this.inflight.get(key);

    const pending = this.request(buf, this.upstream)
      .then((raw) => {
        const response = parseMessage(raw);

        if (response.pduType !== PDU.RESPONSE)
          throw new Error(`unexpected ${PDU_NAMES[response.pduType]} from device`);

        const entry = {
          errorStatus: response.errorStatus,
          errorIndex: response.errorIndex,
          varbinds: response.varbinds
        };

        // Not awaited: the reply should not wait for Redis. set() never rejects.
        if (CACHEABLE_ERRORS.has(entry.errorStatus))
          this.cache.set(key, entry);

        return entry;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, pending);

    return pending;
  }
}
