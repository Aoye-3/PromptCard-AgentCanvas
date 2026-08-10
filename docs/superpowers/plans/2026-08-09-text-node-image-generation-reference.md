# Text Node Image Generation Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a text-node context-menu action that sends a named, removable text snapshot to the image-generation composer and compiles user-entered Prompt text before all text-reference content.

**Architecture:** Store text-node snapshots separately from the editable `PromptDocument` in `ImageGenerationComposerDraft`. Render those snapshots as compact tags, then append their text to a cloned Prompt document at the existing request boundary. The backend contract and image-reference path remain unchanged.

**Tech Stack:** React 18, TypeScript, Vitest, react-test-renderer, Vite, Tailwind CSS.

## Global Constraints

- Work only in the current repository and branch; do not create a worktree or alternate checkout.
- Preserve unrelated working-tree changes and existing untracked Playwright screenshots.
- Text references are send-time snapshots with `nodeId`, `label`, `text`, and stable `order`.
- User-entered Prompt content must compile before all text-reference content.
- Do not add backend fields, storage tables, runtime protocol variants, or dependencies.
- Re-sending the same node refreshes its label and text without changing its order.
- New image conversations clear text references; removing a tag never changes the canvas node.

---

### Task 1: Text-reference draft model and request compilation

**Files:**
- Modify: `src/domain/image-generation/project-conversation.ts`
- Test: `src/domain/image-generation/project-conversation.test.ts`

**Interfaces:**
- Produces: `ProjectImageGenerationTextReference` with `{ nodeId: string; label: string; text: string; order: number }`.
- Produces: backward-compatible `ImageGenerationComposerDraft.textReferences?`.
- Produces: `compileConversationPromptDocument(draft): PromptDocument`.
- Produces: `removeConversationTextReference(draft, nodeId): ImageGenerationComposerDraft`.
- Updates: `injectCanvasNodesIntoDraft` so text nodes become snapshots instead of visible Prompt text.

- [ ] **Step 1: Write failing domain tests**

```ts
it('stores and refreshes one named reference per text node', () => {
  const source = {
    ...createFreeCanvasTextNode('First body', { x: 0, y: 0 }, 1),
    id: 'text-1',
    title: '建筑设定'
  }
  const initial = injectCanvasNodesIntoDraft(createEmptyConversationDraft(), [source]).draft
  const refreshed = injectCanvasNodesIntoDraft(initial, [{
    ...source,
    title: '黄鹤楼设定',
    segments: [{ ...source.segments[0], text: 'Updated body' }]
  }]).draft

  expect(refreshed.textReferences).toEqual([
    { nodeId: 'text-1', label: '黄鹤楼设定', text: 'Updated body', order: 0 }
  ])
  expect(promptDocumentPlainText(refreshed.promptDocument)).toBe('')
})

it('compiles user Prompt before ordered text references', () => {
  const request = buildConversationGenerationRequest('project-1', 'conversation-1', {
    ...createEmptyConversationDraft(),
    promptDocument: { version: 1, segments: [{ type: 'text', text: 'User instruction' }] },
    textReferences: [
      { nodeId: 'b', label: 'B', text: 'Second reference', order: 1 },
      { nodeId: 'a', label: 'A', text: 'First reference', order: 0 }
    ]
  })

  expect(promptDocumentPlainText(request.promptDocument)).toBe(
    'User instruction\nFirst reference\nSecond reference'
  )
})
```

Add a removal test that verifies the visible Prompt remains unchanged.

- [ ] **Step 2: Run tests and verify RED**

```powershell
npx.cmd vitest run src/domain/image-generation/project-conversation.test.ts --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because text-reference fields/helpers do not exist and text injection still mutates `promptDocument`.

- [ ] **Step 3: Implement the minimal model and compiler**

```ts
export interface ProjectImageGenerationTextReference {
  nodeId: string
  label: string
  text: string
  order: number
}

