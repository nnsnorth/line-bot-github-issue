import { replyMessage } from './lineClient.js'

export const PRODUCTS = ['connect', 'phr', 'dashboard', 'other']

/** Sentinel value used when a user selects "Other" for their tenant. */
export const OTHER_TENANT_VALUE = '__other__'

/**
 * Encode action + value + carried state into a LINE postback data string.
 * All context needed to continue the flow is embedded in each button so the
 * service remains stateless across Cloud Run instances.
 *
 * Format: "<action>:<JSON payload>"
 * Payload: { v, d, t? }
 *   v  – selected value (product name or tenant)
 *   d  – original raw description (re-fed to classifier on final step)
 *   t  – resolved tenant (carried once known, so product step can use it)
 *
 * If the resulting string exceeds LINE's 300-char limit the description (d)
 * is trimmed to fit.
 */
export function buildPostbackData(action, value, stateBase) {
  const payload = { ...stateBase, v: value }
  let data = `${action}:${JSON.stringify(payload)}`
  if (data.length > 300) {
    const overhead = data.length - (payload.d?.length ?? 0)
    payload.d = (payload.d ?? '').slice(0, Math.max(0, 300 - overhead))
    data = `${action}:${JSON.stringify(payload)}`
  }
  return data
}

/**
 * Parse a postback data string produced by buildPostbackData.
 * Returns { action, state } or null if the format is unrecognised.
 */
export function parsePostbackData(data) {
  const colonIdx = data.indexOf(':')
  if (colonIdx === -1) return null
  try {
    return { action: data.slice(0, colonIdx), state: JSON.parse(data.slice(colonIdx + 1)) }
  } catch {
    return null
  }
}

/**
 * Build the compact state object carried in every postback button.
 *   d     – original description (may be trimmed to fit 300-char postback limit)
 *   extra – additional fields to merge in (e.g. { t: tenantName })
 */
export function buildCarriedState(description, extra = {}) {
  return { d: description, ...extra }
}

/**
 * Ask the user to select the product their issue relates to.
 * Uses plain, friendly language suited for sales staff and healthcare officers.
 */
export async function replyAskProduct(replyToken, description, carriedState) {
  return replyMessage(replyToken, [
    {
      type: 'text',
      text: 'Which product does your request relate to?\nPlease tap one of the options below.',
      quickReply: {
        items: PRODUCTS.map((label) => ({
          type: 'action',
          action: {
            type: 'postback',
            label,
            data: buildPostbackData('select_product', label, carriedState),
            displayText: label,
          },
        })),
      },
    },
  ])
}

/**
 * Ask the user to select their tenant/organisation (1-on-1 sessions only).
 * LINE quick reply supports a maximum of 13 items; the list is sliced to fit.
 */
export async function replyAskTenant(replyToken, carriedState, tenants) {
  return replyMessage(replyToken, [
    {
      type: 'text',
      text: 'Which organisation are you from?\nPlease tap one of the options below.',
      quickReply: {
        items: [
          ...tenants.slice(0, 12).map((label) => ({
            type: 'action',
            action: {
              type: 'postback',
              label,
              data: buildPostbackData('select_tenant', label, carriedState),
              displayText: label,
            },
          })),
          {
            type: 'action',
            action: {
              type: 'postback',
              label: 'Other',
              data: buildPostbackData('select_tenant', OTHER_TENANT_VALUE, carriedState),
              displayText: 'Other',
            },
          },
        ],
      },
    },
  ])
}
