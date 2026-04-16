import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGraphql } = vi.hoisted(() => ({ mockGraphql: vi.fn() }))

vi.mock('../src/octokit.js', () => ({
  default: { graphql: mockGraphql },
}))

// Re-register the default config mock before each test so that vi.doMock
// overrides from one test never bleed into the next.
beforeEach(() => {
  vi.resetModules()
  mockGraphql.mockReset()
  vi.doMock('../src/config.js', () => ({
    default: {
      GITHUB_OWNER: 'test-owner',
      GITHUB_REPO: 'test-repo',
      GITHUB_PROJECT_NUMBER: 0,
    },
  }))
})

describe('loadFieldCache', () => {
  it('returns repoId and supportLabelId without project when GITHUB_PROJECT_NUMBER is 0', async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: { id: 'MDEwOlJlcG9zaXRvcnkx', label: { id: 'LA_label1' } },
    })

    const { loadFieldCache } = await import('../src/fieldCache.js')
    const result = await loadFieldCache()

    expect(result.repoId).toBe('MDEwOlJlcG9zaXRvcnkx')
    expect(result.supportLabelId).toBe('LA_label1')
    expect(result.projectId).toBeNull()
    expect(result.fields).toBeNull()
  })

  it('handles a missing "support" label gracefully', async () => {
    mockGraphql.mockResolvedValueOnce({
      repository: { id: 'repo-id', label: null },
    })

    const { loadFieldCache } = await import('../src/fieldCache.js')
    const result = await loadFieldCache()

    expect(result.supportLabelId).toBeNull()
    expect(result.repoId).toBe('repo-id')
  })

  it('fetches and normalises project fields when GITHUB_PROJECT_NUMBER is set', async () => {
    vi.resetModules()
    vi.doMock('../src/config.js', () => ({
      default: {
        GITHUB_OWNER: 'test-owner',
        GITHUB_REPO: 'test-repo',
        GITHUB_PROJECT_NUMBER: 7,
      },
    }))

    mockGraphql
      .mockResolvedValueOnce({
        repository: { id: 'repo-id', label: { id: 'label-id' } },
      })
      .mockResolvedValueOnce({
        organization: {
          projectV2: {
            id: 'PVT_project1',
            fields: {
              nodes: [
                {
                  id: 'FLD_status', name: 'Status',
                  options: [{ id: 'OPT_inbox', name: 'Inbox' }, { id: 'OPT_triaged', name: 'Triaged' }],
                },
                {
                  id: 'FLD_severity', name: 'Severity',
                  options: [{ id: 'OPT_s1', name: 'S1' }],
                },
                { id: 'FLD_reporter', name: 'Reporter' },
              ],
            },
          },
        },
      })

    const { loadFieldCache } = await import('../src/fieldCache.js')
    const result = await loadFieldCache()

    expect(result.projectId).toBe('PVT_project1')
    expect(result.fields['status'].id).toBe('FLD_status')
    expect(result.fields['status'].options['inbox']).toBe('OPT_inbox')
    expect(result.fields['status'].options['triaged']).toBe('OPT_triaged')
    expect(result.fields['severity'].options['s1']).toBe('OPT_s1')
    expect(result.fields['reporter'].id).toBe('FLD_reporter')
    expect(result.fields['reporter'].options).toBeUndefined()
  })
})

describe('ensureCache', () => {
  it('returns cached result on second call without fetching again', async () => {
    mockGraphql.mockResolvedValue({
      repository: { id: 'repo-id', label: null },
    })

    const { ensureCache } = await import('../src/fieldCache.js')

    const first = await ensureCache()
    const second = await ensureCache()

    expect(first).toBe(second)
    expect(mockGraphql).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent calls — only one GraphQL request is made', async () => {
    mockGraphql.mockResolvedValue({
      repository: { id: 'repo-id', label: null },
    })

    const { ensureCache } = await import('../src/fieldCache.js')

    const [r1, r2, r3] = await Promise.all([ensureCache(), ensureCache(), ensureCache()])

    expect(r1).toBe(r2)
    expect(r2).toBe(r3)
    expect(mockGraphql).toHaveBeenCalledTimes(1)
  })
})