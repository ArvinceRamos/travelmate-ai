import React from "react";
import ReactMarkdown from "react-markdown";
import DOMPurify from "dompurify";

const SAFE_URL_RE = /^(https?:\/\/|mailto:|tel:)/i;

function sanitizeBackendText(value = "") {
  return DOMPurify.sanitize(String(value || ""), {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
  });
}

function sanitizeLinkUrl(url = "") {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  const normalized = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;
  return SAFE_URL_RE.test(normalized) ? normalized : "";
}

function isMapUrl(url = "") {
  try {
    const parsed = new URL(url);
    return (
      /(^|\.)maps?\./i.test(parsed.hostname) ||
      /(^|\.)openstreetmap\.org$/i.test(parsed.hostname) ||
      /\/maps?(?:\/|$)/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function inferPlaceNameFromLine(line = "") {
  const cleaned = line.replace(/^\s*[-*•]\s*/, "").trim();
  const beforeColon = cleaned.split(":")[0].trim();

  if (/^(?:open\s+)?maps?$/i.test(beforeColon)) {
    return "";
  }

  return beforeColon.replace(/\([^)]*\)\s*$/, "").trim();
}

function renderStrongText(text = "", keyPrefix = "md") {
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g).filter((part) => part !== "");

  return parts.map((part, idx) => {
    const strong = part.match(/^\*\*([^*]+)\*\*$/);
    if (strong) {
      return <strong key={`${keyPrefix}-strong-${idx}`}>{strong[1]}</strong>;
    }
    return <React.Fragment key={`${keyPrefix}-text-${idx}`}>{part}</React.Fragment>;
  });
}

/**
 * Parse markdown-ish links:
 * - [label](url)
 * - auto-link URLs
 * Map links become an internal "View map" chip.
 */
function renderInline(text, { onOpenMap, keyPrefix = "inl" } = {}) {
  const line = String(text || "");
  const parts = [];
  let last = 0;

  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(line))) {
    const [full, label, url] = m;
    const start = m.index;
    const end = start + full.length;
    if (start > last) parts.push({ type: "text", value: line.slice(last, start) });
    const safeUrl = sanitizeLinkUrl(url);
    if (safeUrl) {
      parts.push({ type: "mdlink", label, url: safeUrl });
    } else {
      parts.push({ type: "text", value: label });
    }
    last = end;
  }
  if (last < line.length) parts.push({ type: "text", value: line.slice(last) });

  // If no markdown links, auto-link URLs
  const autoParts = [];
  if (parts.length === 1 && parts[0].type === "text") {
    const s = parts[0].value;
    const urlRe = /(https?:\/\/[^\s)]+)|(www\.[^\s)]+)/g;
    let l = 0;
    let um;
    while ((um = urlRe.exec(s))) {
      const u = sanitizeLinkUrl(um[0].startsWith("http") ? um[0] : `https://${um[0]}`);
      if (um.index > l) autoParts.push({ type: "text", value: s.slice(l, um.index) });
      if (u) autoParts.push({ type: "url", url: u });
      else autoParts.push({ type: "text", value: um[0] });
      l = um.index + um[0].length;
    }
    if (l < s.length) autoParts.push({ type: "text", value: s.slice(l) });
  }

  const finalParts = autoParts.length ? autoParts : parts;
  const placeName = inferPlaceNameFromLine(line);

  return finalParts.map((p, i) => {
    if (p.type === "text") return <React.Fragment key={`${keyPrefix}-t-${i}`}>{renderStrongText(p.value, `${keyPrefix}-t-${i}`)}</React.Fragment>;

    const url = p.url;
    const isMaps = isMapUrl(url);

    if (isMaps) {
      return (
        <button
          key={`${keyPrefix}-m-${i}`}
          type="button"
          className="tm-inlineChip"
          onClick={() =>
            onOpenMap?.({
              query: placeName || "",
              label: placeName || "",
              url,
            })
          }
          title="Open in View Maps"
        >
          View map
        </button>
      );
    }

    const label = p.label || p.url;
    return (
      <a key={`${keyPrefix}-a-${i}`} className="tm-inlineLink" href={url} target="_blank" rel="noreferrer">
        {label}
      </a>
    );
  });
}

