import { describe, expect, it } from 'vitest'

import {
  findExternalLinks,
  findMarkdownExternalLinks,
  findPlainExternalLinks,
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

  it('returns null for empty or whitespace input', () => {
    expect(parseExternalLinkTarget('')).toBeNull()
    expect(parseExternalLinkTarget('   ')).toBeNull()
  })

  it('returns null for invalid URLs', () => {
    expect(parseExternalLinkTarget('not-a-url')).toBeNull()
    expect(parseExternalLinkTarget('://missing-protocol')).toBeNull()
  })

  it('parses http URLs (not just https)', () => {
    expect(parseExternalLinkTarget('http://example.com')).toEqual({
      raw: 'http://example.com',
      url: 'http://example.com/',
    })
  })

  it('parses URLs with query parameters and fragments', () => {
    const result = parseExternalLinkTarget('https://example.com/search?q=hello&page=1#results')
    expect(result).not.toBeNull()
    expect(result!.url).toContain('q=hello')
    expect(result!.url).toContain('#results')
  })

  it('parses URLs with ports', () => {
    const result = parseExternalLinkTarget('https://localhost:3000/api')
    expect(result).not.toBeNull()
    expect(result!.url).toContain('3000')
  })

  it('rejects javascript: and data: protocols', () => {
    expect(parseExternalLinkTarget('javascript:alert(1)')).toBeNull()
    expect(parseExternalLinkTarget('data:text/html,hello')).toBeNull()
  })

  it('findMarkdownExternalLinks finds labeled links', () => {
    const matches = findMarkdownExternalLinks('[GitHub](https://github.com)')
    expect(matches).toHaveLength(1)
    expect(matches[0].label).toBe('GitHub')
    expect(matches[0].href).toBe('https://github.com')
  })

  it('findMarkdownExternalLinks ignores non-http markdown links', () => {
    const matches = findMarkdownExternalLinks('[file](C:/repo/test.ts)')
    expect(matches).toHaveLength(0)
  })

  it('findMarkdownExternalLinks handles multiple links', () => {
    const text = '[A](https://a.com) text [B](https://b.com)'
    const matches = findMarkdownExternalLinks(text)
    expect(matches).toHaveLength(2)
    expect(matches[0].label).toBe('A')
    expect(matches[1].label).toBe('B')
  })

  it('findPlainExternalLinks finds URLs at start of text', () => {
    const matches = findPlainExternalLinks('https://example.com is a site')
    expect(matches).toHaveLength(1)
    expect(matches[0].fullMatch).toBe('https://example.com')
  })

  it('findPlainExternalLinks trims trailing comma and period', () => {
    const matches = findPlainExternalLinks('visit https://example.com, or https://other.com.')
    expect(matches).toHaveLength(2)
    expect(matches[0].fullMatch).toBe('https://example.com')
    expect(matches[1].fullMatch).toBe('https://other.com')
  })

  it('findPlainExternalLinks skips URLs already covered by markdown links', () => {
    const text = 'See [docs](https://example.com) and visit https://other.com'
    const plain = findPlainExternalLinks(text)
    expect(plain).toHaveLength(1)
    expect(plain[0].fullMatch).toBe('https://other.com')
  })

  it('findExternalLinks returns sorted results mixing markdown and plain', () => {
    const text = 'Visit https://first.com then [second](https://second.com)'
    const all = findExternalLinks(text)
    expect(all).toHaveLength(2)
    expect(all[0].startIndex).toBeLessThan(all[1].startIndex)
  })

  it('findExternalLinks returns empty for no links', () => {
    expect(findExternalLinks('no links here')).toEqual([])
    expect(findExternalLinks('')).toEqual([])
  })

  it('finds URLs wrapped in parentheses', () => {
    const matches = findPlainExternalLinks('(https://example.com)')
    expect(matches).toHaveLength(1)
    expect(matches[0].fullMatch).toBe('https://example.com')
  })

  it('finds URLs wrapped in brackets', () => {
    const matches = findPlainExternalLinks('[https://example.com]')
    expect(matches).toHaveLength(1)
    expect(matches[0].fullMatch).toBe('https://example.com')
  })
})
