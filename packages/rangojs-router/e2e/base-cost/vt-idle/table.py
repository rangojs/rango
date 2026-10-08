"""Cells x variants table from the matrix directory.

usage: table.py <matrix-dir> <mode> [variants...]
cell: complete median (min-max) nVT ; with --first also the first visual change median
"""
import json, sys, statistics as st, os

FB = {"bc-fb", "bc-fb-outer", "bc-fb-inner", "bc-fb-in"}


def metrics(row):
    first = None
    comp = {}
    for e in row["ev"]:
        if e["t"] is None:
            continue
        if first is None and e["p"]:
            first = e["t"]
        if e["id"] not in FB and e["p"] and e["id"] not in comp:
            comp[e["id"]] = e["t"]
    return first, (max(comp.values()) if comp else None), len(row["vt"]), row.get("load", "")


d, mode = sys.argv[1], sys.argv[2]
args = [a for a in sys.argv[3:] if not a.startswith("--")]
variants = args or ["base", "a", "b1", "b2", "c0", "c30", "c100"]
show_first = "--first" in sys.argv
data = {}
loads = {}
cells = []
for v in variants:
    p = os.path.join(d, f"{v}-{mode}.jsonl")
    if not os.path.exists(p):
        continue
    for l in open(p):
        r = json.loads(l)
        key = (r["route"], r["delay"])
        if key not in cells:
            cells.append(key)
        data.setdefault((v, key), []).append(metrics(r))
    meta = p + ".meta"
    if os.path.exists(meta):
        ls = [x.split("load averages:")[-1].strip().split()[0] for x in open(meta) if "load averages" in x]
        loads[v] = f"{min(map(float, ls)):.1f}-{max(map(float, ls)):.1f}"

print(f"## {mode}  (load average 1m during run: " + ", ".join(f"{v} {loads.get(v, '?')}" for v in variants if v in loads) + ")")
print("cell | " + " | ".join(variants))
print("--- | " + " | ".join("---" for _ in variants))
for key in cells:
    out = []
    for v in variants:
        ms = data.get((v, key))
        if not ms:
            out.append("-")
            continue
        comps = [m[1] for m in ms if m[1] is not None]
        firsts = [m[0] for m in ms if m[0] is not None]
        nvt = "/".join(sorted({str(m[2]) for m in ms}))
        cell = f"{round(st.median(comps))} ({round(min(comps))}-{round(max(comps))}) {nvt}vt"
        if show_first:
            cell = f"{round(st.median(firsts))} -> " + cell
        out.append(cell)
    print(f"{key[0]} {key[1]} | " + " | ".join(out))
