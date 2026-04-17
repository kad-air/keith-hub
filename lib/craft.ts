import type {
  CraftItem,
  CraftCollectionResponse,
  CraftSchemaProperty,
  TrackerConfig,
  TrackerItem,
} from "./craft-types";

const CRAFT_BASE = "https://connect.craft.do/links/EBVzdf0Goa3/api/v1";

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${process.env.CRAFT_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// ─── Fetch all items from a collection ──────────────────────────
export async function fetchCollectionItems(
  collectionId: string,
): Promise<CraftCollectionResponse> {
  const res = await fetch(
    `${CRAFT_BASE}/collections/${collectionId}/items?maxDepth=0`,
    { headers: headers(), cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(
      `Craft API error ${res.status}: ${await res.text()}`,
    );
  }
  return res.json();
}

// ─── Fetch the property schema for a collection ────────────────
// The /items endpoint never includes a schema block, so the detail page
// pulls it from /schema separately to drive the read-only "extras" list.
// Type is sniffed from the description text rather than the JSON Schema
// `type`, because Craft's "single select" and "date" both serialize as
// `type: "string"` and the description is the only differentiator.
export async function fetchCollectionSchema(
  collectionId: string,
): Promise<CraftSchemaProperty[]> {
  const res = await fetch(
    `${CRAFT_BASE}/collections/${collectionId}/schema`,
    { headers: headers(), cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(
      `Craft schema error ${res.status}: ${await res.text()}`,
    );
  }
  const json = (await res.json()) as {
    properties?: {
      items?: {
        items?: {
          properties?: {
            properties?: {
              properties?: Record<
                string,
                { title?: string; description?: string; type?: string }
              >;
            };
          };
        };
      };
    };
  };
  const raw =
    json.properties?.items?.items?.properties?.properties?.properties ?? {};
  return Object.entries(raw).map(([key, def]) =>
    normalizeSchemaProperty(key, def),
  );
}

function normalizeSchemaProperty(
  key: string,
  def: { title?: string; description?: string; type?: string },
): CraftSchemaProperty {
  const desc = def.description ?? "";
  let type: CraftSchemaProperty["type"];
  if (def.type === "boolean") type = "boolean";
  else if (def.type === "number") type = "number";
  else if (def.type === "array") type = "multiSelect";
  else if (/^A single select/i.test(desc)) type = "singleSelect";
  else if (/^A date/i.test(desc)) type = "date";
  else type = "text";
  return { key, name: def.title ?? key, type };
}

// ─── Update a single item's properties ──────────────────────────
export async function updateCollectionItem(
  collectionId: string,
  itemId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(
    `${CRAFT_BASE}/collections/${collectionId}/items`,
    {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({
        itemsToUpdate: [{ id: itemId, properties }],
        allowNewSelectOptions: false,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Craft update error ${res.status}: ${await res.text()}`,
    );
  }
}

// ─── Parse contentPreviewMd for image and link URLs ─────────────
export function parseContentPreview(md: string | undefined): {
  imageUrl: string | null;
  linkUrl: string | null;
} {
  if (!md) return { imageUrl: null, linkUrl: null };

  const imageMatch = md.match(
    /!\[[^\]]*\]\((https:\/\/r\.craft\.do\/[^)]+)\)/,
  );
  const linkMatch = md.match(
    /\[[^\]]+\]\(((?!https:\/\/r\.craft\.do)[^)]+)\)/,
  );

  return {
    imageUrl: imageMatch?.[1] ?? null,
    linkUrl: linkMatch?.[1] ?? null,
  };
}

// ─── Normalize raw Craft items into TrackerItems ────────────────

// The music collection has a trailing space in the "now listening " status value.
// We trim on read and map back on write.
const STATUS_TRIM_MAP: Record<string, string> = {
  "now listening": "now listening ",
};

export function trimStatus(status: string): string {
  return status.trim();
}

export function untrimStatus(status: string): string {
  return STATUS_TRIM_MAP[status] ?? status;
}

export function normalizeItems(
  raw: CraftItem[],
  config: TrackerConfig,
): TrackerItem[] {
  return raw.map((item) => {
    const { imageUrl, linkUrl } = parseContentPreview(
      item.contentPreviewMd,
    );
    const name =
      config.titleKey === "album_name"
        ? (item.album_name ?? "")
        : (item.title ?? "");
    const status =
      typeof item.properties.status === "string"
        ? trimStatus(item.properties.status)
        : "";
    const rating =
      typeof item.properties.rating === "string"
        ? item.properties.rating
        : "";
    const ranking =
      typeof item.properties.ranking === "number"
        ? item.properties.ranking
        : undefined;
    const subtitle =
      typeof item.properties[config.subtitleKey] === "string"
        ? (item.properties[config.subtitleKey] as string)
        : "";

    // Extract release date: most trackers use `release_date` (ISO date string),
    // books uses `publication_year` (number).
    let releaseDate: string | null = null;
    if (typeof item.properties.release_date === "string" && item.properties.release_date) {
      releaseDate = item.properties.release_date;
    } else if (typeof item.properties.publication_year === "number") {
      releaseDate = String(item.properties.publication_year);
    }

    return {
      id: item.id,
      name,
      imageUrl,
      linkUrl,
      status,
      rating,
      ranking,
      subtitle,
      releaseDate,
      properties: item.properties,
    };
  });
}
