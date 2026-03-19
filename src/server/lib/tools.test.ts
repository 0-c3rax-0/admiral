import { describe, expect, test } from 'bun:test'
import { rememberMarketSnapshot, rememberZeroFillSell } from './runtime-guards'
import { executeTool, findCanonicalAlias, mergeGameStateSnapshot } from './tools'
import { createProfile, deleteProfile } from './db'

describe('sell rerouting', () => {
  test('blocks unsupported remote-station args on view_market before hitting the server', async () => {
    const toolCalls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const result = await executeTool(
      'game',
      {
        command: 'view_market',
        args: {
          station_id: 'nova_terra_central',
          page_size: 50,
        },
      },
      {
        profileId: `test-${Date.now()}-view-market-invalid-args`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            toolCalls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(toolCalls).toHaveLength(0)
    expect(result).toContain('view_market only accepts item_id or category')
    expect(result).toContain('station_id')
  })

  test('blocks sell without explicit quantity', async () => {
    const toolCalls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const result = await executeTool(
      'game',
      {
        command: 'sell',
        args: {
          item_id: 'legacy_ore',
        },
      },
      {
        profileId: `test-${Date.now()}-sell-missing-quantity`,
        todo: '',
        log: () => {},
        gameState: {
          location: {
            poi_name: 'Nova Terra Central',
          },
        },
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            toolCalls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(toolCalls).toHaveLength(0)
    expect(result).toContain('Sell requires item_id and a quantity greater than 0')
  })

  test('reroutes repeated zero-fill sell attempts to create_sell_order', async () => {
    const profileId = `test-${Date.now()}-sell-reroute`
    const toolCalls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
    const logs: Array<{ type: string; summary: string }> = []

    rememberMarketSnapshot(profileId, 'Nova Terra Central', 'tungsten_ore', {
      bestBid: null,
      bestAsk: 8,
      bidVolume: 0,
      askVolume: 40,
    })
    rememberZeroFillSell(profileId, 'tungsten_ore', 'Nova Terra Central')

    const result = await executeTool(
      'game',
      {
        command: 'sell',
        args: {
          item_id: 'tungsten_ore',
          quantity: 10,
        },
      },
      {
        profileId,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        gameState: {
          location: {
            poi_name: 'Nova Terra Central',
          },
        },
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            toolCalls.push({ command, args })
            return {
              result: {
                ok: true,
              },
            }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toEqual({
      command: 'create_sell_order',
      args: {
        item_id: 'tungsten_ore',
        quantity: 10,
        price_each: 8,
      },
    })
    expect(logs.some((entry) => entry.type === 'system' && entry.summary.includes('Rerouted sell -> create_sell_order'))).toBe(true)
    expect(result).toContain('ok: true')
  })
})

describe('command aliases', () => {
  test('maps cancel_mission to abandon_mission when the API exposes abandon_mission', () => {
    const alias = findCanonicalAlias('cancel_mission', [
      'accept_mission',
      'abandon_mission',
      'get_missions',
    ])

    expect(alias).toBe('abandon_mission')
  })

  test('maps get_market to view_market when the API exposes view_market', () => {
    const alias = findCanonicalAlias('get_market', [
      'get_status',
      'view_market',
      'view_orders',
    ])

    expect(alias).toBe('view_market')
  })

  test('maps market_view to view_market when the API exposes view_market', () => {
    const alias = findCanonicalAlias('market_view', [
      'get_status',
      'view_market',
      'view_orders',
    ])

    expect(alias).toBe('view_market')
  })

  test('maps get_queue to v2_get_queue when only the v2 command exists', () => {
    const alias = findCanonicalAlias('get_queue', [
      'v2_get_queue',
      'get_state',
      'get_base',
    ])

    expect(alias).toBe('v2_get_queue')
  })

  test('rewrites facility_types to facility(action=types) before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'facility_types',
        args: {},
      },
      {
        profileId: `test-${Date.now()}-facility-types-rewrite`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'websocket_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            if (command === 'get_commands') {
              return {
                result: {
                  commands: [
                    { name: 'login' },
                  ],
                },
              } as any
            }
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'facility',
        args: { action: 'types' },
      },
    ])
  })

  test('normalizes personal_build type args to facility_type before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'personal_build',
        args: { type: 'personal_quarters' },
      },
      {
        profileId: `test-${Date.now()}-facility-personal-build-normalization`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'facility',
        args: { action: 'personal_build', facility_type: 'personal_quarters' },
      },
    ])
  })

  test('normalizes facility build type-style args to facility_type before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'facility',
        args: { action: 'build', type: 'faction_workshop' },
      },
      {
        profileId: `test-${Date.now()}-facility-build-normalization`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'facility',
        args: { action: 'build', facility_type: 'faction_workshop' },
      },
    ])
  })

  test('normalizes facility toggle id-style args to facility_id before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'facility',
        args: { action: 'toggle', id: 'fac_123' },
      },
      {
        profileId: `test-${Date.now()}-facility-toggle-normalization`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'facility',
        args: { action: 'toggle', facility_id: 'fac_123' },
      },
    ])
  })

  test('repairs malformed nested game invocation with empty top-level command', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: '',
        args: {
          command: 'facility_personal_build',
          args: { facility_type: 'crew_bunk' },
        },
      },
      {
        profileId: `test-${Date.now()}-nested-game-repair`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'facility',
        args: { action: 'personal_build', facility_type: 'crew_bunk' },
      },
    ])
  })

  test('rewrites get_recipes to catalog(type=recipes) before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'get_recipes',
        args: {},
      },
      {
        profileId: `test-${Date.now()}-get-recipes-rewrite`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'catalog',
        args: { type: 'recipes' },
      },
    ])
  })

  test('rewrites auth_login to login before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
    const suppliedUsername = 'test_login_user'
    const suppliedPassword = 'secret'
    const suppliedEmpire = 'solarian'

    await executeTool(
      'game',
      {
        command: 'auth_login',
        args: { username: suppliedUsername, password: suppliedPassword, empire: suppliedEmpire },
      },
      {
        profileId: `test-${Date.now()}-auth-login-rewrite`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'login',
        args: { username: suppliedUsername, password: suppliedPassword, empire: suppliedEmpire },
      },
    ])
  })

  test('forces login to use stored profile credentials instead of hallucinated username', async () => {
    const profileId = `test-${Date.now()}-login-credential-normalization`
    const storedUsername = 'stored_profile_user'
    const storedPassword = 'stored-password'
    const suppliedUsername = 'mismatched_model_user'
    const suppliedPassword = 'wrong-password'
    try {
      createProfile({
        id: profileId,
        name: profileId,
        username: storedUsername,
        password: storedPassword,
        empire: 'solarian',
        player_id: '',
        provider: 'openrouter',
        model: 'openrouter/free',
        failover_provider: 'nvidia',
        failover_model: 'mistralai/ministral-14b-instruct-2512',
        directive: '',
        todo: '',
        connection_mode: 'http_v2',
        server_url: 'https://game.spacemolt.com',
        autoconnect: false,
        enabled: true,
        context_budget: null,
      })

      const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

      await executeTool(
        'game',
        {
          command: 'login',
          args: { username: suppliedUsername, password: suppliedPassword, empire: 'pirate' },
        },
        {
          profileId,
          todo: '',
          log: () => {},
          connection: {
            mode: 'websocket_v2',
            connect: async () => {},
            login: async () => ({ success: true }),
            register: async () => ({ success: true }),
            execute: async (command, args) => {
              if (command === 'get_commands') {
                return {
                  result: {
                    commands: [
                      { name: 'login' },
                    ],
                  },
                } as any
              }
              calls.push({ command, args })
              return { result: { ok: true } }
            },
            onNotification: () => {},
            disconnect: async () => {},
            isConnected: () => true,
          },
        },
      )

      expect(calls).toEqual([
        {
          command: 'login',
          args: { username: storedUsername, password: storedPassword, empire: 'solarian' },
        },
      ])
    } finally {
      deleteProfile(profileId)
    }
  })
})

