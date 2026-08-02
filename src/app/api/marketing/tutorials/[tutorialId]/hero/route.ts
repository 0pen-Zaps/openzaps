import { NextResponse } from "next/server";

import {
  isMarketingAdminAuthorized,
  marketingAdminUnauthorizedResponse,
} from "@/lib/marketing/auth";
import {
  TutorialHandoffSourceError,
  loadSourceControlledTutorialHeroAsset,
} from "@/lib/marketing/tutorial-handoff-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TUTORIAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "Authorization",
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ tutorialId: string }> },
): Promise<Response> {
  // Authenticate before resolving a selection or touching source-controlled
  // files so an unauthenticated request cannot probe tutorial or asset state.
  if (!isMarketingAdminAuthorized(request)) {
    return marketingAdminUnauthorizedResponse();
  }

  const { tutorialId } = await context.params;
  if (!TUTORIAL_ID.test(tutorialId)) {
    return NextResponse.json(
      { error: "Invalid tutorial selection." },
      { status: 400, headers: PRIVATE_HEADERS },
    );
  }
  try {
    const hero = loadSourceControlledTutorialHeroAsset(tutorialId);
    const bytes = Uint8Array.from(hero.bytes);
    return new Response(bytes.buffer, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "content-type": hero.mimeType,
        "content-length": String(hero.byteLength),
        "content-disposition":
          `attachment; filename="openzaps-${tutorialId}-hero.jpg"`,
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "x-openzaps-content-sha256": hero.sha256,
      },
    });
  } catch (error) {
    if (error instanceof TutorialHandoffSourceError) {
      return NextResponse.json(
        {
          error:
            "The source-controlled tutorial hero is unavailable or no longer matches its reviewed source.",
        },
        { status: 409, headers: PRIVATE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: "The source-controlled tutorial hero could not be prepared." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
