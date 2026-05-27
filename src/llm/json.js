export function extractJsonObjectText(value) {
  const trimmed = `${value ?? ''}`.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response');
  }

  return trimmed.slice(start, end + 1);
}

