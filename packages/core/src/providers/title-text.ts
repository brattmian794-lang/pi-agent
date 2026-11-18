/** 只提取可见的最终标题文本，不猜测 thinking、reasoning 或工具块中的内容。 */
export function extractFinalTitleText(value: unknown): string | null {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else if (Array.isArray(value)) {
    text = value.map((block: unknown) => {
      if (!block || typeof block !== 'object') return ''
      const part = block as { type?: unknown; text?: unknown }
      return (part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string' ? part.text : ''
    }).join('')
  } else if (value && typeof value === 'object') {
    const block = value as { type?: unknown; text?: unknown }
    if ((block.type !== 'text' && block.type !== 'output_text') || typeof block.text !== 'string') return null
    text = block.text
  } else {
    return null
  }

  // 部分兼容端点把推理包在 content 字符串里；未闭合标签表示推理尚未结束。
  return text.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '').trim() || null
}
