import katex from 'katex'

/**
 * 共享的 KaTeX 渲染选项。
 *
 * 数学模式里出现中文、全角标点属于常见输入，KaTeX 默认（strict='warn'）会逐字符
 * 抛出 unicodeTextInMathMode 告警，一次渲染就能刷出上百条日志。这里统一使用
 * strict='ignore'：排版结果不变，但不再产生噪声。
 */
export const KATEX_RENDER_OPTIONS = {
  output: 'htmlAndMathml',
  throwOnError: false,
  strict: 'ignore',
} as const

/** 供 rehype-katex 使用的同源选项，保证所有 Markdown 渲染面行为一致。 */
export const KATEX_REHYPE_OPTIONS: { throwOnError: boolean; strict: 'ignore' } = {
  throwOnError: false,
  strict: 'ignore',
}

const CJK_IN_MATH_PATTERN = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/
const reportedCjkFormulas = new Set<string>()

/**
 * 对含中文/全角字符的公式只提示一次（按公式内容去重），
 * 既能定位到具体公式，又不会因为重复渲染刷屏。
 */
function reportCjkFormulaOnce(latex: string): void {
  if (!CJK_IN_MATH_PATTERN.test(latex)) return
  const key = latex.trim().slice(0, 160)
  if (!key || reportedCjkFormulas.has(key)) return
  if (reportedCjkFormulas.size >= 100) reportedCjkFormulas.clear()
  reportedCjkFormulas.add(key)
  console.warn(`[Markdown 数学渲染] 公式含中文或全角字符，已按 strict=ignore 渲染（同一公式不再提示）: ${key}`)
}

/**
 * Shared KaTeX HTML renderer for editable Markdown surfaces.
 * Keep math generation out of editor widgets so every surface starts from the
 * same DOM contract as the Agent Markdown renderer.
 */
export function renderMarkdownMath(latex: string, displayMode = false): string {
  try {
    reportCjkFormulaOnce(latex)
    return katex.renderToString(latex, {
      displayMode,
      ...KATEX_RENDER_OPTIONS,
    })
  } catch {
    return latex
  }
}

/** remark-math 生成的数学节点（结构化解构，避免额外引入 mdast 类型依赖）。 */
interface MathAstNode {
  type?: unknown
  value?: unknown
  children?: MathAstNode[]
}

const MATH_NODE_TYPES = new Set(['inlineMath', 'math'])

function walkMathNodes(node: MathAstNode): void {
  if (typeof node.type === 'string' && MATH_NODE_TYPES.has(node.type) && typeof node.value === 'string') {
    reportCjkFormulaOnce(node.value)
  }
  if (!Array.isArray(node.children)) return
  for (const child of node.children) walkMathNodes(child)
}

/**
 * remark 插件：在 rehype-katex 渲染前扫描数学节点，对含中文/全角字符的公式
 * 给出一次性可定位提示。与 renderMarkdownMath 共用同一份去重集合，
 * 因此同一公式在聊天、推理、编辑器预览之间只提示一次。
 */
export function remarkCjkMathHint(): (tree: MathAstNode) => void {
  // 每次调用创建独立遍历闭包；去重集合仍是模块级共享的。
  return (tree) => walkMathNodes(tree)
}
