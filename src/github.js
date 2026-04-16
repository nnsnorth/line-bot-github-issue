import octokit from './octokit.js'
import { ensureCache } from './fieldCache.js'
import { avgConfidence } from './classifier.js'

const WORKING_DAYS_BY_SEVERITY = { s1: null, s2: 2, s3: 5 }
const S1_HOURS = 8

function addWorkingDays(date, days) {
  const result = new Date(date)
  let added = 0
  while (added < days) {
    result.setDate(result.getDate() + 1)
    const dow = result.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return result
}

/**
 * Calculate the Resolution SLA deadline based on severity.
 *   S1 — 8 hours, S2 — 2 working days, S3 — 5 working days, S4 — no fixed date
 */
function calculateResolutionSLA(severity) {
  if (!severity) return null

  const key = severity.toLowerCase()
  if (key === 's1') {
    return new Date(Date.now() + S1_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10)
  }

  const days = WORKING_DAYS_BY_SEVERITY[key]
  if (!days) return null

  return addWorkingDays(new Date(), days).toISOString().slice(0, 10)
}

async function createIssue(title, body, repoId, labelId) {
  const input = { repositoryId: repoId, title, body }
  if (labelId) {
    input.labelIds = [labelId]
  }
  const { createIssue: result } = await octokit.graphql(`
    mutation($input: CreateIssueInput!) {
      createIssue(input: $input) {
        issue { id number url }
      }
    }`, { input })

  return { number: result.issue.number, nodeId: result.issue.id, url: result.issue.url }
}

async function addToProject(issueNodeId, projectId) {
  const { addProjectV2ItemById } = await octokit.graphql(`
    mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project contentId: $content }) {
        item { id }
      }
    }`, { project: projectId, content: issueNodeId })
  return addProjectV2ItemById.item.id
}

async function setField(projectId, itemId, fieldId, value) {
  await octokit.graphql(`
    mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $project itemId: $item fieldId: $field value: $value
      }) { projectV2Item { id } }
    }`, { project: projectId, item: itemId, field: fieldId, value })
}

function buildFieldMutations(projectId, itemId, fields, classification, lineDisplayName) {
  const mutations = []

  const selectFields = [
    { field: 'status', value: classification.confident ? 'triaged' : 'inbox' },
    { field: 'severity', value: classification.severity },
    { field: 'category', value: classification.category },
    { field: 'product', value: classification.product },
    { field: 'issue_type', value: classification.issue_type },
    { field: 'tenant', value: classification.tenant },
  ]

  for (const { field, value } of selectFields) {
    const optionId = fields[field]?.options?.[value?.toLowerCase()]
    if (optionId) {
      mutations.push(setField(projectId, itemId, fields[field].id,
        { singleSelectOptionId: optionId }))
    }
  }

  if (lineDisplayName && fields['reporter']) {
    mutations.push(setField(projectId, itemId, fields['reporter'].id,
      { text: lineDisplayName }))
  }

  const slaDate = calculateResolutionSLA(classification.severity)
  if (slaDate && fields['resolution_sla']) {
    mutations.push(setField(projectId, itemId, fields['resolution_sla'].id,
      { date: slaDate }))
  }

  return mutations
}

function formatConfidence(value) {
  return value != null ? ` (${(value * 100).toFixed(0)}%)` : ''
}

function buildIssueBody(classification, rawMessage, lineDisplayName) {
  return [
    `**Reporter:** ${lineDisplayName}`,
    `**Tenant:** ${classification.tenant ?? 'unknown'}`,
    `**Product:** ${classification.product}`,
    '',
    // Confidence scores are shown only for classifier-derived fields.
    // Tenant and product are always resolved (exact match / user selection / group map)
    // before the ticket is created, so their confidence is not meaningful here.
    `**Issue Type:** ${classification.issue_type}${formatConfidence(classification.issue_type_confidence)}`,
    `**Category:** ${classification.category ?? 'unclassified'}${formatConfidence(classification.category_confidence)}`,
    `**Severity:** ${classification.severity ?? 'unclassified'}${formatConfidence(classification.severity_confidence)}`,
    `**Avg Classification Confidence:** ${(avgConfidence(classification) * 100).toFixed(0)}%`,
    '',
    `**Original message:**`,
    `> ${rawMessage}`,
    '',
    '---',
    '*Created automatically via LINE @support*',
    '*Issue type, category, and severity are auto-classified — verify before acting.*',
  ].filter(Boolean).join('\n')
}

export async function createSupportTicket(classification, rawMessage, lineDisplayName) {
  const title = classification.summary || `Support request from ${lineDisplayName}`
  const body = buildIssueBody(classification, rawMessage, lineDisplayName)

  const cache = await ensureCache()
  if (!cache?.repoId) {
    throw new Error('Field cache not loaded — cannot create issue via GraphQL')
  }

  const { number, nodeId, url } = await createIssue(title, body, cache.repoId, cache.supportLabelId)

  const { projectId, fields } = cache
  if (!projectId) {
    return { number, url, status: 'no-project' }
  }

  const itemId = await addToProject(nodeId, projectId)
  const statusName = classification.confident ? 'triaged' : 'inbox'

  const mutations = buildFieldMutations(projectId, itemId, fields, classification, lineDisplayName)
  await Promise.all(mutations)

  return { number, url, itemId, status: statusName }
}

export async function createGitHubIssue(title, body) {
  const cache = await ensureCache()
  if (!cache?.repoId) {
    throw new Error('Field cache not loaded — cannot create issue via GraphQL')
  }
  return createIssue(title, body, cache.repoId, cache.supportLabelId)
}
