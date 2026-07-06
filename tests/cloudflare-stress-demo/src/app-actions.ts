"use server";

/**
 * Server action for the /app/feedback route. The bench posts this via the
 * progressive-enhancement wire format (form-encoded $ACTION_ID_* field), so
 * each request runs the action then a full PE re-render.
 */
export async function submitFeedback(formData: FormData): Promise<void> {
  await new Promise((r) => setTimeout(r, 3));
  // Consume the payload; a fire-and-forget PE form ignores return values.
  String(formData.get("message") ?? "");
}
