import "server-only";

import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import tutorialManifestJson from "../../../docs/tutorials/manifest.json";
import {
  createSubstackEditorHandoff,
  type SubstackEditorHandoff,
} from "@/lib/marketing/channels/substack";
import {
  SOURCE_CONTROLLED_TUTORIAL_APPROVAL_STATEMENT,
  SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER,
  SOURCE_CONTROLLED_TUTORIAL_BUNDLE_VERSION,
  SOURCE_CONTROLLED_TUTORIAL_HERO_MAX_BYTES,
  SourceControlledTutorialApprovalBundleSchema,
  SourceControlledTutorialApprovalReceiptSchema,
  SourceControlledTutorialHeroSchema,
  sourceControlledTutorialHeroDeclaration,
  type SourceControlledTutorialApprovalBundle,
  type SourceControlledTutorialApprovalReceipt,
  type SourceControlledTutorialHero,
} from "@/lib/marketing/tutorial-handoff-contract";
import {
  containsCredentialLikeData,
  normalizeMarketingSourceUrl,
} from "@/lib/marketing/source-url";
import {
  MarketingClaimSchema,
  MarketingDisclosureSchema,
  MarketingTopicSchema,
} from "@/lib/marketing/schemas";

const PUBLICATION_URL = "https://defitutorials.substack.com";
const EDITOR_URL = "https://defitutorials.substack.com/publish/post";
const FEED_URL = "https://defitutorials.substack.com/feed";
const SOURCE_MAX_BYTES = 275_000;
const SOURCE_SHA256 = /^[0-9a-f]{64}$/u;
const TUTORIAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SOURCE_PATH = /^docs\/tutorials\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;
const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

const tutorialHandoffFields = {
  subtitle: z.string().trim().min(1).max(300).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).min(2).max(5),
  sourceSha256: z.string().regex(SOURCE_SHA256),
  bodySha256: z.string().regex(SOURCE_SHA256),
  hero: SourceControlledTutorialHeroSchema,
  topics: z.array(MarketingTopicSchema).min(1).max(8),
  disclosures: z.array(MarketingDisclosureSchema).max(2),
  claims: z.array(MarketingClaimSchema).max(24),
} as const;

const tutorialBase = z
  .object({
    id: z.string().min(1).max(200).regex(TUTORIAL_ID),
    title: z.string().trim().min(1).max(200),
    sourcePath: z.string().regex(SOURCE_PATH),
  })
  .strict();

const handoffTutorialBase = tutorialBase.extend(tutorialHandoffFields);

