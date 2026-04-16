import config from './config.js'
import { classify, isConfident } from './classifier.js'
import { createSupportTicket, createGitHubIssue } from './github.js'
import { getBotUserId, verifySignature, replyText, getDisplayName } from './lineClient.js'
import {
  PRODUCTS,
  OTHER_TENANT_VALUE,
  buildCarriedState,
  parsePostbackData,
  replyAskProduct,
  replyAskTenant,
} from './labelSelection.js'

const SUPPORT_PATTERN = /^@support\s+(.+)/is

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Extract the description text from a message that @mentions the bot.
 * Returns null when the bot is not mentioned or nothing remains after stripping the mention.
 */
function extractDescriptionFromMention(text, mentionees, botUserId) {
  const botMentions = mentionees.filter((m) => m.type === 'user' && m.userId === botUserId)
  if (botMentions.length === 0) return null

  const sorted = [...botMentions].sort((a, b) => b.index - a.index)
  let result = text
  for (const m of sorted) {
    result = result.slice(0, m.index) + result.slice(m.index + m.length)
  }
  const description = result.trim()
  return description.length > 0 ? description : null
}

/**
 * Scan the description for an exact (case-insensitive) product name.
 * 'other' is excluded because it is too generic to match literally.
 * Returns { value, confidence } or null.
 */
function exactMatchProduct(description) {
  const lower = description.toLowerCase()
  for (const product of PRODUCTS) {
    if (product === 'other') continue
    if (lower.includes(product.toLowerCase())) {
      return { value: product, confidence: 1.0 }
    }
  }
  return null
}

/**
 * Scan the description for an exact (case-insensitive) tenant name from the
 * configured tenant list.
 * Returns { value, confidence } or null.
 */
function exactMatchTenant(description, tenants) {
  const lower = description.toLowerCase()
  for (const tenant of tenants) {
    if (lower.includes(tenant.toLowerCase())) {
      return { value: tenant, confidence: 1.0 }
    }
  }
  return null
}

/**
 * Resolve product via: exact match → classifier result → needs user input.
 * Returns { product, product_confidence } when resolved, or { needsAsk: true }.
 */
function resolveProduct(description, classification) {
  const exact = exactMatchProduct(description)
  if (exact) return { product: exact.value, product_confidence: exact.confidence }

  if ((classification.product_confidence ?? 0) >= config.CONFIDENCE_THRESHOLD) {
    return { product: classification.product, product_confidence: classification.product_confidence }
  }

  return { needsAsk: true }
}

/**
 * Resolve tenant for 1-on-1 chats: exact match → classifier result → needs user input.
 * If no tenants are configured, returns a resolved null tenant (tenant system is disabled).
 * Returns { tenant, tenant_confidence } when resolved, or { needsAsk: true }.
 */
function resolveTenant1on1(description, classification) {
  if (config.LINE_TENANTS.length === 0) {
    return { tenant: null, tenant_confidence: 0 }
  }

  const exact = exactMatchTenant(description, config.LINE_TENANTS)
  if (exact) return { tenant: exact.value, tenant_confidence: exact.confidence }

  if ((classification.tenant_confidence ?? 0) >= config.CONFIDENCE_THRESHOLD) {
    return { tenant: classification.tenant, tenant_confidence: classification.tenant_confidence }
  }

  return { needsAsk: true }
}

function buildSuccessMessage(number, url) {
  return `Your request has been submitted! ✅\n\nTicket #${number}: ${url}\n\nOur team will review it and get back to you soon.`
}

function buildErrorMessage() {
  return "Sorry, we couldn't submit your request right now. Please try again, or contact your support team directly."
}

// ─── ticket creation ─────────────────────────────────────────────────────────

/**
 * Final step: re-classify, apply all resolved overrides, and create the ticket.
 * overrides: { product, product_confidence, tenant?, tenant_confidence? }
 * groupId is used to apply the group-tenant map if this is a group postback.
 */
