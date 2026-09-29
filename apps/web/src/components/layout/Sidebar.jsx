import React, { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";

import Button from "../common/Button.jsx";

import { useAuth } from "../../hooks/useAuth";
import { deleteChat, setChatTitle, subscribeChats } from "../../services/chatService";
import { useComposerDraft } from "../../store/composerDraftContext.jsx";
import { useChatUi } from "../../store/chatUiContext.jsx";
import { useNotifications } from "../../features/notifications/notificationsStore.jsx";

const navLinks = [
  { to: "/map", label: "View Maps", emoji: "🗺️" },
  { to: "/itinerary", label: "Saved Itinerary", emoji: "📌" },
  { to: "/notifications", label: "Notifications", emoji: "🔔" },
  { to: "/settings", label: "Settings", emoji: "⚙️" },
];

export default function Sidebar({ isOpen = true, isMobile = false, onClose }) {
  const { user, loading } = useAuth();
  const { draft, setDraft } = useComposerDraft();
  useChatUi();

  const { unreadCount } = useNotifications();

  const [chats, setChats] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState("");

  // kebab menu state
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 });
  const menuRef = useRef(null);

  const nav = useNavigate();

  function goLogin(nextPath = "/chat") {
    // Login is a modal in Topbar, opened via query param.
    const next = nextPath ? encodeURIComponent(nextPath) : "";
    nav(`/chat?auth=login${next ? `&next=${next}` : ""}`);
  }

  useEffect(() => {
    if (!user) {
      setChats([]);
      return;
    }
    const unsub = subscribeChats(user.uid, setChats);
    return () => unsub?.();
  }, [user]);

  // Close menu on outside click / escape
  useEffect(() => {
    function onDocMouseDown(e) {
      if (!menuOpenId) return;
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpenId(null);
      }
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setMenuOpenId(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpenId]);

  async function onNewChat() {
    if (loading) return;

    if (!user) {
      goLogin("/chat");
      return;
    }

    // Tell ChatPage to reset UI and NOT auto-restore the last chat.
    sessionStorage.setItem("tm_force_new_chat", "1");
    if (draft) setDraft("");

    nav(`/chat?new=${Date.now()}`);

    if (isMobile) {
      onClose?.();
    }
  }

  function beginRename(chat) {
    setEditingId(chat.id);
    setEditingValue(chat.title || "New chat");
    setMenuOpenId(null);
  }

  function cancelRename() {
    setEditingId(null);
    setEditingValue("");
  }

  async function commitRename(chatId) {
    const title = (editingValue || "").trim() || "New chat";
    await setChatTitle(chatId, title.length <= 48 ? title : `${title.slice(0, 48)}…`);
    cancelRename();
  }

  async function onDelete(chat) {
    if (!user) return;
    setMenuOpenId(null);
    const ok = window.confirm(`Delete chat "${chat.title || "New chat"}"? This cannot be undone.`);
    if (!ok) return;
    await deleteChat(chat.id);
    nav(`/chat`, { replace: true });
  }

  const userInitials = useMemo(() => {
    const name = user?.displayName || user?.email || "";
    const parts = name.split(" ").filter(Boolean);
    return (parts[0]?.[0] || "U").toUpperCase();
  }, [user]);

  function openMenuFor(chatId, btnEl) {
    const r = btnEl.getBoundingClientRect();
    setMenuPos({
      top: r.bottom + 8,
      left: r.right - 180,
      width: 180,
    });
    setMenuOpenId(chatId);
  }

  const menu =
    menuOpenId &&
    createPortal(
      <div
        ref={menuRef}
        className="tm-popMenu"
        style={{
          top: `${menuPos.top}px`,
          left: `${Math.max(12, menuPos.left)}px`,
          width: `${menuPos.width}px`,
        }}
        role="menu"
      >
        <button
          className="tm-popMenuItem"
          type="button"
          role="menuitem"
          onClick={() => beginRename(chats.find((c) => c.id === menuOpenId))}
        >
          Rename
        </button>
        <button
          className="tm-popMenuItem tm-popMenuItem--danger"
          type="button"
          role="menuitem"
          onClick={() => onDelete(chats.find((c) => c.id === menuOpenId))}
        >
          Delete
        </button>
      </div>,
      document.body
    );

  return (
    <aside className={`tm-sidebar ${isOpen ? "tm-sidebar--open" : "tm-sidebar--closed"} ${isMobile ? "tm-sidebar--mobile" : ""}`}>
      <div className="tm-sidebar__top">
        <div className="tm-sidebarHeader">
          <button
            type="button"
            className="tm-brandRow tm-brandRow--btn"
            aria-label="Go to landing page"
            title="Go to landing page"
            onClick={() => {
              sessionStorage.setItem("tm_force_new_chat", "1");
              nav(`/chat?new=${Date.now()}`);
            }}
          >
            <img className="tm-logoIcon" src="/assets/travelmate-logo.png" alt="TravelMate AI logo" />
            <div className="tm-brandText">
              <span className="tm-brand__name">TravelMate</span>
              <span className="tm-brand__ai"> AI</span>
            </div>
          </button>

          <button
            className="tm-sidebarCloseBtn"
            type="button"
            aria-label="Close sidebar"
            title="Close"
            onClick={() => onClose?.()}
          >
            ☰
          </button>
        </div>

        <Button onClick={onNewChat} disabled={loading}>
          + New chat
        </Button>

        <div className="tm-sidebar__sectionTitle">Recent Chats</div>

        <div className="tm-sidebar__history tm-scrollOnHover" aria-label="Recent chats">
          {!user ? (
            <div className="tm-mutedBox">Sign in to save chats.</div>
          ) : chats.length === 0 ? (
            <div className="tm-mutedBox">No chats yet.</div>
          ) : (
            chats.map((c) => (
              <div key={c.id} className="tm-chatRow">
                {editingId === c.id ? (
                  <div className="tm-chatEdit">
                    <input
                      className="tm-chatEditInput"
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(c.id);
                        if (e.key === "Escape") cancelRename();
                      }}
                    />
                    <button
                      className="tm-iconMini"
                      type="button"
                      onClick={() => commitRename(c.id)}
                      title="Save"
                      aria-label="Save"
                    >
                      ✓
                    </button>
                    <button className="tm-iconMini" type="button" onClick={cancelRename} title="Cancel" aria-label="Cancel">
                      ✕
                    </button>
                  </div>
                ) : (
                  <>
                    <NavLink
                      to={`/chat/${c.id}`}
                      className={({ isActive }) => (isActive ? "tm-chatLink tm-chatLink--active" : "tm-chatLink")}
                      title={c.title || "New chat"}
                      onClick={() => {
                        setMenuOpenId(null);
                        if (isMobile) onClose?.();
                      }}
                    >
                      {c.title || "New chat"}
                    </NavLink>

                    <button
                      className="tm-ellipsisBtn"
                      type="button"
                      aria-label="More"
                      title="More"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (menuOpenId === c.id) {
                          setMenuOpenId(null);
                          return;
                        }
                        openMenuFor(c.id, e.currentTarget);
                      }}
                    >
                      ⋮
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="tm-sep" role="separator" />

      <nav className="tm-sidebar__navBottom" aria-label="Sidebar navigation">
        {navLinks.map((l) => {
          const isNotif = l.to === "/notifications";
          const showBadge = isNotif && unreadCount > 0;
          return (
            <NavLink
              key={l.to}
              to={l.to}
              onClick={(e) => {
                if (loading) {
                  e.preventDefault();
                  return;
                }

                if (!user) {
                  e.preventDefault();
                  goLogin(l.to);
                  return;
                }

                if (isMobile) {
                  onClose?.();
                }
              }}
              className={({ isActive }) => (isActive ? "tm-navLink tm-navLink--active" : "tm-navLink")}
            >
              <span className="tm-navEmoji" aria-hidden>
                {l.emoji}
              </span>
              <span>{l.label}</span>
              {showBadge ? (
                <span className="tm-navBadge" aria-label={`${unreadCount} unread notifications`}>
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              ) : null}
            </NavLink>
          );
        })}
      </nav>

      <div className="tm-sep tm-sep--soft" role="separator" />

      <div className="tm-sidebar__user">
        {user ? (
          <div className="tm-userRow">
            <div className="tm-avatar">{user.photoURL ? <img src={user.photoURL} alt="user" /> : userInitials}</div>
            <div className="tm-userMeta">
              <div className="tm-userName">{user.displayName || "Signed in"}</div>
              <div className="tm-userEmail">{user.email}</div>
            </div>
          </div>
        ) : (
          <div className="tm-mutedBox">Not signed in</div>
        )}
      </div>

      {menu}
    </aside>
  );
}