export const SourceControlledTutorialManifestSchema = z
  .object({
    version: z.literal(1),
    publication: z.literal(PUBLICATION_URL),
    feed: z.literal(FEED_URL),
    statusDefinitions: z
      .object({
        draft: z.string().min(1),
        approved_handoff: z.string().min(1),
        rss_confirmed: z.string().min(1),
      })
      .strict(),
    tutorials: z
      .array(
        z.discriminatedUnion("status", [
          handoffTutorialBase.extend({
            status: z.literal("draft"),
            preparedAt: z.iso.date(),
            canonicalUrl: z.null(),
            publishedAt: z.null(),
          }),
          handoffTutorialBase.extend({
            status: z.literal("approved_handoff"),
            preparedAt: z.iso.date(),
            approvedAt: z.iso.datetime(),
            canonicalUrl: z.null(),
            publishedAt: z.null(),
          }),
          tutorialBase.extend({
            status: z.literal("rss_confirmed"),
            canonicalUrl: z
              .url()
              .regex(
                /^https:\/\/defitutorials\.substack\.com\/p\/[a-z0-9]+(?:-[a-z0-9]+)*$/u,
              ),
            publishedAt: z.iso.datetime(),
          }),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, tutorial] of manifest.tutorials.entries()) {
      if (ids.has(tutorial.id)) {
        context.addIssue({
          code: "custom",
          message: "Tutorial ids must be unique.",
          path: ["tutorials", index, "id"],
        });
      }
      ids.add(tutorial.id);
      if (tutorial.sourcePath !== `docs/tutorials/${tutorial.id}.md`) {
        context.addIssue({
          code: "custom",
          message: "Tutorial sourcePath must be derived from tutorial id.",
          path: ["tutorials", index, "sourcePath"],
        });
      }
      if (tutorial.status !== "rss_confirmed") {
        const tags = tutorial.tags.map((tag) => tag.toLowerCase());
        if (new Set(tags).size !== tags.length) {
          context.addIssue({
            code: "custom",
            message: "Tutorial handoff tags must be unique.",
            path: ["tutorials", index, "tags"],
          });
        }
        if (new Set(tutorial.topics).size !== tutorial.topics.length) {
          context.addIssue({
            code: "custom",
            message: "Tutorial handoff topics must be unique.",
            path: ["tutorials", index, "topics"],
          });
        }
        if (
          new Set(tutorial.disclosures).size !== tutorial.disclosures.length
        ) {
          context.addIssue({
            code: "custom",
            message: "Tutorial handoff disclosures must be unique.",
            path: ["tutorials", index, "disclosures"],
          });
        }
      }
    }
  });

type SourceControlledTutorialManifest = z.infer<
  typeof SourceControlledTutorialManifestSchema
>;
type HandoffManifestTutorial = Extract<
  SourceControlledTutorialManifest["tutorials"][number],
  { status: "draft" | "approved_handoff" }
>;

export interface TutorialSourceLoadOptions {
  /** Defaults to the checked-out application root. */
  rootDir?: string;
  /** Test seam. Production callers use the imported source-controlled manifest. */
  manifest?: unknown;
  /** Test seam. Production callers use a real, containment-checked file read. */
  readSource?: (absolutePath: string) => Uint8Array;
  /** Test seam. Production callers use a real, containment-checked hero read. */
  readHero?: (absolutePath: string) => Uint8Array;
}

export interface SourceControlledTutorialEditorHandoff
  extends SubstackEditorHandoff {
  source: {
    version: 2;
    tutorialId: string;
    sourcePath: string;
    sourceSha256: string;
    bodySha256: string;
    hero: SourceControlledTutorialHero;
    modelRewriteAllowed: false;
  };
  approval: SourceControlledTutorialApprovalReceipt;
}

export interface SourceControlledTutorialSelection {
  tutorialId: string;
  title: string;
  manifestStatus: "draft" | "approved_handoff";
  sourcePath: string;
  sourceSha256: string;
  bodySha256: string;
  hero: SourceControlledTutorialHero;
}

export interface SourceControlledTutorialHeroAsset
  extends SourceControlledTutorialHero {
  tutorialId: string;
  fileName: string;
  bytes: Uint8Array;
}

export class TutorialHandoffSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TutorialHandoffSourceError";
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function manifestTutorial(
  rawManifest: unknown,
  tutorialId: string,
): HandoffManifestTutorial {
  if (!TUTORIAL_ID.test(tutorialId)) {
    throw new TutorialHandoffSourceError("Tutorial selection is invalid.");
  }
  const manifest = SourceControlledTutorialManifestSchema.safeParse(rawManifest);
  if (!manifest.success) {
    throw new TutorialHandoffSourceError("Tutorial manifest is invalid.");
  }
  const tutorial = manifest.data.tutorials.find((item) => item.id === tutorialId);
  if (!tutorial) {
    throw new TutorialHandoffSourceError("Tutorial selection was not found.");
  }
  if (tutorial.status === "rss_confirmed") {
    throw new TutorialHandoffSourceError(
      "An RSS-confirmed tutorial cannot be prepared as a new editor handoff.",
    );
  }
  return tutorial;
}

function checkedSourcePath(rootDir: string, sourcePath: string): string {
  const root = resolve(rootDir);
  const tutorialRoot = resolve(root, "docs", "tutorials");
  const absolutePath = resolve(root, sourcePath);
  const relativePath = relative(tutorialRoot, absolutePath);
  if (
    !relativePath
    || relativePath.startsWith(`..${sep}`)
    || relativePath === ".."
    || resolve(dirname(absolutePath)) !== tutorialRoot
  ) {
    throw new TutorialHandoffSourceError("Tutorial source path escaped its root.");
  }
  return absolutePath;
}

function readCheckedSource(rootDir: string, sourcePath: string): Uint8Array {
  const absolutePath = checkedSourcePath(rootDir, sourcePath);
  try {
    const tutorialRoot = realpathSync(join(resolve(rootDir), "docs", "tutorials"));
    const realSourcePath = realpathSync(absolutePath);
    const relativePath = relative(tutorialRoot, realSourcePath);
    if (
      relativePath.startsWith(`..${sep}`)
      || relativePath === ".."
      || resolve(dirname(realSourcePath)) !== tutorialRoot
    ) {
      throw new TutorialHandoffSourceError(
        "Tutorial source symlink escaped its root.",
      );
    }
    return readFileSync(realSourcePath);
  } catch (error) {
    if (error instanceof TutorialHandoffSourceError) throw error;
    throw new TutorialHandoffSourceError("Tutorial source could not be read.");
  }
}

function checkedHeroPath(rootDir: string, sourcePath: string): string {
  const root = resolve(rootDir);
  const mediaRoot = resolve(root, "docs", "media");
  const absolutePath = resolve(root, sourcePath);
  const relativePath = relative(mediaRoot, absolutePath);
  if (
    !relativePath
    || relativePath.startsWith(`..${sep}`)
    || relativePath === ".."
    || resolve(dirname(absolutePath)) !== mediaRoot
  ) {
    throw new TutorialHandoffSourceError("Tutorial hero path escaped its root.");
  }
  return absolutePath;
}

function readCheckedHero(rootDir: string, sourcePath: string): Uint8Array {
  const absolutePath = checkedHeroPath(rootDir, sourcePath);
  try {
    const mediaRoot = realpathSync(join(resolve(rootDir), "docs", "media"));
    const realHeroPath = realpathSync(absolutePath);
    const relativePath = relative(mediaRoot, realHeroPath);
    if (
      relativePath.startsWith(`..${sep}`)
      || relativePath === ".."
      || resolve(dirname(realHeroPath)) !== mediaRoot
    ) {
      throw new TutorialHandoffSourceError(
        "Tutorial hero symlink escaped its root.",
      );
    }
    const size = statSync(realHeroPath).size;
    if (size < 4 || size > SOURCE_CONTROLLED_TUTORIAL_HERO_MAX_BYTES) {
      throw new TutorialHandoffSourceError(
        "Tutorial hero file size is invalid.",
      );
    }
    return readFileSync(realHeroPath);
  } catch (error) {
    if (error instanceof TutorialHandoffSourceError) throw error;
    throw new TutorialHandoffSourceError("Tutorial hero could not be read.");
  }
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.byteLength < 12
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.byteLength - 2] !== 0xff
    || bytes[bytes.byteLength - 1] !== 0xd9
  ) {
    throw new TutorialHandoffSourceError(
      "Tutorial hero is not a complete JPEG image.",
    );
  }

  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (offset < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) {
      throw new TutorialHandoffSourceError(
        "Tutorial hero JPEG structure is invalid.",
      );
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) {
      throw new TutorialHandoffSourceError(
        "Tutorial hero JPEG structure is invalid.",
      );
    }

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8) {
      throw new TutorialHandoffSourceError(
        "Tutorial hero JPEG structure is invalid.",
      );
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) {
      throw new TutorialHandoffSourceError(
        "Tutorial hero JPEG structure is invalid.",
      );
    }

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      throw new TutorialHandoffSourceError(
        "Tutorial hero JPEG structure is invalid.",
      );
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8 || bytes[offset + 2] !== 8 || dimensions) {
        throw new TutorialHandoffSourceError(
          "Tutorial hero JPEG frame is invalid.",
        );
      }
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width < 1 || height < 1) {
        throw new TutorialHandoffSourceError(
          "Tutorial hero JPEG dimensions are invalid.",
        );
      }
      dimensions = { width, height };
    }
    offset += segmentLength;
    // Entropy-coded scan data is validated by the pinned hash and terminal EOI.
    // Header parsing stops at SOS because byte-stuffing makes it non-segment data.
    if (marker === 0xda) break;
  }

  if (!dimensions) {
    throw new TutorialHandoffSourceError(
      "Tutorial hero JPEG has no supported frame dimensions.",
    );
  }
  return dimensions;
}

