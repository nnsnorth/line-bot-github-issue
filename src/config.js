import 'dotenv/config'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function decodePrivateKey(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith('-----')) {
    return trimmed.replace(/\\n/g, '\n')
  }
  const decoded = Buffer.from(trimmed, 'base64').toString('utf-8')
  if (!decoded.includes('-----BEGIN')) {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not a valid PEM or base64-encoded PEM.')
  }
  return decoded
}

const config = Object.freeze({
  LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET || '',
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',

  GITHUB_APP_ID: requireEnv('GITHUB_APP_ID'),
  GITHUB_APP_PRIVATE_KEY: decodePrivateKey(requireEnv('GITHUB_APP_PRIVATE_KEY')),
  GITHUB_INSTALLATION_ID: requireEnv('GITHUB_APP_INSTALLATION_ID'),

  GITHUB_OWNER: requireEnv('GITHUB_OWNER'),
  GITHUB_REPO: requireEnv('GITHUB_REPO'),
  GITHUB_PROJECT_NUMBER: parseInt(process.env.GITHUB_PROJECT_NUMBER || '0', 10),

  CLASSIFIER_URL: process.env.CLASSIFIER_URL || '',
  CONFIDENCE_THRESHOLD: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.70'),

  // Reverse lookup: groupId → tenant, built from LINE_GROUP_TENANT_MAP env var.
  // Env var format: {"tenantName": ["groupId1", "groupId2"], ...}
  LINE_GROUP_TENANT_MAP: (() => {
    const raw = JSON.parse(process.env.LINE_GROUP_TENANT_MAP || '{}')
    const map = {}
    for (const [tenant, groups] of Object.entries(raw)) {
      const ids = Array.isArray(groups) ? groups : [groups]
      for (const id of ids) {
        map[id] = tenant
      }
    }
    return map
  })(),

  // Sorted list of tenant names (keys of LINE_GROUP_TENANT_MAP) used in 1-on-1 tenant prompts.
  LINE_TENANTS: (() => {
    const raw = JSON.parse(process.env.LINE_GROUP_TENANT_MAP || '{}')
    return Object.keys(raw).sort()
  })(),
})

export default config
