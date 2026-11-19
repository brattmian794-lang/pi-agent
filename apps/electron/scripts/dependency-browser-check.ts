/** 第一批依赖的浏览器验证入口；由 Bun 打包，结果在页面展示供实际浏览器复核。 */
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { StreamLanguage } from '@codemirror/language'

interface CheckResult { name: string; passed: boolean; detail?: string }
const results: CheckResult[] = []
function check(name: string, passed: boolean, detail?: string): void {
  results.push({ name, passed, detail })
  document.querySelector('#results')!.textContent = JSON.stringify(results, null, 2)
}

// 使用 LiveMarkdownPreview 的清洗选项；本页验证依赖链，不声称覆盖整个产品 UI。
const markdown = new MarkdownIt({ html: true })
const dirty = markdown.render('# 正常标题\n\n**保留正文** [安全链接](https://example.com)\n\n<table><tr><td>单元格</td></tr></table>\n\n<script>window.__xss=1</script><img src=x onerror="window.__xss=2"><a href="javascript:alert(1)" onclick="alert(1)">危险链接</a><style>body{display:none}</style><p style="display:none">可见正文</p><iframe srcdoc="<script>alert(1)</script>"></iframe>')
const sanitized = DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style'], FORBID_ATTR: ['style'] })
const preview = document.querySelector('#preview')!
preview.innerHTML = sanitized
check('正常标题、强调、表格、正文保留', Boolean(preview.querySelector('h1') && preview.querySelector('strong') && preview.querySelector('td') && preview.textContent?.includes('可见正文')))
check('安全 HTTPS 链接保留', preview.querySelector('a')?.getAttribute('href') === 'https://example.com')
check('脚本、iframe、style 标签移除', !preview.querySelector('script, iframe, style'))
check('事件属性、内联样式、危险 URL 移除', !Array.from(preview.querySelectorAll('*')).some(el => Array.from(el.attributes).some(attr => /^on/i.test(attr.name) || attr.name === 'style' || /javascript:/i.test(attr.value))))
const encoded = DOMPurify.sanitize('<a href="java&#x73;cript:alert(1)">encoded</a><svg onload="alert(1)"></svg>', { USE_PROFILES: { html: true } })
check('编码危险协议和 SVG 事件移除', !/href=|onload|<svg/i.test(encoded))

const view = new EditorView({
  state: EditorState.create({
    doc: Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 行`).join('\n'),
    extensions: [
      StreamLanguage.define({ token(stream) { stream.skipToEnd(); return null } }),
      keymap.of([{ key: 'Mod-a', run(editor) { editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } }); return true } }]),
      EditorView.theme({ '&': { height: '180px' }, '.cm-scroller': { overflow: 'auto' } }),
    ],
  }),
  parent: document.querySelector('#editor')!,
})
view.focus()
check('CodeMirror 初始焦点', view.hasFocus)
view.dispatch({ changes: { from: 0, insert: '中文输入验证\n' } })
check('CodeMirror 状态事务保留中文文本', view.state.doc.toString().startsWith('中文输入验证\n'))
view.dispatch({ selection: { anchor: view.state.doc.length }, effects: EditorView.scrollIntoView(view.state.doc.length) })
requestAnimationFrame(() => requestAnimationFrame(() => {
  check('CodeMirror 滚动到文末', view.scrollDOM.scrollTop > 0, String(view.scrollDOM.scrollTop))
}))
const inputEvents: string[] = []
view.contentDOM.addEventListener('input', event => { inputEvents.push(event.type); document.querySelector('#input-events')!.textContent = JSON.stringify({ inputEvents, document: view.state.doc.toString() }) })
view.contentDOM.addEventListener('compositionend', event => { document.querySelector('#composition')!.textContent = JSON.stringify({ isTrusted: event.isTrusted, data: (event as CompositionEvent).data }) })
Object.assign(window, { dependencyCheck: { results, view, inputEvents } })
