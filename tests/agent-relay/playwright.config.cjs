module.exports = { testDir: __dirname, testMatch: 'agent-relay.e2e.cjs', reporter: 'list',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }] };
