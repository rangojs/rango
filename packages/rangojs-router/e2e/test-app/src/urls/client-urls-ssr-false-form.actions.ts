"use server";

// The useActionState action of client-urls-ssr-false-form.tsx: its form's
// action is a bound server reference.
export async function saveSsrFalseForm(
  _previous: string | null,
  formData: FormData,
): Promise<string> {
  return `saved ${String(formData.get("id"))}`;
}
