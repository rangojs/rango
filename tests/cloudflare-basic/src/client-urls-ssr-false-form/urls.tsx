"use client";

import type { ReactNode } from "react";
import { Suspense, useActionState } from "react";
import { clientUrls, useLoader } from "@rangojs/router/client";
import { SsrFalseFormLoader } from "./defs.js";
import { saveSsrFalseForm } from "./actions.js";

// A no-script document of a group route whose ssr: false loader feeds a
// useActionState form under an inline <Suspense> (#1138,
// e2e/client-urls-ssr-false-form.test.ts, body in tests/shared-e2e).

function SsrFalseFormSave({ id }: { id: string }): ReactNode {
  const [state, action] = useActionState(saveSsrFalseForm, null);
  return (
    <form action={action} data-testid="sff-form">
      <input type="hidden" name="id" value={id} />
      <button type="submit" data-testid="sff-submit">
        Save
      </button>
      {state && <p data-testid="sff-state">{state}</p>}
    </form>
  );
}

function SsrFalseFormPart(): ReactNode {
  const { data } = useLoader(SsrFalseFormLoader);
  return <SsrFalseFormSave id={data.id} />;
}

function SsrFalseFormPage(): ReactNode {
  return (
    <section data-testid="sff-page">
      <h1>Frame</h1>
      <Suspense fallback={<p data-testid="sff-fallback">Reading</p>}>
        <SsrFalseFormPart />
      </Suspense>
    </section>
  );
}

export default clientUrls(({ path, loader }) => [
  path("/", SsrFalseFormPage, { name: "index" }, () => [
    loader(SsrFalseFormLoader, { ssr: false }),
  ]),
]);
