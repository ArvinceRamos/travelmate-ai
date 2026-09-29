import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled UI error", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
          <section style={{ maxWidth: 420, width: "100%", display: "grid", gap: 12 }}>
            <h1 style={{ margin: 0, fontSize: 24 }}>Something went wrong</h1>
            <p style={{ margin: 0, color: "#64748b" }}>
              TravelMate AI hit an unexpected interface error.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => window.location.assign("/chat")}>
                Back to chat
              </button>
              <button type="button" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
