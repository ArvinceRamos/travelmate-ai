import React from "react";

const PATHS = {
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: (
    <>
      <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  chat: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z" />,
  map: (
    <>
      <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </>
  ),
  food: (
    <>
      <path d="M4 11h16a8 8 0 0 1-16 0z" />
      <path d="M8 7c0-2 2-2 2-4M13 7c0-2 2-2 2-4" />
    </>
  ),
  beach: (
    <>
      <path d="M3 18c3 0 3-2 6-2s3 2 6 2 3-2 6-2" />
      <path d="M12 14V6M12 6c3 0 5 1 6 3-3 0-5-1-6-3z" />
    </>
  ),
  mountain: <path d="M3 19l6-11 4 6 3-4 5 9z" />,
  boat: (
    <>
      <path d="M2 17l4-1 5 2 8-4" />
      <path d="M4 13l3-6h6l3 4" />
    </>
  ),
  surf: (
    <>
      <path d="M3 16c3 0 3-2 6-2s3 2 6 2 3-2 6-2" />
      <circle cx="16" cy="6" r="2" />
      <path d="M6 12l5-4 3 3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
  bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  directions: (
    <>
      <path d="M12 3l9 9-9 9-9-9z" />
      <path d="M8 12h6M12 9l3 3-3 3" />
    </>
  ),
  car: (
    <>
      <path d="M5 16l1.5-5a2 2 0 0 1 2-1.5h7a2 2 0 0 1 2 1.5L19 16" />
      <rect x="3" y="16" width="18" height="4" rx="1.5" />
    </>
  ),
  scooter: (
    <>
      <circle cx="6" cy="17" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M8.5 17h7M15 17l-2-9h3M13 8h-2" />
    </>
  ),
  bus: (
    <>
      <rect x="5" y="4" width="14" height="13" rx="3" />
      <path d="M5 11h14M8 20l1-3M16 20l-1-3" />
    </>
  ),
  walk: (
    <>
      <circle cx="13" cy="4" r="1.5" />
      <path d="M9 21l2-6-2-3 2-4 3 3 3 1M11 15l3 2 1 4" />
    </>
  ),
  bike: (
    <>
      <circle cx="6" cy="16" r="3.5" />
      <circle cx="18" cy="16" r="3.5" />
      <path d="M6 16l4-8h5l3 8M10 8H8" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </>
  ),
  locate: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />,
};

export default function Icon({ name, size = 20, strokeWidth = 2, className, ...rest }) {
  const body = PATHS[name];
  if (!body) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {body}
    </svg>
  );
}

export function BrandMark({ size = 34 }) {
  return (
    <span className="tm-brandMark" style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="compass" size={Math.round(size * 0.58)} />
    </span>
  );
}
