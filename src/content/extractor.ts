import { Readability } from '@mozilla/readability';

export interface Article {
  title: string;
  content: string; // HTML string
  wordCount: number;
}

export function extractArticle(doc: Document): Article | null {
  const clone = doc.cloneNode(true) as Document;
  const reader = new Readability(clone);
  const article = reader.parse();
  if (!article) return null;
  return {
    title: article.title,
    content: article.content,
    wordCount: article.textContent.trim().split(/\s+/).filter(Boolean).length,
  };
}
