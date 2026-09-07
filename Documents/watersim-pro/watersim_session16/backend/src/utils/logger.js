const { createLogger, format, transports } = require('winston');
const config = require('../config');
const { combine, timestamp, errors, json, colorize, printf } = format;

// Dev lines carry their metadata (error messages, ids) — without it a logged
// "Unhandled error" says nothing about what failed.
const devFormat = combine(
  colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    const rest = Object.fromEntries(Object.entries(meta).filter(([k]) => typeof k === 'string' && k !== 'splat'));
    const tail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `${timestamp} ${level}: ${stack || message}${tail}`;
  })
);
const prodFormat = combine(timestamp(), errors({ stack: true }), json());

const logger = createLogger({
  level: config.env === 'production' ? 'info' : 'debug',
  format: config.env === 'production' ? prodFormat : devFormat,
  transports: [new transports.Console()],
  exceptionHandlers: [new transports.Console()],
  rejectionHandlers: [new transports.Console()],
  // Process lifecycle on uncaughtException/unhandledRejection is owned by
  // server.js (drain + exit). Winston only logs — it must not exit itself.
  exitOnError: false,
});

module.exports = logger;
