import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleWebhook } from '../src/lineHandler.js'
import { createGitHubIssue, createSupportTicket } from '../src/github.js'
import { classify } from '../src/classifier.js'

// vi.hoisted ensures this value is available inside the vi.mock factory,
// which is hoisted to the top of the file before any const declarations.
const CHANNEL_SECRET = vi.hoisted(() => 'test-channel-secret')

vi.mock('../src/config.js', () => ({
  default: {
    LINE_CHANNEL_SECRET: CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    CLASSIFIER_URL: '',
    GITHUB_APP_ID: 'test-app-id',
    GITHUB_APP_INSTALLATION_ID: '12345678',
    GITHUB_OWNER: 'test-owner',
    GITHUB_REPO: 'test-repo',
    GITHUB_PROJECT_NUMBER: 0,
    CONFIDENCE_THRESHOLD: 0.70,
    FIELD_OPTIONS: {},
  },
}))

vi.mock('../src/classifier.js', () => ({
  classify: vi.fn(),
  isConfident: vi.fn().mockReturnValue(true),
}))

vi.mock('../src/github.js', () => ({
  createSupportTicket: vi.fn(),
  createGitHubIssue: vi.fn(),
}))

function makeSignature(bodyBuf) {
  return crypto.createHmac('sha256', CHANNEL_SECRET).update(bodyBuf).digest('base64')
}

function makeReq(bodyObj, overrideSignature) {
  const bodyBuf = Buffer.from(JSON.stringify(bodyObj))
  const sig = overrideSignature ?? makeSignature(bodyBuf)
  return {
    headers: { 'x-line-signature': sig },
    body: bodyBuf,
  }
}

function makeRes() {
  const res = {}
  res.status = (code) => { res._status = code; return res }
  res.json = (body) => { res._body = body; return res }
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ displayName: 'Test User' }),
    text: () => Promise.resolve(''),
  }))
  createGitHubIssue.mockResolvedValue({
    number: 42,
    url: 'https://github.com/test-owner/test-repo/issues/42',
  })
  createSupportTicket.mockResolvedValue({
    number: 99,
    url: 'https://github.com/test-owner/test-repo/issues/99',
    status: 'triaged',
  })
  classify.mockResolvedValue({
    product: 'phr', product_confidence: 0.9,
    issue_type: 'incident/bug', issue_type_confidence: 0.85,
    category: 'connectivity', category_confidence: 0.8,
    severity: 'S2', severity_confidence: 0.75,
    tenant: null, tenant_confidence: 0.0,
    summary: 'Login page crash',
  })
})

describe('handleWebhook — request validation', () => {
  it('returns 400 when X-Line-Signature header is missing', async () => {
    const req = { headers: {}, body: Buffer.from('{}') }
    const res = makeRes()
    await handleWebhook(req, res)
    expect(res._status).toBe(400)
    expect(res._body).toMatchObject({ error: 'Missing X-Line-Signature header' })
  })

  it('returns 401 when signature is invalid', async () => {
    // Same byte-length as a real HMAC-SHA256 base64, but for a different payload
    const wrongBodySig = makeSignature(Buffer.from('wrong body content'))
    const req = makeReq({ events: [] }, wrongBodySig)
    const res = makeRes()
    await handleWebhook(req, res)
    expect(res._status).toBe(401)
    expect(res._body).toMatchObject({ error: 'Invalid signature' })
  })

  it('returns 400 for malformed JSON body', async () => {
    const bodyBuf = Buffer.from('not-json')
    const sig = makeSignature(bodyBuf)
    const req = { headers: { 'x-line-signature': sig }, body: bodyBuf }
    const res = makeRes()
    await handleWebhook(req, res)
    expect(res._status).toBe(400)
    expect(res._body).toMatchObject({ error: 'Invalid JSON body' })
  })
})

describe('handleWebhook — LINE verification', () => {
  it('returns 200 for LINE webhook verification (empty events array)', async () => {
    const req = makeReq({ events: [] })
    const res = makeRes()
    await handleWebhook(req, res)
    expect(res._status).toBe(200)
    expect(res._body).toMatchObject({ status: 'ok' })
  })
})

describe('handleWebhook — @support message', () => {
  it('creates a GitHub issue when @support message is received (no classifier)', async () => {
    const req = makeReq({
      events: [{
        type: 'message',
        replyToken: 'reply-token-1',
        source: { userId: 'user-001' },
        message: { type: 'text', text: '@support login page is broken' },
      }],
    })
    const res = makeRes()
    await handleWebhook(req, res)

    expect(res._status).toBe(200)
    expect(createGitHubIssue).toHaveBeenCalledWith(
      'login page is broken',
      'login page is broken'
    )
  })

  it('truncates long descriptions to 80 chars in issue title', async () => {
    const longDesc = 'a'.repeat(100)
    const req = makeReq({
      events: [{
        type: 'message',
        replyToken: 'reply-token-2',
        source: { userId: 'user-001' },
        message: { type: 'text', text: `@support ${longDesc}` },
      }],
    })
    const res = makeRes()
    await handleWebhook(req, res)

    const [title] = createGitHubIssue.mock.calls[0]
    expect(title).toHaveLength(80)
    expect(title.endsWith('...')).toBe(true)
  })
})

describe('handleWebhook — other event types', () => {
  it('returns 200 and does not create an issue for a non-@support text message', async () => {
    const req = makeReq({
      events: [{
        type: 'message',
        replyToken: 'reply-token-3',
        source: { userId: 'user-001' },
        message: { type: 'text', text: 'hello there' },
      }],
    })
    const res = makeRes()
    await handleWebhook(req, res)

    expect(res._status).toBe(200)
    expect(createGitHubIssue).not.toHaveBeenCalled()
    expect(createSupportTicket).not.toHaveBeenCalled()
  })

  it('returns 200 for a follow event', async () => {
    const req = makeReq({
      events: [{
        type: 'follow',
        replyToken: 'reply-token-4',
        source: { userId: 'user-002' },
      }],
    })
    const res = makeRes()
    await handleWebhook(req, res)
    expect(res._status).toBe(200)
  })

  it('returns 200 for an unfollow event', async () => {
    const req = makeReq({
      events: [{
        type: 'unfollow',
        source: { userId: 'user-003' },
      }],
    })
    const res = makeRes()
    await handleWebhook(req, res)
    expect(res._status).toBe(200)
  })
})
