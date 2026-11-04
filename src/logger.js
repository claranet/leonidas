/*
Tiny leveled logger writing single lines to stdout/stderr, suitable for
containers and journald. Timestamps are ISO 8601 (UTC, 24h).
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold = LEVELS.info;

export const setLevel = (level) => {
  if (!(level in LEVELS))
    throw new Error(`unknown log level: ${level}`);

  threshold = LEVELS[level];
};

export const createLogger = (scope) => {
  const write = (level) => (...args) => {
    if (LEVELS[level] > threshold)
      return;

    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${args.map(format).join(` `)}`;

    (LEVELS[level] <= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };

  return {
    error: write(`error`),
    warn: write(`warn`),
    info: write(`info`),
    debug: write(`debug`),
    isDebug: () => threshold >= LEVELS.debug
  };
};

const format = (arg) => {
  if (arg instanceof Error)
    return arg.stack || arg.message;

  if (typeof arg === `object`)
    return JSON.stringify(arg);

  return String(arg);
};
