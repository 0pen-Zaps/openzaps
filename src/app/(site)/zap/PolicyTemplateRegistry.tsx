"use client";

import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, getAddress, isAddress, type Address } from "viem";

import { useWalletSession } from "@/components/WalletProvider";
import type { ChainNode } from "@/lib/blocks";
import {
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATE_SUMMARY,
  isPolicyTemplateHash,
  policyTemplatePublishMessage,
  policyTemplateSubscriptionReadMessage,
  policyTemplateSubscriptionMessage,
  POLICY_TEMPLATE_SUBSCRIPTION_TTL_SECONDS,
  preparePolicyTemplate,
  templateChain,
  type PublicPolicyTemplate,
} from "@/lib/policy-templates";
import { getInjectedProvider, robinhoodChain } from "@/lib/robinhood";
import styles from "./policy-template-registry.module.css";

type RegistryResponse = {
  configured: boolean;
  publishingEnabled?: boolean;
  subscriptionsEnabled?: boolean;
  templates: PublicPolicyTemplate[];
  nextCursor?: string | null;
  error?: string;
};

type SubscriptionSnapshotResponse = {
  subscriber?: unknown;
  version?: unknown;
  contentHashes?: unknown;
  error?: string;
  code?: string;
};

type SubscriptionMutationResponse = {
  subscriber?: unknown;
  version?: unknown;
  contentHash?: unknown;
  subscribed?: unknown;
  error?: string;
  code?: string;
};

