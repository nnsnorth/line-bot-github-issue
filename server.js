import { app } from './src/app.js'
import { loadFieldCache } from './src/fieldCache.js'

const PORT = process.env.PORT || 3000

// Load field cache before accepting traffic
try {
  await loadFieldCache()
} catch (err) {
  console.warn('Field cache init skipped:', err.message)
}

app.listen(PORT, () => {
  console.log(`LINE webhook server running on port ${PORT}`)
})
