import { createClient } from 'redis'

export async function createRedis(options = {}) {
  const url = options.url || process.env.REDIS_URL
  if (!url) throw new Error('REDIS_URL is required')
  const client = createClient({ url })
  client.on('error', (error) => console.error('Redis error:', error.message))
  await client.connect()
  return client
}

export async function createRedisPair(options = {}) {
  const url = options.url || process.env.REDIS_URL
  if (!url) throw new Error('REDIS_URL is required')
  const command = createClient({ url })
  const events = command.duplicate()
  command.on('error', (error) => console.error('Redis command error:', error.message))
  events.on('error', (error) => console.error('Redis events error:', error.message))
  await Promise.all([command.connect(), events.connect()])
  return { command, events, close: () => Promise.all([command.quit(), events.quit()]) }
}

