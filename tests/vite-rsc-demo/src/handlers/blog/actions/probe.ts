"use server";

import { recordBlogActionProbe } from "../data/action-probe.js";

export async function submitBlogProbeAction(slug: string, formData: FormData) {
  const rawMessage = formData.get("message");
  const message =
    typeof rawMessage === "string" && rawMessage.trim().length > 0
      ? rawMessage.trim()
      : "Action completed without a custom message.";

  await new Promise((resolve) => setTimeout(resolve, 250));

  const entry = recordBlogActionProbe(slug, message);

  return {
    ok: true,
    slug,
    message,
    count: entry.count,
    submittedAt: entry.lastSubmittedAt,
  };
}
