interface AgentEndpointPayload {
  body: string;
  mediaType: string;
}

export async function agentEndpointResponse(
  load: () => Promise<AgentEndpointPayload | null>,
  prerender: boolean,
): Promise<Response> {
  try {
    const payload = await load();
    if (!payload) return new Response("Not found", { status: 404 });
    return new Response(payload.body, {
      headers: { "Content-Type": payload.mediaType },
    });
  } catch (error) {
    if (prerender) throw error;
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
