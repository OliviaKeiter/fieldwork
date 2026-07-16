// Client-side text extraction so a career record can be uploaded, not hand-typed.
export async function extractTextFromFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) {
    return (await file.text()).trim();
  }

  if (name.endsWith('.docx')) {
    const mammoth = await import('mammoth/mammoth.browser');
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.convertToMarkdown({ arrayBuffer });
    return result.value.trim();
  }

  if (name.endsWith('.pdf')) {
    const pdfjsLib = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item: any) => ('str' in item ? item.str : '')).join(' ');
      pages.push(text);
    }
    return pages.join('\n\n').trim();
  }

  if (name.endsWith('.doc')) {
    throw new Error(
      'Legacy .doc files aren’t supported — save it as .docx or .pdf and try again.'
    );
  }

  throw new Error(`Unsupported file type: ${file.name.split('.').pop() ?? 'unknown'}. Use .docx, .pdf, .md, or .txt.`);
}
