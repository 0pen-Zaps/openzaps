import Image from "next/image";
import {
  protocolLogoAsset,
  type ProtocolId,
  type ProtocolInfo,
} from "@/lib/protocols";
import styles from "./ProtocolLogo.module.css";

/**
 * One authentic, locally vendored protocol mark.
 *
 * The image stays decorative because the visible protocol text or the stack
 * wrapper owns the accessible name. Local files avoid runtime CDN drift; SVG
 * optimization is disabled so Next serves the official bytes as vendored.
 */
export function ProtocolLogo({
  protocol,
  size = 16,
  eager = false,
}: {
  protocol: ProtocolId;
  size?: number;
  eager?: boolean;
}): React.JSX.Element {
  const asset = protocolLogoAsset(protocol);
  const compound = asset.presentation === "compound-icon";
  const imageWidth = compound ? Math.ceil(size * (121 / 27)) : size;

  return (
    <span
      className={styles.plate}
      data-protocol={protocol}
      data-presentation={asset.presentation}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Image
        src={asset.src}
        alt=""
        width={imageWidth}
        height={size}
        className={styles.image}
        draggable={false}
        loading={eager ? "eager" : undefined}
        unoptimized
      />
    </span>
  );
}

/**
 * Slightly overlapped marks with one accessible label. Version text remains
 * outside the image, so Uniswap v3 and v4 truthfully share one brand mark
 * without inventing different logos.
 */
export function ProtocolStack({
  protocols,
  size = 16,
  decorative = false,
  eager = false,
}: {
  protocols: ProtocolInfo[];
  size?: number;
  decorative?: boolean;
  eager?: boolean;
}): React.JSX.Element | null {
  if (protocols.length === 0) return null;

  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={
        decorative
          ? undefined
          : `via ${protocols.map((protocol) => protocol.name).join(" + ")}`
      }
      aria-hidden={decorative || undefined}
      className={styles.stack}
    >
      {protocols.map((protocol, index) => (
        <span
          key={protocol.id}
          title={protocol.name}
          className={styles.stackItem}
          style={{ marginLeft: index === 0 ? 0 : -size * 0.28 }}
        >
          <ProtocolLogo protocol={protocol.id} size={size} eager={eager} />
        </span>
      ))}
    </span>
  );
}