async function createTicketFromState(replyToken, userId, groupId, source, state, overrides) {
  const { d: description } = state
  const displayName = await getDisplayName(userId, source)

  try {
    const classification = await classify(description)

    // Tenant: group map takes precedence, then carried state, then override
    const groupTenant = groupId ? (config.LINE_GROUP_TENANT_MAP[groupId] ?? null) : null
    if (groupTenant) {
      classification.tenant = groupTenant
      classification.tenant_confidence = 1.0
    } else if (overrides.tenant !== undefined || overrides.tenant_is_other) {
      classification.tenant = overrides.tenant_is_other ? null : overrides.tenant
      classification.tenant_confidence = overrides.tenant_confidence ?? 1.0
      if (overrides.tenant_is_other) classification.tenant_is_other = true
    } else if (state.t) {
      if (state.t === OTHER_TENANT_VALUE) {
        classification.tenant = null
        classification.tenant_is_other = true
      } else {
        classification.tenant = state.t
      }
      classification.tenant_confidence = 1.0
    }

    // Product: always from the resolved override
    classification.product = overrides.product
    classification.product_confidence = overrides.product_confidence ?? 1.0

    // issue_type, category, severity: always from classifier (no override)

    classification.confident = isConfident(classification)

    const result = await createSupportTicket(classification, description, displayName)
    console.log(
      `Ticket created — #${result.number}, status: ${result.status}, ` +
      `product: ${classification.product} (${classification.product_confidence.toFixed(2)}), ` +
      `issue_type: ${classification.issue_type} (${classification.issue_type_confidence?.toFixed(2)}), ` +
      `category: ${classification.category} (${classification.category_confidence?.toFixed(2)}), ` +
      `severity: ${classification.severity} (${classification.severity_confidence?.toFixed(2)}), ` +
      `tenant: ${classification.tenant ?? 'none'} (${(classification.tenant_confidence ?? 0).toFixed(2)})`
    )
    return replyText(replyToken, buildSuccessMessage(result.number, result.url))
  } catch (err) {
    console.error(`Failed to create support ticket for user ${userId}:`, err)
    return replyText(replyToken, buildErrorMessage())
  }
}

// ─── message handler ─────────────────────────────────────────────────────────

async function handleTextMessage(event) {
  const { replyToken, source, message } = event
  const userId = source?.userId ?? 'unknown'
  const isGroup = source?.type === 'group' || source?.type === 'room'
  const groupId = source?.groupId ?? source?.roomId ?? null

  console.log(`Message from ${userId}${groupId ? ` (group: ${groupId})` : ''}: [${message.type}] ${message.text ?? ''}`)

  if (message.type !== 'text') return

  let description

  if (isGroup) {
    // Group/room: trigger only on @mention
    const mentionees = message.mention?.mentionees ?? []
    if (mentionees.length === 0) return

    const botUserId = await getBotUserId()
    if (!botUserId) return

    description = extractDescriptionFromMention(message.text, mentionees, botUserId)
    if (!description) return

    // Group tenant must be configured — silently ignore requests from unknown groups
    const groupTenant = config.LINE_GROUP_TENANT_MAP[groupId] ?? null
    if (!groupTenant) {
      console.log(`Group ${groupId} not in LINE_GROUP_TENANT_MAP — ignoring request`)
      return
    }
  } else {
    // 1-on-1: require @support prefix
    const supportMatch = message.text.match(SUPPORT_PATTERN)
    if (!supportMatch) {
      return replyText(replyToken,
        'Hi! To submit a support request, type:\n@support <description of your issue>\n\nExample: @support I cannot log in to the app')
    }
    description = supportMatch[1].trim()
  }

  const displayName = await getDisplayName(userId, source)

  try {
    if (!config.CLASSIFIER_URL) {
      // No classifier configured: create a bare GitHub issue without labels
      const title = description.length > 80 ? description.slice(0, 77) + '...' : description
      const result = await createGitHubIssue(title, description)
      console.log(`GitHub issue #${result.number} created (no classifier): ${result.url}`)
      return replyText(replyToken, buildSuccessMessage(result.number, result.url))
    }

    const classification = await classify(description)

    if (isGroup) {
      const groupTenant = config.LINE_GROUP_TENANT_MAP[groupId]
      classification.tenant = groupTenant
      classification.tenant_confidence = 1.0

      // Resolve product: exact match → classifier → ask
      const productResult = resolveProduct(description, classification)
      if (productResult.needsAsk) {
        console.log(
          `Low product confidence (${classification.product_confidence?.toFixed(2)}) ` +
          `for group ${groupId} — asking user`
        )
        return replyAskProduct(
          replyToken,
          description,
          buildCarriedState(description, { t: groupTenant })
        )
      }

      classification.product = productResult.product
      classification.product_confidence = productResult.product_confidence
    } else {
      // 1-on-1: resolve tenant first
      const tenantResult = resolveTenant1on1(description, classification)
      if (tenantResult.needsAsk) {
        console.log(
          `Low tenant confidence (${classification.tenant_confidence?.toFixed(2)}) ` +
          `for user ${userId} — asking tenant`
        )
        return replyAskTenant(replyToken, buildCarriedState(description), config.LINE_TENANTS)
      }
      classification.tenant = tenantResult.tenant
      classification.tenant_confidence = tenantResult.tenant_confidence

      // Resolve product: exact match → classifier → ask
      const productResult = resolveProduct(description, classification)
      if (productResult.needsAsk) {
        console.log(
          `Low product confidence (${classification.product_confidence?.toFixed(2)}) ` +
          `for user ${userId} — asking product`
        )
        return replyAskProduct(
          replyToken,
          description,
          buildCarriedState(description, { t: classification.tenant })
        )
      }
      classification.product = productResult.product
      classification.product_confidence = productResult.product_confidence
    }

    // issue_type, category, severity come from the classifier — no user input needed
    classification.confident = isConfident(classification)

    const result = await createSupportTicket(classification, description, displayName)
    console.log(
      `Ticket created — #${result.number}, status: ${result.status}, ` +
      `product: ${classification.product} (${classification.product_confidence.toFixed(2)}), ` +
      `issue_type: ${classification.issue_type} (${classification.issue_type_confidence?.toFixed(2)}), ` +
      `category: ${classification.category} (${classification.category_confidence?.toFixed(2)}), ` +
      `severity: ${classification.severity} (${classification.severity_confidence?.toFixed(2)}), ` +
      `tenant: ${classification.tenant ?? 'none'} (${(classification.tenant_confidence ?? 0).toFixed(2)})`
    )
    return replyText(replyToken, buildSuccessMessage(result.number, result.url))
  } catch (err) {
    console.error('Failed to create support ticket:', err)
    return replyText(replyToken, buildErrorMessage())
  }
}

