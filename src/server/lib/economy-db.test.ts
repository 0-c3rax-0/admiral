import { describe, expect, test } from 'bun:test'
import { addMarketSnapshot, listCraftableRecipeEconomics, upsertRecipes } from './economy-db'

describe('craftable recipe economics', () => {
  test('computes profitable craft opportunities from available materials', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const profileId = `test-craft-econ-${suffix}`

    upsertRecipes([
      {
        recipe_id: `recipe_graphene_${suffix}`,
        recipe_name: `Exfoliate Graphene ${suffix}`,
        output_item_name: `Graphene Sheet ${suffix}`,
        output_quantity: 1,
        inputs: [
          { item_name: `Carbon Ore ${suffix}`, quantity: 6 },
        ],
      },
      {
        recipe_id: `recipe_bad_${suffix}`,
        recipe_name: `Bad Trade ${suffix}`,
        output_item_name: `Bad Output ${suffix}`,
        output_quantity: 1,
        inputs: [
          { item_name: `Carbon Ore ${suffix}`, quantity: 2 },
        ],
      },
    ], profileId)

    addMarketSnapshot({
      profile_id: profileId,
      category: 'test',
      source: 'unit-test',
      entries: [
        {
          item_id: `carbon_ore_${suffix}`,
          item_name: `Carbon Ore ${suffix}`,
          best_bid: 5,
          best_ask: 6,
          bid_volume: 100,
          ask_volume: 100,
        },
        {
          item_id: `graphene_sheet_${suffix}`,
          item_name: `Graphene Sheet ${suffix}`,
          best_bid: 40,
          best_ask: 42,
          bid_volume: 100,
          ask_volume: 100,
        },
        {
          item_id: `bad_output_${suffix}`,
          item_name: `Bad Output ${suffix}`,
          best_bid: 7,
          best_ask: 8,
          bid_volume: 100,
          ask_volume: 100,
        },
      ],
    })

    const results = listCraftableRecipeEconomics([
      { item_name: `Carbon Ore ${suffix}`, quantity: 12 },
    ], profileId, 10)

    expect(results).toHaveLength(2)
    expect(results[0].recipe_name).toBe(`Exfoliate Graphene ${suffix}`)
    expect(results[0].max_craftable).toBe(2)
    expect(results[0].estimated_raw_input_bid_value).toBe(30)
    expect(results[0].estimated_revenue).toBe(40)
    expect(results[0].estimated_profit_vs_raw_inputs).toBe(10)
    expect(results[0].estimated_total_profit_vs_raw_inputs).toBe(20)

    expect(results[1].recipe_name).toBe(`Bad Trade ${suffix}`)
    expect(results[1].estimated_profit_vs_raw_inputs).toBeLessThan(0)
  })
})
