module.exports = {
  testDir: './tests',
  // Node's own tests (*.test.mjs) and the relay check (*.e2e.cjs) run separately.
  testMatch: '*.spec.cjs',
  webServer: {
    command: 'node tools/serve.mjs 8765',
    url: 'http://127.0.0.1:8765/'
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } }]
};
