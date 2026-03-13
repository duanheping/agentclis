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
