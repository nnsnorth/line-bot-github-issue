import config from './config.js'

const METADATA_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'

// Fields used to compute average classification confidence (issue_type, category, severity).
// Tenant and product are resolved via a separate flow (exact match → classify → user selection)
// and are NOT included in this average.
const CONFIDENCE_FIELDS = [
  'issue_type_confidence',
  'category_confidence',
  'severity_confidence',
]

async function getIdToken(audience) {
  try {
    const url = `${METADATA_URL}?audience=${audience}`
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } })
    if (res.ok) return res.text()
  } catch {
    // Not running on GCP (local dev) — skip auth
  }
  return null
}

export async function classify(messageText) {
  const { CLASSIFIER_URL } = config
  const headers = { 'Content-Type': 'application/json' }

  const idToken = await getIdToken(CLASSIFIER_URL)
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`
  }

  const response = await fetch(`${CLASSIFIER_URL}/classify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: messageText }),
  })

  if (!response.ok) {
    throw new Error(`Classifier service error: ${response.status}`)
  }

  return response.json()
}

export function avgConfidence(classification) {
  const scores = CONFIDENCE_FIELDS.map((field) => classification[field] ?? 0)
  return scores.reduce((sum, v) => sum + v, 0) / scores.length
}

/**
 * A ticket is considered confident enough to be moved to "triaged" when:
 *   1. Tenant is resolved — unless no tenants are configured in the env.
 *   2. Product is resolved.
 *   3. The average confidence across issue_type, category, and severity is above threshold.
 *
 * Both tenant and product are always resolved before createSupportTicket is called;
 * this check is a final safety gate that also drives the GitHub project status field.
 */
export function isConfident(classification) {
  const tenantOk = config.LINE_TENANTS.length === 0 || !!classification.tenant || !!classification.tenant_is_other
  const productOk = !!classification.product
  return tenantOk && productOk && avgConfidence(classification) >= config.CONFIDENCE_THRESHOLD
}
