'use strict';
// Starts the server: validates config, checks the database, listens, and shuts down
// cleanly. Run with `npm run dev` (auto-restart) or `npm start`.
let config;
try {
  config = require('./config/env');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const app = require('./app');
const { sequelize } = require('./models');
const { closeSessionStore } = require('./config/session');
const logger = require('./utils/logger');

const SHUTDOWN_TIMEOUT_MS = 10000;

async function start() {
  try {
    await sequelize.authenticate();
  } catch (err) {
    logger.fatal(
      { err },
      'Cannot connect to the database. Check your .env settings and that PostgreSQL is running.'
    );
    process.exit(1);
  }

  // Express 5 also calls a listen() callback when startup fails, so log on the real
  // 'listening' event instead.
  const server = app.listen(config.port);
  server.on('listening', () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'Cub Critics API listening');
  });

  server.on('error', (err) => {
    logger.fatal(
      { err },
      err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use` : 'Server error'
    );
    process.exit(1);
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Last resort so a stuck connection cannot keep the process alive forever.
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close(async () => {
      try {
        await closeSessionStore();
        await sequelize.close();
      } catch (err) {
        logger.error({ err }, 'Error closing database connections');
      }
      process.exit(0);
    });
    server.closeIdleConnections();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

start();
