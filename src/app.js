import express from 'express'
import { handleWebhook } from './lineHandler.js'

const app = express()

// Parse raw body for LINE signature verification
app.use(
  '/webhook',
  express.raw({ type: 'application/json' }),
)

app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.post('/webhook', handleWebhook)

export { app }