describe('navigation argument normalization', () => {
  test('normalizes travel aliases like id and target to target_poi before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const makeConnection = () => ({
      mode: 'http_v2' as const,
      connect: async () => {},
      login: async () => ({ success: true }),
      register: async () => ({ success: true }),
      execute: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args })
        return { result: { ok: true } }
      },
      onNotification: () => {},
      disconnect: async () => {},
      isConnected: () => true,
    })

    await executeTool(
      'game',
      {
        command: 'travel',
        args: { id: 'main_belt' },
      },
      {
        profileId: `test-${Date.now()}-travel-id-normalization`,
        todo: '',
        log: () => {},
        connection: makeConnection(),
      },
    )

    await executeTool(
      'game',
      {
        command: 'travel',
        args: { target: 'main_belt' },
      },
      {
        profileId: `test-${Date.now()}-travel-target-normalization`,
        todo: '',
        log: () => {},
        connection: makeConnection(),
      },
    )

    expect(calls).toEqual([
      {
        command: 'travel',
        args: { target_poi: 'main_belt' },
      },
      {
        command: 'travel',
        args: { target_poi: 'main_belt' },
      },
    ])
  })

  test('resolves runtime placeholders like $found_poi before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'travel',
        args: { target_poi: '$found_poi_id' },
      },
      {
        profileId: `test-${Date.now()}-travel-placeholder`,
        todo: '',
        log: () => {},
        gameState: {
          location: {
            system_name: 'Furud',
            poi_id: 'poi_live_123',
            poi_name: 'Rich Belt',
          },
          poi: {
            id: 'poi_catalog_456',
            name: 'Rich Belt',
          },
        },
        connection: {
          mode: 'websocket_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'get_commands') {
              return { result: { commands: [{ name: 'travel' }] } }
            }
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'travel',
        args: { target_poi: 'poi_catalog_456' },
      },
    ])
  })

  test('blocks malformed combined system and poi travel targets locally', async () => {
    const logs: Array<{ type: string; summary: string }> = []
    let executeCalled = false

    const result = await executeTool(
      'game',
      {
        command: 'travel',
        args: { target_poi: 'furud / furud_belt' },
      },
      {
        profileId: `test-${Date.now()}-travel-combined-destination`,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => {
            executeCalled = true
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(executeCalled).toBe(false)
    expect(result).toContain('combined system/POI string')
    expect(logs.some((entry) => entry.summary.includes('combined system/POI string'))).toBe(true)
  })

  test('requires a fresh location verification after jump before travel', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const profileId = `test-${Date.now()}-travel-refresh-after-jump`
    const connection = {
      mode: 'http_v2' as const,
      connect: async () => {},
      login: async () => ({ success: true }),
      register: async () => ({ success: true }),
      execute: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args })
        if (command === 'jump') return { result: { pending: true, command: 'jump' } }
        return { result: { ok: true } }
      },
      onNotification: () => {},
      disconnect: async () => {},
      isConnected: () => true,
    }

    const jumpResult = await executeTool(
      'game',
      {
        command: 'jump',
        args: { target_system: 'furud' },
      },
      {
        profileId,
        todo: '',
        log: () => {},
        connection,
      },
    )

    const travelResult = await executeTool(
      'game',
      {
        command: 'travel',
        args: { target_poi: 'furud_belt' },
      },
      {
        profileId,
        todo: '',
        log: () => {},
        connection,
      },
    )

    expect(jumpResult).toContain('pending: true')
    expect(travelResult).toContain('navigation_refresh_required')
  })
})

