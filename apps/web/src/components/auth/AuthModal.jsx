import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  authenticateWithGoogle,
  completeVerifiedEmailLogin,
  loginWithEmail,
  resendVerificationEmail,
  signupWithEmail,
  validateSignupEmailLegitimacy,
} from "../../services/authService";
import toast from "react-hot-toast";

const RESEND_COOLDOWN_SECONDS = 45;
const AUTO_VERIFY_POLL_MS = 4000;
const PENDING_EMAIL_VERIFICATION_KEY = "tm_pending_email_verification_v1";

function readPendingEmailVerification() {
  try {
    const raw = sessionStorage.getItem(PENDING_EMAIL_VERIFICATION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed?.email || !parsed?.password) return null;

    return {
      email: String(parsed.email || "").trim().toLowerCase(),
      password: String(parsed.password || ""),
      name: String(parsed.name || ""),
      createdAt: Number(parsed.createdAt || Date.now()),
    };
  } catch {
    return null;
  }
}

function writePendingEmailVerification(payload) {
  try {
    sessionStorage.setItem(
      PENDING_EMAIL_VERIFICATION_KEY,
      JSON.stringify({
        email: String(payload?.email || "").trim().toLowerCase(),
        password: String(payload?.password || ""),
        name: String(payload?.name || ""),
        createdAt: Date.now(),
      })
    );
  } catch {
    // ignore session storage write errors; signup flow still works in-memory
  }
}

function clearPendingEmailVerification() {
  try {
    sessionStorage.removeItem(PENDING_EMAIL_VERIFICATION_KEY);
  } catch {
    // ignore session storage cleanup errors
  }
}

