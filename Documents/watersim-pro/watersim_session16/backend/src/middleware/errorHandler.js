const logger = require('../utils/logger');

/**
 * Central error handling middleware.
 * Must have 4 arguments to be recognised as error middleware by Express.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // Default to 500 unless the error carries a status
  const status = err.status || err.statusCode || 500;
  const isOperational = err.isOperational || status < 500;

  // Log all errors; only include stack trace for server errors in development
  logger.error('Request error', {
    status,
    message: err.message,
    path: req.path,
    method: req.method,
    ...(process.env.NODE_ENV !== 'production' && !isOperational && { stack: err.stack }),
  });

  // Never leak internal details in production for 5xx errors
  const message =
    status >= 500 && process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message;

  res.status(status).json({
    success: false,
    error: {
      message,
      ...(err.code && { code: err.code }),
    },
  });
};

/**
 * 404 handler — must be registered after all routes.
 */
const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    error: { message: `Route not found: ${req.method} ${req.path}` },
  });
};

/**
 * Convenience factory for operational errors (4xx).
 */
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { errorHandler, notFound, AppError };
