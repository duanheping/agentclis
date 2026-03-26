import { describe, expect, it } from 'vitest'

import {
  findFileReferences,
  findMarkdownFileReferences,
  findPlainFileReferences,
  parseFileReferenceTarget,
} from './fileReferences'

describe('parseFileReferenceTarget', () => {
  it('parses Windows file references with hash-based line markers', () => {
    expect(
      parseFileReferenceTarget('C:/repo/src/main.c#L42'),
    ).toEqual({
      raw: 'C:/repo/src/main.c#L42',
      path: 'C:/repo/src/main.c',
      line: 42,
      column: undefined,
    })
  })

  it('parses absolute paths with colon-based line and column markers', () => {
    expect(
      parseFileReferenceTarget('/workspace/src/app.ts:12:3'),
    ).toEqual({
      raw: '/workspace/src/app.ts:12:3',
      path: '/workspace/src/app.ts',
      line: 12,
      column: 3,
    })
  })

  it('rejects non-file links and relative paths', () => {
    expect(parseFileReferenceTarget('README.md')).toBeNull()
    expect(parseFileReferenceTarget('https://example.com/test.ts')).toBeNull()
  })

  it('expands home-relative paths when a home directory is provided', () => {
    expect(
      parseFileReferenceTarget('~\\Downloads\\report.md', {
        homeDir: 'C:\\Users\\hduan10',
      }),
    ).toEqual({
      raw: '~\\Downloads\\report.md',
      path: 'C:\\Users\\hduan10\\Downloads\\report.md',
      line: undefined,
      column: undefined,
    })
  })
})

describe('findMarkdownFileReferences', () => {
  it('returns only markdown links that point at absolute file paths', () => {
    expect(
      findMarkdownFileReferences(
        'See [main.c](C:/repo/src/main.c#L42) and [docs](https://example.com/docs).',
      ),
    ).toEqual([
      {
        fullMatch: '[main.c](C:/repo/src/main.c#L42)',
        label: 'main.c',
        href: 'C:/repo/src/main.c#L42',
        startIndex: 4,
        endIndex: 36,
        target: {
          raw: 'C:/repo/src/main.c#L42',
          path: 'C:/repo/src/main.c',
          line: 42,
          column: undefined,
        },
      },
    ])
  })
})

describe('findPlainFileReferences', () => {
  it('finds plain home-relative file paths in terminal text', () => {
    expect(
      findPlainFileReferences('Show ~\\Downloads\\ECG2_Callout_Logic_Analysis.md now'),
    ).toEqual([
      {
        fullMatch: '~\\Downloads\\ECG2_Callout_Logic_Analysis.md',
        startIndex: 5,
        endIndex: 47,
        target: {
          raw: '~\\Downloads\\ECG2_Callout_Logic_Analysis.md',
          path: '~\\Downloads\\ECG2_Callout_Logic_Analysis.md',
          line: undefined,
          column: undefined,
        },
      },
    ])
  })
})

describe('findFileReferences', () => {
  it('combines markdown and plain file references without double-linking markdown paths', () => {
    expect(
      findFileReferences(
        'Use [main.c](C:/repo/src/main.c#L42) or ~\\Downloads\\report.md.',
      ),
    ).toEqual([
      {
        fullMatch: '[main.c](C:/repo/src/main.c#L42)',
        label: 'main.c',
        href: 'C:/repo/src/main.c#L42',
        startIndex: 4,
        endIndex: 36,
        target: {
          raw: 'C:/repo/src/main.c#L42',
          path: 'C:/repo/src/main.c',
          line: 42,
          column: undefined,
        },
      },
      {
        fullMatch: '~\\Downloads\\report.md',
        startIndex: 40,
        endIndex: 61,
        target: {
          raw: '~\\Downloads\\report.md',
          path: '~\\Downloads\\report.md',
          line: undefined,
          column: undefined,
        },
      },
    ])
  })
})

