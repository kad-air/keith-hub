import { NextRequest, NextResponse } from "next/server";
import {
  dumpConfigYaml,
  getConfigSource,
  getConfigYaml,
  parseConfigYaml,
  readRepoConfigYaml,
  resetConfigToRepo,
  saveConfigYaml,
  type AppConfig,
} from "@/lib/config";

export const dynamic = "force-dynamic";

// The live config document. GET returns both the raw YAML and the parsed
// object (the Sources/Algorithm panes edit the object; the YAML pane edits
// the text). `dirty` compares the live config against the repo file so the
// UI can show "backup is stale — copy as YAML".
function configResponse(): NextResponse {
  const yamlText = getConfigYaml();
  const { config } = parseConfigYaml(yamlText);
  let dirty = false;
  try {
    const repo = parseConfigYaml(readRepoConfigYaml());
    dirty = JSON.stringify(config) !== JSON.stringify(repo.config);
  } catch {
    dirty = true; // no repo file at all — everything is unbacked
  }
  return NextResponse.json({
    yaml: yamlText,
    config,
    source: getConfigSource(),
    dirty,
  });
}

export async function GET(): Promise<NextResponse> {
  try {
    return configResponse();
  } catch (err) {
    console.error("[api/tune/config] GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { yaml?: string; config?: AppConfig };
    let yamlText: string;
    if (typeof body.yaml === "string") {
      yamlText = body.yaml;
    } else if (body.config && typeof body.config === "object") {
      yamlText = dumpConfigYaml(body.config);
    } else {
      return NextResponse.json(
        { errors: ["Body must include yaml (string) or config (object)"] },
        { status: 400 }
      );
    }
    const { errors } = saveConfigYaml(yamlText);
    if (errors.length > 0) {
      return NextResponse.json({ errors }, { status: 400 });
    }
    return configResponse();
  } catch (err) {
    console.error("[api/tune/config] PUT error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Restore the repo file as the live config (drops the DB copy).
export async function DELETE(): Promise<NextResponse> {
  try {
    resetConfigToRepo();
    return configResponse();
  } catch (err) {
    console.error("[api/tune/config] DELETE error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
