import { generateOpenGraphImage } from "astro-og-canvas";
import { config } from "virtual:nimbus/config";
import { ogCardConfig } from "./og/_og-card-config";

export const prerender = true;

export async function GET() {
  const body = await generateOpenGraphImage({
    title: config.title,
    description: config.description,
    ...ogCardConfig,
  });

  return new Response(body, {
    headers: { "Content-Type": "image/png" },
  });
}
