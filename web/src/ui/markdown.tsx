import type { ReactNode } from 'react'

/** Only this inline subset becomes elements; HTML and unsupported links stay text. */
function inline(source: string): ReactNode[] {
  const tokens = /(?<!!)\[([^\]\n]+)\]\(([^)\n]*)\)|\*\*([^*\n]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|_([^_\n]+)_/g
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of source.matchAll(tokens)) {
    nodes.push(source.slice(cursor, match.index))
    const [text, label, url, bold, starItalic, underscoreItalic] = match
    if (label !== undefined) {
      nodes.push(/^(https?:\/\/|mailto:)/.test(url)
        ? <a key={match.index} href={url} rel="noreferrer" target="_blank" className="rounded underline underline-offset-2 hover:text-stone-900">{label}</a>
        : text)
    } else if (bold !== undefined) {
      nodes.push(<strong key={match.index}>{bold}</strong>)
    } else {
      nodes.push(<em key={match.index}>{starItalic ?? underscoreItalic}</em>)
    }
    cursor = match.index + text.length
  }
  nodes.push(source.slice(cursor))
  return nodes
}

const heading = /^(#{1,3}) (.+)$/
const bullet = /^[-*] (.+)$/
const numbered = /^\d+\. (.+)$/

/** The console's small Markdown subset, built only from React elements (never HTML). */
export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const key = index
    if (!line.trim()) {
      index++
      continue
    }
    const title = heading.exec(line)
    if (title) {
      const content = inline(title[2])
      if (title[1].length === 1) blocks.push(<h2 key={key} className="text-base font-semibold text-stone-900">{content}</h2>)
      else if (title[1].length === 2) blocks.push(<h3 key={key} className="text-sm font-semibold text-stone-900">{content}</h3>)
      else blocks.push(<h4 key={key} className="text-sm font-medium text-stone-900">{content}</h4>)
      index++
      continue
    }
    const list = bullet.test(line) ? bullet : numbered.test(line) ? numbered : undefined
    if (list) {
      const items: ReactNode[] = []
      while (index < lines.length) {
        const item = list.exec(lines[index])
        if (!item) break
        items.push(<li key={index}>{inline(item[1])}</li>)
        index++
      }
      blocks.push(list === bullet
        ? <ul key={key} className="list-disc space-y-1 pl-5">{items}</ul>
        : <ol key={key} className="list-decimal space-y-1 pl-5">{items}</ol>)
      continue
    }
    const paragraph = [line]
    index++
    while (index < lines.length && lines[index].trim() && !heading.test(lines[index]) && !bullet.test(lines[index]) && !numbered.test(lines[index])) {
      paragraph.push(lines[index])
      index++
    }
    blocks.push(<p key={key} className="whitespace-pre-wrap">{inline(paragraph.join('\n'))}</p>)
  }
  return <div className="space-y-3 break-words text-sm leading-relaxed text-stone-700">{blocks}</div>
}
