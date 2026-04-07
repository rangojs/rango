async function ReactPerfProbeLeaf({
  label,
  delay,
}: {
  label: string;
  delay: number;
}) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return <span hidden data-rsc-perf-leaf={label} />;
}

async function ReactPerfProbeBranch({
  label,
  delay,
}: {
  label: string;
  delay: number;
}) {
  await new Promise((resolve) => setTimeout(resolve, delay));

  return (
    <div hidden data-rsc-perf-branch={label}>
      <ReactPerfProbeLeaf label={`${label}-leaf-a`} delay={delay / 2} />
      <ReactPerfProbeLeaf label={`${label}-leaf-b`} delay={delay / 3} />
    </div>
  );
}

/**
 * Dev-only async server component subtree used to validate React Performance
 * Tracks integration in the demo app.
 */
export async function ReactPerfProbe() {
  if (!import.meta.env.DEV) {
    return null;
  }

  await new Promise((resolve) => setTimeout(resolve, 40));

  return (
    <section hidden data-rsc-perf-root="home">
      <ReactPerfProbeBranch label="home-branch-a" delay={60} />
      <ReactPerfProbeBranch label="home-branch-b" delay={90} />
    </section>
  );
}
