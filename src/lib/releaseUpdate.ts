function attributeValue(tag: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] ?? null
}

export function releaseAssetFromHtml(html: string) {
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? []

  for (const scriptTag of scriptTags) {
    if (attributeValue(scriptTag, 'type') !== 'module') continue
    const source = attributeValue(scriptTag, 'src')
    if (source) return source
  }

  return null
}
