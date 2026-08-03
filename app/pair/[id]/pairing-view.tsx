"use client";

import { useEffect, useState } from "react";

type PairingState = {
  status: "loading" | "waiting" | "qr" | "qr_expired" | "connected" | "failed" | "expired";
  qrDataUrl?: string;
  qrUpdatedAt?: number;
  message?: string;
};

export function PairingView({ id }: { id: string }) {
  const [state, setState] = useState<PairingState>({ status: "loading" });

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!token) {
      setState({ status: "expired", message: "This pairing link is incomplete." });
      return;
    }

    let active = true;
    let timeout: number | undefined;
    let terminal = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/pairing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "view", id, token }),
          cache: "no-store",
        });
        const result = await response.json();
        if (!active) return;
        const nextState = response.ok ? result : { status: "expired", message: result.error };
        setState(nextState);
        if (nextState.status === "connected" || nextState.status === "failed" || nextState.status === "expired") {
          terminal = true;
        }
      } catch {
        if (active) setState((current) => ({ ...current, message: "Connection lost. Retrying…" }));
      } finally {
        if (active && !terminal) {
          timeout = window.setTimeout(refresh, document.hidden ? 10_000 : 2_000);
        }
      }
    };

    void refresh();
    return () => {
      active = false;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [id]);

  const requestFreshQr = async () => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!token) return;
    setState({ status: "waiting", message: "Generating a new QR…" });
    try {
      const response = await fetch("/api/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "refresh", id, token }),
        cache: "no-store",
      });
      if (!response.ok) {
        const result = await response.json();
        setState({ status: "expired", message: result.error ?? "Pairing link expired." });
      }
    } catch {
      setState({ status: "qr_expired", message: "Could not request a new QR. Try again." });
    }
  };

  if (state.status === "connected") {
    return <div className="success"><span>✓</span><h1>Account linked</h1><p>You can close this page.</p></div>;
  }

  return (
    <main>
      <div className="brand"><span className="brandMark">B</span><span>Baileys Agent Kit</span></div>
      <section className="card">
        <div className="copy">
          <p className="eyebrow">Secure device pairing</p>
          <h1>Connect WhatsApp</h1>
          <ol>
            <li>Open WhatsApp on your phone.</li>
            <li>Open <strong>Settings → Linked devices</strong>.</li>
            <li>Tap <strong>Link a device</strong>, then scan.</li>
          </ol>
          <p className="privacy">This private link expires in 10 minutes. The QR is never stored permanently.</p>
        </div>
        <div className="qrPanel">
          {state.qrDataUrl
            ? <img key={state.qrUpdatedAt} src={state.qrDataUrl} width="640" height="640" alt="WhatsApp pairing QR code" />
            : <div className="qrPlaceholder">{state.status !== "qr_expired" && <span className="spinner" />}<p>{state.message ?? (state.status === "expired" ? "Link expired" : state.status === "qr_expired" ? "QR expired. Generate a new one when ready." : state.status === "waiting" ? "Generating QR…" : "Preparing secure QR…")}</p></div>}
          <span className={`status ${state.status}`}>{state.status === "qr" ? "Ready to scan" : state.status === "qr_expired" ? "QR expired" : state.status}</span>
          {state.status === "qr_expired" && <button type="button" onClick={() => void requestFreshQr()}>Generate new QR</button>}
        </div>
      </section>
      <footer>Unofficial WhatsApp integration powered by Baileys</footer>
    </main>
  );
}