function looksLikeItinerary(text) {
  const t = String(text || "");
  // Cheap + effective: header + at least one Day line OR multiple time blocks
  const hasTripDates = /Trip dates:\s*\d{4}-\d{2}-\d{2}\s*to\s*\d{4}-\d{2}-\d{2}/i.test(t);
  const hasDay = /^Day\s+\d+\s+—/m.test(t);
  const hasTimeBlocks = /^\d{2}:\d{2}–\d{2}:\d{2}/m.test(t);
  return (hasTripDates && (hasDay || hasTimeBlocks)) || (hasDay && hasTimeBlocks);
}

function parseHeaderBlock(lines) {
  if (lines.length < 3) return null;
  const l0 = (lines[0] || "").trim();
  const l1 = (lines[1] || "").trim();
  const l2 = (lines[2] || "").trim();

  // Must be exactly your spec
  if (!l0.includes("•")) return null;
  if (!/^Trip dates:/i.test(l1)) return null;
  if (!/^Base:/i.test(l2)) return null;

  return { title: l0, dates: l1, base: l2 };
}

function splitActivityLine(rest) {
  const cleaned = String(rest || "").replace(/^\s*[-•]\s*/, "").trim();

  // Expected: "Activity Name — Description..."
  const idx = cleaned.indexOf(" — ");
  if (idx !== -1) {
    return {
      activity: cleaned.slice(0, idx).trim(),
      details: cleaned.slice(idx + 3).trim(),
    };
  }

  // Backend strict itinerary format: "Activity Name - Description..."
  const dashIdx = cleaned.indexOf(" - ");
  if (dashIdx === -1) return { activity: cleaned, details: "" };
  return {
    activity: cleaned.slice(0, dashIdx).trim(),
    details: cleaned.slice(dashIdx + 3).trim(),
  };
}

