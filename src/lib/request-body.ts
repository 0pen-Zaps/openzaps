/**
 * A bounded JSON-body reader for public Route Handlers.
 *
 * `Request.text()` buffers the entire body before callers can measure it, and
 * JavaScript string length counts UTF-16 code units rather than encoded bytes.
 * This reader rejects an oversized declared length up front and enforces the
 * same byte cap while consuming chunked/streamed requests.
 */
export class BoundedJsonBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = "BoundedJsonBodyError";
  }
}

export class BoundedTextBodyError extends Error {
  constructor(readonly status: 413) {
    super("Body too large.");
    this.name = "BoundedTextBodyError";
  }
}

async function consumeBoundedTextBody(
  request: Pick<Request, "headers" | "body">,
  maxBytes: number,
  oversized: () => Error,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(maxBytes)) {
    throw oversized();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size classification must not be masked by a producer's cancel error.
        }
        throw oversized();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read an exact text body without first buffering more than `maxBytes`.
 *
 * Signature-verification endpoints need the original text, so parsing and
 * normalization must remain the caller's responsibility.
 */
export function readBoundedTextBody(
  request: Pick<Request, "headers" | "body">,
  maxBytes: number,
): Promise<string> {
  return consumeBoundedTextBody(
    request,
    maxBytes,
    () => new BoundedTextBodyError(413),
  );
}

export async function readBoundedJsonBody(
  request: Pick<Request, "headers" | "body">,
  maxBytes: number,
): Promise<unknown> {
  if (!request.body) {
    throw new BoundedJsonBodyError("Body must be valid JSON.", 400);
  }
  const text = await consumeBoundedTextBody(
    request,
    maxBytes,
    () => new BoundedJsonBodyError("Body too large.", 413),
  );

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundedJsonBodyError("Body must be valid JSON.", 400);
  }
}
