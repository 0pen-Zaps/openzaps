import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER,
  sourceControlledTutorialHeroDeclaration,
  type SourceControlledTutorialHero,
} from "./tutorial-handoff-contract";
import {
  createSourceControlledTutorialEditorHandoff,
  listSourceControlledTutorialSelections,
  loadSourceControlledTutorialApprovalBundle,
  loadSourceControlledTutorialHeroAsset,
} from "./tutorial-handoff-source";

const TITLE = "Paper Trade First";
const BODY = `${"Use a virtual route and record its exact boundary. ".repeat(8)}

Pre-audit software. Verify before use.

Read https://www.0xzaps.com/docs before moving from simulation to a capped pilot.
`;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jpeg(width = 1128, height = 440): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

function hero(bytes: Uint8Array = jpeg()): SourceControlledTutorialHero {
  return {
    sourcePath: "docs/media/paper-trade-first.jpg",
    sha256: sha256(bytes),
    mimeType: "image/jpeg",
    width: 1128,
    height: 440,
    byteLength: bytes.byteLength,
    alt: "OpenZaps Virtual Trading paper-trading safety preview.",
  };
}

function source(
  body = BODY,
  title = TITLE,
  sourceHero: SourceControlledTutorialHero = hero(),
): string {
  return `# ${title}

**Publication:** DeFi Tutorials

${sourceControlledTutorialHeroDeclaration(sourceHero)}

${SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER}

${body}`;
}

function manifest(
  sourceText = source(),
  body = BODY,
  sourceHero: SourceControlledTutorialHero = hero(),
): unknown {
  return {
    version: 1,
    publication: "https://defitutorials.substack.com",
    feed: "https://defitutorials.substack.com/feed",
    statusDefinitions: {
      draft: "Draft",
      approved_handoff: "Approved handoff",
      rss_confirmed: "RSS confirmed",
    },
    tutorials: [
      {
        id: "paper-trade-first",
        title: TITLE,
        subtitle: "A bounded tutorial",
        tags: ["DeFi", "OpenZaps"],
        sourcePath: "docs/tutorials/paper-trade-first.md",
        sourceSha256: sha256(sourceText),
        bodySha256: sha256(body),
        hero: sourceHero,
        topics: ["protocol", "simulation"],
        disclosures: ["pre_audit"],
        claims: [
          {
            text: "The tutorial uses a virtual route.",
            factKeys: ["product.virtual_trading"],
            treatment: "asserted",
          },
        ],
        status: "draft",
        preparedAt: "2026-08-01",
        canonicalUrl: null,
        publishedAt: null,
      },
    ],
  };
}

function load(
  sourceText = source(),
  rawManifest: unknown = manifest(sourceText),
  heroBytes: Uint8Array = jpeg(),
) {
  return loadSourceControlledTutorialApprovalBundle("paper-trade-first", {
    rootDir: "/worktree",
    manifest: rawManifest,
    readSource: () => Buffer.from(sourceText),
    readHero: () => heroBytes,
  });
}

