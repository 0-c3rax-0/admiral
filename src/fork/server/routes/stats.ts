import { Hono } from 'hono'
import {
  listProfiles,
  getProfile,
  getProfileSkills,
  listProfileSkills,
  listStatsEvents,
  listStatsSnapshots,
} from '../../../server/lib/db'

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
    if (newest?.ts && (!lastSnapshotTs || parseSqliteUtcTimestamp(newest.ts) > parseSqliteUtcTimestamp(lastSnapshotTs))) {
      lastSnapshotTs = newest.ts
    }

    if (snapshots.length > 0) {
      creditsDelta1h += deltaUsingNearestValues(snapshots, oneHourAgo, 'credits')
      oreDelta1h += deltaUsingNearestValues(snapshots, oneHourAgo, 'ore_mined')
      tradesDelta1h += deltaUsingNearestValues(snapshots, oneHourAgo, 'trades_completed')
      systemsDelta1h += deltaUsingNearestValues(snapshots, oneHourAgo, 'systems_explored')
    }

    events24h += events.filter((e) => parseSqliteUtcTimestamp(e.ts) >= now - (24 * 60 * 60 * 1000)).length
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

stats.get('/skills/summary', (c) => {
  const rows = listProfileSkills()
  return c.json({
    profiles: rows.map((row) => ({
      profile_id: row.profile_id,
      ts: row.ts,
      skills: row.skills,
    })),
  })
})

stats.get('/:id/skills', (c) => {
  const id = c.req.param('id')
  const profile = getProfile(id)
  if (!profile) return c.json({ error: 'Profile not found' }, 404)
  const row = getProfileSkills(id)
  return c.json({ profile_id: id, ts: row?.ts ?? null, skills: row?.skills ?? null })
})

export default stats

function deltaUsingNearestValues(
  snapshots: Array<{
    ts: string
    credits: number | null
    ore_mined: number | null
    trades_completed: number | null
    systems_explored: number | null
  }>,
  oneHourAgo: number,
  key: 'credits' | 'ore_mined' | 'trades_completed' | 'systems_explored',
): number {
  const newest = snapshots.find((snapshot) => typeof snapshot[key] === 'number' && Number.isFinite(snapshot[key] as number))
  if (!newest) return 0

  const anchor = snapshots.find((snapshot) => (
    parseSqliteUtcTimestamp(snapshot.ts) <= oneHourAgo &&
    typeof snapshot[key] === 'number' &&
    Number.isFinite(snapshot[key] as number)
  )) || [...snapshots].reverse().find((snapshot) => typeof snapshot[key] === 'number' && Number.isFinite(snapshot[key] as number))

  if (!anchor) return 0
  return (newest[key] as number) - (anchor[key] as number)
}

function parseSqliteUtcTimestamp(ts: string | null | undefined): number {
  if (!ts) return 0
  const isoLike = ts.includes('T') ? ts : ts.replace(' ', 'T')
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(isoLike) ? isoLike : `${isoLike}Z`
  const parsed = Date.parse(withZone)
  return Number.isFinite(parsed) ? parsed : 0
}