function verifiedHeroBytes(
  rootDir: string,
  hero: SourceControlledTutorialHero,
  readHero?: (absolutePath: string) => Uint8Array,
): Uint8Array {
  const absolutePath = checkedHeroPath(rootDir, hero.sourcePath);
  const bytes = readHero
    ? readHero(absolutePath)
    : readCheckedHero(rootDir, hero.sourcePath);
  if (
    bytes.byteLength < 4
    || bytes.byteLength > SOURCE_CONTROLLED_TUTORIAL_HERO_MAX_BYTES
    || bytes.byteLength !== hero.byteLength
  ) {
    throw new TutorialHandoffSourceError(
      "Tutorial hero byte length does not match the reviewed manifest.",
    );
  }
  if (sha256(bytes) !== hero.sha256) {
    throw new TutorialHandoffSourceError(
      "Tutorial hero hash does not match the reviewed manifest.",
    );
  }
  const dimensions = jpegDimensions(bytes);
  if (dimensions.width !== hero.width || dimensions.height !== hero.height) {
    throw new TutorialHandoffSourceError(
      "Tutorial hero dimensions do not match the reviewed manifest.",
    );
  }
  return bytes;
}

function utf8Source(bytes: Uint8Array): string {
  if (bytes.byteLength < 1 || bytes.byteLength > SOURCE_MAX_BYTES) {
    throw new TutorialHandoffSourceError("Tutorial source size is invalid.");
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\r") || !source.endsWith("\n")) {
      throw new TutorialHandoffSourceError(
        "Tutorial source must use LF line endings and end with one newline.",
      );
    }
    return source;
  } catch (error) {
    if (error instanceof TutorialHandoffSourceError) throw error;
    throw new TutorialHandoffSourceError("Tutorial source is not valid UTF-8.");
  }
}

