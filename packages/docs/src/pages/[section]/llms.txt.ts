import {
  getLlmsPayload,
  getLlmsStaticPaths,
  type LlmsEndpointReference,
} from "@cloudflare/nimbus-docs/agent-endpoints";
import { agentEndpointResponse } from "../../utils/agent-endpoint-response";

export const prerender = true;

interface SectionProps {
  reference: LlmsEndpointReference;
}

interface SectionContext {
  params: { section?: string };
  props: Partial<SectionProps>;
  request: Request;
}

export const getStaticPaths = async () =>
  getLlmsStaticPaths();

export async function GET({ params, props, request }: SectionContext) {
  const reference =
    props.reference ??
    (params.section
      ? ({
          scope: "section",
          surface: "index",
          section: params.section,
        } satisfies LlmsEndpointReference)
      : null);
  if (!reference) return new Response("Not found", { status: 404 });
  return agentEndpointResponse(() =>
    getLlmsPayload(reference, {
      request,
    }),
    prerender,
  );
}
