import React from "react";

export default function Card({ title, right = null, children }) {
  return (
    <div className="card">
      {title ? (
        <div className="card__titleRow">
          <div className="card__title">{title}</div>
          {right ? <div className="card__titleRight">{right}</div> : null}
        </div>
      ) : null}
      <div className="card__body">{children}</div>
    </div>
  );
}