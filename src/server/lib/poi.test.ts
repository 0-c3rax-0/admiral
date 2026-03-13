import { describe, expect, test } from 'bun:test'
import { classifyPoi, isDockedPoi, isResourcePoi, resolvePoiSnapshot } from './poi'

describe('resolvePoiSnapshot', () => {
  test('prefers live location POI over stale player POI fields', () => {
    const location = {
      poi_type: 'asteroid_belt',
      poi_name: 'Nova Terra Industrial Belt',
    }
    const player = {
      current_poi_type: 'station',
      current_poi: 'Nova Terra Central',
    }

    const poi = resolvePoiSnapshot(location, player)

    expect(poi).toEqual({
      type: 'asteroid_belt',
      name: 'Nova Terra Industrial Belt',
    })
    expect(classifyPoi(poi.type, poi.name)).toBe('ore')
    expect(isDockedPoi(poi.type, poi.name)).toBe(false)
    expect(isResourcePoi(poi.type, poi.name)).toBe(true)
  })

  test('documents the stale mixed-field regression that previously misclassified belts as stations', () => {
    expect(classifyPoi('station', 'Nova Terra Industrial Belt')).toBe('station')
  })

  test('prefers player poi name over stale player poi type when no live location snapshot exists', () => {
    const poi = resolvePoiSnapshot(undefined, {
      current_poi_type: 'station',
      current_poi: 'nova_terra_industrial_belt',
    })

    expect(poi).toEqual({
      type: undefined,
      name: 'nova_terra_industrial_belt',
    })
    expect(classifyPoi(poi.type, poi.name)).toBe('ore')
    expect(isDockedPoi(poi.type, poi.name)).toBe(false)
    expect(isResourcePoi(poi.type, poi.name)).toBe(true)
  })
})