export const compileConversationPromptDocument = (
  draft: ImageGenerationComposerDraft
): PromptDocument => [...(draft.textReferences || [])]
  .sort((left, right) => left.order - right.order)
  .reduce(
    (document, reference) => appendPromptText(document, reference.text.trim()),
    clonePromptDocument(draft.promptDocument)
  )
```

Set `textReferences: []` in `createEmptyConversationDraft`. Upsert text nodes by `nodeId` inside `injectCanvasNodesIntoDraft`, retaining the existing order when refreshed. Add `removeConversationTextReference` and renumber survivors. Use `compileConversationPromptDocument` inside `buildConversationGenerationRequest`.

- [ ] **Step 4: Run the Task 1 tests and verify GREEN**

Run the Step 2 command. Expected: all project-conversation tests pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- src/domain/image-generation/project-conversation.ts src/domain/image-generation/project-conversation.test.ts
git commit -m "feat: model image generation text references"
```

---

### Task 2: Text-node context command and panel routing

**Files:**
- Modify: `src/components/canvas/image-actions/CanvasTextNodeContextMenu.tsx`
- Modify: `src/components/canvas/FreeCanvasBuilderScreen.tsx`
- Test: `src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx`

**Interfaces:**
- Consumes: `injectCanvasNodesIntoDraft` and `compileConversationPromptDocument` from Task 1.
- Produces: `TextNodeContextCommand` member `send-to-image-generation`.
- Produces: menu label `发送到图片生成参考`.

- [ ] **Step 1: Write failing routing tests**

Extend the existing text-node context-menu test:

```ts
expect(labels).toEqual(expect.arrayContaining([
  '复制', '补全', '发送到 Agent', '发送到图片生成参考', '删除'
]))

act(() => sendToImageGeneration.props.onClick())

expect(renderer.root.findByProps({
  'data-free-canvas-image-generation-panel': true
})).toBeTruthy()
```

Assert that an empty node, preview mode, and disabled image-generation feature each disable the new action.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx.cmd vitest run src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx -t "text node context menu" --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because the new command, label, and routing callback do not exist.

- [ ] **Step 3: Implement the command and route**

Extend the union:

```ts
export type TextNodeContextCommand =
  | 'copy'
  | 'complete'
  | 'send-to-agent'
  | 'send-to-image-generation'
  | 'delete'
```

Render the new item after `发送到 Agent` with a text/image icon and an `imageGenerationDisabled` prop. In `FreeCanvasBuilderScreen`, inject exactly the selected text node, show any rejection, switch `rightPanelMode` to `image-generation`, and expand the panel. Disable the action for preview mode, a disabled image-generation feature, or empty text.

Change required-Prompt validation to inspect:

```ts
promptDocumentPlainText(compileConversationPromptDocument(imageComposerDraft)).trim()
```

This allows a text reference without manually typed Prompt text.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: focused context-menu tests pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- src/components/canvas/image-actions/CanvasTextNodeContextMenu.tsx src/components/canvas/FreeCanvasBuilderScreen.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx
git commit -m "feat: route text nodes to image generation"
```

---

### Task 3: Compact text-reference tags and removal

**Files:**
- Modify: `src/components/canvas/image-generation/types.ts`
- Modify: `src/components/canvas/image-generation/ImageGenerationComposer.tsx`
- Modify: `src/components/canvas/FreeCanvasBuilderScreen.tsx`
- Test: `src/components/canvas/image-generation/ImageGenerationComposer.test.tsx`
- Test: `src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx`

**Interfaces:**
- Consumes: `ProjectImageGenerationTextReference` and `removeConversationTextReference`.
- Produces: `ImageGenerationComposerProps.textReferences` and `onRemoveTextReference`.

- [ ] **Step 1: Write failing tag tests**

```tsx
const onRemoveTextReference = vi.fn()
const renderer = create(
  <ImageGenerationComposer
    {...baseProps}
    textReferences={[{ nodeId: 'text-1', label: '黄鹤楼设定' }]}
    onRemoveTextReference={onRemoveTextReference}
  />
)