function exactEditorBody(source: string): string {
  const delimiter = `${SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER}\n\n`;
  const first = source.indexOf(delimiter);
  if (first < 0 || source.indexOf(delimiter, first + delimiter.length) >= 0) {
    throw new TutorialHandoffSourceError(
      "Tutorial source must contain exactly one editor-body marker.",
    );
  }
  const body = source.slice(first + delimiter.length);
  if (body.length < 300 || body.length > 250_000 || !body.trim()) {
    throw new TutorialHandoffSourceError("Tutorial editor body size is invalid.");
  }
  return body;
}

function requireExactHeroDeclaration(
  source: string,
  hero: SourceControlledTutorialHero,
): void {
  const bodyMarker = `${SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER}\n\n`;
  const bodyMarkerIndex = source.indexOf(bodyMarker);
  if (bodyMarkerIndex < 0) {
    throw new TutorialHandoffSourceError(
      "Tutorial source has no canonical editor-body marker.",
    );
  }
  const preamble = source.slice(0, bodyMarkerIndex);
  const declaration = sourceControlledTutorialHeroDeclaration(hero);
  const exactLine = `${declaration}\n`;
  const first = preamble.indexOf(exactLine);
  const heroLabels = preamble.match(
    /^\*\*(?:Suggested|Verified) hero:\*\*/gmu,
  ) ?? [];
  if (
    first < 0
    || preamble.indexOf(exactLine, first + exactLine.length) >= 0
    || heroLabels.length !== 1
  ) {
    throw new TutorialHandoffSourceError(
      "Tutorial source hero declaration does not match the reviewed manifest.",
    );
  }
}

