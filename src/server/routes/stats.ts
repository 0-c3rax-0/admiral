import { Hono } from 'hono'
import { getProfile, listStatsEvents, listStatsSnapshots } from '../lib/db'

const stats = new Hono()

stats.get('/:id/snapshots', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const limitRaw = c.req.query('limit')
  const limit = Math.max(1, Math.min(2000, parseInt(limitRaw || '120', 10) || 120))
  const rows = listStatsSnapshots(id, limit)
  return c.json({ profile_id: id, snapshots: rows })
})

stats.get('/:id/events', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const limitRaw = c.req.query('limit')
  const limit = Math.max(1, Math.min(1000, parseInt(limitRaw || '200', 10) || 200))
  const rows = listStatsEvents(id, limit)
  return c.json({ profile_id: id, events: rows })
})

export default stats
