// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { buildArchitectureSchema } from './projectArchitectureAgent'

describe('buildArchitectureSchema', () => {
  it('requires every nested object property when additional properties are disallowed', () => {
    const schema = JSON.parse(buildArchitectureSchema()) as {
      properties: {
        modules: {
          items: {
            additionalProperties: boolean
            properties: Record<string, unknown>
            required: string[]
          }
        }
        interactions: {
          items: {
            additionalProperties: boolean
            properties: Record<string, unknown>
            required: string[]
          }
        }
      }
    }

    const moduleItems = schema.properties.modules.items
    expect(moduleItems.additionalProperties).toBe(false)
    expect(moduleItems.required.sort()).toEqual(
      Object.keys(moduleItems.properties).sort(),
    )

    const interactionItems = schema.properties.interactions.items
    expect(interactionItems.additionalProperties).toBe(false)
    expect(interactionItems.required.sort()).toEqual(
      Object.keys(interactionItems.properties).sort(),
    )
  })
})
