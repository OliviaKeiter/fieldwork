// mammoth ships no types for its browser bundle; this ambient declaration keeps
// `npx tsc --noEmit` clean (used by fileExtract.ts).
declare module 'mammoth/mammoth.browser' {
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
  export function convertToMarkdown(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
}
