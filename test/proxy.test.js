import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PollCache } from '../src/cache.js';
import { DeviceProxy, makeKey } from '../src/proxy.js';
import { parseMessage, PDU } from '../src/snmp/message.js';
import { readTlv, TAG } from '../src/snmp/ber.js';
import { startAgent, query, request, FakeRedis } from './helpers.js';

// Returns the decoded string values of a response's varbinds.
const values = (buf) => {
  const { varbinds } = parseMessage(buf);
  const out = [];

  for (let pos = 0; pos < varbinds.length;) {
    const vb = readTlv(varbinds, pos, TAG.SEQUENCE);
    const oid = readTlv(varbinds, vb.valueStart, TAG.OID);
    out.push(readTlv(varbinds, oid.end).value.toString());
    pos = vb.end;
  }

  return out;
};

describe(`DeviceProxy`, () => {
  let agent, redis, proxy;

  const setup = async (agentOptions, cacheOptions = {}) => {
    agent = await startAgent(agentOptions);
    redis = new FakeRedis();
    proxy = new DeviceProxy({
      ip: `127.0.0.1`,
      address: `127.0.0.1`,
      prefix: `test`,
      cache: new PollCache({ redis, memoryTtlSec: 30, redisTtlSec: 300, maxEntries: 100, ...cacheOptions }),
      upstream: { port: agent.port, timeoutMs: 100, retries: 1 }
    });
    await proxy.start();
  };

  afterEach(async () => {
    await proxy?.stop();
    await agent?.close();
  });

  describe(`with a responding agent`, () => {
    beforeEach(() => setup());

    it(`polls the device on a miss and answers from cache afterwards`, async () => {
      const first = parseMessage(await query(proxy.port, request({ requestId: 1, oids: [ `1.3.6.1.2.1.1.1.0` ] })));
      const second = parseMessage(await query(proxy.port, request({ requestId: 2, oids: [ `1.3.6.1.2.1.1.1.0` ] })));

      assert.equal(agent.requests, 1);
      assert.equal(first.pduType, PDU.RESPONSE);
      assert.equal(first.requestId, 1);
      assert.equal(second.requestId, 2);
      assert.deepEqual(second.varbinds, first.varbinds);
      assert.deepEqual(proxy.stats, { polls: 2, memoryHits: 1, redisHits: 0, misses: 1, relayed: 0, timeouts: 0, errors: 0 });
    });

    it(`stores responses in redis with the configured TTL`, async () => {
      await query(proxy.port, request({ oids: [ `1.3.6.1.2.1.1.5.0` ] }));

      const key = makeKey(`test`, `127.0.0.1`, parseMessage(request({ oids: [ `1.3.6.1.2.1.1.5.0` ] })));
      assert.ok(redis.data.has(key));
      assert.equal(redis.ttl.get(key), 300);
      assert.ok(!key.includes(`public`), `community must not appear in the key`);
    });

    it(`answers from redis when the memory cache is empty`, async () => {
      await query(proxy.port, request({ oids: [ `1.3.6.1.2.1.1.5.0` ] }));
      proxy.cache.memory.clear();
      await query(proxy.port, request({ oids: [ `1.3.6.1.2.1.1.5.0` ] }));

      assert.equal(agent.requests, 1);
      assert.equal(proxy.stats.redisHits, 1);
    });

    it(`handles GETBULK with all repetitions`, async () => {
      const reply = await query(proxy.port, request({ pduType: PDU.GET_BULK, errorStatus: 0, errorIndex: 5, oids: [ `1.3.6.1.2.1.2.2.1.2` ] }));

      assert.equal(values(reply).length, 5);
      assert.equal(values(reply)[4], `1.3.6.1.2.1.2.2.1.2.5#1`);
    });

    it(`keeps separate cache entries per community, PDU type and bulk size`, async () => {
      const oids = [ `1.3.6.1.2.1.1.1.0` ];

      await query(proxy.port, request({ oids }));
      await query(proxy.port, request({ oids, community: `private` }));
      await query(proxy.port, request({ oids, pduType: PDU.GET_NEXT }));
      await query(proxy.port, request({ oids, pduType: PDU.GET_BULK, errorIndex: 10 }));
      await query(proxy.port, request({ oids, pduType: PDU.GET_BULK, errorIndex: 20 }));

      assert.equal(agent.requests, 5);
    });

    it(`shares one upstream request between concurrent identical polls`, async () => {
      const replies = await Promise.all([ 1, 2, 3 ].map((requestId) =>
        query(proxy.port, request({ requestId, oids: [ `1.3.6.1.2.1.1.3.0` ] }))));

      assert.equal(agent.requests, 1);
      assert.deepEqual(replies.map((r) => parseMessage(r).requestId), [ 1, 2, 3 ]);
    });

    it(`relays SET requests without caching`, async () => {
      await query(proxy.port, request({ pduType: PDU.SET, oids: [ `1.3.6.1.2.1.1.5.0` ] }));
      await query(proxy.port, request({ pduType: PDU.SET, oids: [ `1.3.6.1.2.1.1.5.0` ] }));

      assert.equal(agent.requests, 2);
      assert.equal(proxy.stats.relayed, 2);
      assert.equal(redis.data.size, 0);
    });

    it(`relays SNMPv3 messages unchanged`, async () => {
      const v3 = Buffer.from(`300e020103300902020001020205dc0400`, `hex`);
      const reply = await query(proxy.port, v3);

      assert.deepEqual(reply, v3);
      assert.deepEqual(agent.received[0], v3);
    });

    it(`keeps working when redis fails`, async () => {
      redis.failing = true;

      const reply = await query(proxy.port, request({ oids: [ `1.3.6.1.2.1.1.1.0` ] }));

      assert.equal(parseMessage(reply).pduType, PDU.RESPONSE);
      assert.equal(proxy.stats.errors, 0);
    });

    it(`ignores garbage`, async () => {
      assert.equal(await query(proxy.port, Buffer.from(`hello`), 200), null);
      assert.equal(proxy.stats.errors, 1);
    });
  });

  describe(`with a silent agent`, () => {
    beforeEach(() => setup({ silent: true }));

    it(`retries, then gives up without replying`, async () => {
      const reply = await query(proxy.port, request({ oids: [ `1.3.6.1.2.1.1.1.0` ] }), 400);

      assert.equal(reply, null);
      assert.equal(agent.requests, 2);
      assert.equal(proxy.stats.timeouts, 1);
    });
  });
});
