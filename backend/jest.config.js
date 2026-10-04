/** Jest configuration for the LeadForge AI backend. */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 60000,
  collectCoverageFrom: ['src/**/*.js', '!src/scripts/**'],
  clearMocks: true,
  verbose: false,
};
