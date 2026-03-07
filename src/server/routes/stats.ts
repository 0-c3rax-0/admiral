import { Hono } from 'hono'
import { listProfiles, getProfile, listStatsEvents, listStatsSnapshots } from '../lib/db'

const stats = new Hono()

stats.get('/summary', (c) => {
  const profiles = listProfiles()
  const now = Date.now()
  const oneHourAgo = now - (60 * 60 * 1000)

  let snapshotCount = 0
  let profilesWithData = 0
  let lastSnapshotTs: string | null = null
  let creditsDelta1h = 0
  let oreDelta1h = 0
  let tradesDelta1h = 0
  let systemsDelta1h = 0
  let events24h = 0

  for (const profile of profiles) {
    const snapshots = listStatsSnapshots(profile.id, 240)
    const events = listStatsEvents(profile.id, 200)
    snapshotCount += snapshots.length
    if (snapshots.length > 0) profilesWithData++

    const newest = snapshots[0]
    if (newest?.ts && (!lastSnapshotTs || new Date(newest.ts).getTime() > new Date(lastSnapshotTs).getTime())) {
      lastSnapshotTs = newest.ts
    }

    if (snapshots.length > 0) {
      const anchor = snapshots.find((s) => new Date(s.ts).getTime() <= oneHourAgo) || snapshots[snapshots.length - 1]
      creditsDelta1h += num(newest?.credits) - num(anchor?.credits)
      oreDelta1h += num(newest?.ore_mined) - num(anchor?.ore_mined)
      tradesDelta1h += num(newest?.trades_completed) - num(anchor?.trades_completed)
      systemsDelta1h += num(newest?.systems_explored) - num(anchor?.systems_explored)
    }

    events24h += events.filter((e) => new Date(e.ts).getTime() >= now - (24 * 60 * 60 * 1000)).length
  }

  return c.json({
    snapshotCount,
    profilesWithData,
    lastSnapshotTs,
    creditsDelta1h,
    oreDelta1h,
    tradesDelta1h,
    systemsDelta1h,
    events24h,
  })
})

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

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
