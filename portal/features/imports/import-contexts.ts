export function mergeImportContextOptions(options: string[], selected: string[]): string[] {
  return [...new Set([...options, ...selected].map((context) => context.trim()).filter(Boolean))];
}
