import { getLlmsPayload } from "@cloudflare/nimbus-docs/agent-endpoints";
import { agentEndpointResponse } from "../utils/agent-endpoint-response";

export const prerender = true;

export async function GET(context: { request: Request }) {
  return agentEndpointResponse(() =>
    getLlmsPayload(
      {
        scope: "site",
        surface: "full",
      },
      context,
    ),
    prerender,
  );
}
