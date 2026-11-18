import { extractFinalTitleText } from '@proma/core/providers'

/** 标题生成 Prompt */
export const TITLE_PROMPT = '根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。如果消息内容过短或无明确主题，直接使用原始消息作为标题。\n\n用户消息：'

/** 短消息阈值：低于此长度直接使用原文作为标题 */
export const SHORT_MESSAGE_THRESHOLD = 4

/** 最大标题长度（Unicode 码点数） */
export const MAX_TITLE_LENGTH = 20

const TITLE_PUNCTUATION = /^["'“”‘’「《]+|["'“”‘’」》]+$/g
const MARKDOWN_PREFIX = /^(?:[#>*\-\d.)]\s*)+/
const WHITESPACE = /\s+/g
const FILE_MENTION = /@file:(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s<>"'`，。！？；：、（）【】《》“”‘’]+)/gu
const URL_REFERENCE = /(?:https?|ftp|file|attachment):\/\/[^\s<>"'`，。！？；、（）【】《》“”‘’]+|www\.[^\s<>"'`，。！？；、（）【】《》“”‘’]+/giu
const PATH_REFERENCE = /@?(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"'`，。！？；：、（）【】《》“”‘’]+|(?<![\p{L}\p{N}_])@?(?:~?\/|\.{1,2}[\\/])[^\s<>"'`，。！？；：、（）【】《》“”‘’]+|(?<![\p{L}\p{N}_])(?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+\.[\p{L}\p{N}]+|(?:[A-Za-z]%3A(?:%5C|%2F)|%2F|%5C%5C)[A-Za-z0-9%_.!~*'()-]+/giu
const EDGE_PUNCTUATION = /^[\s,.;:!?，。！？；：、()[\]{}<>"'`]+|[\s,.;:!?，。！？；：、()[\]{}<>"'`]+$/gu

function truncateTitle(text: string): string | null {
  return Array.from(text).slice(0, MAX_TITLE_LENGTH).join('') || null
}

/** 清理模型返回的标题；拒绝推理、工具块及没有明确类型的内容块。 */
export function sanitizeGeneratedTitle(title: unknown): string | null {
  const text = extractFinalTitleText(title)
  if (!text) return null
  return truncateTitle(text.replace(TITLE_PUNCTUATION, '').replace(WHITESPACE, ' ').trim())
}

/** 解码引用后仅保留文件名；损坏编码不能回流到会话标题中。 */
function getReferenceFileName(reference: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(reference.replace(/^@/, '').replace(/^file:\/\//i, ''))
  } catch {
    return null
  }
  const name = decoded.split(/[\\/]/).pop()?.replace(EDGE_PUNCTUATION, '').trim()
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]|%[\da-f]{2}/i.test(name)) return null
  return name
}

/**
 * 模型失败时优先用清理后的正文兜底。纯文件输入可以用文件名，纯链接或
 * 没有主题的输入返回 null，交由调用方保留默认名；不能直接截断原始引用。
 */
export function createFallbackTitle(userMessage: string): string | null {
  const fileNames: string[] = []
  const rememberFile = (reference: string): string => {
    if (/^(?!file:)[a-z][\w+.-]*:\/\//i.test(reference)) return ' '
    const name = getReferenceFileName(reference)
    if (name) fileNames.push(name)
    return ' '
  }

  const withoutReferences = userMessage
    .replace(/<attached_files\b[^>]*>[\s\S]*?(?:<\/attached_files>|$)/gi, ' ')
    .replace(/(!?)\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g, (_match: string, image: string, label: string, target: string) => {
      rememberFile(target)
      return image ? ' ' : label
    })
    .replace(FILE_MENTION, (mention) => {
      const value = mention.slice('@file:'.length).replace(/^["'`]|["'`]$/g, '')
      // 输入框序列化的编码引用可能紧邻中文正文；不把正文吞进文件名。
      const match = /%[\da-f]{2}/i.test(value)
        ? /^([^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)(.*)$/u.exec(value)
        : null
      rememberFile(match?.[1] ?? value)
      return ` ${match?.[2] ?? ''}`
    })
    .replace(/@file:/gi, ' ')
    .replace(URL_REFERENCE, (url) => /^file:\/\//i.test(url) ? rememberFile(url) : ' ')
    // 独占一行的绝对路径可以包含空格，必须在按片段匹配路径前整体移除。
    .replace(/^[ \t]*@?(?:[A-Za-z]:[\\/]|\\\\|~?\/)[^\r\n]*$/gmu, rememberFile)
    .replace(/["'`]([^"'`\r\n]+)["'`]/g, (match: string, value: string) => {
      return /^(?:@?[A-Za-z]:[\\/]|\\\\|~?\/|\.{1,2}[\\/])/.test(value) ? rememberFile(value) : match
    })
    .replace(PATH_REFERENCE, rememberFile)

  const firstLine = withoutReferences.split(/\r?\n/)
    .map((line) => line.trim().replace(MARKDOWN_PREFIX, '').replace(WHITESPACE, ' ').replace(EDGE_PUNCTUATION, '').trim())
    .find((line) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(line))

  return truncateTitle(firstLine ?? fileNames[0] ?? '')
}
