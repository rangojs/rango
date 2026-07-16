import { Meta, type HandlerContext } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import {
  CacheLabPulseLoader,
  getCacheLabProduct,
} from "../../cache-lab-data.js";
import {
  CacheLabInvalidationPanel,
  CacheLabLivePulse,
  CacheLabProductGrid,
} from "../CacheLabClient.js";

const STREAMED_META_DELAY_MS = 900;

export async function CacheLabPage(ctx: HandlerContext) {
  const probe = (ctx.searchParams.get("probe") ?? "explore").slice(0, 64);
  const [alpha, beta] = await Promise.all([
    getCacheLabProduct("alpha", probe),
    getCacheLabProduct("beta", probe),
  ]);
  ctx.use(Meta)({
    name: "description",
    content:
      "An explorable Vercel Runtime Cache lab for use cache, PPR, tags, and invalidation.",
  });
  ctx.use(Meta)(
    new Promise<{ title: string }>((resolve) =>
      setTimeout(
        () => resolve({ title: `Vercel Cache Lab - ${alpha.cacheToken}` }),
        STREAMED_META_DELAY_MS,
      ),
    ),
  );

  return (
    <main className="cache-lab" data-testid="cache-lab-page">
      <style dangerouslySetInnerHTML={{ __html: CACHE_LAB_STYLES }} />
      <header className="cache-lab-hero">
        <div className="cache-lab-status">
          <span /> Vercel Runtime Cache
        </div>
        <h1 data-testid="cache-lab-title">Cache behavior you can inspect</h1>
        <p>
          Two function results, one PPR shell, and one public test invalidation
          endpoint. Every visible token is evidence of which layer was reused.
        </p>
        <div className="cache-lab-hero-actions">
          <a href="#cache-lab-console">Open invalidation console</a>
          <Link to="/">Return home</Link>
        </div>
      </header>

      <section className="cache-lab-model" aria-label="Cache model">
        <article>
          <span>01</span>
          <h2>Function values</h2>
          <p>
            Each product runs inside <code>&quot;use cache&quot;</code> with a
            catalog tag and its own product tag.
          </p>
        </article>
        <article>
          <span>02</span>
          <h2>PPR shell</h2>
          <p>
            The shell carries its explicit tag plus the product tags observed
            during capture.
          </p>
        </article>
        <article>
          <span>03</span>
          <h2>Promised metadata</h2>
          <p>
            The title comes from <code>Meta(promise)</code>. It streams without
            holding the visible page, then becomes part of the captured shell.
          </p>
        </article>
      </section>

      <section
        className="cache-lab-boundary"
        aria-labelledby="cache-lab-values"
      >
        <div className="cache-lab-boundary-label">PPR shell</div>
        <div className="cache-lab-section-heading">
          <div>
            <span className="cache-lab-kicker">Stored values</span>
            <h2 id="cache-lab-values">Product cache generations</h2>
          </div>
          <code>probe={probe}</code>
        </div>
        <div className="cache-lab-live-row">
          <span>Nested promise PPR hole</span>
          <CacheLabLivePulse loader={CacheLabPulseLoader} />
        </div>
        <CacheLabProductGrid
          products={[
            { id: "alpha", product: alpha },
            { id: "beta", product: beta },
          ]}
        />
      </section>

      <CacheLabInvalidationPanel />

      <section className="cache-lab-runbook">
        <span className="cache-lab-kicker">Manual runbook</span>
        <h2>Read the evidence</h2>
        <ol>
          <li>Reload: both cache tokens stay fixed on a warm shell hit.</li>
          <li>
            Invalidate Alpha: the shell misses, Alpha changes, and Beta stays
            fixed.
          </li>
          <li>
            Invalidate PPR shell only: the shell recaptures while both function
            tokens stay fixed.
          </li>
          <li>
            Invalidate the catalog: both function tokens and the promised title
            change.
          </li>
        </ol>
      </section>
    </main>
  );
}

