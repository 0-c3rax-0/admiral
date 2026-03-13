import { describe, expect, test } from 'bun:test'
import { parseShipKbHtml } from './ship-kb'

describe('parseShipKbHtml', () => {
  test('classifies commercial freighters and industrial mining ships from KB HTML', () => {
    const html = `
      <section class="ship-category mt-3" id="commercial">
        <h2>Commercial <span class="text-muted">(10 classes)</span></h2>
        <section class="ship-class mt-3" id="commercial--freighter">
          <h3>Freighter</h3>
          <table>
            <tbody>
              <tr>
                <td>Floor Price</td>
                <td class="num">1</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>
      <section class="ship-category mt-3" id="industrial">
        <h2>Industrial <span class="text-muted">(18 classes)</span></h2>
        <section class="ship-class mt-3" id="industrial--mining">
          <h3>Mining</h3>
          <table>
            <tbody>
              <tr>
                <td>Prospect</td>
                <td class="num">0</td>
              </tr>
            </tbody>
          </table>
        </section>
      </section>
    `

    const ships = parseShipKbHtml(html)

    expect(ships).toEqual([
      {
        name: 'Floor Price',
        category: 'Commercial',
        className: 'Freighter',
        purpose: 'freighter',
      },
      {
        name: 'Prospect',
        category: 'Industrial',
        className: 'Mining',
        purpose: 'mining',
      },
    ])
  })
})
