import { fileURLToPath } from 'node:url';

/**
 * Component imports such as `@ops/ui/primitives/button` name folders and extensionless files, which package
 * exports can't resolve. Apps add this alias to Vite and Vitest so those imports read the package source; `css`,
 * `jsx`, `tokens` and `types` still resolve through the exports `panda lib` writes.
 */
export const uiSourceAlias = {
  find: /^@ops\/ui\/(blocks|hooks|icons|illustrations|primitives|theme)(\/.*)?$/,
  replacement: `${fileURLToPath(new URL('./src/', import.meta.url))}$1$2`,
};