export default function AuthModal({ open, mode = "login", onClose }) {
  const [tab, setTab] = useState(mode === "signup" ? "signup" : "login");
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [autoCheckingVerification, setAutoCheckingVerification] = useState(false);
  const [authError, setAuthError] = useState("");
  const [verificationNotice, setVerificationNotice] = useState("");
  const [verificationStep, setVerificationStep] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const autoCheckInFlightRef = useRef(false);

  const title = useMemo(() => {
    if (verificationStep) return "Verify your email";
    return tab === "login" ? "Welcome back" : "Create your account";
  }, [tab, verificationStep]);

  const subtitle = useMemo(() => {
    if (verificationStep) {
      return "Finish verification before your account can continue into TravelMate AI.";
    }

    return tab === "login"
      ? "Sign in to continue planning your trips."
      : "Start saving chats and itineraries.";
  }, [tab, verificationStep]);

  function resetForm({ nextTab = mode === "signup" ? "signup" : "login", preserveEmail = false } = {}) {
    const preservedEmail = preserveEmail ? String(email || "").trim().toLowerCase() : "";

    setTab(nextTab);
    setBusy(false);
    setResendBusy(false);
    setAutoCheckingVerification(false);
    setAuthError("");
    setVerificationNotice("");
    setVerificationStep(false);
    setResendCooldown(0);
    setName("");
    setEmail(preservedEmail);
    setPassword("");
    setConfirmPassword("");
    autoCheckInFlightRef.current = false;
  }

  useEffect(() => {
    if (!open) return;

    const pending = readPendingEmailVerification();
    if (pending) {
      setTab("signup");
      setBusy(false);
      setResendBusy(false);
      setAutoCheckingVerification(false);
      setAuthError("");
      setVerificationStep(true);
      setVerificationNotice("Your account is almost ready. Please verify your email address to continue. Check your inbox or spam folder for the verification link.");
      setResendCooldown(0);
      setName(pending.name || "");
      setEmail(pending.email || "");
      setPassword(pending.password || "");
      setConfirmPassword("");
      autoCheckInFlightRef.current = false;
      return;
    }

    resetForm({ nextTab: mode === "signup" ? "signup" : "login" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  useEffect(() => {
      if (!open) return;
      if (verificationStep) return;

      setAuthError("");
  }, [tab, open, verificationStep]);

  useEffect(() => {
    if (!resendCooldown) return;

    const timer = window.setTimeout(() => {
      setResendCooldown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (!open || !verificationStep) return;

    let cancelled = false;

    async function attemptVerificationCheck() {
      if (busy || resendBusy || autoCheckInFlightRef.current) return;

      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanPass = String(password || "").trim();
      if (!cleanEmail || !cleanPass) return;

      autoCheckInFlightRef.current = true;
      setAutoCheckingVerification(true);

      try {
        const result = await completeVerifiedEmailLogin(cleanEmail, cleanPass);
        if (cancelled) return;

        if (!result?.verified) {
          return;
        }

        clearPendingEmailVerification();
        setAuthError("");
        setVerificationStep(false);
        setVerificationNotice("Email verified successfully. You can now log in.");
        setTab("login");
        setName("");
        setPassword("");
        setConfirmPassword("");
      } catch (err) {
        if (cancelled) return;

        const message = err?.message || "Could not confirm verification.";
        setAuthError(message);
      } finally {
        if (!cancelled) {
          setAutoCheckingVerification(false);
        }
        autoCheckInFlightRef.current = false;
      }
    }

    attemptVerificationCheck();

    const intervalId = window.setInterval(() => {
      attemptVerificationCheck();
    }, AUTO_VERIFY_POLL_MS);

    const handleFocus = () => {
      attemptVerificationCheck();
    };

    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [open, verificationStep, email, password, busy, resendBusy]);

  if (!open) return null;

  async function handleEmailSubmit(e) {
    e.preventDefault();
    if (busy || resendBusy || autoCheckingVerification) return;

    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPass = String(password || "").trim();
    const cleanName = String(name || "").trim();
    const cleanConfirm = String(confirmPassword || "").trim();

    setAuthError("");

    if (verificationStep) {
      await handleVerifiedContinue();
      return;
    }

    if (tab === "signup") {
      if (!cleanName) {
        toast.error("Please enter your name.");
        return;
      }

      if (!cleanEmail) {
        toast.error("Please enter your email.");
        return;
      }

      if (!cleanPass || !cleanConfirm) {
        toast.error("Please enter and confirm your password.");
        return;
      }

      if (cleanPass !== cleanConfirm) {
        toast.error("Passwords do not match.");
        return;
      }

      const legitimacy = await validateSignupEmailLegitimacy(cleanEmail);
      if (!legitimacy.ok) {
        setAuthError(legitimacy.message);
        toast.error(legitimacy.message);
        return;
      }
    }

    if (tab === "login") {
      if (!cleanEmail || !cleanPass) {
        toast.error("Please enter email and password.");
        return;
      }
    }

    try {
      setBusy(true);

      if (tab === "login") {
        await loginWithEmail(cleanEmail, cleanPass);
        clearPendingEmailVerification();
        sessionStorage.setItem("tm_just_logged_in", "1");
        toast.success("Logged in!");
        onClose?.();
        return;
      }

    writePendingEmailVerification({
      email: cleanEmail,
      password: cleanPass,
      name: cleanName,
    });

    const signupResult = await signupWithEmail(cleanEmail, cleanPass, cleanName);

      setVerificationStep(true);
      setVerificationNotice(
        signupResult.message ||
          "Your account is almost ready. Please verify your email address to continue. Check your inbox or spam folder for the verification link."
    );
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      toast.success("Verification email sent.");
    } catch (err) {
  if (tab === "signup") {
    clearPendingEmailVerification();
  }

  const message = err?.message || "Authentication failed.";
  setAuthError(message);
  toast.error(message);
} finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    if (busy || resendBusy || verificationStep) return;

    try {
      setBusy(true);
      setAuthError("");
      setVerificationNotice("");

      const result = await authenticateWithGoogle();

      if (result?.pendingRedirect) {
        toast.success("Continuing with Google…");
        return;
      }

      clearPendingEmailVerification();
      sessionStorage.setItem("tm_just_logged_in", "1");
      toast.success(result?.isNewUser ? "Account created with Google!" : "Logged in with Google!");
      onClose?.();
    } catch (err) {
      const message = err?.message || "Google sign-in failed.";
      setAuthError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResendVerification() {
    if (busy || resendBusy || resendCooldown > 0) return;

    try {
      setResendBusy(true);
      setAuthError("");

      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanPass = String(password || "").trim();

      await resendVerificationEmail(cleanEmail, cleanPass);

      writePendingEmailVerification({
        email: cleanEmail,
        password: cleanPass,
        name,
      });

      setVerificationNotice(
        "Verification email sent. Please check your inbox or spam folder for the verification link."
      );
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      toast.success("Verification email sent.");
    } catch (err) {
      const message = err?.message || "Could not resend verification email.";
      setAuthError(message);
      toast.error(message);
    } finally {
      setResendBusy(false);
    }
  }

  async function handleVerifiedContinue() {
    if (busy || resendBusy || autoCheckingVerification) return;

    try {
      setBusy(true);
      setAuthError("");

      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanPass = String(password || "").trim();

      const result = await completeVerifiedEmailLogin(cleanEmail, cleanPass);

      if (!result?.verified) {
        setVerificationNotice(
          "Your email is not verified yet. Please open the verification link from your inbox or spam folder, then return here."
        );
        toast.error("Email is not verified yet.");
        return;
      }

      clearPendingEmailVerification();
      setAuthError("");
      setVerificationStep(false);
      setVerificationNotice("Email verified successfully. You can now log in.");
      setTab("login");
      setName("");
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      const message = err?.message || "Could not confirm verification.";
      setAuthError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function handleBackToSignup() {
    if (busy || resendBusy) return;
    clearPendingEmailVerification();
    resetForm({ nextTab: "signup", preserveEmail: false });
  }

  return (
    <div className="tm-modalOverlay" role="dialog" aria-modal="true">
      <div className="tm-authShell" aria-label="Authentication dialog">
        <div className="tm-authLeft">
          <div className="tm-authLeftContent">
            <div className="tm-authBrandCard">
              <div className="tm-authLogoWrap">
                <img className="tm-authLogo" src="/assets/travelmate-logo.png" alt="TravelMate AI" />
              </div>

              <div className="tm-authBrandMain">
                <span className="tm-authBrandName">Travelmate</span>
                <span className="tm-authBrandAi">AI</span>
              </div>

              <div className="tm-authBrandTagline">Plan faster. Travel smarter.</div>
            </div>

            <div className="tm-authFeaturesCard">
              <div className="tm-authFeaturesHeader">
                <div className="tm-authFeaturesBadge" aria-hidden>
                  ✨
                </div>
                <h3 className="tm-authFeaturesTitle">Everything in one place</h3>
              </div>

              <div className="tm-authFeaturesList">
                <div className="tm-authFeatureItem">
                  <div className="tm-authFeatureIcon" aria-hidden>
                    🤖
                  </div>
                  <div className="tm-authFeatureContent">
                    <div className="tm-authFeatureTitle">AI-driven personalized suggestions</div>
                    <div className="tm-authFeatureDesc">
                      Get recommendations tailored to your preferences
                    </div>
                  </div>
                </div>

                <div className="tm-authFeatureItem">
                  <div className="tm-authFeatureIcon" aria-hidden>
                    ⚡
                  </div>
                  <div className="tm-authFeatureContent">
                    <div className="tm-authFeatureTitle">Generate itineraries in seconds</div>
                    <div className="tm-authFeatureDesc">Build day-by-day travel plans faster</div>
                  </div>
                </div>

                <div className="tm-authFeatureItem">
                  <div className="tm-authFeatureIcon" aria-hidden>
                    🧭
                  </div>
                  <div className="tm-authFeatureContent">
                    <div className="tm-authFeatureTitle">Navigate stress-free</div>
                    <div className="tm-authFeatureDesc">Get route guidance and local travel insights</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="tm-authStatsRow">
              <div className="tm-authStatCard">
                <div className="tm-authStatValue">AI-Driven</div>
                <div className="tm-authStatLabel">Smart travel help</div>
              </div>

              <div className="tm-authStatCard">
                <div className="tm-authStatValue">190+</div>
                <div className="tm-authStatLabel">Countries</div>
              </div>

              <div className="tm-authStatCard">
                <div className="tm-authStatValue">24/7</div>
                <div className="tm-authStatLabel">Access</div>
              </div>
            </div>

            <div className="tm-authTrustLine">Smart travel planning starts here</div>
          </div>
        </div>

        <div className="tm-authRight">
          <div className="tm-authPanel">
            <div className="tm-authPanelTop">
              <div className="tm-authHeadings">
                <h1 className="tm-authTitle">{title}</h1>
                <p className="tm-authSubtitle">{subtitle}</p>
              </div>

              <button type="button" className="tm-authClose" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </div>

            {!verificationStep ? (
              <div className="tm-authTabs" role="tablist" aria-label="Authentication tabs">
                <button
                  type="button"
                  className={tab === "login" ? "tm-authTab tm-authTab--active" : "tm-authTab"}
                  onClick={() => setTab("login")}
                  disabled={busy || resendBusy}
                >
                  Login
                </button>
                <button
                  type="button"
                  className={tab === "signup" ? "tm-authTab tm-authTab--active" : "tm-authTab"}
                  onClick={() => setTab("signup")}
                  disabled={busy || resendBusy}
                >
                  Sign Up
                </button>
              </div>
            ) : null}

            {!verificationStep ? (
              <button className="tm-googleBtnPro" onClick={handleGoogle} disabled={busy || resendBusy} type="button">
                <span className="tm-googleIcon" aria-hidden>
                  <svg width="18" height="18" viewBox="0 0 48 48">
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.3 0 6.3 1.1 8.6 3.2l6.4-6.4C35.1 2.6 29.8 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.6 5.9C12 13.4 17.5 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.1 24.5c0-1.6-.1-2.8-.4-4.1H24v7.8h12.5c-.3 2-1.9 5-5.4 7.1l8.3 6.4c4.9-4.5 7.7-11.2 7.7-19.2z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.1 28.7c-.5-1.5-.8-3.1-.8-4.7s.3-3.2.8-4.7l-7.6-5.9C.9 16.6 0 20.2 0 24s.9 7.4 2.5 10.6l7.6-5.9z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.5 0 12-2.1 16-5.7l-8.3-6.4c-2.2 1.5-5.2 2.6-7.7 2.6-6.5 0-12-3.9-14-9.7l-7.6 5.9C6.4 42.6 14.6 48 24 48z"
                    />
                  </svg>
                </span>
                <span>{busy ? "Please wait…" : tab === "login" ? "Continue with Google" : "Sign up with Google"}</span>
              </button>
            ) : null}

            {verificationNotice ? <div className="tm-authNotice tm-authNotice--success">{verificationNotice}</div> : null}

            {verificationStep ? (
              <div className="tm-authNotice tm-authNotice--success">
                {autoCheckingVerification
                  ? "Waiting for verification… Once your email is verified, you can continue to log in."
                  : "Waiting for verification. Keep this screen open after clicking the email verification link."}
              </div>
            ) : null}

            {authError ? <div className="tm-authNotice tm-authNotice--error">{authError}</div> : null}

            {!verificationStep ? (
              <div className="tm-authDivider">
                <span>or</span>
              </div>
            ) : null}

            <form onSubmit={handleEmailSubmit} className="tm-authForm">
              {tab === "signup" && !verificationStep ? (
                <div className="tm-fieldPro">
                  <label className="tm-labelPro">Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    autoComplete="name"
                    disabled={busy || resendBusy}
                  />
                </div>
              ) : null}

              <div className="tm-fieldPro">
                <label className="tm-labelPro">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  disabled={busy || resendBusy || verificationStep}
                />
              </div>

              <div className="tm-fieldPro">
                <label className="tm-labelPro">{verificationStep ? "Password to continue" : "Password"}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete={tab === "login" ? "current-password" : "new-password"}
                  disabled={busy || resendBusy}
                />
              </div>

              {tab === "signup" && !verificationStep ? (
                <div className="tm-fieldPro">
                  <label className="tm-labelPro">Confirm Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    autoComplete="new-password"
                    disabled={busy || resendBusy}
                  />
                </div>
              ) : null}

              {!verificationStep ? (
                <div className="tm-authRowLinks">
                  <button
                    type="button"
                    className="tm-linkPro"
                    onClick={() => toast("Reset password coming soon.")}
                    disabled={busy || resendBusy}
                  >
                    Forgot password?
                  </button>

                  <button
                    type="button"
                    className="tm-linkPro"
                    onClick={() => setTab(tab === "login" ? "signup" : "login")}
                    disabled={busy || resendBusy}
                  >
                    {tab === "login" ? "Create an account" : "Already have an account?"}
                  </button>
                </div>
              ) : null}

              {!verificationStep ? (
                <button className="tm-primaryBtnPro" disabled={busy || resendBusy} type="submit">
                  {busy ? "Please wait…" : tab === "login" ? "Login" : "Create account"}
                </button>
              ) : (
                <>
                  <button className="tm-primaryBtnPro" disabled={busy || resendBusy || autoCheckingVerification} type="submit">
                    {busy ? "Checking verification…" : autoCheckingVerification ? "Waiting for verification…" : "I’ve verified my email"}
                  </button>

                  <button
                    type="button"
                    className="tm-linkPro tm-linkPro--center"
                    onClick={handleResendVerification}
                    disabled={busy || resendBusy || autoCheckingVerification || resendCooldown > 0}
                  >
                    {resendBusy
                      ? "Sending verification email…"
                      : resendCooldown > 0
                      ? `Resend available in ${resendCooldown}s`
                      : "Resend verification email"}
                  </button>

                  <button
                    type="button"
                    className="tm-linkPro tm-linkPro--center"
                    onClick={handleBackToSignup}
                    disabled={busy || resendBusy || autoCheckingVerification}
                  >
                    Back to sign up
                  </button>
                </>
              )}

              {!verificationStep ? (
                <div className="tm-authSmallPrint">
                  {tab === "login" ? (
                    <>
                      New here?{" "}
                      <button
                        type="button"
                        className="tm-linkInline"
                        onClick={() => setTab("signup")}
                        disabled={busy || resendBusy}
                      >
                        Sign up
                      </button>
                    </>
                  ) : (
                    <>
                      Already have an account?{" "}
                      <button
                        type="button"
                        className="tm-linkInline"
                        onClick={() => setTab("login")}
                        disabled={busy || resendBusy}
                      >
                        Login
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}