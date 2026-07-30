const SUPABASE_PROJECT_REF =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Environment = Readonly<Record<string, string | undefined>>;

export interface OpenZapsSupabaseConfiguration {
  restUrl: string;
  serviceRoleKey: string;
}

export function isSupabaseProjectRef(value: unknown): value is string {
  return typeof value === "string" && SUPABASE_PROJECT_REF.test(value);
}

/**
 * Accept one exact canonical Supabase project origin, with loopback HTTP
 * available only to local/test callers that opt in.
 */
export function isBoundSupabaseUrl(
  raw: string | undefined,
  expectedProjectRef: string | undefined,
  allowLoopback: boolean,
): boolean {
  if (!raw || raw !== raw.trim()) return false;
  try {
    const url = new URL(raw);
    const canonicalOrigin = isSupabaseProjectRef(expectedProjectRef)
      ? `https://${expectedProjectRef}.supabase.co`
      : null;
    const localHttp =
      allowLoopback
      && url.protocol === "http:"
      && LOOPBACK_HOSTS.has(url.hostname);
    const canonicalProject =
      canonicalOrigin !== null
      && (raw === canonicalOrigin || raw === `${canonicalOrigin}/`)
      && url.protocol === "https:"
      && !url.port;
    return (
      (canonicalProject || localHttp)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (url.pathname === "" || url.pathname === "/")
    );
  } catch {
    return false;
  }
}

function serverSecret(value: string | undefined): string | null {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) {
    return null;
  }
  return value.trim();
}

/**
 * Resolve the shared relay/registry/operations store without retaining invalid
 * configuration. Production must bind the credential to one exact project ref.
 */
export function openZapsSupabaseConfiguration(
  env: Environment = process.env,
): OpenZapsSupabaseConfiguration | null {
  const serviceRoleKey = serverSecret(env.SUPABASE_SERVICE_ROLE_KEY);
  const rawUrl = env.SUPABASE_URL;
  if (
    !serviceRoleKey
    || !isBoundSupabaseUrl(
      rawUrl,
      env.OPENZAPS_SUPABASE_PROJECT_REF,
      env.NODE_ENV !== "production",
    )
    || !rawUrl
  ) {
    return null;
  }

  const baseUrl = new URL(rawUrl);
  return {
    restUrl: new URL(
      "rest/v1/",
      baseUrl.href.endsWith("/") ? baseUrl : `${baseUrl.href}/`,
    ).toString(),
    serviceRoleKey,
  };
}

export function requireOpenZapsSupabaseConfiguration(
  env: Environment = process.env,
): OpenZapsSupabaseConfiguration {
  const configuration = openZapsSupabaseConfiguration(env);
  if (!configuration) {
    throw new Error("Supabase storage is not configured.");
  }
  return configuration;
}
