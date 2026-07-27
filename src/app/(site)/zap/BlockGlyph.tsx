/**
 * The builder catalogue's icon component.
 *
 * The geometry moved to `@/components/Glyph` when the app shell started needing
 * the same marks — one set of paths, drawn once, so a nav item and the block it
 * navigates to can never diverge. This name survives because the builder refers
 * to its marks as block glyphs and roughly forty call sites say so.
 */
export { Glyph as BlockGlyph, type GlyphName } from "@/components/Glyph";
