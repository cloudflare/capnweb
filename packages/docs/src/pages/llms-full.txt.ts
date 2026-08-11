// Full-corpus markdown for AI agents — every published page in one
// document. Scope and collation live in the framework helper; reshape or
// delete this route to change the site's corpus policy.
import { renderCorpusMarkdown } from "@cloudflare/nimbus-docs";

export const prerender = true;

export async function GET() {
  return new Response(await renderCorpusMarkdown(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
