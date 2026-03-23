import { describe, expect, it } from 'vitest'

import {
  findExternalLinks,
  parseExternalLinkTarget,
} from './externalLinks'

describe('externalLinks', () => {
  it('parses only http and https targets', () => {
    expect(parseExternalLinkTarget('https://example.com/docs')).toEqual({
      raw: 'https://example.com/docs',
      url: 'https://example.com/docs',
    })
    expect(parseExternalLinkTarget('mailto:test@example.com')).toBeNull()
    expect(parseExternalLinkTarget('ftp://example.com/file.txt')).toBeNull()
  })

  it('finds plain external links and trims trailing punctuation', () => {
    expect(
      findExternalLinks('Open https://example.com/docs). right now.'),
    ).toEqual([
      expect.objectContaining({
        fullMatch: 'https://example.com/docs',
        target: {
          raw: 'https://example.com/docs',
          url: 'https://example.com/docs',
        },
      }),
    ])
  })

  it('finds markdown external links without double-linking the href', () => {
    expect(
      findExternalLinks(
        'See [docs](https://example.com/docs) and then [site](https://openai.com).',
      ),
    ).toEqual([
      expect.objectContaining({
        fullMatch: '[docs](https://example.com/docs)',
      }),
      expect.objectContaining({
        fullMatch: '[site](https://openai.com)',
      }),
    ])
  })
})
