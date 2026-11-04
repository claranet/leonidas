/*
Follows the kernel log and emits `ip` for every destination address that the
iptables LOG rule reports, i.e. SNMP traffic to devices not handled yet.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createLogger } from './logger.js';

const log = createLogger(`watcher`);

const RESTART_DELAY_MS = 5000;

export const parseLine = (line, prefix) => {
  if (!line.includes(`${prefix} `))
    return null;

  const match = line.match(/\bDST=(\S+)/);

  return match && net.isIPv4(match[1]) ? match[1] : null;
};

export class Watcher extends EventEmitter {
  constructor({ file, prefix }) {
    super();
    this.file = file;
    this.prefix = prefix;
    this.child = null;
    this.stopped = true;
  }

  start() {
    this.stopped = false;

    // `tail -F` survives log rotation and starts at the end of the file.
    this.child = spawn(`tail`, [ `-F`, `-n`, `0`, this.file ], { stdio: [ `ignore`, `pipe`, `pipe` ] });

    createInterface({ input: this.child.stdout }).on(`line`, (line) => {
      const ip = parseLine(line, this.prefix);
      if (ip)
        this.emit(`ip`, ip);
    });

    createInterface({ input: this.child.stderr }).on(`line`, (line) => log.warn(line));

    this.child.on(`error`, (err) => log.error(`tail failed: ${err.message}`));
    this.child.on(`exit`, (code) => {
      if (this.stopped)
        return;

      log.warn(`tail exited with ${code}, restarting in ${RESTART_DELAY_MS} ms`);
      setTimeout(() => !this.stopped && this.start(), RESTART_DELAY_MS);
    });

    log.info(`watching ${this.file}`);
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }
}
