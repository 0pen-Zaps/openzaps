<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Two things here fail silently

**Tokens are themed; `/` is not.** Every colour, shadow, and radius in the app resolves from the five theme blocks in `src/app/globals.css`. The landing page at `/` pins its own copies in `src/app/(landing)/landing.module.css`, including the ones the shared primitives (`.btn`, `.mono`, `.container`, …) read. Make a shared primitive read a token that is not pinned there and `/` repaints with whatever theme the app is set to — no error, no test, just a bone-white hero button on a black page.

**`/zapdraw` starts with `/zap`.** Any `pathname.startsWith("/zap")` matches the game as well as the builder. Compare `pathname === "/zap"`; the builder's four views live in `?view=`, never in the path.
