// Set required environment variables before any module loads.
// Tests that need different values should use vi.stubEnv() or vi.mock().
process.env.GITHUB_APP_ID = 'test-app-id'
process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\ndGVzdA==\n-----END RSA PRIVATE KEY-----'
process.env.GITHUB_APP_INSTALLATION_ID = '12345678'
process.env.GITHUB_OWNER = 'test-owner'
process.env.GITHUB_REPO = 'test-repo'
process.env.LINE_CHANNEL_SECRET = 'test-channel-secret'
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-access-token'
