/**
 * 工具内容 Token 估算模块
 *
 * 基于字符级启发式估算文本的 token 消耗量，
 * 用于在 canUseTool 中拦截可能因 token 截断而失败的大文件写入。
 */

/** Write 内容的 token 阈值，超过此值触发分块写入引导 */
export const WRITE_CONTENT_TOKEN_THRESHOLD = 16_000

/**
 * 判断 Unicode 码点是否为 CJK 字符。
 *
 * 覆盖区间：CJK 统一汉字、CJK 符号标点、全角形式、
 * 韩文音节、平假名、片假名、CJK 扩展 A/B。
 */
export function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
    (cp >= 0x3000 && cp <= 0x303F) ||   // CJK Symbols and Punctuation
    (cp >= 0xFF00 && cp <= 0xFFEF) ||   // Fullwidth Forms
    (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
    (cp >= 0x3040 && cp <= 0x30FF) ||   // Hiragana + Katakana
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
    (cp >= 0x20000 && cp <= 0x2A6DF)    // CJK Extension B (supplementary)
  )
}

/**
 * 估算文本的近似 token 数量。
 *
 * CJK 字符 BPE 分词效率较低，保守估计：
 * - CJK ≈ 1.5 tokens/char
 * - ASCII ≈ 0.25 tokens/char
 * - 其他 ≈ 0.75 tokens/char
 *
 * 偏保守：宁可高估触发分块，也不要低估导致截断。
 */
export function estimateTokenCount(text: string): number {
  let cjkCount = 0
  let asciiCount = 0
  let otherCount = 0

  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    if (isCjkCodePoint(cp)) {
      cjkCount++
    } else if (cp < 128) {
      asciiCount++
    } else {
      otherCount++
    }
  }

  return Math.ceil(cjkCount * 1.5 + asciiCount * 0.25 + otherCount * 0.75)
}

/** Write 单次写入超限的判定结果：包含阈值、实际规模与可直接回给模型的分段写入说明。 */
export interface WriteSizeLimitRejection {
  estimatedTokens: number
  chars: number
  limit: number
  message: string
}

/**
 * 判断一次工具调用是否因 Write 内容过大而必须拒绝。
 *
 * 只约束 Write：其它工具的超大入参由各自权限与校验规则处理。
 * 拒绝说明同时给出上限、实际规模、未写入磁盘的结论与分段写入方式，
 * 让模型能自行构造有效的后续调用，而不是盲目重试同一次 Write。
 */
export function evaluateWriteSizeLimit(
  toolName: string,
  input: Record<string, unknown>,
): WriteSizeLimitRejection | null {
  if (toolName !== 'Write' || typeof input.content !== 'string') return null
  const chars = input.content.length
  const estimatedTokens = estimateTokenCount(input.content)
  if (estimatedTokens <= WRITE_CONTENT_TOKEN_THRESHOLD) return null
  return {
    estimatedTokens,
    chars,
    limit: WRITE_CONTENT_TOKEN_THRESHOLD,
    message:
      `Write was rejected: content is too large for a single call (~${estimatedTokens} estimated tokens, ${chars} chars; ` +
      `limit is ${WRITE_CONTENT_TOKEN_THRESHOLD} tokens per call). Nothing was written to disk. ` +
      `Split the work: call Write once with the first section, then use Edit repeatedly to append the remaining sections ` +
      `(old_string = a short unique tail of what already exists, new_string = that tail plus the next section).`,
  }
}
