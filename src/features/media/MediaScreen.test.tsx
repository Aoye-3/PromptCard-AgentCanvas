import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppShell } from '@/components/app/AppShell'
import { I18nProvider } from '@/i18n'
import type { IPromptProject } from '@/models/PromptHistory.model'
import { MediaAnalysisDialog } from './MediaAnalysisDialog'
import { recentCaptureFixtures } from './media-fixtures'
import { MediaScreen } from './MediaScreen'

describe('MediaScreen', () => {
  it('renders the recent captures page shell and metadata affordances', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <MediaScreen />
      </I18nProvider>
    )

    expect(markup).toContain('data-media-screen')
    expect(markup).toContain('grid-cols-3')
    expect(markup).toContain('lg:grid-cols-[minmax(0,1fr)_420px]')
  })

  it('renders Media as a top-level side navigation item', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AppShell
          activeTab="media"
          setActiveTab={() => undefined}
          projectMode="home"
          saveStatus="saved"
          saveStatusText="Saved"
          activeProject={null}
          projectSearchTerm=""
          onProjectSearchTermChange={() => undefined}
          onCreateProject={() => undefined}
          onShowProjectTrash={() => undefined}
        >
          <MediaScreen />
        </AppShell>
      </I18nProvider>
    )

    expect(markup).toContain('data-app-side-nav')
    expect(markup).toContain('data-project-search-input')
    expect(markup).toContain('data-app-project-utilities')
    expect(markup).toContain('data-side-nav-item="SkillHub"')
    expect(markup.match(/data-side-nav-item=/g)?.length).toBe(10)
    expect(markup).toContain('data-app-nav-tab="files"')
    expect(markup).toContain('data-active="true"')
    expect(markup).not.toContain('grid-cols-5')
  })

  it('renders Capture Bar as an active top-level side navigation item', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AppShell
          activeTab="capture"
          setActiveTab={() => undefined}
          projectMode="home"
          saveStatus="saved"
          saveStatusText="Saved"
          activeProject={null}
          projectSearchTerm=""
          onProjectSearchTermChange={() => undefined}
          onCreateProject={() => undefined}
          onShowProjectTrash={() => undefined}
        >
          <div />
        </AppShell>
      </I18nProvider>
    )

    expect(markup).toContain('data-side-nav-item="捕获栏"')
    expect(markup).toContain('data-active="true"')
    expect(markup.match(/data-side-nav-item=/g)?.length).toBe(10)
  })

  it('hides the primary navigation in project builder mode', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AppShell
          activeTab="projects"
          setActiveTab={() => undefined}
          projectMode="builder"
          saveStatus="saved"
          saveStatusText="Saved"
          activeProject={{ id: 'project-1', title: 'Canvas Project' } as IPromptProject}
          projectSearchTerm=""
          onProjectSearchTermChange={() => undefined}
          onCreateProject={() => undefined}
          onShowProjectTrash={() => undefined}
        >
          <div data-builder-child />
        </AppShell>
      </I18nProvider>
    )

    expect(markup).not.toContain('data-app-side-nav')
    expect(markup).not.toContain('data-project-search-input')
    expect(markup).not.toContain('data-side-nav-item=')
    expect(markup).toContain('Canvas Project')
    expect(markup).toContain('data-builder-child')
  })

  it('renders the fixed project trash utility inside the side navigation', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AppShell
          activeTab="agents"
          setActiveTab={() => undefined}
          projectMode="home"
          saveStatus="saved"
          saveStatusText="Saved"
          activeProject={null}
          projectSearchTerm=""
          onProjectSearchTermChange={() => undefined}
          onCreateProject={() => undefined}
          onShowProjectTrash={() => undefined}
        >
          <div />
        </AppShell>
      </I18nProvider>
    )

    expect(markup).toContain('data-app-side-nav')
    expect(markup).toContain('data-project-search-input')
    expect(markup).toContain('data-app-project-utilities')
    expect(markup).toContain('data-side-nav-item="回收站"')
    expect(markup).not.toContain('data-side-nav-item="模板库"')
    expect(markup.match(/data-side-nav-item=/g)?.length).toBe(10)
  })

  it('renders Update as a top-level side navigation item', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AppShell
          activeTab="updates"
          setActiveTab={() => undefined}
          projectMode="home"
          saveStatus="saved"
          saveStatusText="Saved"
          activeProject={null}
          projectSearchTerm=""
          onProjectSearchTermChange={() => undefined}
          onCreateProject={() => undefined}
          onShowProjectTrash={() => undefined}
        >
          <div />
        </AppShell>
      </I18nProvider>
    )

    expect(markup).toContain('data-side-nav-item="更新"')
    expect(markup).toContain('data-active="true"')
    expect(markup.match(/data-side-nav-item=/g)?.length).toBe(10)
  })

  it('renders the media analysis dialog shell for a selected capture', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <MediaAnalysisDialog capture={recentCaptureFixtures[0]} onClose={() => undefined} />
      </I18nProvider>
    )

    expect(markup).toContain('data-media-analysis-dialog')
    expect(markup).toContain('data-media-dossier')
    expect(markup).toContain('data-media-analysis-preview')
    expect(markup).toContain('data-media-analysis-prompt')
    expect(markup).toContain('data-media-analysis-note')
    expect(markup).toContain('data-media-agent-workspace')
    expect(markup).toContain('data-media-analysis-chat')
    expect(markup).toContain('data-media-prompt-preview')
    expect(markup.indexOf('data-media-analysis-preview')).toBeLessThan(markup.indexOf('data-media-prompt-preview'))
    expect(markup.indexOf('data-media-prompt-preview')).toBeLessThan(markup.indexOf('data-media-analysis-prompt'))
    expect(markup).toContain('data-media-prompt-language')
    expect(markup).toContain('aria-label="使用中文 Prompt"')
    expect(markup).toContain('aria-label="Use English Prompt"')
    expect(markup).toContain('aria-label="使用混合 Prompt" aria-pressed="true"')
    expect(markup).toContain('data-media-analysis-title="true" class="min-w-0"')
    expect(markup).toContain('data-media-analysis-close="true" class="shrink-0')
    expect(markup).toContain('生成预览')
    expect(markup).toContain('写入 Prompt 库')
  })

  it('does not render the media analysis dialog when closed', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <MediaAnalysisDialog capture={null} onClose={() => undefined} />
      </I18nProvider>
    )

    expect(markup).not.toContain('data-media-analysis-dialog')
  })
})
