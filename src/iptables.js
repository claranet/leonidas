/*
Manages the iptables rules that steer SNMP traffic into Leonidas.

All rules live in a dedicated chain (default: nat/LEONIDAS) that is jumped to
from PREROUTING, so Leonidas never touches rules it does not own:

  PREROUTING -p udp --dport 161 -j LEONIDAS
  LEONIDAS   -d <device> -p udp --dport 161 -j DNAT --to-destination <proxy>   (proxied)
  LEONIDAS   -d <device> -p udp --dport 161 -j RETURN                          (passthrough)
  LEONIDAS   -p udp --dport 161 -m limit ... -j LOG --log-prefix "LEONIDAS "   (unknown device)

Commands are run via execFile (no shell) and serialized through a queue.
 */

import { execFile } from 'node:child_process';
import net from 'node:net';
import { createLogger } from './logger.js';

const log = createLogger(`iptables`);

const SNMP = [ `-p`, `udp`, `--dport`, `161` ];

const defaultRun = (binary, args) => new Promise((resolve, reject) => {
  execFile(binary, args, (err, stdout, stderr) => {
    if (err)
      return reject(Object.assign(err, { stderr }));

    return resolve(stdout);
  });
});

const assertIPv4 = (ip) => {
  if (!net.isIPv4(ip))
    throw new Error(`not an IPv4 address: ${ip}`);
};

export class Iptables {
  constructor({ binary, table, chain, parent, logPrefix }, run = defaultRun) {
    Object.assign(this, { binary, table, chain, parent, logPrefix });
    this.run = run;
    this.queue = Promise.resolve();
  }

  exec(...args) {
    const full = [ `-w`, `-t`, this.table, ...args ];
    const job = this.queue.then(() => {
      log.debug(`${this.binary} ${full.join(` `)}`);
      return this.run(this.binary, full);
    });

    this.queue = job.catch(() => {});

    return job;
  }

  async tryExec(...args) {
    try {
      await this.exec(...args);
      return true;
    } catch {
      return false;
    }
  }

  get jump() {
    return [ this.parent, ...SNMP, `-j`, this.chain ];
  }

  // Creates (or empties) the chain, hooks it into the parent chain and adds
  // the LOG rule that lets the watcher discover new devices.
  async setup({ logging }) {
    await this.tryExec(`-N`, this.chain);
    await this.exec(`-F`, this.chain);

    if (!await this.tryExec(`-C`, ...this.jump))
      await this.exec(`-I`, ...this.jump);

    if (logging) {
      await this.exec(`-A`, this.chain, ...SNMP,
        `-m`, `limit`, `--limit`, `10/second`, `--limit-burst`, `50`,
        `-j`, `LOG`, `--log-prefix`, `${this.logPrefix} `);
    }

    log.info(`chain ${this.table}/${this.chain} ready`);
  }

  async teardown() {
    while (await this.tryExec(`-D`, ...this.jump));

    await this.tryExec(`-F`, this.chain);
    await this.tryExec(`-X`, this.chain);

    log.info(`chain ${this.table}/${this.chain} removed`);
  }

  async proxy(ip, address, port) {
    assertIPv4(ip);
    await this.remove(ip);
    await this.exec(`-I`, this.chain, `1`, `-d`, ip, ...SNMP, `-j`, `DNAT`, `--to-destination`, `${address}:${port}`);
  }

  async passthrough(ip) {
    assertIPv4(ip);
    await this.remove(ip);
    await this.exec(`-I`, this.chain, `1`, `-d`, ip, ...SNMP, `-j`, `RETURN`);
  }

  async remove(ip) {
    assertIPv4(ip);

    const rules = (await this.exec(`-S`, this.chain))
      .split(`\n`)
      .filter((line) => line.startsWith(`-A `) && line.includes(` -d ${ip}/32 `));

    for (const rule of rules)
      await this.exec(`-D`, ...rule.trim().split(/\s+/).slice(1));
  }
}
