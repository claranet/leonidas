import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Iptables } from '../src/iptables.js';
import { parseLine } from '../src/watcher.js';

const options = { binary: `iptables`, table: `nat`, chain: `LEONIDAS`, parent: `PREROUTING`, logPrefix: `LEONIDAS` };

// Records commands; `-S` returns `rules`, `-C` fails unless `jumpExists`.
const recorder = ({ rules = ``, jumpExists = false } = {}) => {
  const calls = [];
  const run = async (binary, args) => {
    calls.push(args.slice(3).join(` `));

    if (args.includes(`-S`))
      return rules;

    if (args.includes(`-C`) && !jumpExists)
      throw new Error(`no such rule`);

    return ``;
  };

  return { calls, run };
};

describe(`Iptables`, () => {
  it(`sets up its own chain without touching other rules`, async () => {
    const { calls, run } = recorder();
    await new Iptables(options, run).setup({ logging: true });

    assert.deepEqual(calls, [
      `-N LEONIDAS`,
      `-F LEONIDAS`,
      `-C PREROUTING -p udp --dport 161 -j LEONIDAS`,
      `-I PREROUTING -p udp --dport 161 -j LEONIDAS`,
      `-A LEONIDAS -p udp --dport 161 -m limit --limit 10/second --limit-burst 50 -j LOG --log-prefix LEONIDAS `
    ]);
  });

  it(`does not add the jump twice`, async () => {
    const { calls, run } = recorder({ jumpExists: true });
    await new Iptables(options, run).setup({ logging: false });

    assert.ok(!calls.some((c) => c.startsWith(`-I PREROUTING`)));
  });

  it(`replaces existing rules of a device`, async () => {
    const rules = [
      `-N LEONIDAS`,
      `-A LEONIDAS -d 10.0.0.1/32 -p udp -m udp --dport 161 -j RETURN`,
      `-A LEONIDAS -d 10.0.0.11/32 -p udp -m udp --dport 161 -j RETURN`,
      ``
    ].join(`\n`);
    const { calls, run } = recorder({ rules });

    await new Iptables(options, run).proxy(`10.0.0.1`, `192.168.0.1`, 40000);

    assert.deepEqual(calls, [
      `-S LEONIDAS`,
      `-D LEONIDAS -d 10.0.0.1/32 -p udp -m udp --dport 161 -j RETURN`,
      `-I LEONIDAS 1 -d 10.0.0.1 -p udp --dport 161 -j DNAT --to-destination 192.168.0.1:40000`
    ]);
  });

  it(`refuses anything that is not an IPv4 address`, async () => {
    const { calls, run } = recorder();

    await assert.rejects(new Iptables(options, run).passthrough(`1.2.3.4; rm -rf /`));
    assert.equal(calls.length, 0);
  });
});

describe(`watcher`, () => {
  const line = `Nov  4 13:37:00 router kernel: [123.456] LEONIDAS IN=eth1 OUT=eth2 SRC=192.168.10.2 DST=192.168.20.2 LEN=72 PROTO=UDP SPT=40000 DPT=161`;

  it(`extracts the destination address`, () => {
    assert.equal(parseLine(line, `LEONIDAS`), `192.168.20.2`);
  });

  it(`ignores lines without the prefix or with invalid addresses`, () => {
    assert.equal(parseLine(line.replace(`LEONIDAS `, `OTHER `), `LEONIDAS`), null);
    assert.equal(parseLine(line.replace(`DST=192.168.20.2`, `DST=999.1.1.1`), `LEONIDAS`), null);
  });
});
