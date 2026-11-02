'use strict';
// Two kinds of tests:
//  - unit:        no database needed (fast)
//  - integration: real PostgreSQL, using a separate "_test" database (see README)
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
      clearMocks: true,
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
      globalSetup: '<rootDir>/tests/integration/globalSetup.js',
      setupFiles: ['<rootDir>/tests/integration/setupEnv.js'],
      testTimeout: 30000,
      clearMocks: true,
    },
  ],
};
