"""One line per trace row: VT windows and when bc-value became visible.

usage: vtsum.py <jsonl>...
"""
import json, sys

for path in sys.argv[1:]:
    print(f"# {path.split('/')[-1]}")
    for l in open(path):
        r = json.loads(l)
        t0 = r["t0"]
        vts = " ".join(
            f"[{v['start'] - t0:.0f}-{(v.get('finished') or 0) - t0:.0f}]" for v in r["vt"]
        )
        val = [e["t"] - t0 for e in r["ev"] if e["id"] == "bc-value" and e["s"] == "visible"]
        valb = [e["t"] - t0 for e in r["ev"] if e["id"] == "bc-value-b" and e["s"] == "visible"]
        fb = [e["t"] - t0 for e in r["ev"] if e["id"] == "bc-fb" and e["s"] == "visible"]
        done = max(val[:1] + valb[:1]) if val else None
        print(
            f"  run {r['i']}: nVT={len(r['vt'])} {vts} fallback={fb[0]:.0f}" if fb else f"  run {r['i']}: nVT={len(r['vt'])} {vts} fallback=-",
            f"complete={done:.0f}" if done is not None else "complete=-",
            "|", r["load"].split("load averages:")[-1].strip(),
        )
