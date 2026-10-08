import json, sys, statistics as st, collections

FB = {"bc-fb", "bc-fb-outer", "bc-fb-inner", "bc-fb-in"}


def metrics(row):
    ev = row["ev"]
    first_fb = None
    comp = {}
    first_change = None
    for e in ev:
        i, p, t = e["id"], e["p"], e["t"]
        if t is not None and t >= 0 and first_change is None:
            first_change = t
        if i in FB:
            if p and first_fb is None:
                first_fb = t
        elif p and i not in comp:
            comp[i] = t
    complete = max(comp.values()) if comp else None
    return dict(
        first_fb=first_fb,
        first_change=first_change,
        complete=complete,
        nvt=len(row["vt"]),
        vt=row["vt"],
    )


def load(path):
    rows = [json.loads(l) for l in open(path)]
    g = collections.OrderedDict()
    for r in rows:
        g.setdefault((r["route"], r["delay"]), []).append(metrics(r))
    return g


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(st.median(xs)) if xs else None


def rng(xs):
    xs = [x for x in xs if x is not None]
    return f"{round(min(xs))}-{round(max(xs))}" if xs else "-"


if __name__ == "__main__":
    for path in sys.argv[1:]:
        g = load(path)
        print(f"\n# {path.split('/')[-1]}")
        print("route | delay | firstChange med | complete med (range) | nVT | n")
        for (route, d), ms in g.items():
            comps = [m["complete"] for m in ms]
            fc = [m["first_change"] for m in ms]
            nvt = "/".join(sorted({str(m["nvt"]) for m in ms}))
            print(
                f"{route} | {d} | {med(fc)} | {med(comps)} ({rng(comps)}) | {nvt} | {len(ms)}"
            )
        if "-v" in sys.argv:
            pass