const CACHE_LAB_STYLES = `
  .cache-lab {
    --lab-ink: #171612;
    --lab-muted: #656157;
    --lab-paper: #f5f0e5;
    --lab-card: #fffdf8;
    --lab-line: #d8d0bf;
    --lab-accent: #e35132;
    --lab-green: #217a5a;
    color: var(--lab-ink);
    margin: -1rem auto 4rem;
    max-width: 1080px;
  }
  .cache-lab code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cache-lab-hero {
    background: var(--lab-paper);
    border: 1px solid var(--lab-line);
    border-radius: 28px;
    padding: clamp(2rem, 7vw, 5.5rem);
    position: relative;
    overflow: hidden;
  }
  .cache-lab-hero::after {
    background: repeating-linear-gradient(135deg, transparent 0 15px, rgba(227, 81, 50, .12) 15px 16px);
    content: "";
    inset: 0 0 0 58%;
    pointer-events: none;
    position: absolute;
  }
  .cache-lab-status {
    align-items: center;
    background: rgba(255, 255, 255, .65);
    border: 1px solid var(--lab-line);
    border-radius: 999px;
    display: inline-flex;
    font-size: .78rem;
    font-weight: 700;
    gap: .55rem;
    letter-spacing: .08em;
    padding: .45rem .75rem;
    position: relative;
    text-transform: uppercase;
    z-index: 1;
  }
  .cache-lab-status span { background: var(--lab-green); border-radius: 50%; height: .55rem; width: .55rem; }
  .cache-lab-hero h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(3rem, 8vw, 6.5rem);
    font-weight: 500;
    letter-spacing: -.065em;
    line-height: .88;
    margin: 2rem 0 1.5rem;
    max-width: 760px;
    position: relative;
    z-index: 1;
  }
  .cache-lab-hero > p { color: var(--lab-muted); font-size: 1.1rem; max-width: 620px; position: relative; z-index: 1; }
  .cache-lab-hero-actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 2rem; position: relative; z-index: 1; }
  .cache-lab-hero-actions a {
    background: var(--lab-ink);
    border: 1px solid var(--lab-ink);
    border-radius: 999px;
    color: white;
    display: inline-block;
    font-weight: 700;
    padding: .72rem 1.1rem;
    text-decoration: none;
  }
  .cache-lab-hero-actions a + a { background: transparent; color: var(--lab-ink); }
  .cache-lab-model { display: grid; grid-template-columns: repeat(3, 1fr); margin: 2rem 0 4rem; }
  .cache-lab-model article { border-left: 1px solid var(--lab-line); padding: .5rem 2rem 1rem; }
  .cache-lab-model article:last-child { border-right: 1px solid var(--lab-line); }
  .cache-lab-model article > span, .cache-lab-kicker { color: var(--lab-accent); font-size: .75rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .cache-lab-model h2 { font-size: 1rem; margin: .8rem 0 .45rem; }
  .cache-lab-model p { color: var(--lab-muted); font-size: .9rem; }
  .cache-lab-boundary { border: 1px solid var(--lab-accent); border-radius: 22px; padding: clamp(1.25rem, 4vw, 2.5rem); position: relative; }
  .cache-lab-boundary-label { background: var(--lab-accent); border-radius: 999px; color: white; font-size: .7rem; font-weight: 800; left: 1.5rem; letter-spacing: .1em; padding: .3rem .7rem; position: absolute; text-transform: uppercase; top: 0; transform: translateY(-50%); }
  .cache-lab-section-heading { align-items: end; display: flex; justify-content: space-between; margin-bottom: 1.5rem; }
  .cache-lab-section-heading h2, .cache-lab-console h2, .cache-lab-runbook h2 { font-family: Georgia, "Times New Roman", serif; font-size: clamp(2rem, 4vw, 3rem); font-weight: 500; letter-spacing: -.035em; margin: .25rem 0; }
  .cache-lab-section-heading > code { background: var(--lab-paper); border-radius: 6px; color: var(--lab-muted); font-size: .75rem; padding: .35rem .55rem; }
  .cache-lab-product-grid { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cache-lab-product { background: var(--lab-card); border: 1px solid var(--lab-line); border-radius: 15px; min-height: 245px; padding: 1.4rem; }
  .cache-lab-live-row { align-items: center; background: var(--lab-paper); border: 1px dashed var(--lab-green); border-radius: 10px; color: var(--lab-muted); display: flex; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .72rem; justify-content: space-between; margin-bottom: 1rem; padding: .65rem .8rem; }
  .cache-lab-live-row > span:first-child { color: var(--lab-green); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .cache-lab-product-topline { align-items: center; display: flex; justify-content: space-between; }
  .cache-lab-product-topline strong { font-family: Georgia, "Times New Roman", serif; font-size: 1.5rem; }
  .cache-lab-eyebrow { border: 1px solid var(--lab-green); border-radius: 999px; color: var(--lab-green); font-size: .68rem; font-weight: 800; letter-spacing: .1em; padding: .25rem .5rem; text-transform: uppercase; }
  .cache-lab-product h3 { font-family: Georgia, "Times New Roman", serif; font-size: 2rem; font-weight: 500; margin: 1.6rem 0 1rem; }
  .cache-lab-facts { display: grid; gap: .65rem; }
  .cache-lab-facts div { display: grid; gap: .5rem; grid-template-columns: 90px 1fr; }
  .cache-lab-facts dt { color: var(--lab-muted); font-size: .75rem; text-transform: uppercase; }
  .cache-lab-facts dd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; overflow-wrap: anywhere; }
  .cache-lab-tag-list { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: 1.2rem; }
  .cache-lab-tag-list code { background: var(--lab-paper); border-radius: 4px; color: var(--lab-muted); font-size: .68rem; padding: .25rem .4rem; }
  .cache-lab-console { background: var(--lab-ink); border-radius: 22px; color: white; display: grid; gap: 1.5rem; grid-template-columns: 1fr; margin-top: 2rem; padding: clamp(1.5rem, 5vw, 3.5rem); }
  .cache-lab-console p { color: #bbb6aa; max-width: 520px; }
  .cache-lab-console p code { color: white; }
  .cache-lab-console-actions { display: flex; flex-wrap: wrap; gap: .6rem; grid-column: 1 / -1; }
  .cache-lab-console button { background: var(--lab-accent); border: 0; border-radius: 999px; color: white; cursor: pointer; font-size: .82rem; font-weight: 800; padding: .65rem 1rem; }
  .cache-lab-console button:disabled { cursor: not-allowed; opacity: .45; }
  .cache-lab-console .cache-lab-secondary-button { background: transparent; border: 1px solid #716b5e; }
  .cache-lab-console-status { border-top: 1px solid #3d3931; color: #bbb6aa; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; grid-column: 1 / -1; padding-top: 1rem; }
  .cache-lab-console-status.is-success { color: #7ee0b9; }
  .cache-lab-console-status.is-error { color: #ff947e; }
  .cache-lab-runbook { border-bottom: 1px solid var(--lab-line); border-top: 1px solid var(--lab-line); margin-top: 4rem; padding: 3rem 0; }
  .cache-lab-runbook ol { counter-reset: runbook; display: grid; gap: 1rem; grid-template-columns: repeat(2, 1fr); list-style: none; margin-top: 1.5rem; }
  .cache-lab-runbook li { color: var(--lab-muted); counter-increment: runbook; padding-left: 2.3rem; position: relative; }
  .cache-lab-runbook li::before { color: var(--lab-ink); content: counter(runbook, decimal-leading-zero); font-family: Georgia, "Times New Roman", serif; font-size: 1.2rem; left: 0; position: absolute; }
  @media (max-width: 720px) {
    .cache-lab { margin-top: 0; }
    .cache-lab-hero::after { inset: 55% 0 0; }
    .cache-lab-model, .cache-lab-product-grid, .cache-lab-console, .cache-lab-runbook ol { grid-template-columns: 1fr; }
    .cache-lab-model article, .cache-lab-model article:last-child { border-left: 0; border-right: 0; border-top: 1px solid var(--lab-line); padding: 1.2rem .4rem; }
    .cache-lab-section-heading { align-items: start; flex-direction: column; gap: .8rem; }
  }
`;
