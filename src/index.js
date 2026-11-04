#!/usr/bin/env node

import { loadConfig } from './config.js';
import { createLogger, setLevel } from './logger.js';
import { App } from './app.js';

const log = createLogger(`main`);

const config = loadConfig();
setLevel(config.log.level);

const app = new App(config);

let stopping = false;
const shutdown = async (code) => {
  if (stopping)
    return;

  stopping = true;

  try {
    await app.stop();
  } catch (err) {
    log.error(err);
    code = 1;
  }

  process.exit(code);
};

process.on(`SIGINT`, () => shutdown(0));
process.on(`SIGTERM`, () => shutdown(0));

try {
  await app.start();
} catch (err) {
  log.error(`startup failed:`, err);
  await shutdown(1);
}
