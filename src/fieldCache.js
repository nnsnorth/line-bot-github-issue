import config from './config.js'
import octokit from './octokit.js'

let cache = null
let loading = null

export async function loadFieldCache() {
  // Always fetch repository metadata (needed for GraphQL issue creation)
  const { repository } = await octokit.graphql(`
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
        label(name: "support") { id }
      }
    }`, {
    owner: config.GITHUB_OWNER,
    name: config.GITHUB_REPO,
  })

  const repoId = repository.id
  const supportLabelId = repository.label?.id ?? null

  if (!supportLabelId) {
    console.warn('Label "support" not found in repository — issues will be created without label')
  }

  if (!config.GITHUB_PROJECT_NUMBER) {
    console.log('GITHUB_PROJECT_NUMBER not set — skipping project field cache')
    cache = { repoId, supportLabelId, projectId: null, fields: null }
    return cache
  }

  const { organization } = await octokit.graphql(`
    query($org: String!, $num: Int!) {
      organization(login: $org) {
        projectV2(number: $num) {
          id
          fields(first: 40) {
            nodes {
              ... on ProjectV2Field {
                id name
              }
              ... on ProjectV2SingleSelectField {
                id name
                options { id name }
              }
            }
          }
        }
      }
    }`, {
    org: config.GITHUB_OWNER,
    num: config.GITHUB_PROJECT_NUMBER,
  })

  const project = organization.projectV2
  const fields = {}

  for (const node of project.fields.nodes) {
    if (!node.name) continue
    const key = node.name.toLowerCase().replace(/\s+/g, '_')
    fields[key] = { id: node.id }

    if (node.options) {
      fields[key].options = {}
      for (const opt of node.options) {
        fields[key].options[opt.name.toLowerCase()] = opt.id
      }
    }
  }

  cache = { repoId, supportLabelId, projectId: project.id, fields }
  console.log('Field cache loaded:', Object.keys(fields))
  return cache
}

export async function ensureCache() {
  if (cache) return cache
  if (!loading) {
    loading = loadFieldCache().finally(() => { loading = null })
  }
  return loading
}

