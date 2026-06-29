module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.ts'],
  setupFiles: ['./jest.setup.js'],
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'CommonJS', moduleResolution: 'node' } }],
  },
};
