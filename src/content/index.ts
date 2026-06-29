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

    // Diagnostic: check how many placeholders survived Readability extraction
    const survived = jobs.filter(j => markdown.includes(`affine-img://${j.id}`));
    const missed   = jobs.filter(j => !markdown.includes(`affine-img://${j.id}`));
    if (jobs.length > 0) {
      console.log(
        `[AFFiNE Clipper] special nodes: ${jobs.length} detected, ` +
        `${survived.length} survived Readability, ${missed.length} filtered out, ` +
        `${images.size} captured`
      );
    }

    let finalMarkdown = substituteImages(markdown, images);

    // Readability strips <img src="affine-img://..."> placeholders because the
    // scheme is non-standard.  Append any filtered-out diagrams at the end so
    // they always reach AFFiNE regardless of Readability's decisions.
    if (missed.length > 0) {
      const appended: string[] = [];
      for (const job of missed) {
        const dataUri = images.get(job.id);
        if (dataUri) {
          appended.push(`![${job.info.label}](${dataUri})`);
        }
      }
      if (appended.length > 0) {
        finalMarkdown += '\n\n---\n\n' + appended.join('\n\n');
      }
    }

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
