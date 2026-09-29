import React, { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";

import Card from "../components/common/Card.jsx";
import Button from "../components/common/Button.jsx";

import { useAuth } from "../hooks/useAuth";
import { auth, db, storage } from "../services/firebase";

import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  updateProfile,
} from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";

const AVATAR_UPLOADS_ENABLED =
  import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true" ||
  import.meta.env.VITE_ENABLE_AVATAR_UPLOADS === "true";

function safeName(u) {
  return (u?.displayName || "").trim();
}

function providerHasPassword(user) {
  const list = Array.isArray(user?.providerData) ? user.providerData : [];
  return list.some((p) => p?.providerId === "password");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function drawCroppedSquare({ img, canvas, zoom, panX, panY }) {
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);

  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const baseScale = Math.max(size / iw, size / ih);
  const scale = baseScale * zoom;

  const drawW = iw * scale;
  const drawH = ih * scale;

  const x = (size - drawW) / 2 + panX;
  const y = (size - drawH) / 2 + panY;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x, y, drawW, drawH);
}

function toArrayText(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).join(", ");
  }
  return String(value || "").trim();
}

function parseCsvInput(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function buildProfileSummary({
  bio,
  travelPreferences,
  interests,
  travelStyle,
  budgetStyle,
  personalTravelNotes,
}) {
  const parts = [];
  const legacyBio = String(bio || "").trim();
  if (legacyBio) parts.push(legacyBio);

  const pref = parseCsvInput(travelPreferences);
  const ints = parseCsvInput(interests);
  if (pref.length) parts.push(`Travel preferences: ${pref.join(", ")}.`);
  if (ints.length) parts.push(`Interests: ${ints.join(", ")}.`);
  if (String(travelStyle || "").trim()) parts.push(`Travel style: ${String(travelStyle).trim()}.`);
  if (String(budgetStyle || "").trim()) parts.push(`Budget style: ${String(budgetStyle).trim()}.`);
  if (String(personalTravelNotes || "").trim()) parts.push(`Personal notes: ${String(personalTravelNotes).trim()}.`);

  return parts.join(" ").trim();
}

function statsText(profile) {
  const prefCount = parseCsvInput(profile.travelPreferences).length;
  const interestCount = parseCsvInput(profile.interests).length;
  return [
    prefCount ? `${prefCount} preference${prefCount > 1 ? "s" : ""}` : null,
    interestCount ? `${interestCount} interest${interestCount > 1 ? "s" : ""}` : null,
    profile.travelStyle ? profile.travelStyle : null,
    profile.budgetStyle ? profile.budgetStyle : null,
  ]
    .filter(Boolean)
    .join(" • ");
}

export default function SettingsPage() {
  const { user, loading } = useAuth();

  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [homeBase, setHomeBase] = useState("");
  const [bio, setBio] = useState("");
  const [travelPreferences, setTravelPreferences] = useState("");
  const [interests, setInterests] = useState("");
  const [travelStyle, setTravelStyle] = useState("");
  const [budgetStyle, setBudgetStyle] = useState("");
  const [personalTravelNotes, setPersonalTravelNotes] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [photoPath, setPhotoPath] = useState("");

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");

  const [photoFile, setPhotoFile] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({ dragging: false, sx: 0, sy: 0, px: 0, py: 0 });

  const imgRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);

  const uid = user?.uid || null;

  const profileDocRef = useMemo(() => {
    if (!uid) return null;
    return doc(db, "users", uid);
  }, [uid]);

  useEffect(() => {
    if (!profileDocRef || !user) return;

    let cancelled = false;

    (async () => {
      try {
        const snap = await getDoc(profileDocRef);
        const data = snap.exists() ? snap.data() : {};
        const travelProfile = data?.travelProfile || {};

        if (cancelled) return;

        setDisplayName(safeName(user) || data?.displayName || "");
        setHomeBase(data?.homeBase || "");
        setBio(data?.bio || "");
        setTravelPreferences(toArrayText(travelProfile?.travelPreferences || data?.travelPreferences));
        setInterests(toArrayText(travelProfile?.interests || data?.interests));
        setTravelStyle(String(travelProfile?.travelStyle || data?.travelStyle || "").trim());
        setBudgetStyle(String(travelProfile?.budgetStyle || data?.budgetStyle || "").trim());
        setPersonalTravelNotes(
          String(travelProfile?.personalTravelNotes || data?.personalTravelNotes || "").trim()
        );
        setPhotoUrl(user?.photoURL || data?.photoURL || "");
        setPhotoPath(data?.photoPath || "");
      } catch {
        if (!cancelled) {
          toast.error("Could not load your settings.");
        }
      } finally {
        if (!cancelled) setProfileLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profileDocRef, user]);

  useEffect(() => {
    if (loading) return;
    if (user) return;
    window.location.assign("/chat?auth=login&next=%2Fsettings");
  }, [loading, user]);

  const travelProfile = useMemo(
    () => ({
      travelPreferences,
      interests,
      travelStyle,
      budgetStyle,
      personalTravelNotes,
    }),
    [travelPreferences, interests, travelStyle, budgetStyle, personalTravelNotes]
  );

  const aiProfileSummary = useMemo(
    () =>
      buildProfileSummary({
        bio,
        travelPreferences,
        interests,
        travelStyle,
        budgetStyle,
        personalTravelNotes,
      }),
    [bio, travelPreferences, interests, travelStyle, budgetStyle, personalTravelNotes]
  );

  async function saveProfile() {
    if (!user) return;
    const name = (displayName || "").trim();
    if (!name) {
      toast.error("Please enter a display name.");
      return;
    }

    setBusy(true);
    try {
      await updateProfile(auth.currentUser, { displayName: name });

      await setDoc(
        doc(db, "users", user.uid),
        {
          displayName: name,
          email: user.email || null,
          bio: String(bio || "").trim(),
          homeBase: String(homeBase || "").trim(),
          photoURL: auth.currentUser?.photoURL || photoUrl || null,
          photoPath: photoPath || null,
          travelProfile: {
            travelPreferences: parseCsvInput(travelPreferences),
            interests: parseCsvInput(interests),
            travelStyle: String(travelStyle || "").trim(),
            budgetStyle: String(budgetStyle || "").trim(),
            personalTravelNotes: String(personalTravelNotes || "").trim(),
            summary: aiProfileSummary || null,
          },
          aiProfileContext: aiProfileSummary || null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      toast.success("Profile updated.");
    } catch (e) {
      toast.error(e?.message || "Failed to update profile.");
    } finally {
      setBusy(false);
    }
  }

  function onPickPhoto(e) {
    const f = e.target.files?.[0] || null;
    if (!f) return;

    if (!f.type.startsWith("image/")) {
      toast.error("Please choose an image file.");
      e.target.value = "";
      return;
    }

    if (f.size > 6 * 1024 * 1024) {
      toast.error("Image is too large. Please use an image under 6MB.");
      e.target.value = "";
      return;
    }

    setPhotoFile(f);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setEditorOpen(true);
    e.target.value = "";
  }

  useEffect(() => {
    if (!editorOpen || !photoFile) return;

    const url = URL.createObjectURL(photoFile);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        drawCroppedSquare({ img, canvas, zoom: 1, panX: 0, panY: 0 });
      }
    };
    img.onerror = () => {
      toast.error("Could not preview this image.");
      setEditorOpen(false);
      setPhotoFile(null);
    };
    img.src = url;

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [editorOpen, photoFile]);

  useEffect(() => {
    if (!editorOpen) return;
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    drawCroppedSquare({ img, canvas, zoom, panX: pan.x, panY: pan.y });
  }, [editorOpen, zoom, pan]);

  async function uploadCroppedPhoto() {
    if (!user) return;
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    setPhotoBusy(true);
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Failed to process image.");

      const previousPath = photoPath || "";
      const nextPath = `users/${user.uid}/profile/profile_${Date.now()}.jpg`;
      const storageRef = ref(storage, nextPath);
      await uploadBytes(storageRef, blob, { contentType: "image/jpeg" });
      const url = await getDownloadURL(storageRef);

      await updateProfile(auth.currentUser, { photoURL: url });
      await setDoc(
        doc(db, "users", user.uid),
        {
          photoURL: url,
          photoPath: nextPath,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      if (previousPath && previousPath !== nextPath) {
        deleteObject(ref(storage, previousPath)).catch(() => {});
      }

      setPhotoUrl(url);
      setPhotoPath(nextPath);
      setEditorOpen(false);
      setPhotoFile(null);
      toast.success("Profile photo updated.");
    } catch (e) {
      toast.error(e?.message || "Failed to upload profile photo.");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function changePassword() {
    if (!user) return;
    if (!providerHasPassword(user)) {
      toast.error("This account does not use email/password. Use your provider's security settings.");
      return;
    }

    const cur = (currentPw || "").trim();
    const np = (newPw || "").trim();
    const np2 = (newPw2 || "").trim();

    if (!cur || !np || !np2) {
      toast.error("Fill in all password fields.");
      return;
    }
    if (np.length < 6) {
      toast.error("New password must be at least 6 characters.");
      return;
    }
    if (np !== np2) {
      toast.error("New passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      const cred = EmailAuthProvider.credential(user.email, cur);
      await reauthenticateWithCredential(auth.currentUser, cred);
      await updatePassword(auth.currentUser, np);
      setCurrentPw("");
      setNewPw("");
      setNewPw2("");
      toast.success("Password updated.");
    } catch (e) {
      toast.error(e?.message || "Failed to change password.");
    } finally {
      setBusy(false);
    }
  }

  function startDragging(clientX, clientY) {
    dragRef.current = {
      dragging: true,
      sx: clientX,
      sy: clientY,
      px: pan.x,
      py: pan.y,
    };
    setDragging(true);
  }

  function moveDragging(clientX, clientY) {
    if (!dragRef.current.dragging) return;
    const dx = clientX - dragRef.current.sx;
    const dy = clientY - dragRef.current.sy;
    setPan({
      x: clamp(dragRef.current.px + dx, -220, 220),
      y: clamp(dragRef.current.py + dy, -220, 220),
    });
  }

  function stopDragging() {
    dragRef.current.dragging = false;
    setDragging(false);
  }

  const avatarNode = useMemo(() => {
    const initials = (user?.displayName || user?.email || "U").trim()[0]?.toUpperCase?.() || "U";
    return (
      <div className="tm-settingsAvatar tm-settingsAvatar--lg">
        {photoUrl ? <img src={photoUrl} alt="Profile" /> : <span>{initials}</span>}
      </div>
    );
  }, [photoUrl, user]);

  if (loading || !profileLoaded) return null;

  return (
    <div className="tm-settingsPage tm-pageFull">
      <Card title="Settings">
        <div className="tm-settingsScroll">
        <div className="tm-settingsShell">
          
          <section className="tm-settingsHero">
            <div className="tm-settingsHero__main">
              <div className="tm-settingsEyebrow">Profile and travel preferences</div>
              <h2 className="tm-settingsHero__title">Keep your profile clean, current, and useful for trip planning.</h2>
              <p className="tm-settingsHero__text">
                Your saved preferences are used by TravelMate AI to shape itineraries, pacing, food suggestions,
                and recommendation style.
              </p>
              <div className="tm-settingsHero__chips">
                <span className="tm-settingsChip">AI-aware profile</span>
                <span className="tm-settingsChip">Firebase synced</span>
                <span className="tm-settingsChip">Secure account controls</span>
              </div>
            </div>
            <div className="tm-settingsHero__side">
              <div className="tm-settingsSnapshot">
                {avatarNode}
                <div className="tm-settingsSnapshot__meta">
                  <div className="tm-settingsSnapshot__name">{displayName || user?.displayName || "Traveler"}</div>
                  <div className="tm-settingsSnapshot__email">{user?.email}</div>
                  <div className="tm-settingsSnapshot__sub">{statsText(travelProfile) || "No travel profile saved yet."}</div>
                </div>
              </div>
            </div>
          </section>

          <div className="tm-settingsGrid tm-settingsGrid--pro">
            <section className="tm-settingsColumn">
              <div className="tm-settingsSection">
                <div className="tm-settingsSection__title">User information</div>
                <div className="tm-settingsSection__subtitle">
                  Update your public profile, photo, and trip guidance preferences.
                </div>

                <div className="tm-settingsProfileRow tm-settingsProfileRow--pro">
                  {avatarNode}
                  <div className="tm-settingsProfileMeta tm-settingsProfileMeta--stack">
                    <div>
                      <div className="tm-settingsProfileName">{displayName || user?.displayName || "Traveler"}</div>
                      <div className="tm-settingsEmail">{user?.email}</div>
                    </div>

                    <div className="tm-settingsPhotoActions">
                      {AVATAR_UPLOADS_ENABLED ? (
                        <>
                          <label className="tm-fileBtn" htmlFor="tmPhotoPick">
                            {photoUrl ? "Replace photo" : "Upload photo"}
                          </label>
                          <input
                            ref={fileInputRef}
                            id="tmPhotoPick"
                            className="tm-fileInput"
                            type="file"
                            accept="image/*"
                            onChange={onPickPhoto}
                            disabled={busy || photoBusy}
                          />
                          <div className="tm-settingsPhotoHint">
                            JPG or PNG, square crop, up to 6MB.{photoBusy ? " Uploading…" : ""}
                          </div>
                        </>
                      ) : (
                        <div className="tm-settingsPhotoHint" role="status">
                          Avatar uploads are unavailable without Firebase Storage billing. Your existing photo remains visible.
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="tm-formGrid">
                  <label className="tm-field">
                    <div className="tm-label">Display name</div>
                    <input
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="e.g., Arvince"
                      disabled={busy}
                    />
                  </label>

                  <label className="tm-field">
                    <div className="tm-label">Home base</div>
                    <input
                      value={homeBase}
                      onChange={(e) => setHomeBase(e.target.value)}
                      placeholder="e.g., Tokyo, Cebu City, or Singapore"
                      disabled={busy}
                    />
                  </label>

                  <label className="tm-field tm-field--full">
                    <div className="tm-label">Bio</div>
                    <textarea
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      rows={3}
                      placeholder="Short summary about how you like to travel."
                      disabled={busy}
                    />
                  </label>
                </div>
              </div>

              <div className="tm-settingsSection">
                <div className="tm-settingsSection__title">Travel profile for AI</div>
                <div className="tm-settingsSection__subtitle">
                  These fields are saved to your profile and injected into TravelMate AI context automatically.
                </div>

                <div className="tm-formGrid tm-formGrid--single">
                  <label className="tm-field tm-field--full">
                    <div className="tm-label">Travel preferences</div>
                    <input
                      value={travelPreferences}
                      onChange={(e) => setTravelPreferences(e.target.value)}
                      placeholder="budget travel, local food, fewer transfers"
                      disabled={busy}
                    />
                    <div className="tm-helpText">Use commas to separate preferences.</div>
                  </label>

                  <label className="tm-field tm-field--full">
                    <div className="tm-label">Interests</div>
                    <input
                      value={interests}
                      onChange={(e) => setInterests(e.target.value)}
                      placeholder="history, cafés, beaches, museums"
                      disabled={busy}
                    />
                  </label>

                  <div className="tm-formGrid">
                    <label className="tm-field">
                      <div className="tm-label">Travel style</div>
                      <input
                        value={travelStyle}
                        onChange={(e) => setTravelStyle(e.target.value)}
                        placeholder="relaxed, balanced, packed"
                        disabled={busy}
                      />
                    </label>

                    <label className="tm-field">
                      <div className="tm-label">Budget style</div>
                      <input
                        value={budgetStyle}
                        onChange={(e) => setBudgetStyle(e.target.value)}
                        placeholder="budget, mid-range, luxury"
                        disabled={busy}
                      />
                    </label>
                  </div>

                  <label className="tm-field tm-field--full">
                    <div className="tm-label">Personal travel notes</div>
                    <textarea
                      value={personalTravelNotes}
                      onChange={(e) => setPersonalTravelNotes(e.target.value)}
                      rows={4}
                      placeholder="Examples: avoid crowded tourist spots, prefer relaxed pacing, want more local food stops."
                      disabled={busy}
                    />
                  </label>
                </div>

                <div className="tm-settingsPreviewBox">
                  <div className="tm-settingsPreviewBox__label">AI context preview</div>
                  <div className="tm-settingsPreviewBox__text">
                    {aiProfileSummary || "Your saved travel preferences will appear here and be used by the AI."}
                  </div>
                </div>

                <div className="tm-actionsRow">
                  <Button onClick={saveProfile} disabled={busy || photoBusy}>
                    {busy ? "Saving…" : "Save profile"}
                  </Button>
                </div>
              </div>
            </section>

            <section className="tm-settingsColumn">
              <div className="tm-settingsSection">
                <div className="tm-settingsSection__title">Security</div>
                <div className="tm-settingsSection__subtitle">Keep your account secure without affecting your saved chats or itineraries.</div>

                {!providerHasPassword(user) ? (
                  <div className="tm-mutedBox">
                    Your account uses an external provider such as Google. Change your password from that provider’s
                    security settings.
                  </div>
                ) : (
                  <>
                    <div className="tm-formGrid tm-formGrid--single">
                      <label className="tm-field tm-field--full">
                        <div className="tm-label">Current password</div>
                        <input
                          type="password"
                          value={currentPw}
                          onChange={(e) => setCurrentPw(e.target.value)}
                          placeholder="••••••••"
                          disabled={busy}
                        />
                      </label>

                      <label className="tm-field tm-field--full">
                        <div className="tm-label">New password</div>
                        <input
                          type="password"
                          value={newPw}
                          onChange={(e) => setNewPw(e.target.value)}
                          placeholder="At least 6 characters"
                          disabled={busy}
                        />
                      </label>

                      <label className="tm-field tm-field--full">
                        <div className="tm-label">Confirm new password</div>
                        <input
                          type="password"
                          value={newPw2}
                          onChange={(e) => setNewPw2(e.target.value)}
                          placeholder="Repeat new password"
                          disabled={busy}
                        />
                      </label>
                    </div>

                    <div className="tm-actionsRow tm-actionsRow--left">
                      <Button onClick={changePassword} disabled={busy || photoBusy}>
                        {busy ? "Updating…" : "Change password"}
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <div className="tm-settingsSection">
                <div className="tm-settingsSection__title">How TravelMate AI uses this</div>
                <div className="tm-mutedBox tm-mutedBox--stack">
                  <div>
                    Saved profile data is used to personalize itinerary pace, food suggestions, attraction mix,
                    recommendation tone, and budget framing.
                  </div>
                  <ul className="tm-ul">
                    <li>Budget travelers get lower-cost routing and food suggestions first.</li>
                    <li>Relaxed travelers get fewer transfers and more breathing room.</li>
                    <li>Users who avoid crowds get quieter areas and softer pacing when possible.</li>
                  </ul>
                </div>
              </div>

              <div className="tm-settingsSection">
                <div className="tm-settingsSection__title">App notes</div>
                <div className="tm-mutedBox">
                  <ul className="tm-ul">
                    <li>TravelMate AI is free and ad-supported.</li>
                    <li>No booking or payments happen inside the app.</li>
                    <li>Refreshing should keep your session and current chat state.</li>
                  </ul>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
      </Card>

      {editorOpen ? (
        <div className="tm-modalOverlay" role="dialog" aria-modal="true">
          <div className="tm-settingsModal">
            <div className="tm-settingsModal__header">
              <div className="tm-settingsModal__title">Edit profile photo</div>
              <button
                className="tm-iconBtn"
                type="button"
                onClick={() => {
                  setEditorOpen(false);
                  setPhotoFile(null);
                  stopDragging();
                }}
                aria-label="Close"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="tm-settingsModal__body">
              <div
                className={`tm-cropStage ${dragging ? "tm-cropStage--dragging" : ""}`}
                onMouseDown={(e) => startDragging(e.clientX, e.clientY)}
                onMouseMove={(e) => moveDragging(e.clientX, e.clientY)}
                onMouseUp={stopDragging}
                onMouseLeave={stopDragging}
                onTouchStart={(e) => {
                  const touch = e.touches?.[0];
                  if (!touch) return;
                  startDragging(touch.clientX, touch.clientY);
                }}
                onTouchMove={(e) => {
                  const touch = e.touches?.[0];
                  if (!touch) return;
                  moveDragging(touch.clientX, touch.clientY);
                }}
                onTouchEnd={stopDragging}
              >
                <canvas ref={canvasRef} width={320} height={320} className="tm-cropCanvas" />
                <div className="tm-cropHint">Drag to reposition • Use the slider to zoom</div>
              </div>

              <label className="tm-field tm-field--full" style={{ marginTop: 12 }}>
                <div className="tm-label">Zoom</div>
                <input
                  type="range"
                  min={1}
                  max={2.2}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  disabled={photoBusy}
                />
              </label>
            </div>

            <div className="tm-settingsModal__footer">
              <Button
                variant="ghost"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                disabled={photoBusy}
              >
                Reset
              </Button>
              <div style={{ flex: 1 }} />
              <Button
                variant="ghost"
                onClick={() => {
                  setEditorOpen(false);
                  setPhotoFile(null);
                  stopDragging();
                }}
                disabled={photoBusy}
              >
                Cancel
              </Button>
              <Button onClick={uploadCroppedPhoto} disabled={photoBusy}>
                {photoBusy ? "Saving…" : "Save photo"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
