const { createLogger, format, transports } = require('winston');
const config = require('../config');
const { combine, timestamp, errors, json, colorize, printf } = format;

const devFormat = combine(
  colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }),
  printf(({ level, message, timestamp, stack }) => `${timestamp} ${level}: ${stack || message}`)
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