describe("source-controlled Substack tutorial handoff", () => {
  it("selects the exact manifest source and returns a hash-bound approval bundle", () => {
    const bundle = load();

    expect(bundle).toMatchObject({
      version: 2,
      channel: "substack",
      status: "requires_owner_approval",
      tutorialId: "paper-trade-first",
      sourcePath: "docs/tutorials/paper-trade-first.md",
      title: TITLE,
      subtitle: "A bounded tutorial",
      tags: ["DeFi", "OpenZaps"],
      hero: hero(),
      bodyMarkdown: BODY,
      links: ["https://www.0xzaps.com/docs"],
      modelRewriteAllowed: false,
      apiWriteAttempted: false,
      privateEndpointUsed: false,
      approval: {
        required: true,
        decision: "pending",
        scope: "exact_source_and_body_sha256",
        tutorialId: "paper-trade-first",
      },
    });
    expect(bundle.sourceSha256).toBe(sha256(source()));
    expect(bundle.bodySha256).toBe(sha256(BODY));
    expect(bundle.approval.sourceSha256).toBe(bundle.sourceSha256);
    expect(bundle.approval.bodySha256).toBe(bundle.bodySha256);
  });

  it("lists only byte-verified handoff selections without exposing body copy", () => {
    expect(
      listSourceControlledTutorialSelections({
        rootDir: "/worktree",
        manifest: manifest(),
        readSource: () => Buffer.from(source()),
        readHero: () => jpeg(),
      }),
    ).toEqual([
      {
        tutorialId: "paper-trade-first",
        title: TITLE,
        manifestStatus: "draft",
        sourcePath: "docs/tutorials/paper-trade-first.md",
        sourceSha256: sha256(source()),
        bodySha256: sha256(BODY),
        hero: hero(),
      },
    ]);
  });

  it("fails closed on source-byte, body, title, marker, and outbound-link drift", () => {
    expect(() => load(`${source()}changed\n`, manifest(source()))).toThrow(
      "source hash does not match",
    );

    const changedBody = `${BODY}One more reviewed sentence.\n`;
    expect(() =>
      load(source(changedBody), manifest(source(changedBody), BODY)),
    ).toThrow("editor body hash does not match");

    const wrongTitle = source(BODY, "Different title");
    expect(() => load(wrongTitle, manifest(wrongTitle))).toThrow(
      "source title does not match",
    );

    const missingMarker = source().replace(
      `${SOURCE_CONTROLLED_TUTORIAL_BODY_MARKER}\n\n`,
      "",
    );
    expect(() => load(missingMarker, manifest(missingMarker))).toThrow(
      "exactly one editor-body marker",
    );

    const externalBody = `${BODY}https://attacker.example/tutorial\n`;
    expect(() =>
      load(
        source(externalBody),
        manifest(source(externalBody), externalBody),
      ),
    ).toThrow("non-canonical outbound link");
  });

  it("verifies the exact hero bytes, JPEG structure, dimensions, and source declaration", () => {
    const bytes = jpeg();
    const sourceHero = hero(bytes);
    const sourceText = source(BODY, TITLE, sourceHero);
    const asset = loadSourceControlledTutorialHeroAsset("paper-trade-first", {
      rootDir: "/worktree",
      manifest: manifest(sourceText, BODY, sourceHero),
      readSource: () => Buffer.from(sourceText),
      readHero: () => bytes,
    });

    expect(asset).toMatchObject({
      tutorialId: "paper-trade-first",
      fileName: "paper-trade-first.jpg",
      ...sourceHero,
    });
    expect(asset.bytes).toEqual(bytes);

    const changedBytes = Uint8Array.from(bytes);
    changedBytes[12] ^= 1;
    expect(() =>
      load(sourceText, manifest(sourceText, BODY, sourceHero), changedBytes)
    ).toThrow("hero hash does not match");

    const wrongLength = { ...sourceHero, byteLength: sourceHero.byteLength + 1 };
    const wrongLengthSource = source(BODY, TITLE, wrongLength);
    expect(() =>
      load(
        wrongLengthSource,
        manifest(wrongLengthSource, BODY, wrongLength),
        bytes,
      )
    ).toThrow("hero byte length does not match");

    const wrongDimensions = { ...sourceHero, width: sourceHero.width - 1 };
    const wrongDimensionsSource = source(BODY, TITLE, wrongDimensions);
    expect(() =>
      load(
        wrongDimensionsSource,
        manifest(wrongDimensionsSource, BODY, wrongDimensions),
        bytes,
      )
    ).toThrow("hero dimensions do not match");

    const incompleteJpeg = bytes.slice(0, -2);
    const incompleteHero = hero(incompleteJpeg);
    const incompleteSource = source(BODY, TITLE, incompleteHero);
    expect(() =>
      load(
        incompleteSource,
        manifest(incompleteSource, BODY, incompleteHero),
        incompleteJpeg,
      )
    ).toThrow("not a complete JPEG");

    const changedDeclarationHero = {
      ...sourceHero,
      alt: "A different owner-visible description.",
    };
    expect(() =>
      load(
        sourceText,
        manifest(sourceText, BODY, changedDeclarationHero),
        bytes,
      )
    ).toThrow("hero declaration does not match");
  });

  it("rejects a direct-child hero symlink that escapes docs/media", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "openzaps-tutorial-hero-"));
    try {
      const bytes = jpeg();
      const sourceHero = hero(bytes);
      const sourceText = source(BODY, TITLE, sourceHero);
      mkdirSync(join(rootDir, "docs", "tutorials"), { recursive: true });
      mkdirSync(join(rootDir, "docs", "media"), { recursive: true });
      writeFileSync(
        join(rootDir, "docs", "tutorials", "paper-trade-first.md"),
        sourceText,
      );
      const outsidePath = join(rootDir, "outside.jpg");
      writeFileSync(outsidePath, bytes);
      symlinkSync(
        outsidePath,
        join(rootDir, "docs", "media", "paper-trade-first.jpg"),
      );

      expect(() =>
        loadSourceControlledTutorialApprovalBundle("paper-trade-first", {
          rootDir,
          manifest: manifest(sourceText, BODY, sourceHero),
        })
      ).toThrow("hero symlink escaped its root");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("requires approval of both exact hashes and revalidates before handoff", () => {
    const bundle = load();
    const approval = {
      decision: "approve" as const,
      approvedBy: "owner",
      tutorialId: bundle.tutorialId,
      sourceSha256: bundle.sourceSha256,
      bodySha256: bundle.bodySha256,
    };

    expect(() =>
      createSourceControlledTutorialEditorHandoff(
        bundle,
        { ...approval, bodySha256: "0".repeat(64) },
        "tutorial:paper-trade-first",
        {
          rootDir: "/worktree",
          manifest: manifest(),
          readSource: () => Buffer.from(source()),
          readHero: () => jpeg(),
        },
      ),
    ).toThrow("approval does not match");

    expect(() =>
      createSourceControlledTutorialEditorHandoff(
        bundle,
        approval,
        "tutorial:paper-trade-first",
        {
          rootDir: "/worktree",
          manifest: manifest(),
          readSource: () => Buffer.from(`${source()}changed\n`),
          readHero: () => jpeg(),
        },
      ),
    ).toThrow("source hash does not match");

    const changedHero = Uint8Array.from(jpeg());
    changedHero[12] ^= 1;
    expect(() =>
      createSourceControlledTutorialEditorHandoff(
        bundle,
        approval,
        "tutorial:paper-trade-first",
        {
          rootDir: "/worktree",
          manifest: manifest(),
          readSource: () => Buffer.from(source()),
          readHero: () => changedHero,
        },
      ),
    ).toThrow("hero hash does not match");
  });

  it("creates only a copy-ready official-editor package after exact approval", () => {
    const bundle = load();
    const handoff = createSourceControlledTutorialEditorHandoff(
      bundle,
      {
        decision: "approve",
        approvedBy: "owner",
        tutorialId: bundle.tutorialId,
        sourceSha256: bundle.sourceSha256,
        bodySha256: bundle.bodySha256,
      },
      "tutorial:paper-trade-first",
      {
        rootDir: "/worktree",
        manifest: manifest(),
        readSource: () => Buffer.from(source()),
        readHero: () => jpeg(),
      },
    );

    expect(handoff).toMatchObject({
      status: "requires-human-publish",
      editorUrl: "https://defitutorials.substack.com/publish/post",
      apiWriteAttempted: false,
      privateEndpointUsed: false,
      draft: {
        title: TITLE,
        bodyMarkdown: BODY,
      },
      source: {
        version: 2,
        tutorialId: "paper-trade-first",
        sourceSha256: bundle.sourceSha256,
        bodySha256: bundle.bodySha256,
        hero: hero(),
        modelRewriteAllowed: false,
      },
      approval: {
        decision: "approve",
        approvedBy: "owner",
      },
    });
  });

  it("rejects already-published entries instead of preparing duplicates", () => {
    const raw = manifest() as {
      tutorials: Array<Record<string, unknown>>;
    };
    raw.tutorials[0] = {
      id: "paper-trade-first",
      title: TITLE,
      sourcePath: "docs/tutorials/paper-trade-first.md",
      status: "rss_confirmed",
      canonicalUrl: "https://defitutorials.substack.com/p/paper-trade-first",
      publishedAt: "2026-08-01T12:00:00.000Z",
    };

    expect(() => load(source(), raw)).toThrow(
      "RSS-confirmed tutorial cannot be prepared",
    );
  });
});
