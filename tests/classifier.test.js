import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { classify, isConfident } from '../src/classifier.js'

vi.mock('../src/config.js', () => ({
  default: {
    CLASSIFIER_URL: 'https://test-classifier.example.com',
    CONFIDENCE_THRESHOLD: 0.70,
    LINE_TENANTS: ['Hospital A'],
  },
}))

describe('isConfident', () => {
  it('returns true when average confidence is above threshold', () => {
    expect(isConfident({
      product: 'phr',
      tenant: 'Hospital A',
      issue_type_confidence: 0.85,
      category_confidence: 0.80,
      severity_confidence: 0.75,
    })).toBe(true)
  })

  it('returns false when average confidence is below threshold', () => {
    expect(isConfident({
      product: 'phr',
      tenant: 'Hospital A',
      issue_type_confidence: 0.4,
      category_confidence: 0.3,
      severity_confidence: 0.4,
    })).toBe(false)
  })

  it('returns true when average confidence equals threshold exactly', () => {
    expect(isConfident({
      product: 'phr',
      tenant: 'Hospital A',
      issue_type_confidence: 0.80,
      category_confidence: 0.80,
      severity_confidence: 0.80,
    })).toBe(true)
  })

  it('treats null/undefined confidence values as 0', () => {
    // product and tenant are resolved, but classifier fields are missing/null
    expect(isConfident({
      product: 'phr',
      tenant: 'Hospital A',
      issue_type_confidence: undefined,
      category_confidence: null,
      severity_confidence: null,
    })).toBe(false)
  })
})

describe('classify', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts message to the classifier endpoint', async () => {
    const mockResult = {
      product: 'phr',
      product_confidence: 0.9,
      issue_type: 'incident/bug',
      issue_type_confidence: 0.85,
    }
    fetch.mockImplementation(async (url) => {
      if (url.includes('metadata.google.internal')) throw new Error('not on GCP')
      return { ok: true, json: () => Promise.resolve(mockResult) }
    })

    const result = await classify('login page crash')

    const classifyCall = fetch.mock.calls.find(([url]) =>
      url === 'https://test-classifier.example.com/classify'
    )
    expect(classifyCall).toBeDefined()
    expect(classifyCall[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: 'login page crash' }),
    })
    expect(result).toEqual(mockResult)
  })

  it('includes Authorization header when GCP ID token is available', async () => {
    fetch.mockImplementation(async (url) => {
      if (url.includes('metadata.google.internal')) {
        return { ok: true, text: () => Promise.resolve('gcp-id-token') }
      }
      return { ok: true, json: () => Promise.resolve({}) }
    })

    await classify('test')

    const classifyCall = fetch.mock.calls.find(([url]) =>
      url === 'https://test-classifier.example.com/classify'
    )
    expect(classifyCall[1].headers['Authorization']).toBe('Bearer gcp-id-token')
  })

  it('throws when the classifier service returns a non-ok response', async () => {
    fetch.mockImplementation(async (url) => {
      if (url.includes('metadata.google.internal')) throw new Error('not on GCP')
      return { ok: false, status: 503 }
    })

    await expect(classify('test')).rejects.toThrow('Classifier service error: 503')
  })
})
