export function OpenZapMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id="openzap-ring" x1="96" y1="64" x2="416" y2="448" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8EA0FF" />
          <stop offset="0.5" stopColor="#6B5CFF" />
          <stop offset="1" stopColor="#21D07A" />
        </linearGradient>
        <linearGradient id="openzap-bolt" x1="305" y1="108" x2="188" y2="410" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F7F8F8" />
          <stop offset="0.48" stopColor="#C8D0FF" />
          <stop offset="1" stopColor="#37F09A" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="#08090A" />
      <path
        d="M257 74C357.516 74 439 155.484 439 256C439 356.516 357.516 438 257 438C156.484 438 75 356.516 75 256C75 175.835 126.851 107.779 198.866 83.521"
        stroke="url(#openzap-ring)"
        strokeWidth="38"
        strokeLinecap="round"
      />
      <path d="M342 68L407 111" stroke="#08090A" strokeWidth="54" strokeLinecap="round" />
      <path
        d="M302 104L169 277H244L207 410L346 223H265L302 104Z"
        fill="url(#openzap-bolt)"
        stroke="#08090A"
        strokeWidth="18"
        strokeLinejoin="round"
      />
      <path
        d="M302 104L169 277H244L207 410L346 223H265L302 104Z"
        stroke="rgba(255,255,255,0.72)"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <circle cx="141" cy="142" r="10" fill="#37F09A" />
      <circle cx="374" cy="365" r="7" fill="#8EA0FF" />
    </svg>
  );
}