describe('parseFileReferenceTarget edge cases', () => {
  it('returns null for empty/whitespace input', () => {
    expect(parseFileReferenceTarget('')).toBeNull()
    expect(parseFileReferenceTarget('   ')).toBeNull()
  })

  it('parses hash-based line and column markers', () => {
    expect(parseFileReferenceTarget('C:/src/main.c#L42C10')).toEqual({
      raw: 'C:/src/main.c#L42C10',
      path: 'C:/src/main.c',
      line: 42,
      column: 10,
    })
  })

  it('parses colon-based line-only markers', () => {
    expect(parseFileReferenceTarget('/workspace/app.ts:12')).toEqual({
      raw: '/workspace/app.ts:12',
      path: '/workspace/app.ts',
      line: 12,
      column: undefined,
    })
  })

  it('resolves file:// URIs with drive letters', () => {
    expect(parseFileReferenceTarget('file:///C:/repo/main.ts')).toEqual({
      raw: 'file:///C:/repo/main.ts',
      path: 'C:/repo/main.ts',
      line: undefined,
      column: undefined,
    })
  })

  it('resolves file:// URIs with Unix-style paths', () => {
    expect(parseFileReferenceTarget('file:///workspace/app.ts')).toEqual({
      raw: 'file:///workspace/app.ts',
      path: '/workspace/app.ts',
      line: undefined,
      column: undefined,
    })
  })

  it('rejects non-file protocol URIs', () => {
    expect(parseFileReferenceTarget('https://example.com/test.ts')).toBeNull()
  })

  it('rejects bare file names without path', () => {
    expect(parseFileReferenceTarget('package.json')).toBeNull()
    expect(parseFileReferenceTarget('README.md')).toBeNull()
  })

  it('handles UNC paths', () => {
    const result = parseFileReferenceTarget('\\\\server\\share\\file.txt')
    expect(result).not.toBeNull()
    expect(result!.path).toBe('\\\\server\\share\\file.txt')
  })

  it('parses paths ending with a dot (valid absolute paths)', () => {
    // parseFileReferenceTarget resolves absolute paths; dot-ending is
    // filtered later by looksLikeFileReferencePath in findPlainFileReferences
    expect(parseFileReferenceTarget('C:/repo/.')).not.toBeNull()
    expect(parseFileReferenceTarget('C:/repo/..')).not.toBeNull()
  })

  it('handles home-relative with forward slashes', () => {
    expect(parseFileReferenceTarget('~/docs/file.md', { homeDir: '/home/user' })).toEqual({
      raw: '~/docs/file.md',
      path: '/home/user/docs/file.md',
      line: undefined,
      column: undefined,
    })
  })

  it('handles home-relative with trailing slash on homeDir', () => {
    expect(
      parseFileReferenceTarget('~\\file.txt', { homeDir: 'C:\\Users\\user\\' }),
    ).toEqual({
      raw: '~\\file.txt',
      path: 'C:\\Users\\user\\file.txt',
      line: undefined,
      column: undefined,
    })
  })

  it('returns home-relative path as-is when no homeDir', () => {
    expect(parseFileReferenceTarget('~/docs/file.md')).toEqual({
      raw: '~/docs/file.md',
      path: '~/docs/file.md',
      line: undefined,
      column: undefined,
    })
  })

  it('handles Windows drive letter both cases', () => {
    expect(parseFileReferenceTarget('c:\\repo\\file.ts')).not.toBeNull()
    expect(parseFileReferenceTarget('D:\\repo\\file.ts')).not.toBeNull()
  })
})

describe('findFileReferences edge cases', () => {
  it('returns empty for text with no file references', () => {
    expect(findFileReferences('just plain text here')).toEqual([])
    expect(findFileReferences('')).toEqual([])
  })

  it('finds multiple plain file references', () => {
    const text = 'See C:/src/a.ts and C:/src/b.ts for details'
    const refs = findFileReferences(text)
    expect(refs).toHaveLength(2)
  })

  it('finds file references with trailing punctuation trimmed when possible', () => {
    // Comma after .ts makes 'main.ts,' — the trimmer checks if the
    // candidate looks like a file reference path, so trailing comma
    // is included when the basename still has a valid extension.
    const text = 'Check C:/src/main.ts and C:/src/test.ts.'
    const refs = findPlainFileReferences(text)
    expect(refs).toHaveLength(2)
    expect(refs[0].target.path).toBe('C:/src/main.ts')
    expect(refs[1].target.path).toBe('C:/src/test.ts')
  })

  it('does not double-link markdown file references as plain', () => {
    const text = '[file](C:/src/main.ts) and C:/src/other.ts'
    const refs = findFileReferences(text)
    expect(refs).toHaveLength(2)
    expect(refs[0].fullMatch).toBe('[file](C:/src/main.ts)')
    expect(refs[1].fullMatch).toBe('C:/src/other.ts')
  })
})
