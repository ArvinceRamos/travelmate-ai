import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import Sidebar from "./Sidebar.jsx";
import Topbar from "./Topbar.jsx";
import { useAuth } from "../../hooks/useAuth";
import { consumeGoogleRedirectResult, logout } from "../../services/authService";

function hasPendingEmailVerification() {
  try {
    return !!sessionStorage.getItem("tm_pending_email_verification_v1");
  } catch {
    return false;
  }
}

function hasPasswordProvider(user) {
  const providers = Array.isArray(user?.providerData) ? user.providerData : [];
  return providers.some((item) => item?.providerId === "password");
}

export default function AppShell({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const nav = useNavigate();

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 900 : false
  );
  const [verificationGuardBusy, setVerificationGuardBusy] = useState(false);
  const prevUserRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const result = await consumeGoogleRedirectResult();
        if (cancelled || !result?.user) return;

        sessionStorage.setItem("tm_just_logged_in", "1");
        toast.success(result.isNewUser ? "Account created with Google!" : "Logged in with Google!");
      } catch (err) {
        if (!cancelled) {
          toast.error(err?.message || "Google sign-in failed.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (loading) return;

    const prevUser = prevUserRef.current;
    const isLoggedIn = !!user;
    const wasLoggedIn = !!prevUser;

    if (!isLoggedIn) {
      setSidebarOpen(false);
      prevUserRef.current = null;
      return;
    }

    if (!wasLoggedIn) {
      setSidebarOpen(!isMobile);
    }

    prevUserRef.current = user;
  }, [loading, user, isMobile]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia("(max-width: 900px)");

    function handleChange(event) {
      setIsMobile(event.matches);
    }

    setIsMobile(media.matches);

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (loading) return;
    if (!user) return;

    const justLoggedIn = sessionStorage.getItem("tm_just_logged_in");
    if (!justLoggedIn) return;

    sessionStorage.removeItem("tm_just_logged_in");
    nav(`/chat?new=${Date.now()}`, { replace: true });
  }, [user, loading, nav]);

  useEffect(() => {
    if (loading || !user || verificationGuardBusy) return;
    if (!hasPasswordProvider(user) || user.emailVerified) return;
    if (hasPendingEmailVerification()) return;

    let cancelled = false;

    (async () => {
      try {
        setVerificationGuardBusy(true);
        await logout();

        if (cancelled) return;

        setSidebarOpen(false);
        toast.error("Please verify your email before using TravelMate AI.");
        nav(`/chat?auth=login&verify=1`, { replace: true });
      } finally {
        if (!cancelled) {
          setVerificationGuardBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, loading, nav, verificationGuardBusy]);

  function handleToggleSidebar() {
    if (loading || verificationGuardBusy) return;

    if (!user) {
      setSidebarOpen(false);
      toast.error("Please log in to access the sidebar.");
      nav(`/chat?auth=login&next=${encodeURIComponent(location.pathname)}`);
      return;
    }

    setSidebarOpen((value) => !value);
  }

  useEffect(() => {
    if (loading || verificationGuardBusy) return;
    if (user) return;

    const protectedPaths = ["/map", "/itinerary", "/notifications", "/settings"];
    if (protectedPaths.some((path) => location.pathname.startsWith(path))) {
      toast.error("Please log in to access that page.");
      nav("/chat?auth=login", { replace: true });
    }
  }, [user, loading, location.pathname, nav, verificationGuardBusy]);

  return (
    <div
      className={`app ${sidebarOpen ? "" : "tm-sidebarClosed"} ${isMobile && sidebarOpen ? "tm-mobileSidebarOpen" : ""}`}
    >
      <Sidebar isOpen={sidebarOpen} isMobile={isMobile} onClose={() => setSidebarOpen(false)} />

      {isMobile && sidebarOpen ? (
        <button
          type="button"
          className="tm-sidebarBackdrop"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <div className="main">
        <Topbar sidebarOpen={sidebarOpen} isMobile={isMobile} onToggleSidebar={handleToggleSidebar} />
        <div className="content">{children}</div>
      </div>
    </div>
  );
}