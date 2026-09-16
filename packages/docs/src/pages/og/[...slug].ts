import {
  getIndexedEntries,
  isDiscoverable,
} from "@cloudflare/nimbus-docs/runtime";
import { OGImageRoute } from "astro-og-canvas";
import { ogCardConfig } from "./_og-card-config";

// Prerender every OG card as a static asset so `output: "server"` doesn't
// turn image generation into an on-demand route.
export const prerender = true;

// Enumerate via the framework projection (not a raw `getCollection`) so draft
// entries are excluded uniformly — a draft page emits no route, so its
// `/og/<id>.png` shouldn't either.
const entries = (await getIndexedEntries()).filter((entry) =>
  isDiscoverable(entry.entry),
);

const pages = Object.fromEntries(
  entries.map((entry) => {
    const routeId = entry.entry.id.replace(/(?:^|\/)index$/, "");
    const pathname = entry.url.replace(/\/$/, "");
    const prefix = routeId ? pathname.slice(0, -routeId.length) : pathname;
    return [
      `${prefix.replace(/\/$/, "")}/${entry.entry.id}`.replace(
        /^\/+|\/+$/g,
        "",
      ),
      {
        title: entry.title,
        description: entry.description ?? "",
      },
    ];
  }),
);

export const { getStaticPaths, GET } = await OGImageRoute({
  pages,
  getImageOptions: (_path, page) => ({
    title: page.title,
    description: page.description,
    ...ogCardConfig,
  }),
});
