import React from "react";
import { useNavigate } from "react-router-dom";
import { useMaps } from "../../features/maps/mapsStore";
import { renderMessageContent } from "../../utils/richText.jsx";

export default function MessageBubble({ role, content, footer }) {
  const isUser = role === "user";
  const nav = useNavigate();
  const { openPlace } = useMaps();

  function onOpenMap(intent) {
    openPlace({
      ...intent,
      sourceText: String(content || ""),
    });
    nav("/map");
  }

  return (
    <div className={`tm-msg ${isUser ? "tm-msg--user" : "tm-msg--assistant"}`}>
      {!isUser && (
        <div className="tm-msg__avatar">
          <img src="/assets/travelmate-logo.png" alt="TravelMate AI" className="tm-msg__avatar-img" />
        </div>
      )}

      <div className="tm-msg__body">
        <div className={`tm-msg__content ${isUser ? "tm-msg__content--user" : "tm-msg__content--assistant"}`}>
          {renderMessageContent(content, { onOpenMap })}
        </div>
        {footer ? <div className="tm-msg__footer">{footer}</div> : null}
      </div>
    </div>
  );
}