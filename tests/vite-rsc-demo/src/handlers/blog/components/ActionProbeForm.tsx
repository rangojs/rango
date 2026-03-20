"use client";

import { startTransition, useActionState } from "react";

interface ProbeResult {
  ok: boolean;
  slug: string;
  message: string;
  count: number;
  submittedAt: string | null;
}

export function ActionProbeForm({
  slug,
  action,
}: {
  slug: string;
  action: (slug: string, formData: FormData) => Promise<ProbeResult>;
}) {
  const [state, formAction, isPending] = useActionState<
    ProbeResult | null,
    FormData
  >(async (_prevState, formData) => {
    return action(slug, formData);
  }, null);

  return (
    <div
      style={{
        marginTop: "1rem",
        padding: "1rem",
        border: "1px solid #d1d5db",
        borderRadius: "8px",
        background: "#ffffff",
      }}
    >
      <h4 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Action Probe</h4>
      <p style={{ marginTop: 0, color: "#4b5563", fontSize: "0.9rem" }}>
        Submit this while the sidebar parallel route is present. The page should
        refresh its server snapshot below without showing the sidebar loading
        skeleton again.
      </p>

      <form action={(formData) => startTransition(() => formAction(formData))}>
        <label
          style={{
            display: "block",
            fontSize: "0.9rem",
            fontWeight: 600,
            marginBottom: "0.35rem",
          }}
        >
          Message
        </label>
        <input
          type="text"
          name="message"
          defaultValue="Check that sidebar stays rendered during action refresh"
          disabled={isPending}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "0.65rem 0.8rem",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            marginBottom: "0.75rem",
          }}
        />
        <button
          type="submit"
          disabled={isPending}
          style={{
            background: isPending ? "#94a3b8" : "#0f766e",
            color: "white",
            border: "none",
            borderRadius: "6px",
            padding: "0.7rem 1rem",
            cursor: isPending ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {isPending ? "Running action..." : "Run Blog Action"}
        </button>
      </form>

      {state && (
        <div
          style={{
            marginTop: "0.9rem",
            padding: "0.85rem",
            borderRadius: "6px",
            background: "#ecfeff",
            border: "1px solid #99f6e4",
            fontSize: "0.9rem",
          }}
        >
          <strong>Latest action response:</strong>
          <div>Count: {state.count}</div>
          <div>Message: {state.message}</div>
          <div>At: {state.submittedAt ?? "unknown"}</div>
        </div>
      )}
    </div>
  );
}
