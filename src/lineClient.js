import crypto from 'crypto'
import config from './config.js'

const LINE_API_BASE = 'https://api.line.me/v2/bot'

let botUserIdCache = null

export async function getBotUserId() {
  if (botUserIdCache) return botUserIdCache
  if (!config.LINE_CHANNEL_ACCESS_TOKEN) return null
  try {
    const res = await fetch(`${LINE_API_BASE}/info`, {
      headers: { Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}` },
    })
    if (res.ok) {
      const info = await res.json()
      botUserIdCache = info.userId
      return botUserIdCache
    }
  } catch (err) {
    console.warn('Failed to fetch LINE bot info:', err.message)
  }
  return null
}

export function verifySignature(rawBody, signature) {
  if (!config.LINE_CHANNEL_SECRET) {
    console.warn('LINE_CHANNEL_SECRET is not set — skipping signature verification')
    return true
  }
  const expected = crypto
    .createHmac('sha256', config.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64')
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

export async function replyMessage(replyToken, messages) {
  if (!config.LINE_CHANNEL_ACCESS_TOKEN) return

  const res = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`LINE reply API error ${res.status}: ${text}`)
  }
}

export async function replyText(replyToken, text) {
  return replyMessage(replyToken, [{ type: 'text', text }])
}

export async function getDisplayName(userId, source = null) {
  if (!config.LINE_CHANNEL_ACCESS_TOKEN || !userId || userId === 'unknown') {
    return 'LINE user'
  }

  const headers = { Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}` }

  // In group/room context, use the member endpoint which works even when the
  // user is not friends with the LINE OA.
  const groupId = source?.groupId
  const roomId = source?.roomId
  const memberUrl = groupId
    ? `${LINE_API_BASE}/group/${groupId}/member/${userId}`
    : roomId
      ? `${LINE_API_BASE}/room/${roomId}/member/${userId}`
      : null

  if (memberUrl) {
    try {
      const res = await fetch(memberUrl, { headers })
      if (res.ok) {
        const profile = await res.json()
        if (profile.displayName) return profile.displayName
      }
    } catch (err) {
      console.warn('Failed to fetch LINE group/room member profile:', err.message)
    }
  }

  // Fall back to the follower profile endpoint (requires friendship).
  try {
    const res = await fetch(`${LINE_API_BASE}/profile/${userId}`, { headers })
    if (res.ok) {
      const profile = await res.json()
      if (profile.displayName) return profile.displayName
    }
  } catch (err) {
    console.warn('Failed to fetch LINE profile:', err.message)
  }

  return 'LINE user'
}
