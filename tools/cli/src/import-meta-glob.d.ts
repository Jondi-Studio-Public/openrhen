/**
 * `import.meta.glob` for the CLI's own type check. The portal build resolves it from `vite/client` instead, and
 * only reaches this file's consumers, never this declaration, so the two do not collide.
 */
interface ImportMeta {
  glob(pattern: string, options: { eager: true; import: "default" }): Record<string, unknown>;
}
