import {
  getMarkdownPayload,
  getMarkdownStaticPaths,
  type MarkdownEndpointReference,
} from "@cloudflare/nimbus-docs/agent-endpoints";
import { agentEndpointResponse } from "../../utils/agent-endpoint-response";

export const prerender = true;

interface SlugProps {
  reference: MarkdownEndpointReference;
}

interface SlugContext {
  params: { slug?: string };
  props: Partial<SlugProps>;
  request: Request;
}

export const getStaticPaths = async () =>
  getMarkdownStaticPaths({
    collection: "docs",
    surface: "markdown",
  });

export async function GET({ params, props, request }: SlugContext) {
  return agentEndpointResponse(() =>
    getMarkdownPayload({
      collection: "docs",
      surface: "markdown",
      slug: params.slug,
      reference: props.reference,
      context: { request },
    }),
    prerender,
  );
}
