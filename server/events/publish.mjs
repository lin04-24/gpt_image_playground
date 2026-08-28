import { redisKeys } from '../redis/keys.mjs'

export async function publishEvent(database, redis, type, aggregateId, payload = {}) {
  const result = await database.query('UPDATE app_meta SET event_sequence = event_sequence + 1, updated_at = now() WHERE id = 1 RETURNING event_sequence')
  const event = {
    id: Number(result.rows[0]?.event_sequence || 0),
    type,
    aggregateId,
    payload,
  }
  await redis.publish(redisKeys.events, JSON.stringify(event))
  return event
}
