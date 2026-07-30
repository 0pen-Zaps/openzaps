import { afterEach, describe, expect, it, vi } from "vitest";

import { policyRegistryConfigured } from "@/lib/policy-template-server";
import { relayConfigured } from "@/lib/relay-server";
import {
  isBoundSupabaseUrl,
  openZapsSupabaseConfiguration,
} from "@/lib/supabase-config";

const PROJECT_REF = "abcdefghijklmnopqrst";
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  OPENZAPS_SUPABASE_PROJECT_REF: PROJECT_REF,
  SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY: "server-only-service-role-key",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shared Supabase project binding", () => {
  it("requires one exact canonical HTTPS project origin in production", () => {
    expect(openZapsSupabaseConfiguration(PRODUCTION_ENV)).toEqual({
      restUrl: `https://${PROJECT_REF}.supabase.co/rest/v1/`,
      serviceRoleKey: "server-only-service-role-key",
    });
    expect(openZapsSupabaseConfiguration({
      ...PRODUCTION_ENV,
      OPENZAPS_SUPABASE_PROJECT_REF: "anotherprojectref",
    })).toBeNull();
    expect(openZapsSupabaseConfiguration({
      ...PRODUCTION_ENV,
      OPENZAPS_SUPABASE_PROJECT_REF: undefined,
    })).toBeNull();
    expect(openZapsSupabaseConfiguration({
      ...PRODUCTION_ENV,
      SUPABASE_URL: `http://${PROJECT_REF}.supabase.co`,
    })).toBeNull();
  });

  it("rejects URL ambiguity and malformed server secrets", () => {
    for (const url of [
      `https://${PROJECT_REF}.supabase.co:443`,
      `https://user:password@${PROJECT_REF}.supabase.co`,
      `https://${PROJECT_REF}.supabase.co/rest/v1`,
      `https://${PROJECT_REF}.supabase.co?project=other`,
      `https://${PROJECT_REF}.supabase.co#other`,
      ` https://${PROJECT_REF}.supabase.co`,
    ]) {
      expect(openZapsSupabaseConfiguration({
        ...PRODUCTION_ENV,
        SUPABASE_URL: url,
      })).toBeNull();
    }
    expect(openZapsSupabaseConfiguration({
      ...PRODUCTION_ENV,
      SUPABASE_SERVICE_ROLE_KEY: "bad\nkey",
    })).toBeNull();
  });

  it("allows loopback HTTP only outside production", () => {
    expect(openZapsSupabaseConfiguration({
      NODE_ENV: "test",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "local-key",
    })).toEqual({
      restUrl: "http://127.0.0.1:54321/rest/v1/",
      serviceRoleKey: "local-key",
    });
    expect(openZapsSupabaseConfiguration({
      NODE_ENV: "production",
      OPENZAPS_SUPABASE_PROJECT_REF: PROJECT_REF,
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "local-key",
    })).toBeNull();
    expect(isBoundSupabaseUrl(
      `https://${PROJECT_REF}.supabase.co`,
      PROJECT_REF,
      false,
    )).toBe(true);
  });

  it("keeps both relay and policy storage dark until production binds the exact project", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", `https://${PROJECT_REF}.supabase.co`);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "server-only-service-role-key");
    vi.stubEnv("OPENZAPS_SUPABASE_PROJECT_REF", "");
    expect(relayConfigured()).toBe(false);
    expect(policyRegistryConfigured()).toBe(false);

    vi.stubEnv("OPENZAPS_SUPABASE_PROJECT_REF", PROJECT_REF);
    expect(relayConfigured()).toBe(true);
    expect(policyRegistryConfigured()).toBe(true);
  });
});
