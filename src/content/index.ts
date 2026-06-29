import type { ExtractResult, ExtractError } from '../types';
import { extractArticle } from './extractor';
import { toMarkdown } from './markdown';
import { findAndPrepare, captureAll, substituteImages } from './special-nodes';

async function performExtraction(): Promise<ExtractResult | ExtractError> {
  try {
    const { modifiedClone, jobs } = findAndPrepare(document);

    const article = extractArticle(modifiedClone);
    if (!article) {
      return { type: 'EXTRACT_ERROR', message: 'Could not extract article content from this page.' };
    }

    const markdown = toMarkdown(article.content);
    const images = await captureAll(jobs);
    const finalMarkdown = substituteImages(markdown, images);

    return {
      type: 'EXTRACT_RESULT',
      title: article.title || document.title,
      markdown: finalMarkdown,
      wordCount: article.wordCount,
      specialNodes: jobs.map((j) => j.info),
    };
  } catch (err) {
    return { type: 'EXTRACT_ERROR', message: String(err) };
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'EXTRACT') {
    performExtraction().then(sendResponse);
    return true; // keep message channel open for async response
  }
});
