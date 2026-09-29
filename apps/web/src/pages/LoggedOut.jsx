import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import AuthModal from "../components/auth/AuthModal.jsx";
import "../styles/LoggedOut.css";

export default function LoggedOut() {
  const nav = useNavigate();
  const { user, loading } = useAuth();

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

  useEffect(() => {
    if (loading) return;
    if (!user) return;

    sessionStorage.setItem("tm_force_new_chat", "1");
    nav(`/chat?new=${Date.now()}`, { replace: true });
  }, [loading, user, nav]);

  return (
    <>
      <div className="tm-loggedOut">
        <div className="tm-loggedOutCard">
          <h1 className="tm-loggedOutTitle">You’re signed out</h1>
          <p className="tm-loggedOutSub">
            You can still use TravelMate AI, but chats and itineraries won’t be saved unless you sign in.
          </p>

          <div className="tm-loggedOutActions">
            <button className="tm-loggedOutPrimaryBtn" onClick={openLogin}>
              Log in
            </button>

            <button
              type="button"
              className="tm-loggedOutSecondaryBtn"
              onClick={openSignup}
            >
              Create account
            </button>

            <button
              type="button"
              className="tm-loggedOutGhostBtn"
              onClick={() => nav("/chat?new=1")}
            >
              Start new chat
            </button>
          </div>
        </div>
      </div>

      <AuthModal open={modalOpen} mode={modalMode} onClose={() => setModalOpen(false)} />
    </>
  );
}