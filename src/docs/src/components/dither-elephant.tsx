/** Static, two-tone illustration. The SVG patterns need no canvas or animation. */
export function DitherElephant() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 256 184"
      className="pointer-events-none h-auto w-32 shrink-0 text-fd-muted-foreground sm:w-40"
    >
      <defs>
        <pattern id="elephant-mid" width="4" height="4" patternUnits="userSpaceOnUse">
          <path d="M0 0h2v2H0zM2 2h2v2H2z" fill="currentColor" />
        </pattern>
        <pattern id="elephant-light" width="4" height="4" patternUnits="userSpaceOnUse">
          <path d="M0 0h2v2H0z" fill="currentColor" />
        </pattern>
        <pattern id="elephant-dense" width="4" height="4" patternUnits="userSpaceOnUse">
          <path d="M0 0h4v2H0zM0 2h2v2H0z" fill="currentColor" />
        </pattern>
      </defs>
      <g shapeRendering="crispEdges">
        <path d="M58 111h22v52H56zM134 112h22l7 51h-25z" fill="url(#elephant-light)" />
        <path d="M43 79C24 76 16 90 17 108h5c-1-16 7-23 23-22z" fill="url(#elephant-mid)" />
        <path
          d="M37 88c0-33 26-52 70-52 44 0 74 21 74 55 0 27-18 42-45 46l-2 35h-26l-3-36H82l-5 36H51l3-45c-12-10-17-23-17-39Z"
          fill="url(#elephant-mid)"
        />
        <path
          d="M46 76c10-24 37-33 65-30 23 2 37 10 50 23-38-13-76-11-115 7Z"
          fill="url(#elephant-dense)"
        />
        <path
          d="M139 74c0-30 15-49 39-49 25 0 41 20 41 46 0 17-7 29-9 42-3 14 0 23 9 23 9 0 13-9 12-21h9c5 25-5 40-22 40-21 0-28-20-26-47-32 7-53-7-53-34Z"
          fill="url(#elephant-dense)"
        />
        <path
          d="M153 48c-26 0-39 22-31 49 5 17 18 28 32 22 16-7 21-35 15-53-3-11-8-18-16-18Z"
          fill="var(--color-fd-background)"
        />
        <path
          d="M152 50c-23 0-35 20-28 45 4 15 16 24 27 20 15-6 19-32 14-48-3-11-7-17-13-17Z"
          fill="url(#elephant-mid)"
        />
        <path d="M190 90c8 7 16 8 27 5-9 14-20 17-28 11Z" fill="currentColor" />
        <path d="M191 58h6v6h-6z" fill="var(--color-fd-background)" />
        <path d="M29 178h195v2H29z" fill="url(#elephant-light)" />
      </g>
    </svg>
  );
}
