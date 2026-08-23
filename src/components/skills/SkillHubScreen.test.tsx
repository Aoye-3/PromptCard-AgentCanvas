import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SkillHubScreen } from './SkillHubScreen'

describe('SkillHubScreen', () => {
  it('shows builtin and external skill metadata without script execution controls', () => {
    const markup = renderToStaticMarkup(<SkillHubScreen initialSkills={[
      {
        id: 'SKL-canvas', slug: 'canvas-prompt-editor', name: 'Canvas Prompt Editor',
        description: 'Protects template segments.', source: 'builtin', trustState: 'first-party',
        capabilityId: 'canvas.prompt.edit', toolDependencies: ['emit_canvas_text_update'],
        revision: 1, digest: 'sha256:canvas',
        referenceCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAV', lifecycleStatus: 'active'
      },
      {
        id: 'SKL-tone', slug: 'tone-helper', name: 'Tone Helper',
        description: 'External writing helper.', source: 'external', trustState: 'trusted',
        toolDependencies: ['search_prompt_library'], revision: 2, digest: 'sha256:tone',
        referenceCode: 'SKL-01ARZ3NDEKTSV4RRFFQ69G5FAW', lifecycleStatus: 'active'
      }
    ]} />)

    expect(markup).toContain('SkillHub')
    expect(markup).toContain('Canvas Prompt Editor')
    expect(markup).toContain('Tone Helper')
    expect(markup).toContain('emit_canvas_text_update')
    expect(markup).toContain('first-party')
    expect(markup).not.toContain('运行脚本')
  })
})