export function PolicyTemplateRegistry({
  chain,
  parent,
  onLoad,
  onPublished,
}: {
  chain: readonly ChainNode[];
  parent: PublicPolicyTemplate | null;
  onLoad: (template: PublicPolicyTemplate) => void;
  onPublished: (template: PublicPolicyTemplate) => void;
}): React.JSX.Element {
  const walletSession = useWalletSession();
  const [templates, setTemplates] = useState<PublicPolicyTemplate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [publishingEnabled, setPublishingEnabled] = useState(false);
  const [subscriptionsEnabled, setSubscriptionsEnabled] = useState(false);
  const [status, setStatus] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [subscribed, setSubscribed] = useState<Set<string>>(() => new Set());
  const [subscriptionWallet, setSubscriptionWallet] = useState<Address | null>(null);
  const [subscriptionVersion, setSubscriptionVersion] = useState(0);
  const [subscriptionsSyncing, setSubscriptionsSyncing] = useState(false);
  const activeSubscriptionWallet = walletSession.account
    && subscriptionWallet
    && getAddress(walletSession.account) === subscriptionWallet
    ? subscriptionWallet
    : null;

  const load = useCallback(async (cursor: string | null = null): Promise<void> => {
    try {
      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await fetch(`/api/policy-templates${suffix}`, { cache: "no-store" });
      const body = (await response.json()) as RegistryResponse;
      setConfigured(body.configured);
      setPublishingEnabled(body.publishingEnabled === true);
      setSubscriptionsEnabled(body.subscriptionsEnabled === true);
      setTemplates((current) =>
        cursor ? dedupeTemplates([...current, ...(body.templates ?? [])]) : body.templates ?? [],
      );
      setNextCursor(body.nextCursor ?? null);
      if (!response.ok) setStatus(body.error ?? "The registry could not be read.");
    } catch {
      setConfigured(false);
      setStatus("The registry could not be reached. Local designs and share links still work.");
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void load(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const syncSubscriptions = async (): Promise<void> => {
    if (subscriptionsSyncing || !subscriptionsEnabled) return;
    setSubscriptionsSyncing(true);
    setStatus("");
    try {
      const subscriber = getAddress(await walletSession.connect());
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No injected wallet found.");
      const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
      const expiresAt = subscriptionExpiry();
      const requestNonce = randomRequestNonce();
      const subscriberSignature = await wallet.signMessage({
        account: subscriber,
        message: policyTemplateSubscriptionReadMessage({
          subscriber,
          requestNonce,
          expiresAt,
        }),
      });
      const response = await fetch("/api/policy-templates/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          operation: "read",
          subscriber,
          subscriberSignature,
          requestNonce,
          expiresAt,
        }),
      });
      const body = (await response.json()) as SubscriptionSnapshotResponse;
      if (!response.ok) throw new Error(body.error ?? "Wallet subscriptions could not be read.");
      if (
        typeof body.subscriber !== "string"
        || !isAddress(body.subscriber)
        || getAddress(body.subscriber) !== subscriber
        || !Number.isSafeInteger(body.version)
        || Number(body.version) < 0
        || !Array.isArray(body.contentHashes)
        || body.contentHashes.some((entry) => !isPolicyTemplateHash(entry))
      ) {
        throw new Error("The subscription service returned an invalid wallet snapshot.");
      }
      const [active] = await wallet.getAddresses();
      if (!active || getAddress(active) !== subscriber) {
        throw new Error("The active wallet changed while subscriptions were loading.");
      }
      setSubscribed(new Set(body.contentHashes.map((entry) => String(entry).toLowerCase())));
      setSubscriptionWallet(subscriber);
      setSubscriptionVersion(Number(body.version));
      setStatus(`Loaded ${body.contentHashes.length} exact-version subscription${body.contentHashes.length === 1 ? "" : "s"} for ${shortAddress(subscriber)}.`);
    } catch (cause) {
      setSubscribed(new Set());
      setSubscriptionWallet(null);
      setSubscriptionVersion(0);
      setStatus(cause instanceof Error ? cause.message : "Wallet subscriptions could not be read.");
    } finally {
      setSubscriptionsSyncing(false);
    }
  };

  const publish = async (): Promise<void> => {
    if (!name.trim() || publishing || chain.length === 0) return;
    setPublishing(true);
    setStatus("");
    try {
      const publication = {
        name,
        summary,
        version: parent ? parent.version + 1 : 1,
        parentHash: parent?.contentHash ?? null,
        chain: templateChain(chain),
      };
      const prepared = preparePolicyTemplate(publication);
      const publisher = await walletSession.connect();
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No injected wallet found.");
      const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
      const publisherSignature = await wallet.signMessage({
        account: publisher,
        message: policyTemplatePublishMessage(prepared),
      });
      const response = await fetch("/api/policy-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...publication,
          publisher,
          publisherSignature,
        }),
      });
      const body = (await response.json()) as { template?: PublicPolicyTemplate; error?: string };
      if (!response.ok || !body.template) {
        setStatus(body.error ?? "The template could not be published.");
        return;
      }
      const published = body.template;
      setTemplates((current) => dedupeTemplates([...current, published]));
      setName("");
      setSummary("");
      onPublished(published);
      setStatus(`Published immutable version ${published.version} at ${shortHash(published.contentHash)}.`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "The template could not be published.");
    } finally {
      setPublishing(false);
    }
  };

  const toggleSubscription = async (template: PublicPolicyTemplate): Promise<void> => {
    if (!activeSubscriptionWallet) {
      setStatus("Load this wallet’s authoritative subscriptions before changing them.");
      return;
    }
    const next = !subscribed.has(template.contentHash);
    setStatus("");
    try {
      const subscriber = getAddress(await walletSession.connect());
      if (subscriber !== activeSubscriptionWallet) {
        setSubscribed(new Set());
        setSubscriptionWallet(null);
        setSubscriptionVersion(0);
        throw new Error("The active wallet changed. Load its subscriptions before changing them.");
      }
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No injected wallet found.");
      const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
      const expiresAt = subscriptionExpiry();
      const subscriberSignature = await wallet.signMessage({
        account: subscriber,
        message: policyTemplateSubscriptionMessage({
          subscriber,
          contentHash: template.contentHash,
          subscribed: next,
          expectedVersion: subscriptionVersion,
          expiresAt,
        }),
      });
      const response = await fetch("/api/policy-templates/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          operation: "set",
          subscriber,
          subscriberSignature,
          contentHash: template.contentHash,
          subscribed: next,
          expectedVersion: subscriptionVersion,
          expiresAt,
        }),
      });
      const body = (await response.json()) as SubscriptionMutationResponse;
      if (!response.ok) {
        if (body.code === "VERSION_CONFLICT") {
          setSubscribed(new Set());
          setSubscriptionWallet(null);
          setSubscriptionVersion(0);
        }
        setStatus(body.error ?? "The subscription could not be changed.");
        return;
      }
      const [active] = await wallet.getAddresses();
      if (
        !active
        || getAddress(active) !== subscriber
        || typeof body.subscriber !== "string"
        || !isAddress(body.subscriber)
        || getAddress(body.subscriber) !== subscriber
        || body.contentHash !== template.contentHash
        || body.subscribed !== next
        || !Number.isSafeInteger(body.version)
        || Number(body.version) !== subscriptionVersion + 1
      ) {
        setSubscribed(new Set());
        setSubscriptionWallet(null);
        setSubscriptionVersion(0);
        throw new Error("The subscription response was not authoritative for the active wallet.");
      }
      setSubscribed((current) => {
        const updated = new Set(current);
        if (next) updated.add(template.contentHash);
        else updated.delete(template.contentHash);
        return updated;
      });
      setSubscriptionVersion(Number(body.version));
      setStatus(
        next
          ? `Subscribed to exact version ${template.version}; later forks will not silently replace it.`
          : `Unsubscribed from exact version ${template.version}.`,
      );
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "The subscription could not be changed.");
    }
  };

  return (
    <section className={styles.shell} aria-labelledby="public-policy-templates">
      <div className={styles.head}>
        <div>
          <h2 id="public-policy-templates">Public policy templates</h2>
          <p>
            Every version is immutable, wallet-signed, and addressed by its content hash. Forks name an exact
            parent; wallet-bound subscriptions pin one exact version, never “latest”.
          </p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.refresh}
            onClick={() => void syncSubscriptions()}
            disabled={!subscriptionsEnabled || subscriptionsSyncing}
          >
            {subscriptionsSyncing
              ? "Loading subscriptions…"
              : activeSubscriptionWallet
                ? `Synced ${shortAddress(activeSubscriptionWallet)}`
                : "Load my subscriptions"}
          </button>
          <button type="button" className={styles.refresh} onClick={() => void load(null)} disabled={configured === null}>
            Refresh
          </button>
        </div>
      </div>

      {parent ? (
        <p className={styles.lineage}>
          Publishing this canvas creates v{parent.version + 1}, forked from v{parent.version}{" "}
          <code>{shortHash(parent.contentHash)}</code>.
        </p>
      ) : null}

      <div className={styles.publish}>
        <input
          value={name}
          maxLength={MAX_TEMPLATE_NAME}
          placeholder="Template name"
          aria-label="Public template name"
          onChange={(event) => setName(event.target.value)}
        />
        <input
          value={summary}
          maxLength={MAX_TEMPLATE_SUMMARY}
          placeholder="What this exact version does"
          aria-label="Public template summary"
          onChange={(event) => setSummary(event.target.value)}
        />
        <button
          type="button"
          onClick={() => void publish()}
          disabled={!name.trim() || !chain.length || publishing || !configured || !publishingEnabled}
        >
          {publishing ? "Publishing…" : parent ? "Publish fork" : "Publish v1"}
        </button>
      </div>

      {configured && !publishingEnabled ? (
        <p className={styles.notice}>
          Browsing is read-only on this deployment. Wallet-signed publication stays disabled until its production
          admission controls are enabled.
        </p>
      ) : null}
      {configured && subscriptionsEnabled && !activeSubscriptionWallet ? (
        <p className={styles.notice}>
          Subscription state stays hidden until the active wallet signs a short-lived read request.
        </p>
      ) : null}

      {configured === false ? (
        <p className={styles.notice}>The public registry is not configured here. Local saves and content share links are unaffected.</p>
      ) : templates.length > 0 ? (
        <>
          <div className={styles.grid}>
            {templates.map((template) => (
              <article className={styles.card} key={template.contentHash}>
                <div>
                  <strong>{template.name}</strong>
                  <span>v{template.version} · {template.chain.length} blocks</span>
                </div>
                <p>{template.summary || "No summary supplied."}</p>
                <code title={template.contentHash}>{shortHash(template.contentHash)}</code>
                <small>published by {shortAddress(template.publisher)}</small>
                {template.parentHash ? <small>fork of {shortHash(template.parentHash)}</small> : <small>root version</small>}
                <div className={styles.actions}>
                  <button type="button" onClick={() => onLoad(template)}>
                    Open exact v{template.version}
                  </button>
                  <button
                    type="button"
                    data-subscribed={activeSubscriptionWallet ? subscribed.has(template.contentHash) : false}
                    onClick={() => void toggleSubscription(template)}
                    disabled={!subscriptionsEnabled || !activeSubscriptionWallet || subscriptionsSyncing}
                    title={
                      !subscriptionsEnabled
                        ? "Exact-version subscriptions are disabled on this deployment."
                        : !activeSubscriptionWallet
                          ? "Load the active wallet’s authoritative subscriptions first."
                          : undefined
                    }
                  >
                    {!activeSubscriptionWallet
                      ? "Load to check"
                      : subscribed.has(template.contentHash)
                        ? "Subscribed"
                        : `Subscribe v${template.version}`}
                  </button>
                </div>
              </article>
            ))}
          </div>
          {nextCursor ? (
            <button type="button" className={styles.refresh} onClick={() => void load(nextCursor)}>
              Load more verified templates
            </button>
          ) : null}
        </>
      ) : configured ? (
        <p className={styles.notice}>No public templates have been published yet.</p>
      ) : null}

      <p className={styles.status} aria-live="polite">{status}</p>
    </section>
  );
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function subscriptionExpiry(): number {
  return Math.floor(Date.now() / 1_000) + Math.min(120, POLICY_TEMPLATE_SUBSCRIPTION_TTL_SECONDS);
}

function randomRequestNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function dedupeTemplates(templates: readonly PublicPolicyTemplate[]): PublicPolicyTemplate[] {
  return [...new Map(templates.map((template) => [template.contentHash, template])).values()]
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.contentHash.localeCompare(right.contentHash)
        : left.createdAt.localeCompare(right.createdAt),
    );
}
