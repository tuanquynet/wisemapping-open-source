/**
 * Bun supports `import x from './f.sql' with { type: 'text' }`, but TypeScript
 * needs to be told the module resolves to a string.
 */
declare module "*.sql" {
  const content: string;
  export default content;
}
