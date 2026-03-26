import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renderSpy = vi.hoisted(() => vi.fn())
const createRootSpy = vi.hoisted(() =>
  vi.fn(() => ({
    render: renderSpy,
  })),
)
const AppView = vi.hoisted(() => function AppView() { return null })
const SkillSyncView = vi.hoisted(() => function SkillSyncView() { return null })
const AnalysisView = vi.hoisted(() => function AnalysisView() { return null })

vi.mock('react-dom/client', () => ({
  createRoot: createRootSpy,
}))

vi.mock('./App.tsx', () => ({
  default: AppView,
}))

vi.mock('./components/SkillSyncWindow.tsx', () => ({
  SkillSyncWindow: SkillSyncView,
}))

vi.mock('./components/AnalysisWindow.tsx', () => ({
  AnalysisWindow: AnalysisView,
}))

async function importEntryPoint(search = ''): Promise<void> {
  vi.resetModules()
  createRootSpy.mockClear()
  renderSpy.mockClear()
  document.body.innerHTML = '<div id="root"></div>'
  history.pushState({}, '', `/${search}`)
  await import('./main.tsx')
}

describe('main entrypoint', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders the main app by default', async () => {
    await importEntryPoint()

    expect(createRootSpy).toHaveBeenCalledWith(
      document.getElementById('root'),
    )
    expect(renderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AppView,
      }),
    )
  })

  it('renders the skill sync window for the dedicated view', async () => {
    await importEntryPoint('?view=skill-sync')

    expect(renderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SkillSyncView,
      }),
    )
  })

  it('renders the analysis window for the dedicated view', async () => {
    await importEntryPoint('?view=analysis')

    expect(renderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AnalysisView,
      }),
    )
  })
})
