import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import AuthModal from "../auth/AuthModal.jsx";
import Button from "../common/Button.jsx";

import { useAuth } from "../../hooks/useAuth";
import { logoutFlow } from "../../services/logoutFlow";

import "../../styles/layout.css";

export default function Topbar({ sidebarOpen, isMobile = false, onToggleSidebar }) {
  const { user, loading } = useAuth();
  const nav = useNavigate();
  const location = useLocation();

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState("login");

  function openLogin() {
    setModalMode("login");
    setModalOpen(true);
  }

  function openSignup() {
    setModalMode("signup");
    setModalOpen(true);
  }

  async function handleLogout() {
    const ok = window.confirm("Are you sure you want to log out?");
    if (!ok) return;
    await logoutFlow();
    nav("/logged-out", { replace: true });
  }

  // Deep-link login/signup via URL (used by sidebar gating)
  // Example: /chat?auth=login or /chat?auth=signup
  useEffect(() => {
    const qs = new URLSearchParams(location.search || "");
    const authMode = qs.get("auth");
    if (!authMode) return;
    if (loading) return;
    if (user) return;

    if (authMode === "signup") openSignup();
    else openLogin();

    // Clean URL (prevents "stuck" auth modal on refresh)
    qs.delete("auth");
    const next = qs.toString();
    nav(`${location.pathname}${next ? `?${next}` : ""}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, loading, user]);

  // Close modal automatically when user becomes logged in.
  useEffect(() => {
    if (user) setModalOpen(false);
  }, [user]);

  const brandNode = useMemo(() => {
    return (
      <button
        type="button"
        className="tm-brandBtn"
        aria-label="Go to landing page"
        title="Go to landing page"
        onClick={() => {
          // Landing page is the /chat "new chat" interface
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
    );
  }, [nav]);

  return (
    <>
      <header className="tm-topbar">
        <div className="tm-topbar__left">
          {/* Burger menu must be top-left alongside logo. Hide completely when logged out. */}
          {!loading && user && (isMobile || !sidebarOpen) ? (
            <button
              className={`tm-sidebarToggleBtn ${sidebarOpen ? "tm-sidebarToggleBtn--active" : ""}`}
              type="button"
              aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              onClick={onToggleSidebar}
            >
              ☰
            </button>
          ) : null}

          {isMobile || !sidebarOpen ? brandNode : null}
        </div>

        <div className="tm-topbar__right">
          {!loading && !user ? (
            <div className="tm-authBtns">
              <Button variant="ghost" onClick={openLogin}>
                Log in
              </Button>
              <Button onClick={openSignup}>Sign up</Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={handleLogout}>
              Log out
            </Button>
          )}
        </div>
      </header>

      <AuthModal open={modalOpen} mode={modalMode} onClose={() => setModalOpen(false)} />
    </>
  );
}