function renderItinerary(content, { onOpenMap } = {}) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  const rawLines = text.split("\n");

  // Preserve intentional blank lines as separators between blocks
  const lines = rawLines.map((l) => l.replace(/\s+$/g, ""));

  const header = parseHeaderBlock(lines);

  // We’ll iterate and build blocks
  const blocks = [];
  let i = 0;

  if (header) {
    blocks.push({
      type: "header",
      header,
    });
    i = 3;

    // Optional blank line after header
    while (i < lines.length && lines[i].trim() === "") i += 1;
  }

  for (; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const trimmed = line.trim();

    if (!trimmed) {
      blocks.push({ type: "spacer" });
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: "bullet", text: bullet[1].trim() });
      continue;
    }

    const numbered = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      blocks.push({ type: "numbered", number: numbered[1], text: numbered[2].trim() });
      continue;
    }

    // Day header: "Day 1 — Mar 8 (Today)" or "Day 2 — Mar 9"
    if (/^Day\s+\d+\s+—/i.test(trimmed)) {
      blocks.push({ type: "day", text: trimmed });
      continue;
    }

    // Time block line: "09:00–10:30 • Activity — details"
    // Allow bullet "•" or just space after time
    const m = trimmed.match(/^(\d{2}:\d{2})–(\d{2}:\d{2})\s*(?:[•]\s*)?(.*)$/);
    if (m) {
      const start = m[1];
      const end = m[2];
      const rest = (m[3] || "").trim();
      const { activity, details } = splitActivityLine(rest);

      blocks.push({
        type: "time",
        start,
        end,
        activity,
        details,
      });
      continue;
    }

    // Normal paragraph line
    blocks.push({ type: "p", text: trimmed });
  }

  return (
    <div className="tm-rich tm-rich--itinerary">
      {blocks.map((b, idx) => {
        if (b.type === "header") {
          return (
            <div key={`hdr-${idx}`} className="tm-itinHeader">
              <div className="tm-itinHeader__title">{b.header.title}</div>
              <div className="tm-itinHeader__meta">{b.header.dates}</div>
              <div className="tm-itinHeader__meta">{b.header.base}</div>
            </div>
          );
        }

        if (b.type === "day") {
          return (
            <div key={`day-${idx}`} className="tm-itinDay">
              {b.text}
            </div>
          );
        }

        if (b.type === "time") {
          return (
            <div key={`t-${idx}`} className="tm-itinRow">
              <div className="tm-itinTime">
                {b.start}–{b.end}
              </div>
              <div className="tm-itinMain">
                {b.activity ? <span className="tm-itinAct">{b.activity}</span> : null}
                {b.details ? (
                  <span className="tm-itinDetails">
                    {" "}
                    — {renderInline(b.details, { onOpenMap, keyPrefix: `d-${idx}` })}
                  </span>
                ) : null}
              </div>
            </div>
          );
        }

        if (b.type === "spacer") {
          // Avoid stacking too many spacers
          return <div key={`sp-${idx}`} className="tm-itinSpacer" />;
        }

        if (b.type === "hr") {
          return <hr key={`hr-${idx}`} className="tm-richHr" />;
        }

        if (b.type === "heading") {
          return (
            <div key={`h-${idx}`} className={`tm-richHeading tm-richHeading--${Math.min(b.level, 3)}`}>
              {renderInline(b.text, { onOpenMap, keyPrefix: `h-${idx}` })}
            </div>
          );
        }

        if (b.type === "bullet") {
          return (
            <div key={`b-${idx}`} className="tm-richBullet">
              <span className="tm-richBullet__mark">•</span>
              <span className="tm-richBullet__text">{renderInline(b.text, { onOpenMap, keyPrefix: `b-${idx}` })}</span>
            </div>
          );
        }

        if (b.type === "numbered") {
          return (
            <div key={`n-${idx}`} className="tm-richBullet">
              <span className="tm-richBullet__mark">{b.number}.</span>
              <span className="tm-richBullet__text">{renderInline(b.text, { onOpenMap, keyPrefix: `n-${idx}` })}</span>
            </div>
          );
        }

        // paragraph line
        return (
          <div key={`p-${idx}`} className="tm-itinP">
            {renderInline(b.text, { onOpenMap, keyPrefix: `p-${idx}` })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renderer:
 * - If itinerary -> structured blocks
 * - Else -> render markdown while preserving bubble layout
 */
export function renderMessageContent(content, { onOpenMap } = {}) {
  const text = sanitizeBackendText(content)
    .replace(/\r\n/g, "\n")
    .replace(/^[\t ]*•[\t ]+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([^\n])\n[\t ]*\n+(?=(?:[-*]|\d+[.)])[\t ]+)/g, "$1\n")
    .replace(/((?:[-*]|\d+[.)])[\t ]+[^\n]+)\n[\t ]*\n+(?=(?:[-*]|\d+[.)])[\t ]+)/g, "$1\n")
    .trim();

  if (looksLikeItinerary(text)) {

    return renderItinerary(text, { onOpenMap });
  }

  return (
    <div className="tm-rich">
      <ReactMarkdown
        components={{
          p: ({ children }) => <div className="tm-msgLine">{children}</div>,
          strong: ({ children }) => <strong>{children}</strong>,
          h1: ({ children }) => <div className="tm-richHeading tm-richHeading--1">{children}</div>,
          h2: ({ children }) => <div className="tm-richHeading tm-richHeading--2">{children}</div>,
          h3: ({ children }) => <div className="tm-richHeading tm-richHeading--3">{children}</div>,
          ul: ({ children }) => <ul className="tm-richList">{children}</ul>,
          ol: ({ children }) => <ol className="tm-richList">{children}</ol>,
          li: ({ children }) => <li className="tm-richListItem">{children}</li>,
          hr: () => <hr className="tm-richHr" />,
          a: ({ href, children }) => {
            const safeUrl = sanitizeLinkUrl(href || "");
            if (!safeUrl) return <>{children}</>;

            if (isMapUrl(safeUrl)) {
              return (
                <button
                  type="button"
                  className="tm-inlineChip"
                  onClick={() =>
                    onOpenMap?.({
                      query: String(children || ""),
                      label: String(children || ""),
                      url: safeUrl,
                    })
                  }
                  title="Open in View Maps"
                >
                  View map
                </button>
              );
            }

            return (
              <a className="tm-inlineLink" href={safeUrl} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
