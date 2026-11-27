import { describe, expect, test } from 'bun:test'
import { KATEX_REHYPE_OPTIONS, KATEX_RENDER_OPTIONS, renderMarkdownMath, remarkCjkMathHint } from './markdown-math'

/** 捕获 console.warn，避免 KaTeX 或提示语污染测试输出。 */
function captureWarnings(run: () => void): string[] {
  const original = console.warn
  const warnings: string[] = []
  console.warn = (...values: unknown[]): void => {
    warnings.push(values.map((value) => String(value)).join(' '))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return warnings
}

describe('Markdown 数学渲染选项', () => {
  test('Given rehype-katex 与 renderMarkdownMath When 读取选项 Then 统一 strict=ignore 且保留 throwOnError=false', () => {
    expect(KATEX_REHYPE_OPTIONS).toEqual({ throwOnError: false, strict: 'ignore' })
    // rehype-katex 内部强制 throwOnError=true，strict 才是抑制 unicodeTextInMathMode 的关键项。
    expect(KATEX_REHYPE_OPTIONS.strict).toBe('ignore')
    // 编辑器预览面使用的渲染选项必须与 rehype 面保持同一语义，避免两个渲染面告警行为不一致。
    expect(KATEX_RENDER_OPTIONS).toMatchObject({
      output: 'htmlAndMathml',
      throwOnError: false,
      strict: 'ignore',
    })
  })

  test('Given 含中文的公式 When 渲染 Then 输出 HTML 且不再产生 unicodeTextInMathMode 逐字符告警', () => {
    const latex = 'P(中文|上下文)=\\frac{中文命中}{总样本}'
    let html = ''
    const warnings = captureWarnings(() => {
      html = renderMarkdownMath(latex, false)
    })
    expect(html).toContain('katex')
    expect(warnings.filter((warning) => warning.includes('unicodeTextInMathMode'))).toEqual([])
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('[Markdown 数学渲染]')
    expect(warnings[0]).toContain('strict=ignore')
  })

  test('Given 同一中文公式重复渲染 When 渲染两次 Then 只保留一条可定位提示', () => {
    const latex = '\\text{重复渲染的公式}=1'
    const warnings = captureWarnings(() => {
      renderMarkdownMath(latex)
      renderMarkdownMath(latex)
      renderMarkdownMath(latex)
    })
    expect(warnings.filter((warning) => warning.includes('[Markdown 数学渲染]')).length).toBe(1)
  })

  test('Given 纯 ASCII 公式 When 渲染 Then 不产生额外提示', () => {
    const warnings = captureWarnings(() => {
      const html = renderMarkdownMath('E=mc^2', true)
      expect(html).toContain('katex')
    })
    expect(warnings).toEqual([])
  })

  test('Given 语法错误的公式 When 渲染 Then 不抛异常且不静默为纯文本以外的行为', () => {
    let html = ''
    const warnings = captureWarnings(() => {
      html = renderMarkdownMath('\\frac{1}', false)
    })
    // throwOnError=false：返回带 katex-error 标记的 HTML，而不是抛异常中断消息渲染。
    expect(typeof html).toBe('string')
    expect(html).toContain('katex')
    // strict=ignore 只影响兼容性提示，解析错误仍以错误标记呈现，不会被完全吞掉。
    expect(warnings.filter((warning) => warning.includes('unicodeTextInMathMode'))).toEqual([])
  })
})

describe('聊天与推理 Markdown 的中文公式提示', () => {
  test('Given remark-math 生成的行内/块级数学节点 When 执行插件 Then 每个中文公式只提示一次', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'inlineMath', value: '行内中文公式=1' }] },
        { type: 'math', value: '块级中文公式=2' },
      ],
    }
    const plugin = remarkCjkMathHint()
    const warnings = captureWarnings(() => {
      plugin(tree)
      // 流式渲染会反复执行同一条管线，第二次以后不再提示。
      plugin(tree)
    })
    const hints = warnings.filter((warning) => warning.includes('[Markdown 数学渲染]'))
    expect(hints.length).toBe(2)
    expect(hints[0]).toContain('行内中文公式')
    expect(hints[1]).toContain('块级中文公式')
  })

  test('Given 普通文本节点含中文 When 执行插件 Then 不误报为公式提示', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '这里只是正文中文' }] }],
    }
    const warnings = captureWarnings(() => {
      remarkCjkMathHint()(tree)
    })
    expect(warnings).toEqual([])
  })

  test('Given 公式与编辑器预览共享去重集合 When 同一公式先经 remark 再经 renderMarkdownMath Then 只提示一次', () => {
    const latex = '共享去重的中文公式=3'
    const plugin = remarkCjkMathHint()
    const warnings = captureWarnings(() => {
      plugin({ type: 'root', children: [{ type: 'inlineMath', value: latex }] })
      renderMarkdownMath(latex)
    })
    expect(warnings.filter((warning) => warning.includes('[Markdown 数学渲染]')).length).toBe(1)
  })
})
