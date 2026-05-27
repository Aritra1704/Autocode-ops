function normalizeText(value) {
  return `${value ?? ''}`.replace(/\r\n/g, '\n').trim();
}

function splitLargeParagraph(paragraph, maxChars) {
  const pieces = [];
  let remaining = paragraph.trim();

  while (remaining.length > maxChars) {
    const boundary = remaining.lastIndexOf(' ', maxChars);
    const cut = boundary > Math.floor(maxChars * 0.6) ? boundary : maxChars;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) {
    pieces.push(remaining);
  }

  return pieces;
}

export function chunkDocumentText(text, options = {}) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }

  const maxChars = options.maxChars ?? 1100;
  const minChars = options.minChars ?? 120;
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((paragraph) =>
      paragraph.length > maxChars ? splitLargeParagraph(paragraph, maxChars) : [paragraph]
    );

  const chunks = [];
  let buffer = '';

  for (const paragraph of paragraphs) {
    if (!buffer) {
      buffer = paragraph;
      continue;
    }

    const joined = `${buffer}\n\n${paragraph}`;
    if (joined.length <= maxChars) {
      buffer = joined;
      continue;
    }

    if (buffer.length >= minChars) {
      chunks.push(buffer);
      buffer = paragraph;
    } else {
      chunks.push(joined.slice(0, maxChars));
      buffer = joined.slice(maxChars).trim();
    }
  }

  if (buffer.trim().length > 0) {
    chunks.push(buffer.trim());
  }

  return chunks.map((content, index) => ({
    chunkIndex: index,
    content,
    tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
  }));
}