describe('state inference from command errors', () => {
  test('treats dock + already_docked as a docked local state hint', () => {
    const merged = mergeGameStateSnapshot(
      {
        player: {
          current_system: 'Nova Terra',
          current_poi: 'Deep Belt',
        },
        location: {
          system_name: 'Nova Terra',
          poi_name: 'Deep Belt',
          poi_type: 'asteroid_belt',
          in_transit: true,
          ticks_remaining: 1,
        },
      },
      {
        error: {
          code: 'already_docked',
          message: 'Already docked',
        },
      },
      'dock',
      { station_id: 'nova_terra_central' },
    )

    expect(merged).toMatchObject({
      player: {
        current_poi: 'nova_terra_central',
      },
      location: {
        docked_at: 'nova_terra_central',
        poi_name: 'nova_terra_central',
        poi_type: 'station',
        in_transit: false,
        ticks_remaining: 0,
      },
    })
  })

  test('treats undock + not_docked as an undocked local state hint', () => {
    const merged = mergeGameStateSnapshot(
      {
        player: {
          current_system: 'Nova Terra',
          current_poi: 'nova_terra_central',
        },
        location: {
          system_name: 'Nova Terra',
          poi_name: 'nova_terra_central',
          poi_type: 'station',
          docked_at: 'nova_terra_central',
          in_transit: false,
          ticks_remaining: 0,
        },
      },
      {
        error: {
          code: 'not_docked',
          message: 'You are not docked',
        },
      },
      'undock',
      {},
    )

    expect(merged).toMatchObject({
      location: {
        docked_at: null,
        in_transit: false,
        ticks_remaining: 0,
      },
    })
  })
})

