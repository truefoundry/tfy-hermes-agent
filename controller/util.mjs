export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
