import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import AdmZip from 'adm-zip'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import sharp from 'sharp'
import { extractTextFromFile } from './document-parser'
import { resolveTargetPath } from './file-preview-service'

let fixtureDir: string
beforeAll(() => {
  fixtureDir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'dependency-parsing-'))
})
afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

const relationshipsNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
const officeNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

async function officeFixture(kind: 'docx' | 'xlsx'): Promise<Buffer> {
  const zip = new JSZip()
  const mainPart = kind === 'docx' ? 'word/document.xml' : 'xl/workbook.xml'
  const mainType = kind === 'docx' ? 'wordprocessingml.document' : 'spreadsheetml.sheet'
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/${mainPart}" ContentType="application/vnd.openxmlformats-officedocument.${mainType}.main+xml"/>
    ${kind === 'xlsx' ? '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}
  </Types>`)
  zip.file('_rels/.rels', `<Relationships xmlns="${relationshipsNamespace}"><Relationship Id="rId1" Type="${officeNamespace}/officeDocument" Target="${mainPart}"/></Relationships>`)
  if (kind === 'docx') {
    zip.file(mainPart, `<w:document xmlns:w="${wordNamespace}"><w:body>
      <w:p><w:r><w:t>第一段 中文 &amp; XML</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> bold run</w:t></w:r></w:p>
      <w:p><w:r><w:t>第二段</w:t><w:br/><w:t>换行内容</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格左列</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Table right 42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>文档末尾</w:t></w:r></w:p>
    </w:body></w:document>`)
  } else {
    zip.file(mainPart, `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeNamespace}"><sheets><sheet name="验收表" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${relationshipsNamespace}"><Relationship Id="rId1" Type="${officeNamespace}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${officeNamespace}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`)
    zip.file('xl/sharedStrings.xml', `<sst xmlns="${spreadsheetNamespace}" count="2" uniqueCount="2"><si><t>首行中文</t></si><si><r><t>富文本</t></r><r><t> cell</t></r></si></sst>`)
    zip.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${spreadsheetNamespace}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`)
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ZIP/XML 辅助函数是 file-preview-service 的私有函数；这里以库级断言验收依赖，
// 不冒充 OfficeCLI/预览 HTML 集成测试，也不向产品添加测试专用导出或全局模块 mock。
describe('Given adm-zip / JSZip，When 压缩包跨库读写，Then 保留文件并处理非法输入', () => {
  test('JSZip 压缩后 adm-zip 读取，再写回 JSZip，保留 Unicode、空文件及二进制', async () => {
    const zip = new JSZip()
    const binary = Buffer.from([0, 1, 127, 128, 255])
    zip.file('目录/文本.txt', '中文 roundtrip & <xml>')
    zip.file('empty.txt', '')
    zip.file('data.bin', binary)
    const adm = new AdmZip(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    expect(adm.readAsText('目录/文本.txt')).toBe('中文 roundtrip & <xml>')
    expect(adm.getEntry('empty.txt')?.getData().length).toBe(0)
    expect(adm.getEntry('data.bin')?.getData()).toEqual(binary)
    adm.addFile('added.txt', Buffer.from('adm 写入'))
    const loaded = await JSZip.loadAsync(adm.toBuffer(), { checkCRC32: true })
    expect(await loaded.file('目录/文本.txt')!.async('string')).toBe('中文 roundtrip & <xml>')
    expect(await loaded.file('data.bin')!.async('nodebuffer')).toEqual(binary)
    expect(await loaded.file('empty.txt')!.async('string')).toBe('')
    expect(await loaded.file('added.txt')!.async('string')).toBe('adm 写入')
  })

  test('JSZip 加载含 ../ 的 ZIP 时归一化条目名，不在磁盘解压', async () => {
    const zip = new JSZip()
    zip.file('../../../escape.txt', 'untrusted')
    zip.file('safe/../normalized.txt', 'normalized')
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(loaded.file('../../../escape.txt')).toBeNull()
    expect(await loaded.file('escape.txt')!.async('string')).toBe('untrusted')
    expect(await loaded.file('normalized.txt')!.async('string')).toBe('normalized')
    expect(Object.keys(loaded.files).every((name) => !name.split('/').includes('..'))).toBe(true)
  })

  test.each([Buffer.from('not a ZIP'), Buffer.from('PK\x03\x04truncated')])('两库拒绝损坏或截断 ZIP %#', async (bytes) => {
    expect(() => new AdmZip(bytes)).toThrow()
    await expect(JSZip.loadAsync(bytes)).rejects.toThrow()
  })
})

describe('Given 预览候选根，When 解析相对路径，Then 归一化或拒绝越界', () => {
  test('根内的点路径归一化，正反斜杠的父目录越界及 NUL 被拒绝', () => {
    const root = join(fixtureDir, 'authorized')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'inside.txt'), 'inside')
    writeFileSync(join(fixtureDir, 'outside.txt'), 'outside')
    expect(resolveTargetPath('nested/../inside.txt', [root])).toBe(resolve(root, 'inside.txt'))
    expect(resolveTargetPath('../outside.txt', [root])).toBe('')
    // Windows 同时识别两种分隔符；其他平台的反斜杠是合法文件名。
    if (process.platform === 'win32') expect(resolveTargetPath('..\\outside.txt', [root])).toBe('')
    expect(resolveTargetPath('inside.txt\0', [root])).toBe('')
  })
})

describe('Given xmldom，When 解析 XML，Then 正常解码并暴露错误且不展开外部实体', () => {
  test('命名空间、CDATA、内置实体和 Unicode 正常解析', () => {
    const doc = new DOMParser().parseFromString('<x:root xmlns:x="urn:test"><x:p>中文 &amp; <![CDATA[<tag>]]></x:p></x:root>', 'application/xml')
    const paragraph = doc.getElementsByTagNameNS('urn:test', 'p').item(0)
    expect(paragraph?.textContent).toBe('中文 & <tag>')
  })

  test('不完整 XML 即使被容错修复，也通过 errorHandler 明确报告异常', () => {
    const diagnostics: string[] = []
    const parser = new DOMParser({ errorHandler: {
      warning: (message) => diagnostics.push(message),
      error: (message) => diagnostics.push(message),
      fatalError: (message) => diagnostics.push(message),
    } })
    parser.parseFromString('<root><unclosed></root>', 'application/xml')
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics.join('\n')).toMatch(/unclosed|mismatch|invalid/i)
  })

  test('SYSTEM 文件实体不读取本地内容，保留未解析实体并报告错误', () => {
    const secret = join(fixtureDir, 'entity-secret.txt')
    const marker = 'EXTERNAL_ENTITY_MUST_NOT_EXPAND_8271'
    writeFileSync(secret, marker)
    const diagnostics: string[] = []
    const doc = new DOMParser({ errorHandler: {
      warning: (message) => diagnostics.push(message),
      error: (message) => diagnostics.push(message),
      fatalError: (message) => diagnostics.push(message),
    } }).parseFromString(`<!DOCTYPE root [<!ENTITY external SYSTEM "${pathToFileURL(secret).href}">]><root>&external;</root>`, 'application/xml')
    expect(doc.documentElement.textContent).not.toContain(marker)
    expect(doc.documentElement.textContent).toBe('&external;')
    expect(diagnostics.join('\n')).toMatch(/entity not found/i)
  })
})

// vision-relay-service 的 normalizeImageContent 未导出；公开入口还依赖模型配置与网络。
// 以下只验收与该私有函数相同的 sharp 解码/flatten/JPEG 操作，不声称覆盖视觉服务。
describe('Given sharp，When 完整解码并转码图像，Then 输出有效像素或拒绝损坏输入', () => {
  test('透明 PNG 转白底 JPEG，尺寸、格式及解码后的像素正确', async () => {
    const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const jpeg = await sharp(png, { animated: false, limitInputPixels: 20_000_000 }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer()
    const metadata = await sharp(jpeg).metadata()
    expect(metadata.format).toBe('jpeg')
    expect(metadata.width).toBe(3)
    expect(metadata.height).toBe(2)
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(3)
    expect(data.length).toBe(18)
    expect([...data].every((channel) => channel >= 250)).toBe(true)
  })

  test('伪造图片和具有 PNG 签名的截断图片都无法完整转码', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } }).png().toBuffer()
    for (const data of [Buffer.from('not an image'), png.subarray(0, 40)]) {
      await expect(sharp(data).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer()).rejects.toThrow()
    }
  })
})

describe('Given JSZip 生成的真实 Office 文档，When 调用 document-parser，Then 提取复杂内容或拒绝损坏文档', () => {
  test('DOCX 经产品 mammoth 路径保留多段、格式 run、表格及内容顺序', async () => {
    const path = join(fixtureDir, 'complex.docx')
    writeFileSync(path, await officeFixture('docx'))
    const text = await extractTextFromFile(path)
    const expected = ['第一段 中文 & XML', 'bold run', '第二段', '换行内容', '表格左列', 'Table right 42', '文档末尾']
    let previous = -1
    for (const fragment of expected) {
      const index = text.indexOf(fragment)
      expect(index).toBeGreaterThan(previous)
      previous = index
    }
    expect(text).toMatch(/bold run\s*\n\s*第二段/)
    // 已知限制：当前 extractRawText 会丢弃 w:br 分隔符；这里只验收两侧内容。
    expect(text).not.toContain('<w:')
  })

  test('XLSX 经产品 officeparser Buffer 路径提取多行、共享字符串及数字', async () => {
    const path = join(fixtureDir, 'complex.xlsx')
    writeFileSync(path, await officeFixture('xlsx'))
    const text = await extractTextFromFile(path)
    expect(text).toContain('首行中文')
    // 已知限制：officeparser 4.2.0 对共享富文本只提取首个 run，未覆盖完整富文本保真。
    expect(text).toContain('富文本')
    expect(text).toContain('42')
    expect(text.indexOf('富文本')).toBeGreaterThan(text.indexOf('首行中文'))
  })

  test.each(['docx', 'xlsx'])('损坏的 %s 经产品解析器拒绝，文件保持存在', async (extension) => {
    const path = join(fixtureDir, `broken.${extension}`)
    writeFileSync(path, Buffer.from('PK\x03\x04broken office archive'))
    await expect(extractTextFromFile(path)).rejects.toThrow()
    expect(existsSync(path)).toBe(true)
  })

  test('ZIP 有效但缺少 Word 主文档时产品拒绝，避免把压缩包误当成功', async () => {
    const zip = new JSZip()
    zip.file('unrelated.txt', 'not a document')
    const path = join(fixtureDir, 'missing-main.docx')
    writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
    await expect(extractTextFromFile(path)).rejects.toThrow()
  })
})
