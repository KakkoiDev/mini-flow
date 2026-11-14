module.exports = {
  testDir: './tests',
  webServer: {
    command: 'node tools/serve.mjs 8765',
    url: 'http://127.0.0.1:8765/'
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } }]
};
