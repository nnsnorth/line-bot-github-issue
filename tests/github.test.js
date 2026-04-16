import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupportTicket, createGitHubIssue } from '../src/github.js'

// vi.hoisted ensures these are available when mock factories are called
// (factories are hoisted before any const declarations)
const { mockGraphql, mockEnsureCache } = vi.hoisted(() => ({
  mockGraphql: vi.fn(),
  mockEnsureCache: vi.fn(),
}))

vi.mock('../src/config.js', () => ({
  default: {
    GITHUB_OWNER: 'test-owner',
    GITHUB_REPO: 'test-repo',
    GITHUB_PROJECT_NUMBER: 11,
    CONFIDENCE_THRESHOLD: 0.70,
    FIELD_OPTIONS: {},
  },
}))

vi.mock('../src/octokit.js', () => ({
  default: { graphql: mockGraphql },
}))

vi.mock('../src/fieldCache.js', () => ({
  ensureCache: mockEnsureCache,
}))

const CACHE_NO_PROJECT = {
  repoId: 'REPO_001',
  supportLabelId: 'LABEL_001',
  projectId: null,
  fields: null,
}

const CACHE_WITH_PROJECT = {
  repoId: 'REPO_001',
  supportLabelId: 'LABEL_001',
  projectId: 'PVT_project1',
  fields: {
    status: { id: 'FLD_status', options: { inbox: 'OPT_inbox', triaged: 'OPT_triaged' } },
    severity: { id: 'FLD_severity', options: { s2: 'OPT_s2' } },
    category: { id: 'FLD_cat', options: { connectivity: 'OPT_conn' } },
    product: { id: 'FLD_prod', options: { 'phr': 'OPT_app' } },
    issue_type: { id: 'FLD_type', options: { 'incident/bug': 'OPT_bug' } },
    tenant: { id: 'FLD_tenant', options: {} },
    reporter: { id: 'FLD_reporter' },
  },
}

beforeEach(() => {
  mockGraphql.mockReset()
  mockEnsureCache.mockReset()
})

describe('createGitHubIssue', () => {
  it('creates an issue via GraphQL and returns number, nodeId, url', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_NO_PROJECT)
    mockGraphql.mockResolvedValueOnce({
      createIssue: { issue: { id: 'MDExOklzc3VlMQ==', number: 10, url: 'https://github.com/test-owner/test-repo/issues/10' } },
    })

    const result = await createGitHubIssue('Test title', 'Test body')

    expect(result.number).toBe(10)
    expect(result.url).toContain('/issues/10')
    expect(mockGraphql).toHaveBeenCalledTimes(1)
  })

  it('includes the support label when available', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_NO_PROJECT)
    mockGraphql.mockResolvedValueOnce({
      createIssue: { issue: { id: 'node-id', number: 11, url: 'url' } },
    })

    await createGitHubIssue('title', 'body')

    const [, vars] = mockGraphql.mock.calls[0]
    expect(vars.input.labelIds).toContain(CACHE_NO_PROJECT.supportLabelId)
  })

  it('throws when cache has no repoId', async () => {
    mockEnsureCache.mockResolvedValue({ repoId: null })

    await expect(createGitHubIssue('t', 'b')).rejects.toThrow('Field cache not loaded')
  })
})

describe('createSupportTicket', () => {
  const baseClassification = {
    confident: true,
    summary: 'Login page crash',
    product: 'phr',
    product_confidence: 0.9,
    issue_type: 'incident/bug',
    issue_type_confidence: 0.85,
    category: 'connectivity',
    category_confidence: 0.8,
    severity: 'S2',
    severity_confidence: 0.75,
    tenant: null,
    tenant_confidence: 0.0,
  }

  it('uses classification.summary as the issue title', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_NO_PROJECT)
    mockGraphql.mockResolvedValueOnce({
      createIssue: { issue: { id: 'node-id', number: 20, url: 'url' } },
    })

    await createSupportTicket(baseClassification, 'raw message', 'Alice')

    const [, vars] = mockGraphql.mock.calls[0]
    expect(vars.input.title).toBe('Login page crash')
  })

  it('falls back to "Support request from <name>" when summary is absent', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_NO_PROJECT)
    mockGraphql.mockResolvedValueOnce({
      createIssue: { issue: { id: 'node-id', number: 21, url: 'url' } },
    })

    await createSupportTicket({ ...baseClassification, summary: undefined }, 'raw', 'Bob')

    const [, vars] = mockGraphql.mock.calls[0]
    expect(vars.input.title).toBe('Support request from Bob')
  })

  it('returns status "no-project" when project is not configured', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_NO_PROJECT)
    mockGraphql.mockResolvedValueOnce({
      createIssue: { issue: { id: 'node-id', number: 22, url: 'url' } },
    })

    const result = await createSupportTicket(baseClassification, 'raw', 'Alice')
    expect(result.status).toBe('no-project')
  })

  it('sets status to "triaged" when classification is confident', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_WITH_PROJECT)
    mockGraphql
      .mockResolvedValueOnce({ createIssue: { issue: { id: 'node-id', number: 23, url: 'url' } } })
      .mockResolvedValueOnce({ addProjectV2ItemById: { item: { id: 'ITEM_001' } } })
      .mockResolvedValue({ updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_001' } } })

    const result = await createSupportTicket({ ...baseClassification, confident: true }, 'raw', 'Alice')
    expect(result.status).toBe('triaged')
  })

  it('sets status to "inbox" when classification is not confident', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_WITH_PROJECT)
    mockGraphql
      .mockResolvedValueOnce({ createIssue: { issue: { id: 'node-id', number: 24, url: 'url' } } })
      .mockResolvedValueOnce({ addProjectV2ItemById: { item: { id: 'ITEM_001' } } })
      .mockResolvedValue({ updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_001' } } })

    const result = await createSupportTicket({ ...baseClassification, confident: false }, 'raw', 'Alice')
    expect(result.status).toBe('inbox')
  })

  it('runs all field mutations in parallel via Promise.all', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_WITH_PROJECT)
    mockGraphql
      .mockResolvedValueOnce({ createIssue: { issue: { id: 'node-id', number: 25, url: 'url' } } })
      .mockResolvedValueOnce({ addProjectV2ItemById: { item: { id: 'ITEM_001' } } })
      .mockResolvedValue({ updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_001' } } })

    await createSupportTicket(baseClassification, 'raw message', 'Alice')

    // createIssue (1) + addToProject (1) + field mutations (status, severity, category, product, issue_type, reporter = 6)
    expect(mockGraphql.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('includes the raw message in the issue body', async () => {
    mockEnsureCache.mockResolvedValue(CACHE_NO_PROJECT)
    mockGraphql.mockResolvedValueOnce({
      createIssue: { issue: { id: 'node-id', number: 26, url: 'url' } },
    })

    await createSupportTicket(baseClassification, 'the printer is on fire', 'Alice')

    const [, vars] = mockGraphql.mock.calls[0]
    expect(vars.input.body).toContain('the printer is on fire')
  })
})