// ─── postback handler ────────────────────────────────────────────────────────

/**
 * Handle postback events from quick-reply label selections.
 *
 * All context is carried inside the postback data itself — no server-side
 * session required (stateless / Cloud Run safe).
 *
 * Flow:
 *   select_tenant  → tenant chosen by user → resolve product (exact/classify/ask)
 *   select_product → product chosen by user → create ticket
 */
async function handlePostbackEvent(event) {
  const { replyToken, source, postback } = event
  const userId = source?.userId ?? 'unknown'
  const groupId = source?.groupId ?? source?.roomId ?? null

  const parsed = parsePostbackData(postback?.data ?? '')
  if (!parsed) return

  const { action, state } = parsed
  if (!['select_tenant', 'select_product'].includes(action)) return

  const { d: description } = state

  // ── select_tenant ──────────────────────────────────────────────────────────
  if (action === 'select_tenant') {
    const tenantRaw = state.v
    const isOtherTenant = tenantRaw === OTHER_TENANT_VALUE
    const tenant = isOtherTenant ? null : tenantRaw
    console.log(`User ${userId} selected tenant: ${isOtherTenant ? 'other (unknown)' : tenant}`)

    try {
      const classification = await classify(description)
      classification.tenant = tenant
      classification.tenant_confidence = 1.0
      if (isOtherTenant) classification.tenant_is_other = true

      const productResult = resolveProduct(description, classification)
      if (productResult.needsAsk) {
        console.log(
          `Low product confidence (${classification.product_confidence?.toFixed(2)}) ` +
          `for user ${userId} after tenant selection — asking product`
        )
        return replyAskProduct(
          replyToken,
          description,
          buildCarriedState(description, { t: isOtherTenant ? OTHER_TENANT_VALUE : tenant })
        )
      }

      return createTicketFromState(replyToken, userId, groupId, source, state, {
        tenant,
        tenant_confidence: 1.0,
        tenant_is_other: isOtherTenant,
        product: productResult.product,
        product_confidence: productResult.product_confidence,
      })
    } catch (err) {
      console.error(`Failed to process tenant selection for user ${userId}:`, err)
      return replyText(replyToken, buildErrorMessage())
    }
  }

  // ── select_product ─────────────────────────────────────────────────────────
  if (action === 'select_product') {
    const product = state.v
    console.log(`User ${userId} selected product: ${product}`)

    return createTicketFromState(replyToken, userId, groupId, source, state, {
      product,
      product_confidence: 1.0,
    })
  }
}

// ─── event router ────────────────────────────────────────────────────────────

async function handleEvent(event) {
  const { type, replyToken, source } = event
  const userId = source?.userId ?? 'unknown'

  switch (type) {
    case 'message':
      return handleTextMessage(event)

    case 'postback':
      return handlePostbackEvent(event)

    case 'follow':
      console.log(`User ${userId} followed the LINE OA`)
      return replyText(replyToken,
        'Welcome to Support Bot! 👋\n\nTo submit a support request, type:\n@support <description of your issue>')

    case 'unfollow':
      console.log(`User ${userId} unfollowed the LINE OA`)
      break

    case 'join':
      console.log(`Bot joined group/room: ${source?.groupId ?? source?.roomId}`)
      break

    case 'leave':
      console.log(`Bot left group/room: ${source?.groupId ?? source?.roomId}`)
      break

    default:
      console.log(`Unhandled event type: ${type}`)
  }
}

// ─── webhook entry point ─────────────────────────────────────────────────────

export async function handleWebhook(req, res) {
  const signature = req.headers['x-line-signature']
  if (!signature) {
    return res.status(400).json({ error: 'Missing X-Line-Signature header' })
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body))

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  let payload
  try {
    payload = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }

  const events = payload.events ?? []

  if (events.length === 0) {
    console.log('LINE webhook verification request received — responding 200 OK')
    return res.status(200).json({ status: 'ok' })
  }

  // Respond 200 immediately — LINE expects a quick acknowledgement
  res.status(200).json({ status: 'ok' })

  // Process events asynchronously after responding
  await Promise.all(events.map(handleEvent)).catch((err) =>
    console.error('Error processing LINE events:', err),
  )
}