const tag = renderer.root.findByProps({
  'data-image-generation-text-reference': 'text-1'
})
expect(tag.children.join('')).toContain('黄鹤楼设定')

act(() => renderer.root.findByProps({
  'aria-label': '移除文字参考 黄鹤楼设定'
}).props.onClick())
expect(onRemoveTextReference).toHaveBeenCalledWith('text-1')
```

- [ ] **Step 2: Run the composer test and verify RED**

```powershell
npx.cmd vitest run src/components/canvas/image-generation/ImageGenerationComposer.test.tsx --maxWorkers=1 --minWorkers=1
```

Expected: FAIL because no text-reference tag is rendered.

- [ ] **Step 3: Implement tags and removal wiring**

Add props:

```ts
textReferences?: Array<{ nodeId: string; label: string }>
onRemoveTextReference?: (nodeId: string) => void
```

Render text-reference tags in the existing `本轮图片输入` row before image thumbnails. Each tag uses a `FileText` icon, truncated node name, `data-image-generation-text-reference`, and an accessible small `X` removal button.

Pass sorted references and removal from `FreeCanvasBuilderScreen`:

```ts
textReferences: [...(imageComposerDraft.textReferences || [])]
  .sort((left, right) => left.order - right.order)
  .map(({ nodeId, label }) => ({ nodeId, label })),
onRemoveTextReference: nodeId => setImageComposerDraft(current => (
  removeConversationTextReference(current, nodeId)
))
```

- [ ] **Step 4: Run tag and routing tests and verify GREEN**

```powershell
npx.cmd vitest run src/components/canvas/image-generation/ImageGenerationComposer.test.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx --maxWorkers=1 --minWorkers=1
```

Expected: both files pass.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- src/components/canvas/image-generation/types.ts src/components/canvas/image-generation/ImageGenerationComposer.tsx src/components/canvas/FreeCanvasBuilderScreen.tsx src/components/canvas/image-generation/ImageGenerationComposer.test.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx
git commit -m "feat: show image generation text reference tags"
```

---

### Task 4: Full verification

**Files:**
- Verify only; do not change unrelated lint failures.

- [ ] **Step 1: Run the full frontend suite**

```powershell
npm.cmd run test:frontend
```

Expected: all four shards pass.

- [ ] **Step 2: Run production build and changed-file lint**

```powershell
npm.cmd run build
npx.cmd eslint src/domain/image-generation/project-conversation.ts src/domain/image-generation/project-conversation.test.ts src/components/canvas/image-actions/CanvasTextNodeContextMenu.tsx src/components/canvas/FreeCanvasBuilderScreen.tsx src/components/canvas/FreeCanvasBuilderScreen.image-generation.test.tsx src/components/canvas/image-generation/types.ts src/components/canvas/image-generation/ImageGenerationComposer.tsx src/components/canvas/image-generation/ImageGenerationComposer.test.tsx --report-unused-disable-directives --max-warnings 0
```

Expected: build and changed-file lint exit with code 0. Report existing full-repository lint failures separately if they remain.

- [ ] **Step 3: Verify the real browser flow without persisting test data**

Use the local app with non-GET requests intercepted. Open a free-canvas project, right-click a non-empty text node, click `发送到图片生成参考`, and assert the image-generation panel, named text tag, removal button, and zero `pageerror` events.

Type `User instruction` and inspect an intercepted generation request. Its `promptDocument` plain text must start with `User instruction` and contain the text-node snapshot afterward.

- [ ] **Step 4: Inspect the final diff**

```powershell
git diff --check
git status --short --branch
git log --oneline -5
```

Expected: only planned files plus pre-existing unrelated working-tree items are present; no whitespace errors.