describe('command error interpretation', () => {
  test('explains no_base as a location/base-state problem', async () => {
    const result = await executeTool(
      'game',
      {
        command: 'facility',
        args: { action: 'types' },
      },
      {
        profileId: `test-${Date.now()}-no-base-interpretation`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => ({
            error: {
              code: 'no_base',
              message: 'No base at this location',
            },
          }),
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(result).toContain('Error: [no_base] No base at this location')
    expect(result).toContain('requires being at a valid base or station location')
    expect(result).toContain('move to a valid base')
  })
})

describe('tool argument normalization', () => {
  test('parses stringified JSON args for game tool calls', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const result = await executeTool(
      'game',
      {
        command: 'help',
        args: '{"command":"travel"}',
      } as any,
      {
        profileId: `test-${Date.now()}-help-json-args`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'help',
        args: { command: 'travel' },
      },
    ])
    expect(result).toContain('ok: true')
  })

  test('rejects non-object game args payloads before logging mangled characters', async () => {
    const logs: Array<{ type: string; summary: string }> = []
    let executeCalled = false

    const result = await executeTool(
      'game',
      {
        command: 'help',
        args: '"travel"',
      } as any,
      {
        profileId: `test-${Date.now()}-help-invalid-args`,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => {
            executeCalled = true
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(executeCalled).toBe(false)
    expect(result).toContain("invalid 'args' payload")
    expect(logs.some((entry) => entry.summary.includes("invalid 'args' payload"))).toBe(true)
    expect(logs.some((entry) => entry.summary.includes('0='))).toBe(false)
  })

  test('normalizes singular type arguments in catalog', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'catalog',
        args: { type: 'item' },
      },
      {
        profileId: `test-${Date.now()}-catalog-type-norm`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'catalog',
        args: { type: 'items' },
      },
    ])
  })

  test('reroutes empty facility personal_build to types with category=personal', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const result = await executeTool(
      'game',
      {
        command: 'facility',
        args: { action: 'personal_build' },
      },
      {
        profileId: `test-${Date.now()}-facility-personal-build-empty`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'facility',
        args: { action: 'types', category: 'personal' },
      },
    ])
    expect(result).toContain('ok: true')
  })

  test('reroutes empty facility build to types', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    const result = await executeTool(
      'game',
      {
        command: 'facility',
        args: { action: 'build' },
      },
      {
        profileId: `test-${Date.now()}-facility-build-empty`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'facility',
        args: { action: 'types' },
      },
    ])
    expect(result).toContain('ok: true')
  })

  test('normalizes view_orders scope aliases like self to personal before execution', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []

    await executeTool(
      'game',
      {
        command: 'view_orders',
        args: { scope: 'self', order_type: 'sell' },
      },
      {
        profileId: `test-${Date.now()}-view-orders-scope-self`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async (command, args) => {
            calls.push({ command, args })
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(calls).toEqual([
      {
        command: 'view_orders',
        args: { scope: 'personal', order_type: 'sell' },
      },
    ])
  })

  test('blocks unsupported view_orders scope values locally', async () => {
    let executeCalled = false

    const result = await executeTool(
      'game',
      {
        command: 'view_orders',
        args: { scope: 'all' },
      },
      {
        profileId: `test-${Date.now()}-view-orders-scope-invalid`,
        todo: '',
        log: () => {},
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => {
            executeCalled = true
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(executeCalled).toBe(false)
    expect(result).toContain('Error: [invalid_scope] Invalid scope.')
    expect(result).toContain('exact scope values `personal` or `faction`')
  })
})

describe('backoff hints', () => {
  test('surfaces retry_after guidance on rate-limit errors', async () => {
    const logs: Array<{ type: string; summary: string }> = []

    const result = await executeTool(
      'game',
      {
        command: 'get_status',
      },
      {
        profileId: `test-${Date.now()}-rate-limit-hint`,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => ({
            error: {
              code: 'rate_limited',
              message: 'Too many requests',
              retry_after: 12,
            },
          }),
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(result).toContain('12s pause')
    expect(logs.some((entry) => entry.type === 'system' && entry.summary.includes('12s pause'))).toBe(true)
  })
})

describe('local tool guardrails', () => {
  test('rejects local tools wrapped in game() with a clear error', async () => {
    const logs: Array<{ type: string; summary: string }> = []
    let executeCalled = false

    const result = await executeTool(
      'game',
      {
        command: 'status_log',
        args: {
          category: 'info',
          message: 'hello',
        },
      } as any,
      {
        profileId: `test-${Date.now()}-status-log-guard`,
        todo: '',
        log: (type, summary) => logs.push({ type, summary }),
        connection: {
          mode: 'http_v2',
          connect: async () => {},
          login: async () => ({ success: true }),
          register: async () => ({ success: true }),
          execute: async () => {
            executeCalled = true
            return { result: { ok: true } }
          },
          onNotification: () => {},
          disconnect: async () => {},
          isConnected: () => true,
        },
      },
    )

    expect(executeCalled).toBe(false)
    expect(result).toContain('local Admiral tool')
    expect(result).toContain('Call status_log(')
    expect(logs.some((entry) => entry.summary.includes('Blocked local tool wrapped in game(): status_log'))).toBe(true)
  })
})