function exactCanonicalLinks(body: string): string[] {
  const unique = new Set<string>();
  const candidates = body.match(/https:\/\/[^\s<>"'`]+/gu) ?? [];
  for (const candidate of candidates) {
    const raw = candidate.replace(/[\])}>.,!?;:]+$/gu, "");
    let normalized: string;
    try {
      normalized = normalizeMarketingSourceUrl(raw);
    } catch {
      throw new TutorialHandoffSourceError(
        "Tutorial body contains a non-canonical outbound link.",
      );
    }
    if (normalized !== raw) {
      throw new TutorialHandoffSourceError(
        "Tutorial body links must already be canonical.",
      );
    }
    unique.add(raw);
  }
  return [...unique];
}

function bundlesMatch(
  approved: SourceControlledTutorialApprovalBundle,
  current: SourceControlledTutorialApprovalBundle,
): boolean {
  return JSON.stringify(approved) === JSON.stringify(current);
}

/**
 * Load one exact source-controlled draft for owner review.
 *
 * The model is not called. The manifest pins both the complete source file and
 * the exact editor body slice. A changed byte requires a new manifest hash and
 * therefore a fresh owner review.
 */
function loadVerifiedSourceControlledTutorial(
  tutorialId: string,
  options: TutorialSourceLoadOptions = {},
): {
  bundle: SourceControlledTutorialApprovalBundle;
  heroBytes: Uint8Array;
} {
  const tutorial = manifestTutorial(
    options.manifest ?? tutorialManifestJson,
    tutorialId,
  );
  const rootDir = options.rootDir ?? process.cwd();
  const absolutePath = checkedSourcePath(rootDir, tutorial.sourcePath);
  const sourceBytes = options.readSource
    ? options.readSource(absolutePath)
    : readCheckedSource(rootDir, tutorial.sourcePath);
  const source = utf8Source(sourceBytes);
  const sourceHash = sha256(sourceBytes);
  if (sourceHash !== tutorial.sourceSha256) {
    throw new TutorialHandoffSourceError(
      "Tutorial source hash does not match the reviewed manifest.",
    );
  }

  const firstHeading = source.match(/^# (.+)$/mu)?.[1]?.trim();
  if (firstHeading !== tutorial.title) {
    throw new TutorialHandoffSourceError(
      "Tutorial source title does not match the reviewed manifest.",
    );
  }
  if (containsCredentialLikeData(source)) {
    throw new TutorialHandoffSourceError(
      "Tutorial source contains credential-like data.",
    );
  }
  const bodyMarkdown = exactEditorBody(source);
  requireExactHeroDeclaration(source, tutorial.hero);
  const heroBytes = verifiedHeroBytes(
    rootDir,
    tutorial.hero,
    options.readHero,
  );
  const bodyHash = sha256(bodyMarkdown);
  if (bodyHash !== tutorial.bodySha256) {
    throw new TutorialHandoffSourceError(
      "Tutorial editor body hash does not match the reviewed manifest.",
    );
  }
  const links = exactCanonicalLinks(bodyMarkdown);

  const bundle = SourceControlledTutorialApprovalBundleSchema.parse({
    version: SOURCE_CONTROLLED_TUTORIAL_BUNDLE_VERSION,
    channel: "substack",
    status: "requires_owner_approval",
    tutorialId: tutorial.id,
    manifestStatus: tutorial.status,
    sourcePath: tutorial.sourcePath,
    sourceSha256: sourceHash,
    bodySha256: bodyHash,
    hero: tutorial.hero,
    title: tutorial.title,
    ...(tutorial.subtitle ? { subtitle: tutorial.subtitle } : {}),
    tags: tutorial.tags,
    topics: tutorial.topics,
    disclosures: tutorial.disclosures,
    claims: tutorial.claims,
    links,
    bodyMarkdown,
    editorUrl: EDITOR_URL,
    publicationUrl: PUBLICATION_URL,
    modelRewriteAllowed: false,
    apiWriteAttempted: false,
    privateEndpointUsed: false,
    approval: {
      required: true,
      decision: "pending",
      scope: "exact_source_and_body_sha256",
      tutorialId: tutorial.id,
      sourceSha256: sourceHash,
      bodySha256: bodyHash,
      statement: SOURCE_CONTROLLED_TUTORIAL_APPROVAL_STATEMENT,
    },
  });
  return { bundle, heroBytes };
}

export function loadSourceControlledTutorialApprovalBundle(
  tutorialId: string,
  options: TutorialSourceLoadOptions = {},
): SourceControlledTutorialApprovalBundle {
  return loadVerifiedSourceControlledTutorial(tutorialId, options).bundle;
}

/**
 * Return the exact source-controlled bytes for an authenticated owner handoff.
 * Loading the asset also revalidates the source declaration, editor body, file
 * hash, byte length, JPEG structure, dimensions, and direct-child containment.
 */
export function loadSourceControlledTutorialHeroAsset(
  tutorialId: string,
  options: TutorialSourceLoadOptions = {},
): SourceControlledTutorialHeroAsset {
  const { bundle, heroBytes } = loadVerifiedSourceControlledTutorial(
    tutorialId,
    options,
  );
  return {
    tutorialId: bundle.tutorialId,
    fileName: basename(bundle.hero.sourcePath),
    ...bundle.hero,
    bytes: heroBytes,
  };
}

/**
 * Return only handoff-eligible tutorials whose current source bytes still
 * match the manifest. The body remains available only in the private approval
 * bundle; a selector does not need to expose it.
 */
export function listSourceControlledTutorialSelections(
  options: TutorialSourceLoadOptions = {},
): SourceControlledTutorialSelection[] {
  const parsed = SourceControlledTutorialManifestSchema.safeParse(
    options.manifest ?? tutorialManifestJson,
  );
  if (!parsed.success) {
    throw new TutorialHandoffSourceError("Tutorial manifest is invalid.");
  }
  return parsed.data.tutorials
    .filter(
      (tutorial): tutorial is HandoffManifestTutorial =>
        tutorial.status !== "rss_confirmed",
    )
    .map((tutorial) => {
      const bundle = loadSourceControlledTutorialApprovalBundle(
        tutorial.id,
        options,
      );
      return {
        tutorialId: bundle.tutorialId,
        title: bundle.title,
        manifestStatus: bundle.manifestStatus,
        sourcePath: bundle.sourcePath,
        sourceSha256: bundle.sourceSha256,
        bodySha256: bundle.bodySha256,
        hero: bundle.hero,
      };
    });
}

/**
 * Re-read and re-hash the source immediately before creating the copy-only
 * official-editor handoff. No Substack write endpoint is called.
 */
export function createSourceControlledTutorialEditorHandoff(
  rawBundle: SourceControlledTutorialApprovalBundle,
  rawApproval: SourceControlledTutorialApprovalReceipt,
  idempotencyKey: string,
  options: TutorialSourceLoadOptions = {},
): SourceControlledTutorialEditorHandoff {
  const bundle = SourceControlledTutorialApprovalBundleSchema.parse(rawBundle);
  const approval = SourceControlledTutorialApprovalReceiptSchema.parse(
    rawApproval,
  );
  if (
    approval.tutorialId !== bundle.tutorialId
    || approval.sourceSha256 !== bundle.sourceSha256
    || approval.bodySha256 !== bundle.bodySha256
  ) {
    throw new TutorialHandoffSourceError(
      "Tutorial approval does not match the exact reviewed hashes.",
    );
  }

  const current = loadSourceControlledTutorialApprovalBundle(
    bundle.tutorialId,
    options,
  );
  if (!bundlesMatch(bundle, current)) {
    throw new TutorialHandoffSourceError(
      "Tutorial source or manifest changed after approval; start a fresh review.",
    );
  }

  const handoff = createSubstackEditorHandoff({
    title: current.title,
    ...(current.subtitle ? { subtitle: current.subtitle } : {}),
    bodyMarkdown: current.bodyMarkdown,
    tags: current.tags,
    idempotencyKey,
  });
  return {
    ...handoff,
    source: {
      version: SOURCE_CONTROLLED_TUTORIAL_BUNDLE_VERSION,
      tutorialId: current.tutorialId,
      sourcePath: current.sourcePath,
      sourceSha256: current.sourceSha256,
      bodySha256: current.bodySha256,
      hero: current.hero,
      modelRewriteAllowed: false,
    },
    approval,
  };
}
